// Sanitizers for everything nodes send. Each returns a fresh object
// holding only known fields of the expected type, or null when the input
// is unusable.

import type { NodeInfo } from "../lib/protocol.ts";

/** A reported block before the server adds its timing fields. */
export interface ReportedBlock {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  miner: string;
  gasUsed: number;
  gasLimit: number;
  difficulty: string;
  totalDifficulty: string;
  transactionsRoot: string;
  stateRoot: string;
  sha3Uncles: string;
  txCount: number;
  uncleCount: number;
  fees: string | null;
}

export interface ReportedStats {
  active: boolean;
  mining: boolean;
  syncing: boolean;
  hashrate: number;
  peers: number;
  gasPrice: number;
  peerLatency: number;
}

const MAX_BLOCK_NUMBER = 2 ** 48;
const ZERO_HASH = "0x" + "0".repeat(64);
const ZERO_ADDRESS = "0x" + "0".repeat(40);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

// Control and bidi override characters
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** cleanString keeps printable text with a capped length. */
export function cleanString(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";

  return String(value).replace(UNPRINTABLE, "").trim().slice(0, max);
}

export function cleanInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.min(max, Math.max(min, Math.round(n)));
}

export function cleanNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);

  if (!Number.isFinite(n)) return fallback;

  return Math.min(max, Math.max(min, n));
}

function cleanHash(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : null;
}

function cleanAddress(value: unknown): string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : ZERO_ADDRESS;
}

/**
 * cleanBigNumber keeps a non-negative integer as a decimal string, as
 * difficulties overflow JavaScript numbers.
 */
export function cleanBigNumber(value: unknown): string | null {
  let s: string;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    s = BigInt(Math.max(0, Math.round(value))).toString();
  } else {
    s = String(value);
  }

  return /^[0-9]{1,78}$/.test(s) ? s.replace(/^0+(?=.)/, "") : null;
}

export function cleanId(value: unknown): string | null {
  const id = cleanString(value, 64);

  // Names are lookup keys and end up in logs, so keep them to a
  // conservative character set.
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._\-()[\]#+]{0,63}$/.test(id)) return null;

  return id;
}

export function cleanInfo(info: unknown): NodeInfo | null {
  if (!isPlainObject(info)) return null;

  return {
    name: cleanString(info.name, 64),
    node: cleanString(info.node, 128),
    port: cleanInt(info.port, 0, 65535, 0),
    net: cleanString(info.net, 32),
    protocol: cleanString(info.protocol, 128),
    api: cleanString(info.api, 32),
    os: cleanString(info.os, 32),
    os_v: cleanString(info.os_v, 32),
    client: cleanString(info.client, 32),
    canUpdateHistory: info.canUpdateHistory === true,
  };
}

/**
 * cleanBlock compacts a reported block. Transaction and uncle lists are
 * reduced to counts: nothing downstream needs the hashes, and keeping
 * them would let a node fill memory and every viewer's connection with
 * arbitrarily large blocks.
 */
export function cleanBlock(block: unknown): ReportedBlock | null {
  if (!isPlainObject(block)) return null;

  const number = Number(block.number);

  if (!Number.isInteger(number) || number < 0 || number > MAX_BLOCK_NUMBER) return null;

  const hash = cleanHash(block.hash);
  const difficulty = cleanBigNumber(block.difficulty);
  const totalDifficulty = cleanBigNumber(block.totalDifficulty);

  if (hash === null || difficulty === null || totalDifficulty === null) return null;

  const txCount = Array.isArray(block.transactions)
    ? block.transactions.length
    : cleanInt(block.txCount, 0, 1e7, 0);
  const uncleCount = Array.isArray(block.uncles) ? block.uncles.length : cleanInt(block.uncleCount, 0, 100, 0);

  return {
    number,
    hash,
    parentHash: cleanHash(block.parentHash) ?? ZERO_HASH,
    timestamp: cleanInt(block.timestamp, 0, MAX_BLOCK_NUMBER, 0),
    miner: cleanAddress(block.miner),
    gasUsed: cleanInt(block.gasUsed, 0, Number.MAX_SAFE_INTEGER, 0),
    gasLimit: cleanInt(block.gasLimit, 0, Number.MAX_SAFE_INTEGER, 0),
    difficulty,
    totalDifficulty,
    transactionsRoot: cleanHash(block.transactionsRoot) ?? "",
    stateRoot: cleanHash(block.stateRoot) ?? "",
    sha3Uncles: cleanHash(block.sha3Uncles) ?? "",
    txCount: Math.min(txCount, 1e7),
    uncleCount: Math.min(uncleCount, 100),
    // Reported by parallaxd versions that include it; anything malformed counts as unknown
    fees: block.fees === undefined ? null : cleanBigNumber(block.fees),
  };
}

export function cleanHistory(history: unknown): ReportedBlock[] | null {
  if (!Array.isArray(history)) return null;

  // Nodes answer a history request with at most 50 blocks
  return history
    .slice(0, 50)
    .map(cleanBlock)
    .filter((block): block is ReportedBlock => block !== null);
}

export function cleanStats(stats: unknown): ReportedStats | null {
  if (!isPlainObject(stats)) return null;

  return {
    active: stats.active !== false,
    mining: stats.mining === true,
    syncing: stats.syncing === true,
    hashrate: cleanNumber(stats.hashrate, 0, 1e21, 0),
    peers: cleanInt(stats.peers, 0, 100000, 0),
    gasPrice: cleanNumber(stats.gasPrice, 0, 1e30, 0),
    peerLatency: cleanInt(stats.peerLatency, 0, 600000, 0),
  };
}

export function cleanPending(stats: unknown): number | null {
  if (!isPlainObject(stats)) return null;

  return cleanInt(stats.pending, 0, 1e9, 0);
}

export function cleanLatency(latency: unknown): number {
  return cleanInt(latency, 0, 600000, 0);
}
