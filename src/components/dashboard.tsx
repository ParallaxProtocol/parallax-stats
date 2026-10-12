"use client";

import { useMemo, type ReactNode } from "react";
import { miningDifficulty } from "@/lib/asert";
import { onMainnet, summarize } from "@/lib/derive";
import { majorityLevel, spreadLevel } from "@/lib/alert-levels";
import { formatInt } from "@/lib/format";
import type { Snapshot } from "@/lib/protocol";
import type { Release, ReleaseCommits } from "@/lib/releases";
import type { WorldMap } from "@/lib/world";
import { About } from "./about";
import { AlertCount, useAlerts } from "./alerts";
import { BlockClock, ClockPlate, MiniClock } from "./block-clock";
import { BlockToasts, SoundToggle } from "./block-toast";
import { BestBlock, BlockTime, Decentralization, EMPTY_CHARTS, Fees, Fullness, Propagation, Transactions } from "./charts";
import { Confirmations } from "./confirmations";
import { FigureTile, figures } from "./figures";
import { NetworkStatus } from "./incidents";
import { ClientVersions, StaleBlocks } from "./health";
import { LatestBlocks } from "./latest-blocks";
import { LiveProvider, useLive } from "./live/provider";
import { Supply } from "./monetary";
import { NodeMap } from "./node-map";
import { NodeTable } from "./node-table";
import { sectionNumber, SectionNav, STATUS_DOT, type SectionLink } from "./section-nav";
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
  const { nodes, charts, gasPrice, pools, explorer, price, incidents, connection, latency } = useLive();
  const summary = useMemo(() => summarize(nodes), [nodes]);
  const mainnet = useMemo(() => onMainnet(nodes), [nodes]);
  const best = summary.bestStats?.block ?? null;
  const mainnetBest = mainnet ? best : null;
  const mining = mainnetBest ? miningDifficulty(mainnetBest) : null;
  const c = charts ?? EMPTY_CHARTS;
  const block = (i: number) => `#${formatInt(c.height[i])}`;
  const figure = figures({ summary, charts, mining, gasPrice, explorer, price });
  const start = c.trends?.start ?? [];
  const foundAt = (summary.bestStats?.block.timestamp ?? 0) * 1000;
  const alerts = useAlerts({ bestBlock: summary.bestBlock, foundAt, charts, nodes, latestRelease });
  // Warnings that stand whether or not their banner was dismissed, marked on their sections
  const sections = useMemo(() => {
    const status: Record<string, SectionLink["status"]> = {
      mining: (() => {
        const level = majorityLevel(charts);

        return level && { level, label: level === "critical" ? "One miner holds a majority" : "Two miners hold a majority" };
      })(),
      nodes: (() => {
        const level = spreadLevel(charts?.propagation);

        return level && { level, label: "Blocks reach nodes slowly" };
      })(),
    };

    return SECTIONS.map((section) => ({ ...section, status: status[section.id] ?? null }));
  }, [charts]);

  return (
    <BestBlock value={summary.bestBlock}>
      {/* What visitors most often come for: whether something is wrong now, and what went wrong before */}
      <NetworkStatus log={incidents} alerts={alerts} />
      <ClockPlate id="best-block" foundAt={foundAt} className="flex flex-col gap-6 p-6 sm:p-8">
        <BlockClock bestBlock={summary.bestBlock} foundAt={foundAt} />
        <ConnectionStatus connection={connection} latency={latency} />
      </ClockPlate>
      {/* Once the block clock scrolls away, the bar carries it in brief, with the header's controls */}
      <SectionNav
        sections={sections}
        aside={
          <>
            <a href="#best-block" title="Back to the block clock" className="mr-2">
              <MiniClock bestBlock={summary.bestBlock} foundAt={foundAt} />
            </a>
            <AlertCount alerts={alerts} />
            <ThemeToggle compact />
            <SoundToggle compact />
            <About compact />
          </>
        }
        asideAfter="best-block"
      />
      <Section id="mining" sections={sections}>
        <div className={FOUR}>
          <FigureTile figure={figure.hashrate} start={start} />
          <FigureTile figure={figure.difficulty} start={start} />
          <BlockTime c={c} block={block} />
          {/* Both rows on wide screens, so the miner list has room */}
          <Decentralization charts={charts} className="xl:row-span-2" />
          {/* What a hash earns, what all of them earn, and what that means for a payment */}
          <FigureTile figure={figure.hashprice} start={start} />
          <FigureTile figure={figure.security} start={start} />
          <Confirmations charts={charts} className="sm:col-span-2 xl:col-span-1" />
        </div>
      </Section>
      <Section id="blocks" sections={sections}>
        <div className={FOUR}>
          <Transactions c={c} block={block} />
          <Fullness c={c} block={block} />
          <Fees c={c} block={block} />
          <FigureTile figure={figure.fee} start={start} />
          <LatestBlocks c={c} pools={pools} explorer={explorer} className="sm:col-span-2 xl:col-span-3" />
          {/* Under the recommended fee, which it explains */}
          <FigureTile figure={figure.mempool} start={start} className="sm:col-span-2 xl:col-span-1" />
        </div>
      </Section>
      <Section id="supply" sections={sections}>
        <Supply bestBlock={summary.bestBlock} />
      </Section>
      {/* Last: the node list grows with the network, and would push anything below it out of reach */}
      <Section id="nodes" sections={sections}>
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
    </BestBlock>
  );
}

/** Every section lays its tiles on the same four columns, so edges line up down the page. */
const FOUR = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4";

/** The page's sections, in order: the bar under the block clock links to each. */
const SECTIONS: SectionLink[] = [
  { id: "mining", title: "Mining", description: "Hashrate, difficulty, who finds the blocks and how long to wait" },
  { id: "blocks", title: "Blocks & fees", description: "What recent blocks carried, what is waiting, and what sending costs" },
  { id: "supply", title: "Supply", description: "Issuance, halvings and the 21 million cap" },
  { id: "nodes", title: "Nodes", description: "Where the network runs, and how well it keeps up" },
];

/**
 * Section is a numbered, titled group of tiles on one topic; it scrolls into
 * view clear of the section bar. Its heading reads like an instrument's
 * scale: a bracketed index, the title, and a ruled line out to any warning
 * about the section.
 */
function Section({ id, sections, children }: { id: string; sections: SectionLink[]; children: ReactNode }) {
  const index = sections.findIndex((section) => section.id === id);
  const { title, description, status } = sections[index];

  return (
    <section id={id} aria-labelledby={`${id}-title`} className="mt-10 flex scroll-mt-16 flex-col gap-4 first-of-type:mt-6">
      <header className="flex flex-wrap items-end gap-x-4 gap-y-1 px-1">
        <h2 id={`${id}-title`} className="flex items-center gap-3">
          <span className="section-index font-mono text-[11px] text-brand tabular-nums">{sectionNumber(index)}</span>
          <span className="font-sans text-2xl font-medium tracking-tight">{title}</span>
        </h2>
        <p className="pb-0.5 text-sm text-muted-foreground max-sm:basis-full">{description}</p>
        <span aria-hidden className="section-rule mb-1.5 hidden min-w-8 flex-1 sm:block" />
        {status && (
          <span className="mb-0.5 inline-flex items-center gap-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
            <span className={`relative flex size-1.5`}>
              <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${STATUS_DOT[status.level]}`} />
              <span className={`relative inline-flex size-1.5 rounded-full ${STATUS_DOT[status.level]}`} />
            </span>
            {status.label}
          </span>
        )}
      </header>
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
