"use client";

import { useState } from "react";
import {
  blockReward,
  emissionAt,
  HALVING_INTERVAL,
  SUPPLY_CAP,
  supplyCurve,
  toLax,
  WEI_PER_LAX,
} from "@/lib/emission";
import { formatInt } from "@/lib/format";
import { TARGET_BLOCK_TIME, type Charts } from "@/lib/protocol";
import { Decentralization } from "./charts";
import { useServerNow } from "./live/provider";
import { Label, Plate } from "./plate";
import { useSize } from "./use-size";

/** Halvings drawn on the supply curve; by the 8th, over 99% is issued. */
const CURVE_ERAS = 8;

const monthYear = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** formatLax shows whole LAX with separators, or the exact fraction for small amounts like rewards. */
function formatLax(wei: bigint): string {
  const whole = wei / WEI_PER_LAX;
  const fraction = (wei % WEI_PER_LAX).toString().padStart(18, "0").replace(/0+$/, "");

  return `${formatInt(Number(whole))}${fraction ? `.${fraction.slice(0, 8)}` : ""} LAX`;
}

/** formatSpan renders a rough duration: 18 hours, 12 days, 7 months, 3.4 years. */
function formatSpan(ms: number): string {
  const hours = ms / 3_600_000;

  if (hours < 48) return `${Math.max(1, Math.round(hours))} hours`;
  if (hours < 24 * 60) return `${Math.round(hours / 24)} days`;
  if (hours < 24 * 730) return `${Math.round(hours / (24 * 30.44))} months`;

  return `${(hours / (24 * 365.25)).toFixed(1)} years`;
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");

  return `${n}${suffix}`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase" title={hint}>
        {label}
      </dt>
      <dd className="font-mono text-sm tabular-nums">{value}</dd>
    </div>
  );
}

function Halving({ height }: { height: number }) {
  const now = useServerNow();
  const state = emissionAt(height);
  // ASERT adjusts difficulty every block to hold the 10 minute target, so
  // projecting at the target beats extrapolating a passing fast or slow run
  const blockSeconds = TARGET_BLOCK_TIME;
  const remainingMs = state.blocksToHalving * blockSeconds * 1000;
  const eraStart = state.era * HALVING_INTERVAL;

  return (
    <Plate as="section" aria-labelledby="halving-title" className="flex min-w-0 flex-col gap-4 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <Label as="h2">
          <span id="halving-title">Next halving</span>
        </Label>
        <span className="text-xs text-muted-foreground">the {ordinal(state.era + 1)}, at block #{formatInt(state.nextHalving)}</span>
      </div>

      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-3xl tabular-nums">{formatInt(state.blocksToHalving)}</span>
        <span className="text-sm text-muted-foreground">blocks to go</span>
      </p>

      <p className="text-sm">
        Expected around <span className="font-semibold">{monthYear.format(now + remainingMs)}</span>, in about{" "}
        {formatSpan(remainingMs)}
        <span className="block text-xs text-muted-foreground">
          at the 10 minute block time that difficulty adjustment holds
        </span>
      </p>

      <div className="flex flex-col gap-1.5">
        <div
          className="relative h-1.5 bg-border"
          role="meter"
          aria-label="Progress through the current halving era"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(state.eraProgress * 100)}
        >
          <div className="brand-gradient-mark absolute inset-y-0 left-0" style={{ width: `${state.eraProgress * 100}%` }} />
        </div>
        <div className="flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
          <span>#{formatInt(eraStart)}</span>
          <span>{(state.eraProgress * 100).toFixed(1)}% of this era mined</span>
          <span>#{formatInt(state.nextHalving)}</span>
        </div>
      </div>

      <table className="mt-auto w-full text-xs">
        <caption className="sr-only">Upcoming halvings</caption>
        <thead className="text-left text-muted-foreground">
          <tr className="border-b border-border">
            <th scope="col" className="pb-2 font-mono text-[10px] font-normal tracking-wider uppercase">Halving</th>
            <th scope="col" className="pb-2 font-mono text-[10px] font-normal tracking-wider uppercase">Block</th>
            <th scope="col" className="pb-2 text-right font-mono text-[10px] font-normal tracking-wider uppercase">
              Reward
            </th>
            <th scope="col" className="pb-2 text-right font-mono text-[10px] font-normal tracking-wider uppercase">
              Expected
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          <tr className="border-b border-border/50">
            <td className="py-1.5 text-muted-foreground">Now</td>
            <td className="py-1.5 font-mono text-muted-foreground">#{formatInt(height)}</td>
            <td className="py-1.5 text-right font-mono">{formatLax(state.reward)}</td>
            <td className="py-1.5 text-right text-muted-foreground">current</td>
          </tr>
          {[1, 2, 3].map((ahead) => {
            const at = (state.era + ahead) * HALVING_INTERVAL;

            return (
              <tr key={at} className="border-b border-border/50 last:border-b-0">
                <td className="py-1.5">{ordinal(state.era + ahead)}</td>
                <td className="py-1.5 font-mono">#{formatInt(at)}</td>
                <td className="py-1.5 text-right font-mono">{formatLax(blockReward(at))}</td>
                <td className="py-1.5 text-right">{monthYear.format(now + (at - height) * blockSeconds * 1000)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Plate>
  );
}

/** SupplyCurve draws the share of the maximum supply issued over the halvings, marking the present. */
function SupplyCurve({ height }: { height: number }) {
  const [ref, size] = useSize<HTMLDivElement>({ width: 480, height: 120 });
  const [active, setActive] = useState<number | null>(null);
  const curve = supplyCurve(CURVE_ERAS);
  const span = CURVE_ERAS * HALVING_INTERVAL;
  const { width, height: h } = size;
  const x = (blocks: number) => (Math.min(blocks, span) / span) * width;
  const y = (share: number) => 4 + (1 - share) * (h - 8);
  const points = curve.map((p) => `${x(p.height)},${y(p.share)}`).join(" ");
  const nowShare = emissionAt(height).issuedShare;
  const hovered = active !== null ? curve[active] : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex justify-between text-xs text-muted-foreground tabular-nums" aria-live="polite">
        <span>Share of the maximum supply issued</span>
        <span>
          {hovered
            ? hovered.height === 0
              ? "genesis: 0%"
              : `${ordinal(active!)} halving, #${formatInt(hovered.height)}: ${(hovered.share * 100).toFixed(2)}%`
            : `now ${(nowShare * 100).toFixed(1)}%`}
        </span>
      </div>
      <div ref={ref} className="relative min-h-28 flex-1">
        <svg
          viewBox={`0 0 ${width} ${h}`}
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
          role="img"
          aria-label={`Supply curve: ${(nowShare * 100).toFixed(1)}% of the maximum supply is issued, half by the first halving and over 99% by the ${ordinal(CURVE_ERAS)}`}
          onPointerLeave={() => setActive(null)}
        >
          {[0.5, 1].map((share) => (
            <line
              key={share}
              x1={0}
              x2={width}
              y1={y(share)}
              y2={y(share)}
              className="stroke-border"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <polygon points={`0,${y(0)} ${points} ${width},${y(0)}`} className="fill-brand-mark opacity-10" />
          <polyline
            points={points}
            fill="none"
            className="stroke-brand-mark"
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {curve.map((p, i) => (
            <circle
              key={p.height}
              cx={x(p.height)}
              cy={y(p.share)}
              r={active === i ? 4 : 2}
              className="fill-brand-mark stroke-surface-elevated"
              strokeWidth={active === i ? 2 : 0}
            />
          ))}
          <line
            x1={x(height)}
            x2={x(height)}
            y1={0}
            y2={h}
            className="stroke-foreground/50"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={x(height)} cy={y(nowShare)} r={5} className="fill-foreground stroke-surface-elevated" strokeWidth={2} />
          {curve.map((p, i) => (
            <rect
              key={p.height}
              x={x(p.height) - width / CURVE_ERAS / 2}
              y={0}
              width={width / CURVE_ERAS}
              height={h}
              fill="transparent"
              onPointerEnter={() => setActive(i)}
            />
          ))}
        </svg>
        <span className="pointer-events-none absolute top-0 left-1 font-mono text-[10px] text-muted-foreground">100%</span>
        <span
          className="pointer-events-none absolute left-1 -translate-y-full font-mono text-[10px] text-muted-foreground"
          style={{ top: y(0.5) }}
        >
          50%
        </span>
      </div>
      <div className="relative h-3 font-mono text-[10px] text-muted-foreground">
        {curve.map((p, i) => (
          <span
            key={p.height}
            className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full"
            style={{ left: `${(i / CURVE_ERAS) * 100}%` }}
          >
            {i === 0 ? "genesis" : i}
          </span>
        ))}
      </div>
      <p className="text-right font-mono text-[10px] tracking-wider text-muted-foreground uppercase">halvings</p>
    </div>
  );
}

function Emission({ height }: { height: number }) {
  const state = emissionAt(height);

  return (
    <Plate as="section" aria-labelledby="emission-title" className="flex min-w-0 flex-1 flex-col gap-4 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <Label as="h2">
          <span id="emission-title">Emission</span>
        </Label>
        <span className="text-xs text-muted-foreground">maximum {formatInt(Number(SUPPLY_CAP / WEI_PER_LAX))} LAX</span>
      </div>

      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-3xl tabular-nums">{formatInt(Math.floor(toLax(state.issued)))}</span>
        <span className="text-sm text-muted-foreground">
          LAX issued, {(state.issuedShare * 100).toFixed(1)}% of the maximum
        </span>
      </p>

      <SupplyCurve height={height} />

      <dl className="grid grid-cols-3 gap-3 border-t border-border pt-3">
        <Stat label="Issued per day" value={`${formatInt(Math.round(toLax(state.dailyIssuance)))} LAX`} />
        <Stat
          label="Supply growth, next 12 months"
          hint="A year of issuance at the current reward, against the coins issued so far, assuming 10 minute blocks."
          value={state.inflation === null ? "n/a" : `${(state.inflation * 100).toFixed(state.inflation < 0.1 ? 2 : 1)}%`}
        />
        <Stat label="Left to mine" value={`${formatInt(Math.ceil(toLax(SUPPLY_CAP - state.issued)))} LAX`} />
      </dl>
    </Plate>
  );
}

/**
 * Monetary shows the issuance schedule at the best block (when the next
 * halving lands and how much of the fixed supply exists, both following
 * from the height alone; see lib/emission) beside who is mining it.
 */
export function Monetary({ bestBlock, charts }: { bestBlock: number; charts: Charts | null }) {
  if (!bestBlock) return null;

  return (
    // Large screens pair Halving and Top miners above a full-width Emission;
    // extra-wide ones put all three in a row
    <div className="grid grid-flow-dense gap-4 lg:grid-cols-2 2xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_minmax(0,2fr)]">
      <Halving height={bestBlock} />
      <div className="flex min-w-0 lg:col-span-2 2xl:col-span-1">
        <Emission height={bestBlock} />
      </div>
      <div className="flex min-w-0 [&>*]:flex-1">
        <Decentralization charts={charts} />
      </div>
    </div>
  );
}
