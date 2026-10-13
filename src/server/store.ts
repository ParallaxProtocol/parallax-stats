// Hands the running hub to Next.js pages and route handlers. Next.js
// bundles them separately from server.ts, so the hub is shared through
// a global rather than a module instance. This file must stay free of
// Node-only imports: pages import it.

import type { Snapshot } from "../lib/protocol.ts";

export interface SnapshotSource {
  snapshot(): Snapshot;
  readonly publicNodes: boolean;
}

const KEY = Symbol.for("parallax-stats.hub");

type HubGlobal = typeof globalThis & { [KEY]?: SnapshotSource };

export function publishHub(hub: SnapshotSource): void {
  (globalThis as HubGlobal)[KEY] = hub;
}

/** getPublicNodes reports whether anyone may report without a secret, for the page's instructions. */
export function getPublicNodes(): boolean {
  return (globalThis as HubGlobal)[KEY]?.publicNodes ?? false;
}

/** getSnapshot returns the live state, or an empty one when no hub runs (e.g. `next dev` alone). */
export function getSnapshot(): Snapshot {
  return (globalThis as HubGlobal)[KEY]?.snapshot() ?? { serverTime: Date.now(), nodes: [], charts: null, gasPrice: null, pools: {}, explorer: null, price: null, markets: null, incidents: null };
}
