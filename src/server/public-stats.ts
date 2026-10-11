// The v2 JSON stats: what the dashboard shows, for scripts and other sites.
// Built from the same snapshot and the same alert rules as the page, so the
// two never disagree. Times are Unix milliseconds unless a field says
// seconds; difficulties are decimal strings, as they overflow numbers.

import {
  chainLevel,
  DEEP_REORG,
  deepReorg,
  majority,
  reorgLevel,
  SLOW_SPREAD_MS,
  stallLevel,
  VERY_SLOW_SPREAD_MS,
  type Level,
} from "../lib/alert-levels.ts";
import { miningDifficulty } from "../lib/asert.ts";
import { DECENTRALIZATION_MIN_BLOCKS, gradeDecentralization, majorityHolders } from "../lib/decentralization.ts";
import { onMainnet, summarize } from "../lib/derive.ts";
import { HISTORY_BINS, TARGET_BLOCK_TIME, type Snapshot } from "../lib/protocol.ts";
import type { Release } from "../lib/releases.ts";
import { compareParts, parseVersion } from "../lib/version.ts";

const WEEK_S = 7 * 86_400;
/** Gas a plain transfer uses. */
const TRANSFER_GAS = 21_000;
/** Pool difficulty units: one is 2^32 hashes. */
const POOL_UNIT = 2 ** 32;

export interface ApiAlert {
  type: "split" | "stall" | "reorg" | "majority" | "propagation" | "slow-miner" | "no-verified-node" | "release";
  level: Level | "info";
  /** When the condition began, where it has a start. */
  since: number | null;
  details: Record<string, unknown>;
}

const mean = (values: number[]) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** publicStats assembles the v2 response from the live snapshot. */
export function publicStats(snapshot: Snapshot, latestRelease: Release | null, now = Date.now()) {
  const { nodes, charts, gasPrice, pools } = snapshot;
  const summary = summarize(nodes);
  const best = summary.bestStats?.block ?? null;
  const mainnet = onMainnet(nodes);
  const next = mainnet && best ? miningDifficulty(best) : null;
  const health = charts?.health ?? null;
  const minerBlocks = charts?.minerBlocks ?? 0;
  const fullWeek = (charts?.minerSpan ?? 0) >= WEEK_S - 3_600;
  const majorityCount = charts ? majorityHolders(charts.miners, minerBlocks) : null;
  const price = gasPrice ? Number(gasPrice) : null;

  return {
    serverTime: snapshot.serverTime,
    network: mainnet ? "mainnet" : nodes.length > 0 ? "other" : null,

    bestBlock: best
      ? { number: best.number, hash: best.hash, miner: best.miner, pool: pools[best.miner]?.name ?? null, timestamp: best.timestamp * 1000, arrived: best.arrived }
      : null,

    nodes: { total: summary.total, active: summary.active, synced: summary.synced, latencyMs: summary.peerLatency || null },

    blockTime: {
      targetSeconds: TARGET_BLOCK_TIME,
      // The headline figure: the last 7 days, or what the server holds until it has a week
      week: { averageSeconds: charts?.avgBlocktime || null, blocks: minerBlocks, spanSeconds: charts?.minerSpan ?? 0, fullWeek },
      // The Block time chart's: the last 40 blocks
      recent: { averageSeconds: mean(charts?.blocktime.filter((t) => t > 0) ?? []), blocks: charts?.height.length ?? 0 },
    },

    hashrate: { hashesPerSecond: charts?.avgHashrate || null },

    difficulty: {
      latest: best?.difficulty ?? null,
      // Exact for the block being mined: mainnet ASERT is fixed by its parent
      next: next?.toString() ?? null,
      nextPoolUnits: next !== null ? Number(next) / POOL_UNIT : null,
      changeWeek: charts?.difficultyWeek ?? null,
    },

    recommendedFee:
      price !== null ? { wei: gasPrice, gwei: price / 1e9, transferLax: (price * TRANSFER_GAS) / 1e18 } : null,

    uptime: { verifiedAveragePercent: summary.uptime },

    decentralization: {
      blocks: minerBlocks,
      spanSeconds: charts?.minerSpan ?? 0,
      fullWeek,
      grade: minerBlocks >= DECENTRALIZATION_MIN_BLOCKS ? gradeDecentralization(majorityCount).verdict.toLowerCase() : null,
      // Miners that together found most of the blocks; null when it takes more than are listed
      majorityHolders: majorityCount,
      distinctMiners: charts?.minerCount ?? 0,
      topMiners: (charts?.miners ?? []).map((m) => ({
        name: m.pool?.name ?? null,
        website: m.pool?.url ?? null,
        address: m.miner,
        blocks: m.blocks,
        share: minerBlocks > 0 ? m.blocks / minerBlocks : 0,
      })),
    },

    staleBlocks: health
      ? {
          window: health.window,
          count: health.staleBlocks,
          recent: health.recentStale,
          reorgs: { count: health.reorgs, since: health.since },
          lastReorg: health.lastReorg,
          lastDeepReorg: health.lastDeepReorg ?? null,
          split: health.split,
          level: chainLevel(health, now),
        }
      : null,

    propagation: charts
      ? {
          reports: charts.propagation.samples,
          medianMs: charts.propagation.p50,
          p90Ms: charts.propagation.p90,
          p99Ms: charts.propagation.p99,
          reach90: charts.propagation.spread ?? null,
          historyBlocks: HISTORY_BINS,
        }
      : null,

    alerts: activeAlerts(snapshot, latestRelease, now),
  };
}

/** activeAlerts lists what the page's banners show right now, by the same rules, without per-viewer dismissals. */
export function activeAlerts(snapshot: Snapshot, latestRelease: Release | null, now = Date.now()): ApiAlert[] {
  const { nodes, charts } = snapshot;
  const summary = summarize(nodes);
  const health = charts?.health ?? null;
  const alerts: ApiAlert[] = [];

  if (health?.split) {
    alerts.push({ type: "split", level: "critical", since: null, details: { chains: health.split.chains, verifiedNodes: health.split.nodes, sharedHeight: health.split.height } });
  }

  const foundAt = (summary.bestStats?.block.timestamp ?? 0) * 1000;

  if (stallLevel(foundAt, now)) {
    alerts.push({ type: "stall", level: "critical", since: foundAt, details: { lastBlock: summary.bestBlock, waitingSeconds: Math.round((now - foundAt) / 1000) } });
  }

  const reorg = deepReorg(health, now);

  if (reorg) {
    alerts.push({ type: "reorg", level: reorgLevel(reorg.depth ?? 1), since: reorg.at, details: { height: reorg.height, depth: reorg.depth ?? 1, nodes: reorg.nodes, alertFromDepth: DEEP_REORG } });
  }

  const held = majority(charts);

  if (held) {
    alerts.push({
      type: "majority",
      level: "critical",
      since: null,
      details: { name: held.miner.pool?.name ?? null, address: held.miner.miner, share: held.share, blocks: held.miner.blocks, of: held.blocks },
    });
  }

  const spread = charts?.propagation.spread ?? null;

  if (spread && spread.median > SLOW_SPREAD_MS) {
    alerts.push({ type: "propagation", level: spread.median > VERY_SLOW_SPREAD_MS ? "critical" : "warn", since: null, details: { medianMs: spread.median, blocks: spread.blocks } });
  } else if (spread?.slowMiner) {
    const slow = spread.slowMiner;

    alerts.push({ type: "slow-miner", level: "warn", since: null, details: { name: slow.pool, address: slow.miner, medianMs: slow.median, blocks: slow.blocks } });
  }

  if (nodes.some((node) => node.trusted) && !nodes.some((node) => node.trusted && node.stats.active)) {
    alerts.push({ type: "no-verified-node", level: "info", since: null, details: {} });
  }

  const latest = latestRelease ? parseVersion(`/${latestRelease.tag}`) : null;
  const online = nodes.filter((node) => node.stats.active);
  const behind = online.filter((node) => {
    const { parts } = parseVersion(node.info.node);

    return parts !== null && latest?.parts && compareParts(parts, latest.parts) < 0;
  }).length;

  if (latestRelease && latest?.parts && behind > 0) {
    alerts.push({ type: "release", level: "info", since: null, details: { version: latest.label, url: latestRelease.url, behind, online: online.length } });
  }

  const severity = { critical: 0, warn: 1, info: 2 };

  return alerts.sort((a, b) => severity[a.level] - severity[b.level]);
}
