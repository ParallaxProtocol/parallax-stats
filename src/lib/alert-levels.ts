// When each warning applies, in one place: the banners at the top of the
// page and the sections they are about are tinted by the same rules.

import { STALL_MS } from "./format.ts";
import { PROPAGATION_BANDS, TARGET_BLOCK_TIME, type Charts, type ChainHealth, type PropagationStats } from "./protocol.ts";

export type Level = "warn" | "critical";

/** Reorganizations stay on the banner, and tint their section, this long; critical ones longer. */
export const REORG_ALERT_MS = 30 * 60 * 1000;
export const CRITICAL_REORG_ALERT_MS = 24 * 60 * 60 * 1000;
/** A reorganization replacing this many blocks or more raises an alert (amber)... */
export const DEEP_REORG = 3;
/** ...and one replacing this many or more, a critical one (red): amber covers 3 to 5. */
export const VERY_DEEP_REORG = 6;
/** Fewer blocks than this say too little about who mines. */
export const MAJORITY_MIN_BLOCKS = 10;
/** Blocks taking longer than these to reach most verified nodes are slow, and far too slow. */
export const SLOW_SPREAD_MS = PROPAGATION_BANDS[1];
export const VERY_SLOW_SPREAD_MS = PROPAGATION_BANDS[2];

/**
 * staleChance is the chance another miner finds a competing block while one
 * takes `ms` to reach the network: blocks come as a Poisson process at the
 * target block time.
 */
export function staleChance(ms: number): number {
  return 1 - Math.exp(-ms / 1000 / TARGET_BLOCK_TIME);
}

/** stallLevel: no block for longer than the stall threshold. */
export function stallLevel(foundAt: number, now: number): Level | null {
  return foundAt > 0 && now - foundAt > STALL_MS ? "critical" : null;
}

/**
 * deepReorg is the latest reorganization while recent and DEEP_REORG blocks
 * deep or more. Shallower ones are routine on proof of work: they show in
 * the stale blocks figures, without an alert.
 */
export function deepReorg(health: ChainHealth | null, now: number): ChainHealth["lastReorg"] {
  // A server from before lastDeepReorg only reports the latest one
  const reorg = health?.lastDeepReorg !== undefined ? health.lastDeepReorg : health?.lastReorg;

  if (!reorg || (reorg.depth ?? 1) < DEEP_REORG) return null;

  const lasts = reorgLevel(reorg.depth ?? 1) === "critical" ? CRITICAL_REORG_ALERT_MS : REORG_ALERT_MS;

  return now - reorg.at < lasts ? reorg : null;
}

/** reorgLevel: amber from DEEP_REORG blocks deep, red from VERY_DEEP_REORG. */
export function reorgLevel(depth: number): Level {
  return depth >= VERY_DEEP_REORG ? "critical" : "warn";
}

/** chainLevel: verified nodes on different chains, or a recent deep reorganization. */
export function chainLevel(health: ChainHealth | null, now: number): Level | null {
  if (health?.split) return "critical";

  const reorg = deepReorg(health, now);

  return reorg ? reorgLevel(reorg.depth ?? 1) : null;
}

/** majority is the top miner while it found more than half of the last week's blocks. */
export function majority(charts: Charts | null): { miner: Charts["miners"][number]; share: number; blocks: number } | null {
  const top = charts?.miners[0];
  const blocks = charts?.minerBlocks ?? 0;

  return top && blocks >= MAJORITY_MIN_BLOCKS && top.blocks * 2 > blocks ? { miner: top, share: top.blocks / blocks, blocks } : null;
}

export function majorityLevel(charts: Charts | null): Level | null {
  return majority(charts) ? "critical" : null;
}

/** spreadLevel: blocks slow to reach most verified nodes, or one miner's blocks consistently slow. */
export function spreadLevel(propagation: PropagationStats | null | undefined): Level | null {
  const spread = propagation?.spread;

  if (!spread) return null;
  if (spread.median > VERY_SLOW_SPREAD_MS) return "critical";
  if (spread.median > SLOW_SPREAD_MS || spread.slowMiner) return "warn";

  return null;
}
