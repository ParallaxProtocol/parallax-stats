"use client";

import { useState } from "react";
import type { Summary } from "@/lib/derive";
import {
  formatDifficulty,
  formatGasPrice,
  formatPoolDifficulty,
  formatHashrate,
  gradePeerLatency,
  gradeRatio,
  gradeUptime,
  type Grade,
} from "@/lib/format";
import { TREND_SLICE_S, type Charts, type Trends } from "@/lib/protocol";
import { sliceTime, Tile, TrendLine, Waiting } from "./charts";
import { Indicator } from "./indicator";

export interface Figure {
  label: string;
  value: string;
  grade?: Grade;
  note?: string;
  /** The figure over the last 7 days, one value per trend slice. */
  trend: (number | null)[];
  /** Renders a slice's value in place of the figure, while it is hovered. */
  format: (value: number) => string;
  /** Says more about a hovered slice's value, after its time. */
  detail?: (value: number) => string;
  /** Shown while no slice has a value. */
  waiting: string;
}

export type FigureKey = "hashrate" | "difficulty" | "active" | "fee" | "latency" | "uptime";

/** Gas a plain LAX transfer uses. */
const TRANSFER_GAS = 21_000n;

const significant = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

const NO_TRENDS: Trends = { start: [], blocktime: [], hashrate: [], difficulty: [], active: [], synced: [], gasPrice: [], peerLatency: [], uptime: [] };

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
        <span className="flex items-center gap-1.5">
          {figure.grade && <Indicator grade={figure.grade} />}
          {figure.label}
        </span>
      }
      readout={known.length > 0 ? "last 7 days" : undefined}
      value={active === null ? figure.value : hovered === null ? "n/a" : figure.format(hovered)}
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
}: {
  summary: Summary;
  charts: Charts | null;
  mining: bigint | null;
  gasPrice: string | null;
}): Record<FigureKey, Figure> {
  const transfer = gasPrice ? Number(BigInt(gasPrice) * TRANSFER_GAS) / 1e18 : null;
  const { bestStats } = summary;
  // A server from before the trends sends none
  const trends = charts?.trends ?? NO_TRENDS;

  return {
    hashrate: {
      label: "Network hashrate",
      value: charts?.avgHashrate ? formatHashrate(charts.avgHashrate) : "n/a",
      trend: trends.hashrate,
      format: formatHashrate,
      detail: () => "estimated",
      waiting: "Waiting for blocks",
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
      note: "in sync",
      trend: trends.active,
      format: (v) => significant.format(v),
      detail: () => "mean active nodes",
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
    latency: {
      label: "Latency",
      value: summary.peerLatency ? `${summary.peerLatency} ms` : "n/a",
      grade: gradePeerLatency(summary.peerLatency),
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
      note: "verified nodes",
      trend: trends.uptime,
      format: (v) => `${v.toFixed(1)}%`,
      detail: () => "mean, verified nodes",
      waiting: "Collecting readings",
    },
  };
}
