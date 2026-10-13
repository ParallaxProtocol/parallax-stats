// Number and time formatting, and the status grades that drive the
// indicator colors. Pure functions shared by server and client renders.

import { PROPAGATION_BANDS, TARGET_BLOCK_TIME } from "./protocol.ts";

/** A status grade. Each renders as a colored mark with a text label beside it. */
export type Grade = "good" | "warn" | "serious" | "critical" | "info" | "off";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatInt(n: number): string {
  return integer.format(n);
}

export function formatCompact(n: number): string {
  return compact.format(n);
}

const SI = ["", "K", "M", "G", "T", "P", "E", "Z"];

/** formatSI scales a value to an SI prefix: 12.3 G. */
export function formatSI(value: number, digits = 1): { value: string; prefix: string } {
  let v = Math.max(0, value);
  let i = 0;

  while (v >= 1000 && i < SI.length - 1) {
    v /= 1000;
    i++;
  }

  return { value: v.toFixed(i === 0 ? 0 : digits), prefix: SI[i] };
}

export function formatHashrate(hashes: number): string {
  const { value, prefix } = formatSI(hashes);

  return `${value} ${prefix}H/s`;
}

/**
 * hashpriceUnit picks the hashrate unit that puts a hashprice, LAX per H/s
 * per day, at 0.1 or more: 1.2 LAX per MH/s rather than 0.0000012 per H/s.
 */
export function hashpriceUnit(perHash: number): { scale: number; unit: string } {
  let i = 0;

  while (perHash > 0 && perHash * 1000 ** i < 0.1 && i < SI.length - 1) i++;

  return { scale: 1000 ** i, unit: `${SI[i]}H/s` };
}

/** Pools and miners count difficulty in units of 2^32 hashes, Bitcoin style. */
const POOL_UNIT = 2 ** 32;

/** formatPoolDifficulty converts raw chain difficulty to the units pools show: 774.94. */
export function formatPoolDifficulty(difficulty: string | number | bigint): string {
  const pool = Number(difficulty) / POOL_UNIT;

  return pool < 10_000 ? pool.toFixed(2) : formatInt(pool);
}

export function formatDifficulty(difficulty: string | number | bigint): string {
  const { value, prefix } = formatSI(Number(difficulty), 2);

  return `${value} ${prefix}H`;
}

/** formatGasPrice shows wei, gwei or LAX, whichever reads best. */
export function formatGasPrice(wei: number): string {
  if (wei < 1e6) return `${formatInt(wei)} wei`;
  if (wei < 1e18) return `${oneDecimal.format(wei / 1e9).replace(/\.0$/, "")} gwei`;

  return `${oneDecimal.format(wei / 1e18)} LAX`;
}

/** formatMs renders a short duration: 840 ms, 4.2 s, 12 min, 3 h, 2 days. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h`;

  const days = Math.round(ms / 86_400_000);

  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** formatClock renders elapsed time precisely: 42 s, 4 min 07 s, 1 h 12 min. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));

  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;

  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`;
}

/** formatAgo renders how long ago a server timestamp was. */
export function formatAgo(timestamp: number, now: number): string {
  if (!timestamp) return "never";

  const ms = Math.max(0, now - timestamp);

  return ms < 60_000 ? `${Math.floor(ms / 1000)} s ago` : `${formatMs(ms)} ago`;
}

/** formatBlockTime renders an average block time in seconds: 9 min 48 s. */
export function formatBlockTime(seconds: number): string {
  if (!seconds) return "n/a";
  if (seconds < 60) return `${seconds.toFixed(1)} s`;

  return formatClock(seconds * 1000);
}

export function shortHash(hash: string): string {
  const h = hash.startsWith("0x") ? hash.slice(2) : hash;

  return `${h.slice(0, 8)}…${h.slice(-8)}`;
}

/** clientVersion trims a client string like Parallax/v2.1.0-stable-abc/linux-amd64/go1.27 to its version. */
export function clientVersion(node: string): string {
  const parts = node.split("/");
  const version = parts.find((part) => /^v\d/.test(part));

  return version ?? parts[0] ?? "";
}

/**
 * shortVersion trims a version like v2.1.2-stable-1dea7a08 to v2.1.2 when
 * the commit is the one GitHub's v2.1.2 release tag points at, so official
 * builds read as their release. Any other build keeps its full version.
 */
export function shortVersion(version: string, releases: Record<string, string>): string {
  const match = /^(v\d+\.\d+\.\d+)-stable-([0-9a-f]{7,40})$/i.exec(version);
  const commit = match ? releases[match[1]] : undefined;

  return match && commit?.startsWith(match[2].toLowerCase()) ? match[1] : version;
}

// Grades

/**
 * After this long without a block the network may have stalled. Block
 * intervals are exponential, so waits of an hour happen; two hours at the
 * 10 minute target is a one-in-160,000 wait at steady hashrate.
 */
export const STALL_MS = 2 * 60 * 60 * 1000;

/** gradeElapsed grades the time since the last block: on schedule, long, unusually long, or a possible stall. */
export function gradeElapsed(ms: number): Grade {
  const t = TARGET_BLOCK_TIME * 1000;

  if (ms <= t) return "good";
  if (ms <= 3 * t) return "warn";
  if (ms <= STALL_MS) return "serious";

  return "critical";
}

/** gradeAvgBlockTime grades how far an average block time strays from the target. */
export function gradeAvgBlockTime(seconds: number): Grade {
  if (!seconds) return "off";

  const deviation = Math.abs(seconds - TARGET_BLOCK_TIME) / TARGET_BLOCK_TIME;

  if (deviation <= 0.1) return "good";
  if (deviation <= 0.25) return "warn";
  if (deviation <= 0.5) return "serious";

  return "critical";
}

/** Gas a plain transfer uses: what a waiting transaction is taken to need when recent blocks carried none. */
export const TRANSFER_GAS = 21_000;

/**
 * mempoolPressure is the room waiting transactions need, as a share of a
 * block: 1 fills the next block, 3 takes three to clear. Only their number
 * is reported, so each is taken to need what recent blocks' transactions
 * did on average.
 */
export function mempoolPressure(pending: number, gasPerTx: number, gasLimit: number): number {
  return gasLimit > 0 ? (pending * (gasPerTx > 0 ? gasPerTx : TRANSFER_GAS)) / gasLimit : 0;
}

/** gradePressure: room to spare under half a block, a queue up to two blocks, a backlog beyond. */
export function gradePressure(pressure: number): Grade {
  if (pressure < 0.5) return "good";
  if (pressure <= 2) return "warn";

  return "critical";
}

/** formatPercent renders a fraction as a percentage to two decimals, without rounding a little to nothing: 0.63%, 230.00%. */
export function formatPercent(fraction: number): string {
  const pct = fraction * 100;

  if (pct === 0) return "0%";
  if (pct < 0.01) return "<0.01%";

  return `${pct.toFixed(2)}%`;
}

export function gradeRatio(ratio: number): Grade {
  if (!Number.isFinite(ratio)) return "off";
  if (ratio >= 0.9) return "good";
  if (ratio >= 0.75) return "info";
  if (ratio >= 0.5) return "warn";

  return "critical";
}

/**
 * gradePeerLatency grades a node's median ping to its peers. Relaying a block
 * takes a few round trips, so with 10 minute blocks even a second adds little
 * stale risk; intercontinental and Tor links are slow and fine.
 */
export function gradePeerLatency(ms: number): Grade {
  if (!ms) return "off";
  if (ms < 1000) return "good";
  if (ms < 3000) return "warn";
  if (ms < 10_000) return "serious";

  return "critical";
}

/**
 * gradePeers grades a node's peer count. Two nodes connect only when one of them
 * accepts incoming connections, and few mainnet nodes do, so most top out at
 * that few: 4 is well connected for now.
 */
export function gradePeers(peers: number): Grade {
  if (peers <= 1) return "critical";
  if (peers < 4) return "warn";

  return "good";
}

/** gradePropagation grades how late a block reached a node, by the speed bands, which match the propagation alert. */
export function gradePropagation(ms: number): Grade {
  if (ms === 0) return "info";
  if (ms < PROPAGATION_BANDS[0]) return "good";
  if (ms < PROPAGATION_BANDS[1]) return "warn";
  if (ms < PROPAGATION_BANDS[2]) return "serious";

  return "critical";
}

/** gradeBehind grades how many blocks a node trails the best block; ahead of it is suspect. */
export function gradeBehind(behind: number): Grade {
  if (behind < 0) return "critical";
  if (behind === 0) return "good";
  if (behind === 1) return "warn";
  if (behind < 4) return "serious";

  return "critical";
}

export function gradeUptime(uptime: number): Grade {
  if (uptime >= 90) return "good";
  if (uptime >= 75) return "warn";

  return "critical";
}

/** survival is the share of blocks that take longer than `ms`, for exponentially distributed intervals. */
export function survival(ms: number): number {
  return Math.exp(-ms / (TARGET_BLOCK_TIME * 1000));
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** countryName spells out a two-letter country code, or gives the code back if it is not one. */
export function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}
