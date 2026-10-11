// Runs the websocket hub on a plain HTTP server and talks to it over raw
// websockets, the way the parallaxd reporter (node/stats/prlstats.go)
// and the browser do.

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import type { PublicNode, ServerMessage, Snapshot } from "../src/lib/protocol.ts";
import { createHub, type Hub } from "../src/server/hub.ts";
import { log } from "../src/server/log.ts";
import { loadSettings } from "../src/server/settings.ts";

const HASH = "0x" + "cd".repeat(32);
const PRIVATE = "priv-7f3a91c2e8";
const POOL_SECRET = "pool-4c19e0b7d2";

let server: Server;
let hub: Hub;
let base: string;

before(async () => {
  log.quiet = true;
  hub = createHub(
    loadSettings({ WS_SECRET: `${PRIVATE}|pool-*=${POOL_SECRET}`, PUBLIC_SECRET: "open", MAX_NODES_PER_IP: "2", CONN_PER_MINUTE: "1000" }),
    { fetchGasPrice: async () => 117_391_737_659n },
  );
  server = createServer((req, res) => {
    if (!hub.handleRequest(req, res)) res.end();
  });
  server.on("upgrade", (req, socket, head) => {
    if (!hub.handleUpgrade(req, socket, head)) socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  hub.close();
  server.close();
});

type Client = WebSocket & { messages: unknown[]; closed: boolean };

function connect(path: string, headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base + path, { headers }) as Client;

    ws.messages = [];
    ws.closed = false;
    ws.on("message", (raw) => ws.messages.push(JSON.parse(raw.toString())));
    ws.on("close", () => (ws.closed = true));
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function emit(ws: WebSocket, event: string, data?: unknown): void {
  ws.send(JSON.stringify({ emit: [event, data] }));
}

async function waitFor<T>(check: () => T, ms = 3000): Promise<NonNullable<T>> {
  const deadline = Date.now() + ms;

  for (;;) {
    const value = check();

    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");

    await sleep(20);
  }
}

function isReady(ws: Client): boolean {
  return ws.messages.some((m) => JSON.stringify(m) === '{"emit":["ready"]}');
}

async function report(id: string, secret: string, headers?: Record<string, string>): Promise<Client> {
  const ws = await connect("/api", headers);

  emit(ws, "hello", {
    id,
    secret,
    info: { name: id, node: "Parallax/v2.1.0-stable/linux-amd64/go1.27.1", net: "2110", canUpdateHistory: true },
  });

  return ws;
}

/** viewNodes fetches the node list a browser gets on connecting. */
async function viewNodes(): Promise<PublicNode[]> {
  const ws = await connect("/live");
  const snapshot = await waitFor(() => ws.messages.find((m) => (m as ServerMessage).type === "snapshot"));

  ws.close();

  return (snapshot as Snapshot).nodes;
}

test("a secret limited to some names verifies those and refuses others", async () => {
  const pool = await report("pool-eu", POOL_SECRET);

  await waitFor(() => isReady(pool));
  assert.equal((await viewNodes()).find((n) => n.id === "pool-eu")?.trusted, true);

  // The pool's secret cannot verify a name outside its own
  const impostor = await report("seed-1", POOL_SECRET);

  await waitFor(() => impostor.closed);
  assert.ok(!isReady(impostor));
  assert.equal((await viewNodes()).find((n) => n.id === "seed-1"), undefined);

  pool.close();
});

test("a wrong secret is refused", async () => {
  const ws = await report("intruder", "guess");

  await waitFor(() => ws.closed);
  assert.ok(!isReady(ws));
  assert.equal((await viewNodes()).find((n) => n.id === "intruder"), undefined);
});

test("public and private secrets log in with different trust", async () => {
  const pub = await report("public-node", "open");
  const priv = await report("own-node", PRIVATE);

  await waitFor(() => isReady(pub) && isReady(priv));

  const nodes = await viewNodes();

  assert.equal(nodes.find((n) => n.id === "own-node")?.trusted, true);
  assert.ok(nodes.some((n) => !n.trusted && /^node-[0-9a-f]{8}$/.test(n.id)));

  pub.close();
  priv.close();
});

test("a node without a secret logs in unverified", async () => {
  const ws = await report("no-secret-node", "");

  await waitFor(() => isReady(ws));

  const nodes = await viewNodes();

  assert.equal(nodes.find((n) => n.id === "no-secret-node"), undefined);
  assert.ok(nodes.some((n) => !n.trusted && /^node-[0-9a-f]{8}$/.test(n.id)));

  ws.close();
});

test("reports are attributed to the logged in node, not the claimed id", async () => {
  const victim = await report("victim", PRIVATE);
  const attacker = await report("attacker", "open");

  await waitFor(() => isReady(victim) && isReady(attacker));

  emit(victim, "stats", { id: "victim", stats: { active: true, peers: 8, peerLatency: 50 } });
  emit(attacker, "stats", { id: "victim", stats: { active: true, peers: 0, peerLatency: 9999 } });
  await sleep(200);

  const nodes = await viewNodes();

  assert.equal(nodes.find((n) => n.id === "victim")?.stats.peers, 8);
  assert.ok(nodes.some((n) => !n.trusted && n.stats.peerLatency === 9999));

  victim.close();
  attacker.close();
});

test("viewers get live updates but never the names of unverified nodes", async () => {
  const viewer = await connect("/live");
  const pub = await report("hidden-name-xyz", "open");

  await waitFor(() => isReady(pub));

  emit(pub, "stats", { stats: { active: true, peers: 3, peerLatency: 40 } });
  emit(pub, "pending", { stats: { pending: 2 } });
  emit(pub, "block", { block: { number: 3, hash: HASH, difficulty: "1", totalDifficulty: "3" } });

  await waitFor(() => viewer.messages.some((m) => (m as ServerMessage).type === "charts"), 5000);

  const types = new Set(viewer.messages.map((m) => (m as ServerMessage).type));

  assert.deepEqual([...types].sort(), ["block", "charts", "node", "pending", "snapshot", "stats"]);
  assert.ok(!JSON.stringify(viewer.messages).includes("hidden-name-xyz"));
  assert.ok(!JSON.stringify(await viewNodes()).includes("hidden-name-xyz"));

  viewer.close();
  pub.close();
});

test("nodes get pongs and history requests in the Primus framing", async () => {
  const ws = await report("history-node", PRIVATE);

  await waitFor(() => isReady(ws));

  emit(ws, "node-ping", { id: "history-node", clientTime: "123" });
  const pong = (await waitFor(() =>
    ws.messages.find((m) => (m as { emit?: unknown[] }).emit?.[0] === "node-pong"),
  )) as { emit: [string, { clientTime: string; serverTime: number }] };

  assert.equal(pong.emit[1].clientTime, "123");

  emit(ws, "block", { block: { number: 1000, hash: HASH, difficulty: "1", totalDifficulty: "1" } });
  emit(ws, "block", { block: { number: 1001, hash: "0x" + "ce".repeat(32), difficulty: "1", totalDifficulty: "2" } });
  emit(ws, "latency", { latency: "12" });

  const request = (await waitFor(() =>
    ws.messages.find((m) => (m as { emit?: unknown[] }).emit?.[0] === "history"),
  )) as { emit: [string, { list: number[] }] };

  assert.equal(request.emit[1].list.length, 50);
  assert.equal(request.emit[1].list.at(-1), 999);

  // Primus heartbeats from older reporters are answered
  ws.send(JSON.stringify("primus::ping::42"));
  await waitFor(() => ws.messages.includes("primus::pong::42"));

  ws.close();
});

test("viewers can measure their latency", async () => {
  const viewer = await connect("/live");

  viewer.send(JSON.stringify({ type: "ping", t: 7 }));

  const pong = await waitFor(() => viewer.messages.find((m) => (m as ServerMessage).type === "pong"));

  assert.equal((pong as { t: number }).t, 7);
  viewer.close();
});

test("messages before login are ignored", async () => {
  const ws = await connect("/api");

  emit(ws, "block", { id: "ghost", block: { number: 5, hash: HASH, difficulty: "1", totalDifficulty: "1" } });
  await sleep(200);

  assert.equal((await viewNodes()).find((n) => n.id === "ghost"), undefined);
  ws.close();
});

test("forwarding headers from an untrusted peer do not dodge the per-address cap", async () => {
  const a = await report("cap-a", "open", { "x-forwarded-for": "1.1.1.1" });
  const b = await report("cap-b", "open", { "x-forwarded-for": "2.2.2.2" });

  await waitFor(() => isReady(a) && isReady(b));

  const c = await report("cap-c", "open", { "x-forwarded-for": "3.3.3.3" });

  await waitFor(() => c.closed);
  assert.ok(!isReady(c));

  a.close();
  b.close();
});

test("flooding a connection gets it closed", async () => {
  const ws = await report("flooder", PRIVATE);

  await waitFor(() => isReady(ws));

  for (let i = 0; i < 200; i++) emit(ws, "pending", { stats: { pending: i } });

  await waitFor(() => ws.closed);
});

test("the private secret never reaches viewers or reporters", async () => {
  const viewer = await connect("/live");
  const own = await report("secret-check", PRIVATE);
  const pub = await report("secret-check-pub", "open");
  const wrong = await report("secret-check-bad", PRIVATE + "x");
  const closeReasons: string[] = [];

  wrong.on("close", (_code, reason) => closeReasons.push(reason.toString()));
  await waitFor(() => isReady(own) && isReady(pub) && wrong.closed);

  emit(own, "stats", { stats: { active: true, peers: 5, peerLatency: 30 } });
  emit(own, "node-ping", { clientTime: "t" });
  emit(own, "latency", { latency: "5" });
  await sleep(200);

  const seen = JSON.stringify([viewer.messages, own.messages, pub.messages, wrong.messages, closeReasons, await viewNodes()]);

  assert.ok(viewer.messages.length > 0 && own.messages.length > 0);
  assert.ok(!seen.includes(PRIVATE));
  assert.ok(!seen.includes("priv-7f3a"));

  viewer.close();
  own.close();
  pub.close();
});

test("fees reported with a block reach viewers in the charts", async () => {
  const viewer = await connect("/live");
  const ws = await report("fee-node", PRIVATE);

  await waitFor(() => isReady(ws));

  emit(ws, "block", { block: { number: 5000, hash: "0x" + "ef".repeat(32), difficulty: "1", totalDifficulty: "1", fees: "441000000000000" } });

  const charts = (await waitFor(
    () => viewer.messages.findLast((m) => (m as ServerMessage).type === "charts" && (m as { charts: { fees: unknown[] } }).charts.fees.includes("441000000000000")),
    5000,
  )) as { charts: { fees: (string | null)[] } };

  assert.ok(charts.charts.fees.includes("441000000000000"));

  viewer.close();
  ws.close();
});

test("the hub tells the page whether public nodes are open, and never exposes a secret", () => {
  assert.equal(hub.publicNodes, true);
  assert.ok(!JSON.stringify(hub).includes("open"));
  assert.ok(!JSON.stringify(hub).includes(PRIVATE));
});

test("the name check answers with a status only, and is rate limited", async () => {
  const http = base.replace("ws://", "http://");
  const pub = await report("checked-name", "open");

  await waitFor(() => isReady(pub));

  const check = async (name: string) => {
    const res = await fetch(`${http}/api/v1/names?name=${encodeURIComponent(name)}`);
    return { code: res.status, body: await res.json() };
  };

  // The test client connects from the same address as the node
  assert.deepEqual(await check("checked-name"), { code: 200, body: { status: "yours" } });
  assert.deepEqual(await check("unused-name-123"), { code: 200, body: { status: "available" } });
  assert.deepEqual(await check(""), { code: 200, body: { status: "invalid" } });

  const post = await fetch(`${http}/api/v1/names?name=x`, { method: "POST" });
  assert.equal(post.status, 405);

  let limited = false;

  for (let i = 0; i < 25 && !limited; i++) limited = (await check("unused-name-123")).code === 429;
  assert.ok(limited);

  pub.close();
});

test("viewers get the recommended gas price in the snapshot", async () => {
  const ws = await connect("/live");
  const snapshot = (await waitFor(() => ws.messages.find((m) => (m as ServerMessage).type === "snapshot"))) as Snapshot;

  assert.equal(snapshot.gasPrice, "117391737659");
  ws.close();
});

test("the stats endpoints are rate limited per address", async () => {
  const limited = createHub(loadSettings({ PUBLIC_SECRET: "open", API_PER_MINUTE: "3" }));
  const api = createServer((req, res) => {
    // What the hub lets through, Next.js answers
    if (!limited.handleRequest(req, res)) res.end("{}");
  });

  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));

  const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  try {
    const statuses = [];

    for (let i = 0; i < 4; i++) statuses.push((await fetch(`${url}/api/v2/stats`)).status);

    assert.deepEqual(statuses, [200, 200, 200, 429]);

    // The limit is per address and shared by both versions
    const v1 = await fetch(`${url}/api/v1/stats`);

    assert.equal(v1.status, 429);
    assert.equal(v1.headers.get("retry-after"), "60");
    assert.equal(v1.headers.get("access-control-allow-origin"), "*");

    // Other paths are not counted
    assert.equal((await fetch(`${url}/`)).status, 200);
  } finally {
    limited.close();
    api.close();
  }
});
