"use client";

import type { ReactNode } from "react";
import { formatAgo, formatBlockTime, formatInt, formatPercent } from "@/lib/format";
import { WEI_PER_LAX } from "@/lib/emission";
import type { Charts, MiningPool } from "@/lib/protocol";
import { formatSmallLax, Waiting } from "./charts";
import { ExternalLink } from "./external-link";
import { Heading } from "./health";
import { useServerNow } from "./live/provider";
import { Plate } from "./plate";
import { Tooltip } from "./tooltip";

/** Underlined, so a linked block or miner reads as a link inside the table. */
const LINK = "underline decoration-border underline-offset-2 hover:decoration-foreground";

/** Blocks listed, newest first. */
const SHOWN = 10;

const HEAD = "px-2 pb-2 text-left font-mono text-[10px] font-normal tracking-wider text-muted-foreground uppercase first:pl-0 last:pr-0";
const CELL = "px-2 py-1.5 whitespace-nowrap tabular-nums first:pl-0 last:pr-0";

/**
 * FullAddress shows a whole address while it fits, and otherwise cuts its
 * middle, keeping the last 4 characters: 0x38432a…c6ab.
 */
function FullAddress({ address }: { address: string }) {
  return (
    <span className="flex min-w-0 font-mono">
      <span className="truncate">{address.slice(0, -4)}</span>
      <span className="shrink-0">{address.slice(-4)}</span>
    </span>
  );
}

/**
 * MinerCell sizes the miner column by its full text, as tables do, but lets
 * it give up width first when the table runs short. An invisible copy that
 * may wrap anywhere sets the column's width: the full text when there is
 * room, next to nothing at the least. The visible text lies over it on one
 * line and cuts what does not fit.
 */
function MinerCell({ text, mono, children }: { text: string; mono: boolean; children: ReactNode }) {
  return (
    <td className={`${CELL} relative`}>
      <span aria-hidden className={`invisible block h-0 overflow-hidden break-all whitespace-normal ${mono ? "font-mono" : ""}`}>
        {text}
      </span>
      <span className="absolute inset-x-2 top-1/2 flex min-w-0 -translate-y-1/2">{children}</span>
    </td>
  );
}

/**
 * LatestBlocks lists the newest blocks: when each was found and by whom,
 * what it carried, and how long it took after its parent.
 */
export function LatestBlocks({
  c,
  pools,
  explorer,
  className = "",
}: {
  c: Charts;
  pools: Record<string, MiningPool>;
  /** The block explorer's address, for links to each block and miner; null for none. */
  explorer: string | null;
  className?: string;
}) {
  const now = useServerNow();
  // A server from before the list sends no miners or timestamps
  const miners = c.miner ?? [];
  const timestamps = c.timestamp ?? [];
  const rows = c.height
    .map((height, i) => ({ height, i }))
    .slice(-SHOWN)
    .reverse();

  return (
    <Plate as="section" aria-labelledby="latest-blocks-title" className={`flex min-w-0 flex-col gap-4 p-5 ${className}`}>
      <Heading
        id="latest-blocks-title"
        title="Latest blocks"
        readout={
          explorer ? (
            <ExternalLink href={`${explorer}/blocks`}>All blocks in the explorer</ExternalLink>
          ) : rows.length > 0 ? (
            "newest first"
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <Waiting />
      ) : (
        <div className="-mx-5 overflow-x-auto px-5">
          {/* Wide enough on a phone that the miner column keeps room to read; narrower, it scrolls */}
          <table className="w-full min-w-[38rem] text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className={HEAD}>Block</th>
                <th className={HEAD}>Found</th>
                <th className={HEAD}>Miner</th>
                <th className={`${HEAD} text-right`}>Transactions</th>
                <th className={`${HEAD} text-right`}>Full</th>
                <th className={`${HEAD} text-right`}>Fees, LAX</th>
                <Tooltip content="Time since the parent block">
                  <th className={`${HEAD} text-right`}>Took</th>
                </Tooltip>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ height, i }) => {
                const miner = miners[i];
                const pool = miner ? (pools[miner] ?? null) : null;
                const fees = c.fees[i];
                const limit = c.gasLimit[i];

                return (
                  <tr key={height} className="border-b border-border/50 last:border-0">
                    <td className={`${CELL} font-mono`}>
                      {explorer ? (
                        <a href={`${explorer}/block/${height}`} target="_blank" rel="noopener noreferrer" className={LINK}>
                          #{formatInt(height)}
                        </a>
                      ) : (
                        `#${formatInt(height)}`
                      )}
                    </td>
                    <td className={`${CELL} text-muted-foreground`}>{timestamps[i] ? formatAgo(timestamps[i] * 1000, now) : "—"}</td>
                    <MinerCell text={pool ? pool.name : (miner ?? "—")} mono={!pool}>
                      {!miner ? (
                        "—"
                      ) : explorer ? (
                        <Tooltip content={<MinerTip miner={miner} pool={pool?.name} />}>
                          <a href={`${explorer}/address/${miner}`} target="_blank" rel="noopener noreferrer" className={`flex min-w-0 ${LINK}`}>
                            {pool ? <span className="truncate">{pool.name}</span> : <FullAddress address={miner} />}
                          </a>
                        </Tooltip>
                      ) : pool ? (
                        <Tooltip content={<MinerTip miner={miner} pool={pool.name} />}>
                          <span className="block truncate">{pool.name}</span>
                        </Tooltip>
                      ) : (
                        <Tooltip content={<MinerTip miner={miner} />}>
                          <span className="flex min-w-0">
                            <FullAddress address={miner} />
                          </span>
                        </Tooltip>
                      )}
                    </MinerCell>
                    <td className={`${CELL} text-right`}>
                      {/* An empty block has no list to show */}
                      {explorer && c.transactions[i] > 0 ? (
                        <Tooltip content={`Transactions in block #${formatInt(height)}`}>
                          <a href={`${explorer}/block/${height}?tab=txs`} target="_blank" rel="noopener noreferrer" className={LINK}>
                            {formatInt(c.transactions[i])}
                          </a>
                        </Tooltip>
                      ) : (
                        formatInt(c.transactions[i])
                      )}
                    </td>
                    <td className={`${CELL} text-right`}>{limit > 0 ? formatPercent(c.gasSpending[i] / limit) : "—"}</td>
                    <td className={`${CELL} text-right`}>
                      {fees === null ? <span className="text-muted-foreground">—</span> : formatSmallLax(Number(BigInt(fees)) / Number(WEI_PER_LAX))}
                    </td>
                    <td className={`${CELL} text-right`}>
                      {/* No time when the parent is not in the history */}
                      {c.blocktime[i] > 0 ? formatBlockTime(c.blocktime[i]) : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Plate>
  );
}

/** MinerTip names a block's miner in full: its pool, if known, over its address. */
function MinerTip({ miner, pool }: { miner: string; pool?: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      {pool && <span>{pool}, mining pool</span>}
      <span className="font-mono break-all text-muted-foreground">{miner}</span>
    </span>
  );
}
