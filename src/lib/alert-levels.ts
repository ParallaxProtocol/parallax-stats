// When each warning applies, in one place: the banners at the top of the
// page and the sections they are about are tinted by the same rules.

import { STALL_MS } from "./format.ts";
import type { Charts, ChainHealth, PropagationStats } from "./protocol.ts";

export type Level = "warn" | "critical";

/** Reorganizations stay on the banner, and tint their section, this long. */
export const REORG_ALERT_MS = 30 * 60 * 1000;
/** A reorganization replacing this many blocks or more is a serious one. */
export const DEEP_REORG = 3;
/** Fewer blocks than this say too little about who mines. */
export const MAJORITY_MIN_BLOCKS = 10;
/** Blocks taking longer than these to reach most verified nodes are slow, and far too slow. */
export const SLOW_SPREAD_MS = 15_000;
export const VERY_SLOW_SPREAD_MS = 60_000;

/** stallLevel: no block for longer than the stall threshold. */
export function stallLevel(foundAt: number, now: number): Level | null {
  return foundAt > 0 && now - foundAt > STALL_MS ? "critical" : null;
}

/** recentReorg is the latest reorganization while it is recent enough to call out. */
export function recentReorg(health: ChainHealth | null, now: number): ChainHealth["lastReorg"] {
  return health?.lastReorg && now - health.lastReorg.at < REORG_ALERT_MS ? health.lastReorg : null;
}

/** chainLevel: verified nodes on different chains, or a recent reorganization, deep or not. */
export function chainLevel(health: ChainHealth | null, now: number): Level | null {
  if (health?.split) return "critical";

  const reorg = recentReorg(health, now);

  if (!reorg) return null;

  return (reorg.depth ?? 1) >= DEEP_REORG ? "critical" : "warn";
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
