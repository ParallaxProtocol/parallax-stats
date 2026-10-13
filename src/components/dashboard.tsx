"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { animate, MotionConfig, stagger } from "motion/react";
import { miningDifficulty } from "@/lib/asert";
import { onMainnet, summarize } from "@/lib/derive";
import { majorityLevel, spreadLevel, thinMarket } from "@/lib/alert-levels";
import { formatInt } from "@/lib/format";
import type { Snapshot } from "@/lib/protocol";
import type { PublishedRelease, Release, ReleaseCommits } from "@/lib/releases";
import { watch } from "@/lib/withholding";
import type { WorldMap } from "@/lib/world";
import { About } from "./about";
import { AlertCount, useAlerts } from "./alerts";
import { BlockClock, ClockPlate, MiniClock } from "./block-clock";
import { BlockToasts, SoundToggle } from "./block-toast";
import { BestBlock, BlockTime, Decentralization, EMPTY_CHARTS, Fees, Fullness, MinerCall, Propagation, Transactions } from "./charts";
import { Confirmations } from "./confirmations";
import { FigureTile, figures } from "./figures";
import { NetworkStatus } from "./incidents";
import { ClientVersions, StaleBlocks } from "./health";
import { LatestBlocks } from "./latest-blocks";
import { LiveProvider, useLive, useServerNow } from "./live/provider";
import { SPRING } from "./motion";
import { Exchanges } from "./market";
import { Supply } from "./monetary";
import { NodeMap } from "./node-map";
import { NodeTable } from "./node-table";
import { sectionNumber, SectionNav, STATUS_DOT, type SectionLink } from "./section-nav";
import { Ping } from "./indicator";
import { Tooltip } from "./tooltip";

export function Dashboard({
  initial,
  world,
  publicNodes,
  latestRelease,
  releaseCommits,
  releases,
}: {
  initial: Snapshot;
  world: WorldMap;
  publicNodes: boolean;
  latestRelease: Release | null;
  releaseCommits: ReleaseCommits;
  releases: PublishedRelease[];
}) {
  return (
    // Every animation follows the viewer's reduced motion setting: transforms and heights jump, fades stay
    <MotionConfig reducedMotion="user">
      <LiveProvider initial={initial}>
        <Live world={world} publicNodes={publicNodes} latestRelease={latestRelease} releaseCommits={releaseCommits} releases={releases} />
      </LiveProvider>
    </MotionConfig>
  );
}

function Live({
  world,
  publicNodes,
  latestRelease,
  releaseCommits,
  releases,
}: {
  world: WorldMap;
  publicNodes: boolean;
  latestRelease: Release | null;
  releaseCommits: ReleaseCommits;
  releases: PublishedRelease[];
}) {
  const { nodes, charts, gasPrice, pools, explorer, price, markets, incidents, connection, latency } = useLive();
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
  const thin = thinMarket(markets);
  const alerts = useAlerts({ charts, nodes, latestRelease });
  const quiet = watch(charts, useServerNow())?.level ?? null;
  // Warnings marked on their sections
  const sections = useMemo(() => {
    const status: Record<string, SectionLink["status"]> = {
      mining: (() => {
        // The largest miner gone quiet first: it is what to act on now
        if (quiet) return { level: quiet, label: "The largest miner has stopped publishing" };

        const level = majorityLevel(charts);

        return level && { level, label: level === "critical" ? "One miner holds a majority" : "Two miners hold a majority" };
      })(),
      nodes: (() => {
        const level = spreadLevel(charts?.propagation);

        return level && { level, label: "Blocks reach nodes slowly" };
      })(),
      market: thin ? { level: "warn", label: thin } : null,
    };

    return SECTIONS.map((section) => ({ ...section, status: status[section.id] ?? null }));
  }, [charts, thin, quiet]);

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
            <Tooltip content="Back to the block clock">
              <a href="#best-block" className="mr-2">
                <MiniClock bestBlock={summary.bestBlock} foundAt={foundAt} />
              </a>
            </Tooltip>
            <AlertCount alerts={alerts} />
            <SoundToggle compact />
            <About compact />
          </>
        }
        asideAfter="best-block"
      />
      {/* The call to miners at the top says what the header's status would */}
      <Section id="mining" sections={sections} quiet>
        {/* While one miner holds a majority, the section opens with what miners can do about it */}
        <MinerCall charts={charts} />
        <div className={FOUR}>
          <BlockTime c={c} block={block} />
          <FigureTile figure={figure.hashrate} start={start} />
          <FigureTile figure={figure.difficulty} start={start} />
          {/* Both rows on wide screens, so the miner list has room */}
          <Decentralization charts={charts} className="xl:row-span-2" />
          {/* What a hash earns, what all of them earn, and what that means for a payment */}
          <FigureTile figure={figure.hashprice} start={start} />
          <FigureTile figure={figure.security} start={start} />
          <Confirmations charts={charts} price={price} bestBlock={summary.bestBlock} className="sm:col-span-2 xl:col-span-1" />
          {/* Beside how long to wait: whether confirmed blocks have been undone */}
          <StaleBlocks health={charts?.health ?? null} propagation={charts?.propagation} className="sm:col-span-2 xl:col-span-4" />
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
      {/* The exchanges card says at its foot what the header's status would */}
      <Section id="market" sections={sections} quiet>
        <div className={FOUR}>
          <FigureTile figure={figure.price} start={start} />
          <FigureTile figure={figure.marketCap} start={start} />
          <FigureTile figure={figure.volume} start={start} />
          {/* Last: what miners bring to market each day, read against the volume beside it */}
          <FigureTile figure={figure.issuance} start={start} />
          {/* Whether the price above can be trusted */}
          <Exchanges
            markets={markets}
            priceUrl={price?.url ?? null}
            warning={thin}
            className="sm:col-span-2 xl:col-span-3"
          />
          <FigureTile figure={figure.securityShare} start={start} className="sm:col-span-2 xl:col-span-1" />
        </div>
      </Section>
      {/* Last: the node list grows with the network, and would push anything below it out of reach */}
      <Section id="nodes" sections={sections}>
        {/* The four tiles beside the map share one row height: equal fractions settle at the tallest. On
            two columns the map takes the first row; on four it spans the two; client versions comes after */}
        <div className={`${FOUR} sm:grid-rows-[auto_1fr_1fr_auto] xl:grid-rows-[1fr_1fr_auto]`}>
          <NodeMap world={world} nodes={nodes} bestBlock={summary.bestBlock} className="sm:col-span-2 xl:row-span-2" />
          <FigureTile figure={figure.active} start={start} />
          <FigureTile figure={figure.latency} start={start} />
          <FigureTile figure={figure.uptime} start={start} />
          <Propagation stats={c.propagation} />
          <ClientVersions nodes={nodes} latestRelease={latestRelease} releases={releases} className="sm:col-span-2 xl:col-span-4" />
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
  { id: "mining", title: "Mining", description: "Block time, hashrate, difficulty, who finds the blocks and recommended confirmations" },
  { id: "blocks", title: "Blocks & fees", description: "What recent blocks carried, what is waiting, and what sending costs" },
  { id: "supply", title: "Supply", description: "Issuance, halvings and the 21 million cap" },
  { id: "market", title: "Market", description: "What LAX trades at, how much of it trades, and what miners bring to sell" },
  { id: "nodes", title: "Nodes", description: "Where the network runs, and how well it keeps up" },
];

/** How far a section's tiles rise as they come into view, and how far apart they start. */
const RISE = 12;
const STAGGER = 0.05;

/**
 * useTilesEnter has a section's tiles fade and rise into place, one after
 * another, the first time it scrolls into view. Sections already on screen
 * when the page opens are left as they are, so nothing moves on arrival,
 * and so is everything when the viewer asks for reduced motion.
 */
function useTilesEnter() {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const section = ref.current;

    if (!section || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (section.getBoundingClientRect().top < window.innerHeight) return;

    // The section's plates, not ones inside another plate
    const tiles = [...section.querySelectorAll<HTMLElement>(".group\\/plate")].filter((tile) => !tile.parentElement?.closest(".group\\/plate"));

    // Motion throws on an empty list, as for a section with nothing to show yet
    if (tiles.length === 0) return;

    animate(tiles, { opacity: 0, y: RISE }, { duration: 0 });

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;

        observer.disconnect();
        // Back to no transform at all, which Motion writes as none, so no tile is left a containing block
        // for what is positioned inside it
        animate(tiles, { opacity: 1, y: 0 }, { ...SPRING, delay: stagger(STAGGER) });
      },
      { rootMargin: "0px 0px -10% 0px" },
    );

    observer.observe(section);

    return () => observer.disconnect();
  }, []);

  return ref;
}

/**
 * Section is a numbered, titled group of tiles on one topic; it scrolls into
 * view clear of the section bar. Its heading reads like an instrument's
 * scale: a bracketed index, the title, and a ruled line out to any warning
 * about the section. Its tiles rise into place as it first comes into view.
 */
function Section({
  id,
  sections,
  quiet = false,
  children,
}: {
  id: string;
  sections: SectionLink[];
  /** Leaves the status out of the header, for a section whose own content opens with it; the bar still marks it. */
  quiet?: boolean;
  children: ReactNode;
}) {
  const index = sections.findIndex((section) => section.id === id);
  const { title, description, status } = sections[index];
  const ref = useTilesEnter();

  return (
    <section ref={ref} id={id} aria-labelledby={`${id}-title`} className="mt-10 flex scroll-mt-16 flex-col gap-4 first-of-type:mt-6">
      <header className="flex flex-wrap items-end gap-x-4 gap-y-1 px-1">
        <h2 id={`${id}-title`} className="flex items-center gap-3">
          <span className="section-index font-mono text-[11px] text-brand tabular-nums">{sectionNumber(index)}</span>
          <span className="font-sans text-2xl font-medium tracking-tight">{title}</span>
        </h2>
        <p className="pb-0.5 text-sm text-muted-foreground max-sm:basis-full">{description}</p>
        <span aria-hidden className="section-rule mb-1.5 hidden min-w-8 flex-1 sm:block" />
        {status && !quiet && (
          <span className="mb-0.5 inline-flex items-center gap-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
            <span className={`relative flex size-1.5`}>
              <Ping color={STATUS_DOT[status.level]} critical={status.level === "critical"} cause={status.label} />
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
        {/* Pulses as it goes live, again on each reconnection, then rests */}
        {connection === "live" && <Ping color="bg-brand-mark" />}
        <span
          className={`relative inline-flex size-2 rounded-full ${connection === "live" ? "bg-brand-mark" : connection === "connecting" ? "bg-warn" : "bg-critical"}`}
        />
      </span>
      {text}
    </p>
  );
}
