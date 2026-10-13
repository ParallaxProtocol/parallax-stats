"use client";

import { Fragment, useCallback, useEffect, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  clientVersion,
  formatAgo,
  formatGasPrice,
  formatHashrate,
  formatInt,
  formatMs,
  gradeBehind,
  gradePeerLatency,
  gradePeers,
  gradePropagation,
  gradeUptime,
  shortHash,
  shortVersion,
  type Grade,
} from "@/lib/format";
import { HISTORY_BINS, PROPAGATION_BANDS, type Block, type PublicNode } from "@/lib/protocol";
import { AddNode } from "./add-node";
import { scrubIndex } from "./charts";
import { CopyButton } from "./copy-button";
import { GRADE_NAME, GRADE_TEXT } from "./indicator";
import { Label } from "./plate";
import { useServerNow } from "./live/provider";
import { usePersistent } from "./use-persistent";
import { Tooltip } from "./tooltip";

type SortKey =
  | "name"
  | "client"
  | "sync"
  | "peers"
  | "peerLatency"
  | "block"
  | "mining"
  | "propagation"
  | "propagationAvg"
  | "pending"
  | "uptime";

interface Sort {
  key: SortKey;
  desc: boolean;
}

const NO_PINS: string[] = [];

const SORT_VALUE: Record<SortKey, (n: PublicNode) => number | string> = {
  name: (n) => n.info.name.toLowerCase(),
  client: (n) => n.info.node,
  sync: (n) => (n.stats.syncing ? 1 : 0),
  peers: (n) => n.stats.peers,
  peerLatency: (n) => n.stats.peerLatency || Number.MAX_SAFE_INTEGER,
  block: (n) => n.stats.block.number,
  // Miners first, by hashrate; offline nodes count as not mining
  mining: (n) => (n.stats.active && n.stats.mining ? 1 + n.stats.hashrate : 0),
  propagation: (n) => shownPropagation(n.stats.block),
  propagationAvg: (n) => timedAverage(n) ?? Infinity,
  pending: (n) => n.stats.pending,
  uptime: (n) => n.stats.uptime,
};

function compare(a: number | string, b: number | string): number {
  if (typeof a === "string") return a.localeCompare(String(b));

  // Untimed values (Infinity) tie with each other rather than give NaN
  return a === b ? 0 : a - (b as number);
}

/** timedAverage is a node's average propagation, or null while none of its recent blocks were timed. */
function timedAverage(node: PublicNode): number | null {
  return node.history.some((p) => p >= 0) ? node.stats.propagationAvg : null;
}

/** shownPropagation sorts an untimed head, one the node caught up to, after every timed one. */
function shownPropagation(block: Block): number {
  return block.propagation < 0 ? Infinity : block.propagation;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * sortNodes keeps pinned nodes first, in name order and out of any sort, so
 * they stay where the viewer put them. Connected verified nodes follow, then
 * the rest connected, then the offline ones the same way, below a divider:
 * each group ordered by the chosen column, or without one, verified nodes in
 * name order and the rest by block.
 */
function sortNodes(nodes: PublicNode[], sort: Sort | null, pins: string[]): PublicNode[] {
  // A sort saved by an older version may name a column that no longer exists
  const value = sort ? SORT_VALUE[sort.key] : undefined;
  const byNodeName = (a: PublicNode, b: PublicNode) => byName.compare(a.info.name, b.info.name) || a.id.localeCompare(b.id);

  return [...nodes].sort((a, b) => {
    const group = rank(a, pins) - rank(b, pins);

    if (group !== 0) return group;
    if (rank(a, pins) === 0) return byNodeName(a, b);
    if (sort && value) return compare(value(a), value(b)) * (sort.desc ? -1 : 1) || byNodeName(a, b);
    if (a.trusted) return byNodeName(a, b);

    return b.stats.block.number - a.stats.block.number || compare(shownPropagation(a.stats.block), shownPropagation(b.stats.block)) || byNodeName(a, b);
  });
}

/** rank is a node's group in the table: pinned, then connected verified and the rest, then offline ones the same way. */
function rank(node: PublicNode, pins: string[]): number {
  if (pins.includes(node.id)) return 0;

  return (node.stats.active ? 0 : 2) + (node.trusted ? 1 : 2);
}

/** OFFLINE_RANK is the first group below the offline divider. */
const OFFLINE_RANK = 3;

/** offlineFor says how long ago a node was last known connected: 12 min. */
function offlineFor(offlineSince: number | null, now: number): string | null {
  if (offlineSince === null) return null;

  const ms = Math.max(0, now - offlineSince);

  return ms < 60_000 ? "< 1 min" : formatMs(ms);
}

interface Column {
  key: SortKey;
  label: string;
  title: string;
  /** Sort direction on first click: big values first for counts. */
  desc?: boolean;
}

const COLUMNS: Column[] = [
  { key: "name", label: "Node", title: "Node name" },
  { key: "client", label: "Client", title: "Client version" },
  { key: "sync", label: "Sync", title: "Sync state" },
  { key: "peers", label: "Peers", title: "Connected peers", desc: true },
  { key: "peerLatency", label: "Latency", title: "Median of the minimum ping to each peer" },
  { key: "block", label: "Block", title: "Latest block", desc: true },
  { key: "mining", label: "Mining", title: "Whether the node is mining; hover the icon for its hashrate", desc: true },
  { key: "propagation", label: "Propagation", title: "Delay after the first node reported the block" },
  { key: "propagationAvg", label: "Propagation history", title: "Propagation delay for each of the last 40 blocks, and the average" },
  { key: "pending", label: "Mempool size", title: "Transactions waiting in the node's mempool", desc: true },
  { key: "uptime", label: "Uptime", title: "Share of time connected since first seen", desc: true },
];

/** Cell shows a value in its grade's color; screen readers hear the grade after the value. */
function Cell({ grade, title, children, className = "" }: { grade?: Grade; title?: string; children: ReactNode; className?: string }) {
  return (
    <Tooltip content={title}>
      <td className={`px-3 py-3 whitespace-nowrap ${grade ? GRADE_TEXT[grade] : ""} ${className}`}>
        <span className="inline-flex items-center gap-1.5">
          {children}
          {grade && <span className="sr-only">({GRADE_NAME[grade]})</span>}
        </span>
      </td>
    </Tooltip>
  );
}

/** fewPeersHint says how an active node with few peers can get more, and nothing otherwise. */
function fewPeersHint(active: boolean, peers: number): string | undefined {
  return active && gradePeers(peers) !== "good" ? "Few peers: opening P2P port 32110 lets other nodes connect to this one" : undefined;
}

/** Dash stands in for a value there is none of, such as a node not mining. */
function Dash() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 text-muted-foreground/60" aria-hidden>
      <path d="M5 8h6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/** MempoolSize counts a node's pending transactions, and says when there are none. */
function MempoolSize({ pending }: { pending: number }) {
  if (pending === 0) return <span className="italic">empty</span>;

  return <>{`${formatInt(pending)} ${pending === 1 ? "txn" : "txns"}`}</>;
}

/** MiningStatus is a pickaxe for a mining node, with its hashrate on hover, and a dash otherwise. */
function MiningStatus({ mining, hashrate, className = "" }: { mining: boolean; hashrate: number; className?: string }) {
  const label = mining ? `Mining at ${formatHashrate(hashrate)}` : "Not mining";

  return (
    <td className={`px-3 py-3 ${className}`}>
      <Tooltip content={label}>
        <span role="img" aria-label={label} className="flex size-5 items-center justify-center">
          {mining ? (
            // Pickaxe, after Lucide (ISC license)
            <svg
              viewBox="0 0 24 24"
              className="size-4 text-brand"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M14.531 12.469 6.619 20.38a1 1 0 1 1-3-3l7.912-7.912" />
              <path d="M15.686 4.314A12.5 12.5 0 0 0 5.461 2.958 1 1 0 0 0 5.58 4.71a22 22 0 0 1 6.318 3.393" />
              <path d="M17.7 3.7a1 1 0 0 0-1.4 0l-4.6 4.6a1 1 0 0 0 0 1.4l2.6 2.6a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4z" />
              <path d="M19.686 8.314a12.501 12.501 0 0 1 1.356 10.225 1 1 0 0 1-1.751-.119 22 22 0 0 0-3.393-6.319" />
            </svg>
          ) : (
            <Dash />
          )}
        </span>
      </Tooltip>
    </td>
  );
}

/** VerifiedIcon marks a node run by the Parallax team or a known operator. */
function VerifiedIcon() {
  return (
    <Tooltip content="Verified: run by the Parallax team or a known operator, such as a bootnode, pool or exchange. The best block follows verified nodes.">
      <svg viewBox="0 0 24 24" className="ml-1.5 inline-block size-4 -translate-y-px align-middle" role="img" aria-label="Verified">
        <path
          d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"
          className="fill-brand-mark"
        />
        <path
          d="m8.5 12 2.5 2.5 4.5-5"
          fill="none"
          className="stroke-background"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </Tooltip>
  );
}

/** SyncStatus is a check when synced, a spinner while syncing, and says how long a node has been offline. */
function SyncStatus({ active, syncing, offline }: { active: boolean; syncing: boolean; offline: string | null }) {
  if (!active) {
    return (
      <td className="px-3 py-3 whitespace-nowrap">
        <Tooltip content={offline ? `Offline for ${offline}` : "Offline"}>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warn">
            <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden>
              <circle cx="8" cy="8" r="6" />
              <path d="M4 12 12 4" />
            </svg>
            Offline{offline && <span className="font-normal">· {offline}</span>}
          </span>
        </Tooltip>
      </td>
    );
  }

  const label = syncing ? "Syncing" : "Synced";

  return (
    <td className="px-3 py-3">
      <Tooltip content={label}>
        <span role="img" aria-label={label} className="flex size-5 items-center justify-center">
          {syncing ? (
            <svg viewBox="0 0 16 16" className="size-4 animate-spin text-warn motion-reduce:animate-none" aria-hidden>
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
              <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="size-4 text-good" aria-hidden>
              <path
                d="m3.5 8.5 3 3 6-7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      </Tooltip>
    </td>
  );
}

/**
 * PropagationStrip draws a node's delay for each recent block as a row of tiny
 * columns, oldest first and ending at the best block. Hovering or dragging
 * along it shows the block and its delay.
 */
function PropagationStrip({ history, bestBlock, offline }: { history: number[]; bestBlock: number; offline: boolean }) {
  // Full height at the top of the amber band: a bar's height and color say the same
  const ceiling = PROPAGATION_BANDS[1];
  const h = 18;
  const [hover, setHover] = useState<{ index: number; left: number; top: number } | null>(null);

  function point(e: PointerEvent<SVGSVGElement>) {
    const index = scrubIndex(e, history.length);

    if (index === null) return setHover(null);

    const rect = e.currentTarget.getBoundingClientRect();

    setHover({ index, left: rect.left + (index + 0.5) * (rect.width / history.length), top: rect.top });
  }

  const delay = hover ? history[hover.index] : null;

  return (
    <>
      <svg
        width={HISTORY_BINS * 3}
        height={h}
        className={`block touch-pan-y select-none [-webkit-touch-callout:none] ${offline ? "grayscale" : ""}`}
        aria-hidden
        onPointerDown={point}
        onPointerMove={point}
        onPointerLeave={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
        // A tap reads the strip rather than opening the row
        onClick={(e) => e.stopPropagation()}
      >
        {/* The whole strip takes the pointer, gaps and missing blocks included */}
        <rect width={HISTORY_BINS * 3} height={h} fill="transparent" />
        {history.map((ms, i) =>
          ms < 0 ? null : (
            <rect
              key={i}
              x={i * 3}
              y={h - Math.max(2, (Math.min(ms, ceiling) / ceiling) * h)}
              width={2}
              height={Math.max(2, (Math.min(ms, ceiling) / ceiling) * h)}
              className={`${STRIP_FILL[gradePropagation(ms)]} ${hover === null || hover.index === i ? "" : "opacity-35"}`}
            />
          ),
        )}
      </svg>
      {hover &&
        // On the body, so the table's sideways scroll never clips it
        createPortal(
          <span
            role="tooltip"
            className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full border border-border bg-surface-elevated px-2.5 py-1.5 font-mono text-xs whitespace-nowrap text-foreground shadow-lg"
            style={{ left: hover.left, top: hover.top - 6 }}
          >
            <span className="text-muted-foreground">#{formatInt(bestBlock - (history.length - 1 - hover.index))}</span>{" "}
            {delay === null || delay < 0 ? "no data" : delay === 0 ? "first" : `+${formatMs(delay)}`}
          </span>,
          document.body,
        )}
    </>
  );
}

const STRIP_FILL: Record<Grade, string> = {
  good: "fill-good",
  warn: "fill-warn",
  serious: "fill-serious",
  critical: "fill-critical",
  info: "fill-info",
  off: "fill-off",
};

function DetailSection({ title, rows }: { title: string; rows: [string, ReactNode, string?][] }) {
  return (
    <section className="min-w-0">
      <Label as="h3" className="mb-2 block">
        {title}
      </Label>
      <dl className="divide-y divide-border/60">
        {rows.map(([label, value, hint]) => (
          <div key={label} className="flex min-w-0 items-baseline justify-between gap-4 py-1.5 text-xs">
            <dt className="shrink-0 text-muted-foreground">{label}</dt>
            <Tooltip content={hint}>
              <dd className="flex min-w-0 items-baseline gap-1 text-right font-mono">{value}</dd>
            </Tooltip>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * Details is the expanded panel under a node's row. It animates its
 * height open and closed, staying mounted while it collapses; the parent
 * drops it once onClosed fires.
 */
function Details({
  node,
  colSpan,
  open,
  now,
  onClosed,
}: {
  node: PublicNode;
  colSpan: number;
  open: boolean;
  now: number;
  onClosed: () => void;
}) {
  const [shown, setShown] = useState(false);
  const { info, stats, geo } = node;
  const truncate = (text: string) => <span className="truncate">{text}</span>;

  useEffect(() => {
    // Start collapsed, then open on the next frame so the height animates
    const frame = requestAnimationFrame(() => setShown(open));

    if (open) return () => cancelAnimationFrame(frame);

    // Drop the panel even if no transition runs to signal the end
    const fallback = window.setTimeout(onClosed, 400);

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(fallback);
    };
  }, [open, onClosed]);

  return (
    <tr className="border-b border-border/50">
      <td colSpan={colSpan} className="p-0">
        <div
          className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${shown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
          onTransitionEnd={(e) => {
            if (!open && e.propertyName === "grid-template-rows") onClosed();
          }}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="border-l-2 border-brand bg-background/50 px-6 py-5 sm:pl-12">
              {!node.trusted && (
                <p className="mb-5 flex max-w-3xl gap-2 border border-border bg-surface-elevated px-3 py-2 text-xs text-muted-foreground">
                  <svg viewBox="0 0 16 16" className="mt-px size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                    <circle cx="8" cy="8" r="6.5" />
                    <path d="M8 7.2v4M8 4.8v.1" strokeLinecap="round" />
                  </svg>
                  Unverified node. Everything here is reported by the node itself, and it is listed under a pseudonym:
                  only nodes run by the dashboard operator show the name they chose.
                </p>
              )}
              <div className="grid max-w-6xl grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-3">
                <DetailSection
                  title="Node"
                  rows={[
                    ["Client", truncate(info.node || "unknown"), info.node],
                    ["Network", info.net || "unknown"],
                    ["Protocols", truncate(info.protocol || "unknown"), info.protocol],
                    ["Port", info.port ? String(info.port) : "unknown"],
                    ["System", [info.os, info.os_v].filter(Boolean).join(" ") || "unknown"],
                    ["Location", geo ? [geo.city, geo.country].filter(Boolean).join(", ") : "unknown"],
                  ]}
                />
                <DetailSection
                  title="Latest block"
                  rows={[
                    ["Number", `#${formatInt(stats.block.number)}`],
                    [
                      "Hash",
                      <>
                        <span className="truncate">{shortHash(stats.block.hash)}</span>
                        <CopyButton value={stats.block.hash} label="block hash" />
                      </>,
                      stats.block.hash,
                    ],
                    ["Reported", formatAgo(stats.block.received, now)],
                    ["Transactions", formatInt(stats.block.txCount)],
                    ["Total difficulty", truncate(formatInt(Number(stats.block.totalDifficulty))), stats.block.totalDifficulty],
                    ["Average propagation", timedAverage(node) === null ? <Dash /> : formatMs(stats.propagationAvg)],
                  ]}
                />
                <DetailSection
                  title="Activity"
                  rows={
                    stats.active
                      ? [
                          ["Peers", formatInt(stats.peers), fewPeersHint(stats.active, stats.peers)],
                          ["Latency to peers", stats.peerLatency ? `${stats.peerLatency} ms` : "n/a"],
                          ["Mempool size", <MempoolSize key="pending" pending={stats.pending} />],
                          ["Mining", stats.mining ? formatHashrate(stats.hashrate) : "no"],
                          ["Gas price", formatGasPrice(stats.gasPrice)],
                        ]
                      : [
                          ["Status", "offline"],
                          ["Last connected", node.offlineSince ? formatAgo(node.offlineSince, now) : "unknown"],
                          ["Uptime", `${stats.uptime}%`],
                        ]
                  }
                />
              </div>
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function NodeTable({
  nodes,
  bestBlock,
  publicNodes,
  releaseCommits,
}: {
  nodes: PublicNode[];
  bestBlock: number;
  publicNodes: boolean;
  releaseCommits: Record<string, string>;
}) {
  const now = useServerNow();
  // null is the default order; a new key, so a sort saved by older versions starts from the default
  const [sort, setSort] = usePersistent<Sort | null>("node-sort", null);
  const [pins, setPins] = usePersistent<string[]>("pins", NO_PINS);
  const [open, setOpen] = useState<string | null>(null);
  // A panel that is animating closed stays mounted until it finishes
  const [closing, setClosing] = useState<string | null>(null);
  const onClosed = useCallback(() => setClosing(null), []);

  function toggle(id: string) {
    if (open !== null) setClosing(open);
    setOpen(open === id ? null : id);
  }
  const sorted = sortNodes(nodes, sort, pins);
  const offlineCount = sorted.filter((node) => rank(node, pins) >= OFFLINE_RANK).length;
  const colSpan = COLUMNS.length + 1;

  /** sortBy cycles a column through its first direction, the reverse, and back to the default order. */
  function sortBy(column: Column) {
    const first = column.desc ?? false;

    if (sort?.key !== column.key) setSort({ key: column.key, desc: first });
    else if (sort.desc === first) setSort({ key: column.key, desc: !first });
    else setSort(null);
  }

  function togglePin(id: string) {
    setPins(pins.includes(id) ? pins.filter((p) => p !== id) : [...pins, id]);
  }

  return (
    <section aria-labelledby="nodes-title" className="border border-border bg-surface-elevated">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-6 py-4">
        <Label as="h2" className="text-sm text-foreground">
          <span id="nodes-title">Nodes</span>
        </Label>
        <div className="flex items-center gap-4">
          <p className="hidden text-xs text-muted-foreground sm:block">Select a node for details.</p>
          <AddNode publicNodes={publicNodes} />
        </div>
      </header>

      {nodes.length === 0 ? (
        <p className="px-6 py-6 text-sm text-muted-foreground">
          No nodes are reporting yet. Start parallaxd with <code className="font-mono text-foreground">--prlstats</code>{" "}
          pointing here to add one.
        </p>
      ) : (
        <div className="relative overflow-x-auto">
          {/* relative: the cells hold absolutely positioned screen-reader text, which must stay clipped here */}
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="w-10 py-3 pr-1 pl-4">
                  <span className="sr-only">Pinned</span>
                </th>
                {COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className="px-3 py-3 font-mono text-xs font-normal tracking-wider whitespace-nowrap uppercase"
                    aria-sort={sort?.key === column.key ? (sort.desc ? "descending" : "ascending") : undefined}
                  >
                    <Tooltip content={`${column.title}. Click to sort, again to reverse, a third time for the default order.`}>
                      <button
                        type="button"
                        className={`inline-flex items-center gap-1 uppercase hover:text-foreground ${sort?.key === column.key ? "text-foreground" : ""}`}
                        onClick={() => sortBy(column)}
                      >
                        {column.label}
                        <span aria-hidden className={sort?.key === column.key ? "text-brand" : "invisible"}>
                          {sort?.desc ? "↓" : "↑"}
                        </span>
                      </button>
                    </Tooltip>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {sorted.map((node, i) => {
                const { stats } = node;
                const active = stats.active;
                // Offline rows fade, all but the name and status, until hovered or opened
                const fade = active || open === node.id ? "" : "opacity-50 transition-opacity group-hover:opacity-100";
                const divider = rank(node, pins) >= OFFLINE_RANK && (i === 0 || rank(sorted[i - 1], pins) < OFFLINE_RANK);
                const behind = bestBlock - stats.block.number;
                const pinned = pins.includes(node.id);
                const expanded = open === node.id;
                const atHead = behind <= 0;
                const timed = stats.block.propagation >= 0;
                const version = clientVersion(node.info.node);

                return (
                  <Fragment key={node.id}>
                    {divider && i > 0 && (
                      <tr className="border-b border-border/50 bg-background/30">
                        <th colSpan={colSpan} scope="rowgroup" className="px-4 py-1.5 text-left text-xs font-medium text-muted-foreground uppercase">
                          Offline · {offlineCount}
                        </th>
                      </tr>
                    )}
                    <tr
                      onClick={() => toggle(node.id)}
                      className={`group cursor-pointer border-b border-border/50 transition-colors hover:bg-background/40 ${expanded ? "bg-background/50" : ""}`}
                    >
                      <td className="py-3 pr-1 pl-4">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            togglePin(node.id);
                          }}
                          aria-pressed={pinned}
                          aria-label={`${pinned ? "Unpin" : "Pin"} ${node.info.name}`}
                          className={`flex size-6 items-center justify-center rounded ${pinned ? "text-brand" : "text-muted-foreground/60 hover:text-foreground"}`}
                        >
                          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
                            <path
                              d="M5 1.5h6l-1 4 2.5 2.5v1.5h-3.5v5L8 15.5l-1-1v-5H3.5V8L6 5.5Z"
                              fill={pinned ? "currentColor" : "none"}
                              stroke="currentColor"
                              strokeWidth="1.2"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </button>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(node.id);
                          }}
                          aria-expanded={expanded}
                          className="inline-flex items-center gap-1.5 text-left font-medium"
                        >
                          <svg
                            viewBox="0 0 16 16"
                            className={`size-3 shrink-0 text-muted-foreground transition-transform duration-300 ${expanded ? "rotate-90" : ""}`}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            aria-hidden
                          >
                            <path d="m6 3.5 4.5 4.5L6 12.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span className={node.trusted ? "" : "font-mono text-[13px] font-normal text-muted-foreground"}>{node.info.name}</span>
                        </button>
                        {node.trusted && <VerifiedIcon />}
                      </td>
                      <Cell className={`font-mono text-xs text-muted-foreground ${fade}`}>
                        <Tooltip content={version}>
                          <span className="max-w-28 truncate">{version ? shortVersion(version, releaseCommits) : "unknown"}</span>
                        </Tooltip>
                      </Cell>
                      <SyncStatus active={active} syncing={stats.syncing} offline={offlineFor(node.offlineSince, now)} />
                      <Cell grade={active ? gradePeers(stats.peers) : undefined} title={fewPeersHint(active, stats.peers)} className={fade}>
                        {active ? stats.peers : "—"}
                      </Cell>
                      <Cell grade={active ? gradePeerLatency(stats.peerLatency) : undefined} className={fade}>
                        {!active ? "—" : stats.peerLatency ? `${stats.peerLatency} ms` : "n/a"}
                      </Cell>
                      <Cell grade={active ? gradeBehind(behind) : undefined} className={fade}>
                        #{formatInt(stats.block.number)}
                        {!active ? (
                          <span className="text-xs text-muted-foreground">last seen</span>
                        ) : (
                          behind !== 0 && <span className="text-xs text-muted-foreground">{behind > 0 ? `${formatInt(behind)} behind` : "ahead"}</span>
                        )}
                      </Cell>
                      <MiningStatus mining={active && stats.mining} hashrate={stats.hashrate} className={fade} />
                      <Cell
                        grade={active && atHead && timed ? gradePropagation(stats.block.propagation) : undefined}
                        title={active && atHead && !timed ? "Caught up to after connecting: timed from the next block" : undefined}
                        className={fade}
                      >
                        {!active ? (
                          "—"
                        ) : !atHead ? (
                          "n/a"
                        ) : !timed ? (
                          <>
                            <Dash />
                            <span className="sr-only">Not timed</span>
                          </>
                        ) : stats.block.propagation ? (
                          `+${formatMs(stats.block.propagation)}`
                        ) : (
                          "first"
                        )}
                      </Cell>
                      <td className={`px-3 py-3 ${fade}`}>
                        {nodes.length < 2 ? (
                          // With no other node, every block reaches this one first: nothing to compare
                          <Tooltip content="No other node to compare with">
                            <span className="text-muted-foreground">—</span>
                          </Tooltip>
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            <PropagationStrip history={node.history} bestBlock={bestBlock} offline={!active} />
                            <span className="text-xs whitespace-nowrap text-muted-foreground">
                              {behind > HISTORY_BINS ? (
                                "n/a"
                              ) : timedAverage(node) === null ? (
                                <Tooltip content={`None of the last ${HISTORY_BINS} blocks timed yet`}>
                                  <span className="inline-flex">
                                    <Dash />
                                    <span className="sr-only">No average yet</span>
                                  </span>
                                </Tooltip>
                              ) : (
                                `avg ${formatMs(stats.propagationAvg)}`
                              )}
                            </span>
                          </span>
                        )}
                      </td>
                      <Cell className={`text-muted-foreground ${fade}`}>{active ? <MempoolSize pending={stats.pending} /> : "—"}</Cell>
                      <Cell grade={active ? gradeUptime(stats.uptime) : undefined} className={fade}>
                        {stats.uptime}%
                      </Cell>
                    </tr>
                    {(expanded || closing === node.id) && (
                      <Details node={node} colSpan={colSpan} open={expanded} now={now} onClosed={onClosed} />
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
