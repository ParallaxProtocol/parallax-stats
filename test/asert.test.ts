// Checks the ASERT port against real mainnet blocks, read from a synced
// parallaxd over RPC.

import assert from "node:assert/strict";
import test from "node:test";
import {
  ANCHOR_HEIGHT,
  ANCHOR_PARENT_TIME,
  asertNextTarget,
  difficultyToTarget,
  HALF_LIFE,
  IDEAL_BLOCK_TIME,
  nextDifficulty,
  targetToDifficulty,
} from "../src/lib/asert.ts";

// Mainnet block timestamps and difficulties
const T17559 = 1_765_613_626;
const T17560 = 1_765_635_069;
const D17560 = 286_240_692_951_727n;
const D17561 = 263_292_565_918_155n;

test("the first ASERT blocks match mainnet exactly", () => {
  assert.equal(nextDifficulty(17_559, T17559), D17560);
  assert.equal(nextDifficulty(17_560, T17560), D17561);
});

test("a block exactly on schedule keeps the anchor difficulty", () => {
  const target = difficultyToTarget(363_312_886_369_486n);
  const onSchedule = ANCHOR_PARENT_TIME + IDEAL_BLOCK_TIME * (ANCHOR_HEIGHT + 1 - ANCHOR_HEIGHT);

  assert.equal(asertNextTarget(ANCHOR_HEIGHT, ANCHOR_PARENT_TIME, target, ANCHOR_HEIGHT, onSchedule), target);
});

test("a half life of drift halves or doubles the target", () => {
  const target = 1n << 200n;
  const base = ANCHOR_PARENT_TIME + IDEAL_BLOCK_TIME;

  assert.equal(asertNextTarget(ANCHOR_HEIGHT, ANCHOR_PARENT_TIME, target, ANCHOR_HEIGHT, base + HALF_LIFE), target * 2n);
  assert.equal(asertNextTarget(ANCHOR_HEIGHT, ANCHOR_PARENT_TIME, target, ANCHOR_HEIGHT, base - HALF_LIFE), target / 2n);
});

test("targets clamp to the valid range", () => {
  const max = (1n << 256n) - 1n;

  assert.equal(asertNextTarget(ANCHOR_HEIGHT, ANCHOR_PARENT_TIME, max, ANCHOR_HEIGHT, ANCHOR_PARENT_TIME + 100 * HALF_LIFE), max);
  assert.equal(asertNextTarget(ANCHOR_HEIGHT, ANCHOR_PARENT_TIME, 1n, ANCHOR_HEIGHT, ANCHOR_PARENT_TIME - 100 * HALF_LIFE), 1n);
  assert.equal(targetToDifficulty(0n), 1n);
});

test("pool units are raw difficulty over 2^32", async () => {
  const { formatPoolDifficulty } = await import("../src/lib/format.ts");

  // What pools showed for the block mined after mainnet #59,131
  assert.equal(formatPoolDifficulty(3_328_400_000_000n), "774.95");
  assert.equal(formatPoolDifficulty(2 ** 32), "1.00");
});

test("mining difficulty is withheld for heads that cannot be mainnet ASERT blocks", async () => {
  const { miningDifficulty, nextDifficulty: next } = await import("../src/lib/asert.ts");

  assert.equal(miningDifficulty({ number: 17_559, timestamp: T17559, difficulty: "363312886369486" }), null);
  assert.equal(miningDifficulty({ number: 17_560, timestamp: T17560, difficulty: D17560.toString() }), next(17_560, T17560));
  // A simulated head 410 days ahead of schedule
  assert.equal(miningDifficulty({ number: 120_000, timestamp: T17560, difficulty: "3000000000000" }), null);
});
