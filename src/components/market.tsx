"use client";

import { formatAgo, formatCompact, formatPercent } from "@/lib/format";
import type { Level } from "@/lib/alert-levels";
import type { Market } from "@/lib/protocol";
import { Waiting } from "./charts";
import { ExternalLink } from "./external-link";
import { Heading } from "./health";
import { useServerNow } from "./live/provider";
import { Plate } from "./plate";
import { Tooltip } from "./tooltip";

/** Underlined, so a linked exchange reads as a link inside the table. */
const LINK = "underline decoration-border underline-offset-2 hover:decoration-foreground";

const HEAD = "px-2 pb-2 text-left font-mono text-[10px] font-normal tracking-wider text-muted-foreground uppercase first:pl-0 last:pr-0";
const CELL = "px-2 py-1.5 whitespace-nowrap tabular-nums first:pl-0 last:pr-0";

const significant = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

/** usd shows a market's dollars: $0, $1.14, $601, $12.3K. */
function usd(v: number): string {
  return v >= 10_000 ? `$${formatCompact(v)}` : `$${significant.format(v)}`;
}

/** Dash for a figure the exchange does not report. */
const NONE = <span className="text-muted-foreground">—</span>;

/**
 * Exchanges lists where LAX trades and how well: each pair's share of the
 * volume, its spread and the orders near its price. Below, the orders it
 * takes to push the price 2% down against what miners bring to sell in a
 * day, which is whether the market can take the new coins.
 */
export function Exchanges({
  markets,
  dailyNewCoins,
  priceUrl,
  tone,
  className = "",
}: {
  markets: Market[] | null;
  /** New coins a day, in dollars; null while unknown. */
  dailyNewCoins: number | null;
  /** The coin's CoinGecko page, credited in the heading. */
  priceUrl: string | null;
  /** Tints the tile while the market is thin. */
  tone?: Level | null;
  className?: string;
}) {
  const now = useServerNow();
  const list = markets ?? [];
  const total = list.reduce((sum, m) => sum + m.volume24h, 0);
  const sellers = list.filter((m) => m.depthDown !== null);
  const sellDepth = sellers.reduce((sum, m) => sum + m.depthDown!, 0);

  return (
    <Plate as="section" aria-labelledby="exchanges-title" tone={tone} className={`flex min-w-0 flex-col gap-4 p-5 ${className}`}>
      <Heading
        id="exchanges-title"
        title="Where LAX trades"
        readout={priceUrl ? <ExternalLink href={`${priceUrl}#markets`}>CoinGecko</ExternalLink> : undefined}
      />
      {list.length === 0 ? (
        <Waiting>{markets === null ? "Collecting markets" : "No exchange reports trading"}</Waiting>
      ) : (
        <>
          <div className="-mx-5 overflow-x-auto px-5">
            {/* Wide enough on a phone to keep the figures apart; narrower, it scrolls */}
            <table className="w-full min-w-[36rem] text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className={HEAD}>Exchange</th>
                  <th className={HEAD}>Pair</th>
                  <th className={`${HEAD} text-right`}>24h volume</th>
                  <th className={`${HEAD} text-right`}>Share</th>
                  <Tooltip content="The gap between the best offer to buy and the best to sell, against the price">
                    <th className={`${HEAD} text-right`}>Spread</th>
                  </Tooltip>
                  <Tooltip content="Dollars of orders it takes to move the price 2% up (buying) and 2% down (selling)">
                    <th className={`${HEAD} text-right`}>±2% depth</th>
                  </Tooltip>
                  <th className={`${HEAD} text-right`}>Last trade</th>
                </tr>
              </thead>
              <tbody>
                {list.map((m) => (
                  <tr key={`${m.exchange} ${m.pair}`} className="border-b border-border/50 last:border-0">
                    <td className={CELL}>
                      {m.url ? (
                        <a href={m.url} target="_blank" rel="noopener noreferrer" className={LINK}>
                          {m.exchange}
                        </a>
                      ) : (
                        m.exchange
                      )}
                    </td>
                    <td className={`${CELL} font-mono text-muted-foreground`}>{m.pair}</td>
                    <td className={`${CELL} text-right`}>{usd(m.volume24h)}</td>
                    <td className={`${CELL} text-right`}>{total > 0 ? formatPercent(m.volume24h / total) : NONE}</td>
                    <td className={`${CELL} text-right`}>{m.spread !== null ? `${significant.format(m.spread)}%` : NONE}</td>
                    <td className={`${CELL} text-right`}>
                      {m.depthUp !== null || m.depthDown !== null ? (
                        <>
                          {m.depthUp !== null ? usd(m.depthUp) : "—"}
                          <span className="text-muted-foreground"> / </span>
                          {m.depthDown !== null ? usd(m.depthDown) : "—"}
                        </>
                      ) : (
                        NONE
                      )}
                    </td>
                    <td className={`${CELL} text-right text-muted-foreground`}>{m.lastTrade !== null ? formatAgo(m.lastTrade, now) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sellers.length > 0 && (
            <p className="mt-auto text-sm text-muted-foreground">
              Selling <span className="text-foreground tabular-nums">{usd(sellDepth)}</span> would push the price 2% down
              {sellers.length === 2 ? " on both exchanges" : sellers.length > 2 ? ` on all ${sellers.length} exchanges` : ""}
              {dailyNewCoins !== null && (
                <>
                  ; miners bring <span className="text-foreground tabular-nums">{usd(dailyNewCoins)}</span> of new coins a day
                  {sellDepth > 0 && dailyNewCoins > sellDepth && `, ${significant.format(dailyNewCoins / sellDepth)}× as much`}
                </>
              )}
              .
            </p>
          )}
        </>
      )}
    </Plate>
  );
}
