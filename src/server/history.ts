// Shared block history: every height nodes have reported, the forks seen
// at each height, and when each node reported which fork. Block times,
// propagation delays and the charts are all derived from it.

import {
  HISTORY_BINS,
  PROPAGATION_BANDS,
  TREND_SLICE_S,
  type Block,
  type ChainHealth,
  type Charts,
  type MinerCount,
  type MiningPool,
  type PropagationStats,
  type Trends,
} from "../lib/protocol.ts";
import { DEEP_REORG } from "../lib/alert-levels.ts";
import { median } from "../lib/derive.ts";
import type { TimelineBlock } from "./incidents.ts";
import type { ReportedBlock } from "./sanitize.ts";

const MAX_HISTORY = 2000;
/**
 * POOLED_S is the span the hashrate and the block time trend each pool their
 * blocks over. Blocks come by luck: over one 4 hour slice, about 24 blocks, a
 * steady hashrate reads up to 20% off; over 24 hours, about 144 blocks,
 * around 8%.
 */
const POOLED_S = 24 * 3600;
const POOLED_SLICES = POOLED_S / TREND_SLICE_S;
const TOP_MINERS = 10;
/** Who mined is judged over a week of blocks: enough that one lucky pool does not swing it. */
const MINER_WINDOW_S = 7 * 86_400;

/** Reports of the same reorganization by different nodes within this long count once. */
const REORG_GROUP_MS = 2 * 60 * 1000;
const REORG_PERIOD_MS = 24 * 60 * 60 * 1000;
const MAX_REORG_EVENTS = 200;
const RECENT_STALE = 5;
/** Stale heights sent for the block strip, newest first: far more than a healthy window holds. */
const MAX_STALE = 500;
const ZERO_HASH = "0x" + "0".repeat(64);

// Forks kept per height. Only trusted nodes can exceed it, so untrusted
// nodes cannot grow memory by reporting made-up blocks at known heights.
const MAX_FORKS = 10;

/** Largest history request a node answers. */
export const HISTORY_REQUEST_SIZE = 50;

export interface HistoryBlock extends Block {
  trusted: boolean;
  fork: number;
  /** Whether the fees figure came from a trusted node. */
  feesTrusted: boolean;
}

interface Propagation {
  node: string;
  trusted: boolean;
  fork: number;
  received: number;
  propagation: number;
  /** Whether the report measures propagation: from a synced node connected for a while, not history. */
  counted?: boolean;
  /** The node's one-way latency to the dashboard when it reported, ms. */
  latency?: number;
}

/** How a report's timing can be trusted, from what the registry knows of the node. */
export interface Timing {
  counted: boolean;
  latency: number;
}

const UNCOUNTED: Timing = { counted: false, latency: 0 };

/**
 * An untrusted node's report of a height no trusted node has reported yet,
 * held so that once one does, the report is timed from when it came: a
 * public node that hears of a block first is first, and the trusted node
 * after it is not. It can only count if a trusted node reports the very
 * same block, so it cannot be used to make up blocks.
 */
interface EarlyReport extends Timing {
  block: ReportedBlock;
  received: number;
}

/** How long an early report waits for a trusted node to report its block. */
const EARLY_MS = 10 * 60 * 1000;
/** Blocks whose spread is judged, and the verified reports each needs. */
const SPREAD_BLOCKS = 10;
const SPREAD_MIN_REPORTERS = 3;
/** How far back to look for a miner whose blocks spread slowly. */
const SLOW_MINER_WINDOW = 100;
const SLOW_MINER_MIN_BLOCKS = 5;
const SLOW_MINER_MS = 15_000;
const FAST_OTHERS_MS = 5_000;

interface Height {
  height: number;
  /** The block shown for this height: the first seen, or the one a trusted node reported. */
  block: HistoryBlock;
  forks: HistoryBlock[];
  /**
   * Who ever reported each fork, kept apart from the fork objects because
   * those are sent to viewers. Unlike propagTimes, a node that later
   * switches forks stays listed here.
   */
  forkReporters: { ids: Set<string>; trusted: boolean }[];
  propagTimes: Propagation[];
}

interface ReorgEvent {
  height: number;
  at: number;
  nodes: Set<string>;
  trusted: boolean;
  /** Blocks replaced, the most measured so far. */
  depth: number;
  /**
   * What is needed to measure the depth once the new chain's blocks arrive:
   * the head the first node switched to, and the hashes it had reported on
   * its old chain. Not saved across restarts.
   */
  measure?: { head: Head & { parentHash: string }; old: Map<number, string>; oldTop: number };
}

/** A verified node's current head, for spotting chain splits. */
export interface Head {
  number: number;
  hash: string;
}

/** How far back to follow chains when measuring reorgs and splits. */
const MAX_WALK = 100;

/** What is saved of the history across restarts: the same data, with sets as arrays. */
export interface HistoryState {
  startedAt: number;
  items: {
    height: number;
    /** Which fork is the block shown for the height. */
    shown: number;
    forks: HistoryBlock[];
    forkReporters: { ids: string[]; trusted: boolean }[];
    propagTimes: Propagation[];
  }[];
  reorgs: { height: number; at: number; nodes: string[]; trusted: boolean; depth?: number }[];
}

export interface HistoryRequest {
  min: number;
  max: number;
  list: number[];
}

function sameBlock(a: ReportedBlock, b: ReportedBlock): boolean {
  return (
    a.hash === b.hash &&
    a.parentHash === b.parentHash &&
    a.sha3Uncles === b.sha3Uncles &&
    a.transactionsRoot === b.transactionsRoot &&
    a.stateRoot === b.stateRoot &&
    a.miner === b.miner &&
    a.difficulty === b.difficulty &&
    a.totalDifficulty === b.totalDifficulty
  );
}

function findFork(height: Height, block: ReportedBlock): number {
  return height.forks.findIndex((fork) => sameBlock(fork, block));
}

/** weekFullness is the mean share of the gas limit the blocks used, of those with a limit. */
function weekFullness(window: Height[]): number {
  const limited = window.filter((item) => item.block.gasLimit > 0);

  return limited.length > 0 ? limited.reduce((sum, item) => sum + item.block.gasUsed / item.block.gasLimit, 0) / limited.length : 0;
}

export class History {
  /** Sorted by height, highest first. */
  private items: Height[] = [];
  private trustedOnly = false;
  private reorgs: ReorgEvent[] = [];
  /** Blocks to ask nodes for after they switch chains, to measure how far back. */
  private reorgRequests = new Map<string, HistoryRequest>();
  private startedAt = Date.now();
  /** Each untrusted node's latest early report, by node: bounded by the nodes. Not saved across restarts. */
  private early = new Map<string, EarlyReport>();
  /** Early reports timed by the last add, for the registry to update those nodes' heads. */
  private retimed: { id: string; block: HistoryBlock }[] = [];
  /** Known pools by coinbase address. */
  private readonly pools: Map<string, MiningPool>;

  constructor(pools: Map<string, MiningPool> = new Map()) {
    this.pools = pools;
  }

  toState(): HistoryState {
    return {
      startedAt: this.startedAt,
      items: this.items.map((item) => ({
        height: item.height,
        shown: Math.max(0, item.forks.indexOf(item.block)),
        forks: item.forks,
        forkReporters: item.forkReporters.map((r) => ({ ids: [...r.ids], trusted: r.trusted })),
        propagTimes: item.propagTimes,
      })),
      reorgs: this.reorgs.map(({ height, at, nodes, trusted, depth }) => ({ height, at, nodes: [...nodes], trusted, depth })),
    };
  }

  /** restore replaces the history with saved state. */
  restore(state: HistoryState): void {
    this.startedAt = Math.min(state.startedAt, Date.now());
    this.items = state.items
      .filter((item) => item.forks.length > 0)
      .map((item) => ({
        height: item.height,
        block: item.forks[item.shown] ?? item.forks[0],
        forks: item.forks,
        forkReporters: item.forkReporters.map((r) => ({ ids: new Set(r.ids), trusted: r.trusted })),
        propagTimes: item.propagTimes,
      }))
      .sort((a, b) => b.height - a.height)
      .slice(0, MAX_HISTORY);
    this.reorgs = state.reorgs.slice(-MAX_REORG_EVENTS).map((e) => ({ ...e, nodes: new Set(e.nodes), depth: e.depth ?? 1 }));
  }

  /**
   * setTrustedOnly controls who may introduce new block heights. While a
   * trusted node is connected, untrusted nodes can only report blocks at
   * heights a trusted node has already seen, so a node reporting a
   * made-up height cannot become the best block or skew the charts.
   */
  setTrustedOnly(trustedOnly: boolean): void {
    this.trustedOnly = trustedOnly;
  }

  get length(): number {
    return this.items.length;
  }

  /**
   * add records that node `id` reported `reported`. It returns the block
   * with its timing fields filled in, its propagation -1 when the node's
   * report of it was catch-up rather than timed, or null when the block was not
   * recorded (genesis, a height no trusted node has seen while one is
   * online, or one past the fork limit).
   */
  add(reported: ReportedBlock, id: string, trusted: boolean, addingHistory = false, timing: Timing = UNCOUNTED): HistoryBlock | null {
    const { counted, latency } = addingHistory ? UNCOUNTED : timing;

    if (reported.number <= 0) return null;

    const height = this.search(reported.number);

    if (!trusted && this.trustedOnly && !height) {
      if (!addingHistory) this.holdEarly(id, { block: reported, received: Date.now(), counted, latency });

      return null;
    }

    if (!trusted && height && height.forks.length >= MAX_FORKS && findFork(height, reported) < 0) return null;

    const now = Date.now();
    const block: HistoryBlock = {
      ...reported,
      trusted,
      arrived: now,
      received: now,
      propagation: 0,
      fork: 0,
      time: 0,
      feesTrusted: trusted && reported.fees !== null,
    };

    if (!addingHistory) this.detectReorg(reported, id, trusted, height, now);

    if (!height) {
      const item: Height = {
        height: block.number,
        block,
        forks: [block],
        forkReporters: [{ ids: new Set([id]), trusted }],
        propagTimes: [],
      };
      const accept =
        this.items.length === 0 ||
        block.number > this.worstBlockNumber() ||
        (this.items.length < MAX_HISTORY && block.number < this.bestBlockNumber() && addingHistory);

      block.time = this.blockTime(block);

      if (accept) {
        // Nodes that reported this very block before it could be recorded came first
        const early = this.takeEarly(id, block);
        const first = Math.min(now, ...early.map((e) => e.received));

        block.arrived = first;
        block.received = first;

        for (const e of early) {
          item.forkReporters[0].ids.add(e.id);
          item.propagTimes.push({ node: e.id, trusted: false, fork: 0, received: e.received, propagation: e.received - first, counted: e.counted, latency: e.latency });
          this.retimed.push({ id: e.id, block: { ...block, received: e.received, propagation: e.counted ? e.received - first : -1 } });
        }

        item.propagTimes.push({ node: id, trusted, fork: 0, received: now, propagation: now - first, counted, latency });
        this.save(item);
        this.fillChildTimes(item.height);

        if (early.length > 0) return { ...block, received: now, propagation: counted ? now - first : -1 };
      }

      return counted ? block : { ...block, propagation: -1 };
    }

    const propIndex = height.propagTimes.findIndex((p) => p.node === id);
    let forkIndex = findFork(height, block);

    if (forkIndex >= 0) {
      const fork = height.forks[forkIndex];

      block.arrived = fork.arrived;
      block.time = fork.time;
      this.fillFees(fork, reported.fees, trusted);
      block.fees = fork.fees;

      if (propIndex < 0) {
        block.propagation = now - fork.received;
      } else if (height.propagTimes[propIndex].fork === forkIndex) {
        block.received = height.propagTimes[propIndex].received;
        block.propagation = height.propagTimes[propIndex].propagation;
      } else {
        block.propagation = now - fork.received;
        height.propagTimes[propIndex].fork = forkIndex;
        height.propagTimes[propIndex].propagation = block.propagation;
      }
    } else {
      // A new fork at a known height
      if (propIndex >= 0) {
        block.received = height.propagTimes[propIndex].received;
        block.propagation = height.propagTimes[propIndex].propagation;
      }

      block.time = this.blockTime(block);
      forkIndex = height.forks.push(block) - 1;
      height.forkReporters.push({ ids: new Set(), trusted: false });
      block.fork = forkIndex;

      // The node moved to this fork
      if (propIndex >= 0) height.propagTimes[propIndex].fork = forkIndex;
    }

    const reporters = height.forkReporters[forkIndex];

    reporters.ids.add(id);
    reporters.trusted ||= trusted;

    if (propIndex < 0) {
      height.propagTimes.push({ node: id, trusted, fork: forkIndex, received: now, propagation: block.propagation, counted, latency });
    }

    // A trusted report decides which fork the height shows
    if (trusted && !sameBlock(height.block, height.forks[forkIndex])) {
      height.forks[forkIndex].trusted = true;
      height.block = height.forks[forkIndex];
    }

    block.fork = forkIndex;

    // A catch-up report times nothing, however often the node reports that head again
    const own = height.propagTimes.find((p) => p.node === id);

    return own?.counted === false ? { ...block, propagation: -1 } : block;
  }

  /** holdEarly keeps node `id`'s early report in place of any before it, and drops ones gone stale. */
  private holdEarly(id: string, report: EarlyReport): void {
    for (const [other, held] of this.early) if (report.received - held.received > EARLY_MS) this.early.delete(other);

    this.early.set(id, report);
  }

  /** takeEarly removes and returns the early reports of `block`, from nodes other than `id`. */
  private takeEarly(id: string, block: ReportedBlock): (EarlyReport & { id: string })[] {
    const taken: (EarlyReport & { id: string })[] = [];

    for (const [other, held] of this.early) {
      if (other === id || held.block.number !== block.number || !sameBlock(held.block, block)) continue;

      this.early.delete(other);
      if (Date.now() - held.received <= EARLY_MS) taken.push({ ...held, id: other });
    }

    return taken;
  }

  /** takeRetimed returns, once, the early reports the last add timed, with the block each node now has. */
  takeRetimed(): { id: string; block: HistoryBlock }[] {
    const retimed = this.retimed;

    this.retimed = [];

    return retimed;
  }

  /**
   * detectReorg notices a node changing its mind: reporting a different
   * block at a height it already reported, or a block whose parent is not
   * the one it reported just below. Reports of one reorganization by
   * several nodes within REORG_GROUP_MS count as one event.
   */
  private detectReorg(reported: ReportedBlock, id: string, trusted: boolean, height: Height | undefined, now: number): void {
    const sameHeight = height && this.reportedHash(height, id);
    const below = this.search(reported.number - 1);
    const parent = below && this.reportedHash(below, id);
    const switched =
      (sameHeight !== undefined && sameHeight !== reported.hash) ||
      (parent !== undefined && reported.parentHash !== ZERO_HASH && parent !== reported.parentHash);

    if (!switched) return;

    const measure = this.oldChain(reported, id);
    const depth = this.measureDepth(measure);

    // Ask the node for its new chain's recent blocks, to see how far back it parts
    this.reorgRequests.set(id, {
      min: Math.max(1, reported.number - HISTORY_REQUEST_SIZE),
      max: reported.number - 1,
      list: Array.from({ length: Math.min(HISTORY_REQUEST_SIZE, reported.number - 1) }, (_, i) => reported.number - 1 - i).reverse(),
    });

    const last = this.reorgs.at(-1);

    if (last && now - last.at < REORG_GROUP_MS && Math.abs(last.height - reported.number) <= 2) {
      last.nodes.add(id);
      last.trusted ||= trusted;
      last.height = Math.min(last.height, reported.number);
      last.depth = Math.max(last.depth, depth);
      last.measure ??= measure;
      return;
    }

    this.reorgs.push({ height: reported.number, at: now, nodes: new Set([id]), trusted, depth, measure });

    if (this.reorgs.length > MAX_REORG_EVENTS) this.reorgs.shift();
  }

  /** oldChain records what node `id` had before switching to `reported`, to measure the switch by. */
  private oldChain(reported: ReportedBlock, id: string): NonNullable<ReorgEvent["measure"]> {
    const old = new Map<number, string>();
    let oldTop = reported.number - 1;

    for (const item of this.items) {
      if (item.height <= reported.number - MAX_WALK) break;

      const hash = this.reportedHash(item, id);

      if (hash === undefined) continue;

      old.set(item.height, hash);
      if (item.height >= reported.number) oldTop = Math.max(oldTop, item.height);
    }

    return { head: { number: reported.number, hash: reported.hash, parentHash: reported.parentHash }, old, oldTop };
  }

  /**
   * measureDepth counts the blocks a switch replaced: from the node's old
   * head down to the last block both chains share, following the new
   * chain's parents through the history. Where the new chain's blocks are
   * not known yet, the count stops there, so it is a lower bound until they
   * arrive. At least 1.
   */
  private measureDepth({ head, old, oldTop }: NonNullable<ReorgEvent["measure"]>): number {
    let hash = head.hash;
    let parent: string | null = head.parentHash;
    let ancestor = head.number - 1;

    for (let k = head.number; k > head.number - MAX_WALK && k > 0; k--) {
      const had = old.get(k);

      if (had === hash || (had === undefined && k <= oldTop)) {
        ancestor = k;
        break;
      }

      ancestor = k - 1;

      // Step to the new chain's block below, when it is known
      const below = parent ?? this.search(k)?.forks.find((f) => f.hash === hash)?.parentHash;

      if (!below) break;

      hash = below;
      parent = null;
    }

    return Math.max(1, oldTop - ancestor);
  }

  /** takeReorgRequest hands over the blocks to ask node `id` for after it switched chains, once. */
  takeReorgRequest(id: string): HistoryRequest | null {
    const request = this.reorgRequests.get(id) ?? null;

    this.reorgRequests.delete(id);

    return request;
  }

  /**
   * split reports verified nodes following different chains. Chains that
   * part at a node's head are a block race, settled by the next block, so
   * a split needs every node at least two blocks past where they part.
   */
  private split(heads: Head[]): ChainHealth["split"] {
    if (heads.length < 2) return null;

    const byHeight = new Map(this.items.map((item) => [item.height, item]));
    const hashAt = (head: Head, target: number): string | null => {
      let hash = head.hash;

      for (let k = head.number; k > target; k--) {
        const fork = byHeight.get(k)?.forks.find((f) => f.hash === hash);

        if (!fork) return null;
        hash = fork.parentHash;
      }

      return hash;
    };

    const target = Math.min(...heads.map((h) => h.number)) - 1;

    if (target < 1) return null;

    const chains = new Set(heads.map((head) => hashAt(head, target)).filter((hash): hash is string => hash !== null));

    if (chains.size < 2) return null;

    let shared: number | null = null;

    for (let k = target - 1; k > Math.max(0, target - MAX_WALK); k--) {
      if (new Set(heads.map((head) => hashAt(head, k))).size === 1 && hashAt(heads[0], k) !== null) {
        shared = k;
        break;
      }
    }

    return { height: shared, chains: chains.size, nodes: heads.length };
  }

  /** reportedHash is the hash node `id` last reported at a height, if any. */
  private reportedHash(height: Height, id: string): string | undefined {
    const own = height.propagTimes.find((p) => p.node === id);

    return own ? height.forks[own.fork].hash : undefined;
  }

  /**
   * A competing block or reorganization counts only when a trusted node
   * saw it, or, while none is online, when two nodes did, so an untrusted
   * node cannot inflate the figures by reporting made-up blocks.
   */
  private credible(reporters: { size: number }, trusted: boolean): boolean {
    return trusted || (!this.trustedOnly && reporters.size >= 2);
  }

  private health(heads: Head[], now = Date.now()): ChainHealth {
    const stale: { height: number; at: number }[] = [];
    let staleBlocks = 0;

    for (const item of this.items) {
      const losers = new Set<string>();

      item.forks.forEach((fork, i) => {
        const reporters = item.forkReporters[i];

        if (fork.hash !== item.block.hash && this.credible(reporters.ids, reporters.trusted)) losers.add(fork.hash);
      });

      if (losers.size > 0) {
        staleBlocks += losers.size;
        stale.push({ height: item.height, at: item.block.arrived });
      }
    }

    // The new chains' blocks may have arrived since: measure the day's switches again,
    // so a deep one is known as deep even after a later one has come along
    for (const event of this.reorgs) {
      if (event.measure && now - event.at < REORG_PERIOD_MS) event.depth = Math.max(event.depth, this.measureDepth(event.measure));
    }

    const since = Math.max(now - REORG_PERIOD_MS, this.startedAt);
    const counted = this.reorgs.filter((e) => this.credible(e.nodes, e.trusted));
    const last = counted.at(-1);
    const lastDeep = counted.findLast((e) => e.depth >= DEEP_REORG);

    return {
      window: this.items.length,
      staleBlocks,
      recentStale: stale.slice(0, RECENT_STALE),
      stale: stale.slice(0, MAX_STALE),
      reorgEvents: counted
        .filter((e) => this.items.length > 0 && e.height >= this.items.at(-1)!.height)
        .map((e) => ({ height: e.height, at: e.at, nodes: e.nodes.size, depth: e.depth })),
      heights: this.items.length > 0 ? { from: this.items.at(-1)!.height, to: this.items[0].height } : null,
      reorgs: counted.filter((e) => e.at >= since).length,
      since,
      lastReorg: last ? { height: last.height, at: last.at, nodes: last.nodes.size, depth: last.depth } : null,
      lastDeepReorg: lastDeep ? { height: lastDeep.height, at: lastDeep.at, nodes: lastDeep.nodes.size, depth: lastDeep.depth } : null,
      split: this.split(heads),
    };
  }

  /**
   * fillFees records fees for a known block that was first reported without
   * them, by a parallaxd version that does not send them. While a trusted
   * node is online only trusted reports may fill or correct the figure, so
   * an untrusted node cannot plant fees on a block a trusted node reported.
   */
  private fillFees(fork: HistoryBlock, fees: string | null, trusted: boolean): void {
    if (fees === null || fork.feesTrusted) return;

    if (trusted) {
      fork.fees = fees;
      fork.feesTrusted = true;
    } else if (fork.fees === null && !this.trustedOnly) {
      fork.fees = fees;
    }
  }

  /**
   * blockTime is the time between a block's timestamp and its parent's, or
   * 0 when the parent is not in the history. Timestamps, not arrival times:
   * when a node reports blocks says more about the node than the chain.
   */
  private blockTime(block: HistoryBlock): number {
    const below = this.search(block.number - 1);

    if (!below) return 0;

    const parent = below.forks.find((fork) => fork.hash === block.parentHash) ?? below.block;

    return Math.max((block.timestamp - parent.timestamp) * 1000, 0);
  }

  /** fillChildTimes times the blocks above a newly recorded height, which had no parent until now. */
  private fillChildTimes(height: number): void {
    const above = this.search(height + 1);

    if (!above) return;

    for (const fork of above.forks) if (fork.time === 0) fork.time = this.blockTime(fork);
  }

  private save(item: Height): void {
    const index = this.items.findIndex((other) => other.height < item.height);

    if (index < 0) this.items.push(item);
    else this.items.splice(index, 0, item);

    if (this.items.length > MAX_HISTORY) this.items.pop();
  }

  search(number: number): Height | undefined {
    return this.items.find((item) => item.height === number);
  }

  bestBlockNumber(): number {
    return this.items[0]?.height ?? 0;
  }

  private worstBlockNumber(): number {
    return this.items.at(-1)?.height ?? 0;
  }

  private latest(count: number): Height[] {
    return this.items.slice(0, count);
  }

  /**
   * nodePropagation returns how late node `id` was to each of the last
   * HISTORY_BINS heights, oldest first: its propagation delay where it
   * reported the height, and otherwise how long it took to report a
   * later one (or how long ago the height arrived). A height is -1 when
   * there is nothing to measure: outside the history, arrived before the
   * node settled at `since` (ms), or after its next report, as a height
   * filled in from history does. A catch-up report, one not counted
   * toward propagation, measures neither its own height nor those it
   * skipped, and a node still `syncing` is not late for heights it has
   * yet to reach.
   */
  nodePropagation(id: string, since = 0, syncing = false): number[] {
    const propagation = new Array<number>(HISTORY_BINS).fill(-1);
    const best = this.bestBlockNumber();
    let lastArrival = syncing ? 0 : Date.now();

    for (const item of this.latest(HISTORY_BINS)) {
      const index = HISTORY_BINS - 1 - best + item.height;

      if (index < 0) continue;

      const own = item.propagTimes.find((p) => p.node === id);

      if (own) {
        const counted = own.counted !== false;

        if (counted) propagation[index] = own.propagation;
        lastArrival = counted ? item.block.arrived : 0;
      } else if (item.block.arrived >= since && item.block.arrived <= lastArrival) {
        propagation[index] = lastArrival - item.block.arrived;
      }
    }

    return propagation;
  }

  /**
   * delays returns, for each fork at a height, how long after the first
   * counted report every counted report came: arrival times less each
   * node's one-way latency, so a far-away node is not taken for a slow
   * network. Sorted, the first (0) included.
   */
  private delays(item: Height, trustedOnly = false): { fork: number; delays: number[] }[] {
    const byFork = new Map<number, number[]>();

    for (const p of item.propagTimes) {
      if (p.counted === false || (trustedOnly && !p.trusted)) continue;

      const list = byFork.get(p.fork) ?? [];

      list.push(p.received - (p.latency ?? 0));
      byFork.set(p.fork, list);
    }

    return [...byFork].map(([fork, arrivals]) => {
      const first = Math.min(...arrivals);

      return { fork, delays: arrivals.map((a) => Math.max(0, a - first)).sort((a, b) => a - b) };
    });
  }

  /**
   * blockPropagation summarizes how long blocks took to reach verified
   * nodes after the first verified report, over counted reports only, so
   * unverified nodes cannot skew the bands and percentiles with made-up
   * timings. First reports are left out: their delay is 0 by definition,
   * and counting them would pull every figure down.
   */
  private blockPropagation(): PropagationStats {
    const samples: number[] = [];

    for (const item of this.items) {
      for (const { delays } of this.delays(item, true)) samples.push(...delays.slice(1));
    }

    samples.sort((a, b) => a - b);

    const bands = new Array<number>(PROPAGATION_BANDS.length + 1).fill(0);

    for (const sample of samples) {
      const band = PROPAGATION_BANDS.findIndex((bound) => sample < bound);

      bands[band < 0 ? PROPAGATION_BANDS.length : band]++;
    }

    // Nearest-rank percentile
    const percentile = (q: number) =>
      samples.length > 0 ? samples[Math.min(samples.length - 1, Math.ceil(q * samples.length) - 1)] : 0;

    return {
      samples: samples.length,
      avg: samples.length > 0 ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : 0,
      p50: percentile(0.5),
      p90: percentile(0.9),
      p99: percentile(0.99),
      bands,
      spread: this.spread(),
    };
  }

  /** reach90 is how long a block took to reach 90% of the verified nodes that reported it, or null with too few. */
  private reach90(item: Height): number | null {
    const shown = item.forks.indexOf(item.block);
    const delays = this.delays(item, true).find((d) => d.fork === shown)?.delays ?? [];

    return delays.length >= SPREAD_MIN_REPORTERS ? delays[Math.ceil(0.9 * delays.length) - 1] : null;
  }

  /**
   * spread judges how fast recent blocks reach verified nodes, and whether
   * one miner's blocks are consistently slow while everyone else's are fast,
   * which points at that miner's connectivity.
   */
  private spread(): PropagationStats["spread"] {
    const measured: { item: Height; reach: number }[] = [];

    for (const item of this.items.slice(0, SLOW_MINER_WINDOW)) {
      const reach = this.reach90(item);

      if (reach !== null) measured.push({ item, reach });
    }

    const recent = measured.slice(0, SPREAD_BLOCKS).map((m) => m.reach);

    if (recent.length < SPREAD_BLOCKS / 2) return null;

    const byMiner = new Map<string, { miner: string; pool: string | null; reaches: number[] }>();

    for (const { item, reach } of measured) {
      const pool = this.pools.get(item.block.miner) ?? null;
      const key = pool ? `pool:${pool.name}` : item.block.miner;
      const entry = byMiner.get(key) ?? { miner: item.block.miner, pool: pool?.name ?? null, reaches: [] };

      entry.reaches.push(reach);
      byMiner.set(key, entry);
    }

    let slowMiner: NonNullable<PropagationStats["spread"]>["slowMiner"] = null;

    for (const [key, entry] of byMiner) {
      if (entry.reaches.length < SLOW_MINER_MIN_BLOCKS) continue;

      const others = [...byMiner].filter(([k]) => k !== key).flatMap(([, e]) => e.reaches);
      const own = median(entry.reaches);

      if (others.length >= SLOW_MINER_MIN_BLOCKS && own > SLOW_MINER_MS && median(others) <= FAST_OTHERS_MS && own > (slowMiner?.median ?? 0)) {
        slowMiner = { miner: entry.miner, pool: entry.pool, median: own, blocks: entry.reaches.length };
      }
    }

    return { median: median(recent), blocks: recent.length, slowMiner };
  }

  /**
   * difficultyChange is the latest block's difficulty against the block at
   * or just before `seconds` earlier, by timestamp, as a fractional change;
   * null when the history does not reach back that far.
   */
  private difficultyChange(seconds: number): number | null {
    const head = this.items[0];

    if (!head) return null;

    const then = this.items.find((item) => item.block.timestamp <= head.block.timestamp - seconds);

    if (!then) return null;

    const before = Number(then.block.difficulty);

    return before > 0 ? Number(head.block.difficulty) / before - 1 : null;
  }

  /** avgBlocktime is the mean time between blocks over the last 7 days, in seconds, of blocks whose parent is known. */
  private avgBlocktime(window: Height[]): number {
    const times = window.filter((item) => item.block.time > 0).map((item) => item.block.time);

    return times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length / 1000 : 0;
  }

  /**
   * avgHashrate estimates network hashes per second as the total work of the
   * newest unbroken run of blocks over the last POOLED_S, over the time it
   * took: each block takes `difficulty` hashes on average.
   */
  private avgHashrate(): number {
    const run: Height[] = [];

    for (const item of this.items) {
      if (run.length > 0 && item.height !== run.at(-1)!.height - 1) break;

      run.push(item);

      // The first block from before the window closes it: only the work after it counts
      if (item.block.timestamp <= run[0].block.timestamp - POOLED_S) break;
    }

    if (run.length < 2) return 0;

    const span = run[0].block.timestamp - run.at(-1)!.block.timestamp;
    // The oldest block's work came before the span starts
    const work = run.slice(0, -1).reduce((sum, item) => sum + Number(item.block.difficulty), 0);

    return span > 0 ? work / span : 0;
  }

  /**
   * blockTrends works out each trend slice from the blocks found in it, by
   * their timestamps. The block time and the hashrate pool the blocks of the
   * POOLED_S up to each slice's end: the mean time to their parents, and
   * their work over that time, as avgHashrate estimates it. The difficulty
   * is the slice's own blocks' mean, and the transactions their total; the
   * fullness and the fees are means of the slice's blocks too, the fees of
   * those that reported them. Only blocks whose parent is known count
   * towards the time.
   */
  blockTrends(starts: number[]): Pick<Trends, "blocktime" | "hashrate" | "difficulty" | "transactions" | "fullness" | "fees"> {
    // The slices before the first that its pooled figures reach back over
    const lead = POOLED_SLICES - 1;
    const slices = Array.from({ length: lead + starts.length }, () => ({
      work: 0,
      time: 0,
      timed: 0,
      difficulty: 0,
      transactions: 0,
      fullness: 0,
      limited: 0,
      fees: 0,
      feeBlocks: 0,
      blocks: 0,
    }));
    const first = (starts[0] ?? 0) - lead * TREND_SLICE_S;

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      // A timestamp ahead of the clock counts in the slice in progress
      const index = Math.min(slices.length - 1, Math.floor((item.block.timestamp - first) / TREND_SLICE_S));

      if (index < 0) continue;

      const slice = slices[index];
      const parent = this.items[i + 1];
      const difficulty = Number(item.block.difficulty);

      slice.difficulty += difficulty;
      slice.transactions += item.block.txCount;
      slice.blocks++;

      if (item.block.gasLimit > 0) {
        slice.fullness += item.block.gasUsed / item.block.gasLimit;
        slice.limited++;
      }

      if (item.block.fees !== null) {
        slice.fees += Number(item.block.fees);
        slice.feeBlocks++;
      }

      if (parent?.height !== item.height - 1) continue;

      slice.work += difficulty;
      slice.time += item.block.timestamp - parent.block.timestamp;
      slice.timed++;
    }

    const shown = slices.slice(lead);
    // Totals over the POOLED_S to each shown slice's end, divided once: a mean of
    // each slice's own figure would weigh a short, lucky slice as much as a long one
    const pooled = shown.map((_, i) => {
      const window = slices.slice(i, i + POOLED_SLICES);

      return {
        work: window.reduce((sum, s) => sum + s.work, 0),
        time: window.reduce((sum, s) => sum + s.time, 0),
        timed: window.reduce((sum, s) => sum + s.timed, 0),
      };
    });

    return {
      blocktime: pooled.map((p) => (p.timed > 0 ? p.time / p.timed : null)),
      hashrate: pooled.map((p) => (p.time > 0 ? p.work / p.time : null)),
      difficulty: shown.map((s) => (s.blocks > 0 ? s.difficulty / s.blocks : null)),
      transactions: shown.map((s) => (s.blocks > 0 ? s.transactions : null)),
      fullness: shown.map((s) => (s.limited > 0 ? s.fullness / s.limited : null)),
      fees: shown.map((s) => (s.feeBlocks > 0 ? s.fees / s.feeBlocks : null)),
    };
  }

  /** minerWindow is the blocks of the last MINER_WINDOW_S by timestamp, newest first: the week the miner figures and the average block time cover. */
  private minerWindow(): Height[] {
    const head = this.items[0];

    return head ? this.items.filter((item) => item.block.timestamp > head.block.timestamp - MINER_WINDOW_S) : [];
  }

  /** minerCounts tallies blocks per miner, folding a known pool's addresses into one entry. */
  private minerCounts(window: Height[]): Map<string, MinerCount> {
    const byAddress = new Map<string, number>();

    for (const item of window) byAddress.set(item.block.miner, (byAddress.get(item.block.miner) ?? 0) + 1);

    const miners = new Map<string, MinerCount>();

    for (const [address, blocks] of byAddress) {
      const pool = this.pools.get(address) ?? null;
      const key = pool === null ? address : `pool:${pool.name}`;
      const entry = miners.get(key);

      if (!entry) {
        miners.set(key, { miner: address, pool, blocks });
      } else {
        if (blocks > (byAddress.get(entry.miner) ?? 0)) entry.miner = address;
        entry.blocks += blocks;
      }
    }

    return miners;
  }

  private miners(counts: Map<string, MinerCount>): MinerCount[] {
    return [...counts.values()]
      .sort((a, b) => b.blocks - a.blocks || (a.pool?.name ?? a.miner).localeCompare(b.pool?.name ?? b.miner))
      .slice(0, TOP_MINERS);
  }

  /** charts gathers the chart data; `heads` are the verified nodes' heads, for spotting splits. */
  charts(heads: Head[] = []): Omit<Charts, "trends"> {
    const recent = this.latest(HISTORY_BINS).reverse();
    const minerWindow = this.minerWindow();
    const minerCounts = this.minerCounts(minerWindow);
    const weekFees = minerWindow.flatMap((item) => (item.block.fees === null ? [] : [Number(item.block.fees)]));

    return {
      height: recent.map((item) => item.height),
      timestamp: recent.map((item) => item.block.timestamp),
      miner: recent.map((item) => item.block.miner),
      blocktime: recent.map((item) => item.block.time / 1000),
      avgBlocktime: this.avgBlocktime(minerWindow),
      difficulty: recent.map((item) => item.block.difficulty),
      difficultyWeek: this.difficultyChange(7 * 86_400),
      transactions: recent.map((item) => item.block.txCount),
      weekTransactions: minerWindow.reduce((sum, item) => sum + item.block.txCount, 0),
      weekFullness: weekFullness(minerWindow),
      weekFees: weekFees.length > 0 ? weekFees.reduce((a, b) => a + b, 0) / weekFees.length : null,
      weekFeeBlocks: weekFees.length,
      gasSpending: recent.map((item) => item.block.gasUsed),
      gasLimit: recent.map((item) => item.block.gasLimit),
      fees: recent.map((item) => item.block.fees),
      miners: this.miners(minerCounts),
      minerCount: minerCounts.size,
      minerBlocks: minerWindow.length,
      minerSpan: minerWindow.length > 1 ? minerWindow[0].block.timestamp - minerWindow[minerWindow.length - 1].block.timestamp : 0,
      propagation: this.blockPropagation(),
      health: this.health(heads),
      avgHashrate: this.avgHashrate(),
    };
  }

  /** deepReorgs lists the credible reorganizations DEEP_REORG blocks deep or more, as last measured. */
  deepReorgs(): { height: number; at: number; nodes: number; depth: number }[] {
    return this.reorgs
      .filter((e) => e.depth >= DEEP_REORG && this.credible(e.nodes, e.trusted))
      .map((e) => ({ height: e.height, at: e.at, nodes: e.nodes.size, depth: e.depth }));
  }

  /** timeline lists the history's blocks, for working out past incidents. */
  timeline(): TimelineBlock[] {
    return this.items.map((item) => ({ height: item.height, timestamp: item.block.timestamp, miner: item.block.miner }));
  }

  requiresUpdate(): boolean {
    return this.items.length < MAX_HISTORY;
  }

  /** historyRequest lists the most recent missing heights, or null when none are. */
  historyRequest(): HistoryRequest | null {
    // One block, the head a node reports on login, is enough to know which heights to ask for
    if (this.items.length === 0) return null;

    const best = this.bestBlockNumber();
    const present = new Set(this.items.map((item) => item.height));
    const missing: number[] = [];

    // Genesis is never recorded, so start at block 1
    for (let n = best; n >= Math.max(1, best - MAX_HISTORY) && missing.length < HISTORY_REQUEST_SIZE; n--) {
      if (!present.has(n)) missing.push(n);
    }

    if (missing.length === 0) return null;

    missing.reverse();

    return { min: missing[0], max: missing.at(-1)!, list: missing };
  }
}
