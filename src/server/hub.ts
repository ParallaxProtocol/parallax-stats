// Websocket endpoints. Nodes report on /api with the Primus-framed JSON
// protocol parallaxd speaks ({"emit": [event, data]}); browsers watch on
// /live and receive typed ServerMessages.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  NAME_CHECK_PATH,
  STATS_PATHS,
  REPORTER_PATH,
  VIEWER_PATH,
  type Charts,
  type ClientMessage,
  type Geo,
  type Market,
  type Price,
  type ServerMessage,
  type Snapshot,
} from "../lib/protocol.ts";
import { authenticate, clientIP, RateLimiter, TokenBucket, WRONG_NAME } from "./guard.ts";
import { log } from "./log.ts";
import type { MarketPoint } from "./price.ts";
import { STATE_VERSION, type Store } from "./persist.ts";
import { LoginRefused, Registry } from "./registry.ts";
import { cleanBlock, cleanHistory, cleanId, cleanInfo, cleanLatency, cleanPending, cleanStats } from "./sanitize.ts";
import { inList, type Settings } from "./settings.ts";

const HEARTBEAT_MS = 30_000;
const CHARTS_DEBOUNCE_MS = 1000;
const CHARTS_MAX_WAIT_MS = 5000;
const CLEANUP_MS = 5 * 60 * 1000;
const VIEWER_MAX_PAYLOAD = 1024;
const GAS_PRICE_POLL_MS = 60_000;
/** How often incidents are checked for, and how long after starting: restored nodes are offline until they report again. */
const INCIDENT_CHECK_MS = 60_000;
const INCIDENT_GRACE_MS = 2 * 60_000;
/** CoinGecko refreshes its prices every minute or so; every 5 minutes is plenty, and far inside its free limit. */
const PRICE_POLL_MS = 5 * 60_000;
/** Where LAX trades changes slowly, and the call weighs more against the free limit. */
const MARKETS_POLL_MS = 15 * 60_000;
/** A failed read of the markets or the history is tried again this soon, then twice as long each time, up to MARKETS_POLL_MS. */
const MARKETS_RETRY_MS = 60_000;
/** How often the node list's figures are read for the trends. */
const READING_MS = 5 * 60 * 1000;

/** Name lookups per address per minute: enough to type a name, too few to enumerate them. */
const NAME_CHECKS_PER_MINUTE = 20;
/** How often state is saved, when a store is configured. */
const SAVE_INTERVAL_MS = 30_000;
/** Viewers that fall this far behind are dropped rather than buffered. */
const VIEWER_MAX_BUFFERED = 4 * 1024 * 1024;

export interface HubOptions {
  /** Locates a node's address, from a cache right away or later through a promise. */
  lookupGeo?: (ip: string) => Geo | null | Promise<Geo | null>;
  /** Reads the recommended gas price, in wei; polled every GAS_PRICE_POLL_MS. */
  fetchGasPrice?: () => Promise<bigint | null>;
  /** Reads the LAX price; polled every PRICE_POLL_MS. */
  fetchPrice?: () => Promise<Price | null>;
  /** Reads where LAX trades; polled every MARKETS_POLL_MS. */
  fetchMarkets?: () => Promise<Market[] | null>;
  /** Reads the last week's LAX price and volume, to fill the trends; read at startup, and again with the markets until it succeeds. */
  fetchHistory?: () => Promise<MarketPoint[] | null>;
  /** Where state is saved across restarts; without one it lives in memory only. */
  store?: Store;
}

export interface Hub {
  /** handleRequest answers the name check and returns false for anything else. */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean;
  /** handleUpgrade takes websocket upgrades for the stats paths and returns false for anything else. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  snapshot(): Snapshot;
  /** Whether anyone may report without a secret, for the page's instructions. Secrets never leave the hub. */
  readonly publicNodes: boolean;
  /** recheckSecrets disconnects verified nodes whose private secret no longer verifies them, after the secrets change. */
  recheckSecrets(): void;
  close(): void;
}

type Socket = WebSocket & { alive?: boolean };

function parse(raw: RawData): unknown {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return undefined;
  }
}

/** refuse answers an upgrade request with a plain HTTP error. */
function refuse(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createHub(settings: Settings, options: HubOptions = {}): Hub {
  const lookupGeo = options.lookupGeo ?? (() => null);
  const registry = new Registry(settings);
  const pools = Object.fromEntries(settings.miningPools);
  const store = options.store ?? null;

  // Pick up where the last run left off
  if (store) {
    const saved = store.load();

    if (saved) {
      const now = Date.now();

      registry.restore(saved.registry, Math.max(0, now - saved.savedAt), now);
      log.ok("DATA", `Restored ${registry.all().length} nodes and ${registry.history.length} blocks saved ${Math.round((now - saved.savedAt) / 1000)} s ago`);
    }
  }

  function save(): void {
    if (!store) return;

    try {
      store.save({ version: STATE_VERSION, savedAt: Date.now(), registry: registry.toState() });
    } catch (err) {
      log.error("DATA", "Could not save state:", (err as Error).message);
    }
  }

  const saving = store ? setInterval(save, SAVE_INTERVAL_MS) : null;
  const reporters = new WebSocketServer({ noServer: true, maxPayload: settings.maxMessageBytes });
  const viewers = new WebSocketServer({ noServer: true, maxPayload: VIEWER_MAX_PAYLOAD });
  const connectionLimiter = new RateLimiter(settings.connPerMinute);
  const nameCheckLimiter = new RateLimiter(NAME_CHECKS_PER_MINUTE);
  const apiLimiter = new RateLimiter(settings.apiPerMinute);
  const viewersPerIP = new Map<string, number>();
  // Connected nodes verified by a private secret, kept to re-check when the secrets change
  const verifiedLogins = new Map<number, { ws: Socket; id: string; secret: string }>();
  let connections = 0;

  // Viewers

  function broadcast(message: ServerMessage): void {
    if (viewers.clients.size === 0) return;

    const data = JSON.stringify(message);

    for (const client of viewers.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;

      if (client.bufferedAmount > VIEWER_MAX_BUFFERED) client.terminate();
      else client.send(data);
    }
  }

  let charts: Charts | null = null;
  let chartsTimer: NodeJS.Timeout | null = null;
  let chartsFirstScheduled = 0;

  function publishCharts(): void {
    chartsTimer = null;
    chartsFirstScheduled = 0;
    charts = registry.charts();
    broadcast({ type: "charts", charts });
  }

  /** scheduleCharts recomputes the charts once reports settle, at least every CHARTS_MAX_WAIT_MS. */
  function scheduleCharts(): void {
    const now = Date.now();

    if (chartsFirstScheduled === 0) chartsFirstScheduled = now;
    if (chartsTimer) clearTimeout(chartsTimer);

    const wait = Math.min(CHARTS_DEBOUNCE_MS, Math.max(0, chartsFirstScheduled + CHARTS_MAX_WAIT_MS - now));

    chartsTimer = setTimeout(publishCharts, wait);
  }

  function snapshot(): Snapshot {
    return {
      serverTime: Date.now(),
      nodes: registry.all(),
      charts: charts ?? registry.charts(),
      gasPrice,
      pools,
      explorer: settings.explorerUrl,
      price,
      markets,
      incidents: registry.incidentLog(),
    };
  }

  // The recommended fee, read from RPC and pushed to viewers when it changes.
  // A failed read keeps the last known price rather than blanking it.
  let gasPrice: string | null = null;

  async function pollGasPrice(): Promise<void> {
    const price = await options.fetchGasPrice?.();

    if (price === undefined || price === null || price.toString() === gasPrice) return;

    gasPrice = price.toString();
    broadcast({ type: "fee", gasPrice });
  }

  void pollGasPrice();
  const gasPricePoll = options.fetchGasPrice ? setInterval(() => void pollGasPrice(), GAS_PRICE_POLL_MS) : null;

  // The LAX price, the same way. A failed read keeps the last known one
  let price: Price | null = null;

  async function pollPrice(): Promise<void> {
    const next = await options.fetchPrice?.();

    if (!next || (next.usd === price?.usd && next.at === price.at)) return;

    price = next;
    broadcast({ type: "price", price });
  }

  const firstPrice = pollPrice();
  const pricePoll = options.fetchPrice ? setInterval(() => void pollPrice(), PRICE_POLL_MS) : null;

  // Where LAX trades, and once the week's price and volume where the dashboard took no readings
  // of its own: before it read them, or while it was down. One call to CoinGecko at a time, after
  // the price: its free API refuses an address that calls too often. A failed read is tried again
  // within a minute rather than at the next poll
  let markets: Market[] | null = null;
  let historyFilled = !options.fetchHistory;
  let marketsTimer: ReturnType<typeof setTimeout> | undefined;
  let marketsRetry = MARKETS_RETRY_MS;
  let closed = false;

  async function pollMarkets(): Promise<void> {
    const next = (await options.fetchMarkets?.()) ?? null;

    if (next && JSON.stringify(next) !== JSON.stringify(markets)) {
      markets = next;
      broadcast({ type: "markets", markets });
    }

    if (!historyFilled) {
      const points = await options.fetchHistory?.();

      if (points) {
        historyFilled = true;
        registry.backfillMarket(points);
        scheduleCharts();
      }
    }

    const failed = (options.fetchMarkets && !next) || !historyFilled;
    const wait = failed ? marketsRetry : MARKETS_POLL_MS;

    marketsRetry = failed ? Math.min(marketsRetry * 2, MARKETS_POLL_MS) : MARKETS_RETRY_MS;

    if (!closed && (options.fetchMarkets || !historyFilled)) marketsTimer = setTimeout(() => void pollMarkets(), wait);
  }

  if (options.fetchMarkets || options.fetchHistory) void firstPrice.then(pollMarkets);
  // Not at startup: restored nodes are offline until they report again, which would read as an outage
  const reading = setInterval(() => {
    registry.recordReading(gasPrice, Date.now(), price?.usd ?? null, price?.volume24h ?? null);
    // The readings' trends would otherwise wait for the next block to reach viewers
    scheduleCharts();
  }, READING_MS);

  // What is going wrong, recorded as incidents for the timeline
  const hubStarted = Date.now();
  const incidentCheck = setInterval(() => {
    if (Date.now() - hubStarted >= INCIDENT_GRACE_MS && registry.checkIncidents()) {
      broadcast({ type: "incidents", incidents: registry.incidentLog() });
    }
  }, INCIDENT_CHECK_MS);

  viewers.on("connection", (ws: Socket, req: IncomingMessage) => {
    const ip = clientIP(settings, req);
    const bucket = new TokenBucket(2, 10);

    viewersPerIP.set(ip, (viewersPerIP.get(ip) ?? 0) + 1);
    ws.alive = true;
    ws.on("pong", () => (ws.alive = true));
    ws.on("close", () => {
      const count = (viewersPerIP.get(ip) ?? 1) - 1;

      if (count <= 0) viewersPerIP.delete(ip);
      else viewersPerIP.set(ip, count);
    });

    ws.on("message", (raw) => {
      if (!bucket.take()) return ws.close(1008, "Too many messages");

      const msg = parse(raw) as ClientMessage | undefined;

      if (msg?.type === "ping" && Number.isFinite(msg.t)) {
        ws.send(JSON.stringify({ type: "pong", t: msg.t, serverTime: Date.now() } satisfies ServerMessage));
      }
    });

    ws.send(JSON.stringify({ type: "snapshot", ...snapshot() } satisfies ServerMessage));
  });

  // Reporters

  reporters.on("connection", (ws: Socket, req: IncomingMessage) => {
    const ip = clientIP(settings, req);
    const connection = ++connections;
    const bucket = new TokenBucket(settings.msgPerSecond, settings.msgBurst);
    // The node this connection logged in as. Every report is attributed
    // to it, whatever id the message itself claims.
    let nodeId: string | null = null;

    log.info("API", "Open:", ip);

    function emit(event: string, data?: unknown): void {
      ws.send(JSON.stringify({ emit: data === undefined ? [event] : [event, data] }));
    }

    /** askForHistory asks this connection's node for missing blocks, when it is the one to ask. */
    function askForHistory(): void {
      const request = nodeId ? registry.nextHistoryRequest(nodeId) : null;

      if (!request) return;

      emit("history", request);
      log.info("HIS", "Asked:", nodeId, "for history:", request.min, "-", request.max);
    }

    ws.alive = true;
    ws.on("pong", () => (ws.alive = true));

    ws.on("message", (raw) => {
      const msg = parse(raw);

      // Primus heartbeats, from reporters that still send them
      if (typeof msg === "string") {
        if (msg.startsWith("primus::ping::")) ws.send(JSON.stringify(msg.replace("ping", "pong")));
        return;
      }

      if (!bucket.take()) {
        log.warn("API", "Message rate exceeded, closing:", nodeId ?? ip);
        return ws.close(1008, "Too many messages");
      }

      const frame = (msg as { emit?: unknown } | undefined)?.emit;

      if (!Array.isArray(frame) || typeof frame[0] !== "string") return;

      const event = frame[0];
      const data = (frame[1] ?? {}) as Record<string, unknown>;

      if (event === "hello") return hello(data);

      if (nodeId !== null) report(nodeId, event, data);
    });

    function hello(data: Record<string, unknown>): void {
      if (nodeId !== null) return;

      const id = cleanId(data.id);
      const level = authenticate(settings, data.secret, id ?? "");
      const info = cleanInfo(data.info);

      if (level === WRONG_NAME) {
        log.warn("API", "Login refused:", id, "is not a name its private secret may verify, from", ip);
        return ws.close(1008, "Name not allowed for this secret");
      }

      if (level === null || id === null || info === null || settings.reservedNames.includes(id)) {
        log.warn("API", "Wrong secret or invalid login from", ip);
        return ws.close(1008, "Unauthorized");
      }

      try {
        const located = lookupGeo(ip);
        // While a lookup is out, a node reconnecting from the same address keeps its place
        const previous = registry.get(id);
        const node = registry.add({
          id,
          info,
          ip,
          connection,
          latency: 0,
          trusted: level === "trusted",
          geo: located instanceof Promise ? (previous?.ip === ip ? previous.geo : null) : located,
        });

        // Listed now, placed on the map once the lookup answers
        if (located instanceof Promise) {
          void located.then((geo) => {
            const current = registry.get(id);

            if (geo && current && current.connection === connection && current.setGeo(geo)) {
              broadcast({ type: "node", node: current.toPublic() });
            }
          });
        }

        nodeId = id;
        if (level === "trusted" && typeof data.secret === "string") verifiedLogins.set(connection, { ws, id, secret: data.secret });
        emit("ready");
        log.ok("API", "Connected:", id, node.trusted ? "(verified)" : "");
        broadcast({ type: "node", node: node.toPublic() });
      } catch (err) {
        if (!(err instanceof LoginRefused)) throw err;

        log.warn("API", "Login refused:", id, ip, err.message);
        ws.close(1008, err.message);
      }
    }

    function report(id: string, event: string, data: Record<string, unknown>): void {
      const node = registry.get(id);

      if (!node) return;

      switch (event) {
        case "block": {
          const block = cleanBlock(data.block);

          if (block === null) return log.warn("API", "Invalid block from:", id);

          if (registry.addBlock(id, block)) {
            const { stats, history } = node;

            broadcast({ type: "block", id: node.viewId, block: stats.block, propagationAvg: stats.propagationAvg, history });
            log.ok("BLK", "Block:", block.number, "from:", id);
          }

          // Public nodes that had this block first, timed now that a verified node reported it
          for (const other of registry.takeRetimed()) {
            broadcast({ type: "block", id: other.viewId, block: other.stats.block, propagationAvg: other.stats.propagationAvg, history: other.history });
          }

          if (registry.updateSyncing(id)) broadcast({ type: "stats", id: node.viewId, stats: node.basicStats() });

          scheduleCharts();
          break;
        }

        case "pending": {
          const pending = cleanPending(data.stats);

          if (pending !== null && node.setPending(pending)) broadcast({ type: "pending", id: node.viewId, pending });
          break;
        }

        case "stats": {
          const stats = cleanStats(data.stats);

          if (stats === null) return log.warn("API", "Invalid stats from:", id);

          if (registry.setStats(id, stats)) broadcast({ type: "stats", id: node.viewId, stats: node.basicStats() });
          break;
        }

        case "history": {
          const blocks = cleanHistory(data.history);
          const before = registry.history.length;

          if (blocks !== null && registry.addHistory(id, blocks)) {
            log.ok("HIS", "Got history from:", id);
            scheduleCharts();

            // Ask for the next batch at once rather than at the node's next latency report, so a
            // restart refills in seconds. Only after a batch that filled something: a node that
            // cannot fill a gap waits for its next report, rather than being asked again and again
            if (registry.history.length > before) askForHistory();
          }
          break;
        }

        case "node-ping":
          emit("node-pong", {
            clientTime: typeof data.clientTime === "string" ? data.clientTime.slice(0, 64) : null,
            serverTime: Date.now(),
          });
          break;

        case "latency": {
          const latency = cleanLatency(data.latency);

          if (node.setLatency(latency)) broadcast({ type: "latency", id: node.viewId, latency });

          askForHistory();
          break;
        }
      }
    }

    ws.on("close", () => {
      verifiedLogins.delete(connection);

      if (nodeId === null) return;

      const node = registry.inactive(nodeId, connection);

      if (node) broadcast({ type: "node", node: node.toPublic() });

      log.warn("API", "Connection ended:", nodeId);
    });
  });

  // Housekeeping

  const heartbeat = setInterval(() => {
    for (const ws of [...reporters.clients, ...viewers.clients] as Socket[]) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }

      ws.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  const prune = setInterval(() => {
    connectionLimiter.prune();
    nameCheckLimiter.prune();
    apiLimiter.prune();
  }, 60_000);

  const cleanup = setInterval(() => {
    if (registry.removeOldNodes() > 0) broadcast({ type: "snapshot", ...snapshot() });
  }, CLEANUP_MS);

  return {
    handleRequest(req, res) {
      const url = new URL(req.url ?? "/", "http://localhost");

      const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
        res.end(JSON.stringify(body));
      };

      // The stats endpoints are answered by Next.js, which cannot see the
      // client's address: limit them here, by the same address as everything else
      if (STATS_PATHS.includes(url.pathname)) {
        const ip = clientIP(settings, req);
        const cors = { "Access-Control-Allow-Origin": "*" };

        if (inList(settings.bannedIPs, ip)) {
          reply(403, { error: "Forbidden" }, cors);
          return true;
        }

        if (!apiLimiter.allow(ip)) {
          reply(429, { error: `Too many requests: at most ${settings.apiPerMinute} a minute per address` }, { ...cors, "Retry-After": "60" });
          return true;
        }

        return false;
      }

      if (url.pathname !== NAME_CHECK_PATH) return false;

      if (req.method !== "GET") {
        reply(405, { error: "Method not allowed" });
        return true;
      }

      const ip = clientIP(settings, req);

      if (!nameCheckLimiter.allow(ip)) {
        reply(429, { error: "Too many name checks, try again in a minute" });
        return true;
      }

      reply(200, { status: registry.nameStatus(url.searchParams.get("name"), ip) });
      return true;
    },

    handleUpgrade(req, socket, head) {
      const { pathname } = new URL(req.url ?? "/", "http://localhost");

      if (pathname === REPORTER_PATH) {
        const ip = clientIP(settings, req);

        if (inList(settings.bannedIPs, ip) || !connectionLimiter.allow(ip)) {
          log.warn("API", "Refused:", ip);
          refuse(socket, "429 Too Many Requests");
          return true;
        }

        reporters.handleUpgrade(req, socket, head, (ws) => reporters.emit("connection", ws, req));
        return true;
      }

      if (pathname === VIEWER_PATH) {
        const ip = clientIP(settings, req);
        if ((viewersPerIP.get(ip) ?? 0) >= settings.maxViewersPerIP) {
          refuse(socket, "429 Too Many Requests");
          return true;
        }

        viewers.handleUpgrade(req, socket, head, (ws) => viewers.emit("connection", ws, req));
        return true;
      }

      return false;
    },

    snapshot,

    publicNodes: settings.publicNodes,

    recheckSecrets() {
      for (const [connection, login] of verifiedLogins) {
        if (authenticate(settings, login.secret, login.id) === "trusted") continue;

        log.warn("API", "Secret revoked: disconnecting", login.id);
        verifiedLogins.delete(connection);
        login.ws.close(1008, "Secret revoked");
      }
    },

    close() {
      // Save before dropping connections, so connected nodes are saved as up
      save();
      if (saving) clearInterval(saving);
      store?.close();

      if (gasPricePoll) clearInterval(gasPricePoll);
      if (pricePoll) clearInterval(pricePoll);
      closed = true;
      clearTimeout(marketsTimer);
      clearInterval(incidentCheck);
      clearInterval(reading);
      clearInterval(heartbeat);
      clearInterval(prune);
      clearInterval(cleanup);
      if (chartsTimer) clearTimeout(chartsTimer);

      for (const ws of [...reporters.clients, ...viewers.clients]) ws.terminate();

      reporters.close();
      viewers.close();
    },
  };
}
