// Shared block history: every height nodes have reported, the forks seen
// at each height, and when each node reported which fork. Block times,
// propagation delays and the charts are all derived from it.

import {
  HISTORY_BINS,
  PROPAGATION_BANDS,
  type Block,
  type ChainHealth,
  type Charts,
  type MinerCount,
  type PropagationStats,
} from "../lib/protocol.ts";
import type { ReportedBlock } from "./sanitize.ts";

const MAX_HISTORY = 2000;
const HASHRATE_WINDOW = 64;
const TOP_MINERS = 10;

/** Reports of the same reorganization by different nodes within this long count once. */
const REORG_GROUP_MS = 2 * 60 * 1000;
const REORG_PERIOD_MS = 24 * 60 * 60 * 1000;
const MAX_REORG_EVENTS = 200;
const RECENT_STALE = 5;
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
}

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

export class History {
  /** Sorted by height, highest first. */
  private items: Height[] = [];
  private trustedOnly = false;
  private reorgs: ReorgEvent[] = [];
  private readonly startedAt = Date.now();

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
   * with its timing fields filled in, or null when the block was not
   * recorded (genesis, a height no trusted node has seen while one is
   * online, or one past the fork limit).
   */
  add(reported: ReportedBlock, id: string, trusted: boolean, addingHistory = false): HistoryBlock | null {
    if (reported.number <= 0) return null;

    const height = this.search(reported.number);

    if (!trusted && this.trustedOnly && !height) return null;

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
        item.propagTimes.push({ node: id, trusted, fork: 0, received: now, propagation: 0 });
        this.save(item);
        this.fillChildTimes(item.height);
      }

      return block;
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
      height.propagTimes.push({ node: id, trusted, fork: forkIndex, received: now, propagation: block.propagation });
    }

    // A trusted report decides which fork the height shows
    if (trusted && !sameBlock(height.block, height.forks[forkIndex])) {
      height.forks[forkIndex].trusted = true;
      height.block = height.forks[forkIndex];
    }

    block.fork = forkIndex;

    return block;
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

    const last = this.reorgs.at(-1);

    if (last && now - last.at < REORG_GROUP_MS && Math.abs(last.height - reported.number) <= 2) {
      last.nodes.add(id);
      last.trusted ||= trusted;
      last.height = Math.min(last.height, reported.number);
      return;
    }

    this.reorgs.push({ height: reported.number, at: now, nodes: new Set([id]), trusted });

    if (this.reorgs.length > MAX_REORG_EVENTS) this.reorgs.shift();
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

  private health(now = Date.now()): ChainHealth {
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

    const since = Math.max(now - REORG_PERIOD_MS, this.startedAt);
    const counted = this.reorgs.filter((e) => this.credible(e.nodes, e.trusted));
    const last = counted.at(-1);

    return {
      window: this.items.length,
      staleBlocks,
      recentStale: stale.slice(0, RECENT_STALE),
      reorgs: counted.filter((e) => e.at >= since).length,
      since,
      lastReorg: last ? { height: last.height, at: last.at, nodes: last.nodes.size } : null,
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
   * later one (or how long ago the height arrived), or -1 outside the
   * history.
   */
  nodePropagation(id: string): number[] {
    const propagation = new Array<number>(HISTORY_BINS).fill(-1);
    const best = this.bestBlockNumber();
    let lastArrival = Date.now();

    for (const item of this.latest(HISTORY_BINS)) {
      const index = HISTORY_BINS - 1 - best + item.height;

      if (index < 0) continue;

      const own = item.propagTimes.find((p) => p.node === id);

      if (own) {
        propagation[index] = own.propagation;
        lastArrival = item.block.arrived;
      } else {
        propagation[index] = Math.max(0, lastArrival - item.block.arrived);
      }
    }

    return propagation;
  }

  /**
   * blockPropagation summarizes how long blocks took to reach nodes after
   * the first report. First reports are left out: their delay is 0 by
   * definition, and counting them would pull every figure down.
   */
  private blockPropagation(): PropagationStats {
    const samples: number[] = [];

    for (const item of this.items) {
      for (const p of item.propagTimes) if (p.propagation > 0) samples.push(p.propagation);
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
    };
  }

  /** avgBlocktime is the mean time between blocks, in seconds, over blocks whose parent is known. */
  private avgBlocktime(): number {
    const times = this.items.filter((item) => item.block.time > 0).map((item) => item.block.time);

    return times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length / 1000 : 0;
  }

  /**
   * avgHashrate estimates network hashes per second as the total work of the
   * newest unbroken run of blocks over the time it took: each block takes
   * `difficulty` hashes on average.
   */
  private avgHashrate(): number {
    const run: Height[] = [];

    for (const item of this.items) {
      if (run.length > 0 && item.height !== run.at(-1)!.height - 1) break;

      run.push(item);

      if (run.length > HASHRATE_WINDOW) break;
    }

    if (run.length < 2) return 0;

    const span = run[0].block.timestamp - run.at(-1)!.block.timestamp;
    // The oldest block's work came before the span starts
    const work = run.slice(0, -1).reduce((sum, item) => sum + Number(item.block.difficulty), 0);

    return span > 0 ? work / span : 0;
  }

  private minerCounts(): Map<string, number> {
    const counts = new Map<string, number>();

    for (const item of this.latest(HISTORY_BINS)) counts.set(item.block.miner, (counts.get(item.block.miner) ?? 0) + 1);

    return counts;
  }

  private miners(counts: Map<string, number>): MinerCount[] {
    return [...counts]
      .map(([miner, blocks]) => ({ miner, blocks }))
      .sort((a, b) => b.blocks - a.blocks || a.miner.localeCompare(b.miner))
      .slice(0, TOP_MINERS);
  }

  charts(): Charts {
    const recent = this.latest(HISTORY_BINS).reverse();
    const minerCounts = this.minerCounts();

    return {
      height: recent.map((item) => item.height),
      blocktime: recent.map((item) => item.block.time / 1000),
      avgBlocktime: this.avgBlocktime(),
      difficulty: recent.map((item) => item.block.difficulty),
      transactions: recent.map((item) => item.block.txCount),
      gasSpending: recent.map((item) => item.block.gasUsed),
      gasLimit: recent.map((item) => item.block.gasLimit),
      fees: recent.map((item) => item.block.fees),
      miners: this.miners(minerCounts),
      minerCount: minerCounts.size,
      propagation: this.blockPropagation(),
      health: this.health(),
      avgHashrate: this.avgHashrate(),
    };
  }

  requiresUpdate(): boolean {
    return this.items.length < MAX_HISTORY;
  }

  /** historyRequest lists the most recent missing heights, or null when none are. */
  historyRequest(): HistoryRequest | null {
    if (this.items.length < 2) return null;

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
