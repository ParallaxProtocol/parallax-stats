"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { formatAgo, formatInt } from "@/lib/format";
import type { ChainHealth, PropagationStats, PublicNode } from "@/lib/protocol";
import type { PublishedRelease, Release } from "@/lib/releases";
import { chainLevel, DEEP_REORG, staleChance, VERY_DEEP_REORG } from "@/lib/alert-levels";
import { compareParts, parsePlatform, parseVersion } from "@/lib/version";
import { useServerNow } from "./live/provider";
import { Label, Plate } from "./plate";
import { useSize } from "./use-size";

export function Heading({ id, title, readout }: { id: string; title: string; readout?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <Label as="h2">
        <span id={id}>{title}</span>
      </Label>
      {readout && <span className="text-xs text-muted-foreground">{readout}</span>}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd className="text-sm tabular-nums">{children}</dd>
    </div>
  );
}

const NO_HEALTH: ChainHealth = { window: 0, staleBlocks: 0, recentStale: [], reorgs: 0, since: 0, lastReorg: null, lastDeepReorg: null, split: null };

/** formatRate renders a share without rounding a little to nothing: 0%, 0.05%, 1.2%. */
function formatRate(share: number): string {
  const pct = share * 100;

  if (pct === 0) return "0%";
  if (pct < 0.01) return "<0.01%";

  return `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

const dateTime = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * A fork: blocks that lost to a competing branch, from `start` to `end`, and
 * the reorganization of nodes that had followed them, if any did.
 */
interface Fork {
  start: number;
  end: number;
  /** Heights whose block was lost, as stale blocks count them. */
  lost: Set<number>;
  reorg: { depth: number; nodes: number; at: number } | null;
  at: number;
}

/** Forks drawn at most, the newest; earlier ones are counted at the left. */
const MAX_FORKS = 6;
/** Blocks drawn either side of a fork, and at the newest end. */
const CONTEXT = 2;
/** Runs of no more blocks than this are drawn rather than folded: a fold takes more room. */
const FOLD_OVER = 3;

/**
 * forks gathers lost blocks and reorganizations into forks: lost blocks at
 * consecutive heights are one branch, and a reorganization belongs to the
 * branch it replaced, or is a branch of its own when no lost block was
 * recorded there. The records say which heights lost and where nodes
 * switched, not each block's parent, so a branch is laid out from those.
 */
function forks(stale: { height: number; at: number }[], reorgs: { height: number; at: number; depth: number; nodes: number }[]): Fork[] {
  const out: Fork[] = [];

  for (const s of [...stale].sort((a, b) => a.height - b.height)) {
    const last = out.at(-1);

    if (last && s.height === last.end + 1) {
      last.end = s.height;
      last.lost.add(s.height);
      last.at = Math.max(last.at, s.at);
    } else {
      out.push({ start: s.height, end: s.height, lost: new Set([s.height]), reorg: null, at: s.at });
    }
  }

  for (const r of reorgs) {
    // A switch to a chain with its head at `height`, replacing `depth` blocks: those up to it
    const from = r.height - r.depth + 1;
    const fork = out.find((f) => f.start <= r.height && f.end >= from);

    if (fork) {
      fork.reorg = !fork.reorg || r.depth > fork.reorg.depth ? { depth: r.depth, nodes: r.nodes, at: r.at } : fork.reorg;
    } else {
      out.push({ start: from, end: r.height, lost: new Set(), reorg: { depth: r.depth, nodes: r.nodes, at: r.at }, at: r.at });
    }
  }

  return out.sort((a, b) => a.start - b.start);
}

/** A fork's colour: as its reorganization's alert when nodes followed it, red for a lost block nobody did. */
function forkStroke(fork: Fork): string {
  if (!fork.reorg) return "stroke-critical";

  return fork.reorg.depth >= VERY_DEEP_REORG ? "stroke-critical" : fork.reorg.depth >= DEEP_REORG ? "stroke-warn" : "stroke-muted-foreground";
}

/** describe says what happened at a fork, for the caption under the graph. */
function describe(fork: Fork): string {
  const blocks = fork.end - fork.start + 1;
  const where = fork.start === fork.end ? `#${formatInt(fork.start)}` : `#${formatInt(fork.start)}–#${formatInt(fork.end)}`;
  const lost = fork.lost.size > 0 ? `${fork.lost.size} ${fork.lost.size === 1 ? "block" : "blocks"} lost to a competing branch` : `${blocks} ${blocks === 1 ? "block" : "blocks"} replaced`;
  const followed = fork.reorg
    ? `${fork.reorg.nodes} ${fork.reorg.nodes === 1 ? "node" : "nodes"} had followed it and switched back, ${fork.reorg.depth} ${fork.reorg.depth === 1 ? "block" : "blocks"} deep`
    : "no node followed it";

  return `${where} · ${lost} · ${followed} · ${dateTime.format(fork.at)}`;
}

/** Spacing of the graph: between blocks and across a fold at most, and at least before it scrolls instead. */
const MAX_STEP = 24;
const MIN_STEP = 13;
const MAX_GAP = 96;
const MIN_GAP = 56;
const MAIN_Y = 52;
const BRANCH_OFFSET = 30;
const HEIGHT = 104;

type Item = { kind: "block"; height: number } | { kind: "gap"; count: number };

/**
 * ForkGraph draws the chain like a version history: the canonical chain as
 * a line of blocks, oldest to newest, with each fork branching off its
 * parent, its lost blocks ending in a cross, and a dashed line back to the
 * chain where nodes that had followed it switched. Long runs without forks
 * fold into a count, so 2,000 blocks fit.
 */
function ForkGraph({ from, to, list }: { from: number; to: number; list: Fork[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  // Sized to the room it has: blocks draw closer together on a narrow card, and scroll only past that
  const [measure, room] = useSize<HTMLDivElement>({ width: 720, height: 0 });
  const scroller = useRef<HTMLDivElement>(null);
  const shown = list.slice(-MAX_FORKS);
  const earlier = list.length - shown.length;

  // The blocks to draw: a few either side of each fork, and the newest ones
  const ranges: [number, number][] = [];

  for (const [start, end] of [...shown.map((f) => [Math.max(from, f.start - 1 - CONTEXT), Math.min(to, f.end + 1 + CONTEXT)] as [number, number]), [Math.max(from, to - CONTEXT), to] as [number, number]]) {
    const last = ranges.at(-1);

    // Joined when only a few blocks would lie between
    if (last && start <= last[1] + 1 + FOLD_OVER) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  // A short run before the first drawn block is drawn too
  if (ranges[0] && ranges[0][0] - from <= FOLD_OVER) ranges[0][0] = from;

  const items: Item[] = [];

  ranges.forEach(([start, end], i) => {
    const before = i === 0 ? start - from : start - ranges[i - 1][1] - 1;

    if (before > 0) items.push({ kind: "gap", count: before });

    for (let h = start; h <= end; h++) items.push({ kind: "block", height: h });
  });

  // Where each block sits: spaced to fill the room, between the closest and widest spacing
  const blocks = items.filter((item) => item.kind === "block").length;
  const gaps = items.length - blocks;
  // Less the margin at the start and the room past the newest block
  const fit = (room.width - 12 - 40) / (blocks + gaps * (MAX_GAP / MAX_STEP));
  const STEP = Math.max(MIN_STEP, Math.min(MAX_STEP, fit));
  const GAP = Math.max(MIN_GAP, STEP * (MAX_GAP / MAX_STEP));
  const xOf = new Map<number, number>();
  let x = 12;

  for (const item of items) {
    if (item.kind === "gap") {
      x += GAP;
    } else {
      xOf.set(item.height, x);
      x += STEP;
    }
  }

  // Room past the newest block for a fork there: its cross and its label
  const width = x + 40;
  // Branches alternate above and below the chain, so neighbouring forks never meet. By a fork's place in
  // the whole window, so a new fork never flips the others
  const branchY = (fork: Fork) => (list.indexOf(fork) % 2 === 0 ? MAIN_Y - BRANCH_OFFSET : MAIN_Y + BRANCH_OFFSET);
  // The newest block's label goes on the side no fork near it takes
  const tipFork = shown.findLast((f) => f.end >= to - CONTEXT - 1);
  const tipLabelY = tipFork && branchY(tipFork) > MAIN_Y ? MAIN_Y - 10 : MAIN_Y + 20;
  const focus = hovered !== null ? shown[hovered] : null;

  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [width]);

  return (
    <div ref={measure} className="flex min-w-0 flex-col gap-2">
      {/* The newest end matters most: when the graph outgrows the room, it scrolls, starting there */}
      <div ref={scroller} className="flex overflow-x-auto" onPointerLeave={() => setHovered(null)}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="ml-auto shrink-0 overflow-visible"
          role="img"
          aria-label={
            list.length === 0
              ? `Blocks #${formatInt(from)} to #${formatInt(to)}, no forks`
              : `Blocks #${formatInt(from)} to #${formatInt(to)}, ${list.length} ${list.length === 1 ? "fork" : "forks"}: ${list.map((f) => describe(f)).join("; ")}`
          }
        >
          {/* The canonical chain: solid from block to block, dashed across a fold with its count over the middle */}
          {items.map((item, i) => {
            const prev = items[i - 1];

            if (item.kind === "block") {
              return prev?.kind === "block" ? (
                <line key={`l${item.height}`} x1={xOf.get(prev.height)} x2={xOf.get(item.height)} y1={MAIN_Y} y2={MAIN_Y} className="stroke-muted-foreground/60" strokeWidth={1.5} />
              ) : null;
            }

            const next = items[i + 1];
            const x0 = prev?.kind === "block" ? xOf.get(prev.height)! : 0;
            const x1 = next?.kind === "block" ? xOf.get(next.height)! : x0 + GAP;

            return (
              <g key={`g${i}`}>
                <line x1={x0} x2={x1} y1={MAIN_Y} y2={MAIN_Y} className="stroke-muted-foreground/40" strokeWidth={1.5} strokeDasharray="2 4" />
                <text x={(x0 + x1) / 2} y={MAIN_Y - 8} textAnchor="middle" className="fill-muted-foreground font-mono text-[10px]">
                  {formatInt(item.count)} blocks
                </text>
              </g>
            );
          })}

          {/* The forks */}
          {shown.map((fork, i) => {
            const y = branchY(fork);
            const parent = xOf.get(fork.start - 1) ?? xOf.get(fork.start)! - STEP;
            const first = xOf.get(fork.start)!;
            const last = xOf.get(fork.end)!;
            const stroke = forkStroke(fork);
            const back = xOf.get(fork.end + 1);
            const on = hovered === i;

            return (
              <g
                key={fork.start}
                onPointerEnter={() => setHovered(i)}
                className="cursor-default"
              >
                {/* Off the parent, along the lost blocks */}
                <path
                  d={`M${parent},${MAIN_Y} C${parent + STEP / 2},${MAIN_Y} ${first - STEP / 2},${y} ${first},${y} L${last},${y}`}
                  fill="none"
                  className={stroke}
                  strokeWidth={on ? 2.25 : 1.5}
                />
                {Array.from({ length: fork.end - fork.start + 1 }, (_, k) => fork.start + k).map((h) => (
                  <circle key={h} cx={xOf.get(h)} cy={y} r={on ? 4.5 : 4} className={fork.lost.has(h) ? "fill-critical" : "fill-muted-foreground"} />
                ))}
                {/* Abandoned */}
                <path d={`M${last + 9},${y - 3} l6,6 m0,-6 l-6,6`} className={stroke} strokeWidth={1.5} strokeLinecap="round" />
                {/* Nodes that had followed it, switching back to the chain */}
                {fork.reorg && back !== undefined && (
                  <path
                    d={`M${last},${y} C${last + STEP / 2},${y} ${back - STEP / 2},${MAIN_Y} ${back},${MAIN_Y}`}
                    fill="none"
                    className={stroke}
                    strokeWidth={1.25}
                    strokeDasharray="3 3"
                  />
                )}
                <text
                  x={first}
                  y={y < MAIN_Y ? y - 10 : y + 18}
                  textAnchor="middle"
                  className={`font-mono text-[10px] ${on ? "fill-foreground" : "fill-muted-foreground"}`}
                >
                  #{formatInt(fork.start)}
                </text>
                {/* A wider target than the thin lines, for the pointer */}
                <rect x={parent} y={Math.min(y, MAIN_Y) - 14} width={last - parent + 20} height={Math.abs(MAIN_Y - y) + 28} fill="transparent" />
              </g>
            );
          })}

          {/* The chain's blocks, over the lines, and the newest one marked */}
          {items.map((item) =>
            item.kind === "block" ? (
              <circle
                key={`b${item.height}`}
                cx={xOf.get(item.height)}
                cy={MAIN_Y}
                r={item.height === to ? 4.5 : 3}
                className={item.height === to ? "fill-brand-mark" : "fill-muted-foreground"}
              />
            ) : null,
          )}
          <text x={xOf.get(to)} y={tipLabelY} textAnchor="end" className="fill-muted-foreground font-mono text-[10px]">
            #{formatInt(to)} now
          </text>
          {earlier > 0 && (
            <text x={4} y={MAIN_Y + 20} className="fill-muted-foreground font-mono text-[10px]">
              +{earlier} earlier {earlier === 1 ? "fork" : "forks"}
            </text>
          )}
        </svg>
      </div>
      {/* What the fork under the pointer was: a line of its own, so the graph never moves */}
      <p className="min-h-4 truncate text-xs text-muted-foreground">
        {focus
          ? describe(focus)
          : list.length === 0
            ? `No forks in the last ${formatInt(to - from + 1)} blocks.`
            : "Branches are blocks that lost to a competing one; dashed lines, nodes that had followed them switching back. Hover a fork for details."}
      </p>
    </div>
  );
}

/**
 * StaleBlocks shows how often blocks lose to a competing block, as a rate
 * and on a strip of the window's blocks, with recent reorganizations and the
 * rate the network's propagation would lead to expect.
 */
export function StaleBlocks({
  health: reported,
  propagation,
  className = "",
}: {
  health: ChainHealth | null;
  propagation?: PropagationStats | null;
  className?: string;
}) {
  const health = reported ?? NO_HEALTH;
  const now = useServerNow();
  const { window, staleBlocks, reorgs, since, lastReorg } = health;
  // A server from before the block strip sends only the latest few
  const stale = health.stale ?? health.recentStale;
  const events = health.reorgEvents ?? (lastReorg ? [lastReorg] : []);
  const list = forks(
    stale,
    events.map((e) => ({ ...e, depth: e.depth ?? 1 })),
  );
  const spread = propagation?.spread?.median ?? null;
  const fullDay = now - since >= 23.5 * 3_600_000;

  return (
    <Plate
      as="section"
      id="stale-blocks"
      aria-labelledby="stale-title"
      tone={chainLevel(health, now)}
      className={`flex min-w-0 scroll-mt-4 flex-col gap-4 p-5 ${className}`}
    >
      <Heading id="stale-title" title="Stale blocks" readout={window ? `last ${formatInt(window)} blocks` : undefined} />

      {!health.heights && window === 0 ? (
        <p className="text-sm text-muted-foreground">Waiting for blocks</p>
      ) : (
        // Stacked, or the rate, the strip and the facts side by side across the page on wide screens
        <div className="flex flex-col gap-5 xl:grid xl:grid-cols-[11rem_minmax(0,1fr)_15rem] xl:items-start xl:gap-10">
          <p className="flex flex-col gap-1">
            <span className="text-3xl tabular-nums">{formatRate(window > 0 ? staleBlocks / window : 0)}</span>
            <span className="text-sm text-muted-foreground">
              stale, {formatInt(staleBlocks)} of {formatInt(window)} blocks lost
            </span>
          </p>

          {health.heights ? (
            <ForkGraph from={health.heights.from} to={health.heights.to} list={list} />
          ) : (
            <p className="text-xs text-muted-foreground">No competing blocks seen by verified nodes.</p>
          )}

          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 xl:grid-cols-1">
            <Stat label={fullDay ? "Reorgs, 24 h" : "Reorgs"}>
              {formatInt(reorgs)}
              {!fullDay && <span className="text-xs text-muted-foreground"> since the dashboard started {formatAgo(since, now)}</span>}
            </Stat>
            <Stat label="Expected">
              {spread !== null ? (
                <>
                  ~{formatRate(staleChance(spread))} <span className="text-xs text-muted-foreground">at today&apos;s propagation</span>
                </>
              ) : (
                <span className="text-muted-foreground">n/a</span>
              )}
            </Stat>
          </dl>
        </div>
      )}
    </Plate>
  );
}

/** Releases the ladder shows at the least, ending at the latest. */
const LADDER_MIN = 6;
/** Platforms listed before the rest are counted together. */
const MAX_PLATFORMS = 4;

/** age says briefly how long ago a release came out: today, 5 d ago, 3 wk ago, 4 mo ago. */
function age(ms: number): string {
  const days = ms / 86_400_000;

  if (days < 1) return "today";
  if (days < 14) return `${Math.floor(days)} d ago`;
  if (days < 60) return `${Math.floor(days / 7)} wk ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;

  return `${Math.floor(days / 365)} y ago`;
}

const releaseDate = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

type StationKind = "latest" | "older" | "development" | "unknown";

/** A stop on the ladder: a release, or the development builds past the latest, or nodes reporting no version. */
interface Station {
  key: string;
  label: string;
  release: PublishedRelease | null;
  kind: StationKind;
  nodes: PublicNode[];
}

/**
 * ladder lays the releases out oldest to newest, from the oldest any online
 * node runs (or LADDER_MIN back from the latest) to the latest, with a stop
 * after it for development builds and one before for nodes with no version.
 * A node on a version that is no release stands on the newest release
 * before it.
 */
function ladder(online: PublicNode[], releases: PublishedRelease[], latestTag: string | null): Station[] {
  // GitHub out of reach: a stop for each version the nodes run, oldest first, none marked latest
  if (releases.length === 0) {
    const byVersion = new Map<string, Station>();

    for (const node of online) {
      const { label, parts } = parseVersion(node.info.node);
      const station = byVersion.get(label) ?? { key: label, label, release: null, kind: parts ? "older" : "unknown", nodes: [] };

      station.nodes.push(node);
      byVersion.set(label, station);
    }

    return [...byVersion.values()].sort((a, b) => compareParts(parseVersion(`/${a.label}`).parts, parseVersion(`/${b.label}`).parts));
  }

  const latestIndex = Math.max(0, latestTag ? releases.findIndex((r) => r.tag === latestTag) : releases.length - 1);
  const latest = releases[latestIndex] ? parseVersion(`/${releases[latestIndex].tag}`).parts : null;
  const placed = new Map<number, PublicNode[]>();
  const development: PublicNode[] = [];
  const unknown: PublicNode[] = [];

  for (const node of online) {
    const { parts } = parseVersion(node.info.node);

    if (!parts) {
      unknown.push(node);
    } else if (latest && compareParts(parts, latest) > 0) {
      development.push(node);
    } else {
      // The release itself, or else the newest one before the version
      let index = -1;

      for (let i = 0; i <= latestIndex; i++) if (compareParts(parseVersion(`/${releases[i].tag}`).parts, parts) <= 0) index = i;

      if (index < 0) unknown.push(node);
      else placed.set(index, [...(placed.get(index) ?? []), node]);
    }
  }

  const start = Math.max(0, Math.min(latestIndex - (LADDER_MIN - 1), ...placed.keys()));
  const stations: Station[] = releases.slice(start, latestIndex + 1).map((release, i) => ({
    key: release.tag,
    label: release.tag,
    release,
    kind: start + i === latestIndex ? "latest" : "older",
    nodes: placed.get(start + i) ?? [],
  }));

  if (unknown.length > 0) stations.unshift({ key: "unknown", label: "unknown", release: null, kind: "unknown", nodes: unknown });
  if (development.length > 0) stations.push({ key: "development", label: "dev", release: null, kind: "development", nodes: development });

  return stations;
}

/** AdoptionRing is the share of nodes on the latest release or newer, as a ring around the figure. */
function AdoptionRing({ share }: { share: number }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  // Most of the network current is the healthy state; amber once a third or more lag
  const stroke = share >= 2 / 3 ? "stroke-brand-mark" : "stroke-warn";

  return (
    <div className="relative size-28 shrink-0">
      <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
        <circle cx="50" cy="50" r={radius} fill="none" className="stroke-foreground/10" strokeWidth="8" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          className={`${stroke} transition-[stroke-dasharray] duration-700 ease-out`}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${share * circumference} ${circumference}`}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-2xl tabular-nums">{Math.round(share * 100)}%</span>
    </div>
  );
}

/**
 * ClientVersions shows how up to date the network is: the share of online
 * nodes on the latest release or newer, a ladder of releases with each node
 * standing on the one it runs, and the platforms they run on.
 */
export function ClientVersions({
  nodes,
  latestRelease,
  releases,
  className = "",
}: {
  nodes: PublicNode[];
  latestRelease: Release | null;
  releases: PublishedRelease[];
  className?: string;
}) {
  const now = useServerNow();
  const [hovered, setHovered] = useState<string | null>(null);
  const online = nodes.filter((node) => node.stats.active);
  const total = online.length;
  // Without the release list, the latest release alone makes a one-stop ladder
  const known = releases.length > 0 ? releases : latestRelease ? [{ ...latestRelease, publishedAt: 0 }] : [];
  const stations = ladder(online, known, latestRelease?.tag ?? null);
  const current = stations.filter((s) => s.kind === "latest" || s.kind === "development").reduce((sum, s) => sum + s.nodes.length, 0);
  const behind = stations.filter((s) => s.kind === "older").reduce((sum, s) => sum + s.nodes.length, 0);
  const latestLabel = latestRelease ? parseVersion(`/${latestRelease.tag}`).label : null;
  const platforms = [...online.reduce((counts, node) => counts.set(parsePlatform(node.info.node), (counts.get(parsePlatform(node.info.node)) ?? 0) + 1), new Map<string, number>())].sort(
    (a, b) => b[1] - a[1],
  );
  const shownPlatforms = platforms.length > MAX_PLATFORMS ? [...platforms.slice(0, MAX_PLATFORMS - 1), ["other", platforms.slice(MAX_PLATFORMS - 1).reduce((sum, [, n]) => sum + n, 0)] as [string, number]] : platforms;
  const focus = stations.find((s) => s.key === hovered) ?? null;
  // The newest releases matter most: when the ladder scrolls, it starts at that end
  const scroller = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [stations.length]);

  return (
    <Plate as="section" aria-labelledby="versions-title" className={`flex min-w-0 flex-col gap-5 p-5 ${className}`}>
      <Heading id="versions-title" title="Client versions" readout={total ? `${total} online ${total === 1 ? "node" : "nodes"}` : undefined} />

      {total === 0 ? (
        <p className="text-sm text-muted-foreground">Waiting for nodes</p>
      ) : (
        // Stacked, or the ring, the ladder and the platforms side by side across the page on wide screens
        <div className="flex flex-col gap-6 xl:grid xl:grid-cols-[13rem_minmax(0,1fr)_15rem] xl:items-center xl:gap-10">
          <div className="flex items-center gap-4">
            <AdoptionRing share={latestLabel ? current / total : 0} />
            <p className="flex flex-col gap-1 text-sm">
              <span>{latestLabel ? "up to date" : "release unknown"}</span>
              <span className="text-muted-foreground">
                {latestLabel ? `${formatInt(current)} of ${formatInt(total)} on ${latestLabel} or newer` : "GitHub could not be reached"}
              </span>
            </p>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            {/* Scrolls sideways when the releases outgrow the room */}
            <div ref={scroller} className="-mx-1 overflow-x-auto px-1">
              <ol className="grid min-w-max" style={{ gridTemplateColumns: `repeat(${stations.length}, minmax(4.5rem, 1fr))` }} onPointerLeave={() => setHovered(null)}>
                {stations.map((station, i) => {
                  const Tag = station.release ? "a" : "div";
                  // The hovered release's marker fills and its text brightens
                  const on = hovered === station.key;

                  return (
                    <li key={station.key}>
                      <Tag
                        {...(station.release ? { href: station.release.url, target: "_blank", rel: "noopener noreferrer" } : {})}
                        onPointerEnter={() => setHovered(station.key)}
                        onFocus={() => setHovered(station.key)}
                        className={`flex flex-col items-center gap-2 pb-1 transition-opacity duration-150 ${station.nodes.length === 0 && !on ? "opacity-45" : ""}`}
                      >
                        {/* How many nodes run it */}
                        <span className={`h-4 text-xs tabular-nums ${station.kind === "latest" ? "text-brand" : station.kind === "development" ? "text-info-ink" : ""}`}>
                          {station.nodes.length > 0 && `${formatInt(station.nodes.length)} ${station.nodes.length === 1 ? "node" : "nodes"}`}
                        </span>
                        {/* The rail through every station */}
                        <span className="relative flex h-3 w-full items-center justify-center" aria-hidden>
                          <span className={`absolute h-px bg-border ${i === 0 ? "right-0 left-1/2" : i === stations.length - 1 ? "right-1/2 left-0" : "inset-x-0"}`} />
                          {/* Hollow, so it never reads as one more node */}
                          <span
                            className={`relative size-2.5 border-[1.5px] ${station.kind === "development" ? "rotate-45 rounded-[1px]" : "rounded-full"} ${
                              station.kind === "latest" ? "border-brand-mark" : station.kind === "development" ? "border-info" : "border-muted-foreground"
                            } ${
                              // Filled while hovered
                              on
                                ? `scale-125 ${station.kind === "latest" ? "bg-brand-mark" : station.kind === "development" ? "bg-info" : "bg-muted-foreground"}`
                                : "bg-card"
                            } transition-[transform,background-color] duration-150`}
                          />
                        </span>
                        <span className="flex flex-col items-center gap-0.5 text-center">
                          <span className={`font-mono text-xs ${on ? "font-medium text-foreground" : ""}`}>{station.label}</span>
                          <span
                            className={`text-[10px] ${
                              station.kind === "latest" ? "text-brand" : station.kind === "development" ? "text-info-ink" : on ? "text-foreground" : "text-muted-foreground"
                            }`}
                          >
                            {station.kind === "latest"
                              ? "latest"
                              : station.kind === "development"
                                ? "unreleased"
                                : station.kind === "unknown"
                                  ? "no version"
                                  : station.release && station.release.publishedAt > 0
                                    ? age(now - station.release.publishedAt)
                                    : ""}
                          </span>
                        </span>
                      </Tag>
                    </li>
                  );
                })}
              </ol>
            </div>
            {/* What the station under the pointer holds: a line of its own, so the ladder never moves */}
            <p className="min-h-4 truncate text-xs text-muted-foreground" aria-live="polite">
              {focus
                ? [
                    focus.label,
                    focus.release && focus.release.publishedAt > 0
                      ? `released ${releaseDate.format(focus.release.publishedAt)}`
                      : focus.kind === "development"
                        ? "builds newer than the latest release"
                        : focus.kind === "unknown"
                          ? "nodes reporting no version"
                          : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "Online nodes on each release. Hover a release to see when it came out, or open its notes."}
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <dl className="flex flex-col gap-2">
              <dt className="font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Platforms</dt>
              {shownPlatforms.map(([platform, count]) => (
                <dd key={platform} className="grid grid-cols-[minmax(0,7rem)_1fr_1.5rem] items-center gap-3 text-xs">
                  <span className="truncate">{platform}</span>
                  <span className="h-1.5 rounded-full bg-foreground/10">
                    <span className="block h-full rounded-full bg-brand-mark/70" style={{ width: `${(count / total) * 100}%` }} />
                  </span>
                  <span className="text-right tabular-nums">{count}</span>
                </dd>
              ))}
            </dl>
            {latestRelease && behind > 0 && (
              <a
                href={latestRelease.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 self-start border border-border px-3 py-1.5 text-xs transition-colors hover:bg-foreground/5"
              >
                Get {latestLabel}
                <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                  <path d="M6 3.5h6.5V10M12.5 3.5 4 12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            )}
          </div>
        </div>
      )}
    </Plate>
  );
}
