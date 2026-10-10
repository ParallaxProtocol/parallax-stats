// Settings, all from the environment. See the README for what each one
// does.

import { BlockList, isIPv4, isIPv6 } from "node:net";
import { cloudflareEdges } from "./cloudflare.ts";

export interface Settings {
  /** Private secrets; nodes logging in with one are verified. */
  privateSecrets: string[];
  /** Secret anyone may use; nodes logging in with it are unverified. */
  publicSecret: string;
  /** Reverse proxies allowed to set X-Forwarded-For: addresses or ranges such as 10.0.0.0/8. */
  trustedProxies: BlockList;
  /** Cloudflare's edge ranges when the site is proxied through Cloudflare, else null. */
  cloudflare: BlockList | null;
  /** Addresses or ranges refused outright. */
  bannedIPs: BlockList;
  /** Addresses whose nodes are treated as verified. */
  trustedIPs: string[];
  /** Node names no one may log in with. */
  reservedNames: string[];
  /** Nodes tracked in total, connected or recently seen. */
  maxNodes: number;
  /** Unverified names one address may hold, connected or recently seen. */
  maxNodesPerIP: number;
  /** New reporter connections per address per minute. */
  connPerMinute: number;
  /** How long a disconnected name stays bound to its address. */
  nameHoldMs: number;
  /** Largest reporter message accepted. */
  maxMessageBytes: number;
  /** Per-connection reporter message rate: refill per second and burst. */
  msgPerSecond: number;
  msgBurst: number;
  /** Viewer connections one address may hold open. */
  maxViewersPerIP: number;
}

type Env = Record<string, string | undefined>;

export function splitList(value: string | undefined): string[] {
  return String(value ?? "")
    .split(/[|,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function intSetting(env: Env, name: string, fallback: number): number {
  const value = Number.parseInt(env[name] ?? "", 10);

  return Number.isNaN(value) || value < 0 ? fallback : value;
}

/**
 * addressList builds a matcher from entries that are single addresses or
 * CIDR ranges, IPv4 or IPv6. Entries that are neither are ignored.
 */
export function addressList(entries: string[]): BlockList {
  const list = new BlockList();

  for (const entry of entries) {
    const [address, bits] = entry.split("/");
    const type = isIPv4(address) ? "ipv4" : isIPv6(address) ? "ipv6" : null;

    if (!type) continue;

    if (bits === undefined) {
      list.addAddress(address, type);
    } else {
      const prefix = Number(bits);

      if (Number.isInteger(prefix) && prefix >= 0 && prefix <= (type === "ipv4" ? 32 : 128)) list.addSubnet(address, prefix, type);
    }
  }

  return list;
}

/** inList reports whether an address matches, accepting either IP family. */
export function inList(list: BlockList, address: string): boolean {
  if (isIPv4(address)) return list.check(address, "ipv4");
  if (isIPv6(address)) return list.check(address, "ipv6");

  return false;
}

export function loadSettings(env: Env = process.env): Settings {
  const publicSecret = (env.PUBLIC_SECRET ?? "").trim();

  return {
    // A public secret must never double as a private one, or every node
    // using the published value would be verified.
    privateSecrets: splitList(env.WS_SECRET).filter((s) => s !== publicSecret),
    publicSecret,
    trustedProxies: addressList(splitList(env.TRUSTED_PROXIES)),
    cloudflare: /^(1|true|yes)$/i.test((env.BEHIND_CLOUDFLARE ?? "").trim()) ? cloudflareEdges() : null,
    bannedIPs: addressList(splitList(env.BANNED_IPS)),
    trustedIPs: splitList(env.TRUSTED_IPS),
    reservedNames: splitList(env.RESERVED_NAMES),
    maxNodes: intSetting(env, "MAX_NODES", 1000),
    maxNodesPerIP: intSetting(env, "MAX_NODES_PER_IP", 3),
    connPerMinute: intSetting(env, "CONN_PER_MINUTE", 10),
    nameHoldMs: intSetting(env, "NAME_HOLD_MINUTES", 60) * 60 * 1000,

    // A 50 block history report is the biggest message, and it is
    // compacted to a few kB once sanitized.
    maxMessageBytes: intSetting(env, "MAX_MESSAGE_BYTES", 4 * 1024 * 1024),

    msgPerSecond: 5,
    msgBurst: 50,
    maxViewersPerIP: intSetting(env, "MAX_VIEWERS_PER_IP", 20),
  };
}
