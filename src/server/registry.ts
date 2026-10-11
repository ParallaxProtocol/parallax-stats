// The set of known nodes and the shared block history, with the login
// rules that keep a public reporting secret from being abused.

import { randomBytes } from "node:crypto";
import type { Block, Charts, NameStatus, PublicNode } from "../lib/protocol.ts";
import { History, type HistoryRequest } from "./history.ts";
import { NodeRecord, type Login } from "./node.ts";
import { cleanId, type ReportedBlock } from "./sanitize.ts";
import type { Settings } from "./settings.ts";

/** How long to wait for a history answer before asking another node. */
const HISTORY_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

export class LoginRefused extends Error {}

export class Registry {
  private readonly settings: Settings;
  private readonly nodes = new Map<string, NodeRecord>();
  readonly history: History;
  // Pseudonyms are stable while the server runs but cannot be reversed
  // by trying candidate names.
  private readonly pseudonymKey = randomBytes(32);
  private historyRequest: { id: string; at: number } | null = null;

  constructor(settings: Settings) {
    this.settings = settings;
    this.history = new History(settings.miningPools);
  }

  get(id: string): NodeRecord | undefined {
    return this.nodes.get(id);
  }

  /**
   * add registers a node login. Untrusted logins cannot take over a name
   * that is connected, or was recently connected, from another address,
   * nor any name a trusted node holds, and are capped per address and in
   * total. It throws LoginRefused with the reason.
   */
  add(login: Login, now = Date.now()): NodeRecord {
    const s = this.settings;
    const existing = this.nodes.get(login.id);

    if (s.trustedIPs.includes(login.ip)) login = { ...login, trusted: true };

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
    const block: Block = this.history.add(reported, id, node.trusted) ?? {
      ...reported,
      arrived: now,
      received: now,
      propagation: 0,
      time: 0,
    };

    return node.setBlock(block, this.history.nodePropagation(id)) ? node : null;
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

    if (node.stats.block.number < this.history.bestBlockNumber()) return null;

    if (this.historyRequest && now - this.historyRequest.at < HISTORY_REQUEST_TIMEOUT_MS) return null;

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

  charts(): Charts {
    return this.history.charts();
  }
}
