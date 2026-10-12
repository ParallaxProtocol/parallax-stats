// The set of known nodes and the shared block history, with the login
// rules that keep a public reporting secret from being abused.

import { randomBytes } from "node:crypto";
import { summarize } from "../lib/derive.ts";
import { trendStarts, type Block, type Charts, type IncidentLog, type NameStatus, type PublicNode } from "../lib/protocol.ts";
import { canVerify, MIN_VERIFIED, reportsSyncing } from "../lib/version.ts";
import { History, type Head, type HistoryRequest, type HistoryState } from "./history.ts";
import { Incidents, observe, type IncidentsState } from "./incidents.ts";
import { NodeRecord, type Login, type NodeState } from "./node.ts";
import { Readings, type ReadingsState } from "./readings.ts";
import { cleanId, type ReportedBlock, type ReportedStats } from "./sanitize.ts";
import type { Settings } from "./settings.ts";

/** A node's reports start counting toward propagation once it has been connected this long. */
const PROPAGATION_WARMUP_MS = 2 * 60 * 1000;
/** A node whose flag cannot be believed counts as syncing this many blocks behind the best block. */
const SYNCING_LAG = 2;
/** How long to wait for a history answer before asking another node. */
const HISTORY_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

export class LoginRefused extends Error {}

/** What is saved of the registry across restarts. */
export interface RegistryState {
  /** The pseudonym key, hex, so unverified nodes keep their pseudonyms. */
  pseudonymKey: string;
  nodes: NodeState[];
  history: HistoryState;
  /** Missing from state saved before readings were kept. */
  readings?: ReadingsState;
  /** Missing from state saved before incidents were recorded. */
  incidents?: IncidentsState;
}

/** How long to wait for the history to fill before rebuilding past incidents from what there is. */
const REBUILD_WAIT_MS = 30 * 60_000;

export class Registry {
  private readonly settings: Settings;
  private readonly nodes = new Map<string, NodeRecord>();
  readonly history: History;
  readonly readings = new Readings();
  private readonly incidents = new Incidents();
  private readonly startedAt = Date.now();
  // Pseudonyms are stable while the server runs, and across restarts
  // when state is saved, but cannot be reversed by trying candidate names.
  private pseudonymKey = randomBytes(32);
  private historyRequest: { id: string; at: number } | null = null;
  /** Nodes whose head addBlock timed again, for the hub to send out. */
  private retimed: NodeRecord[] = [];

  constructor(settings: Settings) {
    this.settings = settings;
    this.history = new History(settings.miningPools);
  }

  toState(): RegistryState {
    return {
      pseudonymKey: this.pseudonymKey.toString("hex"),
      nodes: [...this.nodes.values()].map((node) => node.toState()),
      history: this.history.toState(),
      readings: this.readings.toState(),
      incidents: this.incidents.toState(),
    };
  }

  /**
   * restore replaces the registry with saved state. Nodes come back
   * disconnected until they report again; `downtime` is how long the
   * dashboard was down, kept out of their uptimes.
   */
  restore(state: RegistryState, downtime: number, now = Date.now()): void {
    const key = Buffer.from(state.pseudonymKey, "hex");

    if (key.length === 32) this.pseudonymKey = key;

    this.nodes.clear();
    for (const saved of state.nodes) this.nodes.set(saved.id, NodeRecord.fromState(saved, this.pseudonymKey, downtime, now));

    this.history.restore(state.history);
    this.readings.restore(state.readings);
    this.incidents.restore(state.incidents);
    this.removeOldNodes(now);
  }

  get(id: string): NodeRecord | undefined {
    return this.nodes.get(id);
  }

  /**
   * add registers a node login. Trusted logins must run MIN_VERIFIED or
   * newer. Untrusted logins cannot take over a name
   * that is connected, or was recently connected, from another address,
   * nor any name a trusted node holds, and are capped per address and in
   * total. It throws LoginRefused with the reason.
   */
  add(login: Login, now = Date.now()): NodeRecord {
    const s = this.settings;
    const existing = this.nodes.get(login.id);

    if (s.trustedIPs.includes(login.ip)) login = { ...login, trusted: true };

    if (login.trusted && !canVerify(login.info.node)) throw new LoginRefused(`Verified nodes must run ${MIN_VERIFIED.label} or newer`);

    if (existing && !login.trusted) {
      if (existing.trusted) throw new LoginRefused("Name is reserved by a trusted node");

      if (existing.ip !== login.ip) {
        if (existing.stats.active) throw new LoginRefused("Name is in use from another address");

        if (now - existing.uptime.lastUpdate < s.nameHoldMs)
          throw new LoginRefused("Name was recently used from another address");
      }
    }

    if (existing) {
      existing.login(login);
      return existing;
    }

    if (!login.trusted) {
      // Bound what one address can hold, connected or not, so cycling
      // through names cannot fill the node list. Its oldest disconnected
      // name makes room for a new one.
      const fromSameIP = [...this.nodes.values()].filter((node) => node.ip === login.ip && !node.trusted);

      if (fromSameIP.length >= s.maxNodesPerIP) {
        const stale = this.longestDisconnected(fromSameIP);

        if (!stale) throw new LoginRefused("Too many nodes from this address");

        this.nodes.delete(stale.id);
      }
    }

    this.removeOldNodes(now);

    if (this.nodes.size >= s.maxNodes) {
      if (!login.trusted) throw new LoginRefused("Node limit reached");

      // A full list must not lock out the operator's own nodes. Make room
      // by dropping the longest disconnected untrusted node, or go over
      // the cap if every untrusted node is connected: trusted nodes are
      // few and run by the operator.
      const stale = this.longestDisconnected([...this.nodes.values()].filter((node) => !node.trusted));

      if (stale) this.nodes.delete(stale.id);
    }

    const node = new NodeRecord(login, this.pseudonymKey);

    this.nodes.set(node.id, node);

    return node;
  }

  private longestDisconnected(nodes: NodeRecord[]): NodeRecord | undefined {
    return nodes
      .filter((node) => !node.stats.active)
      .sort((a, b) => a.uptime.lastUpdate - b.uptime.lastUpdate)[0];
  }

  /**
   * nameStatus tells an unverified operator at `ip` whether they could log
   * in as `name`, by the same rules as add. It answers only that, never
   * which node holds a name.
   */
  nameStatus(name: unknown, ip: string, now = Date.now()): NameStatus {
    const id = cleanId(name);

    if (id === null) return "invalid";
    if (this.settings.reservedNames.includes(id)) return "reserved";

    const existing = this.nodes.get(id);

    if (!existing || existing.isInactiveAndOld(now)) return "available";
    if (existing.trusted) return "reserved";
    if (existing.ip === ip) return "yours";
    if (existing.stats.active || now - existing.uptime.lastUpdate < this.settings.nameHoldMs) return "taken";

    return "available";
  }

  /**
   * hasTrusted reports whether a trusted node is connected. While one
   * is, only trusted nodes may introduce new block heights and answer
   * history requests.
   */
  hasTrusted(): boolean {
    for (const node of this.nodes.values()) if (node.trusted && node.stats.active) return true;

    return false;
  }

  /** addBlock records a node's new head; it returns the node when anything changed. */
  addBlock(id: string, reported: ReportedBlock): NodeRecord | null {
    const node = this.nodes.get(id);

    if (!node) return null;

    this.history.setTrustedOnly(this.hasTrusted());

    // A block missing from the shared history (genesis, or a height no
    // trusted node has reported) is still the node's own head.
    const now = Date.now();
    // Only a settled node's report measures propagation: not one syncing or just
    // (re)connected and catching up. Its one-way latency to us is taken off.
    const timing = { counted: !node.stats.syncing && now - node.connectedAt >= PROPAGATION_WARMUP_MS, latency: node.stats.latency };
    const block: Block = this.history.add(reported, id, node.trusted, false, timing) ?? {
      ...reported,
      arrived: now,
      received: now,
      propagation: 0,
      time: 0,
    };

    // Untrusted nodes that reported this block before it could be recorded now have their timing
    for (const early of this.history.takeRetimed()) {
      const other = this.nodes.get(early.id);

      // Only while it is still on that block
      if (!other || other.stats.block.number !== early.block.number || other.stats.block.hash !== early.block.hash) continue;

      // The same block as its head, so setBlock would keep the stand-in it had: replace it outright
      other.stats.block = early.block;
      other.setBlock(early.block, this.history.nodePropagation(early.id, other.connectedAt));
      this.retimed.push(other);
    }

    return node.setBlock(block, this.history.nodePropagation(id, node.connectedAt)) ? node : null;
  }

  /** takeRetimed returns, once, the other nodes the last addBlock calls gave a new head timing. */
  takeRetimed(): NodeRecord[] {
    const retimed = this.retimed;

    this.retimed = [];

    return retimed;
  }

  /**
   * setStats records a node's stats; it returns the node when anything
   * changed. A node whose syncing flag cannot be believed is syncing when its
   * head is well behind the best block, so one a block behind while a new
   * block spreads still counts as synced.
   */
  setStats(id: string, stats: ReportedStats): NodeRecord | null {
    const node = this.nodes.get(id);

    if (!node) return null;

    const syncing = reportsSyncing(node.info.node) ? stats.syncing : this.isBehind(node);

    return node.setStats({ ...stats, syncing }) ? node : null;
  }

  /**
   * updateSyncing works out again, after a block report, whether a node
   * whose flag cannot be believed is syncing, rather than waiting for its
   * next stats; it returns the node when that changed.
   */
  updateSyncing(id: string): NodeRecord | null {
    const node = this.nodes.get(id);

    if (!node || reportsSyncing(node.info.node)) return null;

    const syncing = this.isBehind(node);

    if (syncing === node.stats.syncing) return null;

    node.stats.syncing = syncing;

    return node;
  }

  /** isBehind tells whether a node's head is well behind the best block. */
  private isBehind(node: NodeRecord): boolean {
    return this.history.bestBlockNumber() - node.stats.block.number >= SYNCING_LAG;
  }

  /** addHistory fills the shared history, but only from the node it was requested from. */
  addHistory(id: string, blocks: ReportedBlock[]): boolean {
    const node = this.nodes.get(id);

    if (!node || this.historyRequest?.id !== id) return false;

    this.history.setTrustedOnly(this.hasTrusted());

    for (const block of [...blocks].reverse()) this.history.add(block, id, node.trusted, true);

    this.historyRequest = null;

    return true;
  }

  /** inactive marks the node behind a closed connection offline. */
  inactive(id: string, connection: number): NodeRecord | null {
    const node = this.nodes.get(id);

    // A newer connection may have taken over the name already
    if (!node || node.connection !== connection) return null;

    node.setState(false);

    return node;
  }

  /**
   * nextHistoryRequest returns the heights to ask node `id` for, if the
   * shared history has gaps, the node is trusted enough and at the head,
   * and no other request is outstanding. Asking is recorded.
   */
  nextHistoryRequest(id: string, now = Date.now()): HistoryRequest | null {
    const node = this.nodes.get(id);

    if (!node || (this.hasTrusted() && !node.trusted) || !node.canUpdate()) return null;

    if (this.historyRequest && now - this.historyRequest.at < HISTORY_REQUEST_TIMEOUT_MS) return null;

    // A node that just switched chains is asked for its new chain first
    const reorg = this.history.takeReorgRequest(id);

    if (reorg) {
      this.historyRequest = { id, at: now };
      return reorg;
    }

    if (node.stats.block.number < this.history.bestBlockNumber()) return null;

    if (!this.history.requiresUpdate()) return null;

    const request = this.history.historyRequest();

    if (request) this.historyRequest = { id, at: now };

    return request;
  }

  /** askedForHistory records an outstanding request, for tests and callers that ask directly. */
  askedForHistory(id: string, now = Date.now()): void {
    this.historyRequest = { id, at: now };
  }

  /** removeOldNodes forgets nodes disconnected for long and returns how many. */
  removeOldNodes(now = Date.now()): number {
    let removed = 0;

    for (const [id, node] of this.nodes) {
      if (node.isInactiveAndOld(now)) {
        this.nodes.delete(id);
        removed++;
      }
    }

    return removed;
  }

  /** all returns the public view of every node, as sent to viewers. */
  all(): PublicNode[] {
    this.removeOldNodes();

    return [...this.nodes.values()].map((node) => node.toPublic());
  }

  /** recordReading adds a reading of the node list's figures, the recommended fee and the LAX price, to the trends. */
  recordReading(gasPrice: string | null, now = Date.now(), usd: number | null = null): void {
    this.readings.record(summarize(this.all()), gasPrice, now, usd);
  }

  /**
   * checkIncidents records what is going wrong at `now`, and reports whether
   * the incident log changed. Past incidents are first rebuilt from saved
   * blocks, once the history has filled.
   */
  checkIncidents(now = Date.now()): boolean {
    let changed = false;

    if (this.incidents.needsRebuild) {
      // Full, or with nothing left to ask for: a full history always lacks the height just past its oldest
      const filled = this.history.length > 1 && (!this.history.requiresUpdate() || this.history.historyRequest() === null);

      if (!filled && now - this.startedAt < REBUILD_WAIT_MS) return false;

      this.incidents.rebuild(this.history.timeline(), this.settings.miningPools);
      changed = true;
    }

    // Charts first: working them out measures reorganizations again
    const charts = this.charts(now);
    const nodes = this.all();
    const summary = summarize(nodes);
    const foundAt = (summary.bestStats?.block.timestamp ?? 0) * 1000;

    changed = this.incidents.reorgs(this.history.deepReorgs(), now) || changed;

    return this.incidents.update(observe(charts, foundAt, summary.bestBlock, now), now) || changed;
  }

  incidentLog(): IncidentLog {
    return this.incidents.log();
  }

  charts(now = Date.now()): Charts {
    const start = trendStarts(now);

    return {
      ...this.history.charts(this.verifiedHeads()),
      trends: { start, ...this.history.blockTrends(start), ...this.readings.series(start) },
    };
  }

  /**
   * verifiedHeads are the heads of connected, synced verified nodes near the
   * front, so a node still catching up does not look like another chain.
   */
  private verifiedHeads(): Head[] {
    const nodes = [...this.nodes.values()].filter((node) => node.trusted && node.stats.active && !node.stats.syncing && node.stats.block.number > 0);
    const front = Math.max(0, ...nodes.map((node) => node.stats.block.number));

    return nodes.filter((node) => front - node.stats.block.number <= 6).map((node) => ({ number: node.stats.block.number, hash: node.stats.block.hash }));
  }
}
