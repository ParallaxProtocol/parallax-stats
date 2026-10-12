import assert from "node:assert/strict";
import test from "node:test";
import { LoginRefused, Registry } from "../src/server/registry.ts";
import { cleanBlock, type ReportedBlock } from "../src/server/sanitize.ts";
import { loadSettings } from "../src/server/settings.ts";

const settings = loadSettings({ PUBLIC_SECRET: "open", MAX_NODES: "5", MAX_NODES_PER_IP: "2", NAME_HOLD_MINUTES: "60" });

let connections = 0;

/** login returns the refusal reason, or null when admitted. */
function login(nodes: Registry, id: string, ip: string, trusted = false, client = ""): string | null {
  try {
    nodes.add({ id, ip, trusted, connection: ++connections, latency: 0, geo: null, info: { name: id, node: client } as never });
    return null;
  } catch (err) {
    if (err instanceof LoginRefused) return err.message;
    throw err;
  }
}

function disconnect(nodes: Registry, id: string): void {
  const node = nodes.get(id)!;

  nodes.inactive(id, node.connection);
}

function block(number: number, hash?: string): ReportedBlock {
  const reported = cleanBlock({
    number,
    hash: "0x" + (hash ?? number.toString(16)).padStart(64, "0"),
    difficulty: "1000",
    totalDifficulty: String(number * 1000),
    timestamp: number * 600,
  });

  // Hash suffixes must be hex, or the block is rejected
  if (!reported) throw new Error(`invalid test block ${number} ${hash}`);

  return reported;
}

test("a connected name cannot be taken from another address", () => {
  const nodes = new Registry(settings);

  assert.equal(login(nodes, "alpha", "1.1.1.1"), null);
  assert.match(login(nodes, "alpha", "2.2.2.2")!, /in use/);
  // Reconnecting from the same address is fine
  assert.equal(login(nodes, "alpha", "1.1.1.1"), null);
});

test("a disconnected name is held for its address", () => {
  const nodes = new Registry(settings);

  login(nodes, "alpha", "1.1.1.1");
  disconnect(nodes, "alpha");

  assert.match(login(nodes, "alpha", "2.2.2.2")!, /recently used/);

  nodes.get("alpha")!.uptime.lastUpdate -= 61 * 60 * 1000;

  assert.equal(login(nodes, "alpha", "2.2.2.2"), null);
});

test("a stale connection closing does not mark a reconnected node offline", () => {
  const nodes = new Registry(settings);

  login(nodes, "alpha", "1.1.1.1");
  const first = nodes.get("alpha")!.connection;

  login(nodes, "alpha", "1.1.1.1");
  assert.equal(nodes.inactive("alpha", first), null);
  assert.equal(nodes.get("alpha")!.stats.active, true);
});

test("untrusted logins cannot take a trusted name", () => {
  const nodes = new Registry(settings);

  login(nodes, "seed", "1.1.1.1", true);
  disconnect(nodes, "seed");

  assert.match(login(nodes, "seed", "1.1.1.1")!, /trusted/);
  assert.equal(login(nodes, "seed", "3.3.3.3", true), null);
});

test("one address holds a bounded number of names", () => {
  const nodes = new Registry(settings);

  assert.equal(login(nodes, "a", "1.1.1.1"), null);
  assert.equal(login(nodes, "b", "1.1.1.1"), null);
  assert.match(login(nodes, "c", "1.1.1.1")!, /Too many/);

  // A disconnected name from the same address makes room
  disconnect(nodes, "a");

  assert.equal(login(nodes, "c", "1.1.1.1"), null);
  assert.equal(nodes.get("a"), undefined);

  // Trusted nodes are not counted or capped
  assert.equal(login(nodes, "t", "1.1.1.1", true), null);
});

test("the total number of nodes is capped", () => {
  const nodes = new Registry(settings);

  for (let i = 0; i < 5; i++) assert.equal(login(nodes, "n" + i, "10.0.0." + i), null);

  assert.match(login(nodes, "n5", "10.0.0.5")!, /limit/);
});

test("trusted nodes are admitted to a full list", () => {
  const nodes = new Registry(settings);

  for (let i = 0; i < 5; i++) login(nodes, "n" + i, "10.0.0." + i);

  // The longest disconnected untrusted node makes room
  disconnect(nodes, "n1");
  disconnect(nodes, "n3");
  nodes.get("n3")!.uptime.lastUpdate -= 1000;

  assert.equal(login(nodes, "seed", "1.1.1.1", true), null);
  assert.equal(nodes.get("n3"), undefined);
  assert.ok(nodes.get("n1"));
  assert.equal(nodes.all().length, 5);

  // With every untrusted node connected, the list goes over the cap
  login(nodes, "n1", "10.0.0.1");
  assert.equal(login(nodes, "seed2", "1.1.1.2", true), null);
  assert.equal(nodes.all().length, 6);

  // Untrusted logins are still refused
  assert.match(login(nodes, "n9", "10.0.0.9")!, /limit/);
});

test("addresses on the trusted list log in verified", () => {
  const nodes = new Registry(loadSettings({ PUBLIC_SECRET: "open", TRUSTED_IPS: "9.9.9.9" }));

  login(nodes, "ops", "9.9.9.9");
  assert.equal(nodes.get("ops")!.trusted, true);
});

test("untrusted nodes cannot introduce heights while a trusted node is online", () => {
  const nodes = new Registry(settings);

  login(nodes, "seed", "1.1.1.1", true);
  login(nodes, "liar", "2.2.2.2");

  nodes.addBlock("seed", block(100));
  nodes.addBlock("liar", block(999999));

  assert.equal(nodes.history.bestBlockNumber(), 100);
  // The liar still shows its own claimed head
  assert.equal(nodes.get("liar")!.stats.block.number, 999999);

  // Reporting a height the trusted node has seen is recorded
  nodes.addBlock("liar", block(100));
  assert.ok(nodes.history.search(100)!.propagTimes.some((p) => p.node === "liar"));
});

test("without a trusted node, everyone can introduce heights", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "2.2.2.2");
  nodes.addBlock("a", block(7));

  assert.equal(nodes.history.bestBlockNumber(), 7);
});

test("history is only accepted from the node it was requested from", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1");
  login(nodes, "b", "2.2.2.2");

  nodes.askedForHistory("a");

  assert.equal(nodes.addHistory("b", [block(5)]), false);
  assert.equal(nodes.history.bestBlockNumber(), 0);

  assert.equal(nodes.addHistory("a", [block(5)]), true);
  assert.equal(nodes.history.bestBlockNumber(), 5);
});

test("one block, the head a node reports on login, is enough to ask for history", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);
  nodes.addBlock("a", block(60));

  assert.deepEqual(nodes.nextHistoryRequest("a")?.list, Array.from({ length: 50 }, (_, i) => 10 + i));
});

test("history requests list missing heights and never genesis", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);
  nodes.addBlock("a", block(3));
  nodes.addBlock("a", block(10));

  const request = nodes.nextHistoryRequest("a");

  assert.deepEqual(request?.list, [1, 2, 4, 5, 6, 7, 8, 9]);
  // Only one request is outstanding at a time
  assert.equal(nodes.nextHistoryRequest("a"), null);

  nodes.addHistory("a", [9, 8, 7, 6, 5, 4, 2, 1].map((n) => block(n)));
  assert.equal(nodes.nextHistoryRequest("a"), null);
});

test("the propagation strip and charts cover the newest blocks", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);
  nodes.askedForHistory("a");
  nodes.addBlock("a", block(100));
  nodes.addHistory(
    "a",
    Array.from({ length: 50 }, (_, i) => block(99 - i)),
  );
  nodes.addBlock("a", block(101));

  const charts = nodes.charts();

  assert.equal(charts.height.length, 40);
  assert.equal(charts.height.at(-1), 101);
  assert.equal(charts.blocktime[0], 600);
  // The node reported the newest height itself, without delay
  assert.equal(nodes.get("a")!.history.at(-1), 0);
});

test("the miners list ranks by blocks found", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);

  for (let n = 1; n <= 6; n++) {
    const miner = n <= 4 ? "0x" + "a".repeat(40) : "0x" + "b".repeat(40);

    nodes.addBlock("a", { ...block(n), miner });
  }

  assert.deepEqual(
    nodes.charts().miners.map((m) => m.blocks),
    [4, 2],
  );
  assert.equal(nodes.charts().minerCount, 2);
});

test("a known pool's addresses count as one miner", () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => "0x" + x.repeat(40));
  const nodes = new Registry(
    loadSettings({ WS_SECRET: "private-secret", MINING_POOLS: `Big Pool=https://pool.example,${a},${b.toUpperCase().replace("0X", "0x")}` }),
  );

  login(nodes, "a", "1.1.1.1", true);

  // 3 blocks from the pool's first address, 2 from its second, 4 from a solo miner
  const miners = [a, a, a, b, b, c, c, c, c];

  miners.forEach((miner, i) => nodes.addBlock("a", { ...block(i + 1), miner }));

  const charts = nodes.charts();

  assert.deepEqual(
    charts.miners.map((m) => [m.pool?.name ?? m.miner, m.blocks]),
    [
      ["Big Pool", 5],
      [c, 4],
    ],
  );
  assert.equal(charts.miners[0].miner, a);
  assert.equal(charts.miners[0].pool?.url, "https://pool.example/");
  assert.equal(charts.minerCount, 2);
});

test("miners are counted over the last 7 days of blocks", () => {
  const nodes = new Registry(settings);
  const [early, late] = ["a", "b"].map((x) => "0x" + x.repeat(40));

  login(nodes, "a", "1.1.1.1", true);

  // One block an hour for 10 days: the first 3 days by one miner, the rest by another
  for (let n = 1; n <= 240; n++) nodes.addBlock("a", { ...block(n), timestamp: n * 3600, miner: n <= 72 ? early : late });

  const charts = nodes.charts();

  // Blocks 73 to 240 are within 7 days of the newest
  assert.equal(charts.minerBlocks, 168);
  assert.equal(charts.minerSpan, 167 * 3600);
  // The average block time covers the same week
  assert.equal(charts.avgBlocktime, 3600);
  assert.deepEqual(
    charts.miners.map((m) => [m.miner, m.blocks]),
    [[late, 168]],
  );
  assert.equal(charts.minerCount, 1);
});

test("the trends work out each 4 hour slice from its blocks, and the readings", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);

  // A block every 10 minutes for 10 days, at twice the difficulty for the last 2 days
  const blocks = 10 * 144;

  for (let n = 1; n <= blocks; n++) nodes.addBlock("a", { ...block(n), difficulty: n > blocks - 2 * 144 ? "2000" : "1000" });

  const now = (blocks * 600 + 60) * 1000;

  nodes.recordReading("2000000000", now);

  const { trends } = nodes.charts(now);

  assert.equal(trends.start.length, 42);
  assert.ok(trends.blocktime.every((t) => t === 600));
  assert.equal(trends.hashrate[0], 1000 / 600);
  assert.equal(trends.hashrate.at(-1), 2000 / 600);
  assert.equal(trends.difficulty.at(-1), 2000);
  // One reading, in the slice in progress
  assert.equal(trends.active.at(-1), 1);
  assert.equal(trends.gasPrice.at(-1), 2e9);
  assert.equal(trends.active[0], null);
});

test("trend readings are saved with the registry", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);
  nodes.recordReading("5", 1_000_000_000);

  const restored = new Registry(settings);

  restored.restore(JSON.parse(JSON.stringify(nodes.toState())), 0, 1_000_000_000);
  assert.equal(restored.charts(1_000_000_000).trends.gasPrice.at(-1), 5);
  // State saved before readings were kept restores without them
  restored.restore({ ...nodes.toState(), readings: undefined }, 0, 1_000_000_000);
  assert.equal(restored.charts(1_000_000_000).trends.gasPrice.at(-1), null);
});

test("unverified nodes are shown under a stable pseudonym", () => {
  const nodes = new Registry(settings);

  login(nodes, "chosen-name", "1.1.1.1");
  login(nodes, "seed", "2.2.2.2", true);

  const view = JSON.stringify(nodes.all());
  const pseudonym = nodes.get("chosen-name")!.viewId;

  assert.ok(!view.includes("chosen-name"));
  assert.match(pseudonym, /^node-[0-9a-f]{8}$/);
  assert.equal(nodes.get("chosen-name")!.toPublic().info.name, pseudonym);
  assert.ok(view.includes('"seed"'));

  // Same name, same pseudonym across reconnects
  disconnect(nodes, "chosen-name");
  login(nodes, "chosen-name", "1.1.1.1");
  assert.equal(nodes.get("chosen-name")!.viewId, pseudonym);
});

test("viewers never see node addresses", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "8.8.8.8");

  assert.ok(!JSON.stringify(nodes.all()).includes("8.8.8.8"));
});

/** settle makes logged-in nodes count toward propagation, as if connected for a while. */
function settle(nodes: Registry, ...ids: string[]): void {
  for (const id of ids) nodes.get(id)!.connectedAt = Date.now() - 10 * 60_000;
}

/** report has node `id` report `reported`, recorded as arriving `delay` ms after `base`. */
function report(nodes: Registry, id: string, reported: ReportedBlock, base: number, delay: number): void {
  nodes.addBlock(id, reported);

  const own = nodes.history.search(reported.number)!.propagTimes.find((p) => p.node === id)!;

  own.received = base + delay;
}

test("propagation stats skip first reports and split delays into speed bands", () => {
  const nodes = new Registry(settings);
  const delays = [0, 400, 1200, 2500, 4000, 6000, 12_000, 30_000, 90_000];
  const ids = delays.map((_, i) => "n" + i);

  ids.forEach((id, i) => login(nodes, id, "10.1.0." + i, true));
  settle(nodes, ...ids);

  // Every node reports the same block after its delay
  delays.forEach((delay, i) => report(nodes, ids[i], block(10), 1_000_000, delay));

  const { propagation } = nodes.charts();

  assert.equal(propagation.samples, 8);
  // Under 5 s, 5–15 s, 15–60 s, 60 s or more
  assert.deepEqual(propagation.bands, [4, 2, 1, 1]);
  assert.equal(propagation.p50, 4000);
  assert.equal(propagation.p90, 90_000);
  assert.equal(propagation.avg, Math.round((400 + 1200 + 2500 + 4000 + 6000 + 12_000 + 30_000 + 90_000) / 8));
});

test("propagation ignores catching-up nodes and takes off each node's latency", () => {
  const nodes = new Registry(settings);

  for (const [id, ip] of [["first", "10.2.0.1"], ["far", "10.2.0.2"], ["fresh", "10.2.0.3"], ["syncing", "10.2.0.4"]]) login(nodes, id, ip, true);
  settle(nodes, "first", "far", "syncing");
  nodes.get("far")!.stats.latency = 300;
  nodes.get("syncing")!.stats.syncing = true;

  report(nodes, "first", block(10), 1_000_000, 0);
  // 400 ms late, 300 of them its own link to the dashboard
  report(nodes, "far", block(10), 1_000_000, 400);
  // Just connected, and syncing: catch-up, minutes late, left out
  report(nodes, "fresh", block(10), 1_000_000, 300_000);
  report(nodes, "syncing", block(10), 1_000_000, 600_000);

  const { propagation } = nodes.charts();

  assert.equal(propagation.samples, 1);
  assert.equal(propagation.p50, 100);
});

test("block spread is how long blocks take to reach most verified nodes", () => {
  const nodes = new Registry(settings);
  const ids = ["v1", "v2", "v3", "v4"];
  const [fast, slow] = ["a", "b"].map((x) => "0x" + x.repeat(40));

  ids.forEach((id, i) => login(nodes, id, "10.3.0." + i, true));
  settle(nodes, ...ids);

  // Every third block is mined by a badly connected miner and takes 30 s to reach the last node
  for (let n = 1; n <= 30; n++) {
    const reported = { ...block(n), miner: n % 3 === 0 ? slow : fast };
    const last = n % 3 === 0 ? 30_000 : 1_000;

    [0, 200, 400, last].forEach((delay, i) => report(nodes, ids[i], reported, n * 1_000_000, delay));
  }

  const { spread } = nodes.charts().propagation;

  assert.ok(spread);
  assert.equal(spread.blocks, 10);
  // The newest 10 blocks: blocks 21 to 30, three of them slow
  assert.equal(spread.median, 1_000);
  assert.deepEqual(spread.slowMiner, { miner: slow, pool: null, median: 30_000, blocks: 10 });
});

test("fees are optional, sanitized, and carried into the charts", () => {
  assert.equal(cleanBlock({ ...block(1), fees: "441000000000000" })?.fees, "441000000000000");
  assert.equal(cleanBlock({ ...block(1), fees: 1e18 })?.fees, "1000000000000000000");
  assert.equal(cleanBlock({ ...block(1), fees: "lots" })?.fees, null);
  assert.equal(block(1).fees, null);

  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);
  nodes.addBlock("a", { ...block(1), fees: "5" });
  nodes.addBlock("a", block(2));

  assert.deepEqual(nodes.charts().fees, ["5", null]);
  assert.equal(nodes.get("a")!.stats.block.fees, null);
});

test("a later report fills in fees, and only trusted nodes may while one is online", () => {
  const nodes = new Registry(settings);

  login(nodes, "old", "1.1.1.1", true);
  login(nodes, "new", "2.2.2.2", true);
  login(nodes, "liar", "3.3.3.3");

  // An older reporter sends the block first, without fees
  nodes.addBlock("old", block(7));
  nodes.addBlock("liar", { ...block(7), fees: "999999" });
  assert.equal(nodes.history.search(7)!.block.fees, null);

  nodes.addBlock("new", { ...block(7), fees: "42" });
  assert.equal(nodes.history.search(7)!.block.fees, "42");

  // Once a trusted figure is in, it stays
  nodes.addBlock("liar", { ...block(7), fees: "1" });
  assert.equal(nodes.history.search(7)!.block.fees, "42");
});

test("without a trusted node online, the first fees reported fill the gap", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1");
  login(nodes, "b", "2.2.2.2");

  nodes.addBlock("a", block(3));
  nodes.addBlock("b", { ...block(3), fees: "10" });

  assert.equal(nodes.history.search(3)!.block.fees, "10");
});

/** chained returns block `number` with parent `parent` (hash suffixes), so tests can build forks. */
function chained(number: number, hash: string, parent: string): ReportedBlock {
  return { ...block(number, hash), parentHash: "0x" + parent.padStart(64, "0") };
}

test("a competing block a trusted node saw counts as stale; made-up forks do not", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);
  login(nodes, "b", "2.2.2.2", true);
  login(nodes, "liar", "3.3.3.3");

  nodes.addBlock("a", chained(10, "a10", "9"));
  nodes.addBlock("b", chained(10, "b10", "9"));
  // An untrusted node adds a fork nobody trusted saw
  nodes.addBlock("liar", chained(10, "fa4e", "9"));

  const health = nodes.charts().health;

  assert.equal(health.staleBlocks, 1);
  assert.deepEqual(
    health.recentStale.map((s) => s.height),
    [10],
  );
  // The block strip gets every stale height, and the heights the window spans
  assert.deepEqual(
    health.stale?.map((s) => s.height),
    [10],
  );
  assert.deepEqual(health.heights, { from: 10, to: 10 });
});

test("a node switching blocks at a height, or building on a new parent, is a reorg", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);
  login(nodes, "b", "2.2.2.2", true);

  nodes.addBlock("a", chained(20, "c20", "19"));
  nodes.addBlock("b", chained(20, "c20", "19"));
  assert.equal(nodes.charts().health.reorgs, 0);

  // Both nodes switch to another block 20: one reorganization
  nodes.addBlock("a", chained(20, "d20", "19"));
  nodes.addBlock("b", chained(20, "d20", "19"));

  let health = nodes.charts().health;

  assert.equal(health.reorgs, 1);
  assert.equal(health.lastReorg?.height, 20);
  assert.equal(health.lastReorg?.nodes, 2);

  // A block 21 whose parent is not the 20 the node reported
  nodes.addBlock("a", chained(21, "e21", "f20"));
  health = nodes.charts().health;
  assert.ok(health.reorgs >= 1);
});

test("an untrusted node cannot fake reorgs while a trusted node is online", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);
  login(nodes, "liar", "3.3.3.3");

  nodes.addBlock("a", chained(30, "c30", "29"));
  nodes.addBlock("liar", chained(30, "c30", "29"));
  nodes.addBlock("liar", chained(30, "d30", "29"));

  assert.equal(nodes.charts().health.reorgs, 0);
  assert.equal(nodes.charts().health.lastReorg, null);
});

test("fork reporters never reach viewers", () => {
  const nodes = new Registry(settings);

  login(nodes, "secret-name", "1.1.1.1");
  login(nodes, "b", "2.2.2.2");
  nodes.addBlock("secret-name", chained(5, "a5", "4"));
  nodes.addBlock("b", chained(5, "b5", "4"));

  assert.ok(!JSON.stringify([nodes.all(), nodes.charts()]).includes("secret-name"));
});

test("a block whose parent is not the one the node reported below is a reorg", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);
  nodes.addBlock("a", chained(40, "c40", "39"));
  nodes.addBlock("a", chained(41, "c41", "c40"));
  assert.equal(nodes.charts().health.reorgs, 0);

  // Block 42 builds on a 41 this node never reported
  nodes.addBlock("a", chained(42, "c42", "d41"));
  assert.equal(nodes.charts().health.reorgs, 1);
  assert.equal(nodes.charts().health.lastReorg?.height, 42);
});

test("name checks answer for the asker's address, by the login rules", () => {
  const nodes = new Registry(loadSettings({ PUBLIC_SECRET: "open", RESERVED_NAMES: "parallax", NAME_HOLD_MINUTES: "60" }));

  login(nodes, "taken-name", "1.1.1.1");
  login(nodes, "seed", "2.2.2.2", true);

  assert.equal(nodes.nameStatus("fresh-name", "9.9.9.9"), "available");
  assert.equal(nodes.nameStatus("taken-name", "9.9.9.9"), "taken");
  assert.equal(nodes.nameStatus("taken-name", "1.1.1.1"), "yours");
  assert.equal(nodes.nameStatus("seed", "9.9.9.9"), "reserved");
  assert.equal(nodes.nameStatus("parallax", "9.9.9.9"), "reserved");
  assert.equal(nodes.nameStatus("<bad>", "9.9.9.9"), "invalid");
  assert.equal(nodes.nameStatus(undefined, "9.9.9.9"), "invalid");

  // A disconnected name stays held for its address, then frees up
  disconnect(nodes, "taken-name");
  assert.equal(nodes.nameStatus("taken-name", "9.9.9.9"), "taken");
  nodes.get("taken-name")!.uptime.lastUpdate -= 61 * 60 * 1000;
  assert.equal(nodes.nameStatus("taken-name", "9.9.9.9"), "available");
});

test("block times come from timestamps against the parent, even when history arrives in chunks", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);

  // Blocks every 600 s by timestamp, 100..199
  const at = (n: number) => ({ ...block(n), parentHash: block(n - 1).hash, timestamp: 1_000_000 + n * 600 });

  nodes.askedForHistory("a");
  nodes.addBlock("a", at(199));
  // Newest chunk first, as history requests go, leaving a gap below it
  nodes.addHistory("a", [198, 197, 196, 195, 194, 193, 192, 191, 190, 189, 188, 187, 186, 185, 184, 183, 182, 181, 180, 179, 178, 177, 176, 175, 174, 173, 172, 171, 170, 169, 168, 167, 166, 165, 164, 163, 162, 161, 160, 159].map(at));
  nodes.askedForHistory("a");
  nodes.addHistory("a", Array.from({ length: 59 }, (_, i) => at(158 - i)));

  const charts = nodes.charts();

  // Every block, including the one at the old chunk boundary, is 600 s after its parent
  assert.ok(charts.blocktime.every((t) => t === 600), JSON.stringify(charts.blocktime));
  assert.equal(charts.avgBlocktime, 600);
});

test("a head block's time ignores when it was reported", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);
  nodes.addBlock("a", { ...block(10), timestamp: 6000 });
  // Reported milliseconds later, but mined 450 s after its parent
  nodes.addBlock("a", { ...block(11), parentHash: block(10).hash, timestamp: 6450 });

  assert.equal(nodes.charts().blocktime.at(-1), 450);
});

test("the charts carry each recent block's timestamp and miner, oldest first", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);

  for (let n = 1; n <= 3; n++) nodes.addBlock("a", { ...block(n), miner: "0x" + String(n).repeat(40) });

  const charts = nodes.charts();

  assert.deepEqual(charts.timestamp, [600, 1200, 1800]);
  assert.deepEqual(charts.miner, ["0x" + "1".repeat(40), "0x" + "2".repeat(40), "0x" + "3".repeat(40)]);
});

test("hashrate is the work of the newest unbroken run over its time span", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);

  // Difficulty 1000 per block (from the helper), one block every 10 s
  for (let n = 1; n <= 20; n++) nodes.addBlock("a", { ...block(n), timestamp: n * 10 });

  assert.equal(nodes.charts().avgHashrate, 100);
});

test("hashrate covers only the last 24 hours", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);

  // A block every 10 minutes for 2 days, at twice the difficulty on the second
  for (let n = 1; n <= 288; n++) nodes.addBlock("a", { ...block(n), timestamp: n * 600, difficulty: n > 144 ? "2000" : "1000" });

  assert.equal(nodes.charts().avgHashrate, 2000 / 600);
});

test("a lucky slice moves the block time trend by its share of the 24 hours", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);

  // A block every 10 minutes, except one 4 hour slice of blocks every 5: the block on its start
  // and 47 fast ones. Then 2 days of regular blocks again
  const times = [
    ...Array.from({ length: 1200 }, (_, i) => (i + 1) * 600),
    ...Array.from({ length: 47 }, (_, i) => 720_000 + (i + 1) * 300),
  ];

  for (let i = 0; i < 2 * 144; i++) times.push(times.at(-1)! + 600);

  times.forEach((timestamp, i) => nodes.addBlock("a", { ...block(i + 1), timestamp }));

  const { trends } = nodes.charts((times.at(-1)! + 60) * 1000);
  const lucky = trends.start.indexOf(50 * 14_400);

  assert.ok(lucky > 0);
  assert.equal(trends.blocktime[lucky - 1], 600);
  // 120 blocks at 10 minutes in the 5 slices before, pooled with the lucky slice's 48: not its own mean of about 5 minutes
  assert.ok(Math.abs(trends.blocktime[lucky]! - (5 * 24 * 600 + 600 + 47 * 300) / 168) < 1e-9);
});

test("each hashrate trend point pools the 24 hours to its slice's end", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);

  // A block every 10 minutes for 10 days, at twice the difficulty from the start of a slice 2 days from the end
  for (let n = 1; n <= 1440; n++) nodes.addBlock("a", { ...block(n), difficulty: n > 1152 ? "2000" : "1000" });

  const { trends } = nodes.charts((1440 * 600 + 60) * 1000);
  const near = (actual: number | null, expected: number) => assert.ok(Math.abs(actual! - expected) < 1e-9, `${actual} is not ${expected}`);

  // Slice 29 is the first with the higher difficulty: its 23 blocks at 2000 and the one on its start at 1000,
  // pooled with the 5 slices of 24 blocks at 1000 before it, rather than jumping straight to 2000 / 600
  near(trends.hashrate[28], 1000 / 600);
  near(trends.hashrate[29], (5 * 24 * 1000 + 1000 + 23 * 2000) / (6 * 24 * 600));
  near(trends.hashrate[35], 2000 / 600);
});

test("the 7 day difficulty change compares with the block a week earlier", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);

  // One block every 6 hours for 30 blocks, difficulty rising 1% a block
  for (let n = 1; n <= 30; n++) {
    nodes.addBlock("a", { ...block(n), timestamp: n * 6 * 3600, difficulty: String(Math.round(1_000_000 * 1.01 ** n)) });
  }

  // Block 30 against block 2, exactly 7 days earlier
  const expected = Math.round(1_000_000 * 1.01 ** 30) / Math.round(1_000_000 * 1.01 ** 2) - 1;

  assert.ok(Math.abs(nodes.charts().difficultyWeek! - expected) < 1e-9);

  // Less than a week of history gives no figure
  const young = new Registry(settings);

  login(young, "a", "1.1.1.1", true);
  for (let n = 1; n <= 30; n++) young.addBlock("a", { ...block(n), timestamp: n * 3600 });
  assert.equal(young.charts().difficultyWeek, null);
});

/** linked builds block `n` on chain `tag`, whose parent is on chain `parentTag`; tags are hex digits. */
function linked(n: number, tag: string, parentTag = tag): ReportedBlock {
  const reported = cleanBlock({
    number: n,
    hash: "0x" + (tag + n.toString(16)).padStart(64, "0"),
    parentHash: "0x" + (parentTag + (n - 1).toString(16)).padStart(64, "0"),
    difficulty: "1000",
    totalDifficulty: String(n * 1000),
    timestamp: n * 600,
  });

  if (!reported) throw new Error(`invalid test block ${n}`);

  return reported;
}

test("a reorganization reports how many blocks it replaced", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);
  for (let n = 1; n <= 10; n++) nodes.addBlock("a", linked(n, "a"));

  // The node switches to a chain that parted after block 7, reporting only its new head
  nodes.addBlock("a", linked(11, "b"));

  // Until the new chain's blocks are known, at least one block was replaced
  assert.equal(nodes.charts().health.lastReorg?.depth, 1);

  // The node is asked for its recent blocks, and answers from its new chain
  const request = nodes.nextHistoryRequest("a");

  assert.ok(request);
  assert.equal(request.max, 10);
  nodes.addHistory("a", [linked(10, "b"), linked(9, "b"), linked(8, "b", "a"), ...[7, 6, 5, 4, 3, 2, 1].map((n) => linked(n, "a"))]);

  // Blocks 8 to 10 were replaced
  assert.equal(nodes.charts().health.lastReorg?.depth, 3);
});

test("verified nodes on different chains are a split, a block race is not", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);
  login(nodes, "b", "2.2.2.2", true);

  for (let n = 1; n <= 5; n++) {
    nodes.addBlock("a", linked(n, "a"));
    nodes.addBlock("b", linked(n, "a"));
  }

  // Each finds a different block 6: a race, settled by the next block
  nodes.addBlock("a", linked(6, "a"));
  nodes.addBlock("b", linked(6, "b", "a"));
  assert.equal(nodes.charts().health.split, null);

  // Each builds on its own: two chains that part after block 5
  nodes.addBlock("a", linked(7, "a"));
  nodes.addBlock("b", linked(7, "b"));
  assert.deepEqual(nodes.charts().health.split, { height: 5, chains: 2, nodes: 2 });
});

test("a later routine reorganization does not hide a deep one", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);
  for (let n = 1; n <= 10; n++) nodes.addBlock("a", linked(n, "a"));

  // A switch to a chain that parted after block 7: 3 blocks deep once its blocks arrive
  nodes.addBlock("a", linked(11, "b"));
  nodes.nextHistoryRequest("a");
  nodes.addHistory("a", [linked(10, "b"), linked(9, "b"), linked(8, "b", "a"), ...[7, 6, 5, 4, 3, 2, 1].map((n) => linked(n, "a"))]);
  for (let n = 12; n <= 20; n++) nodes.addBlock("a", linked(n, "b"));

  // Then a one-block race at 21, lost
  nodes.addBlock("a", linked(21, "c", "b"));
  nodes.addBlock("a", linked(21, "d", "b"));

  const { health } = nodes.charts();

  assert.equal(health.lastReorg?.height, 21);
  assert.equal(health.lastReorg?.depth, 1);
  assert.equal(health.lastDeepReorg?.height, 11);
  assert.equal(health.lastDeepReorg?.depth, 3);
});

test("the first incident check rebuilds a majority from saved blocks, still going", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);

  // 9 days of blocks every 10 minutes, every one by the same miner
  for (let n = 1; n <= 9 * 144; n++) nodes.addBlock("a", block(n));

  const now = (9 * 144 * 600 + 60) * 1000;

  assert.equal(nodes.checkIncidents(now), true);

  const held = nodes.incidentLog().list.find((i) => i.kind === "majority");

  assert.equal(held?.end, null);
  assert.equal(held?.startKnown, false);
  assert.equal(nodes.incidentLog().rebuiltFrom, 600_000);
});

test("a full history is filled enough to rebuild incidents from", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);

  // More blocks than the history keeps: it always lacks the height just past its oldest
  for (let n = 1; n <= 2100; n++) nodes.addBlock("a", block(n));

  assert.equal(nodes.checkIncidents((2100 * 600 + 60) * 1000), true);
  assert.notEqual(nodes.incidentLog().rebuiltFrom, null);
});

test("a node whose syncing flag is reversed is syncing when well behind the best block", () => {
  const nodes = new Registry(settings);
  const stats = { active: true, mining: false, hashrate: 0, peers: 8, gasPrice: 0, peerLatency: 0 };

  login(nodes, "new", "1.1.1.1", true, "Parallax/v2.1.2-stable-1dea7a08/linux-amd64/go1.27.1");
  login(nodes, "old", "2.2.2.2", true, "Parallax/v1.1.0-stable-bee11d20/linux-amd64/go1.24.1");
  login(nodes, "odd", "3.3.3.3", true, "something else");
  nodes.addBlock("new", block(100));
  nodes.addBlock("old", block(99));
  nodes.addBlock("odd", block(98));

  // A release with the fix is believed, whatever its height
  nodes.setStats("new", { ...stats, syncing: true });
  assert.equal(nodes.get("new")!.stats.syncing, true);

  // An older or unknown one says syncing when synced: its height decides, one block behind is synced
  nodes.setStats("old", { ...stats, syncing: true });
  nodes.setStats("odd", { ...stats, syncing: false });
  assert.equal(nodes.get("old")!.stats.syncing, false);
  assert.equal(nodes.get("odd")!.stats.syncing, true);
});

test("a node's propagation history leaves out heights from before it connected", () => {
  const nodes = new Registry(settings);
  const start = Date.now() - 10 * 600_000;
  const arrival = (n: number) => start + n * 600_000;

  login(nodes, "old", "1.1.1.1", true);

  for (let n = 1; n <= 8; n++) {
    nodes.addBlock("old", block(n));
    nodes.history.search(n)!.block.arrived = arrival(n);
  }

  // Connects between blocks 5 and 6, reports 6, misses 7, reports 8
  login(nodes, "new", "2.2.2.2", true);
  nodes.get("new")!.connectedAt = arrival(5.5);
  nodes.addBlock("new", block(6));
  nodes.addBlock("new", block(8));

  const node = nodes.get("new")!;
  const measured = node.history.filter((ms) => ms >= 0);

  // Before it connected: no data, rather than the 10 minutes and more until its first report
  assert.deepEqual(node.history.slice(-8, -3), [-1, -1, -1, -1, -1]);
  // A height it missed while connected is as late as its next report
  assert.equal(node.history.at(-2), 600_000);
  assert.equal(measured.length, 3);
  assert.equal(node.stats.propagationAvg, Math.round(measured.reduce((a, b) => a + b, 0) / measured.length));
  // Uptime counts from its first login, not from the first block
  assert.equal(node.stats.uptime, 100);

  // A height filled in from history after the node's next report has nothing to measure either
  nodes.history.search(7)!.block.arrived = arrival(8) + 1000;
  nodes.addBlock("new", block(8));
  assert.equal(nodes.get("new")!.history.at(-2), -1);
});
