import assert from "node:assert/strict";
import test from "node:test";
import { attackerSuccess, confirmationsFor } from "../src/lib/confirmations.ts";

test("the attacker's chance matches the Bitcoin paper's table", () => {
  // Section 11: q = 0.1
  assert.ok(Math.abs(attackerSuccess(0.1, 5) - 0.0009137) < 1e-7);
  assert.ok(Math.abs(attackerSuccess(0.1, 10) - 0.0000012) < 1e-7);
  // q = 0.3
  assert.ok(Math.abs(attackerSuccess(0.3, 5) - 0.1773523) < 1e-7);
});

test("confirmations for 99.9% match the paper's table", () => {
  const table: [number, number][] = [
    [0.1, 5],
    [0.15, 8],
    [0.2, 11],
    [0.25, 15],
    [0.3, 24],
    [0.35, 41],
    [0.4, 89],
    [0.45, 340],
  ];

  for (const [q, z] of table) assert.equal(confirmationsFor(q, 0.999), z, `q = ${q}`);
});

test("no number of confirmations is safe against a majority, or a miner just short of one", () => {
  assert.equal(confirmationsFor(0.5, 0.999), null);
  assert.equal(confirmationsFor(0.6, 0.999), null);
  assert.equal(confirmationsFor(0.499, 0.999), null);
  assert.equal(confirmationsFor(0, 0.999), 0);
});
