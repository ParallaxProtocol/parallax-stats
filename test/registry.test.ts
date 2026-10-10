import assert from "node:assert/strict";
import test from "node:test";
import { LoginRefused, Registry } from "../src/server/registry.ts";
import { cleanBlock, type ReportedBlock } from "../src/server/sanitize.ts";
import { loadSettings } from "../src/server/settings.ts";

const settings = loadSettings({ PUBLIC_SECRET: "open", MAX_NODES: "5", MAX_NODES_PER_IP: "2", NAME_HOLD_MINUTES: "60" });

let connections = 0;

/** login returns the refusal reason, or null when admitted. */
function login(nodes: Registry, id: string, ip: string, trusted = false): string | null {
  try {
    nodes.add({ id, ip, trusted, connection: ++connections, latency: 0, geo: null, info: { name: id } as never });
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

test("propagation stats skip first reports and split delays into speed bands", () => {
  const nodes = new Registry(settings);
  const delays = [0, 40, 60, 80, 120, 900, 1500, 4000, 9000];

  delays.forEach((_, i) => login(nodes, "n" + i, "10.1.0." + i, true));
  nodes.addBlock("n0", block(10));

  // Every other node reports the same block after its delay
  const height = nodes.history.search(10)!;

  delays.slice(1).forEach((delay, i) => {
    nodes.addBlock("n" + (i + 1), block(10));
    height.propagTimes.at(-1)!.propagation = delay;
  });

  const { propagation } = nodes.charts();

  assert.equal(propagation.samples, 8);
  assert.deepEqual(propagation.bands, [5, 1, 1, 1]);
  assert.equal(propagation.p50, 120);
  assert.equal(propagation.p90, 9000);
  assert.equal(propagation.avg, Math.round((40 + 60 + 80 + 120 + 900 + 1500 + 4000 + 9000) / 8));
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

test("hashrate is the work of the newest unbroken run over its time span", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);

  // Difficulty 1000 per block (from the helper), one block every 10 s
  for (let n = 1; n <= 20; n++) nodes.addBlock("a", { ...block(n), timestamp: n * 10 });

  assert.equal(nodes.charts().avgHashrate, 100);
});

test("the 24 hour difficulty change compares with the block a day earlier", () => {
  const nodes = new Registry(settings);

  login(nodes, "a", "1.1.1.1", true);

  // One block an hour for 30 hours, difficulty rising 1% a block
  for (let n = 1; n <= 30; n++) {
    nodes.addBlock("a", { ...block(n), timestamp: n * 3600, difficulty: String(Math.round(1_000_000 * 1.01 ** n)) });
  }

  // Block 30 against block 6, exactly 24 h earlier
  const expected = Math.round(1_000_000 * 1.01 ** 30) / Math.round(1_000_000 * 1.01 ** 6) - 1;

  assert.ok(Math.abs(nodes.charts().difficultyDay! - expected) < 1e-9);

  // Less than a day of history gives no figure
  const young = new Registry(settings);

  login(young, "a", "1.1.1.1", true);
  young.addBlock("a", { ...block(1), timestamp: 1000 });
  young.addBlock("a", { ...block(2), timestamp: 2000 });
  assert.equal(young.charts().difficultyDay, null);
});
