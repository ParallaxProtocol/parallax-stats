// What went wrong and when: the conditions the alerts warn of, recorded on
// the server as incidents with a start and an end, so the page can show a
// timeline and it survives restarts. A condition must hold for a while
// before it opens an incident, and be gone for a while before it closes
// one, so a figure hovering around a threshold does not leave dozens.

import { DEEP_REORG, majority, reorgLevel, SLOW_SPREAD_MS, spreadLevel } from "../lib/alert-levels.ts";
import { formatClock, formatInt, formatMs, shortHash } from "../lib/format.ts";
import type { Charts, Incident, IncidentKind, IncidentLog, MiningPool } from "../lib/protocol.ts";
import { HIDDEN_CHANCE, UNUSUAL_CHANCE, watch, WATCH_MIN_BLOCKS, WATCH_MIN_SHARE } from "../lib/withholding.ts";

/** Incidents kept, by when they ended: the page shows 30 days of them. */
export const KEEP_MS = 90 * 86_400_000;
const MAX_INCIDENTS = 500;

/** How long a condition must hold before it opens an incident, and be gone before it closes one. */
const CONFIRM_MS = 10 * 60_000;
/**
 * The largest miner going quiet needs no confirming: it only applies once
 * the quiet is already unlikely, and ends with its next block.
 */
const QUIET_CONFIRM_MS = 0;

/** The 7 day window the majority is judged over, as on the page; a little short, for the week's first block. */
const MAJORITY_WINDOW_S = 7 * 86_400;
const MAJORITY_FULL_S = MAJORITY_WINDOW_S - 3_600;

const RANK = { warn: 1, critical: 2 } as const;

/** The kinds recorded; saved incidents of any other kind, from an earlier version, are dropped. */
const KINDS = new Set<IncidentKind>(["majority", "withholding", "spread", "split", "reorg"]);

type Level = Incident["level"];
type SpanKind = Exclude<IncidentKind, "reorg">;

/** A condition as it stands: how bad, a number to compare how bad within a level, and in words. */
export interface Observation {
  level: Level;
  peak: number;
  detail: string;
  /** When the condition began, when it knows: a quiet spell began with the miner's last block. */
  since?: number;
}

/** An incident as kept: with the number its worst point was judged by. */
interface Record extends Incident {
  peak: number;
}

export interface IncidentsState {
  since: number;
  rebuiltFrom: number | null;
  rebuilt: boolean;
  list: Record[];
}

/** A block as the rebuild needs it. */
export interface TimelineBlock {
  height: number;
  /** Unix seconds. */
  timestamp: number;
  miner: string;
}

const plural = (count: number, word: string) => `${formatInt(count)} ${count === 1 ? word : `${word}s`}`;

/** observe works out which conditions hold now, by the rules the alerts use. */
export function observe(charts: Charts | null, now: number): Partial<{ [K in SpanKind]: Observation }> {
  const seen: Partial<{ [K in SpanKind]: Observation }> = {};
  const split = charts?.health.split ?? null;

  if (split) {
    seen.split = {
      level: "critical",
      peak: split.chains * 1000 + split.nodes,
      detail: `Verified nodes on ${split.chains} chains${split.height !== null ? `, parting after block #${formatInt(split.height)}` : ""}`,
    };
  }

  const held = majority(charts);

  if (held) {
    const name = held.miner.pool?.name ?? shortHash(held.miner.miner);

    seen.majority = { level: "critical", peak: held.share, detail: `${name} mined ${Math.round(held.share * 100)}% of the week's blocks` };
  }

  const quiet = watch(charts, now);

  if (quiet?.level) seen.withholding = { level: quiet.level, peak: -Math.log10(quiet.chance), detail: quietDetail(quiet.name, quiet.stretch), since: quiet.stretch.timestamp * 1000 };

  const spread = charts?.propagation.spread ?? null;
  const spreadAt = spreadLevel(charts?.propagation);

  if (spread && spreadAt) {
    seen.spread =
      spread.median > SLOW_SPREAD_MS || !spread.slowMiner
        ? { level: spreadAt, peak: spread.median, detail: `Blocks took ${formatMs(spread.median)} to reach most nodes` }
        : {
            level: spreadAt,
            peak: spread.slowMiner.median,
            detail: `Blocks from ${spread.slowMiner.pool ?? shortHash(spread.slowMiner.miner)} took ${formatMs(spread.slowMiner.median)} to reach most nodes`,
          };
  }

  return seen;
}

/** quietDetail says how quiet the largest miner has been: rplant.xyz published no block after #59,663 for 2 h 05 min. */
function quietDetail(name: string, stretch: { height: number; found: number; expected: number; seconds: number }): string {
  return stretch.found === 0
    ? `${name} published no block after #${formatInt(stretch.height)} for ${formatClock(stretch.seconds * 1000)}`
    : `${name} published ${plural(stretch.found, "block")} after #${formatInt(stretch.height)} in ${formatClock(stretch.seconds * 1000)}, against ${formatInt(Math.round(stretch.expected))} expected`;
}

/** worse reports whether an observation is worse than what an incident has recorded. */
function worse(seen: Observation, record: Record): boolean {
  return RANK[seen.level] > RANK[record.level] || (seen.level === record.level && seen.peak > record.peak);
}

export class Incidents {
  private since: number;
  private rebuiltFrom: number | null = null;
  private rebuilt = false;
  /** Newest first. */
  private list: Record[] = [];
  /** A condition seen but not yet held long enough: since when it applies, and when it was first seen. */
  private pending = new Map<SpanKind, { since: number; seen: number }>();
  /** A condition gone, from when, while its incident waits to close. */
  private clear = new Map<SpanKind, number>();

  constructor(now = Date.now()) {
    this.since = now;
  }

  /** update records the conditions holding at `now`, opening, worsening and closing incidents. It reports whether anything changed. */
  update(seen: Partial<{ [K in SpanKind]: Observation }>, now: number): boolean {
    let changed = false;

    for (const kind of ["majority", "withholding", "spread", "split"] as const) {
      const observation = seen[kind];
      const open = this.list.find((r) => r.kind === kind && r.end === null);
      const confirm = kind === "withholding" ? QUIET_CONFIRM_MS : CONFIRM_MS;

      if (observation) {
        this.clear.delete(kind);

        if (open) {
          if (worse(observation, open)) {
            Object.assign(open, { level: observation.level, peak: observation.peak, detail: observation.detail });
            changed = true;
          }

          continue;
        }

        const pending = this.pending.get(kind) ?? { since: observation.since ?? now, seen: now };

        this.pending.set(kind, pending);

        if (now - pending.seen < confirm) continue;

        this.pending.delete(kind);
        this.add({ kind, start: pending.since, startKnown: true, end: null, ...observation });
        changed = true;
      } else {
        this.pending.delete(kind);

        if (!open) continue;

        // It ended when it was first seen gone, however long the close waited
        const gone = this.clear.get(kind) ?? now;

        this.clear.set(kind, gone);

        if (now - gone < confirm) continue;

        this.clear.delete(kind);
        open.end = gone;
        changed = true;
      }
    }

    return this.prune(now) || changed;
  }

  /**
   * reorgs records deep reorganizations as moments, by when they happened.
   * One is often measured as shallow at first and found deeper later: its
   * record follows.
   */
  reorgs(events: { height: number; at: number; nodes: number; depth: number }[], now: number): boolean {
    let changed = false;

    for (const event of events) {
      if (event.depth < DEEP_REORG || event.at < now - KEEP_MS) continue;

      const id = `reorg:${event.at}`;
      const known = this.list.find((r) => r.id === id);
      const detail = `${plural(event.depth, "block")} replaced at #${formatInt(event.height)}, seen by ${plural(event.nodes, "node")}`;

      if (known) {
        if (event.depth > known.peak) {
          Object.assign(known, { level: reorgLevel(event.depth), peak: event.depth, detail });
          changed = true;
        }

        continue;
      }

      this.add({ kind: "reorg", level: reorgLevel(event.depth), peak: event.depth, detail, start: event.at, startKnown: true, end: event.at });
      changed = true;
    }

    return changed;
  }

  get needsRebuild(): boolean {
    return !this.rebuilt;
  }

  /**
   * rebuild works out, once, the incidents saved blocks can tell of from
   * before recording began: a mining majority, judged over 7 days as on the page; and the
   * largest miner going quiet, from gaps between its own blocks, judged by
   * its share of the 7 days up to the block that ended the gap. A majority
   * holding from the first moment there are 7 days to judge began before
   * then, so its start is not known. Others need what nodes reported at the
   * time, which is gone. Pass no blocks to give up on rebuilding.
   */
  rebuild(blocks: TimelineBlock[], pools: Map<string, MiningPool>): void {
    this.rebuilt = true;

    const chain = [...blocks].sort((a, b) => a.height - b.height);

    if (chain.length < 2) return;

    this.rebuiltFrom = chain[0].timestamp * 1000;

    // Majority: the 7 days of blocks up to each block, a known pool's addresses counted together
    const key = (b: TimelineBlock) => (pools.has(b.miner) ? `pool:${pools.get(b.miner)!.name}` : b.miner);
    const named = (k: string) => (k.startsWith("pool:") ? k.slice(5) : shortHash(k));
    const counts = new Map<string, number>();
    let first = 0;
    let judged = false;
    let open: Record | null = null;
    // Confirmed as the live record confirms: held, or gone, for CONFIRM_MS
    let pending: { since: number; startKnown: boolean } | null = null;
    let gone: number | null = null;
    // Each miner's latest block so far, by its place in the chain, for the gaps between its blocks
    const latest = new Map<string, number>();

    for (let i = 0; i < chain.length; i++) {
      const block = chain[i];

      counts.set(key(block), (counts.get(key(block)) ?? 0) + 1);

      while (chain[first].timestamp <= block.timestamp - MAJORITY_WINDOW_S) {
        counts.set(key(chain[first]), counts.get(key(chain[first]))! - 1);
        first++;
      }

      // The largest miner quiet since its previous block, as the live watch judges its newest gap
      const place = latest.get(key(block));
      const before = place !== undefined ? chain[place] : undefined;
      // Only a gap whose every block is saved: a missing one could have been the miner's
      const unbroken = before !== undefined && block.height - before.height === i - place!;
      const windowBlocks = i - first + 1;
      const own = counts.get(key(block))!;
      let largest = true;

      for (const count of counts.values()) if (count > own) largest = false;

      latest.set(key(block), i);

      if (before && unbroken && largest && windowBlocks >= WATCH_MIN_BLOCKS && own / windowBlocks >= WATCH_MIN_SHARE && block.timestamp > chain[first].timestamp) {
        const interval = (block.timestamp - chain[first].timestamp) / (windowBlocks - 1) / (own / windowBlocks);
        const seconds = block.timestamp - before.timestamp;
        const chance = Math.exp(-seconds / interval);

        if (chance < UNUSUAL_CHANCE) {
          this.add({
            kind: "withholding",
            level: chance < HIDDEN_CHANCE ? "critical" : "warn",
            peak: -Math.log10(chance),
            detail: quietDetail(named(key(block)), { height: before.height, found: 0, expected: seconds / interval, seconds }),
            start: before.timestamp * 1000,
            startKnown: true,
            end: block.timestamp * 1000,
          });
        }
      }

      // Judged only with a full week behind it, as the page does
      if (block.timestamp - chain[0].timestamp < MAJORITY_FULL_S) continue;

      const total = i - first + 1;
      let top: [string, number] = ["", 0];

      for (const entry of counts) if (entry[1] > top[1]) top = entry;

      const share = top[1] / total;
      const held = total >= 10 && top[1] * 2 > total;
      const detail = `${named(top[0])} mined ${Math.round(share * 100)}% of the week's blocks`;
      const at = block.timestamp * 1000;

      if (held) {
        gone = null;

        if (open) {
          if (share > open.peak) Object.assign(open, { peak: share, detail });
        } else {
          // Holding from the first moment it can be judged: it began earlier, when is not known
          pending ??= { since: at, startKnown: judged };

          if (at - pending.since >= CONFIRM_MS) {
            open = { id: "", kind: "majority", level: "critical", peak: share, detail, start: pending.since, startKnown: pending.startKnown, end: null };
            pending = null;
          }
        }
      } else {
        pending = null;

        if (open) {
          gone ??= at;

          if (at - gone >= CONFIRM_MS) {
            open.end = gone;
            this.add(open);
            open = null;
            gone = null;
          }
        }
      }

      judged = true;
    }

    // Still holding: left open, for the live record to carry on
    if (open) this.add(open);
  }

  /** log is what viewers get: the last KEEP_MS of incidents, newest first. */
  log(): IncidentLog {
    return { since: this.since, rebuiltFrom: this.rebuiltFrom, list: this.list.map(({ id, kind, level, start, startKnown, end, detail }) => ({ id, kind, level, start, startKnown, end, detail })) };
  }

  toState(): IncidentsState {
    return { since: this.since, rebuiltFrom: this.rebuiltFrom, rebuilt: this.rebuilt, list: this.list };
  }

  /** restore takes saved incidents, keeping only well-formed ones. */
  restore(state: IncidentsState | undefined): void {
    if (!state || typeof state.since !== "number") return;

    this.since = state.since;
    this.rebuiltFrom = typeof state.rebuiltFrom === "number" ? state.rebuiltFrom : null;
    this.rebuilt = state.rebuilt === true;
    this.list = (Array.isArray(state.list) ? state.list : [])
      .filter((r) => r && KINDS.has(r.kind) && typeof r.id === "string" && typeof r.start === "number" && (r.end === null || typeof r.end === "number"))
      .sort((a, b) => b.start - a.start);
  }

  private add(record: Omit<Record, "id"> & { id?: string }): void {
    const incident: Record = { ...record, id: record.kind === "reorg" ? `reorg:${record.start}` : `${record.kind}:${record.start}` };

    this.list.push(incident);
    this.list.sort((a, b) => b.start - a.start);
  }

  /** prune forgets incidents that ended more than KEEP_MS ago, and the oldest past MAX_INCIDENTS. */
  private prune(now: number): boolean {
    const before = this.list.length;

    this.list = this.list.filter((r) => r.end === null || r.end >= now - KEEP_MS).slice(0, MAX_INCIDENTS);

    return this.list.length !== before;
  }
}
