// Coarse node locations from ip-api.com, the same source as the network
// atlas on parallaxprotocol.org. Only reporting nodes are looked up, never
// viewers, and only a country and coordinates rounded to whole degrees
// (about 100 km) are kept: neither the address nor the city leaves the
// server, and the city is never even asked for.
//
// The free batch endpoint takes no key, answers up to 100 addresses a
// request and allows 15 requests a minute. Lookups are queued and sent in
// batches, so a restart with every node reconnecting at once costs a few
// requests, and answers are cached so reconnects cost none.

import { isIP } from "node:net";
import type { Geo } from "../lib/protocol.ts";
import { addressList, inList } from "./settings.ts";

const ENDPOINT = "http://ip-api.com/batch?fields=status,countryCode,lat,lon,query";
const BATCH_SIZE = 100;
/** Waits for more addresses before sending, so reconnect bursts share a request. */
const GATHER_MS = 1000;
/** 15 requests a minute, with room to spare. */
const MIN_INTERVAL_MS = 4500;
const TIMEOUT_MS = 10_000;
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
/** Addresses ip-api could not place, or that failed to look up, are retried after this. */
const MISSING_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED = 10_000;

/** Addresses that are never on the public internet, so never worth a lookup. */
const UNROUTABLE = addressList([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/3",
  "::/127",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
]);

export type GeoLookup = (ip: string) => Geo | null | Promise<Geo | null>;

interface Answer {
  status?: unknown;
  query?: unknown;
  countryCode?: unknown;
  lat?: unknown;
  lon?: unknown;
}

/** coarsen keeps only a place's country and its coordinates to the nearest whole degree. */
export function coarsen(geo: Geo): Geo {
  // + 0 turns a rounded -0 into 0
  return { country: geo.country, ll: [Math.round(geo.ll[0]) + 0, Math.round(geo.ll[1]) + 0] };
}

function toGeo(answer: Answer): Geo | null {
  const { countryCode, lat, lon } = answer;

  if (answer.status !== "success" || typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  return coarsen({
    country: typeof countryCode === "string" && /^[A-Z]{2}$/.test(countryCode) ? countryCode : "",
    ll: [lat, lon],
  });
}

/**
 * createGeoLookup returns a lookup that answers from its cache right away
 * and otherwise with a promise settled once the address's batch returns.
 * It never rejects: an address it cannot place is null.
 */
export function createGeoLookup(fetcher: typeof fetch = fetch): GeoLookup {
  const cache = new Map<string, { geo: Geo | null; expires: number }>();
  const waiting = new Map<string, { promise: Promise<Geo | null>; resolve: (geo: Geo | null) => void }>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextAllowed = 0;

  function remember(ip: string, geo: Geo | null): void {
    cache.delete(ip);
    cache.set(ip, { geo, expires: Date.now() + (geo ? FOUND_TTL_MS : MISSING_TTL_MS) });

    // Oldest first: drop the entries cached longest ago
    for (const key of cache.keys()) {
      if (cache.size <= MAX_CACHED) break;
      cache.delete(key);
    }
  }

  function settle(ip: string, geo: Geo | null): void {
    remember(ip, geo);
    waiting.get(ip)?.resolve(geo);
    waiting.delete(ip);
  }

  function schedule(delay: number): void {
    if (timer) return;

    timer = setTimeout(
      () => {
        timer = null;
        void flush();
      },
      Math.max(delay, nextAllowed - Date.now()),
    );
    timer.unref?.();
  }

  async function flush(): Promise<void> {
    const batch = [...waiting.keys()].slice(0, BATCH_SIZE);

    if (batch.length === 0) return;

    nextAllowed = Date.now() + MIN_INTERVAL_MS;

    const found = new Map<string, Geo | null>();

    try {
      const res = await fetcher(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      // Out of requests for this window: X-Ttl is the seconds until it resets
      if (res.headers.get("x-rl") === "0") {
        const ttl = Number(res.headers.get("x-ttl"));

        if (Number.isFinite(ttl) && ttl > 0) nextAllowed = Date.now() + Math.min(ttl, 60) * 1000;
      }

      if (res.ok) {
        const answers = (await res.json()) as unknown;

        if (Array.isArray(answers)) {
          for (const answer of answers as Answer[]) {
            if (answer && typeof answer.query === "string" && waiting.has(answer.query)) found.set(answer.query, toGeo(answer));
          }
        }
      }
    } catch {
      // Unreachable: everything in the batch counts as not found, retried later
    }

    for (const ip of batch) settle(ip, found.get(ip) ?? null);

    if (waiting.size > 0) schedule(0);
  }

  return (ip) => {
    if (!isIP(ip) || inList(UNROUTABLE, ip)) return null;

    const cached = cache.get(ip);

    if (cached && cached.expires > Date.now()) return cached.geo;

    const pending = waiting.get(ip);

    if (pending) return pending.promise;

    let resolve!: (geo: Geo | null) => void;
    const promise = new Promise<Geo | null>((r) => (resolve = r));

    waiting.set(ip, { promise, resolve });
    schedule(GATHER_MS);

    return promise;
  };
}
