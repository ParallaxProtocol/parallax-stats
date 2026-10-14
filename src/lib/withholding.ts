// Whether the largest miner is still mining in the open. To replace
// payments it has to mine a chain in secret, and the hashrate it gives that
// chain is missing from the public one: its own blocks stop coming, or come
// slower than its share says they should. A silence is judged by the clock,
// so a miner that stops is caught within hours. A slowdown is judged by the
// clock and against the other miners' blocks too: when hashrate leaves every
// pool alike, its blocks come slower but still at its share of the public
// chain's, which hidden mining cannot do. Judged the same way on the page,
// in the API and for the incident record.

import { shortHash } from "./format.ts";
import type { Charts } from "./protocol.ts";

/**
 * How many of the largest miner's newest blocks the server sends, and the
 * watch looks back over: a day of them at most, as long as the longest wait
 * it vouches for.
 */
export const WATCH_BLOCKS = 144;
/** A miner with less than this share cannot get far in secret: its quiet spells are left alone. */
export const WATCH_MIN_SHARE = 0.25;
/** Fewer blocks in the week than this say too little about the miner's share. */
export const WATCH_MIN_BLOCKS = 10;
/** A quiet spell this unlikely for a miner mining in the open raises a warning (amber)... */
export const UNUSUAL_CHANCE = 1e-4;
/** ...and one this unlikely, a critical alert (red). */
export const HIDDEN_CHANCE = 1e-6;
/** Below this the miner is no longer called mining in the open, though it is not yet a warning (grey). */
export const OPEN_CHANCE = 0.01;

/** The quietest stretch of the largest miner's recent blocks, and what it says. */
export interface Watch {
  /** The miner: a known pool by name, anyone else by a shortened address. */
  name: string;
  /** Its share of the week's blocks. */
  share: number;
  /** Its newest block; `timestamp` in unix seconds. */
  last: { height: number; timestamp: number };
  /**
   * The stretch from one of its recent blocks to now in which it published
   * fewest blocks for its share: from `height`, `found` of its blocks after
   * it against `expected`, over `seconds`, out of the `published` blocks
   * after it from every miner (null when the newest height is not known).
   * Blocks after `height` are the ones a secret chain started there would
   * replace.
   */
  stretch: { height: number; timestamp: number; found: number; expected: number; seconds: number; published: number | null };
  /**
   * The chance of a stretch that quiet from a miner mining in the open,
   * allowing for the stretches looked at: under OPEN_CHANCE it is no longer
   * called open, and under UNUSUAL_CHANCE it warns.
   */
  chance: number;
  level: "warn" | "critical" | null;
}

/** poissonAtMost is the chance of at most `k` events where `mean` are expected. */
export function poissonAtMost(k: number, mean: number): number {
  if (mean <= 0) return 1;

  let term = Math.exp(-mean);
  let sum = term;

  for (let i = 1; i <= k; i++) {
    term *= mean / i;
    sum += term;
  }

  return Math.min(1, sum);
}

/**
 * binomialAtMost is the chance of at most `k` successes in `n` tries of
 * chance `p`, summed as logarithms so that long stretches do not underflow.
 */
export function binomialAtMost(k: number, n: number, p: number): number {
  if (k >= n || p <= 0) return 1;
  if (k < 0 || p >= 1) return 0;

  const lnOdds = Math.log(p) - Math.log1p(-p);
  // ln of the chance of exactly i, from i = 0
  let lnTerm = n * Math.log1p(-p);
  const terms = [lnTerm];

  for (let i = 1; i <= k; i++) {
    lnTerm += Math.log(n - i + 1) - Math.log(i) + lnOdds;
    terms.push(lnTerm);
  }

  const top = Math.max(...terms);

  return Math.min(1, Math.exp(top) * terms.reduce((sum, t) => sum + Math.exp(t - top), 0));
}

/**
 * stretchWeight is what the chance of the stretch from a miner's `j`th
 * newest block is multiplied by, for the stretches looked at to be unlucky
 * in: the longer ones overlap, so it grows with how many times longer than
 * the shortest the stretch is, not with how many there are.
 */
export function stretchWeight(j: number): number {
  return 1 + Math.log2(j);
}

/**
 * quietest looks back from `now` (unix seconds) over a miner's newest
 * blocks, newest first, and finds the stretch it published least in for
 * finding a block every `interval` seconds on average. The stretch from its
 * `j`th newest block holds `j - 1` of its blocks; its chance is weighed by
 * stretchWeight. Given the public chain's newest height and the miner's
 * `share`, a stretch it published in is only as unlikely as the likelier
 * of the clock and its share of the blocks every miner published after it:
 * hashrate leaving every pool slows them all alike.
 */
export function quietest(
  blocks: { height: number; timestamp: number }[],
  interval: number,
  now: number,
  chain: { head: number; share: number } | null = null,
): Pick<Watch, "stretch" | "chance"> | null {
  if (blocks.length === 0 || interval <= 0) return null;

  let best: Pick<Watch, "stretch" | "chance"> | null = null;

  for (let j = 1; j <= blocks.length; j++) {
    const from = blocks[j - 1];
    const found = j - 1;
    // A timestamp a little ahead of the clock is allowed, and counts as now
    const seconds = Math.max(0, now - from.timestamp);
    const expected = seconds / interval;
    const published = chain ? Math.max(found, chain.head - from.height) : null;
    let odds = poissonAtMost(found, expected);

    // A silence stays judged by the clock alone: the other miners' few blocks meanwhile say too little, too late
    if (found > 0 && published !== null) odds = Math.max(odds, binomialAtMost(found, published, chain!.share));

    const chance = Math.min(1, stretchWeight(j) * odds);

    if (!best || chance < best.chance) best = { stretch: { height: from.height, timestamp: from.timestamp, found, expected, seconds, published }, chance };
  }

  return best;
}

/** open reports whether a watched miner is mining in the open: neither warned of nor unusually quiet. */
export function open(watched: Watch | null): boolean {
  return watched !== null && watched.chance >= OPEN_CHANCE;
}

/**
 * watch judges the largest miner of the week by its newest blocks at `now`,
 * ms: null while there is too little to judge by, or the miner is too small
 * to matter, or the server sends no blocks of it.
 */
export function watch(charts: Charts | null, now: number): Watch | null {
  const top = charts?.miners[0];
  const total = charts?.minerBlocks ?? 0;
  const blocks = charts?.topMinerBlocks ?? [];

  if (!charts || !top || total < WATCH_MIN_BLOCKS || blocks.length === 0 || charts.avgBlocktime <= 0) return null;

  const share = top.blocks / total;

  if (share < WATCH_MIN_SHARE) return null;

  const head = charts.height.at(-1);
  const found = quietest(blocks, charts.avgBlocktime / share, now / 1000, head !== undefined ? { head: Math.max(head, blocks[0].height), share } : null);

  if (!found) return null;

  return {
    name: top.pool?.name ?? shortHash(top.miner),
    share,
    last: blocks[0],
    ...found,
    level: found.chance < HIDDEN_CHANCE ? "critical" : found.chance < UNUSUAL_CHANCE ? "warn" : null,
  };
}
