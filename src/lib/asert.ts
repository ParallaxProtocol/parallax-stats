// Parallax mainnet difficulty adjustment: aserti3-2d, ported bit for bit
// from kernel/xhash/asert.go in the protocol source, so the next block's
// difficulty computed here matches the network's exactly. Difficulty
// follows the drift from a 10 minute schedule anchored at block 17,559,
// halving for every 2 days the chain falls behind it.

/** Mainnet chain id; the anchor below only applies there. */
export const MAINNET_NETWORK = "2110";

/** ASERT took over from the 2016-block retarget at this height. */
export const ASERT_ACTIVATION = 17_560;

/** Anchor block (activation − 1), its difficulty, and its parent's timestamp, read from mainnet. */
export const ANCHOR_HEIGHT = ASERT_ACTIVATION - 1;
export const ANCHOR_PARENT_TIME = 1_765_553_571;
export const ANCHOR_DIFFICULTY = 363_312_886_369_486n;

export const IDEAL_BLOCK_TIME = 600;
export const HALF_LIFE = 172_800;
const RADIX = 1n << 16n;
const POLY_A = 195_766_423_245_049n;
const POLY_B = 971_821_376n;
const POLY_C = 5_127n;
const MAX_TARGET = (1n << 256n) - 1n;

const u64 = (x: bigint) => BigInt.asUintN(64, x);

export function difficultyToTarget(difficulty: bigint): bigint {
  if (difficulty <= 0n) return 1n;

  const target = MAX_TARGET / difficulty;

  return target > 0n ? target : 1n;
}

export function targetToDifficulty(target: bigint): bigint {
  if (target <= 0n) return 1n;

  const difficulty = MAX_TARGET / target;

  return difficulty > 0n ? difficulty : 1n;
}

/** asertNextTarget mirrors ASERTNextTarget: the target of the block after the evaluation block. */
export function asertNextTarget(
  anchorHeight: number,
  anchorParentTime: number,
  anchorTarget: bigint,
  evalHeight: number,
  evalTime: number,
): bigint {
  const timeDelta = BigInt(evalTime - anchorParentTime);
  const numBlocks = BigInt(evalHeight - anchorHeight + 1);
  // BigInt division truncates toward zero, like Go's on int64
  let exponent = ((timeDelta - BigInt(IDEAL_BLOCK_TIME) * numBlocks) * RADIX) / BigInt(HALF_LIFE);
  // Arithmetic shift, flooring negative exponents like Go's >> on int64
  const numShifts = exponent >> 16n;

  exponent -= numShifts * RADIX;

  // The cubic approximation of 2^x runs in uint64, wrapping as Go does
  const ux = u64(exponent);
  const x2 = u64(ux * ux);
  const x3 = u64(x2 * ux);
  const poly = u64(u64(u64(u64(POLY_A * ux) + u64(POLY_B * x2)) + u64(POLY_C * x3)) + (1n << 47n));
  const factor = (poly >> 48n) + RADIX;

  let next = anchorTarget * factor;

  next = numShifts < 0n ? next >> -numShifts : next << numShifts;
  next >>= 16n;

  if (next <= 0n) return 1n;

  return next > MAX_TARGET ? MAX_TARGET : next;
}

/** nextDifficulty is the difficulty of the block after the given mainnet block. */
export function nextDifficulty(height: number, timestamp: number): bigint {
  return targetToDifficulty(
    asertNextTarget(ANCHOR_HEIGHT, ANCHOR_PARENT_TIME, difficultyToTarget(ANCHOR_DIFFICULTY), height, timestamp),
  );
}

/**
 * miningDifficulty is the difficulty of the block being mined after the
 * given block, or null when the block cannot be a mainnet ASERT block: one
 * block moves difficulty far less than 4x either way, so a bigger jump means
 * a testnet, simulated or made-up head and a meaningless figure.
 */
export function miningDifficulty(block: { number: number; timestamp: number; difficulty: string }): bigint | null {
  if (block.number < ASERT_ACTIVATION) return null;

  const next = nextDifficulty(block.number, block.timestamp);
  const ratio = Number(next) / Number(block.difficulty);

  return ratio > 0.25 && ratio < 4 ? next : null;
}
