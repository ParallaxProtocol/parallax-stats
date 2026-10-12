import assert from "node:assert/strict";
import test from "node:test";
import { Incidents, KEEP_MS, type Observation, type TimelineBlock } from "../src/server/incidents.ts";

const MIN = 60_000;
const T0 = 1_800_000_000_000;

const majority = (share: number): Observation => ({ level: "critical", peak: share, detail: `rplant.xyz mined ${Math.round(share * 100)}% of the week's blocks` });

test("a condition opens an incident once it has held for 10 minutes, dated from when it was first seen", () => {
  const incidents = new Incidents(T0);

  assert.equal(incidents.update({ majority: majority(0.8) }, T0), false);
  assert.equal(incidents.update({ majority: majority(0.8) }, T0 + 5 * MIN), false);
  assert.equal(incidents.log().list.length, 0);

  assert.equal(incidents.update({ majority: majority(0.8) }, T0 + 10 * MIN), true);
  assert.deepEqual(incidents.log().list, [
    { id: `majority:${T0}`, kind: "majority", level: "critical", start: T0, startKnown: true, end: null, detail: "rplant.xyz mined 80% of the week's blocks" },
  ]);
});

test("a condition gone within 10 minutes leaves no incident", () => {
  const incidents = new Incidents(T0);

  incidents.update({ spread: { level: "warn", peak: 20_000, detail: "slow" } }, T0);
  incidents.update({}, T0 + 5 * MIN);
  incidents.update({ spread: { level: "warn", peak: 20_000, detail: "slow" } }, T0 + 6 * MIN);
  incidents.update({}, T0 + 12 * MIN);

  assert.equal(incidents.log().list.length, 0);
});

test("an incident keeps its worst point, and closes when the condition was first seen gone", () => {
  const incidents = new Incidents(T0);

  incidents.update({ majority: majority(0.8) }, T0);
  incidents.update({ majority: majority(0.8) }, T0 + 10 * MIN);
  incidents.update({ majority: majority(0.87) }, T0 + 20 * MIN);
  incidents.update({ majority: majority(0.6) }, T0 + 30 * MIN);

  assert.equal(incidents.log().list[0].detail, "rplant.xyz mined 87% of the week's blocks");

  // Gone at 40 minutes, back briefly at 45: still the same incident
  incidents.update({}, T0 + 40 * MIN);
  incidents.update({ majority: majority(0.55) }, T0 + 45 * MIN);
  incidents.update({}, T0 + 50 * MIN);
  assert.equal(incidents.log().list[0].end, null);

  incidents.update({}, T0 + 60 * MIN);
  assert.equal(incidents.log().list[0].end, T0 + 50 * MIN);
  assert.equal(incidents.log().list.length, 1);
});

test("a stall opens at once, dated from the last block, and ends with the next", () => {
  const incidents = new Incidents(T0);
  const lastBlock = T0 - 125 * MIN;

  assert.equal(incidents.update({ stall: { level: "critical", peak: 125 * MIN, detail: "No block after #100", since: lastBlock } }, T0), true);
  assert.equal(incidents.log().list[0].start, lastBlock);

  assert.equal(incidents.update({}, T0 + MIN), true);
  assert.equal(incidents.log().list[0].end, T0 + MIN);
});

test("deep reorganizations are moments, followed as they are measured deeper", () => {
  const incidents = new Incidents(T0);

  assert.equal(incidents.reorgs([{ height: 90, at: T0, nodes: 3, depth: 2 }], T0), false);
  assert.equal(incidents.reorgs([{ height: 100, at: T0, nodes: 3, depth: 3 }], T0), true);
  assert.equal(incidents.log().list[0].level, "warn");

  assert.equal(incidents.reorgs([{ height: 100, at: T0, nodes: 4, depth: 6 }], T0 + MIN), true);
  assert.equal(incidents.log().list.length, 1);
  assert.deepEqual(incidents.log().list[0], {
    id: `reorg:${T0}`,
    kind: "reorg",
    level: "critical",
    start: T0,
    startKnown: true,
    end: T0,
    detail: "6 blocks replaced at #100, seen by 4 nodes",
  });

  assert.equal(incidents.reorgs([{ height: 100, at: T0, nodes: 4, depth: 6 }], T0 + 2 * MIN), false);
});

test("past stalls and majorities are rebuilt from saved blocks, a majority holding from the start with its start unknown", () => {
  const pool = "0x" + "a".repeat(40);
  const other = "0x" + "b".repeat(40);
  const blocks: TimelineBlock[] = [];
  let t = 1_700_000_000;

  // 9 days of a block every 10 minutes, the pool finding all but every third: a majority from the start.
  // Then 3 hours without a block, and 9 more days shared by three miners: the majority ends
  for (let n = 1; n <= 9 * 144; n++) blocks.push({ height: n, timestamp: (t += 600), miner: n % 3 === 0 ? other : pool });

  t += 3 * 3600;

  const third = "0x" + "c".repeat(40);

  for (let n = 9 * 144 + 1; n <= 18 * 144; n++) blocks.push({ height: n, timestamp: (t += 600), miner: [pool, other, third][n % 3] });

  const incidents = new Incidents(T0);

  incidents.rebuild(blocks, new Map([[pool, { name: "Big Pool", url: null }]]));

  const log = incidents.log();
  const stall = log.list.find((i) => i.kind === "stall")!;
  const held = log.list.find((i) => i.kind === "majority")!;

  assert.equal(log.rebuiltFrom, blocks[0].timestamp * 1000);
  assert.equal(stall.start, blocks[9 * 144 - 1].timestamp * 1000);
  assert.equal(stall.end, blocks[9 * 144].timestamp * 1000);
  assert.equal(stall.detail, `No block after #${(9 * 144).toLocaleString("en-US")}`);
  assert.equal(log.list.filter((i) => i.kind === "majority").length, 1);
  assert.equal(held.startKnown, false);
  assert.equal(held.detail, "Big Pool mined 67% of the week's blocks");
  assert.notEqual(held.end, null);
  assert.equal(incidents.needsRebuild, false);
});

test("a majority still holding when rebuilt carries on in the live record", () => {
  const pool = "0x" + "a".repeat(40);
  const blocks: TimelineBlock[] = Array.from({ length: 9 * 144 }, (_, i) => ({ height: i + 1, timestamp: 1_700_000_000 + i * 600, miner: pool }));
  const incidents = new Incidents(T0);

  incidents.rebuild(blocks, new Map());
  incidents.update({ majority: majority(1) }, T0);

  assert.equal(incidents.log().list.filter((i) => i.kind === "majority").length, 1);
  assert.equal(incidents.log().list[0].end, null);
});

test("incidents survive a save and restore, and those ended more than 90 days ago are forgotten", () => {
  const incidents = new Incidents(T0);

  incidents.update({ majority: majority(0.8) }, T0);
  incidents.update({ majority: majority(0.8) }, T0 + 10 * MIN);
  incidents.reorgs([{ height: 100, at: T0, nodes: 3, depth: 3 }], T0);

  const restored = new Incidents();

  restored.restore(JSON.parse(JSON.stringify(incidents.toState())));
  assert.deepEqual(restored.log(), incidents.log());

  // Still open after the restore: carried on, not opened again
  restored.update({ majority: majority(0.9) }, T0 + 20 * MIN);
  assert.equal(restored.log().list.filter((i) => i.kind === "majority").length, 1);

  restored.update({}, T0 + KEEP_MS);
  restored.update({}, T0 + KEEP_MS + 10 * MIN);
  restored.update({}, T0 + 2 * KEEP_MS + 11 * MIN);
  assert.equal(restored.log().list.length, 0);
});

test("saved incidents of a kind no longer recorded are dropped on restore", () => {
  const incidents = new Incidents();

  incidents.restore({
    since: T0,
    rebuiltFrom: null,
    rebuilt: true,
    list: [
      { id: `unverified:${T0}`, kind: "unverified" as never, level: "info" as never, start: T0, startKnown: true, end: T0 + MIN, detail: "No verified node online", peak: 0 },
      { id: `stall:${T0}`, kind: "stall", level: "critical", start: T0, startKnown: true, end: T0 + 130 * MIN, detail: "No block after #100", peak: 130 * MIN },
    ],
  });

  assert.deepEqual(
    incidents.log().list.map((i) => i.kind),
    ["stall"],
  );
});
