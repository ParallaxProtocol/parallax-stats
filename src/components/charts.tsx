"use client";

import { createContext, use, useEffect, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { blockReward, WEI_PER_LAX } from "@/lib/emission";
import { formatBlockTime, formatCompact, formatInt, formatMs, formatPercent, gradeAvgBlockTime, shortHash, type Grade } from "@/lib/format";
import { HISTORY_BINS, TARGET_BLOCK_TIME, TREND_SLICE_S, type Charts, type MinerCount, type PropagationStats } from "@/lib/protocol";
import { majority as majorityHeld, majorityLevel, spreadLevel, type Level } from "@/lib/alert-levels";
import { DECENTRALIZATION_MIN_BLOCKS, gradeDecentralization, majorityHolders } from "@/lib/decentralization";
import { Indicator } from "./indicator";
import { Label, Plate } from "./plate";
import { Tooltip } from "./tooltip";
import { useSize } from "./use-size";

/** Smallest plot height; plots grow to fill their tile when the row is taller. */
const MIN_PLOT = 72;
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 3;

/**
 * Tile is the shared anatomy of every chart: a label with a readout on
 * the right, a headline figure, and a body that fills the rest of the
 * tile, so tiles in a row line up whatever they contain.
 */
export function Tile({
  title,
  readout,
  value,
  qualifier,
  tone,
  className = "",
  children,
}: {
  title: ReactNode;
  readout?: ReactNode;
  value?: ReactNode;
  qualifier?: ReactNode;
  /** Tints the tile while a warning about it applies. */
  tone?: Level | null;
  /** Placement classes, for a tile in a grid. */
  className?: string;
  children: ReactNode;
}) {
  const block = use(BestBlock);
  // The block on first render: a tile only flashes for blocks that arrive while it is shown
  const [first] = useState(block);

  return (
    <Plate as="figure" tone={tone} className={`flex min-w-0 flex-col gap-3 p-5 ${className}`}>
      {block !== first && <span key={block} aria-hidden className="tile-flash" />}
      <figcaption className="flex items-baseline justify-between gap-3">
        <Label className="whitespace-nowrap">{title}</Label>
        <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {readout}
        </span>
      </figcaption>
      {value !== undefined && (
        // A fixed height, whatever they say, so hovering a chart never resizes it: one line
        // for the figure and two for its note, enough for the longest readouts
        <p className="flex min-w-0 flex-col gap-1">
          {/* Its clipping box reaches a little past each side, so a verdict's pulsing dot is never cut off */}
          <span className="-mx-2 truncate px-2 text-3xl tabular-nums">{value}</span>
          <span className="line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">{qualifier}</span>
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </Plate>
  );
}

/** BestBlock carries the best block to every tile, so each can flash when a new one lands. */
export const BestBlock = createContext(0);

export function Waiting({ children = "Waiting for blocks" }: { children?: ReactNode }) {
  return <p className="flex flex-1 items-center text-sm text-muted-foreground">{children}</p>;
}

/** barPath draws a column with a rounded data end and a square base. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h);

  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

interface PlotProps {
  values: number[];
  active: number | null;
  onActive: (index: number | null) => void;
  /** What the plot shows, for screen readers. */
  label: string;
}

/** useSeen turns true once the element first scrolls into view, and stays true. */
export function useSeen(ref: RefObject<Element | null>): boolean {
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;

    if (!el || seen) return;

    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setSeen(true), { rootMargin: "0px 0px -10% 0px" });

    observer.observe(el);

    return () => observer.disconnect();
  }, [ref, seen]);

  return seen;
}

/**
 * scrubIndex maps a pointer's x position across an element to one of `count` slots.
 * Touch pointers are captured by the element they first land on, so per-slot
 * pointerenter targets never fire while a finger drags; reading the position does.
 */
export function scrubIndex(event: PointerEvent<Element>, count: number, centered = false): number | null {
  if (count <= 0) return null;

  const rect = event.currentTarget.getBoundingClientRect();
  const fraction = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
  const index = centered ? Math.round(fraction * (count - 1)) : Math.floor(fraction * count);

  return Math.min(count - 1, Math.max(0, index));
}

/** Plot sizes an SVG to fill the space left in its tile and gives every slot a hover target. */
function Plot({
  values,
  onActive,
  label,
  children,
}: Omit<PlotProps, "active" | "values"> & {
  /** One per slot; only how many matters here. */
  values: readonly unknown[];
  children: (size: { width: number; height: number }, slot: number) => ReactNode;
}) {
  const [ref, size] = useSize<HTMLDivElement>({ width: 320, height: MIN_PLOT });
  const seen = useSeen(ref);
  const slot = values.length > 0 ? size.width / values.length : size.width;

  return (
    <div ref={ref} className="relative min-w-0 flex-1" style={{ minHeight: MIN_PLOT }}>
      <svg
        viewBox={`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="none"
        className={`absolute inset-0 block size-full touch-pan-y overflow-visible select-none [-webkit-touch-callout:none] ${
          seen ? "chart-reveal" : "chart-pending"
        }`}
        role="img"
        aria-label={label}
        onPointerDown={(e) => onActive(scrubIndex(e, values.length))}
        onPointerMove={(e) => onActive(scrubIndex(e, values.length))}
        onPointerLeave={() => onActive(null)}
        onPointerCancel={() => onActive(null)}
      >
        {children(size, slot)}
      </svg>
    </div>
  );
}

/** Bars grow from a zero baseline, so they suit counts and shares. */
function Bars({
  values,
  active,
  onActive,
  label,
  max,
  reference,
  track = false,
}: PlotProps & {
  max?: number;
  reference?: { value: number; label: string };
  /** Draw each bar's full-scale track behind it, for shares of a capacity. */
  track?: boolean;
}) {
  const top = max ?? Math.max(reference?.value ?? 0, ...values, 1e-9);

  return (
    <Plot values={values} onActive={onActive} label={label}>
      {({ width, height }, slot) => {
        const bar = Math.max(1, Math.min(MAX_BAR, slot - GAP));
        const y = (v: number) => height - (Math.min(Math.max(0, v), top) / top) * (height - 2);

        return (
          <>
            {/* A baseline, so a block with none reads as zero rather than a gap */}
            {!track && (
              <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
            {values.map((v, i) => {
              const yTop = y(v);

              const x = i * slot + (slot - bar) / 2;

              return (
                <g key={i}>
                  {track && <path d={barPath(x, 2, bar, height - 2)} className="fill-border" />}
                  <path
                    d={barPath(x, yTop, bar, Math.max(height - yTop, v > 0 ? 1 : 0))}
                    className={active === null || active === i ? "fill-brand-mark" : "fill-brand-mark opacity-35"}
                  />
                </g>
              );
            })}
            {reference && (
              <>
                <line
                  x1={0}
                  x2={width}
                  y1={y(reference.value)}
                  y2={y(reference.value)}
                  className="stroke-muted-foreground"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <foreignObject x={0} y={Math.max(0, y(reference.value) - 18)} width={width} height={16}>
                  <span className="float-right bg-surface-elevated/85 px-1 font-mono text-[10px] text-muted-foreground">
                    {reference.label}
                  </span>
                </foreignObject>
              </>
            )}
          </>
        );
      }}
    </Plot>
  );
}

/**
 * TrendLine plots a level that moves within a narrow band, like difficulty,
 * on a scale fitted to its range so small changes stay visible. A null
 * value leaves its slot empty and breaks the line, so missing data never
 * reads as a change.
 */
export function TrendLine({
  values,
  active,
  onActive,
  label,
  format,
  partial = false,
}: Omit<PlotProps, "values"> & {
  values: (number | null)[];
  /** Labels the scale's highest and lowest values at the plot's edge. */
  format?: (value: number) => string;
  /** The last value is still being counted: the line into it is dashed, and it is left out of the labelled range. */
  partial?: boolean;
}) {
  const known = values.filter((v): v is number => v !== null);
  const counted = (partial ? values.slice(0, -1) : values).filter((v): v is number => v !== null);
  // The labelled range leaves out a partial value; the scale still fits it
  const max = counted.length > 0 ? Math.max(...counted) : Math.max(...known);
  const min = counted.length > 0 ? Math.min(...counted) : Math.min(...known);
  const top = Math.max(max, ...known);
  const bottom = Math.min(min, ...known);
  const pad = (top - bottom) * 0.15 || Math.abs(top) * 0.01 || 1;
  // A single reading makes no line yet: it is drawn level, dashed, until a second arrives
  const sparse = known.length < 2;
  // Runs of consecutive known values, each drawn as its own line
  const runs: number[][] = [];

  values.forEach((v, i) => {
    if (v === null) return;
    if (i > 0 && values[i - 1] !== null) runs.at(-1)!.push(i);
    else runs.push([i]);
  });

  const latest = runs.at(-1)?.at(-1) ?? null;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Plot values={values} onActive={onActive} label={label}>
        {({ width, height }, slot) => {
          const x = (i: number) => i * slot + slot / 2;
          const y = (v: number) => 6 + (1 - (v - (bottom - pad)) / (top + pad - (bottom - pad))) * (height - 12);
          const focus = active !== null && values[active] !== null ? active : active === null ? latest : null;
          // While scrubbing, the range steps back unless the point under the pointer is that extreme
          const faded = (v: number) => active !== null && values[active] !== v;

          return (
            <>
              {sparse && latest !== null && (
                <line
                  x1={0}
                  x2={width}
                  y1={y(values[latest]!)}
                  y2={y(values[latest]!)}
                  className="stroke-brand-mark opacity-40"
                  strokeWidth={1.5}
                  strokeDasharray="3 5"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {!sparse && format && max > min && (
                // Guides from the range labels across to the points they name
                <g aria-hidden className="pointer-events-none stroke-muted-foreground">
                  {[max, min].map((v) => (
                    <line
                      key={v}
                      className={`transition-opacity duration-150 ${faded(v) ? "opacity-20" : "opacity-50"}`}
                      x1={0}
                      x2={x(values.indexOf(v))}
                      y1={y(v)}
                      y2={y(v)}
                      strokeWidth={1}
                      strokeDasharray="2 3"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </g>
              )}
              {!sparse &&
                runs.map((run) => {
                  const point = (i: number) => `${x(i)},${y(values[i]!)}`;
                  const points = run.map(point).join(" ");
                  // The segment into a value still being counted is drawn dashed
                  const open = partial && run.length > 1 && run.at(-1) === values.length - 1;
                  const solid = open ? run.slice(0, -1) : run;

                  return (
                    <g key={run[0]}>
                      <polygon points={`${x(run[0])},${height} ${points} ${x(run.at(-1)!)},${height}`} className="fill-brand-mark opacity-10" />
                      <polyline
                        points={solid.map(point).join(" ")}
                        fill="none"
                        className="stroke-brand-mark"
                        strokeWidth={2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                      {open && (
                        <polyline
                          points={run.slice(-2).map(point).join(" ")}
                          fill="none"
                          className="stroke-brand-mark"
                          strokeWidth={2}
                          strokeDasharray="3 4"
                          strokeLinecap="round"
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                    </g>
                  );
                })}
              {active !== null && (
                <line
                  x1={x(active)}
                  x2={x(active)}
                  y1={0}
                  y2={height}
                  className="stroke-muted-foreground"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {focus !== null && (
                <circle cx={x(focus)} cy={y(values[focus]!)} r={4} className="fill-brand-mark stroke-surface-elevated" strokeWidth={2} />
              )}
              {!sparse && format && max > min && (
                // The scale's range beside its highest and lowest points, so a small swing and a large one never look alike
                <g aria-hidden className="pointer-events-none fill-muted-foreground font-mono text-[10px] tabular-nums">
                  <text x={0} y={y(max)} dy={-6} className={`transition-opacity duration-150 ${faded(max) ? "opacity-40" : ""}`}>
                    {format(max)}
                  </text>
                  <text x={0} y={y(min)} dy={13} className={`transition-opacity duration-150 ${faded(min) ? "opacity-40" : ""}`}>
                    {format(min)}
                  </text>
                </g>
              )}
            </>
          );
        }}
      </Plot>
    </div>
  );
}

// The tiles

const average = (values: number[]) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/** sliceTime names a trend slice in the viewer's time zone, like Sat 16:00–20:00. Readouts only, so never server rendered. */
export function sliceTime(start: number): string {
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

  return `${day.format(start * 1000)} ${time.format(start * 1000)}–${time.format((start + TREND_SLICE_S) * 1000)}`;
}

/** Switch picks one of a few views of a tile, in the tile's header. */
export function Switch<T extends string>({ options, value, onChange, label }: { options: [T, string][]; value: T; onChange: (value: T) => void; label: string }) {
  return (
    <span role="group" aria-label={label} className="-my-1 inline-flex shrink-0 border border-border">
      {options.map(([key, text]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => onChange(key)}
          className={`px-1.5 py-0.5 font-mono text-[10px] tracking-wider uppercase transition-colors ${value === key ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {text}
        </button>
      ))}
    </span>
  );
}

type Period = "week" | "blocks";

/** usePeriod is a tile's choice between its 7 day trend and its last blocks, and the point hovered in it. */
function usePeriod() {
  const [view, setView] = useState<Period>("week");
  const [active, setActive] = useState<number | null>(null);
  const choose = (next: Period) => {
    setActive(null);
    setView(next);
  };

  return { view, choose, active, setActive };
}

function PeriodSwitch({ value, onChange }: { value: Period; onChange: (value: Period) => void }) {
  return (
    <Switch
      label="Period"
      options={[
        ["week", "7 days"],
        ["blocks", `${HISTORY_BINS} blocks`],
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

/** lastWeek names the blocks the 7 day figures cover: the last 7 days, or all of them while the history is shorter. */
function lastWeek(c: Charts): string {
  return c.minerSpan >= 7 * 86_400 - 3_600 ? "the last 7 days" : `the last ${formatInt(c.minerBlocks)} blocks`;
}

/**
 * BlockTime leads with the mean time between blocks over the last 7 days,
 * and shows either its 7 day trend or each of the last 40 blocks against
 * the target.
 */
export function BlockTime({ c, block }: { c: Charts; block: (i: number) => string }) {
  const { view, choose, active, setActive } = usePeriod();
  // A server from before the trends sends none
  const trend = c.trends?.blocktime ?? [];
  const start = c.trends?.start ?? [];
  const knownTrend = trend.filter((v): v is number => v !== null);
  // A zero time means the block's parent was not recorded
  const recent = average(c.blocktime.filter((t) => t > 0));
  // What the indicator grades: how far the 7 day mean is off the target, beyond 10% a warning
  const off = c.avgBlocktime ? Math.round(((c.avgBlocktime - TARGET_BLOCK_TIME) / TARGET_BLOCK_TIME) * 100) : null;
  const pace =
    off === null || !c.minerBlocks
      ? null
      : `Mean of ${lastWeek(c)} is ${off === 0 ? "on" : `${Math.abs(off)}% ${off > 0 ? "slower" : "faster"} than`} the 10 min target. Within 10% is healthy.`;

  let value: string | undefined;
  let qualifier: string;

  if (view === "week") {
    const hovered = active !== null ? trend[active] : null;

    value = active !== null ? (hovered === null ? "n/a" : formatBlockTime(hovered)) : formatBlockTime(c.avgBlocktime);
    qualifier =
      active !== null && start[active] !== undefined
        ? `${sliceTime(start[active])}, ${hovered === null ? "no data" : "mean over the 24 hours to its end"}`
        : !c.minerBlocks
          ? "target 10 min"
          : `mean of ${lastWeek(c)}, target 10 min`;
  } else {
    value =
      active !== null ? (c.blocktime[active] ? formatBlockTime(c.blocktime[active]) : "unknown") : c.height.length ? formatBlockTime(recent) : undefined;
    qualifier =
      active !== null
        ? `block ${block(active)}${c.blocktime[active] ? "" : ", parent not recorded"}`
        : `mean of these ${c.height.length}, target 10 min`;
  }

  return (
    <Tile
      title={
        <Tooltip content={pace}>
          <span className="flex items-center gap-1.5">
            {c.height.length > 0 && <Indicator grade={gradeAvgBlockTime(c.avgBlocktime)} label={pace ?? undefined} />}
            Block time
          </span>
        </Tooltip>
      }
      readout={<PeriodSwitch value={view} onChange={choose} />}
      value={value}
      qualifier={qualifier}
    >
      {view === "week" ? (
        knownTrend.length === 0 ? (
          <Waiting />
        ) : (
          <TrendLine
            values={trend}
            active={active}
            onActive={setActive}
            format={formatBlockTime}
            label={`Mean block time over the 24 hours to the end of each ${TREND_SLICE_S / 3600} hour slice of the last 7 days, from ${formatBlockTime(Math.min(...knownTrend))} to ${formatBlockTime(Math.max(...knownTrend))}`}
          />
        )
      ) : c.height.length === 0 ? (
        <Waiting />
      ) : (
        <Bars
          values={c.blocktime}
          active={active}
          onActive={setActive}
          reference={{ value: TARGET_BLOCK_TIME, label: "10 min target" }}
          label={`Time between each of the last ${c.height.length} blocks, against the 10 minute target`}
        />
      )}
    </Tile>
  );
}

/**
 * Transactions leads with how many the last 7 days of blocks held, and
 * shows either each 4 hour slice of them, the one in progress dashed, or
 * each of the last 40 blocks.
 */
export function Transactions({ c, block }: { c: Charts; block: (i: number) => string }) {
  const { view, choose, active, setActive } = usePeriod();
  // A server from before the transaction trend sends none
  const trend = c.trends?.transactions ?? [];
  const start = c.trends?.start ?? [];
  const knownTrend = trend.filter((v): v is number => v !== null);
  const noun = (n: number) => (n === 1 ? "transaction" : "transactions");

  let value: string | undefined;
  let qualifier: string;

  if (view === "week") {
    const hovered = active !== null ? trend[active] : null;
    const total = c.weekTransactions ?? 0;

    value = active !== null ? (hovered === null ? "n/a" : formatInt(hovered)) : c.minerBlocks ? formatInt(total) : undefined;
    qualifier =
      active !== null && start[active] !== undefined
        ? hovered === null
          ? `${sliceTime(start[active])}, no data`
          : `${noun(hovered)}, ${sliceTime(start[active])}${active === trend.length - 1 ? " so far" : ""}`
        : `${noun(total)} in ${lastWeek(c)}`;
  } else {
    const total = c.transactions.reduce((a, b) => a + b, 0);

    value = active !== null ? formatInt(c.transactions[active]) : c.height.length ? formatInt(total) : undefined;
    qualifier =
      active !== null ? `${noun(c.transactions[active])} in block ${block(active)}` : `${noun(total)} in the last ${c.height.length} blocks`;
  }

  return (
    <Tile
      title="Transactions"
      readout={<PeriodSwitch value={view} onChange={choose} />}
      value={value}
      qualifier={qualifier}
    >
      {view === "week" ? (
        knownTrend.length === 0 ? (
          <Waiting />
        ) : (
          <TrendLine
            values={trend}
            active={active}
            onActive={setActive}
            format={formatInt}
            partial
            label={`Transactions in each ${TREND_SLICE_S / 3600} hour slice of the last 7 days, the last still in progress, from ${formatInt(Math.min(...knownTrend))} to ${formatInt(Math.max(...knownTrend))}`}
          />
        )
      ) : c.height.length === 0 ? (
        <Waiting />
      ) : (
        <Bars
          values={c.transactions}
          active={active}
          onActive={setActive}
          label={`Transactions in each of the last ${c.height.length} blocks`}
        />
      )}
    </Tile>
  );
}

/**
 * Fullness shows how much of the gas limit blocks used, on average over the
 * last 7 days, and either its 7 day trend or each of the last 40 blocks.
 */
export function Fullness({ c, block }: { c: Charts; block: (i: number) => string }) {
  const { view, choose, active, setActive } = usePeriod();
  const fullness = c.gasSpending.map((used, i) => (c.gasLimit[i] > 0 ? used / c.gasLimit[i] : 0));
  const pct = formatPercent;
  // A server from before the fullness trend sends none
  const trend = c.trends?.fullness ?? [];
  const start = c.trends?.start ?? [];
  const knownTrend = trend.filter((v): v is number => v !== null);

  let value: string | undefined;
  let qualifier: string;

  if (view === "week") {
    const hovered = active !== null ? trend[active] : null;

    value = active !== null ? (hovered === null ? "n/a" : pct(hovered)) : c.minerBlocks ? pct(c.weekFullness ?? 0) : undefined;
    qualifier =
      active !== null && start[active] !== undefined
        ? `${sliceTime(start[active])}, ${hovered === null ? "no data" : `full on average${active === trend.length - 1 ? " so far" : ""}`}`
        : `full on average over ${lastWeek(c)}`;
  } else {
    value = active !== null ? pct(fullness[active]) : c.height.length ? pct(average(fullness)) : undefined;
    qualifier =
      active !== null
        ? `block ${block(active)}, ${formatCompact(c.gasSpending[active])} of ${formatCompact(c.gasLimit[active])} gas`
        : `full on average over the last ${c.height.length} blocks`;
  }

  return (
    <Tile title="Block fullness" readout={<PeriodSwitch value={view} onChange={choose} />} value={value} qualifier={qualifier}>
      {view === "week" ? (
        knownTrend.length === 0 ? (
          <Waiting />
        ) : (
          <TrendLine
            values={trend}
            active={active}
            onActive={setActive}
            format={pct}
            partial
            label={`Mean share of the gas limit used by the blocks of each ${TREND_SLICE_S / 3600} hour slice of the last 7 days, the last still in progress, from ${pct(Math.min(...knownTrend))} to ${pct(Math.max(...knownTrend))}`}
          />
        )
      ) : c.height.length === 0 ? (
        <Waiting />
      ) : (
        <Bars
          values={fullness}
          max={1}
          track
          active={active}
          onActive={setActive}
          label={`Gas used as a share of the gas limit in each of the last ${c.height.length} blocks, on a scale to 100%`}
        />
      )}
    </Tile>
  );
}

/** The speed bands, in the order of PROPAGATION_BANDS in lib/protocol. */
const BANDS = [
  { label: "Under 5 s", swatch: "bg-good" },
  { label: "5–15 s", swatch: "bg-warn" },
  { label: "15–60 s", swatch: "bg-serious" },
  { label: "60 s or more", swatch: "bg-critical" },
];

/** share formats a fraction as a percentage that never rounds a nonzero part to 0% or a partial whole to 100%. */
function share(part: number, total: number): string {
  if (total === 0 || part === 0) return "0%";
  if (part === total) return "100%";

  const pct = (part / total) * 100;

  if (pct < 1) return "<1%";
  if (pct > 99) return ">99%";

  return `${Math.round(pct)}%`;
}

/**
 * Propagation shows how quickly blocks reach verified nodes. It leads with
 * how long recent blocks took to reach 90% of them, the figure its colour
 * and the slow propagation alert grade, or, with too few verified reports
 * for that, the share of reports within 5 s. Delays are heavily skewed
 * (nearly all arrive within a second), so instead of a histogram on a
 * linear axis it splits the verified reports into speed bands, and gives
 * the tail as percentiles.
 */
export function Propagation({ stats }: { stats: PropagationStats }) {
  const { samples, bands, spread } = stats;
  // Keeps a small nonzero band visible in the bar
  const minWidth = 3;
  // A band hovered in the bar or the list lights up in both, as in the decentralization donut
  const [active, setActive] = useState<number | null>(null);

  return (
    <Tile
      tone={spreadLevel(stats)}
      title="Propagation"
      readout={samples ? `${formatInt(samples)} reports` : undefined}
      value={spread ? formatMs(spread.median) : samples ? share(bands[0], samples) : undefined}
      qualifier={spread ? "to reach 90% of verified nodes" : "reached verified nodes within 5 s"}
    >
      {samples === 0 ? (
        <Waiting>Waiting for blocks to reach a second verified node</Waiting>
      ) : (
        <div className="flex flex-1 flex-col justify-between gap-3">
          <div
            role="img"
            aria-label={BANDS.map((band, i) => `${band.label}: ${bands[i]} reports`).join(", ")}
            className="flex h-3.5 w-full items-center gap-0.5"
          >
            {BANDS.map((band, i) =>
              bands[i] > 0 ? (
                <Tooltip key={band.label} content={`${band.label}: ${formatInt(bands[i])} (${share(bands[i], samples)})`}>
                  <div
                    className={`${band.swatch} rounded-[3px] transition-[height,opacity] duration-150 ${active === i ? "h-3.5" : "h-2.5"} ${
                      active === null || active === i ? "" : "opacity-35"
                    }`}
                    style={{ flexGrow: bands[i], flexBasis: 0, minWidth }}
                    onPointerEnter={() => setActive(i)}
                    onPointerLeave={() => setActive(null)}
                  />
                </Tooltip>
              ) : null,
            )}
          </div>

          <ul className="grid grid-cols-2 gap-x-5 gap-y-0.5">
            {BANDS.map((band, i) => (
              <li
                key={band.label}
                className={`-mx-2 flex items-baseline gap-2 rounded-sm px-2 py-1 text-xs transition-[background-color,opacity] duration-150 ${
                  active === i ? "bg-foreground/8" : active === null ? "" : "opacity-35"
                }`}
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive(null)}
              >
                <span
                  aria-hidden
                  className={`size-2 shrink-0 rounded-[2px] transition-transform duration-150 ${band.swatch} ${active === i ? "scale-125" : ""}`}
                />
                <span className={`truncate ${active === i ? "text-foreground" : "text-muted-foreground"}`}>{band.label}</span>
                <span className="ml-auto tabular-nums whitespace-nowrap">
                  {active === i && <span className="mr-2 text-muted-foreground">{formatInt(bands[i])}</span>}
                  {share(bands[i], samples)}
                </span>
              </li>
            ))}
          </ul>

          <dl className="grid grid-cols-3 gap-2 border-t border-border pt-3 text-xs">
            {(
              [
                ["Median", stats.p50],
                ["90th pct", stats.p90],
                ["99th pct", stats.p99],
              ] as const
            ).map(([label, ms]) => (
              <div key={label} className="flex flex-col gap-0.5">
                <dt className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">{label}</dt>
                <dd className="font-mono tabular-nums">{formatMs(ms)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </Tile>
  );
}

const significant = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

/** formatSmallLax renders a fee-sized amount of LAX to three significant digits: 0.000441. */
export function formatSmallLax(lax: number): string {
  if (lax === 0) return "0";
  if (lax >= 1) return lax.toFixed(lax >= 100 ? 0 : 2);

  return significant.format(lax);
}

/** formatSmallShare renders a small percentage without rounding a nonzero share to 0. */
function formatSmallShare(fraction: number): string {
  const pct = fraction * 100;

  if (pct === 0) return "0%";
  if (pct < 0.001) return "<0.001%";

  return `${significant.format(pct)}%`;
}

/**
 * Fees shows the transaction fees each block paid its miner, and how they
 * compare with the block reward, which shrinks with every halving: on
 * average over the last 7 days, and either its 7 day trend or each of the
 * last 40 blocks. Blocks reported by parallaxd versions that do not send
 * fees show as unknown, never as zero.
 */
export function Fees({ c, block }: { c: Charts; block: (i: number) => string }) {
  const { view, choose, active, setActive } = usePeriod();
  const toLax = (wei: number) => wei / Number(WEI_PER_LAX);
  const lax = c.fees.map((fees) => (fees === null ? null : Number(BigInt(fees)) / Number(WEI_PER_LAX)));
  const known = lax.flatMap((fees, i) => (fees === null ? [] : [i]));
  // A server from before the fee trend sends none
  const trend = (c.trends?.fees ?? []).map((wei) => (wei === null ? null : toLax(wei)));
  const start = c.trends?.start ?? [];
  const knownTrend = trend.filter((v): v is number => v !== null);
  const ofReward = (fees: number, reward: number) => `${formatSmallShare(reward > 0 ? fees / reward : 0)} of the block reward`;

  let value: string | undefined;
  let qualifier: string | undefined;
  let waiting = false;

  if (view === "week") {
    const hovered = active !== null ? trend[active] : null;
    const weekFees = c.weekFees ?? null;
    const reported = c.weekFeeBlocks ?? 0;
    // The reward at the best block: a halving falls inside a week only every four years
    const reward = c.height.length ? Number(blockReward(c.height.at(-1)!)) / Number(WEI_PER_LAX) : 0;

    waiting = knownTrend.length === 0;
    value = active !== null ? (hovered === null ? "n/a" : formatSmallLax(hovered)) : weekFees !== null ? formatSmallLax(toLax(weekFees)) : undefined;
    qualifier =
      active !== null && start[active] !== undefined
        ? hovered === null
          ? `${sliceTime(start[active])}, not reported`
          : `LAX per block, ${sliceTime(start[active])}${active === trend.length - 1 ? " so far" : ""}`
        : weekFees !== null
          ? `LAX per block over ${lastWeek(c)}, ${ofReward(toLax(weekFees), reward)}${
              reported < c.minerBlocks ? `, ${formatInt(reported)} of ${formatInt(c.minerBlocks)} blocks reported` : ""
            }`
          : undefined;
  } else {
    const avg = average(known.map((i) => lax[i]!));
    const avgReward = average(known.map((i) => Number(blockReward(c.height[i])) / Number(WEI_PER_LAX)));

    waiting = known.length === 0;
    value =
      active !== null ? (lax[active] === null ? "not reported" : formatSmallLax(lax[active]!)) : known.length ? formatSmallLax(avg) : undefined;
    qualifier =
      active !== null
        ? lax[active] === null
          ? `block ${block(active)}`
          : `LAX in block ${block(active)}, ${formatInt(c.transactions[active])} transactions`
        : known.length
          ? `LAX per block, ${ofReward(avg, avgReward)}${known.length < c.height.length ? `, ${known.length} of ${c.height.length} blocks reported` : ""}`
          : undefined;
  }

  return (
    <Tile title="Fees" readout={<PeriodSwitch value={view} onChange={choose} />} value={value} qualifier={qualifier}>
      {waiting ? (
        <Waiting>Fees appear once nodes run a parallaxd version that reports them</Waiting>
      ) : view === "week" ? (
        <TrendLine
          values={trend}
          active={active}
          onActive={setActive}
          format={formatSmallLax}
          partial
          label={`Mean transaction fees per block paid to miners in each ${TREND_SLICE_S / 3600} hour slice of the last 7 days, the last still in progress, from ${formatSmallLax(Math.min(...knownTrend))} to ${formatSmallLax(Math.max(...knownTrend))} LAX`}
        />
      ) : (
        <Bars
          values={lax.map((fees) => fees ?? 0)}
          active={active}
          onActive={setActive}
          label={`Transaction fees paid to the miner of each of the last ${c.height.length} blocks`}
        />
      )}
    </Tile>
  );
}

const MINING_POOL_STATS = "https://miningpoolstats.stream/parallax";

/**
 * MinerCall heads the mining section while one miner holds a majority of
 * the last week's blocks: miners are the only ones who can fix that, so it
 * asks them plainly, with the way to do it one click away.
 */
export function MinerCall({ charts }: { charts: Charts | null }) {
  const held = majorityHeld(charts);

  if (!held) return null;

  const { miner: top, share } = held;
  const who = top.pool?.name ?? `Miner ${shortHash(top.miner)}`;

  return (
    <section
      aria-labelledby="miner-call"
      className="relative flex flex-col gap-4 border border-critical/35 bg-linear-to-r from-critical/[0.11] via-critical/[0.04] to-transparent px-5 py-5 sm:flex-row sm:items-center sm:gap-8 sm:px-6"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-critical" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="font-mono text-[10px] tracking-[0.15em] text-critical-ink uppercase">
          Critical <span className="text-muted-foreground/60">·</span> For miners
        </p>
        <h3 id="miner-call" className="text-lg leading-6 font-semibold text-balance sm:text-xl">
          If you mine LAX, move your hashrate to a smaller pool.
        </h3>
        <p className="text-sm leading-5 text-muted-foreground">
          {who} found {Math.round(share * 100)}% of the last week&apos;s blocks. With most of the hashrate, one{" "}
          {top.pool ? "pool" : "miner"} could reverse payments or censor transactions, and only miners moving elsewhere can
          change that.
        </p>
      </div>
      <a
        href={MINING_POOL_STATS}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-10 shrink-0 items-center justify-center gap-2 bg-foreground px-4 text-sm font-semibold whitespace-nowrap text-background transition-opacity hover:opacity-90 active:translate-y-px"
      >
        Find a smaller pool
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
          <path d="M6 3.5h6.5V10M12.5 3.5 4 12" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </a>
    </section>
  );
}

/** Miners named in the chart; the rest are drawn together as other miners. */
const SHOWN_MINERS = 7;

/**
 * Slice colours: the brand teal, stepping toward the surface by rank, so
 * the largest miner is the strongest and none borrow a status colour.
 * Other miners are neutral.
 */
const SLICE_STRENGTH = [100, 68, 46, 33, 25, 19, 15];

/** A warning's ink, for what causes it and the note to act on it: amber for a warning, red for a critical one. */
export const ALERT_INK: Record<Level, string> = {
  warn: "text-warn-ink",
  critical: "text-critical-ink",
};
/** The row of what causes a warning, tinted and outlined in its color. */
export const CAUSE_ROW: Record<Level, string> = {
  warn: "bg-warn/[0.12] ring-1 ring-inset ring-warn/35",
  critical: "bg-critical/[0.12] ring-1 ring-inset ring-critical/35",
};
/** The verdict's dot pulses for any grade short of healthy. */
const PING: Partial<Record<Grade, string>> = { warn: "bg-warn", serious: "bg-serious", critical: "bg-critical" };

/** Verdict is a tile's graded figure: its status dot, pulsing when it is short of healthy, then the words. */
export function Verdict({ grade, children }: { grade: Grade; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="relative inline-flex size-2.5">
        {PING[grade] && <span aria-hidden className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:hidden ${PING[grade]}`} />}
        <Indicator grade={grade} label="" className="relative size-2.5" />
      </span>
      {children}
    </span>
  );
}

/** MinerAddress shortens an address to its ends, short enough for the list never to cut it again. */
function MinerAddress({ address, muted }: { address: string; muted: boolean }) {
  const hex = address.startsWith("0x") ? address.slice(2) : address;

  return (
    <Tooltip content={<span className="font-mono break-all">{address}</span>}>
      <span className={`flex min-w-0 font-mono ${muted ? "text-muted-foreground" : ""}`}>
        <span className="whitespace-nowrap">
          {hex.slice(0, 4)}…{hex.slice(-4)}
        </span>
      </span>
    </Tooltip>
  );
}

function sliceColor(rank: number | null): string {
  return rank === null
    ? "color-mix(in oklch, var(--muted-foreground) 45%, var(--card))"
    : `color-mix(in oklch, var(--brand-mark) ${SLICE_STRENGTH[rank]}%, var(--card))`;
}

interface Slice {
  key: string;
  label: string;
  pool: MinerCount["pool"];
  miner: string | null;
  blocks: number;
  color: string;
}

/** Donut draws each slice as an arc of one ring, with a surface gap between slices. */
function Donut({
  slices,
  total,
  active,
  onActive,
  half = null,
}: {
  slices: Slice[];
  total: number;
  active: string | null;
  onActive: (key: string | null) => void;
  /** Marks the halfway point across the ring, in the warning's color, while the largest miners hold a majority. */
  half?: Level | null;
}) {
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const gap = slices.length > 1 ? 1.5 : 0;
  // Where each slice starts along the ring
  const starts = slices.map((_, i) => slices.slice(0, i).reduce((sum, s) => sum + (s.blocks / total) * circumference, 0));

  return (
    <svg viewBox="0 0 120 120" className="size-32 shrink-0 -rotate-90 sm:size-36 xl:size-44" role="img" aria-label="Share of recent blocks by miner">
      {slices.map((slice, i) => {
        const length = (slice.blocks / total) * circumference;

        return (
          <Tooltip key={slice.key} content={`${slice.label}: ${slice.blocks} of ${total} blocks`}>
            <circle
              cx="60"
              cy="60"
              r={radius}
              fill="none"
              stroke={slice.color}
              strokeWidth={active === slice.key ? 20 : 16}
              strokeDasharray={`${Math.max(0, length - gap)} ${circumference}`}
              strokeDashoffset={-starts[i]}
              className="transition-[stroke-width,opacity] duration-150"
              opacity={active === null || active === slice.key ? 1 : 0.35}
              onPointerEnter={() => onActive(slice.key)}
              onPointerLeave={() => onActive(null)}
            />
          </Tooltip>
        );
      })}
      {half && (
        // Halfway round from the top is the bottom: the ring is drawn turned a quarter back, so that is its left
        <g className={ALERT_INK[half]} aria-hidden>
          <line x1={60 - radius + 12} y1="60" x2={60 - radius - 10} y2="60" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 1.5" />
          <text x={60 - radius + 15} y="60" fill="currentColor" fontSize="7" textAnchor="middle" dominantBaseline="central" transform={`rotate(90 ${60 - radius + 15} 60)`} className="font-mono">
            50%
          </text>
        </g>
      )}
    </svg>
  );
}

/**
 * Decentralization grades how spread out mining is: how few miners hold a
 * majority of recent blocks, each one's share in a donut, and the largest
 * miners by name. A known pool's addresses count as one miner.
 */
export function Decentralization({ charts, className = "" }: { charts: Charts | null; className?: string }) {
  const c = charts ?? EMPTY_CHARTS;
  // A server from before the weekly window sends no count: its miners cover the charted blocks
  const total = typeof c.minerBlocks === "number" ? c.minerBlocks : c.height.length;
  // Allow for the week's first block landing a little after the cutoff
  const fullWeek = c.minerSpan >= 7 * 86_400 - 3_600;
  const majority = majorityHolders(c.miners, total);
  const judged = total >= DECENTRALIZATION_MIN_BLOCKS;
  const { grade, verdict } = gradeDecentralization(majority);
  // One miner holding a majority is the alert's; two together, a warning here. Either way the miners holding it,
  // and the halfway mark they cross, take its color, so the verdict shows its cause
  const tone = majorityLevel(charts);
  const concern: Level | null = tone ?? (judged && majority === 2 ? "warn" : null);
  const holders = concern && majority !== null ? majority : 0;
  const [active, setActive] = useState<string | null>(null);

  const shown = c.miners.slice(0, SHOWN_MINERS);
  const others = total - shown.reduce((sum, m) => sum + m.blocks, 0);
  const otherCount = c.minerCount - shown.length;
  const slices: Slice[] = shown.map((m, i) => ({
    key: m.pool ? `pool:${m.pool.name}` : m.miner,
    label: m.pool?.name ?? shortHash(m.miner),
    pool: m.pool,
    miner: m.pool ? null : m.miner,
    blocks: m.blocks,
    color: sliceColor(i),
  }));

  if (others > 0) {
    slices.push({
      key: "others",
      label: `${otherCount} other ${otherCount === 1 ? "miner" : "miners"}`,
      pool: null,
      miner: null,
      blocks: others,
      color: sliceColor(null),
    });
  }

  return (
    <Tile
      className={className}
      title="Decentralization"
      readout={total ? (fullWeek ? "last 7 days" : `last ${formatInt(total)} blocks`) : undefined}
      value={
        total === 0 ? undefined : judged ? (
          <Verdict grade={grade}>{verdict}</Verdict>
        ) : (
          "Too early"
        )
      }
      qualifier={
        total === 0
          ? undefined
          : majority === null
            ? `no ${Math.min(c.miners.length, 10)} miners hold a majority of ${formatInt(total)} blocks`
            : majority === 1
              ? `one miner holds a majority of ${formatInt(total)} blocks`
              : `${majority} miners together hold a majority of ${formatInt(total)} blocks`
      }
    >
      {c.miners.length === 0 ? (
        <Waiting />
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          {/* Beside the donut, and under it on wide screens, where the tile spans two rows */}
          <div className="flex items-center gap-5 xl:flex-col xl:items-stretch xl:gap-6">
            <div className="relative xl:self-center">
              <Donut slices={slices} total={total} active={active} onActive={setActive} half={concern} />
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl leading-none tabular-nums">{formatInt(c.minerCount)}</span>
                <span className="mt-1 text-[10px] tracking-wider text-muted-foreground uppercase">
                  {c.minerCount === 1 ? "miner" : "miners"}
                </span>
              </div>
            </div>

            <ol className="flex min-w-0 flex-1 flex-col gap-0.5">
              {slices.map((slice, i) => (
                <li
                  key={slice.key}
                  className={`-mx-2 grid grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-sm px-2 py-1 text-xs transition-[background-color,opacity] duration-150 ${
                    // A holder's row keeps its tint under the pointer; the others light up as before
                    concern && i < holders ? CAUSE_ROW[concern] : active === slice.key ? "bg-foreground/8" : ""
                  } ${active === slice.key ? "text-foreground" : active === null ? "" : "opacity-35"}`}
                  onPointerEnter={() => setActive(slice.key)}
                  onPointerLeave={() => setActive(null)}
                >
                  <span
                    className={`size-2.5 rounded-sm transition-transform duration-150 ${active === slice.key ? "scale-125" : ""}`}
                    style={{ background: slice.color }}
                    aria-hidden
                  />
                  {slice.pool?.url ? (
                    <Tooltip content={`${slice.pool.name}, mining pool`}>
                      <a
                        href={slice.pool.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="truncate underline decoration-border underline-offset-2 hover:decoration-foreground"
                      >
                        {slice.label}
                      </a>
                    </Tooltip>
                  ) : slice.miner ? (
                    <MinerAddress address={slice.miner} muted={active !== slice.key} />
                  ) : (
                    <Tooltip content={slice.pool ? `${slice.pool.name}, mining pool` : null}>
                      <span className={`truncate ${active !== slice.key && !slice.pool ? "text-muted-foreground" : ""}`}>{slice.label}</span>
                    </Tooltip>
                  )}
                  <Tooltip content={`${slice.blocks} of ${total} blocks`}>
                    <span className="text-right tabular-nums">
                      {active === slice.key && <span className="mr-2 text-muted-foreground">{slice.blocks} blocks</span>}
                      <span className={concern && i < holders ? `font-semibold ${ALERT_INK[concern]}` : ""}>{share(slice.blocks, total)}</span>
                    </span>
                  </Tooltip>
                </li>
              ))}
            </ol>
          </div>

          <div className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
            {/* The banner above says why; here it is a reminder, in the warning's color. With one miner
                holding a majority, the call at the top of the section asks instead */}
            {judged && majority !== null && majority <= 2 && !tone ? (
              // Worded as the alert's ask: who can act, in the warning's color, then what to do
              <span>
                <span className={`font-semibold ${ALERT_INK[tone ?? "warn"]}`}>If you mine LAX:</span>{" "}
                <span className="text-foreground">move some or all of your hashrate to a smaller pool.</span>
              </span>
            ) : (
              <span>Healthy when at least 4 miners are needed for a majority{tone && majority !== null ? `, not ${majority}` : ""}.</span>
            )}
            <a
              href={MINING_POOL_STATS}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              Find a smaller pool
              <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <path d="M6 3.5h6.5V10M12.5 3.5 4 12" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          </div>
        </div>
      )}
    </Tile>
  );
}

export const EMPTY_CHARTS: Charts = {
  height: [],
  timestamp: [],
  miner: [],
  blocktime: [],
  avgBlocktime: 0,
  difficulty: [],
  difficultyWeek: null,
  transactions: [],
  weekTransactions: 0,
  weekFullness: 0,
  weekFees: null,
  weekFeeBlocks: 0,
  gasSpending: [],
  gasLimit: [],
  fees: [],
  miners: [],
  minerCount: 0,
  minerBlocks: 0,
  minerSpan: 0,
  propagation: { samples: 0, avg: 0, p50: 0, p90: 0, p99: 0, bands: [0, 0, 0, 0] },
  health: { window: 0, staleBlocks: 0, recentStale: [], reorgs: 0, since: 0, lastReorg: null, lastDeepReorg: null, split: null },
  avgHashrate: 0,
  trends: { start: [], blocktime: [], hashrate: [], difficulty: [], transactions: [], fullness: [], fees: [], active: [], synced: [], gasPrice: [], peerLatency: [], uptime: [], pending: [], price: [], volume: [] },
};
