"use client";

import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import {
  clientVersion,
  formatAgo,
  formatGasPrice,
  formatHashrate,
  formatInt,
  formatMs,
  gradeBehind,
  gradeLatency,
  gradePeerLatency,
  gradePeers,
  gradePropagation,
  gradeUptime,
  shortHash,
  type Grade,
} from "@/lib/format";
import { HISTORY_BINS, type PublicNode } from "@/lib/protocol";
import { AddNode } from "./add-node";
import { CopyButton } from "./copy-button";
import { GRADE_NAME, GRADE_TEXT } from "./indicator";
import { Label } from "./plate";
import { useServerNow } from "./live/provider";
import { usePersistent } from "./use-persistent";

type SortKey =
  | "name"
  | "client"
  | "sync"
  | "peers"
  | "peerLatency"
  | "latency"
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

const DEFAULT_SORT: Sort = { key: "block", desc: true };
const NO_PINS: string[] = [];

const SORT_VALUE: Record<SortKey, (n: PublicNode) => number | string> = {
  name: (n) => n.info.name.toLowerCase(),
  client: (n) => n.info.node,
  sync: (n) => (n.stats.syncing ? 1 : 0),
  peers: (n) => n.stats.peers,
  peerLatency: (n) => n.stats.peerLatency || Number.MAX_SAFE_INTEGER,
  latency: (n) => n.stats.latency,
  block: (n) => n.stats.block.number,
  // Miners first, by hashrate; offline nodes count as not mining
  mining: (n) => (n.stats.active && n.stats.mining ? 1 + n.stats.hashrate : 0),
  propagation: (n) => n.stats.block.propagation,
  propagationAvg: (n) => n.stats.propagationAvg,
  pending: (n) => n.stats.pending,
  uptime: (n) => n.stats.uptime,
};

function compare(a: number | string, b: number | string): number {
  return typeof a === "string" ? a.localeCompare(String(b)) : a - (b as number);
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * sortNodes puts pinned nodes first, then verified ones, each group in
 * name order so they keep their places. The rest follow: connected before
 * offline, then by the chosen column.
 */
function sortNodes(nodes: PublicNode[], sort: Sort, pins: string[]): PublicNode[] {
  // A sort saved by an older version may name a column that no longer exists
  const value = SORT_VALUE[sort.key] ?? SORT_VALUE[DEFAULT_SORT.key];
  const rank = (node: PublicNode) => (pins.includes(node.id) ? 0 : node.trusted ? 1 : 2);

  return [...nodes].sort((a, b) => {
    const group = rank(a) - rank(b);

    if (group !== 0) return group;
    if (rank(a) < 2) return byName.compare(a.info.name, b.info.name) || a.id.localeCompare(b.id);

    return (
      Number(b.stats.active) - Number(a.stats.active) ||
      compare(value(a), value(b)) * (sort.desc ? -1 : 1) ||
      a.stats.block.propagation - b.stats.block.propagation ||
      a.id.localeCompare(b.id)
    );
  });
}

interface Column {
  key: SortKey;
  label: string;
  title: string;
  className?: string;
  /** Sort direction on first click: big values first for counts. */
  desc?: boolean;
}

const COLUMNS: Column[] = [
  { key: "name", label: "Node", title: "Node name" },
  { key: "client", label: "Client", title: "Client version", className: "hidden lg:table-cell" },
  { key: "sync", label: "Sync", title: "Sync state" },
  { key: "peers", label: "Peers", title: "Connected peers", desc: true },
  { key: "peerLatency", label: "Peer latency", title: "Median of the minimum ping to each peer" },
  { key: "latency", label: "Latency", title: "Round trip from the node to this dashboard", className: "hidden sm:table-cell" },
  { key: "block", label: "Block", title: "Latest block", desc: true },
  { key: "mining", label: "Mining", title: "Whether the node is mining; hover the icon for its hashrate", desc: true },
  { key: "propagation", label: "Propagation", title: "Delay after the first node reported the block" },
  { key: "propagationAvg", label: "Propagation history", title: "Propagation delay for each of the last 40 blocks, and the average", className: "hidden lg:table-cell" },
  { key: "pending", label: "Mempool size", title: "Transactions waiting in the node's mempool", className: "hidden 2xl:table-cell", desc: true },
  { key: "uptime", label: "Uptime", title: "Share of time connected since first seen", desc: true },
];

/** Cell shows a value in its grade's color; screen readers hear the grade after the value. */
function Cell({ grade, children, className = "" }: { grade?: Grade; children: ReactNode; className?: string }) {
  return (
    <td className={`px-3 py-3 whitespace-nowrap ${grade ? GRADE_TEXT[grade] : ""} ${className}`}>
      <span className="inline-flex items-center gap-1.5">
        {children}
        {grade && <span className="sr-only">({GRADE_NAME[grade]})</span>}
      </span>
    </td>
  );
}

/** MiningStatus is a pickaxe for a mining node, with its hashrate on hover, and a dash otherwise. */
function MiningStatus({ mining, hashrate }: { mining: boolean; hashrate: number }) {
  const label = mining ? `Mining at ${formatHashrate(hashrate)}` : "Not mining";

  return (
    <td className="px-3 py-3">
      <span role="img" aria-label={label} title={label} className="flex size-5 items-center justify-center">
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
          <svg viewBox="0 0 16 16" className="size-4 text-muted-foreground/60" aria-hidden>
            <path d="M5 8h6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          </svg>
        )}
      </span>
    </td>
  );
}

/** VerifiedIcon marks a node run by the dashboard operator. */
function VerifiedIcon() {
  return (
    <svg viewBox="0 0 24 24" className="ml-1.5 inline-block size-4 -translate-y-px align-middle" role="img" aria-label="Verified">
      <title>Verified: run by the dashboard operator. The best block follows verified nodes.</title>
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
  );
}

/** SyncStatus is a check when synced, a spinner while syncing, and a dash when offline. */
function SyncStatus({ active, syncing }: { active: boolean; syncing: boolean }) {
  const label = !active ? "Offline" : syncing ? "Syncing" : "Synced";

  return (
    <td className="px-3 py-3">
      <span role="img" aria-label={label} title={label} className="flex size-5 items-center justify-center">
        {!active ? (
          <svg viewBox="0 0 16 16" className="size-4 text-muted-foreground" aria-hidden>
            <path d="M4 8h8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          </svg>
        ) : syncing ? (
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
    </td>
  );
}

/** PropagationStrip draws a node's delay for each recent block as a row of tiny columns. */
function PropagationStrip({ history }: { history: number[] }) {
  const ceiling = 8000;
  const h = 18;

  return (
    <svg width={HISTORY_BINS * 3} height={h} className="block" aria-hidden>
      {history.map((ms, i) =>
        ms < 0 ? null : (
          <rect
            key={i}
            x={i * 3}
            y={h - Math.max(2, (Math.min(ms, ceiling) / ceiling) * h)}
            width={2}
            height={Math.max(2, (Math.min(ms, ceiling) / ceiling) * h)}
            className={STRIP_FILL[gradePropagation(ms)]}
          />
        ),
      )}
    </svg>
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
            <dd className="flex min-w-0 items-baseline gap-1 text-right font-mono" title={hint}>
              {value}
            </dd>
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
                    ["Average propagation", formatMs(stats.propagationAvg)],
                  ]}
                />
                <DetailSection
                  title="Activity"
                  rows={[
                    ["Peers", formatInt(stats.peers)],
                    ["Peer latency", stats.peerLatency ? `${stats.peerLatency} ms` : "n/a"],
                    ["Latency to dashboard", `${stats.latency} ms`],
                    ["Mempool size", formatInt(stats.pending)],
                    ["Mining", stats.mining ? formatHashrate(stats.hashrate) : "no"],
                    ["Gas price", formatGasPrice(stats.gasPrice)],
                  ]}
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
  publicSecret,
}: {
  nodes: PublicNode[];
  bestBlock: number;
  publicSecret: string;
}) {
  const now = useServerNow();
  const [sort, setSort] = usePersistent<Sort>("sort", DEFAULT_SORT);
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
  const colSpan = COLUMNS.length + 1;

  function sortBy(column: Column) {
    setSort(sort.key === column.key ? { key: column.key, desc: !sort.desc } : { key: column.key, desc: column.desc ?? false });
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
          <AddNode publicSecret={publicSecret} />
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
                    className={`px-3 py-3 font-mono text-xs font-normal tracking-wider whitespace-nowrap uppercase ${column.className ?? ""}`}
                    aria-sort={sort.key === column.key ? (sort.desc ? "descending" : "ascending") : undefined}
                  >
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 uppercase hover:text-foreground"
                      title={column.title}
                      onClick={() => sortBy(column)}
                    >
                      {column.label}
                      <span aria-hidden className={sort.key === column.key ? "text-brand" : "invisible"}>
                        {sort.desc ? "↓" : "↑"}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {sorted.map((node) => {
                const { stats } = node;
                const active = stats.active;
                const behind = bestBlock - stats.block.number;
                const pinned = pins.includes(node.id);
                const expanded = open === node.id;
                const atHead = behind <= 0;

                return (
                  <Fragment key={node.id}>
                    <tr
                      onClick={() => toggle(node.id)}
                      className={`cursor-pointer border-b border-border/50 transition-colors hover:bg-background/40 ${expanded ? "bg-background/50" : ""} ${active ? "" : "text-muted-foreground"}`}
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
                      <Cell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">{clientVersion(node.info.node) || "unknown"}</Cell>
                      <SyncStatus active={active} syncing={stats.syncing} />
                      <Cell grade={active ? gradePeers(stats.peers) : undefined}>{stats.peers}</Cell>
                      <Cell grade={active ? gradePeerLatency(stats.peerLatency) : undefined}>
                        {stats.peerLatency ? `${stats.peerLatency} ms` : "n/a"}
                      </Cell>
                      <Cell className="hidden sm:table-cell" grade={active ? gradeLatency(stats.latency) : undefined}>
                        {`${stats.latency} ms`}
                      </Cell>
                      <Cell grade={active ? gradeBehind(behind) : undefined}>
                        #{formatInt(stats.block.number)}
                        {active && behind !== 0 && (
                          <span className="text-xs text-muted-foreground">{behind > 0 ? `${formatInt(behind)} behind` : "ahead"}</span>
                        )}
                      </Cell>
                      <MiningStatus mining={active && stats.mining} hashrate={stats.hashrate} />
                      <Cell grade={active && atHead ? gradePropagation(stats.block.propagation) : undefined}>
                        {atHead ? (stats.block.propagation ? `+${formatMs(stats.block.propagation)}` : "first") : "n/a"}
                      </Cell>
                      <td className="hidden px-3 py-3 lg:table-cell">
                        <span className="inline-flex items-center gap-2">
                          <PropagationStrip history={node.history} />
                          <span className="text-xs whitespace-nowrap text-muted-foreground">
                            {behind > HISTORY_BINS ? "n/a" : `avg ${formatMs(stats.propagationAvg)}`}
                          </span>
                        </span>
                      </td>
                      <Cell className="hidden 2xl:table-cell">{formatInt(stats.pending)}</Cell>
                      <Cell grade={active ? gradeUptime(stats.uptime) : undefined}>{stats.uptime}%</Cell>
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
