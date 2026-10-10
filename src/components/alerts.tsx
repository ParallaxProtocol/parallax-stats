"use client";

import type { ReactNode } from "react";
import { formatAgo, formatClock, formatInt, STALL_MS } from "@/lib/format";
import type { ChainHealth } from "@/lib/protocol";
import { useServerNow } from "./live/provider";

/** Reorganizations stay on the banner this long. */
const REORG_ALERT_MS = 30 * 60 * 1000;

const TONE = {
  critical: { box: "border-critical/40 bg-critical/10", icon: "text-critical" },
  warn: { box: "border-warn/40 bg-warn/10", icon: "text-warn" },
};

function Banner({ tone, title, children }: { tone: keyof typeof TONE; title: string; children: ReactNode }) {
  return (
    <p role="status" className={`flex gap-3 border px-4 py-3 text-sm ${TONE[tone].box}`}>
      <svg
        viewBox="0 0 16 16"
        className={`mt-0.5 size-4 shrink-0 ${TONE[tone].icon}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden
      >
        <path d="M8 2 14.5 13.5h-13Z" strokeLinejoin="round" />
        <path d="M8 6.5v3M8 11.6v.1" strokeLinecap="round" />
      </svg>
      <span>
        <span className="font-medium">{title}</span> <span className="text-muted-foreground">{children}</span>
      </span>
    </p>
  );
}

/**
 * Alerts calls out what needs attention at the top of the page: no block
 * for longer than the stall threshold, or a recent chain reorganization.
 */
export function Alerts({ foundAt, health }: { foundAt: number; health: ChainHealth | null }) {
  const now = useServerNow();
  const elapsed = foundAt ? now - foundAt : 0;
  const stalled = foundAt > 0 && elapsed > STALL_MS;
  const reorg = health?.lastReorg && now - health.lastReorg.at < REORG_ALERT_MS ? health.lastReorg : null;

  if (!stalled && !reorg) return null;

  return (
    <div className="flex flex-col gap-2">
      {stalled && (
        <Banner tone="critical" title={`No new block for ${formatClock(elapsed)}.`}>
          That is over {Math.floor(elapsed / 600_000)} times the 10 minute target, so the network may have stalled.
        </Banner>
      )}
      {reorg && (
        <Banner tone="warn" title={`Chain reorganization at block #${formatInt(reorg.height)}, ${formatAgo(reorg.at, now)}.`}>
          Seen by {reorg.nodes} {reorg.nodes === 1 ? "node" : "nodes"}: blocks at that height were replaced by another chain.
        </Banner>
      )}
    </div>
  );
}
