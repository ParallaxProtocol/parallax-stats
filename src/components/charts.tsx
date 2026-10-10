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
} from "@/lib/format";
import { TARGET_BLOCK_TIME, type Block, type Charts, type PropagationStats } from "@/lib/protocol";
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
  children,
}: {
  title: string;
  readout?: ReactNode;
  value?: ReactNode;
  qualifier?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Plate as="figure" className="flex min-w-0 flex-col gap-3 p-5">
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
 * the change over the last day and week.
 */
function DifficultyFooter({
  best,
  day: reportedDay,
  week: reportedWeek,
}: {
  best: Block | null;
  day: number | null | undefined;
  week: number | null | undefined;
}) {
  const next = best ? miningDifficulty(best) : null;
  // A server from before these figures sends none
  const day = typeof reportedDay === "number" ? reportedDay : null;
  const week = typeof reportedWeek === "number" ? reportedWeek : null;

  if (next === null && day === null && week === null) return null;

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
      {(day !== null || week !== null) && (
        <div className="flex flex-col gap-2">
          {[
            ["Last 24 h", day, "The latest block's difficulty against the block mined 24 hours earlier."],
            ["Last 7 days", week, "The latest block's difficulty against the block mined 7 days earlier."],
          ].map(([label, change, hint]) =>
            change === null ? null : (
              <div key={label as string} className="flex flex-col gap-0.5">
                <dt className={footLabel} title={hint as string}>
                  {label as string}
                </dt>
                <dd className="font-mono text-sm tabular-nums">{signed(change as number)}</dd>
              </div>
            ),
          )}
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
      <DifficultyFooter best={best} day={c.difficultyDay} week={c.difficultyWeek} />
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
  { label: "Under 1 s", swatch: "bg-good" },
  { label: "1–3 s", swatch: "bg-warn" },
  { label: "3–7 s", swatch: "bg-serious" },
  { label: "7 s or more", swatch: "bg-critical" },
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

  return (
    <Tile
      title="Propagation"
      readout={samples ? `${formatInt(samples)} reports` : undefined}
      value={samples ? share(bands[0], samples) : undefined}
      qualifier="reached nodes within 1 s"
    >
      {samples === 0 ? (
        <Waiting>Waiting for blocks to reach a second node</Waiting>
      ) : (
        <div className="flex flex-1 flex-col justify-between gap-3">
          <div
            role="img"
            aria-label={BANDS.map((band, i) => `${band.label}: ${bands[i]} reports`).join(", ")}
            className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-[4px]"
          >
            {BANDS.map((band, i) =>
              bands[i] > 0 ? (
                <div
                  key={band.label}
                  className={band.swatch}
                  title={`${band.label}: ${formatInt(bands[i])} (${share(bands[i], samples)})`}
                  style={{ flexGrow: bands[i], flexBasis: 0, minWidth }}
                />
              ) : null,
            )}
          </div>

          <ul className="grid grid-cols-2 gap-x-5 gap-y-1">
            {BANDS.map((band, i) => (
              <li key={band.label} className="flex items-baseline gap-2 text-xs">
                <span aria-hidden className={`size-2 shrink-0 rounded-[2px] ${band.swatch}`} />
                <span className="truncate text-muted-foreground">{band.label}</span>
                <span className="ml-auto tabular-nums">{share(bands[i], samples)}</span>
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

/** Warn when this few miners hold a majority, once there are enough blocks to judge. */
const CONCENTRATION_WARNING = 2;
const CONCENTRATION_MIN_BLOCKS = 10;

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
 * Miners shows each top miner's share of recent blocks on a full 0–100%
 * scale, with how concentrated mining is: how many distinct miners found
 * the blocks, and how few of them hold a majority.
 */
export function Miners({ charts }: { charts: Charts | null }) {
  const c = charts ?? EMPTY;
  const total = c.height.length;
  const top = c.miners[0];
  const others = total - c.miners.reduce((sum, m) => sum + m.blocks, 0);
  const majority = majorityHolders(c.miners, total);
  const row = "grid grid-cols-[minmax(0,8.5rem)_1fr_2.5rem] items-center gap-3 text-xs";

  return (
    <Tile
      title="Top miners"
      readout={total ? `share of the last ${total} blocks` : undefined}
      value={top ? share(top.blocks, total) : undefined}
      qualifier={top ? `found by ${shortHash(top.miner)}` : undefined}
    >
      {c.miners.length === 0 ? (
        <Waiting />
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          <ol className="flex flex-col gap-2.5">
            {c.miners.map((m) => (
              <li key={m.miner} className={row}>
                <span className="truncate font-mono text-muted-foreground" title={m.miner}>
                  {shortHash(m.miner)}
                </span>
                <span className="relative h-1 bg-border/60" title={`${m.blocks} of ${total} blocks`}>
                  <span className="absolute inset-y-0 left-0 bg-brand-mark" style={{ width: `${(m.blocks / total) * 100}%` }} />
                </span>
                <span className="text-right tabular-nums">{share(m.blocks, total)}</span>
              </li>
            ))}
            {others > 0 && (
              <li className={row}>
                <span className="text-muted-foreground">
                  {c.minerCount - c.miners.length} other {c.minerCount - c.miners.length === 1 ? "miner" : "miners"}
                </span>
                <span className="relative h-1 bg-border/60" title={`${others} of ${total} blocks`}>
                  <span
                    className="absolute inset-y-0 left-0 bg-muted-foreground"
                    style={{ width: `${(others / total) * 100}%` }}
                  />
                </span>
                <span className="text-right tabular-nums">{share(others, total)}</span>
              </li>
            )}
          </ol>

          {majority !== null && majority <= CONCENTRATION_WARNING && total >= CONCENTRATION_MIN_BLOCKS && (
            <p role="note" className="flex gap-2 border border-warn/40 bg-warn/10 px-3 py-2 text-xs">
              <svg viewBox="0 0 16 16" className="mt-px size-3.5 shrink-0 text-warn" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <path d="M8 2 14.5 13.5h-13Z" strokeLinejoin="round" />
                <path d="M8 6.5v3M8 11.6v.1" strokeLinecap="round" />
              </svg>
              <span>
                <span className="font-medium">
                  {majority === 1 ? "One miner" : "Two miners"} found most of the last {total} blocks.
                </span>{" "}
                <span className="text-muted-foreground">
                  Miners: spread your hashrate across more pools to keep the network decentralized.
                </span>
              </span>
            </p>
          )}

          <dl className="mt-auto grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs">
            <div className="flex flex-col gap-1">
              <dt className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Distinct miners</dt>
              <dd className="font-mono text-sm tabular-nums">{formatInt(c.minerCount)}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Majority held by</dt>
              <dd className="font-mono text-sm tabular-nums">
                {majority === null ? `more than ${c.miners.length}` : `${majority} ${majority === 1 ? "miner" : "miners"}`}
              </dd>
            </div>
          </dl>
          <a
            href={MINING_POOL_STATS}
            target="_blank"
            rel="noopener noreferrer"
            className="-mt-1 inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Compare pools on MiningPoolStats
            <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <path d="M6 3.5h6.5V10M12.5 3.5 4 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
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
  difficultyDay: null,
  difficultyWeek: null,
  transactions: [],
  gasSpending: [],
  gasLimit: [],
  fees: [],
  miners: [],
  minerCount: 0,
  propagation: { samples: 0, avg: 0, p50: 0, p90: 0, p99: 0, bands: [0, 0, 0, 0] },
  health: { window: 0, staleBlocks: 0, recentStale: [], reorgs: 0, since: 0, lastReorg: null },
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
      <Propagation stats={c.propagation} />
      <Difficulty c={c} block={block} best={mainnetBest} />
      <Transactions c={c} block={block} />
      <Fullness c={c} block={block} />
      <Fees c={c} block={block} />
    </div>
  );
}
