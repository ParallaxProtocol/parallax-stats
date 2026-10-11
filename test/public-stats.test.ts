import assert from "node:assert/strict";
import test from "node:test";
import { Registry } from "../src/server/registry.ts";
import { publicStats } from "../src/server/public-stats.ts";
import { cleanBlock, type ReportedBlock } from "../src/server/sanitize.ts";
import { loadSettings } from "../src/server/settings.ts";

function block(n: number, miner: string): ReportedBlock {
  const reported = cleanBlock({
    number: n,
    hash: "0x" + n.toString(16).padStart(64, "0"),
    parentHash: "0x" + (n - 1).toString(16).padStart(64, "0"),
    difficulty: "4294967296000",
    totalDifficulty: String(n),
    timestamp: n * 600,
    miner,
  });

  if (!reported) throw new Error(`invalid test block ${n}`);

  return reported;
}

test("the v2 stats carry the dashboard's figures and alerts", () => {
  const pool = "0x" + "a".repeat(40);
  const solo = "0x" + "b".repeat(40);
  const nodes = new Registry(loadSettings({ WS_SECRET: "private-secret", MINING_POOLS: `Big Pool=https://pool.example,${pool}` }));

  nodes.add({ id: "seed", ip: "1.1.1.1", trusted: true, connection: 1, latency: 0, geo: null, info: { name: "seed", node: "Parallax/v2.1.1-stable/linux-amd64/go1.27" } as never });

  // 20 blocks, 10 minutes apart, 15 of them by one pool
  for (let n = 1; n <= 20; n++) nodes.addBlock("seed", block(n, n <= 15 ? pool : solo));

  const snapshot = { serverTime: 1, nodes: nodes.all(), charts: nodes.charts(), gasPrice: "1000000000", pools: { [pool]: { name: "Big Pool", url: "https://pool.example/" } } };
  const stats = publicStats(snapshot, { tag: "v2.1.2", url: "https://example.org/v2.1.2" }, 20 * 600 * 1000 + 60_000);

  assert.equal(stats.bestBlock?.number, 20);
  assert.equal(stats.bestBlock?.pool, null);
  assert.equal(stats.blockTime.week.averageSeconds, 600);
  assert.equal(stats.blockTime.recent.averageSeconds, 600);
  assert.equal(stats.blockTime.week.fullWeek, false);
  assert.deepEqual(stats.recommendedFee, { wei: "1000000000", gwei: 1, transferLax: 0.000021 });
  assert.equal(stats.difficulty.latest, "4294967296000");

  // One pool holds a majority
  assert.equal(stats.decentralization.grade, "critical");
  assert.equal(stats.decentralization.majorityHolders, 1);
  assert.deepEqual(stats.decentralization.topMiners[0], { name: "Big Pool", website: "https://pool.example/", address: pool, blocks: 15, share: 0.75 });

  // The same alerts the page shows: the majority, and a release the node is behind on
  assert.deepEqual(
    stats.alerts.map((a) => [a.type, a.level]),
    [
      ["majority", "critical"],
      ["release", "info"],
    ],
  );
  assert.deepEqual(stats.alerts[1].details, { version: "v2.1.2", url: "https://example.org/v2.1.2", behind: 1, online: 1 });
});
