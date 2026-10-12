// Simulated parallaxd reporters for developing the dashboard without a
// network. Each speaks the same protocol as node/stats/prlstats.go.
//
//   pnpm simulate [url] [nodes]
//
// It reads the same .env files as the server and logs in with its
// WS_SECRET, and without a secret when PUBLIC_SECRET opens the server to
// public nodes, so a third of the nodes are verified. Set
// TRUSTED_PROXIES=127.0.0.1,::1 for the server so the simulated addresses
// count (locations on the map, and the per-address limits). SIM_BLOCK_MS
// sets the average block interval (default 20 s; the real target is 10 min),
// and SIM_MAJORITY the share of blocks the largest miner finds (default 0.6).

import nextEnv from "@next/env";
import { WebSocket } from "ws";
import { nextDifficulty } from "../src/lib/asert.ts";

nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

const url = process.argv[2] ?? `ws://localhost:${process.env.PORT ?? 3000}/api`;
const count = Number(process.argv[3] ?? 8);
const privateSecret = process.env.SIM_SECRET ?? process.env.WS_SECRET?.split(/[|,]/)[0]?.trim() ?? "";
const publicSecret = process.env.SIM_PUBLIC_SECRET ?? process.env.PUBLIC_SECRET?.trim() ?? "";
const blockMs = Number(process.env.SIM_BLOCK_MS ?? 20_000);

if (!privateSecret && !publicSecret) {
  console.error("Set WS_SECRET or PUBLIC_SECRET (in .env.local or the environment) to match the server");
  process.exit(1);
}

// Public addresses in different places, so the map has something to show
const ADDRESSES = [
  "8.8.8.8",
  "81.2.69.142",
  "185.199.108.153",
  "103.21.244.1",
  "151.101.1.69",
  "177.71.128.1",
  "41.203.64.1",
  "202.12.27.33",
  "45.33.32.156",
  "194.25.0.68",
  "1.1.1.1",
  "62.210.16.6",
];

// Client versions as parallaxd reports them: official release builds, whose
// commits match the GitHub release tags, and a build from source with local
// changes, whose commit matches no release.
const VERSIONS = ["v2.1.2-stable-1dea7a08", "v2.1.1-stable-09519094", "v2.1.2-stable-4f2c9e1b", "v2.1.0-stable-e87747a4"];
// Verified nodes must run v2.1.2 or newer
const VERIFIED_VERSIONS = VERSIONS.filter((v) => v.startsWith("v2.1.2"));

// Fourteen miners. The first finds SIM_MAJORITY of blocks (default 0.6, so
// the dashboard shows a critical mining majority; 0 spreads them out), and
// a few of the rest find most of the others.
const MINERS = Array.from({ length: 14 }, (_, i) => "0x" + (i + 1).toString(16).padStart(2, "0").repeat(20));
const majority = Math.min(1, Math.max(0, Number(process.env.SIM_MAJORITY ?? 0.6) || 0));

function pickMiner(): string {
  return Math.random() < majority ? MINERS[0] : MINERS[1 + Math.floor(Math.random() ** 2.5 * (MINERS.length - 1))];
}

interface SimBlock {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  miner: string;
  gasUsed: number;
  gasLimit: number;
  difficulty: string;
  totalDifficulty: string;
  transactions: string[];
  uncles: string[];
  fees: string;
}

const chain: SimBlock[] = [];

function hash(n: number): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

/** makeBlock builds block `number`, with the difficulty mainnet's ASERT gives it after `parent`. */
function makeBlock(number: number, timestamp: number, parent: SimBlock | undefined): SimBlock {
  const difficulty = nextDifficulty(number - 1, parent?.timestamp ?? timestamp - 600);
  const txs = Math.floor(Math.random() * 40);
  const gasUsed = txs * 21000 + Math.floor(Math.random() * 400_000);
  // Gas used at 1 to 3 gwei
  const fees = (BigInt(gasUsed) * BigInt(Math.floor(1e9 + Math.random() * 2e9))).toString();

  return {
    number,
    hash: hash(number * 7919),
    parentHash: hash((number - 1) * 7919),
    timestamp,
    miner: pickMiner(),
    gasUsed,
    gasLimit: 30_000_000,
    difficulty: difficulty.toString(),
    totalDifficulty: (BigInt(parent?.totalDifficulty ?? 0) + difficulty).toString(),
    transactions: Array.from({ length: txs }, (_, i) => hash(number * 1000 + i)),
    uncles: [],
    fees,
  };
}

// A chain near mainnet's real height whose past blocks are 10 minutes
// apart on average, ending now
const HEAD = 59_000;
const times: number[] = [];
let t = Math.floor(Date.now() / 1000);

for (let n = HEAD; n >= HEAD - 2100; n--) {
  times.unshift(t);
  t -= Math.max(5, Math.round(-Math.log(1 - Math.random()) * 600));
}

times.forEach((time, i) => chain.push(makeBlock(HEAD - 2100 + i, time, chain.at(-1))));

const listeners = new Set<(block: SimBlock) => void>();
/** Nodes that briefly follow a competing block before reorganizing onto the real one. */
const racers = new Set<(block: SimBlock) => void>();

function mine(): void {
  const head = chain.at(-1)!;
  const block = makeBlock(head.number + 1, Math.floor(Date.now() / 1000), head);

  chain.push(block);

  // Now and then a competing block at the same height reaches one node first; it loses
  if (Math.random() < 0.15) {
    const rival = { ...block, hash: hash(block.number * 7919 + 1), miner: MINERS.at(-1)! };

    for (const r of racers) r(rival);
  }

  for (const l of listeners) l(block);

  setTimeout(mine, Math.max(1000, -Math.log(1 - Math.random()) * blockMs));
}

function startNode(index: number): void {
  const verified = privateSecret !== "" && (publicSecret === "" || index < Math.max(1, Math.floor(count / 3)));
  const id = verified ? `seed-${index + 1}` : `operator-node-${index + 1}`;
  const lag = index === count - 1 ? 3 : 0;
  const delay = 50 + Math.random() * (index % 3 === 2 ? 4000 : 900);
  const peers = 2 + Math.floor(Math.random() * 20);
  const peerLatency = 40 + Math.floor(Math.random() * 300);
  const ws = new WebSocket(url, { headers: { "x-forwarded-for": ADDRESSES[index % ADDRESSES.length] } });

  function emit(event: string, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ emit: [event, data] }));
  }

  function race(rival: SimBlock): void {
    emit("block", { id, block: rival });
  }

  function report(block: SimBlock): void {
    setTimeout(() => {
      const own = chain[chain.length - 1 - lag] ?? block;
      // The last node acts as an older parallaxd that does not report fees
      const report = index === count - 1 ? { ...own, fees: undefined } : own;

      emit("block", { id, block: report });
      emit("pending", { id, stats: { pending: Math.floor(Math.random() * 30) } });
    }, delay);
  }

  ws.on("open", () => {
    emit("hello", {
      id,
      secret: verified ? privateSecret : "",
      info: {
        name: id,
        node: `Parallax/${verified ? VERIFIED_VERSIONS[index % VERIFIED_VERSIONS.length] : VERSIONS[index % VERSIONS.length]}/linux-amd64/go1.27.1`,
        port: 32110,
        net: "2110",
        protocol: "prl/68, snap/1",
        api: "No",
        os: "linux",
        os_v: "amd64",
        client: "0.1.1",
        canUpdateHistory: true,
      },
    });
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (typeof msg === "string") {
      if (msg.startsWith("primus::ping::")) ws.send(JSON.stringify(msg.replace("ping", "pong")));
      return;
    }

    const [event, data] = msg.emit ?? [];

    if (event === "ready") {
      console.log(`${id} logged in${verified ? " (verified)" : ""}`);
      report(chain.at(-1)!);
      emit("stats", { id, stats: { active: true, syncing: lag > 0, mining: index === 0, hashrate: 4.2e9, peers, gasPrice: 1e9, uptime: 100, peerLatency } });
      listeners.add(report);
      // The second verified node is the one that sometimes sees a rival block first
      if (index === 1) racers.add(race);
    }

    if (event === "history") {
      const wanted = new Set<number>(data.list);
      const blocks = chain
        .filter((b) => wanted.has(b.number))
        .reverse()
        .map((b) => (index === count - 1 ? { ...b, fees: undefined } : b));

      emit("history", { id, history: blocks });
    }
  });

  const pinger = setInterval(() => {
    emit("node-ping", { id, clientTime: new Date().toISOString() });
    emit("latency", { id, latency: String(10 + Math.floor(Math.random() * 120)) });
  }, 5000);

  ws.on("close", (code, reason) => {
    console.log(`${id} disconnected (${code} ${reason}), retrying`);
    listeners.delete(report);
    racers.delete(race);
    clearInterval(pinger);
    setTimeout(() => startNode(index), 5000);
  });

  ws.on("error", () => {});
}

for (let i = 0; i < count; i++) setTimeout(() => startNode(i), i * 300);

setTimeout(mine, blockMs);
