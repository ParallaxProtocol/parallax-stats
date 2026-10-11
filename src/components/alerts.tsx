"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { DEEP_REORG, majority, recentReorg, SLOW_SPREAD_MS, stallLevel, VERY_SLOW_SPREAD_MS } from "@/lib/alert-levels";
import { formatAgo, formatClock, formatInt, formatMs, shortHash } from "@/lib/format";
import type { Charts, PublicNode } from "@/lib/protocol";
import type { Release } from "@/lib/releases";
import { compareParts, parseVersion } from "@/lib/version";
import { SOUND_KEY } from "./block-toast";
import { reorgChime } from "./chime";
import { useServerNow } from "./live/provider";
import { usePersistent } from "./use-persistent";

/** A dismissed majority alert comes back after this long, or sooner if the share grows this much. */
const MAJORITY_SNOOZE_MS = 24 * 60 * 60 * 1000;
const MAJORITY_REGROWTH = 0.05;
/** How long the reorganization sound waits, to follow a new block's chime. */
const REORG_SOUND_DELAY_MS = 700;
/** Banners shown at once, most severe first. */
const MAX_BANNERS = 2;

const MINING_POOL_STATS = "https://miningpoolstats.stream/parallax";

type Tone = "critical" | "warn" | "info";

const TONE: Record<Tone, { box: string; icon: string }> = {
  critical: {
    box: "border-critical/30 bg-linear-to-r from-critical/15 via-critical/[0.06] to-transparent",
    icon: "bg-critical/20 text-critical-ink",
  },
  warn: {
    box: "border-warn/30 bg-linear-to-r from-warn/15 via-warn/[0.06] to-transparent",
    icon: "bg-warn/20 text-warn-ink",
  },
  info: {
    box: "border-info/30 bg-linear-to-r from-info/15 via-info/[0.06] to-transparent",
    icon: "bg-info/20 text-info-ink",
  },
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
      <path d="M12 3.75V12l6.3 5.3" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // An eye with a slash: nothing verified is watching
  unverified: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.75" />
      <path d="m4 20 16-16" strokeLinecap="round" />
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

interface Alert {
  key: string;
  tone: Tone;
  icon: keyof typeof ICON;
  title: string;
  body: ReactNode;
  facts: string[];
  action?: { href: string; label: string; external?: boolean };
  /** Present when the viewer may dismiss the alert. */
  dismiss?: () => void;
}

/** Banner is one alert across the top of the page: what happened, why it matters and the facts behind it. */
function Banner({ alert }: { alert: Alert }) {
  const { tone, icon, title, body, facts, action, dismiss } = alert;

  return (
    <section
      role="status"
      className={`flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:gap-4 ${TONE[tone].box}`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className={`flex size-8 shrink-0 items-center justify-center rounded-full ${TONE[tone].icon}`}>
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
            {ICON[icon]}
          </svg>
        </span>
        <p className="min-w-0 text-sm">
          <span className="font-semibold">{title}</span> <span className="text-muted-foreground">{body}</span>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 pl-11 sm:shrink-0 sm:pl-0">
        {facts.map((fact) => (
          <span key={fact} className="rounded-full border border-border bg-background/50 px-2.5 py-0.5 text-xs whitespace-nowrap tabular-nums">
            {fact}
          </span>
        ))}
        {action && (
          <a
            href={action.href}
            {...(action.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className="px-1 text-xs whitespace-nowrap text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
          >
            {action.label}
          </a>
        )}
        {dismiss && (
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-background/50 hover:text-foreground"
            aria-label="Dismiss"
          >
            <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </section>
  );
}

const SEVERITY: Record<Tone, number> = { critical: 0, warn: 1, info: 2 };
const NO_DISMISSALS: Record<string, { until?: number; share?: number }> = {};

const plural = (count: number, word: string) => `${formatInt(count)} ${count === 1 ? word : `${word}s`}`;

/**
 * Alerts calls out what needs attention at the top of the page, most severe
 * first: verified nodes on different chains, no block for longer than the
 * stall threshold, a recent chain reorganization, one miner holding a
 * majority, blocks slow to reach the network, no verified node online, and
 * a client release most nodes have not caught up with.
 */
export function Alerts({
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
}) {
  const now = useServerNow();
  const [dismissed, setDismissed] = usePersistent("dismissed-alerts", NO_DISMISSALS);
  const health = charts?.health ?? null;
  const alerts: Alert[] = [];
  const [sound] = usePersistent(SOUND_KEY, true);
  const lastReorgAt = health?.lastReorg?.at ?? null;
  const heardReorg = useRef<number | null | undefined>(undefined);

  // Sound a reorganization as it happens; one already on show at load stays quiet
  useEffect(() => {
    const before = heardReorg.current;

    heardReorg.current = lastReorgAt;

    if (before === undefined || lastReorgAt === null || lastReorgAt === before || !sound) return;

    // A reorganization usually comes with a new block: follow its chime rather than talk over it
    // Not cancelled when the depth is refined meanwhile, which re-runs this effect
    const deep = (health?.lastReorg?.depth ?? 1) >= DEEP_REORG;

    window.setTimeout(() => reorgChime(deep), REORG_SOUND_DELAY_MS);
  }, [lastReorgAt, sound, health?.lastReorg?.depth]);
  const dismissKey = (key: string, value: { until?: number; share?: number }) => setDismissed({ ...dismissed, [key]: value });

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

  // A recent reorganization, serious when deep
  const reorg = recentReorg(health, now);

  if (reorg) {
    const depth = reorg.depth ?? 1;
    const deep = depth >= DEEP_REORG;

    alerts.push({
      key: "reorg",
      tone: deep ? "critical" : "warn",
      icon: "reorg",
      title: `${deep ? "Deep chain reorganization" : "Chain reorganization"} at block #${formatInt(reorg.height)}.`,
      body: deep
        ? "Blocks from that height were replaced by a longer chain. Wait for more confirmations before treating recent payments as final."
        : "Blocks at that height were replaced by a longer chain.",
      facts: [`${plural(depth, "block")} deep`, `Seen by ${plural(reorg.nodes, "node")}`, formatAgo(reorg.at, now)],
      action: { href: "#stale-blocks", label: "Chain health" },
    });
  }

  // One miner with most of the last week's blocks
  const held = majority(charts);

  if (held) {
    const { miner: top, share, blocks: minerBlocks } = held;
    const key = `majority:${top.pool?.name ?? top.miner}`;
    const snoozed = dismissed[key];

    if (!snoozed || now > (snoozed.until ?? 0) || share >= (snoozed.share ?? 0) + MAJORITY_REGROWTH) {
      alerts.push({
        key,
        tone: "critical",
        icon: "majority",
        // A known pool by name, anyone else by address
        title: `${top.pool?.name ?? `Miner ${shortHash(top.miner)}`} found ${Math.round(share * 100)}% of the last week's blocks.`,
        body: "With most of the hashrate, one miner could rewrite recent blocks or censor transactions. Miners: spread your hashrate across more pools.",
        facts: [`${formatInt(top.blocks)} of ${formatInt(minerBlocks)} blocks`],
        action: { href: MINING_POOL_STATS, label: "Compare pools", external: true },
        dismiss: () => dismissKey(key, { until: now + MAJORITY_SNOOZE_MS, share }),
      });
    }
  }

  // Blocks slow to reach the network: the chance a competing block is found meanwhile
  const spread = charts?.propagation.spread ?? null;
  const staleChance = (ms: number) => `${(100 * (1 - Math.exp(-ms / 1000 / 600))).toFixed(1)}%`;

  if (spread && spread.median > SLOW_SPREAD_MS) {
    alerts.push({
      key: "spread",
      tone: spread.median > VERY_SLOW_SPREAD_MS ? "critical" : "warn",
      icon: "spread",
      title: `Blocks are taking ${formatMs(spread.median)} to reach most nodes.`,
      body: `Slow propagation raises the chance of stale blocks, here to about ${staleChance(spread.median)}, and favours the largest miners.`,
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

  // Verified nodes known, but none online
  if (nodes.some((node) => node.trusted) && !nodes.some((node) => node.trusted && node.stats.active)) {
    alerts.push({
      key: "unverified",
      tone: "info",
      icon: "unverified",
      title: "No verified node is online.",
      body: "The best block and charts follow self-reported nodes until one returns, and what they report is not checked.",
      facts: [],
    });
  }

  // A release that online nodes have not caught up with
  const latest = latestRelease ? parseVersion(`/${latestRelease.tag}`) : null;
  const online = nodes.filter((node) => node.stats.active);
  const behind = online.filter((node) => {
    const { parts } = parseVersion(node.info.node);

    return parts !== null && latest?.parts && compareParts(parts, latest.parts) < 0;
  });

  if (latestRelease && latest && behind.length > 0 && !dismissed[`release:${latestRelease.tag}`]) {
    const key = `release:${latestRelease.tag}`;

    alerts.push({
      key,
      tone: "info",
      icon: "release",
      title: `Parallax ${latest.label} is out.`,
      body: `${behind.length} of ${plural(online.length, "online node")} ${behind.length === 1 ? "runs" : "run"} an older version.`,
      facts: [],
      action: { href: latestRelease.url, label: "Release notes", external: true },
      dismiss: () => dismissKey(key, {}),
    });
  }

  if (alerts.length === 0) return null;

  // Array sort is stable: within a tone, the order above holds
  const shown = alerts.sort((a, b) => SEVERITY[a.tone] - SEVERITY[b.tone]).slice(0, MAX_BANNERS);

  return (
    <div className="flex flex-col gap-2">
      {shown.map((alert) => (
        <Banner key={alert.key} alert={alert} />
      ))}
    </div>
  );
}
