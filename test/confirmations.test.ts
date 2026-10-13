import assert from "node:assert/strict";
import test from "node:test";
import { attackerSuccess, confirmationsFor, hiddenShare, reversalCost } from "../src/lib/confirmations.ts";

test("the attacker's chance is the exact one, as Rosenfeld works it out", () => {
  // Rosenfeld (2014), table 1: q = 0.1, 6 confirmations
  assert.ok(Math.abs(attackerSuccess(0.1, 6) - 0.0005914) < 1e-7);
  // Above the Bitcoin paper's approximation, which gives 0.0009137 for 5 confirmations
  assert.ok(attackerSuccess(0.1, 5) > 0.0009137);
  // With no confirmation the payment can be replaced outright
  assert.equal(attackerSuccess(0.1, 0), 1);
});

test("confirmations for 99.9% match Rosenfeld's table", () => {
  const table: [number, number][] = [
    [0.1, 6],
    [0.15, 9],
    [0.2, 13],
    [0.25, 20],
    [0.3, 32],
    [0.35, 58],
    [0.4, 133],
    [0.45, 539],
  ];

  for (const [q, z] of table) assert.equal(confirmationsFor(q, 0.999), z, `q = ${q}`);
});

test("no number of confirmations is safe against a majority, or a miner just short of one", () => {
  assert.equal(confirmationsFor(0.5, 0.999), null);
  assert.equal(confirmationsFor(0.6, 0.999), null);
  assert.equal(confirmationsFor(0.499, 0.999), null);
  assert.equal(confirmationsFor(0, 0.999), 0);
});

test("reversing a payment costs the miner its own share of the blocks replaced", () => {
  assert.equal(reversalCost(0.9, 6, 50), 270);
  assert.equal(reversalCost(0.9, 0, 50), 0);
});

test("a miner hiding none of its share starts as far behind as the payment is deep", () => {
  assert.ok(Math.abs(attackerSuccess(0.3, 8, 0) - (0.3 / 0.7) ** 8) < 1e-15);
  // Hiding all of it is Rosenfeld's case
  assert.equal(attackerSuccess(0.3, 10, 0.3), attackerSuccess(0.3, 10));
  // Hiding some lies between
  assert.ok(attackerSuccess(0.3, 10, 0) < attackerSuccess(0.3, 10, 0.15) && attackerSuccess(0.3, 10, 0.15) < attackerSuccess(0.3, 10));
});

test("what a miner could hide from the watch shrinks as the wait grows", () => {
  assert.equal(hiddenShare(0.4, 0), 0.4);
  assert.ok(hiddenShare(0.4, 10) > hiddenShare(0.4, 100));
  assert.ok(hiddenShare(0.4, 100) > 0 && hiddenShare(0.4, 100) < 0.4);
});

test("a miner seen mining in the open needs far fewer confirmations, though more than one hiding nothing", () => {
  const table: [number, number][] = [
    [0.1, 6],
    [0.3, 19],
    [0.4, 32],
    [0.45, 51],
    [0.49, 205],
  ];

  for (const [q, z] of table) {
    assert.equal(confirmationsFor(q, 0.999, true), z, `q = ${q}`);
    assert.ok(z > Math.ceil(Math.log(0.001) / Math.log(q / (1 - q))) - 1, `q = ${q}`);
  }

  assert.equal(confirmationsFor(0.5, 0.999, true), null);
});
