"use client";

import type { ReactNode } from "react";
import { stallLevel } from "@/lib/alert-levels";
import { formatClock, formatInt, gradeElapsed, survival, type Grade } from "@/lib/format";
import { TARGET_BLOCK_TIME } from "@/lib/protocol";
import { Indicator } from "./indicator";
import { useServerNow } from "./live/provider";
import { Label, Plate } from "./plate";

const VERDICT: Record<Grade, string> = {
  good: "On schedule",
  warn: "Running long",
  serious: "Unusually long",
  critical: "Possible stall",
  info: "",
  off: "Waiting for nodes",
};

/** The span of the clock track, as a multiple of the target interval. */
const SPAN = 3;

const TICKS = [
  { at: 0, label: "0" },
  { at: 1 / SPAN, label: "10 min target" },
  { at: 2 / SPAN, label: "20 min" },
  { at: 1, label: "30 min" },
];

/**
 * BlockClock leads the page: the best block and how long the network has
 * waited since, against the 10 minute target. Intervals are exponential,
 * so it also says how often a wait runs this long.
 */
/**
 * ClockPlate is the best block's plate, tinted while no block has come for
 * longer than the stall threshold. It ticks on its own, so the rest of the
 * page does not re-render every second.
 */
export function ClockPlate({ foundAt, className, children }: { foundAt: number; className?: string; children: ReactNode }) {
  const now = useServerNow();

  return (
    <Plate tone={stallLevel(foundAt, now)} className={className}>
      {children}
    </Plate>
  );
}

export function BlockClock({ bestBlock, foundAt }: { bestBlock: number; foundAt: number }) {
  const now = useServerNow();
  // Miners' clocks may run a few minutes ahead of ours
  const elapsed = foundAt ? Math.max(0, now - foundAt) : 0;
  const target = TARGET_BLOCK_TIME * 1000;
  const fill = Math.min(1, elapsed / (target * SPAN));
  const grade: Grade = foundAt ? gradeElapsed(elapsed) : "off";
  // Capped below 100 once any time has passed, so it never claims every block takes longer
  const longer = elapsed > 0 ? Math.min(99, Math.round(survival(elapsed) * 100)) : 100;

  return (
    <section aria-labelledby="clock-title" className="grid gap-x-12 gap-y-6 lg:grid-cols-[auto_1fr] lg:items-end">
      <div className="flex flex-col gap-2">
        <Label as="h2">
          <span id="clock-title">Best block</span>
        </Label>
        <p className="font-sans text-5xl font-semibold tracking-tight tabular-nums sm:text-7xl">
          {bestBlock ? formatInt(bestBlock) : "—"}
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <p className="text-lg">
            {foundAt ? (
              <>
                Found <span className="font-semibold tabular-nums">{formatClock(elapsed)}</span> ago
              </>
            ) : (
              "No block reported yet"
            )}
          </p>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Indicator grade={grade} label="" />
            <span>
              {VERDICT[grade]}
              {foundAt > 0 && (
                <span className="tabular-nums">. {longer < 1 ? "Fewer than 1%" : `${longer}%`} of blocks take longer than this.</span>
              )}
            </span>
          </p>
        </div>

        <div
          className="relative h-1.5 bg-border"
          role="meter"
          aria-label="Time since the last block"
          aria-valuemin={0}
          aria-valuemax={target * SPAN}
          aria-valuenow={Math.min(elapsed, target * SPAN)}
          aria-valuetext={`${formatClock(elapsed)} since the last block; the target is 10 minutes`}
        >
          <div
            className="brand-gradient-mark absolute inset-y-0 left-0 transition-[width] duration-1000 ease-linear"
            style={{ width: `${fill * 100}%` }}
          />
          {TICKS.slice(1, -1).map((tick) => (
            <div key={tick.at} className="absolute -inset-y-1 w-px bg-muted-foreground/60" style={{ left: `${tick.at * 100}%` }} />
          ))}
        </div>
        <div className="relative h-4 font-mono text-[11px] text-muted-foreground">
          {TICKS.map((tick) => (
            <span
              key={tick.at}
              className="absolute -translate-x-1/2 whitespace-nowrap first:translate-x-0 last:-translate-x-full"
              style={{ left: `${tick.at * 100}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
