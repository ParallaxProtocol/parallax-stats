"use client";

import { useState, type ReactNode } from "react";
import { miningDifficulty } from "@/lib/asert";
import { blockReward, WEI_PER_LAX } from "@/lib/emission";
import {
  formatBlockTime,
  formatCompact,
  formatDifficulty,
  formatInt,
  formatMs,
  formatPoolDifficulty,
  shortHash,
  type Grade,
} from "@/lib/format";
import { TARGET_BLOCK_TIME, type Block, type Charts, type MinerCount, type PropagationStats } from "@/lib/protocol";
import { majorityLevel, spreadLevel, type Level } from "@/lib/alert-levels";
import { Indicator } from "./indicator";
import { Label, Plate } from "./plate";
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
function Tile({
  title,
  readout,
  value,
  qualifier,
  tone,
  children,
}: {
  title: string;
  readout?: ReactNode;
  value?: ReactNode;
  qualifier?: ReactNode;
  /** Tints the tile while a warning about it applies. */
  tone?: Level | null;
  children: ReactNode;
}) {
  return (
    <Plate as="figure" tone={tone} className="flex min-w-0 flex-col gap-3 p-5">
      <figcaption className="flex items-baseline justify-between gap-3">
        <Label className="whitespace-nowrap">{title}</Label>
        <span className="min-w-0 truncate text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {readout}
        </span>
      </figcaption>
      {value !== undefined && (
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-3xl tabular-nums">{value}</span>
          {qualifier && <span className="text-sm text-muted-foreground">{qualifier}</span>}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </Plate>
  );
}

function Waiting({ children = "Waiting for blocks" }: { children?: ReactNode }) {
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

/** Plot sizes an SVG to fill the space left in its tile and gives every slot a hover target. */
function Plot({
  values,
  onActive,
  label,
  children,
}: Omit<PlotProps, "active"> & { children: (size: { width: number; height: number }, slot: number) => ReactNode }) {
  const [ref, size] = useSize<HTMLDivElement>({ width: 320, height: MIN_PLOT });
  const slot = values.length > 0 ? size.width / values.length : size.width;

  return (
    <div ref={ref} className="relative min-w-0 flex-1" style={{ minHeight: MIN_PLOT }}>
      <svg
        viewBox={`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="none"
        className="absolute inset-0 block size-full overflow-visible"
        role="img"
        aria-label={label}
        onPointerLeave={() => onActive(null)}
      >
        {children(size, slot)}
        {values.map((_, i) => (
          <rect
            key={i}
            x={i * slot}
            y={0}
            width={slot}
            height={size.height}
            fill="transparent"
            onPointerEnter={() => onActive(i)}
          />
        ))}
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
 * Line plots a level that moves within a narrow band, like difficulty,
 * on a scale fitted to its range so small changes stay visible.
 */
function Line({ values, active, onActive, label }: PlotProps) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.15 || Math.abs(max) * 0.01 || 1;

  return (
    <Plot values={values} onActive={onActive} label={label}>
      {({ height }, slot) => {
        const x = (i: number) => i * slot + slot / 2;
        const y = (v: number) => 6 + (1 - (v - (min - pad)) / (max + pad - (min - pad))) * (height - 12);
        const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
        const last = values.length - 1;
        const focus = active ?? last;

        return (
          <>
            <polygon
              points={`${x(0)},${height} ${points} ${x(last)},${height}`}
              className="fill-brand-mark opacity-10"
            />
            <polyline
              points={points}
              fill="none"
              className="stroke-brand-mark"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
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
            <circle cx={x(focus)} cy={y(values[focus])} r={4} className="fill-brand-mark stroke-surface-elevated" strokeWidth={2} />
          </>
        );
      }}
    </Plot>
  );
}

// The tiles

const average = (values: number[]) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0);

function BlockTime({ c, block }: { c: Charts; block: (i: number) => string }) {
  const [active, setActive] = useState<number | null>(null);
  // A zero time means the block's parent was not recorded
  const avg = average(c.blocktime.filter((t) => t > 0));

  return (
    <Tile
      title="Block time"
      readout={
        active !== null
          ? `${block(active)}: ${c.blocktime[active] ? formatBlockTime(c.blocktime[active]) : "unknown, parent not recorded"}`
          : `last ${c.height.length} blocks`
      }
      value={c.height.length ? formatBlockTime(avg) : undefined}
      qualifier={`average of these ${c.height.length}, target 10 min`}
    >
      {c.height.length === 0 ? (
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

const footLabel = "font-mono text-[10px] tracking-wider text-muted-foreground uppercase";

/** signed renders a fractional change: +14.6%, −0.4%, or "unchanged". */
function signed(change: number): string {
  return Math.abs(change) < 0.0005 ? "unchanged" : `${change > 0 ? "+" : "−"}${Math.abs(change * 100).toFixed(1)}%`;
}

/**
 * DifficultyFooter shows where difficulty is heading: the exact difficulty
 * of the block being mined (mainnet ASERT, fixed by the parent alone), and
 * the change over the last week.
 */
function DifficultyFooter({ best, week: reportedWeek }: { best: Block | null; week: number | null | undefined }) {
  const next = best ? miningDifficulty(best) : null;
  // A server from before this figure sends none
  const week = typeof reportedWeek === "number" ? reportedWeek : null;

  if (next === null && week === null) return null;

  return (
    <dl className="grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs">
      {next !== null && best && (
        <div className="flex flex-col gap-1">
          <dt
            className={footLabel}
            title="The difficulty of the block miners are working on now. ASERT sets it from the latest block's timestamp, so it is exact; the change is against the latest block."
          >
            Now mining at
          </dt>
          <dd className="font-mono text-sm tabular-nums">
            {formatDifficulty(next)}{" "}
            <span className="text-xs text-muted-foreground">
              {signed((Number(next) - Number(best.difficulty)) / Number(best.difficulty))}
            </span>
            <span
              className="block text-xs whitespace-nowrap text-muted-foreground"
              title="The same difficulty in the units pools and miners use: one unit is 2^32 hashes."
            >
              pool: {formatPoolDifficulty(next)}
            </span>
          </dd>
        </div>
      )}
      {week !== null && (
        <div className="flex flex-col gap-1">
          <dt className={footLabel} title="The latest block's difficulty against the block mined 7 days earlier.">
            Last 7 days
          </dt>
          <dd className="font-mono text-sm tabular-nums">{signed(week)}</dd>
        </div>
      )}
    </dl>
  );
}

function Difficulty({ c, block, best }: { c: Charts; block: (i: number) => string; best: Block | null }) {
  const [active, setActive] = useState<number | null>(null);
  const values = c.difficulty.map(Number);
  const first = values[0];
  const last = values.at(-1);
  const change = first && last !== undefined ? (last - first) / first : 0;

  return (
    <Tile
      title="Difficulty"
      readout={
        active !== null
          ? `${block(active)}: ${formatDifficulty(c.difficulty[active])}, ${formatPoolDifficulty(c.difficulty[active])} in pool units`
          : `last ${values.length} blocks`
      }
      value={last !== undefined ? formatDifficulty(last) : undefined}
      qualifier={
        values.length > 1
          ? `${Math.abs(change) < 0.0005 ? "" : change > 0 ? "+" : "−"}${Math.abs(change * 100).toFixed(1)}% over ${values.length} blocks`
          : undefined
      }
    >
      {values.length === 0 ? (
        <Waiting />
      ) : (
        <Line
          values={values}
          active={active}
          onActive={setActive}
          label={`Difficulty of the last ${values.length} blocks, from ${formatDifficulty(Math.min(...values))} to ${formatDifficulty(Math.max(...values))}`}
        />
      )}
      <DifficultyFooter best={best} week={c.difficultyWeek} />
    </Tile>
  );
}

function Transactions({ c, block }: { c: Charts; block: (i: number) => string }) {
  const [active, setActive] = useState<number | null>(null);
  const total = c.transactions.reduce((a, b) => a + b, 0);

  return (
    <Tile
      title="Transactions"
      readout={
        active !== null
          ? `${block(active)}: ${formatInt(c.transactions[active])} transactions`
          : `${formatInt(total)} in last ${c.height.length} blocks`
      }
      value={c.height.length ? average(c.transactions).toFixed(1) : undefined}
      qualifier="per block"
    >
      {c.height.length === 0 ? (
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

function Fullness({ c, block }: { c: Charts; block: (i: number) => string }) {
  const [active, setActive] = useState<number | null>(null);
  const fullness = c.gasSpending.map((used, i) => (c.gasLimit[i] > 0 ? used / c.gasLimit[i] : 0));
  const pct = (f: number) => `${(f * 100).toFixed(f < 0.1 ? 1 : 0)}%`;

  return (
    <Tile
      title="Block fullness"
      readout={
        active !== null
          ? `${block(active)}: ${pct(fullness[active])}, ${formatCompact(c.gasSpending[active])} of ${formatCompact(c.gasLimit[active])} gas`
          : "gas used of the limit"
      }
      value={c.height.length ? pct(average(fullness)) : undefined}
      qualifier="full on average"
    >
      {c.height.length === 0 ? (
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
 * Propagation shows how quickly blocks reach nodes. Delays are heavily
 * skewed (nearly all arrive within a second), so instead of a histogram
 * on a linear axis it leads with the share that arrived within a second,
 * splits all reports into speed bands, and gives the tail as percentiles.
 */
function Propagation({ stats }: { stats: PropagationStats }) {
  const { samples, bands } = stats;
  // Keeps a small nonzero band visible in the bar
  const minWidth = 3;
  // A band hovered in the bar or the list lights up in both, as in the decentralization donut
  const [active, setActive] = useState<number | null>(null);

  return (
    <Tile
      tone={spreadLevel(stats)}
      title="Propagation"
      readout={samples ? `${formatInt(samples)} reports` : undefined}
      value={samples ? share(bands[0], samples) : undefined}
      qualifier="reached nodes within 5 s"
    >
      {samples === 0 ? (
        <Waiting>Waiting for blocks to reach a second node</Waiting>
      ) : (
        <div className="flex flex-1 flex-col justify-between gap-3">
          <div
            role="img"
            aria-label={BANDS.map((band, i) => `${band.label}: ${bands[i]} reports`).join(", ")}
            className="flex h-3.5 w-full items-center gap-0.5"
          >
            {BANDS.map((band, i) =>
              bands[i] > 0 ? (
                <div
                  key={band.label}
                  className={`${band.swatch} rounded-[3px] transition-[height,opacity] duration-150 ${active === i ? "h-3.5" : "h-2.5"} ${
                    active === null || active === i ? "" : "opacity-35"
                  }`}
                  title={`${band.label}: ${formatInt(bands[i])} (${share(bands[i], samples)})`}
                  style={{ flexGrow: bands[i], flexBasis: 0, minWidth }}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive(null)}
                />
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
function formatSmallLax(lax: number): string {
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
 * compare with the block reward, which shrinks with every halving. Blocks
 * reported by parallaxd versions that do not send fees show as unknown,
 * never as zero.
 */
function Fees({ c, block }: { c: Charts; block: (i: number) => string }) {
  const [active, setActive] = useState<number | null>(null);
  const lax = c.fees.map((fees) => (fees === null ? null : Number(BigInt(fees)) / Number(WEI_PER_LAX)));
  const known = lax.flatMap((fees, i) => (fees === null ? [] : [i]));
  const avg = average(known.map((i) => lax[i]!));
  const avgReward = average(known.map((i) => Number(blockReward(c.height[i])) / Number(WEI_PER_LAX)));

  return (
    <Tile
      title="Fees"
      readout={
        active !== null
          ? lax[active] === null
            ? `${block(active)}: not reported`
            : `${block(active)}: ${formatSmallLax(lax[active]!)} LAX, ${formatInt(c.transactions[active])} transactions`
          : known.length < c.height.length && known.length > 0
            ? `${known.length} of ${c.height.length} blocks reported`
            : "paid to miners per block"
      }
      value={known.length ? formatSmallLax(avg) : undefined}
      qualifier={
        known.length
          ? `LAX per block, ${formatSmallShare(avgReward > 0 ? avg / avgReward : 0)} of the block reward`
          : undefined
      }
    >
      {known.length === 0 ? (
        <Waiting>Fees appear once nodes run a parallaxd version that reports them</Waiting>
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

/** Fewer blocks than this say too little about who mines to grade. */
const DECENTRALIZATION_MIN_BLOCKS = 10;
/** Miners named in the chart; the rest are drawn together as other miners. */
const SHOWN_MINERS = 7;

/**
 * majorityHolders is the fewest miners that together found more than half
 * of the blocks (the Nakamoto coefficient over the window), or null when
 * the miners listed do not reach a majority.
 */
function majorityHolders(miners: { blocks: number }[], total: number): number | null {
  let sum = 0;

  for (let i = 0; i < miners.length; i++) {
    sum += miners[i].blocks;

    if (sum * 2 > total) return i + 1;
  }

  return null;
}

/**
 * gradeDecentralization grades how many miners it takes to hold a majority
 * of recent blocks, which is how many would have to collude to rewrite
 * the chain. null means more than the miners listed.
 */
function gradeDecentralization(majority: number | null): { grade: Grade; verdict: string } {
  if (majority === null || majority >= 4) return { grade: "good", verdict: "Healthy" };
  if (majority === 3) return { grade: "warn", verdict: "Fair" };
  if (majority === 2) return { grade: "serious", verdict: "Concentrated" };

  return { grade: "critical", verdict: "Critical" };
}

/**
 * Slice colours: the brand teal, stepping toward the surface by rank, so
 * the largest miner is the strongest and none borrow a status colour.
 * Other miners are neutral.
 */
const SLICE_STRENGTH = [100, 68, 46, 33, 25, 19, 15];

/** The note to miners: amber while two miners hold a majority, red with its tile when one does. */
const NOTE_TONE: Record<Level, { box: string; icon: string }> = {
  warn: { box: "border-warn/40 bg-warn/10", icon: "text-warn" },
  critical: { box: "border-critical/40 bg-critical/10", icon: "text-critical" },
};

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
function Donut({ slices, total, active, onActive }: { slices: Slice[]; total: number; active: string | null; onActive: (key: string | null) => void }) {
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const gap = slices.length > 1 ? 1.5 : 0;
  // Where each slice starts along the ring
  const starts = slices.map((_, i) => slices.slice(0, i).reduce((sum, s) => sum + (s.blocks / total) * circumference, 0));

  return (
    <svg viewBox="0 0 120 120" className="size-32 shrink-0 -rotate-90 sm:size-36" role="img" aria-label="Share of recent blocks by miner">
      {slices.map((slice, i) => {
        const length = (slice.blocks / total) * circumference;

        return (
          <circle
            key={slice.key}
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
          >
            <title>{`${slice.label}: ${slice.blocks} of ${total} blocks`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

/**
 * Decentralization grades how spread out mining is: how few miners hold a
 * majority of recent blocks, each one's share in a donut, and the largest
 * miners by name. A known pool's addresses count as one miner.
 */
export function Decentralization({ charts }: { charts: Charts | null }) {
  const c = charts ?? EMPTY;
  // A server from before the weekly window sends no count: its miners cover the charted blocks
  const total = typeof c.minerBlocks === "number" ? c.minerBlocks : c.height.length;
  // Allow for the week's first block landing a little after the cutoff
  const fullWeek = c.minerSpan >= 7 * 86_400 - 3_600;
  const majority = majorityHolders(c.miners, total);
  const judged = total >= DECENTRALIZATION_MIN_BLOCKS;
  const { grade, verdict } = gradeDecentralization(majority);
  // The tile, and its note to miners, take the warning's color while one miner holds a majority
  const tone = majorityLevel(charts);
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
      tone={tone}
      title="Decentralization"
      readout={total ? (fullWeek ? `${formatInt(total)} blocks in the last 7 days` : `the last ${formatInt(total)} blocks`) : undefined}
      value={
        total === 0 ? undefined : judged ? (
          <span className="inline-flex items-center gap-2.5">
            <Indicator grade={grade} label="" className="size-2.5" />
            {verdict}
          </span>
        ) : (
          "Too early"
        )
      }
      qualifier={
        total === 0
          ? undefined
          : majority === null
            ? `no ${Math.min(c.miners.length, 10)} miners hold a majority`
            : majority === 1
              ? "one miner holds a majority"
              : `${majority} miners together hold a majority`
      }
    >
      {c.miners.length === 0 ? (
        <Waiting />
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          <div className="flex items-center gap-5">
            <div className="relative">
              <Donut slices={slices} total={total} active={active} onActive={setActive} />
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl leading-none tabular-nums">{formatInt(c.minerCount)}</span>
                <span className="mt-1 text-[10px] tracking-wider text-muted-foreground uppercase">
                  {c.minerCount === 1 ? "miner" : "miners"}
                </span>
              </div>
            </div>

            <ol className="flex min-w-0 flex-1 flex-col gap-0.5">
              {slices.map((slice) => (
                <li
                  key={slice.key}
                  className={`-mx-2 grid grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-sm px-2 py-1 text-xs transition-[background-color,opacity] duration-150 ${
                    active === slice.key ? "bg-foreground/8 text-foreground" : active === null ? "" : "opacity-35"
                  }`}
                  onPointerEnter={() => setActive(slice.key)}
                  onPointerLeave={() => setActive(null)}
                >
                  <span
                    className={`size-2.5 rounded-sm transition-transform duration-150 ${active === slice.key ? "scale-125" : ""}`}
                    style={{ background: slice.color }}
                    aria-hidden
                  />
                  {slice.pool?.url ? (
                    <a
                      href={slice.pool.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="truncate underline decoration-border underline-offset-2 hover:decoration-foreground"
                      title={`${slice.pool.name}, mining pool`}
                    >
                      {slice.label}
                    </a>
                  ) : (
                    <span
                      className={`truncate ${slice.miner ? "font-mono" : ""} ${
                        active !== slice.key && (slice.miner || !slice.pool) ? "text-muted-foreground" : ""
                      }`}
                      title={slice.pool ? `${slice.pool.name}, mining pool` : (slice.miner ?? undefined)}
                    >
                      {slice.label}
                    </span>
                  )}
                  <span className="text-right tabular-nums" title={`${slice.blocks} of ${total} blocks`}>
                    {active === slice.key && <span className="mr-2 text-muted-foreground">{slice.blocks} blocks</span>}
                    {share(slice.blocks, total)}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          {judged && majority !== null && majority <= 2 && (
            <p role="note" className={`flex gap-2 border px-3 py-2 text-xs ${NOTE_TONE[tone ?? "warn"].box}`}>
              <svg viewBox="0 0 16 16" className={`mt-px size-3.5 shrink-0 ${NOTE_TONE[tone ?? "warn"].icon}`} fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <path d="M8 2 14.5 13.5h-13Z" strokeLinejoin="round" />
                <path d="M8 6.5v3M8 11.6v.1" strokeLinecap="round" />
              </svg>
              <span className="text-muted-foreground">
                Miners: spread your hashrate across more pools to keep the network decentralized.
              </span>
            </p>
          )}

          <div className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
            <span>Healthy when at least 4 miners are needed for a majority.</span>
            <a
              href={MINING_POOL_STATS}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              Compare pools on MiningPoolStats
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

const EMPTY: Charts = {
  height: [],
  blocktime: [],
  avgBlocktime: 0,
  difficulty: [],
  difficultyWeek: null,
  transactions: [],
  gasSpending: [],
  gasLimit: [],
  fees: [],
  miners: [],
  minerCount: 0,
  minerBlocks: 0,
  minerSpan: 0,
  propagation: { samples: 0, avg: 0, p50: 0, p90: 0, p99: 0, bands: [0, 0, 0, 0] },
  health: { window: 0, staleBlocks: 0, recentStale: [], reorgs: 0, since: 0, lastReorg: null, split: null },
  avgHashrate: 0,
};

/**
 * ChartGrid lays out the chart tiles; tiles in a row share its height.
 * `mainnetBest` is the best block when nodes report mainnet, which enables
 * the ASERT figures.
 */
export function ChartGrid({ charts, mainnetBest }: { charts: Charts | null; mainnetBest: Block | null }) {
  const c = charts ?? EMPTY;
  const block = (i: number) => `#${formatInt(c.height[i])}`;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <BlockTime c={c} block={block} />
      <Difficulty c={c} block={block} best={mainnetBest} />
      <Propagation stats={c.propagation} />
      <Transactions c={c} block={block} />
      <Fullness c={c} block={block} />
      <Fees c={c} block={block} />
    </div>
  );
}
