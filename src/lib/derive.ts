// Network-wide figures derived from the node list.

import type { NodeStats, PublicNode } from "./protocol.ts";

export interface Summary {
  bestBlock: number;
  bestStats: NodeStats | null;
  total: number;
  active: number;
  synced: number;
  /** Median of active nodes' own median peer latencies, ms; 0 when none measured. */
  peerLatency: number;
  uptime: number;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

export function summarize(nodes: PublicNode[]): Summary {
  const active = nodes.filter((node) => node.stats.active);

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
    synced: active.filter((node) => !node.stats.syncing).length,
    peerLatency: median(active.map((node) => node.stats.peerLatency).filter((latency) => latency > 0)),
    uptime: nodes.length > 0 ? nodes.reduce((sum, node) => sum + node.stats.uptime, 0) / nodes.length : 0,
  };
}
