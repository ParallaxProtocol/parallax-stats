"use client";

import { useMemo } from "react";
import { CONFIDENCE, confirmationsFor, MAX_CONFIRMATIONS } from "@/lib/confirmations";
import { DECENTRALIZATION_MIN_BLOCKS } from "@/lib/decentralization";
import { formatInt, formatMs, shortHash } from "@/lib/format";
import { TARGET_BLOCK_TIME, type Charts } from "@/lib/protocol";
import { EMPTY_CHARTS, Tile, Verdict, Waiting } from "./charts";
import { ExternalLink } from "./external-link";

/** The confidence the figure answers for: 99.9%. */
const HEADLINE = 1;

const BITCOIN_PAPER = "https://bitcoin.org/bitcoin.pdf";

function percent(confidence: number): string {
  return `${+(confidence * 100).toFixed(2)}%`;
}

/** wait renders how long a number of confirmations takes at the target block time. */
function wait(confirmations: number): string {
  return formatMs(confirmations * TARGET_BLOCK_TIME * 1000);
}

/**
 * Confirmations says how many blocks a payment should wait for, against
 * the largest miner of the last 7 days trying to replace it, by the
 * calculation in the Bitcoin paper. While that miner holds a majority no
 * wait is safe at any confidence. The tile itself stays untinted: the
 * verdict's dot pulses, red with no safe wait and amber with the miner close
 * to a majority.
 */
export function Confirmations({ charts, className = "" }: { charts: Charts | null; className?: string }) {
  const c = charts ?? EMPTY_CHARTS;
  // A server from before the weekly window sends no count: its miners cover the charted blocks
  const total = typeof c.minerBlocks === "number" ? c.minerBlocks : c.height.length;
  // Allow for the week's first block landing a little after the cutoff
  const fullWeek = c.minerSpan >= 7 * 86_400 - 3_600;
  const largest = c.miners[0] ?? null;
  const share = largest && total > 0 ? largest.blocks / total : null;
  const judged = share !== null && total >= DECENTRALIZATION_MIN_BLOCKS;
  const majority = share !== null && share >= 0.5;
  const needed = useMemo(() => (share === null ? [] : CONFIDENCE.map((confidence) => confirmationsFor(share, confidence))), [share]);
  const name = largest ? (largest.pool?.name ?? shortHash(largest.miner)) : "";
  const headline = needed[HEADLINE] ?? null;
  const pct = share !== null ? Math.round(share * 100) : 0;
  const mined = fullWeek ? `${pct}% of blocks over the last 7 days` : `${pct}% of the last ${formatInt(total)} blocks`;

  return (
    <Tile
      className={className}
      title="Confirmations to wait"
      readout={
        <ExternalLink
          href={BITCOIN_PAPER}
          title="By the calculation in section 11 of the Bitcoin paper, against the largest miner of the last 7 days trying to replace a payment in secret. A pool counts as one miner; hashrate rented for an attack is not counted, so large payments deserve a margin."
        >
          method
        </ExternalLink>
      }
      value={
        share === null
          ? undefined
          : !judged
            ? "Too early"
            : majority
              ? <Verdict grade="critical">None is safe</Verdict>
              : headline === null
                ? <Verdict grade="warn">Over {formatInt(MAX_CONFIRMATIONS)}</Verdict>
                : `${formatInt(headline)} blocks`
      }
      qualifier={
        share === null
          ? undefined
          : !judged
            ? `${formatInt(total)} blocks are too few to judge the largest miner's share`
            : majority
              ? `${name} mined ${mined}, enough to reverse any payment`
              : headline === null
                ? `for ${percent(CONFIDENCE[HEADLINE])} safety: ${name} is close to a majority`
                : `≈ ${wait(headline)}, for ${percent(CONFIDENCE[HEADLINE])} safety`
      }
    >
      {share === null ? (
        <Waiting />
      ) : !judged ? null : (
        <dl className="mt-auto divide-y divide-border/60 text-xs">
          {CONFIDENCE.map((confidence, i) => (
            <div key={confidence} className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className="text-muted-foreground">{percent(confidence)} safe</dt>
              <dd className="tabular-nums">
                {majority ? (
                  // No number of blocks is enough: the wait is unbounded
                  <span aria-label="no wait is enough">∞</span>
                ) : needed[i] === null ? (
                  `over ${formatInt(MAX_CONFIRMATIONS)} blocks`
                ) : (
                  <>
                    {formatInt(needed[i]!)} blocks <span className="text-muted-foreground">≈ {wait(needed[i]!)}</span>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Tile>
  );
}
