"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  DEEP_REORG,
  deepReorg,
  majority,
  reorgLevel,
  SLOW_SPREAD_MS,
  staleChance,
  stallLevel,
  VERY_DEEP_REORG,
  VERY_SLOW_SPREAD_MS,
} from "@/lib/alert-levels";
import { formatAgo, formatClock, formatCompact, formatInt, formatMs, shortHash } from "@/lib/format";
import type { Charts, PublicNode } from "@/lib/protocol";
import type { Release } from "@/lib/releases";
import { compareParts, parseVersion } from "@/lib/version";
import { watch } from "@/lib/withholding";
import { SOUND_KEY } from "./block-toast";
import { reorgChime } from "./chime";
import { useServerNow } from "./live/provider";
import { FADE_IN, FADE_OUT, SPRING } from "./motion";
import { usePersistent } from "./use-persistent";

/** How long the reorganization sound waits, to follow a new block's chime. */
const REORG_SOUND_DELAY_MS = 700;

const MINING_POOL_STATS = "https://miningpoolstats.stream/parallax";

export type Tone = "critical" | "warn" | "info";

/**
 * Each tone's surface, as on the plates: square, hairlines in the tone, a
 * severity bar down the leading edge and a wash fading from it.
 */
const TONE: Record<Tone, { box: string; bar: string; icon: string; ink: string; label: string }> = {
  critical: {
    box: "border-critical/35 bg-linear-to-r from-critical/[0.11] via-critical/[0.04] to-transparent",
    bar: "bg-critical",
    icon: "border-critical/40 text-critical-ink",
    ink: "text-critical-ink",
    label: "Critical",
  },
  warn: {
    box: "border-warn/35 bg-linear-to-r from-warn/[0.11] via-warn/[0.04] to-transparent",
    bar: "bg-warn",
    icon: "border-warn/40 text-warn-ink",
    ink: "text-warn-ink",
    label: "Warning",
  },
  info: {
    box: "border-info/35 bg-linear-to-r from-info/[0.11] via-info/[0.04] to-transparent",
    bar: "bg-info",
    icon: "border-info/40 text-info-ink",
    ink: "text-info-ink",
    label: "Notice",
  },
};

/** What each kind of alert is about, named in its eyebrow after the severity. */
const TOPIC: Record<keyof typeof ICON, string> = {
  stall: "Block stall",
  reorg: "Deep reorg",
  split: "Chain split",
  majority: "Mining majority",
  withholding: "Hidden mining",
  spread: "Slow propagation",
  release: "New release",
};

const ICON = {
  // A clock for a stall
  stall: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // A chain that branches off for a reorganization
  reorg: (
    <>
      <path d="M7 4v16M7 9c0 4 10 2 10 7v4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="17" cy="6" r="2" />
    </>
  ),
  // One line splitting in two for a chain split
  split: <path d="M12 21v-7M12 14 6 4M12 14l6-10M4 6.5 6 4l2.5 1.5M15.5 5.5 18 4l2 2.5" strokeLinecap="round" strokeLinejoin="round" />,
  // A pie with one dominant slice for a mining majority
  majority: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      {/* Most of the pie filled, from the top round to about 300°, so it never reads as a clock */}
      <path d="M12 12V3.75A8.25 8.25 0 1 1 4.86 7.88Z" fill="currentColor" fillOpacity="0.35" strokeLinejoin="round" />
    </>
  ),
  // An eye struck through for a miner whose blocks have stopped showing
  withholding: (
    <>
      <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M4.5 4.5l15 15" strokeLinecap="round" />
    </>
  ),
  // Ripples spreading slowly from a source, for slow propagation
  spread: (
    <>
      <circle cx="12" cy="12" r="1.75" />
      <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" strokeLinecap="round" />
    </>
  ),
  // An arrow down into a tray for a release
  release: <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" strokeLinecap="round" strokeLinejoin="round" />,
};

export interface Alert {
  key: string;
  tone: Tone;
  icon: keyof typeof ICON;
  title: string;
  body: ReactNode;
  /** Who can act on the alert and what they should do, on its own line in the alert's colour. */
  ask?: { who: string; what: string };
  facts: string[];
  action?: { href: string; label: string; external?: boolean };
}

/**
 * AlertItem is one alert in the status card, minimized to a line or
 * expanded to a band across the card, edge to edge: what happened, why it
 * matters and the facts behind it. It changes in place: its height eases
 * from one to the other as they crossfade, so the alerts around it only
 * glide aside.
 */
function AlertItem({ alert, open, onToggle }: { alert: Alert; open: boolean; onToggle: () => void }) {
  const { tone, icon, title, body, ask, facts, action } = alert;
  const expand = useRef<HTMLButtonElement>(null);
  const collapse = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  const line = useRef<HTMLDivElement>(null);
  const band = useRef<HTMLDivElement>(null);
  // Both forms' heights, for the alert's own height to ease between: until measured it is the line's
  const [heights, setHeights] = useState<{ line: number; band: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      if (line.current && band.current) setHeights({ line: line.current.offsetHeight, band: band.current.offsetHeight });
    };
    const observer = new ResizeObserver(measure);

    measure();
    if (line.current) observer.observe(line.current);
    if (band.current) observer.observe(band.current);

    return () => observer.disconnect();
  }, []);

  // The button pressed goes inert with its half: focus follows to the other one
  useEffect(() => {
    if (!toggled.current) return;

    toggled.current = false;
    (open ? collapse : expand).current?.focus({ preventScroll: true });
  }, [open]);

  function toggle() {
    toggled.current = true;
    onToggle();
  }

  return (
    <motion.div
      className="relative overflow-hidden"
      initial={false}
      animate={{ height: heights ? (open ? heights.band : heights.line) : "auto" }}
      transition={SPRING}
    >
      {/* The line holds the alert's place; the band lies over it, the two crossfading */}
      <div ref={line} className={open ? "pointer-events-none" : ""} inert={open}>
        <motion.div
          className="flex gap-2.5 px-5 py-[3px] text-sm leading-5"
          initial={false}
          animate={open ? { opacity: 0, y: -4 } : { opacity: 1, y: 0 }}
          transition={open ? FADE_OUT : FADE_IN}
        >
          {/* Centred on the first line, so a title that wraps on a narrow screen keeps its dot beside it */}
          <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${WARNING_DOT[tone]}`} />
          {/* Expand runs on after the title like a word, wrapping with it */}
          <p className="min-w-0">
            {title}{" "}
            <button
              ref={expand}
              type="button"
              onClick={toggle}
              aria-expanded={false}
              className="ml-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Expand
            </button>
          </p>
        </motion.div>
      </div>

      {/* Spaced from the lines around it, inside the part that grows, so the space eases in too */}
      <div ref={band} className={`absolute inset-x-0 top-0 ${open ? "" : "pointer-events-none"}`} inert={!open}>
        <div className="py-2">
          <motion.section
            role="status"
            className={`relative flex flex-col gap-3 border-y px-5 py-4 sm:flex-row sm:items-center sm:gap-6 ${TONE[tone].box}`}
            initial={false}
            animate={open ? { opacity: 1, y: 0 } : { opacity: 0, y: 4 }}
            transition={open ? FADE_IN : FADE_OUT}
          >
            <span aria-hidden className={`absolute inset-y-0 left-0 w-[3px] ${TONE[tone].bar}`} />
            <div className="flex min-w-0 flex-1 items-start gap-3.5">
              {/* A critical alert's icon pulses a few times as it opens, then rests */}
              <span
                className={`relative mt-0.5 flex size-8 shrink-0 items-center justify-center border bg-background/40 ${TONE[tone].icon} ${tone === "critical" && open ? "alert-pulse" : ""}`}
              >
                <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                  {ICON[icon]}
                </svg>
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <p className={`font-mono text-[10px] tracking-[0.15em] uppercase ${TONE[tone].ink}`}>
                  {TONE[tone].label} <span className="text-muted-foreground/60">·</span> {TOPIC[icon]}
                </p>
                <p className="text-sm leading-5 font-semibold">{title}</p>
                <p className="text-sm leading-5 text-muted-foreground">{body}</p>
                {ask && (
                  <p className="text-sm leading-5">
                    <span className={`font-semibold ${TONE[tone].ink}`}>{ask.who}:</span> {ask.what}
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-[2.875rem] sm:shrink-0 sm:pl-0">
              {facts.map((fact) => (
                <span key={fact} className="font-mono text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  {fact}
                </span>
              ))}
              {action && <AlertAction action={action} />}
              {/* Quieter than the action beside it: an outline only, in muted ink */}
              <button
                ref={collapse}
                type="button"
                onClick={toggle}
                aria-expanded
                className="inline-flex h-7 items-center border border-border px-2.5 text-xs whitespace-nowrap text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
              >
                Collapse
              </button>
            </div>
          </motion.section>
        </div>
      </div>
    </motion.div>
  );
}

/** AlertAction is an alert's next step, a square button like the page's other controls. */
function AlertAction({ action }: { action: NonNullable<Alert["action"]> }) {
  return (
    <a
      href={action.href}
      {...(action.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="inline-flex h-7 items-center gap-1.5 border border-border bg-background/50 px-2.5 text-xs whitespace-nowrap transition-colors hover:border-foreground/30 hover:bg-background"
    >
      {action.label}
      <svg viewBox="0 0 16 16" className="size-3 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        {action.external ? (
          <path d="M6 3.5h6.5V10M12.5 3.5 4 12" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M3 8h10M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </a>
  );
}

const SEVERITY: Record<Tone, number> = { critical: 0, warn: 1, info: 2 };

const plural = (count: number, word: string) => `${formatInt(count)} ${count === 1 ? word : `${word}s`}`;

/**
 * useAlerts works out what needs attention, most severe first: verified nodes on different chains, no block for longer than the
 * stall threshold, a recent chain reorganization, one miner holding a
 * majority, blocks slow to reach the network, and
 * a client release most nodes have not caught up with.
 */
export function useAlerts({
  bestBlock,
  foundAt,
  charts,
  nodes,
  latestRelease,
}: {
  bestBlock: number;
  foundAt: number;
  charts: Charts | null;
  nodes: PublicNode[];
  latestRelease: Release | null;
}): Alert[] {
  const now = useServerNow();
  const health = charts?.health ?? null;
  const alerts: Alert[] = [];
  const [sound] = usePersistent(SOUND_KEY, true);
  // The deep reorganization to sound, by when it happened: one is often measured
  // as 1 block deep at first and found deeper moments later, and sounds then
  const lastDeep = health?.lastDeepReorg !== undefined ? health.lastDeepReorg : health?.lastReorg;
  const deepAt = lastDeep && (lastDeep.depth ?? 1) >= DEEP_REORG ? lastDeep.at : null;
  const veryDeep = (lastDeep?.depth ?? 1) >= VERY_DEEP_REORG;
  const heardReorg = useRef<number | null | undefined>(undefined);

  // Sound a deep reorganization as it happens; one already on show at load stays quiet
  useEffect(() => {
    const before = heardReorg.current;

    heardReorg.current = deepAt;

    if (before === undefined || deepAt === null || deepAt === before || !sound) return;

    // A reorganization usually comes with a new block: follow its chime rather than talk over it.
    // The critical one adds a third, lower note.
    window.setTimeout(() => reorgChime(veryDeep), REORG_SOUND_DELAY_MS);
  }, [deepAt, sound, veryDeep]);

  // Verified nodes following different chains
  const split = health?.split ?? null;

  if (split) {
    alerts.push({
      key: "split",
      tone: "critical",
      icon: "split",
      title: `Verified nodes are on ${split.chains} different chains.`,
      body:
        split.height !== null
          ? `They agree up to block #${formatInt(split.height)}, then part: some of the network may have forked.`
          : "Some of the network may have forked.",
      facts: [plural(split.nodes, "verified node")],
    });
  }

  // No block for a long time
  const elapsed = foundAt ? now - foundAt : 0;

  if (stallLevel(foundAt, now)) {
    alerts.push({
      key: "stall",
      tone: "critical",
      icon: "stall",
      title: `No new block for ${formatClock(elapsed)}.`,
      body: "The network may have stalled.",
      facts: [`Last block #${formatInt(bestBlock)}`, `${Math.floor(elapsed / 600_000)}× the 10 min target`],
    });
  }

  // A recent deep reorganization; shallower ones are routine and only counted in the stale blocks panel
  const reorg = deepReorg(health, now);

  if (reorg) {
    const tone = reorgLevel(reorg.depth ?? 1);

    alerts.push({
      key: "reorg",
      tone,
      icon: "reorg",
      title: `${tone === "critical" ? "Deep chain reorganization" : "Chain reorganization"} at block #${formatInt(reorg.height)}.`,
      body:
        tone === "critical"
          ? "Blocks from that height were replaced by a longer chain. Wait for more confirmations before treating recent payments as final."
          : "Blocks from that height were replaced by a longer chain.",
      facts: [`${plural(reorg.depth ?? 1, "block")} deep`, `Seen by ${plural(reorg.nodes, "node")}`, formatAgo(reorg.at, now)],
      action: { href: "#stale-blocks", label: "Chain health" },
    });
  }

  // One miner with most of the last week's blocks
  const held = majority(charts);

  if (held) {
    const { miner: top, share, blocks: minerBlocks } = held;

    alerts.push({
      key: `majority:${top.pool?.name ?? top.miner}`,
      tone: "critical",
      icon: "majority",
      // A known pool by name, anyone else by address
      title: `${top.pool?.name ?? `Miner ${shortHash(top.miner)}`} found ${Math.round(share * 100)}% of the last week's blocks.`,
      body: `With most of the hashrate, one ${top.pool ? "pool" : "miner"} could reverse payments or censor transactions.`,
      // The only ones who can fix it: a majority shrinks as its miners move elsewhere
      ask: { who: "If you mine LAX", what: "move some or all of your hashrate to a smaller pool." },
      facts: [`${formatInt(top.blocks)} of ${formatInt(minerBlocks)} blocks`],
      action: { href: MINING_POOL_STATS, label: "Find a smaller pool", external: true },
    });
  }

  // The largest miner's blocks stopping, or slowing, as they would while it mines a chain in secret
  const quiet = watch(charts, now);

  if (quiet?.level) {
    const { name, share, stretch, chance } = quiet;

    alerts.push({
      key: "withholding",
      tone: quiet.level,
      icon: "withholding",
      title:
        stretch.found === 0
          ? `${name} has published no block for ${formatClock(stretch.seconds * 1000)}.`
          : `${name} published ${plural(stretch.found, "block")} in ${formatClock(stretch.seconds * 1000)}, against ${formatInt(Math.round(stretch.expected))} expected.`,
      body: `It found ${Math.round(share * 100)}% of the week's blocks. A miner that stops publishing may be mining a chain in secret to replace recent payments, or may just be down: payments in blocks after #${formatInt(stretch.height)} are not settled until it is back.`,
      ask: { who: "If you accept LAX", what: `hold off on payments confirmed after block #${formatInt(stretch.height)}.` },
      facts: [`1 in ${formatCompact(1 / chance)} if mining openly`],
      action: { href: "#mining", label: "Recommended confirmations" },
    });
  }

  // Blocks slow to reach the network: the chance a competing block is found meanwhile
  const spread = charts?.propagation.spread ?? null;

  if (spread && spread.median > SLOW_SPREAD_MS) {
    alerts.push({
      key: "spread",
      tone: spread.median > VERY_SLOW_SPREAD_MS ? "critical" : "warn",
      icon: "spread",
      title: `Blocks are taking ${formatMs(spread.median)} to reach most nodes.`,
      body: `Slow propagation raises the chance of stale blocks, here to about ${(staleChance(spread.median) * 100).toFixed(1)}%, and favours the largest miners.`,
      facts: [`Last ${plural(spread.blocks, "block")}`],
    });
  } else if (spread?.slowMiner) {
    const slow = spread.slowMiner;

    alerts.push({
      key: "slow-miner",
      tone: "warn",
      icon: "spread",
      title: `Blocks from ${slow.pool ?? shortHash(slow.miner)} take ${formatMs(slow.median)} to reach most nodes.`,
      body: "Other miners' blocks spread within seconds, so this usually means the miner is poorly connected to the network.",
      facts: [plural(slow.blocks, "block")],
    });
  }

  // A release that online nodes have not caught up with
  const latest = latestRelease ? parseVersion(`/${latestRelease.tag}`) : null;
  const online = nodes.filter((node) => node.stats.active);
  const behind = online.filter((node) => {
    const { parts } = parseVersion(node.info.node);

    return parts !== null && latest?.parts && compareParts(parts, latest.parts) < 0;
  });

  if (latestRelease && latest && behind.length > 0) {
    alerts.push({
      key: `release:${latestRelease.tag}`,
      tone: "info",
      icon: "release",
      title: `Parallax ${latest.label} is out.`,
      body: `${behind.length} of ${plural(online.length, "online node")} ${behind.length === 1 ? "runs" : "run"} an older version.`,
      facts: [],
      action: { href: latestRelease.url, label: "Release notes", external: true },
    });
  }

  // Every alert that applies, most severe first; array sort is stable, so within a tone the order above holds
  return alerts.sort((a, b) => SEVERITY[a.tone] - SEVERITY[b.tone]);
}

/**
 * Alerts lists what needs attention, most severe first, each minimized
 * until expanded. Alerts there when the page loads simply appear; ones that
 * come up later open their space and slide in, and ones that clear close it.
 */
export function Alerts({ alerts, className = "" }: { alerts: Alert[]; className?: string }) {
  const [expanded, setExpanded] = useState<string[]>([]);

  return (
    <div className={`flex flex-col ${className}`}>
      <AnimatePresence initial={false}>
        {alerts.map((alert, i) => (
          <motion.div
            key={alert.key}
            className="-mx-5 overflow-hidden"
            initial={{ height: 0, opacity: 0, y: -8 }}
            animate={{ height: "auto", opacity: 1, y: 0, transition: { ...SPRING, delay: i * 0.06 } }}
            exit={{ height: 0, opacity: 0, transition: SPRING }}
          >
            <AlertItem
              alert={alert}
              open={expanded.includes(alert.key)}
              onToggle={() =>
                setExpanded((keys) => (keys.includes(alert.key) ? keys.filter((k) => k !== alert.key) : [...keys, alert.key]))
              }
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export const WARNING_DOT: Record<Tone, string> = { critical: "bg-critical", warn: "bg-warn", info: "bg-info" };

/**
 * AlertCount is the section bar's button for the alerts: how many apply, in
 * the most severe one's colour. It opens them in a panel below it, in place,
 * closed again by a click elsewhere or Escape.
 */
export function AlertCount({ alerts }: { alerts: Alert[] }) {
  const [open, setOpen] = useState(false);
  // The status card's history, opened on the way to it: the same key as the card's own toggle
  const [, setHistory] = usePersistent("incident-history", false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useId();

  useEffect(() => {
    if (!open) return;

    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);

    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (alerts.length === 0) return null;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panel}
        aria-label={plural(alerts.length, "alert")}
        className={`inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 font-mono text-[11px] tabular-nums hover:bg-accent/50 ${open ? "bg-accent/50" : ""}`}
      >
        <span aria-hidden className="relative flex size-2">
          {alerts[0].tone === "critical" && (
            <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${WARNING_DOT.critical}`} />
          )}
          <span className={`relative inline-flex size-2 rounded-full ${WARNING_DOT[alerts[0].tone]}`} />
        </span>
        {alerts.length}
      </button>
      {open && (
        <div
          id={panel}
          className="absolute top-full right-0 z-40 mt-2 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-1.5 border border-border bg-surface-elevated p-1.5 shadow-2xl"
        >
          {alerts.map((alert) => (
            <section key={alert.key} className={`relative flex gap-3 border py-3 pr-3 pl-3.5 ${TONE[alert.tone].box}`}>
              <span aria-hidden className={`absolute inset-y-0 -left-px w-0.5 ${TONE[alert.tone].bar}`} />
              <span className={`flex size-7 shrink-0 items-center justify-center border bg-background/40 ${TONE[alert.tone].icon}`}>
                <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                  {ICON[alert.icon]}
                </svg>
              </span>
              <div className="flex min-w-0 flex-col gap-1 text-xs">
                <p className={`font-mono text-[10px] tracking-[0.15em] uppercase ${TONE[alert.tone].ink}`}>
                  {TONE[alert.tone].label} <span className="text-muted-foreground/60">·</span> {TOPIC[alert.icon]}
                </p>
                <p className="font-semibold">{alert.title}</p>
                <p className="text-muted-foreground">{alert.body}</p>
                {alert.ask && (
                  <p>
                    <span className={`font-semibold ${TONE[alert.tone].ink}`}>{alert.ask.who}:</span> {alert.ask.what}
                  </p>
                )}
                {(alert.facts.length > 0 || alert.action) && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
                    {alert.facts.map((fact) => (
                      <span key={fact} className="font-mono whitespace-nowrap text-muted-foreground tabular-nums">
                        {fact}
                      </span>
                    ))}
                    {alert.action && <AlertAction action={alert.action} />}
                  </div>
                )}
              </div>
            </section>
          ))}
          {/* What came before: closes the panel on the way, so it does not cover the timeline, and opens it */}
          <a
            href="#incidents"
            onClick={() => {
              setOpen(false);
              setHistory(true);
            }} className="px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
            See past incidents
          </a>
        </div>
      )}
    </div>
  );
}
