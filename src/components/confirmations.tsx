"use client";

import { CONFIDENCE, COST_DEPTHS, MAX_CONFIRMATIONS, reversalCost, waitsFor } from "@/lib/confirmations";
import { DECENTRALIZATION_MIN_BLOCKS } from "@/lib/decentralization";
import { blockPay } from "@/lib/earnings";
import { formatAgo, formatClock, formatInt, formatMs, shortHash } from "@/lib/format";
import { TARGET_BLOCK_TIME, type Charts, type Price } from "@/lib/protocol";
import { open, watch, type Watch } from "@/lib/withholding";
import { EMPTY_CHARTS, Tile, Verdict, Waiting } from "./charts";
import { Method } from "./confirmations-method";
import { Indicator } from "./indicator";
import { useServerNow } from "./live/provider";

/** The confidence the figure answers for: 99.9%. */
const HEADLINE = 1;



const significant = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

function percent(confidence: number): string {
  return `${+(confidence * 100).toFixed(2)}%`;
}

/** wait renders how long a number of confirmations takes at the target block time. */
function wait(confirmations: number): string {
  return formatMs(confirmations * TARGET_BLOCK_TIME * 1000);
}

/** quietFor says how the miner's quietest recent stretch went: no block for 1 h 20 min, or 3 blocks in 2 h 05 min where 14 were expected. */
function quietFor({ stretch }: Watch): string {
  return stretch.found === 0
    ? `no block for ${formatClock(stretch.seconds * 1000)}`
    : `${formatInt(stretch.found)} blocks in ${formatClock(stretch.seconds * 1000)} where ${formatInt(Math.round(stretch.expected))} were expected`;
}

/** Row is one line of the tile's table: what it applies to, and the wait. */
function Row({ label, blocks }: { label: string; blocks: number | null }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">
        {blocks === null ? (
          `over ${formatInt(MAX_CONFIRMATIONS)} blocks`
        ) : (
          <>
            {formatInt(blocks)} blocks <span className="text-muted-foreground">≈ {wait(blocks)}</span>
          </>
        )}
      </dd>
    </div>
  );
}

/**
 * Confirmations says how many blocks a payment should wait for, against
 * the largest miner of the last 7 days trying to replace it. Against a
 * minority, the fewest that keep its chance of catching up in secret low:
 * far fewer while it is seen mining in the open, as it then cannot have
 * been mining in secret meanwhile. Against a majority no wait is certain,
 * so it is by the payment's size: long enough that replacing the payment
 * would cost the miner more than the payment, in the rewards of its own
 * blocks it would throw away. Under the table, whether that miner still
 * mines in the open: green while it does, grey while unusually quiet, then
 * amber and red as its quiet grows unlikely; red holds payments. Colour on
 * the tile is only ever that: what is happening now, not what the miner
 * could do, which the decentralization tile and the majority alert show.
 */
export function Confirmations({ charts, price, bestBlock, className = "" }: { charts: Charts | null; price: Price | null; bestBlock: number; className?: string }) {
  const now = useServerNow();
  const c = charts ?? EMPTY_CHARTS;
  // A server from before the weekly window sends no count: its miners cover the charted blocks
  const total = typeof c.minerBlocks === "number" ? c.minerBlocks : c.height.length;
  const largest = c.miners[0] ?? null;
  const share = largest && total > 0 ? largest.blocks / total : null;
  const judged = share !== null && total >= DECENTRALIZATION_MIN_BLOCKS;
  const majority = share !== null && share >= 0.5;
  const name = largest ? (largest.pool?.name ?? shortHash(largest.miner)) : "";
  const pct = share !== null ? Math.round(share * 100) : 0;
  const quiet = judged ? watch(charts, now) : null;
  // Seen mining in the open: it cannot have been mining in secret meanwhile, beyond what it could hide
  const seenOpen = open(quiet);
  const needed = share === null ? [] : waitsFor(share, seenOpen);
  // What reversing costs, in dollars at the current price, or in LAX without one
  const pay = blockPay(bestBlock, c.fees);
  const usd = price?.usd ?? null;
  const money = (lax: number) => (usd !== null ? `$${significant.format(lax * usd)}` : `${significant.format(lax)} LAX`);
  const priced = majority && bestBlock > 0;
  // The headline: the paper's 99.9% against a minority, the shortest wait against a majority
  const headline = majority ? (priced ? COST_DEPTHS[0] : null) : (needed[HEADLINE] ?? null);
  const hold = quiet?.level === "critical";

  return (
    <Tile
      className={className}
      title="Recommended confirmations"
      readout={<Method largest={judged && share !== null ? { name, share } : null} blocktime={c.avgBlocktime} pay={bestBlock > 0 ? pay : 0} usd={usd} quiet={quiet} />}
      value={
        share === null ? undefined : !judged ? (
          "Too early"
        ) : hold ? (
          <Verdict grade="critical">Hold payments</Verdict>
        ) : headline === null ? (
          majority ? "None is certain" : `Over ${formatInt(MAX_CONFIRMATIONS)}`
        ) : (
          `${formatInt(headline)} blocks`
        )
      }
      qualifier={
        share === null
          ? undefined
          : !judged
            ? `${formatInt(total)} blocks are too few to judge the largest miner's share`
            : hold
              ? `${quiet!.name} has stopped publishing: payments after block #${formatInt(quiet!.stretch.height)} may be reversed`
              : majority
                ? headline !== null
                  ? `≈ ${wait(headline)}, for payments up to ${money(reversalCost(share, headline, pay))}; larger ones need longer`
                  : `${name} has ${pct}% of blocks, enough to reverse any payment`
                : headline === null
                  ? `for ${percent(CONFIDENCE[HEADLINE])} safety: ${name} is close to a majority`
                  : seenOpen
                    ? `≈ ${wait(headline)}, for ${percent(CONFIDENCE[HEADLINE])} safety while the dot below stays green`
                    : `≈ ${wait(headline)}, for ${percent(CONFIDENCE[HEADLINE])} safety`
      }
    >
      {share === null ? (
        <Waiting />
      ) : !judged ? null : (
        <div className="mt-auto flex flex-col gap-3">
          {/* While payments are on hold, no wait is recommended */}
          {!hold && (
            <dl className="divide-y divide-border/60 text-xs">
              {majority
                ? priced && COST_DEPTHS.map((depth) => <Row key={depth} label={`Payments up to ${money(reversalCost(share, depth, pay))}`} blocks={depth} />)
                : CONFIDENCE.map((confidence, i) => <Row key={confidence} label={`${percent(confidence)} safe`} blocks={needed[i]} />)}
            </dl>
          )}
          {/* Whether the largest miner still mines in the open: its hashrate would go missing from the chain to mine one in secret */}
          {quiet && (
            <p className="flex min-w-0 items-baseline gap-2 text-xs">
              {/* Green while it publishes as its share says, grey while unusually quiet, then the warning's colour */}
              <Indicator grade={quiet.level ?? (seenOpen ? "good" : "off")} label="" className="relative top-px" />
              <span className="min-w-0 text-muted-foreground">
                <span className="text-foreground">{quiet.name}</span> ({pct}%){" "}
                {!seenOpen
                  ? `has published ${quietFor(quiet)}`
                  : `is mining in the open: last block ${formatAgo(quiet.last.timestamp * 1000, now)}`}
              </span>
            </p>
          )}
        </div>
      )}
    </Tile>
  );
}

