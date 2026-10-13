// What mining pays and what is waiting to be mined, worked out the same way
// for the page's figures and the API.

import { blockReward, WEI_PER_LAX } from "./emission.ts";
import { mempoolPressure } from "./format.ts";
import { TARGET_BLOCK_TIME, type Charts } from "./protocol.ts";

/**
 * blockPay is what the next block pays, in LAX: its reward, and the fees of
 * recent blocks on average, where reported.
 */
export function blockPay(bestBlock: number, fees: (string | null)[]): number {
  const known = fees.filter((f): f is string => f !== null);
  const meanFees = known.length > 0 ? known.reduce((sum, f) => sum + Number(BigInt(f)), 0) / known.length : 0;

  return (Number(blockReward(bestBlock + 1)) + meanFees) / Number(WEI_PER_LAX);
}

/**
 * hashprice is what 1 H/s earns in a day, in LAX. Each block takes
 * `difficulty` hashes on average, so a hash earns the block's pay over the
 * difficulty, whatever luck does to block times.
 */
export function hashprice(pay: number, difficulty: number): number {
  return difficulty > 0 ? (86_400 * pay) / difficulty : 0;
}

/** dailyPay is what miners earn in a day, in LAX, at one block every `blocktime` seconds: what it would cost to rival them. */
export function dailyPay(pay: number, blocktime: number): number {
  return (86_400 / blocktime) * pay;
}

/** scheduledPay is what miners earn in a day at the target block time. */
export function scheduledPay(pay: number): number {
  return dailyPay(pay, TARGET_BLOCK_TIME);
}

/** newCoins is the LAX issued in a day at one block every `blocktime` seconds, before fees: what miners have to sell. */
export function newCoins(bestBlock: number, blocktime: number): number {
  return dailyPay(Number(blockReward(bestBlock + 1)) / Number(WEI_PER_LAX), blocktime);
}

/** latestPace is the newest slice of the block time trend: today's pace of blocks. */
export function latestPace(blocktime: (number | null)[]): number | null {
  return [...blocktime].reverse().find((t) => t !== null) ?? null;
}

/**
 * pressureOf turns a count of waiting transactions into the room they need,
 * as a share of a block: each is taken to need what the recent blocks'
 * transactions did on average, against the newest block's gas limit. Null
 * while either is unknown.
 */
export function pressureOf(pending: number | null, charts: Charts | null): number | null {
  const txs = (charts?.transactions ?? []).reduce((sum, n) => sum + n, 0);
  const gasPerTx = txs > 0 ? (charts?.gasSpending ?? []).reduce((sum, g) => sum + g, 0) / txs : 0;
  const gasLimit = charts?.gasLimit.at(-1) ?? 0;

  return pending !== null && gasLimit > 0 ? mempoolPressure(pending, gasPerTx, gasLimit) : null;
}
