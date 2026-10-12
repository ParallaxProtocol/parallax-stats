import assert from "node:assert/strict";
import test from "node:test";
import { formatPressure, gradePressure, hashpriceUnit, mempoolPressure, shortVersion } from "../src/lib/format.ts";

const releases = { "v2.1.2": "1dea7a088142f54c80c41fd3ba3d617ca408bf18" };

test("a stable build of a release's own commit reads as the release", () => {
  assert.equal(shortVersion("v2.1.2-stable-1dea7a08", releases), "v2.1.2");
  assert.equal(shortVersion("v2.1.2-stable-1DEA7A08", releases), "v2.1.2");
});

test("any other build keeps its full version", () => {
  assert.equal(shortVersion("v2.1.2-stable-deadbeef", releases), "v2.1.2-stable-deadbeef");
  assert.equal(shortVersion("v2.1.3-stable-1dea7a08", releases), "v2.1.3-stable-1dea7a08");
  assert.equal(shortVersion("v2.1.2-unstable-1dea7a08", releases), "v2.1.2-unstable-1dea7a08");
  assert.equal(shortVersion("v2.1.2-stable", releases), "v2.1.2-stable");
  assert.equal(shortVersion("v2.1.2-stable-1dea7a08", {}), "v2.1.2-stable-1dea7a08");
});

test("hashprice is shown per the hashrate unit that makes it 0.1 or more", () => {
  // Parallax today: about 1 LAX per MH/s per day
  assert.deepEqual(hashpriceUnit(1e-6), { scale: 1e6, unit: "MH/s" });
  assert.deepEqual(hashpriceUnit(0.5), { scale: 1, unit: "H/s" });
  assert.deepEqual(hashpriceUnit(2e-4), { scale: 1e3, unit: "KH/s" });
  assert.deepEqual(hashpriceUnit(0), { scale: 1, unit: "H/s" });
});

test("mempool pressure is the room waiting transactions need, as a share of a block", () => {
  // 9 transfers against a 30M gas limit
  assert.ok(Math.abs(mempoolPressure(9, 21_000, 30_000_000) - 0.0063) < 1e-12);
  // Recent blocks carried none: each taken as a plain transfer
  assert.equal(mempoolPressure(10, 0, 210_000), 1);
  assert.equal(mempoolPressure(5, 21_000, 0), 0);

  assert.equal(formatPressure(0.0063), "0.6%");
  assert.equal(formatPressure(0.0004), "<0.1%");
  assert.equal(formatPressure(2.3), "230%");
  assert.equal(formatPressure(0), "0%");

  assert.equal(gradePressure(0.2), "good");
  assert.equal(gradePressure(1.5), "warn");
  assert.equal(gradePressure(2.5), "critical");
});
