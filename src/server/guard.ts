// Guards for a dashboard whose reporting secret is public: login
// authentication, client address resolution and rate limiting. Nodes
// are untrusted input unless they log in with a private secret.

import { createHash, timingSafeEqual } from "node:crypto";
import { isIP, isIPv4 } from "node:net";
import type { IncomingMessage } from "node:http";
import { inList, splitList, type Settings } from "./settings.ts";

export type TrustLevel = "trusted" | "public";

/** A private secret logging in under a name it may not verify. */
export const WRONG_NAME = "wrong-name";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * authenticate maps a login secret and the node name it reports to a trust
 * level, WRONG_NAME when a private secret may not verify that name, or null.
 * Secrets are compared in constant time, as digests so lengths do not leak
 * either, and every private secret is checked so the match position does not.
 */
export function authenticate(settings: Settings, secret: unknown, name = ""): TrustLevel | typeof WRONG_NAME | null {
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 1024) return null;

  const given = digest(secret);
  let matched: Settings["privateSecrets"][number] | null = null;

  for (const candidate of settings.privateSecrets) {
    if (timingSafeEqual(given, digest(candidate.secret))) matched ??= candidate;
  }

  // The same secret may be listed for several patterns: any of them allowing the name will do
  if (matched) {
    const allowed = settings.privateSecrets.some((c) => c.secret === matched.secret && (c.names === null || c.names.test(name)));

    return allowed ? "trusted" : WRONG_NAME;
  }

  if (settings.publicSecret.length > 0 && timingSafeEqual(given, digest(settings.publicSecret))) return "public";

  return null;
}

export function normalizeIP(ip: string | undefined): string {
  const value = String(ip ?? "");

  if (value.startsWith("::ffff:") && isIPv4(value.slice(7))) return value.slice(7);

  return value;
}

type Request = Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string } };

/**
 * clientIP returns the address a request came from. Forwarding headers
 * are honored only when the socket peer is a configured proxy, and then
 * the right-most address not belonging to a proxy wins, since anything
 * left of it was supplied by the client.
 *
 * Behind Cloudflare that address is a Cloudflare edge, and the visitor is
 * in CF-Connecting-IP, which Cloudflare sets itself. The header is read
 * only when the request really arrived from an edge, so a client reaching
 * the server directly cannot choose its address with it.
 */
export function clientIP(settings: Settings, req: Request): string {
  const ip = forwardedIP(settings, req);

  if (settings.cloudflare && inList(settings.cloudflare, ip)) {
    const header = req.headers["cf-connecting-ip"];
    const visitor = normalizeIP(Array.isArray(header) ? header[0] : header);

    if (isIP(visitor)) return visitor;
  }

  return ip;
}

function forwardedIP(settings: Settings, req: Request): string {
  const peer = normalizeIP(req.socket.remoteAddress);

  if (!inList(settings.trustedProxies, peer)) return peer;

  const header = req.headers["x-forwarded-for"];
  const hops = splitList(Array.isArray(header) ? header.join(",") : header).map(normalizeIP);

  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isIP(hops[i])) break;

    if (!inList(settings.trustedProxies, hops[i])) return hops[i];
  }

  return peer;
}

/** RateLimiter counts events per key in a sliding one minute window. */
export class RateLimiter {
  private readonly perMinute: number;
  private hits = new Map<string, number[]>();

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  allow(key: string, now = Date.now()): boolean {
    const cutoff = now - 60_000;
    const hits = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    if (hits.length >= this.perMinute) {
      this.hits.set(key, hits);
      return false;
    }

    hits.push(now);
    this.hits.set(key, hits);

    return true;
  }

  prune(now = Date.now()): void {
    const cutoff = now - 60_000;

    for (const [key, hits] of this.hits) {
      const recent = hits.filter((t) => t > cutoff);

      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}

/** TokenBucket limits messages on a single connection. */
export class TokenBucket {
  private readonly rate: number;
  private readonly burst: number;
  private tokens: number;
  updated: number;

  constructor(rate: number, burst: number, now = Date.now()) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.updated = now;
  }

  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.updated) / 1000) * this.rate);
    this.updated = now;

    if (this.tokens < 1) return false;

    this.tokens -= 1;

    return true;
  }
}
