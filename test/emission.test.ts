// Checks the emission math against the protocol's rules in
// kernel/xhash/consensus.go and api.go.

import assert from "node:assert/strict";
import test from "node:test";
import {
  blockReward,
  emissionAt,
  HALVING_INTERVAL,
  INITIAL_REWARD,
  issuedThrough,
  SUPPLY_CAP,
  supplyCurve,
  WEI_PER_LAX,
} from "../src/lib/emission.ts";

const LAX = WEI_PER_LAX;

test("genesis pays nothing and the boundary block starts the halved era", () => {
  assert.equal(blockReward(0), 0n);
  assert.equal(blockReward(1), 50n * LAX);
  assert.equal(blockReward(HALVING_INTERVAL - 1), 50n * LAX);
  assert.equal(blockReward(HALVING_INTERVAL), 25n * LAX);
  assert.equal(blockReward(2 * HALVING_INTERVAL), 125n * LAX / 10n);
});

test("rewards stop after 63 halvings, using integer division in wei", () => {
  assert.equal(blockReward(63 * HALVING_INTERVAL), INITIAL_REWARD / (1n << 63n));
  assert.equal(blockReward(64 * HALVING_INTERVAL), 0n);
  // 50 LAX divides evenly by 2^19 in wei, but not by 2^20
  assert.equal(blockReward(20 * HALVING_INTERVAL), INITIAL_REWARD / (1n << 20n));
});

test("issued supply sums the rewards of blocks 1..height", () => {
  assert.equal(issuedThrough(0), 0n);
  assert.equal(issuedThrough(1), 50n * LAX);
  assert.equal(issuedThrough(HALVING_INTERVAL - 1), BigInt(HALVING_INTERVAL - 1) * 50n * LAX);
  assert.equal(issuedThrough(HALVING_INTERVAL), BigInt(HALVING_INTERVAL - 1) * 50n * LAX + 25n * LAX);

  // A brute-force sum agrees across a halving
  let sum = 0n;

  for (let h = 1; h <= HALVING_INTERVAL + 1000; h++) sum += blockReward(h);
  assert.equal(issuedThrough(HALVING_INTERVAL + 1000), sum);
});

test("issuance never exceeds the 21 million cap", () => {
  assert.equal(SUPPLY_CAP, 21_000_000n * LAX);
  assert.ok(issuedThrough(64 * HALVING_INTERVAL) <= SUPPLY_CAP);
  assert.equal(blockReward(64 * HALVING_INTERVAL), 0n);
});

test("emission state at a height", () => {
  const state = emissionAt(120_000);

  assert.equal(state.era, 0);
  assert.equal(state.reward, 50n * LAX);
  assert.equal(state.nextReward, 25n * LAX);
  assert.equal(state.nextHalving, HALVING_INTERVAL);
  assert.equal(state.blocksToHalving, 90_000);
  assert.equal(state.dailyIssuance, 144n * 50n * LAX);
  assert.ok(Math.abs(state.eraProgress - 120_000 / HALVING_INTERVAL) < 1e-12);
  // Blocks 1..120,000 are 120,000 rewarded blocks; genesis is block 0
  assert.equal(state.issued, 120_000n * 50n * LAX);
  // Blocks 120,001..209,999 are left before the halving at 210,000
  assert.equal(state.leftThisEra, 89_999n * 50n * LAX);

  assert.equal(emissionAt(0).leftThisEra, 209_999n * 50n * LAX);
  assert.equal(emissionAt(HALVING_INTERVAL).era, 1);
  assert.equal(emissionAt(HALVING_INTERVAL).blocksToHalving, HALVING_INTERVAL);
});

test("the supply curve starts at zero and approaches the maximum", () => {
  const curve = supplyCurve(8);

  assert.equal(curve.length, 9);
  assert.equal(curve[0].share, 0);
  assert.ok(Math.abs(curve[1].share - 0.5) < 1e-5);
  assert.ok(curve[8].share > 0.99 && curve[8].share < 1);
});
