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
  VERY_SLOW_SPREAD_MS,
  type Level,
} from "../lib/alert-levels.ts";
import { miningDifficulty } from "../lib/asert.ts";
import { CONFIDENCE, confirmationsFor, COST_DEPTHS, reversalCost } from "../lib/confirmations.ts";
import { DECENTRALIZATION_MIN_BLOCKS, gradeDecentralization, majorityHolders } from "../lib/decentralization.ts";
import { onMainnet, summarize } from "../lib/derive.ts";
import { blockPay, dailyPay, hashprice, latestPace, pressureOf, scheduledPay } from "../lib/earnings.ts";
import { blockReward, emissionAt, SUPPLY_CAP, toLax, WEI_PER_LAX } from "../lib/emission.ts";
import { hashpriceUnit } from "../lib/format.ts";
import { HISTORY_BINS, PROPAGATION_BANDS, TARGET_BLOCK_TIME, type Charts, type PublicNode, type Snapshot } from "../lib/protocol.ts";
import type { Release } from "../lib/releases.ts";
import { compareParts, parsePlatform, parseVersion } from "../lib/version.ts";
import { open, watch } from "../lib/withholding.ts";

const WEEK_S = 7 * 86_400;
/** Gas a plain transfer uses. */
const TRANSFER_GAS = 21_000;
/** Pool difficulty units: one is 2^32 hashes. */
const POOL_UNIT = 2 ** 32;

export interface ApiAlert {
  type: "split" | "reorg" | "majority" | "withholding" | "propagation" | "slow-miner" | "release";
  level: Level | "info";
  /** When the condition began, where it has a start. */
  since: number | null;
  details: Record<string, unknown>;
}

const mean = (values: number[]) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** publicStats assembles the v2 response from the live snapshot. */
export function publicStats(snapshot: Snapshot, latestRelease: Release | null, now = Date.now()) {
  const { nodes, charts, gasPrice, pools, incidents } = snapshot;
  const summary = summarize(nodes);
  const best = summary.bestStats?.block ?? null;
  const mainnet = onMainnet(nodes);
  const next = mainnet && best ? miningDifficulty(best) : null;
  const health = charts?.health ?? null;
  const minerBlocks = charts?.minerBlocks ?? 0;
  const fullWeek = (charts?.minerSpan ?? 0) >= WEEK_S - 3_600;
  const majorityCount = charts ? majorityHolders(charts.miners, minerBlocks) : null;
  const price = gasPrice ? Number(gasPrice) : null;
  // What a block pays, and what that makes a hash, and all of them, earn in a day
  const pay = blockPay(summary.bestBlock, charts?.fees ?? []);
  const difficulty = next !== null ? Number(next) : best ? Number(best.difficulty) : null;
  const perHash = difficulty !== null && summary.bestBlock > 0 ? hashprice(pay, difficulty) : null;
  const pace = latestPace(charts?.trends.blocktime ?? []);
  const pressure = pressureOf(summary.pending, charts);

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

    hashprice:
      perHash !== null
        ? {
            laxPerHashPerSecondPerDay: perHash,
            // The same figure per the unit the page shows it in, such as MH/s
            ...(({ scale, unit }) => ({ unit, laxPerUnitPerDay: perHash * scale }))(hashpriceUnit(perHash)),
            difficulty: next !== null ? "next" : "latest",
            blockPayLax: pay,
          }
        : null,

    securityBudget:
      pace !== null && summary.bestBlock > 0
        ? { laxPerDay: dailyPay(pay, pace), scheduledLaxPerDay: scheduledPay(pay), blockTimeSeconds: pace }
        : null,

    mempool: {
      // The median of synced nodes
      pending: summary.pending,
      // The room the waiting transactions need, as a share of a block: 1 fills the next one
      pressure,
      blocksToClear: pressure !== null ? Math.ceil(pressure) : null,
    },

    confirmations: confirmations(charts, pay, snapshot.price?.usd ?? null, now),

    latestBlocks: latestBlocks(charts, pools),

    supply: supply(summary.bestBlock, now),

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
          // Every stale height and reorganization the fork graph draws, over the window's heights
          heights: health.heights ?? null,
          stale: health.stale ?? health.recentStale,
          reorgEvents: health.reorgEvents ?? [],
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
          // Reports by speed band: under 5 s, 5 to 15 s, 15 to 60 s, and 60 s or more
          bands: charts.propagation.bands.map((reports, i) => ({ fromMs: i > 0 ? PROPAGATION_BANDS[i - 1] : 0, toMs: PROPAGATION_BANDS[i] ?? null, reports })),
          historyBlocks: HISTORY_BINS,
        }
      : null,

    clientVersions: clientVersions(nodes, latestRelease),

    nodeList: nodes.map(nodeRow),

    alerts: activeAlerts(snapshot, latestRelease, now),

    incidents: incidents ? { since: incidents.since, rebuiltFrom: incidents.rebuiltFrom, list: incidents.list } : null,

    // The figures over the last 7 days, oldest first, null where there was nothing to measure
    trends: charts ? trends(charts, pay) : null,
  };
}

/**
 * confirmations is what the Recommended confirmations tile shows, against
 * the largest miner of the last 7 days: the wait for each confidence, what
 * reversing a payment would cost it, and whether it still mines in the open.
 */
function confirmations(charts: Charts | null, pay: number, usd: number | null, now: number) {
  const total = charts?.minerBlocks ?? 0;
  const largest = charts?.miners[0] ?? null;

  if (!largest || total === 0) return null;

  const share = largest.blocks / total;

  return {
    largestMiner: { name: largest.pool?.name ?? null, address: largest.miner, share },
    // Too few blocks to judge the share by: the page waits rather than recommend
    judged: total >= DECENTRALIZATION_MIN_BLOCKS,
    // While the largest miner holds a majority no wait is safe, and every count is null
    majority: share >= 0.5,
    // The fewest confirmations for each confidence; null when it takes more than 1,000
    levels: levels(share, false),
    // The same for a payment accepted while the miner is seen mining in the open, as the page shows while it is
    openLevels: levels(share, true),
    // What the miner gives up to replace a payment with this many confirmations: its own blocks' rewards
    reversalCost: COST_DEPTHS.map((blocks) => {
      const lax = reversalCost(share, blocks, pay);

      return { blocks, lax, usd: usd !== null ? lax * usd : null };
    }),
    watch: watchDetails(charts, now),
  };
}

/** levels is the fewest confirmations for each confidence, against a miner with `share`, seen mining in the open or not. */
function levels(share: number, open: boolean) {
  return CONFIDENCE.map((confidence) => {
    const blocks = confirmationsFor(share, confidence, open);

    return { confidence, blocks, waitSeconds: blocks !== null ? blocks * TARGET_BLOCK_TIME : null };
  });
}

/** watchDetails is the largest miner's quietest recent stretch, as the tile and the alert judge it; null while not watched. */
function watchDetails(charts: Charts | null, now: number) {
  const quiet = watch(charts, now);

  if (!quiet) return null;

  return {
    lastBlock: { height: quiet.last.height, timestamp: quiet.last.timestamp * 1000 },
    // Its blocks after `fromHeight`, against those its share leads to expect
    fromHeight: quiet.stretch.height,
    since: quiet.stretch.timestamp * 1000,
    found: quiet.stretch.found,
    expected: quiet.stretch.expected,
    // Every miner's blocks after `fromHeight`; null when the newest height is not known
    published: quiet.stretch.published,
    // The chance of a stretch that quiet while mining openly; at 0.01 or more it counts as mining in the open
    chance: quiet.chance,
    open: open(quiet),
    level: quiet.level,
  };
}

/** latestBlocks lists the charted blocks, newest first, with what the Transactions, Block fullness and Fees tiles make of them. */
function latestBlocks(charts: Charts | null, pools: Snapshot["pools"]) {
  if (!charts || charts.height.length === 0) return null;

  const { height, transactions, gasSpending, gasLimit, fees } = charts;
  const count = height.length;
  const fullness = gasSpending.map((used, i) => (gasLimit[i] > 0 ? used / gasLimit[i] : 0));
  const reported = fees.flatMap((f, i) => (f === null ? [] : [i]));
  const feesLax = reported.map((i) => Number(BigInt(fees[i]!)) / Number(WEI_PER_LAX));
  const rewardLax = reported.map((i) => Number(blockReward(height[i])) / Number(WEI_PER_LAX));
  const meanFees = mean(feesLax);
  const meanReward = mean(rewardLax);

  return {
    blocks: count,
    transactions: { total: transactions.reduce((a, b) => a + b, 0), perBlock: mean(transactions) },
    averageFullness: mean(fullness),
    fees: {
      // Older parallaxd versions do not report fees
      reportedBlocks: reported.length,
      averageLax: meanFees,
      shareOfReward: meanFees !== null && meanReward ? meanFees / meanReward : null,
    },
    list: height
      .map((number, i) => {
        const miner = charts.miner[i] ?? null;

        return {
          number,
          timestamp: charts.timestamp[i] ? charts.timestamp[i] * 1000 : null,
          miner,
          pool: miner ? (pools[miner]?.name ?? null) : null,
          transactions: transactions[i],
          gasUsed: gasSpending[i],
          gasLimit: gasLimit[i],
          feesWei: fees[i],
          // Null when the parent is not in the history
          blockTimeSeconds: charts.blocktime[i] > 0 ? charts.blocktime[i] : null,
        };
      })
      .reverse(),
  };
}

/** supply is the Supply section's issuance and halving figures, from the height alone. */
function supply(height: number, now: number) {
  if (height === 0) return null;

  const state = emissionAt(height);

  return {
    issuedLax: toLax(state.issued),
    issuedShare: state.issuedShare,
    capLax: toLax(SUPPLY_CAP),
    leftToMineLax: toLax(SUPPLY_CAP - state.issued),
    blockRewardLax: toLax(state.reward),
    dailyIssuanceLax: toLax(state.dailyIssuance),
    halving: {
      era: state.era,
      nextAt: state.nextHalving,
      blocksToGo: state.blocksToHalving,
      eraProgress: state.eraProgress,
      leftThisEraLax: toLax(state.leftThisEra),
      nextRewardLax: toLax(state.nextReward),
      // At the target block time, which ASERT holds
      expected: now + state.blocksToHalving * TARGET_BLOCK_TIME * 1000,
    },
  };
}

/** clientVersions counts the online nodes by release and platform, as the Client versions panel does. */
function clientVersions(nodes: PublicNode[], latestRelease: Release | null) {
  const online = nodes.filter((node) => node.stats.active);
  const latest = latestRelease ? parseVersion(`/${latestRelease.tag}`) : null;
  const count = (key: (node: PublicNode) => string) =>
    [...online.reduce((counts, node) => counts.set(key(node), (counts.get(key(node)) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const versions = online.map((node) => parseVersion(node.info.node));
  const known = latest?.parts ? versions.filter((v) => v.parts !== null) : [];

  return {
    online: online.length,
    latest: latest?.parts ? { version: latest.label, url: latestRelease!.url } : null,
    // On the latest release or newer, and behind it; null while GitHub cannot be reached
    upToDate: latest?.parts ? known.filter((v) => compareParts(v.parts, latest.parts) >= 0).length : null,
    behind: latest?.parts ? known.filter((v) => compareParts(v.parts, latest.parts) < 0).length : null,
    versions: count((node) => parseVersion(node.info.node).label).map(([version, n]) => ({ version, nodes: n })),
    platforms: count((node) => parsePlatform(node.info.node)).map(([platform, n]) => ({ platform, nodes: n })),
  };
}

/** nodeRow is a node as the node table shows it. */
function nodeRow(node: PublicNode) {
  const { info, stats, geo } = node;

  return {
    name: info.name,
    verified: node.trusted,
    client: info.node,
    version: parseVersion(info.node).label,
    active: stats.active,
    offlineSince: node.offlineSince,
    syncing: stats.syncing,
    mining: stats.mining,
    hashesPerSecond: stats.hashrate,
    peers: stats.peers,
    peerLatencyMs: stats.peerLatency || null,
    block: stats.block.number,
    propagationMs: stats.block.propagation >= 0 ? stats.block.propagation : null,
    propagationAvgMs: stats.propagationAvg,
    pending: stats.pending,
    uptimePercent: stats.uptime,
    country: geo?.country ?? null,
  };
}

/** trends gives each figure's 7 days, in 4 hour slices; prices are left out. */
function trends(charts: Charts, pay: number) {
  const t = charts.trends;

  return {
    start: t.start.map((s) => s * 1000),
    blockTimeSeconds: t.blocktime,
    hashesPerSecond: t.hashrate,
    difficulty: t.difficulty,
    // At today's block pay over the whole week
    hashpriceLax: t.difficulty.map((d) => (d === null ? null : hashprice(pay, d))),
    securityBudgetLax: t.blocktime.map((b) => (b === null ? null : dailyPay(pay, b))),
    activeNodes: t.active,
    syncedNodes: t.synced,
    recommendedFeeWei: t.gasPrice,
    latencyMs: t.peerLatency,
    uptimePercent: t.uptime,
    pending: t.pending,
    mempoolPressure: t.pending.map((p) => (p === null ? null : pressureOf(p, charts))),
  };
}

/** activeAlerts lists what the page's banners show right now, by the same rules. */
export function activeAlerts(snapshot: Snapshot, latestRelease: Release | null, now = Date.now()): ApiAlert[] {
  const { nodes, charts } = snapshot;
  const health = charts?.health ?? null;
  const alerts: ApiAlert[] = [];

  if (health?.split) {
    alerts.push({ type: "split", level: "critical", since: null, details: { chains: health.split.chains, verifiedNodes: health.split.nodes, sharedHeight: health.split.height } });
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

  const quiet = watchDetails(charts, now);

  if (quiet?.level) {
    const top = charts!.miners[0];
    const { level, ...details } = quiet;

    alerts.push({ type: "withholding", level, since: quiet.since, details: { name: top.pool?.name ?? null, address: top.miner, ...details } });
  }

  const spread = charts?.propagation.spread ?? null;

  if (spread && spread.median > SLOW_SPREAD_MS) {
    alerts.push({ type: "propagation", level: spread.median > VERY_SLOW_SPREAD_MS ? "critical" : "warn", since: null, details: { medianMs: spread.median, blocks: spread.blocks } });
  } else if (spread?.slowMiner) {
    const slow = spread.slowMiner;

    alerts.push({ type: "slow-miner", level: "warn", since: null, details: { name: slow.pool, address: slow.miner, medianMs: slow.median, blocks: slow.blocks } });
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
