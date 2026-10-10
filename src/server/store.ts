// Hands the running hub to Next.js pages and route handlers. Next.js
// bundles them separately from server.ts, so the hub is shared through
// a global rather than a module instance. This file must stay free of
// Node-only imports: pages import it.

import type { Snapshot } from "../lib/protocol.ts";

export interface SnapshotSource {
  snapshot(): Snapshot;
  readonly publicSecret: string;
}

const KEY = Symbol.for("parallax-stats.hub");

type HubGlobal = typeof globalThis & { [KEY]?: SnapshotSource };

export function publishHub(hub: SnapshotSource): void {
  (globalThis as HubGlobal)[KEY] = hub;
}

/**
 * getPublicSecret returns the secret anyone may report with, shown in the
 * page's instructions; empty when the dashboard takes only private
 * secrets. It is public by design: private secrets have no way out here.
 */
export function getPublicSecret(): string {
  return (globalThis as HubGlobal)[KEY]?.publicSecret ?? "";
}

/** getSnapshot returns the live state, or an empty one when no hub runs (e.g. `next dev` alone). */
export function getSnapshot(): Snapshot {
  return (globalThis as HubGlobal)[KEY]?.snapshot() ?? { serverTime: Date.now(), nodes: [], charts: null, gasPrice: null };
}
