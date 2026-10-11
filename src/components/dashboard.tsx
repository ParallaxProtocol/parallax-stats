"use client";

import { useMemo, type ReactNode } from "react";
import { miningDifficulty } from "@/lib/asert";
import { onMainnet, summarize } from "@/lib/derive";
import { formatInt } from "@/lib/format";
import type { Snapshot } from "@/lib/protocol";
import type { Release, ReleaseCommits } from "@/lib/releases";
import type { WorldMap } from "@/lib/world";
import { About } from "./about";
import { AlertCount, Alerts, useAlerts } from "./alerts";
import { BlockClock, ClockPlate, MiniClock } from "./block-clock";
import { BlockToasts, SoundToggle } from "./block-toast";
import { BlockTime, Decentralization, EMPTY_CHARTS, Fees, Fullness, Propagation, Transactions } from "./charts";
import { FigureTile, figures } from "./figures";
import { ClientVersions, StaleBlocks } from "./health";
import { LiveProvider, useLive } from "./live/provider";
import { Supply } from "./monetary";
import { NodeMap } from "./node-map";
import { NodeTable } from "./node-table";
import { sectionNumber, SectionNav, type SectionLink } from "./section-nav";
import { ThemeToggle } from "./theme-toggle";

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
  const c = charts ?? EMPTY_CHARTS;
  const block = (i: number) => `#${formatInt(c.height[i])}`;
  const figure = figures({ summary, charts, mining, gasPrice });
  const start = c.trends?.start ?? [];
  const foundAt = (summary.bestStats?.block.timestamp ?? 0) * 1000;
  const alerts = useAlerts({ bestBlock: summary.bestBlock, foundAt, charts, nodes, latestRelease });

  return (
    <>
      <Alerts alerts={alerts} />
      <ClockPlate id="best-block" foundAt={foundAt} className="flex flex-col gap-6 p-6 sm:p-8">
        <BlockClock bestBlock={summary.bestBlock} foundAt={foundAt} />
        <ConnectionStatus connection={connection} latency={latency} />
      </ClockPlate>
      {/* Once the block clock scrolls away, the bar carries it in brief, with the header's controls */}
      <SectionNav
        sections={SECTIONS}
        aside={
          <>
            <a href="#best-block" title="Back to the block clock" className="mr-2">
              <MiniClock bestBlock={summary.bestBlock} foundAt={foundAt} />
            </a>
            <AlertCount alerts={alerts} />
            <About compact />
            <SoundToggle compact />
            <ThemeToggle compact />
          </>
        }
        asideAfter="best-block"
      />
      <Section id="mining">
        <div className={FOUR}>
          <FigureTile figure={figure.hashrate} start={start} />
          <FigureTile figure={figure.difficulty} start={start} />
          <BlockTime c={c} block={block} />
          <Decentralization charts={charts} />
        </div>
      </Section>
      <Section id="blocks">
        <div className={FOUR}>
          <Transactions c={c} block={block} />
          <Fullness c={c} block={block} />
          <Fees c={c} block={block} />
          <FigureTile figure={figure.fee} start={start} />
        </div>
      </Section>
      <Section id="supply">
        <Supply bestBlock={summary.bestBlock} />
      </Section>
      {/* Last: the node list grows with the network, and would push anything below it out of reach */}
      <Section id="nodes">
        <div className={FOUR}>
          <NodeMap world={world} nodes={nodes} bestBlock={summary.bestBlock} className="sm:col-span-2 xl:row-span-2" />
          <FigureTile figure={figure.active} start={start} />
          <FigureTile figure={figure.latency} start={start} />
          <FigureTile figure={figure.uptime} start={start} />
          <Propagation stats={c.propagation} />
          <ClientVersions nodes={nodes} latestRelease={latestRelease} className="sm:col-span-2" />
          <StaleBlocks health={charts?.health ?? null} className="sm:col-span-2" />
        </div>
        <NodeTable nodes={nodes} bestBlock={summary.bestBlock} publicNodes={publicNodes} releaseCommits={releaseCommits} />
      </Section>
      <BlockToasts best={best} pools={pools} live={connection === "live"} />
    </>
  );
}

/** Every section lays its tiles on the same four columns, so edges line up down the page. */
const FOUR = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4";

/** The page's sections, in order: the bar under the block clock links to each. */
const SECTIONS: SectionLink[] = [
  { id: "mining", title: "Mining" },
  { id: "blocks", title: "Blocks & fees" },
  { id: "supply", title: "Supply" },
  { id: "nodes", title: "Nodes" },
];

/** Section is a numbered, titled group of tiles on one topic; it scrolls into view clear of the section bar. */
function Section({ id, children }: { id: string; children: ReactNode }) {
  const index = SECTIONS.findIndex((section) => section.id === id);

  return (
    <section id={id} aria-labelledby={`${id}-title`} className="mt-6 flex scroll-mt-16 flex-col gap-4">
      <h2 id={`${id}-title`} className="flex items-baseline gap-3 px-1">
        <span className="font-mono text-xs text-brand tabular-nums">{sectionNumber(index)}</span>
        <span className="font-sans text-xl font-medium tracking-tight">{SECTIONS[index].title}</span>
      </h2>
      {children}
    </section>
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
