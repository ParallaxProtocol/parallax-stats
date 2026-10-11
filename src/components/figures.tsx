import type { Summary } from "@/lib/derive";
import {
  formatBlockTime,
  formatDifficulty,
  formatGasPrice,
  formatInt,
  formatPoolDifficulty,
  formatHashrate,
  gradeAvgBlockTime,
  gradePeerLatency,
  gradeRatio,
  gradeUptime,
  type Grade,
} from "@/lib/format";
import type { Charts } from "@/lib/protocol";
import { Indicator } from "./indicator";

interface Figure {
  label: string;
  value: string;
  grade?: Grade;
  note?: string;
}

/** Gas a plain LAX transfer uses. */
const TRANSFER_GAS = 21_000n;

const significant = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

/**
 * Figures is the row of headline numbers. `mining` is the difficulty of the
 * block being mined, when known: what pools show as network difficulty, so
 * it leads over the last found block's. `gasPrice` is the recommended gas
 * price from RPC, in wei.
 */
export function Figures({
  summary,
  charts,
  mining,
  gasPrice,
}: {
  summary: Summary;
  charts: Charts | null;
  mining: bigint | null;
  gasPrice: string | null;
}) {
  const transfer = gasPrice ? Number(BigInt(gasPrice) * TRANSFER_GAS) / 1e18 : null;
  const { bestStats } = summary;
  const figures: Figure[] = [
    {
      label: "Avg block time",
      value: formatBlockTime(charts?.avgBlocktime ?? 0),
      grade: gradeAvgBlockTime(charts?.avgBlocktime ?? 0),
      // Says which blocks it averages, unlike the Block time tile's last 40
      note: !charts?.minerBlocks
        ? "target 10 min"
        : charts.minerSpan >= 7 * 86_400 - 3_600
          ? "last 7 days, target 10 min"
          : `last ${formatInt(charts.minerBlocks)} blocks, target 10 min`,
    },
    { label: "Network hashrate", value: charts?.avgHashrate ? formatHashrate(charts.avgHashrate) : "n/a" },
    {
      label: "Difficulty",
      value: bestStats ? formatDifficulty(mining ?? bestStats.block.difficulty) : "n/a",
      note: bestStats ? `${formatPoolDifficulty(mining ?? bestStats.block.difficulty)} in pool units` : undefined,
    },
    {
      // Active nodes that are in sync, out of all active ones
      label: "Active nodes",
      value: `${summary.synced} of ${summary.active}`,
      grade: summary.active ? gradeRatio(summary.synced / summary.active) : "off",
      note: "in sync",
    },
    {
      label: "Recommended fee",
      value: gasPrice ? formatGasPrice(Number(gasPrice)) : "n/a",
      note: transfer !== null ? `≈ ${significant.format(transfer)} LAX per transfer` : undefined,
    },
    {
      label: "Peer latency",
      value: summary.peerLatency ? `${summary.peerLatency} ms` : "n/a",
      grade: gradePeerLatency(summary.peerLatency),
      note: "median",
    },
    {
      label: "Uptime",
      // Verified nodes only: anyone can run an unverified node for an hour
      value: summary.uptime !== null ? `${Math.round(summary.uptime)}%` : "n/a",
      grade: summary.uptime !== null ? gradeUptime(summary.uptime) : "off",
      note: "verified nodes",
    },
  ];

  return (
    <dl className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4 xl:grid-cols-7">
      {figures.map((f) => (
        <div key={f.label} className="flex flex-col items-center justify-center gap-2 bg-background px-3 py-6 text-center">
          <dt className="flex items-center gap-1.5 text-[11px] tracking-wider text-muted-foreground uppercase">
            {f.grade && <Indicator grade={f.grade} />}
            {f.label}
          </dt>
          {/* Shown above its label, as on the main site's stat grid */}
          <dd className="order-first font-mono text-lg font-semibold whitespace-nowrap tabular-nums sm:text-xl">
            {f.value}
          </dd>
          {f.note && <span className="-mt-1 text-[11px] text-muted-foreground/70">{f.note}</span>}
        </div>
      ))}
      {/* Fill the last row so the border colour does not show through */}
      <div className="bg-background xl:hidden" />
    </dl>
  );
}
