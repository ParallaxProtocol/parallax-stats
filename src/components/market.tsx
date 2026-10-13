"use client";

import { formatAgo, formatCompact, formatPercent } from "@/lib/format";
import type { Market } from "@/lib/protocol";
import { Waiting } from "./charts";
import { ExternalLink } from "./external-link";
import { Ping } from "./indicator";
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

/** Depth shows one side's ±2% depth: a dash when unreported, and "none" when no orders sit within 2% of the price. */
function Depth({ dollars }: { dollars: number | null }) {
  if (dollars === null) return <>—</>;
  if (dollars > 0) return <>{usd(dollars)}</>;

  return (
    <Tooltip content="No orders within 2% of the price">
      <span className="text-muted-foreground italic">none</span>
    </Tooltip>
  );
}

/**
 * Exchanges lists where LAX trades and how well: each pair's share of the
 * volume, its spread and the orders near its price, and at its foot why
 * the price is only a rough guide, while it is.
 */
export function Exchanges({
  markets,
  priceUrl,
  warning = null,
  className = "",
}: {
  markets: Market[] | null;
  /** The coin's CoinGecko page, credited in the heading. */
  priceUrl: string | null;
  /** Why the price is only a rough guide, while it is: said at the foot of the card. */
  warning?: string | null;
  className?: string;
}) {
  const now = useServerNow();
  const list = markets ?? [];
  const total = list.reduce((sum, m) => sum + m.volume24h, 0);

  return (
    <Plate as="section" aria-labelledby="exchanges-title" className={`flex min-w-0 flex-col gap-4 p-5 ${className}`}>
      <Heading
        id="exchanges-title"
        title="Exchanges"
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
                          <Depth dollars={m.depthUp} />
                          <span className="text-muted-foreground"> / </span>
                          <Depth dollars={m.depthDown} />
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
          {warning && (
            // At the foot of the card
            <p className="mt-auto flex items-center gap-2.5 border-t border-border pt-3 text-xs">
              <span aria-hidden className="relative flex size-2 shrink-0">
                <Ping color="bg-warn" cause={warning} />
                <span className="relative inline-flex size-2 rounded-full bg-warn" />
              </span>
              {warning}
            </p>
          )}
        </>
      )}
    </Plate>
  );
}
