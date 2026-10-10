// Parallax's coin issuance, mirroring kernel/xhash in the protocol source
// (calcBlockReward and cumulativeEmissionThrough): 50 LAX per block,
// halving every 210,000 blocks, nothing for genesis, and nothing after 63
// halvings. Amounts are wei as BigInt, so the figures match the node's.

import { TARGET_BLOCK_TIME } from "./protocol.ts";

export const HALVING_INTERVAL = 210_000;
export const WEI_PER_LAX = 10n ** 18n;
export const INITIAL_REWARD = 50n * WEI_PER_LAX;
/** calcBlockReward pays nothing past this many halvings. */
const MAX_HALVINGS = 63;

/** era is the number of halvings so far; the boundary block already belongs to the new era. */
export function era(height: number): number {
  return Math.floor(height / HALVING_INTERVAL);
}

/** blockReward is the subsidy of block `height`, in wei. */
export function blockReward(height: number): bigint {
  const halvings = era(height);

  if (height <= 0 || halvings > MAX_HALVINGS) return 0n;

  return INITIAL_REWARD / (1n << BigInt(halvings));
}

/** issuedThrough is the total subsidy of blocks 1..height, in wei. */
export function issuedThrough(height: number): bigint {
  let total = 0n;

  for (let e = 0; e <= Math.min(era(height), MAX_HALVINGS); e++) {
    const first = Math.max(1, e * HALVING_INTERVAL);
    const last = Math.min(height, (e + 1) * HALVING_INTERVAL - 1);

    if (last >= first) total += BigInt(last - first + 1) * blockReward(first);
  }

  return total;
}

/** SUPPLY_CAP is the 21 million LAX maximum supply, in wei. */
export const SUPPLY_CAP = 21_000_000n * WEI_PER_LAX;

/** toLax converts wei to a JavaScript number of LAX, for display. */
export function toLax(wei: bigint): number {
  return Number(wei / 10n ** 10n) / 1e8;
}

const BLOCKS_PER_DAY = 86_400 / TARGET_BLOCK_TIME;

export interface EmissionState {
  height: number;
  era: number;
  reward: bigint;
  nextReward: bigint;
  nextHalving: number;
  blocksToHalving: number;
  /** Share of the current era already mined, 0..1. */
  eraProgress: number;
  issued: bigint;
  /** Share of SUPPLY_CAP issued, 0..1. */
  issuedShare: number;
  /** New coins per day at the target block time and current reward, in wei. */
  dailyIssuance: bigint;
  /** Supply growth over the next 12 months: a year of issuance at the current reward over the coins issued so far, 0..; null before any issuance. */
  inflation: number | null;
}

export function emissionAt(height: number): EmissionState {
  const current = era(height);
  const nextHalving = (current + 1) * HALVING_INTERVAL;
  const reward = blockReward(Math.max(1, height));
  const issued = issuedThrough(height);
  const dailyIssuance = reward * BigInt(BLOCKS_PER_DAY);

  return {
    height,
    era: current,
    reward,
    nextReward: blockReward(nextHalving),
    nextHalving,
    blocksToHalving: nextHalving - height,
    eraProgress: (height - current * HALVING_INTERVAL) / HALVING_INTERVAL,
    issued,
    issuedShare: toLax(issued) / toLax(SUPPLY_CAP),
    dailyIssuance,
    inflation: issued > 0n ? (toLax(dailyIssuance) * 365) / toLax(issued) : null,
  };
}

/** supplyCurve gives the share of SUPPLY_CAP issued at each of the first `eras` halvings, from genesis. */
export function supplyCurve(eras: number): { height: number; share: number }[] {
  const max = toLax(SUPPLY_CAP);

  return Array.from({ length: eras + 1 }, (_, e) => {
    const height = e * HALVING_INTERVAL;

    return { height, share: toLax(issuedThrough(height)) / max };
  });
}
