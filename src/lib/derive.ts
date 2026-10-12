// Network-wide figures derived from the node list.

import { MAINNET_NETWORK } from "./asert.ts";
import type { NodeStats, PublicNode } from "./protocol.ts";

export interface Summary {
  bestBlock: number;
  bestStats: NodeStats | null;
  total: number;
  active: number;
  synced: number;
  /** Median of active nodes' own median peer latencies, ms; 0 when none measured. */
  peerLatency: number;
  /** Average uptime of verified nodes, connected or not, 0..100; null when there are none. */
  uptime: number | null;
  /** Median of synced nodes' pending transactions; null when none is synced. */
  pending: number | null;
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

export function summarize(nodes: PublicNode[]): Summary {
  const active = nodes.filter((node) => node.stats.active);
  // A syncing node's mempool lags the network's, so only synced ones count
  const synced = active.filter((node) => !node.stats.syncing);

  // While verified nodes are online the best block follows them only, so
  // an unverified node reporting a made-up height cannot make everyone
  // else look behind.
  const verified = active.filter((node) => node.trusted);
  const candidates = verified.length > 0 ? verified : nodes;
  let best: PublicNode | null = null;

  for (const node of candidates) if (!best || node.stats.block.number > best.stats.block.number) best = node;

  return {
    bestBlock: best?.stats.block.number ?? 0,
    bestStats: best?.stats ?? null,
    total: nodes.length,
    active: active.length,
    synced: synced.length,
    peerLatency: median(active.map((node) => node.stats.peerLatency).filter((latency) => latency > 0)),
    uptime: average(nodes.filter((node) => node.trusted).map((node) => node.stats.uptime)),
    pending: synced.length > 0 ? median(synced.map((node) => node.stats.pending)) : null,
  };
}

/**
 * onMainnet reports whether the nodes are on mainnet, going by verified
 * nodes when any are online, so unverified nodes cannot switch the
 * mainnet-only figures on or off.
 */
export function onMainnet(nodes: PublicNode[]): boolean {
  const active = nodes.filter((node) => node.stats.active);
  const verified = active.filter((node) => node.trusted);
  const pool = verified.length > 0 ? verified : active;

  return pool.length > 0 && pool.filter((node) => node.info.net === MAINNET_NETWORK).length * 2 > pool.length;
}
