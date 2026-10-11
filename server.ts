// Entry point: one HTTP server for the Next.js app and the stats
// websockets. Run with `node server.ts` (Node strips the types).

import { createServer } from "node:http";
import nextEnv from "@next/env";
import next from "next";
import { createGeoLookup } from "./src/server/geo.ts";
import { openStore } from "./src/server/persist.ts";
import { createHub } from "./src/server/hub.ts";
import { fetchGasPrice } from "./src/server/rpc.ts";
import { log } from "./src/server/log.ts";
import { loadSettings } from "./src/server/settings.ts";
import { watchSecrets } from "./src/server/secrets.ts";
import { publishHub } from "./src/server/store.ts";

const dev = process.env.NODE_ENV !== "production";

// Load .env files the way Next.js does. Next only loads them once the app
// is prepared, but the stats server needs its secrets before that.
nextEnv.loadEnvConfig(process.cwd(), dev);

const settings = loadSettings();

if (settings.privateSecrets.length === 0 && settings.publicSecret.length === 0 && !settings.secretsFile) {
  console.error("Neither WS_SECRET, PUBLIC_SECRET nor a secrets file is set");
  process.exit(1);
}

// A private secret makes a node verified, so it must not be guessable.
// Only the count is logged, never the secrets themselves.
const weak = settings.privateSecrets.filter(({ secret }) => secret.length < 16).length;

if (weak > 0) {
  log.warn("CFG", `${weak} WS_SECRET value(s) shorter than 16 characters; use a random one, e.g. \`openssl rand -hex 32\``);
}

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const rpcURL = process.env.RPC_URL || "https://rpc.parallaxprotocol.org";
const hub = createHub(settings, {
  lookupGeo: createGeoLookup(),
  fetchGasPrice: () => fetchGasPrice(rpcURL),
  store: settings.dataDir ? openStore(settings.dataDir) : undefined,
});

publishHub(hub);

// Private secrets from the secrets file: changes apply while running, and
// nodes whose secret was removed are disconnected
const stopWatchingSecrets = settings.secretsFile ? watchSecrets(settings, settings.secretsFile, () => hub.recheckSecrets()) : () => {};

const server = createServer();
const app = next({ dev, port, httpServer: server });

await app.prepare();

const handle = app.getRequestHandler();
const upgrade = app.getUpgradeHandler();

server.on("request", (req, res) => {
  if (!hub.handleRequest(req, res)) handle(req, res);
});
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => socket.destroy());

  // Anything else, such as dev-mode hot reloading, goes to Next.js
  if (!hub.handleUpgrade(req, socket, head)) upgrade(req, socket, head);
});

server.listen(port, () => {
  log.ok("HTTP", `Listening on http://localhost:${port}`, dev ? "(development)" : "");
});

function shutdown(): void {
  stopWatchingSecrets();
  hub.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
