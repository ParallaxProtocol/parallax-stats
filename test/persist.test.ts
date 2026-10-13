import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openStore, STATE_VERSION } from "../src/server/persist.ts";
import { Registry } from "../src/server/registry.ts";
import { cleanBlock, type ReportedBlock } from "../src/server/sanitize.ts";
import { loadSettings } from "../src/server/settings.ts";

const settings = loadSettings({ PUBLIC_SECRET: "open", NAME_HOLD_MINUTES: "60" });

let connections = 0;

function login(nodes: Registry, id: string, ip: string, trusted: boolean, now: number): void {
  nodes.add({ id, ip, trusted, connection: ++connections, latency: 12, geo: { country: "US", city: "Boston", ll: [42.36, -71.06] }, info: { name: id, node: "Parallax/v2.1.2-stable/linux-amd64/go1.27.1" } as never }, now);
}

function block(number: number, parent = number - 1): ReportedBlock {
  const reported = cleanBlock({
    number,
    hash: "0x" + number.toString(16).padStart(64, "0"),
    parentHash: "0x" + parent.toString(16).padStart(64, "0"),
    difficulty: "1000",
    totalDifficulty: String(number * 1000),
    timestamp: number * 600,
  });

  if (!reported) throw new Error(`invalid test block ${number}`);

  return reported;
}

function withStore(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "parallax-stats-"));

  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("state survives a restart through the store", () => {
  withStore((dir) => {
    // Two hours of history ending ten minutes ago, so reconnecting at the real time comes after it
    const start = Date.now() - 7_800_000;
    const before = new Registry(settings);

    login(before, "seed-1", "1.1.1.1", true, start);
    login(before, "home-node", "2.2.2.2", false, start);
    for (let n = 1; n <= 30; n++) before.addBlock("seed-1", block(n));
    for (const id of ["seed-1", "home-node"]) before.get(id)!.uptime = { started: start, up: 0, down: 0, lastStatus: true, lastUpdate: start };

    // home-node is down for the second hour of two: 50% uptime
    before.get("home-node")!.setState(false, start + 3_600_000);
    before.get("home-node")!.setState(false, start + 7_200_000);
    before.get("seed-1")!.setState(true, start + 7_200_000);

    const savedAt = start + 7_200_000;
    const store = openStore(dir);

    store.save({ version: STATE_VERSION, savedAt, registry: before.toState() });
    store.close();

    // Only the server's user may read it: it holds addresses
    assert.equal(statSync(join(dir, "parallax-stats.db")).mode & 0o777, 0o600);

    // Back up ten minutes later
    const now = Date.now();
    const saved = openStore(dir).load()!;
    const after = new Registry(settings);

    after.restore(saved.registry, now - saved.savedAt, now);

    const seed = after.get("seed-1")!;
    const home = after.get("home-node")!;

    // Nodes come back offline, with their uptime, and the dashboard's own downtime not held against them
    assert.equal(seed.stats.active, false);
    assert.equal(seed.stats.uptime, 100);
    assert.equal(home.stats.uptime, 50);
    assert.equal(seed.stats.block.number, 30);
    assert.deepEqual(seed.geo, { country: "US", city: "Boston", ll: [42.36, -71.06] });

    // Offline since it went down, or for one connected when the dashboard stopped, since then
    assert.equal(home.offlineSince, start + 3_600_000);
    assert.equal(seed.offlineSince, savedAt);
    assert.equal(seed.toPublic().offlineSince, savedAt);

    // Pseudonyms stay the same
    assert.equal(home.publicId, before.get("home-node")!.publicId);

    // The block history and charts are back
    assert.equal(after.history.length, 30);
    assert.deepEqual(after.charts().height, before.charts().height);
    assert.deepEqual(after.charts().difficulty, before.charts().difficulty);

    // Name holds still apply: the name stays bound to its address
    assert.equal(after.nameStatus("home-node", "9.9.9.9", now), "taken");
    assert.equal(after.nameStatus("home-node", "2.2.2.2", now), "yours");

    // Reconnecting soon after the restart costs no uptime for the wait
    seed.setState(true, now + 60_000);
    assert.equal(seed.stats.active, true);
    assert.equal(seed.offlineSince, null);
    assert.equal(seed.stats.uptime, 100);
    assert.equal(home.stats.uptime, 50);

    // Past the grace period the wait counts as downtime
    home.setState(true, now + 3 * 60_000);
    assert.ok(home.stats.uptime < 50);
  });
});

test("a restart does not keep a node offline for long in the list", () => {
  const start = Date.now() - 5 * 3_600_000;
  const before = new Registry(settings);

  login(before, "home-node", "2.2.2.2", false, start);
  before.get("home-node")!.setState(false, start);

  // The dashboard restarts 3 hours into the node's downtime
  const restarted = new Registry(settings);

  restarted.restore(JSON.parse(JSON.stringify(before.toState())), 60_000, start + 3 * 3_600_000);
  assert.ok(restarted.get("home-node"));

  // Over 4 hours offline in all, it is forgotten, though only 2 since the restart
  assert.equal(restarted.removeOldNodes(start + 4 * 3_600_000 + 60_000), 1);
  assert.equal(restarted.get("home-node"), undefined);
});

test("a snapshot from another version is ignored", () => {
  withStore((dir) => {
    const store = openStore(dir);

    store.save({ version: STATE_VERSION + 1, savedAt: Date.now(), registry: new Registry(settings).toState() });
    assert.equal(store.load(), null);
    store.close();
  });
});

test("an empty store loads nothing", () => {
  withStore((dir) => {
    const store = openStore(dir);

    assert.equal(store.load(), null);
    store.close();
  });
});
