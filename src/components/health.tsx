"use client";

import type { ReactNode } from "react";
import { formatAgo, formatInt } from "@/lib/format";
import type { ChainHealth, PublicNode } from "@/lib/protocol";
import type { Release } from "@/lib/releases";
import { chainLevel } from "@/lib/alert-levels";
import { compareParts, parseVersion } from "@/lib/version";
import { useServerNow } from "./live/provider";
import { Label, Plate } from "./plate";

function Heading({ id, title, readout }: { id: string; title: string; readout?: string }) {
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

/** StaleBlocks shows how often blocks lose to a competing block, and recent reorganizations. */
function StaleBlocks({ health }: { health: ChainHealth }) {
  const now = useServerNow();
  const { window, staleBlocks, recentStale, reorgs, since, lastReorg } = health;
  const rate = window > 0 ? (staleBlocks / window) * 100 : 0;
  const period = now - since >= 23.5 * 3_600_000 ? "in the last 24 hours" : `since the dashboard started ${formatAgo(since, now)}`;

  return (
    <Plate
      as="section"
      id="stale-blocks"
      aria-labelledby="stale-title"
      tone={chainLevel(health, now)}
      className="flex min-w-0 scroll-mt-4 flex-col gap-4 p-5"
    >
      <Heading id="stale-title" title="Stale blocks" readout={window ? `last ${formatInt(window)} blocks` : undefined} />

      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-3xl tabular-nums">{formatInt(staleBlocks)}</span>
        <span className="text-sm text-muted-foreground">
          {staleBlocks === 0
            ? "blocks lost to a competing block"
            : `${staleBlocks === 1 ? "block" : "blocks"} lost to a competing block, ${rate < 0.1 ? rate.toFixed(2) : rate.toFixed(1)}% of all`}
        </span>
      </p>

      <dl className="grid grid-cols-2 gap-3">
        <Stat label="Reorgs">
          {formatInt(reorgs)} <span className="text-xs text-muted-foreground">{period}</span>
        </Stat>
        <Stat label="Last reorg">
          {lastReorg ? (
            <>
              <span className="font-mono">#{formatInt(lastReorg.height)}</span>{" "}
              <span className="text-xs text-muted-foreground">
                {formatAgo(lastReorg.at, now)}, seen by {lastReorg.nodes} {lastReorg.nodes === 1 ? "node" : "nodes"}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">none seen</span>
          )}
        </Stat>
      </dl>

      <div className="mt-auto border-t border-border pt-3">
        {recentStale.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Every block in the window won its race. Only competing blocks seen by verified nodes count.
          </p>
        ) : (
          <>
            <p className="mb-2 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">Latest</p>
            <ol className="flex flex-col gap-1.5 text-xs">
              {recentStale.map((s) => (
                <li key={s.height} className="flex justify-between gap-3">
                  <span className="font-mono">#{formatInt(s.height)}</span>
                  <span className="text-muted-foreground tabular-nums">{formatAgo(s.at, now)}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </Plate>
  );
}

interface Version {
  label: string;
  parts: number[] | null;
  count: number;
}

/**
 * ClientVersions shows which parallaxd releases online nodes run, against
 * the latest release on GitHub. Nodes ahead of it run development builds.
 */
function ClientVersions({ nodes, latestRelease }: { nodes: PublicNode[]; latestRelease: Release | null }) {
  const online = nodes.filter((node) => node.stats.active);
  const counts = new Map<string, Version>();

  for (const node of online) {
    const { label, parts } = parseVersion(node.info.node);
    const entry = counts.get(label) ?? { label, parts, count: 0 };

    entry.count++;
    counts.set(label, entry);
  }

  const versions = [...counts.values()].sort((a, b) => compareParts(b.parts, a.parts));
  const latest = latestRelease ? parseVersion(`/${latestRelease.tag}`) : null;
  const status = (v: Version) =>
    !latest?.parts || !v.parts ? null : compareParts(v.parts, latest.parts) === 0 ? "latest" : compareParts(v.parts, latest.parts) > 0 ? "development" : "older";
  // A node ahead of the release runs a build at least as new
  const current = versions.filter((v) => status(v) === "latest" || status(v) === "development").reduce((sum, v) => sum + v.count, 0);
  const behind = versions.filter((v) => status(v) === "older").reduce((sum, v) => sum + v.count, 0);
  const total = online.length;

  return (
    <Plate as="section" aria-labelledby="versions-title" className="flex min-w-0 flex-col gap-4 p-5">
      <Heading id="versions-title" title="Client versions" readout={total ? `${total} online nodes` : undefined} />

      {total === 0 ? (
        <p className="text-sm text-muted-foreground">Waiting for nodes</p>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-2">
            {latest ? (
              <>
                <span className="text-3xl tabular-nums">{Math.round((current / total) * 100)}%</span>
                <span className="text-sm text-muted-foreground">run the latest release, {latest.label}, or newer</span>
              </>
            ) : (
              <>
                <span className="text-3xl tabular-nums">{versions.length}</span>
                <span className="text-sm text-muted-foreground">
                  {versions.length === 1 ? "version" : "versions"} in use; the latest release could not be checked
                </span>
              </>
            )}
          </p>

          <ol className="flex flex-col gap-2.5">
            {versions.map((v) => {
              const state = status(v);

              return (
                <li key={v.label} className="grid grid-cols-[minmax(0,9rem)_1fr_2.5rem] items-center gap-3 text-xs">
                  <span className={`truncate font-mono ${state === "older" || v.parts === null ? "text-muted-foreground" : ""}`}>
                    {v.label}
                    {state === "latest" && <span className="ml-1.5 font-sans text-[10px] text-brand">latest</span>}
                    {state === "development" && <span className="ml-1.5 font-sans text-[10px] text-info-ink">unreleased</span>}
                  </span>
                  <span className="relative h-1 bg-border/60" title={`${v.count} of ${total} nodes`}>
                    <span
                      className={`absolute inset-y-0 left-0 ${state === "older" || state === null ? "bg-muted-foreground" : "bg-brand-mark"}`}
                      style={{ width: `${(v.count / total) * 100}%` }}
                    />
                  </span>
                  <span className="text-right tabular-nums">{v.count}</span>
                </li>
              );
            })}
          </ol>

          {latestRelease && (
            <p className="mt-auto border-t border-border pt-3 text-xs text-muted-foreground">
              {behind === 0 ? (
                "Every node with a known version runs the latest release or newer."
              ) : (
                <>
                  {behind} {behind === 1 ? "node runs" : "nodes run"} an older release.{" "}
                  <a
                    href={latestRelease.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground underline-offset-2 hover:underline"
                  >
                    Get {latest?.label} on GitHub
                  </a>
                </>
              )}
            </p>
          )}
        </>
      )}
    </Plate>
  );
}

/** NetworkHealth groups the chain's competing blocks with the client releases nodes run. */
export function NetworkHealth({
  health,
  nodes,
  latestRelease,
}: {
  health: ChainHealth | null;
  nodes: PublicNode[];
  latestRelease: Release | null;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <StaleBlocks
        health={health ?? { window: 0, staleBlocks: 0, recentStale: [], reorgs: 0, since: 0, lastReorg: null, lastDeepReorg: null, split: null }}
      />
      <ClientVersions nodes={nodes} latestRelease={latestRelease} />
    </div>
  );
}
