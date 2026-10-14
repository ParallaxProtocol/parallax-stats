import assert from "node:assert/strict";
import test from "node:test";
import type { Charts } from "../src/lib/protocol.ts";
import { binomialAtMost, HIDDEN_CHANCE, open, poissonAtMost, quietest, UNUSUAL_CHANCE, watch } from "../src/lib/withholding.ts";

const NOW = 1_800_000_000;

/** A miner with `share` of 1,000 blocks, at a block every 500 s, whose newest blocks are `ages` seconds old. */
function charts(share: number, ages: number[], pool = "rplant.xyz"): Charts {
  return {
    miners: [{ miner: "0xabc", pool: { name: pool, url: null }, blocks: Math.round(share * 1000) }],
    minerBlocks: 1000,
    avgBlocktime: 500,
    height: [100],
    topMinerBlocks: ages.map((age, i) => ({ height: 100 - i, timestamp: NOW - age })),
  } as unknown as Charts;
}

/**
 * A chain of 100 blocks after one of the miner's, a block every `spacing`
 * seconds, the newest just now, of which the miner found those `mine`
 * picks; its share of the week is 86%, at a block every 500 s.
 */
function chain(spacing: number, mine: (i: number) => boolean): Charts {
  const blocks = [{ height: 1000, timestamp: NOW - 100 * spacing }];

  for (let i = 1; i <= 100; i++) if (mine(i)) blocks.push({ height: 1000 + i, timestamp: NOW - (100 - i) * spacing });

  return {
    miners: [{ miner: "0xabc", pool: { name: "rplant.xyz", url: null }, blocks: 860 }],
    minerBlocks: 1000,
    avgBlocktime: 500,
    height: [1100],
    topMinerBlocks: blocks.reverse(),
  } as unknown as Charts;
}

test("poissonAtMost sums the chances of 0 to k events", () => {
  assert.equal(poissonAtMost(0, 0), 1);
  assert.ok(Math.abs(poissonAtMost(0, 2) - Math.exp(-2)) < 1e-12);
  assert.ok(Math.abs(poissonAtMost(1, 2) - 3 * Math.exp(-2)) < 1e-12);
});

test("a miner publishing as its share says raises nothing", () => {
  const seen = watch(charts(0.94, [120, 650, 1100]), NOW * 1000)!;

  assert.equal(seen.level, null);
  assert.equal(open(seen), true);
  assert.equal(seen.name, "rplant.xyz");
  assert.deepEqual(seen.last, { height: 100, timestamp: NOW - 120 });
});

test("binomialAtMost sums the chances of 0 to k successes, without underflowing", () => {
  assert.equal(binomialAtMost(3, 3, 0.5), 1);
  assert.ok(Math.abs(binomialAtMost(0, 3, 0.5) - 0.125) < 1e-12);
  assert.ok(Math.abs(binomialAtMost(1, 3, 0.5) - 0.5) < 1e-12);
  // 0.14^600 is far below the smallest double, but the sum near the mean is not
  assert.ok(binomialAtMost(510, 600, 0.86) > 0.1);
});

test("hashrate leaving every pool alike is not taken for hidden mining", () => {
  // Blocks every 900 s instead of 500, the miner still finding its 86% of them
  const seen = watch(chain(900, (i) => i % 8 !== 0), NOW * 1000)!;

  assert.equal(seen.level, null);
  assert.equal(open(seen), true);

  // By the clock alone, as before, it was critical
  const clock = quietest(chain(900, (i) => i % 8 !== 0).topMinerBlocks!, 500 / 0.86, NOW)!;

  assert.ok(clock.chance < HIDDEN_CHANCE);
});

test("a miner publishing a falling share of every miner's blocks is still caught", () => {
  // It hides most of its hashrate: 60 of the public blocks, coming slower
  const seen = watch(chain(1100, (i) => i % 5 > 1), NOW * 1000)!;

  assert.equal(seen.level, "critical");
  assert.ok(seen.stretch.found > 0 && seen.stretch.found < 0.7 * seen.stretch.published!);
});

test("a silence is judged by the clock, whatever the other miners publish", () => {
  // Its newest block 2 h ago, and the other miners' two since then say little
  const seen = watch({ ...charts(0.94, [125 * 60, 130 * 60]), height: [102] } as Charts, NOW * 1000)!;

  assert.equal(seen.level, "critical");
  assert.equal(seen.stretch.found, 0);
});

test("a majority miner silent for about 1.4 hours warns, and for two hours is critical", () => {
  // 94% of a block every 500 s: one of its own every 532 s
  const warn = watch(charts(0.94, [85 * 60, 90 * 60]), NOW * 1000)!;

  assert.equal(warn.level, "warn");
  assert.equal(warn.stretch.found, 0);
  assert.equal(warn.stretch.height, 100);
  assert.ok(warn.chance < UNUSUAL_CHANCE && warn.chance >= HIDDEN_CHANCE);

  assert.equal(watch(charts(0.94, [125 * 60, 130 * 60]), NOW * 1000)!.level, "critical");
});

test("a miner publishing at a fraction of its rate is caught over a longer stretch", () => {
  // 12 blocks over 6 hours, where its share leads to expect about 40, the newest just now
  const ages = Array.from({ length: 12 }, (_, i) => i * 1800);
  const seen = quietest(ages.map((age, i) => ({ height: 100 - i, timestamp: NOW - age })), 532, NOW)!;

  assert.ok(seen.stretch.found > 0);
  assert.ok(seen.chance < UNUSUAL_CHANCE);
});

test("a small miner, or too few blocks, is not watched", () => {
  assert.equal(watch(charts(0.2, [10 * 3600]), NOW * 1000), null);
  assert.equal(watch({ ...charts(0.94, [10 * 3600]), minerBlocks: 5 } as Charts, NOW * 1000), null);
  // A server from before the watch sends no blocks
  assert.equal(watch({ ...charts(0.94, []), topMinerBlocks: undefined } as Charts, NOW * 1000), null);
});

test("a block stamped a little ahead of the clock counts as now", () => {
  assert.equal(watch(charts(0.94, [-30]), NOW * 1000)!.level, null);
});

test("a quiet spell short of a warning is no longer mining in the open", () => {
  const seen = watch(charts(0.94, [60 * 60, 70 * 60]), NOW * 1000)!;

  assert.equal(seen.level, null);
  assert.equal(open(seen), false);
  assert.equal(open(null), false);
});
