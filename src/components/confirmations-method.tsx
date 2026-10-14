"use client";

// The Recommended confirmations tile's "method" dialog: how the wait is
// worked out, in plain words, with a picture of the attack, the odds and the
// cost to try for any share, the status dot's thresholds, and attacks that
// have happened on other chains.

import { useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { attackerSuccess, CONFIDENCE, hiddenShare, MAX_CONFIRMATIONS, reversalCost, waitsFor } from "@/lib/confirmations";
import { formatClock, formatCompact, formatInt, formatMs } from "@/lib/format";
import { TARGET_BLOCK_TIME } from "@/lib/protocol";
import { HIDDEN_CHANCE, OPEN_CHANCE, UNUSUAL_CHANCE, WATCH_MIN_SHARE, type Watch } from "@/lib/withholding";
import { Indicator } from "./indicator";
import { useSize } from "./use-size";

const ROSENFELD = "https://arxiv.org/abs/1402.2009";
const BITCOIN_PAPER = "https://bitcoin.org/bitcoin.pdf";
const METHODS = "https://github.com/ParallaxProtocol/parallax-stats#how-the-figures-are-worked-out";

/** The confidence the tile's headline answers for: 99.9%. */
const HEADLINE = 1;
/** The chance charts' floor: one in a million. */
const FLOOR = 1e-6;

const significant = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });
const link = "text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground";
const footerLink =
  "inline-flex h-8 items-center gap-1.5 rounded border border-border px-3 font-mono text-[11px] tracking-[0.12em] uppercase hover:bg-accent/50";

/** chance renders a probability as people say it: 13%, 1.2%, or 1 in 4,300. */
function chance(p: number): string {
  if (p >= 0.1) return `${Math.round(p * 100)}%`;
  if (p >= 0.01) return `${+(p * 100).toFixed(1)}%`;

  return `1 in ${p > 1e-5 ? formatInt(Math.round(1 / p)) : formatCompact(1 / p)}`;
}

/** wait renders how long a number of blocks takes at the target block time. */
function wait(blocks: number): string {
  return formatMs(blocks * TARGET_BLOCK_TIME * 1000);
}

function blocks(n: number | null): string {
  return n === null ? `over ${formatInt(MAX_CONFIRMATIONS)} blocks` : `${formatInt(n)} ${n === 1 ? "block" : "blocks"}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-3 font-mono text-[11px] tracking-[0.15em] text-muted-foreground uppercase">
        {title}
        <span aria-hidden className="h-px flex-1 bg-border" />
      </h3>
      {children}
    </section>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5 7 9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Figure frames a picture or chart, with its title above and its caption below. */
function Figure({ title, controls, caption, children }: { title: string; controls?: ReactNode; caption?: ReactNode; children: ReactNode }) {
  return (
    <figure className="flex flex-col gap-3 border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="font-mono text-[10px] tracking-[0.15em] text-muted-foreground uppercase">{title}</span>
        {controls}
      </div>
      {children}
      {caption && <figcaption className="text-xs leading-relaxed text-muted-foreground">{caption}</figcaption>}
    </figure>
  );
}

/** Slider picks a share of the hashrate, in whole percent. */
function Slider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const id = useId();

  return (
    <label htmlFor={id} className="flex items-center gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input id={id} type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-32 accent-[var(--brand-mark)] sm:w-40" />
      <span className="w-9 text-right tabular-nums">{value}%</span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// The attack, drawn

/**
 * Fork draws the attack: the public chain with the payment and its
 * confirmations, and a secret chain branching off before the payment that
 * grows one block longer, replacing them all once published.
 */
function Fork() {
  const [ref, { width }] = useSize<HTMLDivElement>({ width: 640, height: 0 });
  // A block shared by both, the payment's block and 5 more on the public side, 7 on the secret one
  const columns = 8;
  const gap = width < 480 ? 8 : 14;
  const left = width < 480 ? 0 : 88;
  const size = Math.min(52, (width - left - gap * (columns - 1)) / columns);
  const x = (i: number) => left + i * (size + gap);
  const rows = { public: 22, secret: 22 + size + 44 };
  const height = rows.secret + size + 22;
  const narrow = width < 480;

  return (
    <div ref={ref} className="w-full">
      <svg width={width} height={height} role="img" aria-label="A secret chain branching off before the payment grows longer than the public chain and replaces it, payment included" className="overflow-visible font-mono text-[10px]">
        {!narrow && (
          <g className="fill-muted-foreground">
            <text x={0} y={rows.public + size / 2} dominantBaseline="central">
              Public chain
            </text>
            <text x={0} y={rows.secret + size / 2} dominantBaseline="central">
              Secret chain
            </text>
          </g>
        )}

        {/* Links between blocks */}
        <g className="stroke-border" strokeWidth={1.5} fill="none">
          {Array.from({ length: columns - 2 }, (_, i) => (
            <line key={`p${i}`} x1={x(i) + size} x2={x(i + 1)} y1={rows.public + size / 2} y2={rows.public + size / 2} />
          ))}
          <path d={`M${x(0) + size / 2} ${rows.public + size} V${rows.secret + size / 2} H${x(1)}`} className="stroke-muted-foreground" strokeDasharray="3 3" />
          {Array.from({ length: columns - 2 }, (_, i) => (
            <line key={`s${i}`} x1={x(i + 1) + size} x2={x(i + 2)} y1={rows.secret + size / 2} y2={rows.secret + size / 2} className="stroke-muted-foreground" strokeDasharray="3 3" />
          ))}
        </g>

        {/* The block both chains share */}
        <rect x={x(0)} y={rows.public} width={size} height={size} rx={3} className="fill-surface-elevated stroke-muted-foreground" strokeWidth={1.5} />

        {/* The public chain: the payment's block, then the blocks on top of it */}
        {Array.from({ length: columns - 2 }, (_, i) => (
          <g key={i}>
            <rect
              x={x(i + 1)}
              y={rows.public}
              width={size}
              height={size}
              rx={3}
              className={i === 0 ? "fill-[var(--brand-muted)] stroke-[var(--brand-mark)]" : "fill-surface-elevated stroke-muted-foreground"}
              strokeWidth={1.5}
            />
            <text x={x(i + 1) + size / 2} y={rows.public + size / 2} textAnchor="middle" dominantBaseline="central" className={i === 0 ? "fill-foreground" : "fill-muted-foreground"}>
              {i === 0 ? "pay" : `+${i}`}
            </text>
            <text x={x(i + 1) + size / 2} y={rows.public - 8} textAnchor="middle" className="fill-muted-foreground">
              {i + 1}
            </text>
          </g>
        ))}
        <text x={x(columns - 2) + size + 8} y={rows.public - 8} className="fill-muted-foreground">
          {narrow ? "" : "confirmations"}
        </text>

        {/* The secret chain: one block longer, without the payment */}
        {Array.from({ length: columns - 1 }, (_, i) => (
          <g key={i}>
            <rect x={x(i + 1)} y={rows.secret} width={size} height={size} rx={3} className="fill-muted stroke-muted-foreground" strokeWidth={1.5} strokeDasharray="4 3" />
            <text
              x={x(i + 1) + size / 2}
              y={rows.secret + size / 2}
              textAnchor="middle"
              dominantBaseline="central"
              // "no pay" crowds a small block
              fontSize={i === 0 && size < 48 ? 8 : undefined}
              className="fill-muted-foreground"
            >
              {i === 0 ? "no pay" : `+${i}`}
            </text>
          </g>
        ))}
        <text x={x(columns - 1) + size / 2} y={rows.secret + size + 16} textAnchor="middle" className="fill-foreground">
          longer
        </text>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Charts

interface Series {
  key: string;
  label: string;
  /** [x, y] in data units, x rising. */
  points: [number, number][];
  stroke: string;
  dashed?: boolean;
}

interface Rule {
  y: number;
  label: string;
}

/** A strip under the plot marking a stretch of x in a colour, as the status dot's thresholds. */
interface Band {
  from: number;
  to: number;
  className: string;
  label: string;
}

/**
 * Plot draws lines over x from 0 to `xMax`, on a log scale from FLOOR to 1
 * or a linear one from 0 to `yMax`, with dashed rules across, an optional
 * strip of bands under it and a marker. Hovering shows a crosshair and
 * `readout` for the x under the pointer, snapped to whole `step`s.
 */
function Plot({
  series,
  xMax,
  yMax,
  log,
  rules = [],
  bands = [],
  marker,
  xTicks,
  yTicks,
  formatX,
  formatY,
  step = 1,
  readout,
  label,
}: {
  series: Series[];
  xMax: number;
  yMax: number;
  log: boolean;
  rules?: Rule[];
  bands?: Band[];
  marker?: { x: number; label: string } | null;
  xTicks: number[];
  yTicks: number[];
  formatX: (x: number) => string;
  formatY: (y: number) => string;
  step?: number;
  readout: (x: number) => ReactNode;
  label: string;
}) {
  const [ref, { width }] = useSize<HTMLDivElement>({ width: 640, height: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const margin = { top: 10, right: 12, bottom: bands.length > 0 ? 40 : 22, left: 64 };
  const height = 200;
  const plotW = Math.max(10, width - margin.left - margin.right);
  const plotH = height - margin.top - margin.bottom;
  const sx = (x: number) => margin.left + (x / xMax) * plotW;
  const yMin = log ? FLOOR : 0;
  const sy = (y: number) =>
    log
      ? margin.top + (1 - (Math.log10(Math.max(y, FLOOR)) - Math.log10(FLOOR)) / (Math.log10(yMax) - Math.log10(FLOOR))) * plotH
      : margin.top + (1 - (y - yMin) / (yMax - yMin)) * plotH;
  const path = (points: [number, number][]) => {
    // A log line stops at the floor rather than running along it
    const shown = log ? points.slice(0, points.findIndex(([, y]) => y < FLOOR) + 1 || points.length) : points;

    return shown.map(([x, y], i) => `${i === 0 ? "M" : "L"}${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`).join("");
  };

  function move(e: PointerEvent<SVGRectElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * xMax;

    setHover(Math.min(xMax, Math.max(0, Math.round(x / step) * step)));
  }

  const at = (s: Series, x: number) => {
    let best = s.points[0];

    for (const point of s.points) if (Math.abs(point[0] - x) < Math.abs(best[0] - x)) best = point;

    return best;
  };
  const tipLeft = hover !== null ? sx(hover) : 0;

  return (
    <div className="flex flex-col gap-2">
      {/* The legend: a sample of each line's stroke, so identity never rests on colour alone */}
      {series.length > 1 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {series.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <svg width="20" height="6" aria-hidden>
                <line x1="0" x2="20" y1="3" y2="3" stroke={s.stroke} strokeWidth="2" strokeDasharray={s.dashed ? "4 3" : undefined} />
              </svg>
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div ref={ref} className="relative w-full">
        <svg width={width} height={height} role="img" aria-label={label} className="block overflow-visible font-mono text-[10px]">
          {/* Grid and axes, recessive */}
          <g className="stroke-border" strokeWidth={1}>
            {yTicks.map((y) => (
              <line key={y} x1={margin.left} x2={margin.left + plotW} y1={sy(y)} y2={sy(y)} />
            ))}
          </g>
          <g className="fill-muted-foreground tabular-nums">
            {yTicks.map((y) => (
              <text key={y} x={margin.left - 8} y={sy(y)} textAnchor="end" dominantBaseline="central">
                {formatY(y)}
              </text>
            ))}
            {xTicks.map((x) => (
              <text key={x} x={sx(x)} y={margin.top + plotH + 14} textAnchor="middle">
                {formatX(x)}
              </text>
            ))}
          </g>

          {/* Rules across: the confidence a wait is chosen for */}
          {rules.map((rule) => (
            <g key={rule.label}>
              <line x1={margin.left} x2={margin.left + plotW} y1={sy(rule.y)} y2={sy(rule.y)} className="stroke-foreground/50" strokeWidth={1} strokeDasharray="2 3" />
              <text x={margin.left + 6} y={sy(rule.y) - 5} className="fill-muted-foreground">
                {rule.label}
              </text>
            </g>
          ))}

          {/* The status strip under the plot */}
          {bands.map((band) => (
            <g key={band.label}>
              <rect x={sx(band.from)} y={margin.top + plotH + 22} width={Math.max(0, sx(Math.min(band.to, xMax)) - sx(band.from) - 2)} height={4} rx={2} className={band.className} />
            </g>
          ))}

          {series.map((s) => (
            <path key={s.key} d={path(s.points)} fill="none" stroke={s.stroke} strokeWidth={2} strokeDasharray={s.dashed ? "5 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />
          ))}

          {marker && marker.x <= xMax && (
            <g>
              <line x1={sx(marker.x)} x2={sx(marker.x)} y1={margin.top} y2={margin.top + plotH} className="stroke-foreground" strokeWidth={1.5} />
              <text x={sx(marker.x) + 5} y={margin.top + 8} className="fill-foreground">
                {marker.label}
              </text>
            </g>
          )}

          {/* The crosshair, and a dot where it crosses each line */}
          {hover !== null && (
            <g className="pointer-events-none">
              <line x1={sx(hover)} x2={sx(hover)} y1={margin.top} y2={margin.top + plotH} className="stroke-muted-foreground" strokeWidth={1} />
              {series.map((s) => {
                const [x, y] = at(s, hover);

                return log && y < FLOOR ? null : <circle key={s.key} cx={sx(x)} cy={sy(y)} r={4} fill={s.stroke} className="stroke-card" strokeWidth={2} />;
              })}
            </g>
          )}

          {/* Larger than the plot, so the pointer need not land on a line */}
          <rect
            x={margin.left}
            y={0}
            width={plotW}
            height={height}
            fill="transparent"
            onPointerMove={move}
            onPointerDown={move}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 w-max max-w-56 border border-border bg-surface-elevated px-2.5 py-2 text-xs shadow-lg"
            style={tipLeft > width / 2 ? { right: width - tipLeft + 10 } : { left: tipLeft + 10 }}
          >
            {readout(hover)}
          </div>
        )}
      </div>
    </div>
  );
}

/** niceTicks spreads about `count` round ticks from 0 to `max`. */
function niceTicks(max: number, count = 5): number[] {
  const raw = max / count;
  const unit = 10 ** Math.floor(Math.log10(raw));
  const stepSize = [1, 2, 5, 10].map((m) => m * unit).find((s) => s >= raw) ?? raw;

  return Array.from({ length: Math.floor(max / stepSize) + 1 }, (_, i) => i * stepSize);
}

const LOG_TICKS = [1, 1e-2, 1e-4, 1e-6];

/** minuteTicks marks a span of minutes at round steps: every 15, 30 minutes or whole hours. */
function minuteTicks(max: number): number[] {
  const stepSize = [15, 30, 60, 120, 240].find((s) => max / s <= 6) ?? 480;

  return Array.from({ length: Math.floor(max / stepSize) + 1 }, (_, i) => i * stepSize);
}

/** minutesLabel renders whole minutes: 0, 45 min, 2 h, 1 h 37 min. */
function minutesLabel(m: number): string {
  if (m === 0) return "0";
  if (m < 60) return `${m} min`;

  return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/**
 * Odds charts the chance a miner with a share picked on a slider reverses a
 * payment, against the confirmations it has: assumed mining in secret, and
 * seen in the open, with the 99.9% line the headline is chosen at.
 */
function Odds({ initial }: { initial: number }) {
  const [pct, setPct] = useState(initial);
  const q = pct / 100;
  const [secretWait, openWait] = [waitsFor(q, false)[HEADLINE], waitsFor(q, true)[HEADLINE]];
  // Far enough for both lines to cross the rule, where the secret one does within reach
  const reach = Math.max((openWait ?? 400) * 1.6, secretWait !== null && secretWait <= 400 ? secretWait * 1.15 : 0);
  const xMax = Math.min(MAX_CONFIRMATIONS, Math.max(12, Math.ceil(reach)));
  const xs = Array.from({ length: xMax + 1 }, (_, z) => z);
  const secret: [number, number][] = xs.map((z) => [z, attackerSuccess(q, z)]);
  const seen: [number, number][] = xs.map((z) => [z, attackerSuccess(q, z, hiddenShare(q, z))]);
  const series: Series[] = [
    { key: "secret", label: "May be mining in secret", points: secret, stroke: "var(--muted-foreground)", dashed: true },
    { key: "open", label: "Seen mining in the open", points: seen, stroke: "var(--brand-mark)" },
  ];

  return (
    <Figure
      title="Chance a miner reverses a payment"
      controls={<Slider label="Miner's share" value={pct} min={5} max={49} onChange={setPct} />}
      caption={
        <>
          For {percent(CONFIDENCE[HEADLINE])} safety, the line crossing the dotted rule: against {pct}% of the hashrate,{" "}
          <span className="text-foreground">{blocks(secretWait)}</span> if it may be mining in secret,{" "}
          <span className="text-foreground">{blocks(openWait)}</span> while it is seen mining in the open.
        </>
      }
    >
      <Plot
        series={series}
        xMax={xMax}
        yMax={1}
        log
        rules={[{ y: 1 - CONFIDENCE[HEADLINE], label: `${percent(CONFIDENCE[HEADLINE])} safe` }]}
        xTicks={niceTicks(xMax)}
        yTicks={LOG_TICKS}
        formatX={(x) => formatInt(x)}
        formatY={chance}
        label={`The chance a miner with ${pct}% of the hashrate reverses a payment, by confirmations`}
        readout={(z) => (
          <div className="flex flex-col gap-1 tabular-nums">
            <span className="text-muted-foreground">
              After {blocks(z)} ≈ {wait(z)}
            </span>
            <span>In secret: {chance(secret[z][1])}</span>
            <span>In the open: {chance(seen[z][1])}</span>
          </div>
        )}
      />
    </Figure>
  );
}

function percent(confidence: number): string {
  return `${+(confidence * 100).toFixed(2)}%`;
}

/**
 * Cost charts what a majority miner, at a share picked on a slider, gives
 * up to reverse a payment, against the confirmations it has, and where that
 * passes a payment typed in: the wait for it.
 */
function Cost({ initial, pay, usd }: { initial: number; pay: number; usd: number | null }) {
  const [pct, setPct] = useState(initial);
  const [amount, setAmount] = useState(() => Math.round(reversalCost(initial / 100, 24, pay) * (usd ?? 1)) || 1000);
  const id = useId();
  const q = pct / 100;
  const perBlock = reversalCost(q, 1, pay) * (usd ?? 1);
  const unit = usd !== null ? "$" : "LAX";
  const money = (v: number) => (usd !== null ? `$${significant.format(v)}` : `${significant.format(v)} LAX`);
  // The fewest confirmations that make reversing the payment cost more than it is worth
  const needed = perBlock > 0 ? Math.max(1, Math.ceil(amount / perBlock)) : null;
  const xMax = Math.min(MAX_CONFIRMATIONS, Math.max(24, Math.ceil((needed ?? 24) * 1.4)));
  const yMax = Math.max(amount * 1.3, perBlock * xMax) || 1;
  const points: [number, number][] = [
    [0, 0],
    [xMax, perBlock * xMax],
  ];

  return (
    <Figure
      title="What reversing a payment costs a majority miner"
      controls={
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Slider label="Miner's share" value={pct} min={50} max={100} onChange={setPct} />
          <label htmlFor={id} className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Payment</span>
            <span className="flex items-center border border-border bg-background focus-within:border-foreground/40">
              {usd !== null && <span className="pl-2 text-muted-foreground">{unit}</span>}
              <input
                id={id}
                type="number"
                min={0}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))}
                className="w-24 bg-transparent px-2 py-1 tabular-nums outline-none"
              />
              {usd === null && <span className="pr-2 text-muted-foreground">{unit}</span>}
            </span>
          </label>
        </div>
      }
      caption={
        needed !== null ? (
          <>
            Each confirmation costs a miner with {pct}% about <span className="text-foreground">{money(perBlock)}</span> to undo. For a{" "}
            {money(amount)} payment, wait <span className="text-foreground">{blocks(needed)}</span> ≈ {wait(needed)}: then reversing it costs
            more than it gains.
          </>
        ) : (
          "Waiting for blocks to price a confirmation."
        )
      }
    >
      <Plot
        series={[{ key: "cost", label: "Cost to reverse", points, stroke: "var(--brand-mark)" }]}
        xMax={xMax}
        yMax={yMax}
        log={false}
        rules={amount > 0 ? [{ y: amount, label: `payment ${money(amount)}` }] : []}
        marker={needed !== null && needed <= xMax ? { x: needed, label: blocks(needed) } : null}
        xTicks={niceTicks(xMax)}
        yTicks={niceTicks(yMax, 4)}
        formatX={(x) => formatInt(x)}
        formatY={(y) => (usd !== null ? `$${formatCompact(y)}` : formatCompact(y))}
        label={`What reversing a payment costs a miner with ${pct}% of the hashrate, by confirmations`}
        readout={(z) => (
          <div className="flex flex-col gap-1 tabular-nums">
            <span className="text-muted-foreground">
              After {blocks(z)} ≈ {wait(z)}
            </span>
            <span>Costs {money(perBlock * z)} to reverse</span>
          </div>
        )}
      />
    </Figure>
  );
}

/** The status dot's colours, the chance each starts below, and what each means. */
const DOT = [
  { grade: "good", label: "Mining in the open", below: 1, when: "Its blocks arrive as its share says they should. The shorter waits apply." },
  { grade: "off", label: "Unusually quiet", below: OPEN_CHANCE, when: "Odds of 1 in 100 or worse for a miner mining openly. Back to the longer waits." },
  { grade: "warn", label: "Possibly mining in secret", below: UNUSUAL_CHANCE, when: "Odds of 1 in 10,000 or worse. An alert is raised." },
  { grade: "critical", label: "Hold payments", below: HIDDEN_CHANCE, when: "Odds of 1 in a million or worse. Payments after its last block may be reversed." },
] as const;

const BAND: Record<(typeof DOT)[number]["grade"], string> = { good: "fill-good", off: "fill-off", warn: "fill-warn", critical: "fill-critical" };

/**
 * Silence charts how unlikely it is that a miner mining openly, at the
 * largest miner's share, goes so long without a block, with the status
 * dot's colours along the bottom and, while it is quiet, where it is now.
 */
function Silence({ share, blocktime, quiet }: { share: number; blocktime: number; quiet: Watch | null }) {
  // Seconds between its blocks, on average, mining openly
  const interval = blocktime / share;
  const minutes = (p: number) => (-Math.log(p) * interval) / 60;
  const xMax = Math.ceil(minutes(HIDDEN_CHANCE) * 1.25);
  const points: [number, number][] = Array.from({ length: xMax + 1 }, (_, m) => [m, Math.exp((-m * 60) / interval)]);
  const bands: Band[] = DOT.map((dot, i) => ({
    from: i === 0 ? 0 : minutes(dot.below),
    to: i + 1 < DOT.length ? minutes(DOT[i + 1].below) : xMax,
    className: BAND[dot.grade],
    label: dot.label,
  }));
  const silentFor = quiet && quiet.stretch.found === 0 ? quiet.stretch.seconds / 60 : null;

  return (
    <Figure
      title={`How long a miner with ${Math.round(share * 100)}% goes without a block`}
      caption={
        <>
          The chance a miner mining openly, finding one block in {formatClock(interval * 1000)} on average, goes this long without one. The
          strip shows the dot&apos;s colour: grey after {minutesLabel(Math.round(minutes(OPEN_CHANCE)))}, amber after{" "}
          {minutesLabel(Math.round(minutes(UNUSUAL_CHANCE)))}, red after {minutesLabel(Math.round(minutes(HIDDEN_CHANCE)))}. The watch also catches a miner
          publishing fewer blocks than its share says, over longer stretches.
        </>
      }
    >
      <Plot
        series={[{ key: "silence", label: "Chance of a silence this long", points, stroke: "var(--brand-mark)" }]}
        xMax={xMax}
        yMax={1}
        log
        bands={bands}
        marker={silentFor !== null ? { x: silentFor, label: "now" } : null}
        xTicks={minuteTicks(xMax)}
        yTicks={LOG_TICKS}
        formatX={minutesLabel}
        formatY={chance}
        step={1}
        label="The chance a miner mining openly goes so long without a block, by minutes"
        readout={(m) => {
          const p = Math.exp((-m * 60) / interval);
          const dot = [...DOT].reverse().find((d) => p < d.below) ?? DOT[0];

          return (
            <div className="flex flex-col gap-1 tabular-nums">
              <span className="text-muted-foreground">No block for {formatClock(m * 60_000)}</span>
              <span>Chance mining openly: {chance(p)}</span>
              <span className="flex items-center gap-1.5">
                <Indicator grade={dot.grade} label="" /> {dot.label}
              </span>
            </div>
          );
        }}
      />
    </Figure>
  );
}

// ---------------------------------------------------------------------------
// It has happened

const EXAMPLES = [
  {
    when: "January 2019",
    chain: "Ethereum Classic",
    what: "An attacker with a majority of the hashrate reorganized the chain again and again. Coinbase counted 15 reorganizations, 12 with double spends totalling about 219,500 ETC, around $1.1 million.",
    source: { label: "Security Affairs", href: "https://securityaffairs.com/79628/hacking/ethereum-classic-51-attack.html" },
  },
  {
    when: "May 2018",
    chain: "Bitcoin Gold",
    what: "An attacker took a majority of the hashrate and double-spent deposits at exchanges, about 388,000 BTG, around $18 million.",
    source: { label: "Wikipedia", href: "https://en.wikipedia.org/wiki/Bitcoin_Gold" },
  },
  {
    when: "2014",
    chain: "Bitcoin",
    what: "The GHash.io pool briefly passed half of Bitcoin's hashrate. Nothing was reversed, but under pressure it pledged to stay below 40%.",
    source: { label: "PYMNTS", href: "https://www.pymnts.com/news/2014/mining-pool-limits-its-own-power-for-the-greater-good-of-bitcoin/" },
  },
];

// ---------------------------------------------------------------------------
// The dialog

/**
 * Method is the tile's "method" button and the dialog it opens. The dialog's
 * body is only drawn while it is open: its charts work out hundreds of odds.
 */
export function Method({
  largest,
  blocktime,
  pay,
  usd,
  quiet,
}: {
  /** The largest miner of the week, once there are blocks enough to judge it. */
  largest: { name: string; share: number } | null;
  /** Mean seconds per block over the week. */
  blocktime: number;
  /** What a block pays, in LAX. */
  pay: number;
  usd: number | null;
  quiet: Watch | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [shown, setShown] = useState(false);
  const id = useId();
  const share = largest?.share ?? null;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setShown(true);
          dialog.current?.showModal();
        }}
        className="inline-flex cursor-pointer items-center gap-1 hover:text-foreground"
        aria-haspopup="dialog"
      >
        method
        <svg viewBox="0 0 16 16" className="size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 7.2v4M8 4.9v.1" strokeLinecap="round" />
        </svg>
      </button>

      <dialog
        ref={dialog}
        aria-labelledby={`${id}-title`}
        // Its contents go once it has finished closing, not while it fades out
        onClose={() => {
          const el = dialog.current;

          void Promise.allSettled(el?.getAnimations().map((animation) => animation.finished) ?? []).then(() => {
            if (!el?.open) setShown(false);
          });
        }}
        className="modal-dialog m-auto max-h-[90dvh] w-[min(56rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain border border-border bg-surface-elevated p-0 text-left text-sm whitespace-normal text-foreground shadow-[0_4px_10px_oklch(0_0_0/0.45),0_20px_48px_oklch(0_0_0/0.45)] backdrop:bg-black/60 backdrop:backdrop-blur-sm"
        onClick={(e) => {
          // A click on the backdrop lands on the dialog element itself
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
      >
        {/* The header stays in view while the rest scrolls, under a hairline of the logo gradient */}
        <header className="sticky top-0 z-20 border-b border-border bg-surface-elevated/90 backdrop-blur-md">
          <div aria-hidden className="brand-gradient h-0.5" />
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 sm:px-8">
            <div className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] tracking-[0.15em] text-brand uppercase">Recommended confirmations</span>
              <h2 id={`${id}-title`} className="text-2xl">
                How the wait is worked out
              </h2>
              <p className="text-sm text-muted-foreground">
                Against the largest miner of the last 7 days trying to reverse a payment
                {largest ? (
                  <>
                    : now <span className="text-foreground">{largest.name}</span>, with {Math.round(largest.share * 100)}% of the blocks.
                  </>
                ) : (
                  "."
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="-mr-2 inline-flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              aria-label="Close"
            >
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>

        {shown && (
          <div className="flex flex-col gap-8 px-6 pt-6 pb-7 leading-relaxed sm:px-8">
            <Section title="The threat">
              <p className="text-muted-foreground">
                To reverse a payment, a miner builds a competing chain in secret, one that leaves the payment out. Once it is longer than the
                public chain, the miner publishes it. Nodes always follow the longest chain, so they switch to it, and the payment is gone,
                along with every confirmation it had. Each confirmation is one more block the secret chain must overtake. A pool counts as
                one miner, since it decides what all its miners work on.
              </p>
              <Figure
                title="A payment with 6 confirmations, reversed"
                caption="The secret chain branches off just before the payment's block. Published once it is one block longer, it replaces the public chain: all 6 confirmations, and the payment, disappear."
              >
                <Fork />
              </Figure>
            </Section>

            <Section title="Below half the hashrate">
              <p className="text-muted-foreground">
                A miner with less than half the hashrate falls behind on average, so it can only catch up by luck, and its odds shrink
                with every confirmation. They are worked out exactly, as in{" "}
                <a href={ROSENFELD} target="_blank" rel="noopener noreferrer" className={link}>
                  Rosenfeld (2014)
                </a>
                , rather than by the approximation in section 11 of the{" "}
                <a href={BITCOIN_PAPER} target="_blank" rel="noopener noreferrer" className={link}>
                  Bitcoin paper
                </a>
                , which understates them: against 30% of the hashrate, 99.9% safety takes 32 blocks, not the paper&apos;s 24.
              </p>
              <p className="text-muted-foreground">
                Those odds assume the miner was mining in secret the whole time the payment was being confirmed, getting a head start.
                But hashrate cannot be in two places at once: if its blocks keep arriving at the rate its share says they should, it was
                not. It could only start after the payment is accepted, from as far behind as the payment is deep, and needs far fewer
                confirmations. It could still hide part of its hashrate and pass the gap off as bad luck, up to about a third of it, so
                the shorter waits allow for that. They hold for payments accepted while the status dot is green.
              </p>
              <Odds initial={share !== null && share < 0.5 ? Math.max(5, Math.round(share * 100)) : 30} />
            </Section>

            <Section title="Half the hashrate or more">
              <p className="text-muted-foreground">
                A miner with a majority finds blocks faster than everyone else together, so it always catches up eventually, however long
                the wait. Watching it does not help either: it can start a secret chain after the payment is accepted, beginning below it.
              </p>
              <p className="text-muted-foreground">
                What protects a payment then is cost. The blocks it replaces are mostly its own, and their rewards are lost with them:
                about its share of each block&apos;s pay, for every confirmation. Wait until reversing the payment costs the miner more than
                the payment is worth. This leaves out what cannot be counted, such as the pool&apos;s miners leaving it, or the price
                falling once an attack is seen.
              </p>
              {pay > 0 && <Cost initial={share !== null && share >= 0.5 ? Math.round(share * 100) : 60} pay={pay} usd={usd} />}
            </Section>

            <Section title="The status dot">
              <p className="text-muted-foreground">
                Hashrate spent on a secret chain is missing from the public one, so a miner mining in secret stops publishing blocks, or
                publishes fewer than its share. The tile watches the largest miner&apos;s last 144 blocks, once it has{" "}
                {Math.round(WATCH_MIN_SHARE * 100)}% of the blocks or more. A miner that is merely down looks the same, and is treated
                the same: if a reversal came, it would come from that miner. Fewer blocks only count against it while it also publishes
                less than its share of everyone&apos;s: when hashrate leaves every pool alike, all of them slow down together, and that
                is not mining in secret.
              </p>
              <dl className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
                {DOT.map(({ grade, label, when }) => (
                  <div key={grade} className="flex flex-col gap-0.5">
                    <dt className="flex items-baseline gap-2">
                      <Indicator grade={grade} label="" className="relative top-px" />
                      {label}
                    </dt>
                    <dd className="pl-4 text-muted-foreground">{when}</dd>
                  </div>
                ))}
              </dl>
              {blocktime > 0 && <Silence share={share !== null && share >= WATCH_MIN_SHARE ? share : 0.5} blocktime={blocktime} quiet={quiet} />}
            </Section>

            <Section title="It has happened">
              <p className="text-muted-foreground">Majority attacks are not only theory. Smaller proof-of-work chains have lost millions to them.</p>
              <ul className="grid gap-3 sm:grid-cols-3">
                {EXAMPLES.map((example) => (
                  <li key={example.chain} className="flex flex-col gap-2 border border-border bg-card p-4">
                    <span className="font-mono text-[10px] tracking-[0.15em] text-muted-foreground uppercase">{example.when}</span>
                    <span className="font-medium">{example.chain}</span>
                    <p className="flex-1 text-xs leading-relaxed text-muted-foreground">{example.what}</p>
                    <a href={example.source.href} target="_blank" rel="noopener noreferrer" className={`inline-flex items-center gap-1 text-xs ${link}`}>
                      {example.source.label} <ExternalIcon />
                    </a>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title="Not counted">
              <p className="text-muted-foreground">
                Hashrate rented or brought in for an attack, which never shows on the chain beforehand; and pools working together.
                Large payments deserve a margin above what the tile says.
              </p>
            </Section>
          </div>
        )}

        <footer className="flex flex-wrap gap-2 border-t border-border bg-card px-6 py-4 sm:px-8">
          <a href={ROSENFELD} target="_blank" rel="noopener noreferrer" className={footerLink}>
            Rosenfeld (2014) <ExternalIcon />
          </a>
          <a href={BITCOIN_PAPER} target="_blank" rel="noopener noreferrer" className={footerLink}>
            Bitcoin paper <ExternalIcon />
          </a>
          <a href={METHODS} target="_blank" rel="noopener noreferrer" className={footerLink}>
            All methods <ExternalIcon />
          </a>
        </footer>
      </dialog>
    </>
  );
}
