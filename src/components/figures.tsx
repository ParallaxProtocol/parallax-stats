"use client";

import { useState } from "react";
import type { Summary } from "@/lib/derive";
import { blockPay, dailyPay, hashprice, latestPace, pressureOf, scheduledPay } from "@/lib/earnings";
import {
  formatDifficulty,
  formatGasPrice,
  formatInt,
  formatPoolDifficulty,
  formatPercent,
  formatHashrate,
  gradePeerLatency,
  gradePressure,
  gradeRatio,
  gradeUptime,
  hashpriceUnit,
  type Grade,
} from "@/lib/format";
import { TREND_SLICE_S, type Charts, type Price, type Trends } from "@/lib/protocol";
import { sliceTime, Tile, TrendLine, Waiting } from "./charts";
import { ExternalLink } from "./external-link";
import { Indicator } from "./indicator";
import { Tooltip } from "./tooltip";

export interface Figure {
  label: string;
  value: string;
  /** Says what the value counts, on its line in smaller type: per GH/s per day. Hovered slices keep it. */
  unit?: string;
  grade?: Grade;
  /** What the grade says, on hovering the title: the reading, then what counts as healthy. */
  gradeNote?: string;
  note?: string;
  /** The figure over the last 7 days, one value per trend slice. */
  trend: (number | null)[];
  /** Renders a slice's value in place of the figure, while it is hovered. */
  format: (value: number) => string;
  /** Says more about a hovered slice's value, after its time. */
  detail?: (value: number) => string;
  /** Shown while no slice has a value. */
  waiting: string;
  /** A page elsewhere with more on the figure, linked in the tile's header. */
  link?: { href: string; label: string };
}

export type FigureKey = "hashrate" | "difficulty" | "hashprice" | "security" | "active" | "fee" | "mempool" | "latency" | "uptime";

/** Gas a plain LAX transfer uses. */
const TRANSFER_GAS = 21_000n;

const significant = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

const NO_TRENDS: Trends = { start: [], blocktime: [], hashrate: [], difficulty: [], transactions: [], fullness: [], fees: [], active: [], synced: [], gasPrice: [], peerLatency: [], uptime: [], pending: [], price: [] };

/** FigureTile is a headline figure over its last 7 days; hovering a slice puts its value in the figure's place. */
export function FigureTile({ figure, start, className = "" }: { figure: Figure; start: number[]; className?: string }) {
  const [active, setActive] = useState<number | null>(null);
  const { trend } = figure;
  const known = trend.filter((v): v is number => v !== null);
  const hovered = active !== null ? trend[active] : null;

  return (
    <Tile
      className={className}
      title={
        <Tooltip content={figure.grade && figure.grade !== "off" ? figure.gradeNote : null}>
          <span className="flex items-center gap-1.5">
            {figure.grade && <Indicator grade={figure.grade} label={figure.grade !== "off" ? figure.gradeNote : undefined} />}
            {figure.label}
          </span>
        </Tooltip>
      }
      readout={
        figure.link ? (
          <>
            {/* Short beside a link, so both fit beside a long title */}
            {known.length > 0 && "7 days · "}
            <ExternalLink href={figure.link.href}>{figure.link.label}</ExternalLink>
          </>
        ) : known.length > 0 ? (
          "last 7 days"
        ) : undefined
      }
      value={
        <>
          {active === null ? figure.value : hovered === null ? "n/a" : figure.format(hovered)}
          {figure.unit && (active === null ? figure.value !== "n/a" : hovered !== null) && (
            <span className="text-base text-muted-foreground"> {figure.unit}</span>
          )}
        </>
      }
      qualifier={
        active !== null && start[active] !== undefined
          ? [sliceTime(start[active]), hovered === null ? "no data" : figure.detail?.(hovered)].filter(Boolean).join(", ")
          : figure.note
      }
    >
      {known.length === 0 ? (
        <Waiting>{figure.waiting}</Waiting>
      ) : (
        <TrendLine
          values={trend}
          active={active}
          onActive={setActive}
          format={figure.format}
          label={`${figure.label} over the last 7 days, in ${TREND_SLICE_S / 3600} hour slices, from ${figure.format(Math.min(...known))} to ${figure.format(Math.max(...known))}`}
        />
      )}
    </Tile>
  );
}

/**
 * figures gives the headline figures, each with its last 7 days, for the
 * dashboard to place. `mining` is the difficulty of the block being mined,
 * when known: what pools show as network difficulty, so it leads over the
 * last found block's. `gasPrice` is the recommended gas price from RPC,
 * in wei.
 */
export function figures({
  summary,
  charts,
  mining,
  gasPrice,
  explorer,
  price,
}: {
  summary: Summary;
  charts: Charts | null;
  mining: bigint | null;
  gasPrice: string | null;
  /** The block explorer's address, for the mempool's link to pending transactions; null for none. */
  explorer: string | null;
  /** The LAX price, to put the hashprice in dollars; null shows it in LAX. */
  price: Price | null;
}): Record<FigureKey, Figure> {
  const transfer = gasPrice ? Number(BigInt(gasPrice) * TRANSFER_GAS) / 1e18 : null;
  const { bestStats } = summary;
  // A server from before the trends sends none
  const trends = charts?.trends ?? NO_TRENDS;
  const difficulty = mining ?? (bestStats ? BigInt(bestStats.block.difficulty) : null);
  // What a block pays, and so what a hash earns at the difficulty
  const pay = blockPay(summary.bestBlock, charts?.fees ?? []);
  const perHash = (d: number) => hashprice(pay, d);
  const current = difficulty !== null && summary.bestBlock > 0 ? perHash(Number(difficulty)) : null;
  // In dollars at the current price; each trend slice at its own mean price, so a slice before
  // prices were read has none. Without a price, both stay in LAX
  const usd = price?.usd ?? null;
  const currentValue = current !== null && usd !== null ? current * usd : current;
  // One unit for the figure and its trend, so the points compare
  const { scale, unit } = hashpriceUnit(currentValue ?? 0);
  const money = (v: number) => (usd !== null ? `$${significant.format(v)}` : `${significant.format(v)} LAX`);
  // What miners earn in a day, at the pace of blocks over the 24 hours to a slice's end. The newest
  // point of the block time trend gives today's pace
  const daily = (blocktime: number) => dailyPay(pay, blocktime);
  const pace = latestPace(trends.blocktime);
  const earned = pace !== null && summary.bestBlock > 0 ? daily(pace) : null;
  const scheduled = scheduledPay(pay);
  const ahead = earned !== null ? earned / scheduled - 1 : 0;
  const pressure = pressureOf(summary.pending, charts);
  // The CoinGecko credit its free API asks for, on each figure in dollars
  const priceLink = price ? { href: price.url, label: "CoinGecko" } : undefined;

  return {
    hashrate: {
      label: "Network hashrate",
      value: charts?.avgHashrate ? formatHashrate(charts.avgHashrate) : "n/a",
      note: "estimated over the last 24 hours",
      trend: trends.hashrate,
      format: formatHashrate,
      detail: () => "estimated over the 24 hours to its end",
      waiting: "Waiting for blocks",
    },
    hashprice: {
      label: "Hashprice",
      value: currentValue !== null ? money(currentValue * scale) : "n/a",
      unit: `per ${unit} per day`,
      note:
        current === null
          ? undefined
          : usd !== null
            ? `${significant.format(current * scale)} LAX at $${significant.format(usd)} each, fees included`
            : `at the ${mining !== null ? "next" : "latest"} block's difficulty, fees included`,
      // At today's reward over the whole week: a halving every 210,000 blocks, about 4 years, rarely falls within it
      trend: trends.difficulty.map((d, i) => {
        if (d === null) return null;
        if (usd === null) return perHash(d) * scale;

        // A server from before the price readings sends none
        const slicePrice = trends.price?.[i] ?? null;

        return slicePrice === null ? null : perHash(d) * slicePrice * scale;
      }),
      format: money,
      detail: () => `at the mean difficulty${usd !== null ? " and price" : ""}`,
      waiting: usd !== null ? "Collecting prices" : "Waiting for blocks",
      link: priceLink,
    },
    security: {
      label: "Security budget",
      value: earned === null ? "n/a" : money(usd !== null ? earned * usd : earned),
      unit: "per day",
      note:
        earned === null
          ? undefined
          : `${formatInt(Math.round(earned))} LAX to miners, ${
              Math.abs(ahead) < 0.005 ? "as" : `${Math.round(Math.abs(ahead) * 100)}% ${ahead > 0 ? "above" : "below"}`
            } the ${formatInt(Math.round(scheduled))} a day the schedule pays`,
      // Each slice at its own pace of blocks and, in dollars, its own mean price
      trend: trends.blocktime.map((t, i) => {
        if (t === null) return null;
        if (usd === null) return daily(t);

        const slicePrice = trends.price?.[i] ?? null;

        return slicePrice === null ? null : daily(t) * slicePrice;
      }),
      format: money,
      detail: () => `over the 24 hours to its end${usd !== null ? ", at the mean price" : ""}`,
      waiting: usd !== null ? "Collecting prices" : "Waiting for blocks",
      link: priceLink,
    },
    difficulty: {
      label: "Difficulty",
      value: bestStats ? formatDifficulty(mining ?? bestStats.block.difficulty) : "n/a",
      note: bestStats
        ? `${mining !== null ? "next block, " : ""}${formatPoolDifficulty(mining ?? bestStats.block.difficulty)} in pool units`
        : undefined,
      trend: trends.difficulty,
      format: formatDifficulty,
      detail: (v) => `mean, ${formatPoolDifficulty(v)} in pool units`,
      waiting: "Waiting for blocks",
    },
    active: {
      // Active nodes that are in sync, out of all active ones
      label: "Active nodes",
      value: `${summary.synced} of ${summary.active}`,
      grade: summary.active ? gradeRatio(summary.synced / summary.active) : "off",
      gradeNote: summary.active
        ? `${Math.round((summary.synced / summary.active) * 100)}% of active nodes are in sync. 90% or more is healthy.`
        : undefined,
      note: "in sync",
      trend: trends.active,
      // A slice's mean is fractional when a node was off for part of it: the figure counts whole nodes
      format: (v) => formatInt(Math.round(v)),
      detail: (v) => (Number.isInteger(v) ? "active nodes" : `mean ${v.toFixed(1)} active nodes`),
      waiting: "Collecting readings",
    },
    fee: {
      label: "Recommended fee",
      value: gasPrice ? formatGasPrice(Number(gasPrice)) : "n/a",
      note: transfer !== null ? `≈ ${significant.format(transfer)} LAX per transfer` : undefined,
      trend: trends.gasPrice,
      format: formatGasPrice,
      detail: () => "mean",
      waiting: "Collecting readings",
    },
    mempool: {
      label: "Mempool pressure",
      value: pressure !== null ? formatPercent(pressure) : "n/a",
      unit: "of a block",
      grade: pressure !== null ? gradePressure(pressure) : "off",
      gradeNote:
        pressure !== null
          ? `Waiting transactions would fill ${formatPercent(pressure)} of a block. Under half a block is healthy; over 2 blocks is a backlog.`
          : undefined,
      note:
        pressure === null
          ? undefined
          : summary.pending === 0
            ? "Nothing waiting"
            : `${formatInt(summary.pending!)} ${summary.pending === 1 ? "transaction" : "transactions"} waiting, ${
                pressure <= 1 ? "all fit in the next block" : `about ${Math.ceil(pressure)} blocks to clear`
              }`,
      // Each slice's mean waiting count, at today's room per transaction. A server from before the mempool readings sends none
      trend: (trends.pending ?? []).map((pending) => (pending === null ? null : pressureOf(pending, charts))),
      format: formatPercent,
      detail: () => "mean",
      waiting: "Collecting readings",
      link: explorer ? { href: `${explorer}/txs?tab=pending`, label: "pending" } : undefined,
    },
    latency: {
      label: "Latency",
      value: summary.peerLatency ? `${summary.peerLatency} ms` : "n/a",
      grade: gradePeerLatency(summary.peerLatency),
      gradeNote: summary.peerLatency
        ? `Nodes reach their peers in ${summary.peerLatency} ms, the median. Under 1 s is healthy: relaying a block takes only a few round trips.`
        : undefined,
      note: "median to peers",
      trend: trends.peerLatency,
      format: (v) => `${Math.round(v)} ms`,
      detail: () => "mean, median to peers",
      waiting: "Collecting readings",
    },
    uptime: {
      label: "Uptime",
      // Verified nodes only: anyone can run an unverified node for an hour
      value: summary.uptime !== null ? `${Math.round(summary.uptime)}%` : "n/a",
      grade: summary.uptime !== null ? gradeUptime(summary.uptime) : "off",
      gradeNote: summary.uptime !== null ? `Verified nodes have been up ${Math.round(summary.uptime)}% of the time, on average. 90% or more is healthy.` : undefined,
      note: "verified nodes",
      trend: trends.uptime,
      format: (v) => `${v.toFixed(1)}%`,
      detail: () => "mean, verified nodes",
      waiting: "Collecting readings",
    },
  };
}
