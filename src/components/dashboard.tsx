"use client";

import { useMemo } from "react";
import { miningDifficulty } from "@/lib/asert";
import { onMainnet, summarize } from "@/lib/derive";
import type { Snapshot } from "@/lib/protocol";
import type { Release, ReleaseCommits } from "@/lib/releases";
import type { WorldMap } from "@/lib/world";
import { Alerts } from "./alerts";
import { BlockClock, ClockPlate } from "./block-clock";
import { BlockToasts } from "./block-toast";
import { ChartGrid } from "./charts";
import { Figures } from "./figures";
import { LiveProvider, useLive } from "./live/provider";
import { Monetary } from "./monetary";
import { NetworkHealth } from "./health";
import { NodeMap } from "./node-map";
import { NodeTable } from "./node-table";

export function Dashboard({
  initial,
  world,
  publicNodes,
  latestRelease,
  releaseCommits,
}: {
  initial: Snapshot;
  world: WorldMap;
  publicNodes: boolean;
  latestRelease: Release | null;
  releaseCommits: ReleaseCommits;
}) {
  return (
    <LiveProvider initial={initial}>
      <Live world={world} publicNodes={publicNodes} latestRelease={latestRelease} releaseCommits={releaseCommits} />
    </LiveProvider>
  );
}

function Live({
  world,
  publicNodes,
  latestRelease,
  releaseCommits,
}: {
  world: WorldMap;
  publicNodes: boolean;
  latestRelease: Release | null;
  releaseCommits: ReleaseCommits;
}) {
  const { nodes, charts, gasPrice, pools, connection, latency } = useLive();
  const summary = useMemo(() => summarize(nodes), [nodes]);
  const mainnet = useMemo(() => onMainnet(nodes), [nodes]);
  const best = summary.bestStats?.block ?? null;
  const mainnetBest = mainnet ? best : null;
  const mining = mainnetBest ? miningDifficulty(mainnetBest) : null;

  return (
    <>
      <Alerts
        bestBlock={summary.bestBlock}
        foundAt={(summary.bestStats?.block.timestamp ?? 0) * 1000}
        charts={charts}
        nodes={nodes}
        latestRelease={latestRelease}
      />
      <ClockPlate foundAt={(summary.bestStats?.block.timestamp ?? 0) * 1000} className="flex flex-col gap-6 p-6 sm:p-8">
        <BlockClock bestBlock={summary.bestBlock} foundAt={(summary.bestStats?.block.timestamp ?? 0) * 1000} />
        <ConnectionStatus connection={connection} latency={latency} />
      </ClockPlate>
      <Figures summary={summary} charts={charts} mining={mining} gasPrice={gasPrice} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ChartGrid charts={charts} mainnetBest={mainnetBest} />
        <NodeMap world={world} nodes={nodes} bestBlock={summary.bestBlock} />
      </div>
      <Monetary bestBlock={summary.bestBlock} charts={charts} />
      <NetworkHealth health={charts?.health ?? null} nodes={nodes} latestRelease={latestRelease} />
      <NodeTable nodes={nodes} bestBlock={summary.bestBlock} publicNodes={publicNodes} releaseCommits={releaseCommits} />
      <BlockToasts best={best} pools={pools} live={connection === "live"} />
    </>
  );
}

function ConnectionStatus({ connection, latency }: { connection: string; latency: number | null }) {
  const text =
    connection === "live"
      ? `Live${latency !== null ? `, ${latency} ms to the server` : ""}`
      : connection === "connecting"
        ? "Connecting"
        : "Disconnected, reconnecting";

  return (
    <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground" role="status">
      <span className="relative flex size-2">
        {connection === "live" && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-mark opacity-60 motion-reduce:hidden" />
        )}
        <span
          className={`relative inline-flex size-2 rounded-full ${connection === "live" ? "bg-brand-mark" : connection === "connecting" ? "bg-warn" : "bg-critical"}`}
        />
      </span>
      {text}
    </p>
  );
}
