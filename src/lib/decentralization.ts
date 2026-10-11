// How spread out mining is, judged the same way on the page and in the API.

import type { Grade } from "./format.ts";

/** Fewer blocks than this say too little about who mines to grade. */
export const DECENTRALIZATION_MIN_BLOCKS = 10;

/**
 * majorityHolders is the fewest miners that together found more than half
 * of the blocks (the Nakamoto coefficient over the window), or null when
 * the miners listed do not reach a majority.
 */
export function majorityHolders(miners: { blocks: number }[], total: number): number | null {
  let sum = 0;

  for (let i = 0; i < miners.length; i++) {
    sum += miners[i].blocks;

    if (sum * 2 > total) return i + 1;
  }

  return null;
}

/**
 * gradeDecentralization grades how many miners it takes to hold a majority
 * of recent blocks, which is how many would have to collude to rewrite
 * the chain. null means more than the miners listed.
 */
export function gradeDecentralization(majority: number | null): { grade: Grade; verdict: string } {
  if (majority === null || majority >= 4) return { grade: "good", verdict: "Healthy" };
  if (majority === 3) return { grade: "warn", verdict: "Fair" };
  if (majority === 2) return { grade: "serious", verdict: "Concentrated" };

  return { grade: "critical", verdict: "Critical" };
}
