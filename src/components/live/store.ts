// Live dashboard state in the browser: a websocket to the server that
// keeps the node list and charts current, with reconnects and clock
// offset tracking. Components read it through useSyncExternalStore.

import { VIEWER_PATH, type Charts, type MiningPool, type PublicNode, type ServerMessage, type Snapshot } from "@/lib/protocol";

export type Connection = "connecting" | "live" | "offline";

export interface LiveState {
  nodes: PublicNode[];
  charts: Charts | null;
  /** Recommended gas price, wei as a decimal string. */
  gasPrice: string | null;
  /** Known mining pools by coinbase address. */
  pools: Record<string, MiningPool>;
  connection: Connection;
  /** Round trip to the server, ms; null until measured. */
  latency: number | null;
  /** serverTime ≈ Date.now() + clockOffset */
  clockOffset: number;
}

const PING_MS = 5000;
const MAX_BACKOFF_MS = 30_000;

export class LiveStore {
  private state: LiveState;
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private pingTimer: number | undefined;
  private retryTimer: number | undefined;
  private retries = 0;
  private notifyQueued = false;
  private stopped = true;

  constructor(initial: Snapshot) {
    this.state = {
      nodes: initial.nodes,
      charts: initial.charts,
      gasPrice: initial.gasPrice,
      pools: initial.pools ?? {},
      connection: "connecting",
      latency: null,
      clockOffset: 0,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  };

  getState = (): LiveState => this.state;

  start(): void {
    if (!this.stopped) return;

    this.stopped = false;
    this.connect();
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.ws?.close();
    this.ws = null;
  }

  private onVisibility = (): void => {
    // Reconnect right away when a backgrounded tab returns
    if (document.visibilityState === "visible" && this.state.connection === "offline") {
      window.clearTimeout(this.retryTimer);
      this.connect();
    }
  };

  private connect(): void {
    const url = new URL(VIEWER_PATH, window.location.href);

    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

    const ws = new WebSocket(url);

    this.ws = ws;
    this.set({ connection: "connecting" });

    ws.onopen = () => {
      this.retries = 0;
      this.ping();
      this.pingTimer = window.setInterval(() => this.ping(), PING_MS);
    };

    ws.onmessage = (event) => {
      try {
        this.apply(JSON.parse(event.data as string) as ServerMessage);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      window.clearInterval(this.pingTimer);

      if (this.ws !== ws || this.stopped) return;

      this.ws = null;
      this.set({ connection: "offline" });

      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.retries++);

      this.retryTimer = window.setTimeout(() => this.connect(), backoff * (0.75 + Math.random() * 0.5));
    };
  }

  private ping(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
  }

  private apply(msg: ServerMessage): void {
    switch (msg.type) {
      case "snapshot":
        this.set({
          nodes: msg.nodes,
          charts: msg.charts,
          gasPrice: msg.gasPrice,
          pools: msg.pools ?? {},
          connection: "live",
          clockOffset: this.state.latency === null ? msg.serverTime - Date.now() : this.state.clockOffset,
        });
        break;

      case "pong": {
        const now = Date.now();
        const latency = Math.max(0, now - msg.t);

        this.set({ latency, clockOffset: msg.serverTime + latency / 2 - now });
        break;
      }

      case "charts":
        this.set({ charts: msg.charts });
        break;

      case "fee":
        this.set({ gasPrice: msg.gasPrice });
        break;

      case "node": {
        const index = this.state.nodes.findIndex((node) => node.id === msg.node.id);
        const nodes = [...this.state.nodes];

        if (index < 0) nodes.push(msg.node);
        else nodes[index] = msg.node;

        this.set({ nodes });
        break;
      }

      case "block":
        this.update(msg.id, (node) => ({
          ...node,
          history: msg.history,
          stats: { ...node.stats, block: msg.block, propagationAvg: msg.propagationAvg },
        }));
        break;

      case "stats":
        this.update(msg.id, (node) => ({ ...node, stats: { ...node.stats, ...msg.stats } }));
        break;

      case "pending":
        this.update(msg.id, (node) => ({ ...node, stats: { ...node.stats, pending: msg.pending } }));
        break;

      case "latency":
        this.update(msg.id, (node) => ({ ...node, stats: { ...node.stats, latency: msg.latency } }));
        break;
    }
  }

  private update(id: string, change: (node: PublicNode) => PublicNode): void {
    const index = this.state.nodes.findIndex((node) => node.id === id);

    if (index < 0) return;

    const nodes = [...this.state.nodes];

    nodes[index] = change(nodes[index]);
    this.set({ nodes });
  }

  private set(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };

    // Bursts of reports render once per frame
    if (this.notifyQueued) return;

    this.notifyQueued = true;
    requestAnimationFrame(() => {
      this.notifyQueued = false;
      for (const listener of this.listeners) listener();
    });
  }
}
