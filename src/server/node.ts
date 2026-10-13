// One reporting node as the server tracks it, including what viewers
// must never see: its address and, unless verified, its real name.

import { createHmac } from "node:crypto";
import { HISTORY_BINS, type BasicStats, type Block, type Geo, type NodeInfo, type NodeStats, type PublicNode } from "../lib/protocol.ts";
import type { ReportedStats } from "./sanitize.ts";

/** Disconnected nodes are forgotten after this long. */
export const MAX_INACTIVE_MS = 4 * 60 * 60 * 1000;
/** After a restart, nodes this quick to reconnect lose no uptime for the wait. */
export const RECONNECT_GRACE_MS = 2 * 60 * 1000;

const EMPTY_BLOCK: Block = {
  number: 0,
  hash: "0x" + "0".repeat(64),
  parentHash: "0x" + "0".repeat(64),
  timestamp: 0,
  miner: "0x" + "0".repeat(40),
  gasUsed: 0,
  gasLimit: 0,
  difficulty: "0",
  totalDifficulty: "0",
  transactionsRoot: "",
  stateRoot: "",
  sha3Uncles: "",
  txCount: 0,
  uncleCount: 0,
  fees: null,
  arrived: 0,
  received: 0,
  propagation: 0,
  time: 0,
};

export interface Login {
  id: string;
  info: NodeInfo;
  ip: string;
  /** Identifies the connection, so a stale socket closing cannot mark a reconnected node offline. */
  connection: number;
  latency: number;
  trusted: boolean;
  geo: Geo | null;
}

/** What is saved of a node across restarts. */
export interface NodeState {
  id: string;
  trusted: boolean;
  ip: string;
  info: NodeInfo;
  geo: Geo | null;
  stats: NodeStats;
  history: number[];
  uptime: NodeRecord["uptime"];
  /** Missing from state saved before it was kept. */
  offlineSince?: number | null;
}

export class NodeRecord {
  readonly id: string;
  readonly publicId: string;
  trusted = false;
  /** Server-side only, never sent to viewers. */
  ip = "";
  connection = 0;
  info!: NodeInfo;
  geo: Geo | null = null;
  stats: NodeStats = {
    active: false,
    mining: false,
    syncing: false,
    hashrate: 0,
    peers: 0,
    pending: 0,
    gasPrice: 0,
    block: EMPTY_BLOCK,
    propagationAvg: 0,
    latency: 0,
    peerLatency: 0,
    uptime: 100,
  };
  history = new Array<number>(HISTORY_BINS).fill(-1);
  /** Connection time accounting behind the uptime figure. */
  uptime = { started: 0, up: 0, down: 0, lastStatus: false, lastUpdate: 0 };
  /** When the current connection logged in: a node's first blocks after (re)connecting are catch-up, not propagation. */
  connectedAt = 0;
  /** When the node was last known connected; null while it is. */
  offlineSince: number | null = null;
  /** Until when a restored node may reconnect without the wait counting as downtime. */
  private graceUntil = 0;

  constructor(login: Login, pseudonymKey: Buffer) {
    this.id = login.id;
    // Only verified nodes are shown under the name they chose; everyone
    // else appears under a pseudonym derived with a per-process key, so
    // the public table cannot carry arbitrary text or impersonate known
    // operators, and pseudonyms cannot be reversed by trying names.
    this.publicId = "node-" + createHmac("sha256", pseudonymKey).update(login.id).digest("hex").slice(0, 8);
    this.stats.latency = login.latency;
    this.login(login);
  }

  toState(): NodeState {
    const { id, trusted, ip, info, geo, stats, history, uptime, offlineSince } = this;

    return { id, trusted, ip, info, geo, stats, history, uptime, offlineSince };
  }

  /**
   * fromState restores a saved node as disconnected. `downtime` is how long
   * the dashboard itself was down: it is left out of the node's uptime,
   * since the node may well have been running.
   */
  static fromState(state: NodeState, pseudonymKey: Buffer, downtime: number, now = Date.now()): NodeRecord {
    const node = new NodeRecord(
      { id: state.id, info: state.info, ip: state.ip, connection: 0, latency: state.stats.latency, trusted: state.trusted, geo: state.geo },
      pseudonymKey,
    );

    node.stats = { ...state.stats };
    node.history = [...state.history];
    node.uptime = { ...state.uptime };

    if (node.uptime.started !== 0) {
      node.uptime.started += downtime;
      node.uptime.lastUpdate += downtime;
    }

    node.setState(false, Math.max(now, node.uptime.lastUpdate));
    node.graceUntil = now + RECONNECT_GRACE_MS;
    // One connected when the dashboard stopped was last known connected then
    node.offlineSince = state.offlineSince ?? now - downtime;

    return node;
  }

  /** viewId is the id viewers see. */
  get viewId(): string {
    return this.trusted ? this.id : this.publicId;
  }

  /** setGeo places the node and returns whether that changed anything. */
  setGeo(geo: Geo): boolean {
    if (JSON.stringify(geo) === JSON.stringify(this.geo)) return false;

    this.geo = geo;
    return true;
  }

  login(login: Login, now = Date.now()): void {
    this.connectedAt = now;
    this.info = login.info;
    this.ip = login.ip;
    this.geo = login.geo;
    this.trusted = login.trusted;
    this.connection = login.connection;
    this.setState(true);
  }

  toPublic(): PublicNode {
    return {
      id: this.viewId,
      trusted: this.trusted,
      info: { ...this.info, name: this.viewId },
      stats: { ...this.stats },
      history: this.history,
      geo: this.geo,
      offlineSince: this.offlineSince,
    };
  }

  basicStats(): BasicStats {
    const { active, mining, syncing, hashrate, peers, gasPrice, uptime, latency, peerLatency } = this.stats;

    return { active, mining, syncing, hashrate, peers, gasPrice, uptime, latency, peerLatency };
  }

  /** setBlock records a new head and propagation history; false when nothing changed. */
  setBlock(block: Block, history: number[]): boolean {
    const sameHistory = history.every((value, i) => value === this.history[i]);
    // The same head can come back with new timing: reported again after reconnecting, or restored from a save
    const sameBlock =
      block.number === this.stats.block.number && block.hash === this.stats.block.hash && block.propagation === this.stats.block.propagation;

    if (sameHistory && sameBlock) return false;

    if (!sameBlock) this.stats.block = block;

    if (!sameHistory) {
      this.history = history;

      const positives = history.filter((p) => p >= 0);

      this.stats.propagationAvg =
        positives.length > 0 ? Math.round(positives.reduce((a, b) => a + b, 0) / positives.length) : 0;
    }

    return true;
  }

  /** setStats records reported stats; false when nothing changed. */
  setStats(stats: ReportedStats): boolean {
    const s = this.stats;

    if (
      s.active === stats.active &&
      s.mining === stats.mining &&
      s.syncing === stats.syncing &&
      s.hashrate === stats.hashrate &&
      s.peers === stats.peers &&
      s.gasPrice === stats.gasPrice &&
      s.peerLatency === stats.peerLatency
    ) {
      return false;
    }

    s.mining = stats.mining;
    s.syncing = stats.syncing;
    s.hashrate = stats.hashrate;
    s.peers = stats.peers;
    s.gasPrice = stats.gasPrice;
    s.peerLatency = stats.peerLatency;
    // Uptime is measured here from connection state; the value nodes
    // report is a hardcoded placeholder.
    this.setState(true);

    return true;
  }

  setPending(pending: number): boolean {
    if (pending === this.stats.pending) return false;

    this.stats.pending = pending;

    return true;
  }

  setLatency(latency: number): boolean {
    if (latency === this.stats.latency) return false;

    this.stats.latency = latency;

    return true;
  }

  setState(active: boolean, now = Date.now()): void {
    const u = this.uptime;

    if (u.started === 0) {
      u.started = now;
    } else if (!u.lastStatus && now <= this.graceUntil) {
      // Reconnecting after the dashboard restarted: the wait was ours, not the node's
      u.started += now - u.lastUpdate;
    } else if (u.lastStatus) {
      u.up += now - u.lastUpdate;
    } else {
      u.down += now - u.lastUpdate;
    }

    this.graceUntil = 0;
    if (active) this.offlineSince = null;
    else this.offlineSince ??= now;
    this.stats.active = active;
    u.lastStatus = active;
    u.lastUpdate = now;
    this.stats.uptime = u.lastUpdate === u.started ? 100 : Math.round((u.up / (u.lastUpdate - u.started)) * 100);
  }

  /** canUpdate reports whether the node may be asked to fill the shared history. */
  canUpdate(): boolean {
    return this.trusted || this.info.canUpdateHistory || (!this.stats.syncing && this.stats.peers > 0);
  }

  isInactiveAndOld(now = Date.now()): boolean {
    // From when it went offline, which a restart keeps, not its last update, which a restart moves
    return this.offlineSince !== null && now - this.offlineSince > MAX_INACTIVE_MS;
  }
}
