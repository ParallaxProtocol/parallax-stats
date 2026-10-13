import assert from "node:assert/strict";
import test from "node:test";
import type { Summary } from "../src/lib/derive.ts";
import { TREND_SLICE_S, TREND_SLICES, trendStarts } from "../src/lib/protocol.ts";
import { Readings } from "../src/server/readings.ts";

const HOUR = 3600 * 1000;
// A slice boundary, so readings an hour apart stay in known slices
const T0 = 1_800_000_000 - (1_800_000_000 % TREND_SLICE_S);

function summary(active: number, synced: number, peerLatency: number, uptime: number | null, pending: number | null = null): Summary {
  return { bestBlock: 0, bestStats: null, total: active, active, synced, peerLatency, uptime, pending };
}

test("trend slices end with the one in progress, aligned to UTC", () => {
  const now = T0 * 1000 + 90 * 60 * 1000;
  const starts = trendStarts(now);

  assert.equal(starts.length, TREND_SLICES);
  assert.equal(starts.at(-1), T0);
  assert.equal(starts[0], T0 - (TREND_SLICES - 1) * TREND_SLICE_S);
});

test("readings average within their slice, and slices without any are null", () => {
  const readings = new Readings();
  const now = T0 * 1000 + 2 * TREND_SLICE_S * 1000;

  readings.record(summary(4, 4, 100, 99), "1000000000", T0 * 1000);
  readings.record(summary(6, 5, 0, null), null, T0 * 1000 + HOUR);
  readings.record(summary(3, 3, 50, 90), "3000000000", now);

  const starts = trendStarts(now);
  const series = readings.series(starts);
  const [first, gap, last] = [-3, -2, -1].map((i) => starts.length + i);

  assert.equal(series.active[first], 5);
  assert.equal(series.synced[first], 4.5);
  // Readings without a latency, fee or uptime leave them out of the mean
  assert.equal(series.peerLatency[first], 100);
  assert.equal(series.gasPrice[first], 1e9);
  assert.equal(series.uptime[first], 99);
  assert.equal(series.active[gap], null);
  assert.equal(series.gasPrice[last], 3e9);
  assert.equal(series.active[0], null);
});

test("readings survive a save and restore, and old slices drop out", () => {
  const readings = new Readings();

  for (let i = 0; i < TREND_SLICES + 5; i++) readings.record(summary(i, i, 10, 100), null, (T0 + i * TREND_SLICE_S) * 1000);

  const restored = new Readings();

  restored.restore(JSON.parse(JSON.stringify(readings.toState())));

  assert.equal(restored.toState().slices.length, TREND_SLICES);
  assert.deepEqual(restored.toState(), readings.toState());
  // Malformed saved slices are dropped
  restored.restore({ slices: [{ start: "x" } as never] });
  assert.equal(restored.toState().slices.length, 0);
  restored.restore(undefined);
  assert.equal(restored.toState().slices.length, 0);
});

test("the mempool is read with the rest, and readings saved before it still restore", () => {
  const readings = new Readings();

  readings.record(summary(2, 2, 100, 99, 10), null, T0 * 1000);
  readings.record(summary(2, 2, 100, 99, 30), null, T0 * 1000 + HOUR);
  // No synced node: no mempool reading
  readings.record(summary(2, 0, 100, 99, null), null, T0 * 1000 + 2 * HOUR);

  assert.equal(readings.series([T0]).pending[0], 20);

  const old = { slices: [{ start: T0, active: [2, 1], synced: [2, 1], gasPrice: [0, 0], peerLatency: [100, 1], uptime: [99, 1] }] };
  const restored = new Readings();

  restored.restore(old as never);

  const series = restored.series([T0]);

  assert.equal(series.active[0], 2);
  assert.equal(series.pending[0], null);
});

test("the price is read with the rest, and readings saved before it still restore", () => {
  const readings = new Readings();

  readings.record(summary(2, 2, 100, 99), null, T0 * 1000, 0.01);
  readings.record(summary(2, 2, 100, 99), null, T0 * 1000 + HOUR, 0.03);
  // CoinGecko unreachable: no price reading
  readings.record(summary(2, 2, 100, 99), null, T0 * 1000 + 2 * HOUR, null);

  assert.ok(Math.abs(readings.series([T0]).price[0]! - 0.02) < 1e-12);

  const old = { slices: [{ start: T0, active: [2, 1], synced: [2, 1], gasPrice: [0, 0], peerLatency: [100, 1], uptime: [99, 1], pending: [5, 1] }] };
  const restored = new Readings();

  restored.restore(old as never);
  assert.equal(restored.series([T0]).pending[0], 5);
  assert.equal(restored.series([T0]).price[0], null);
});

test("the trading volume is read with the price, and readings saved before it still restore", () => {
  const readings = new Readings();

  readings.record(summary(2, 2, 100, 99), null, T0 * 1000, 0.01, 400);
  readings.record(summary(2, 2, 100, 99), null, T0 * 1000 + HOUR, 0.01, 800);
  readings.record(summary(2, 2, 100, 99), null, T0 * 1000 + 2 * HOUR, null, null);

  assert.equal(readings.series([T0]).volume[0], 600);

  const old = { slices: [{ start: T0, active: [2, 1], synced: [2, 1], gasPrice: [0, 0], peerLatency: [100, 1], uptime: [99, 1], pending: [5, 1], price: [0.02, 1] }] };
  const restored = new Readings();

  restored.restore(old as never);
  assert.equal(restored.series([T0]).price[0], 0.02);
  assert.equal(restored.series([T0]).volume[0], null);
});
