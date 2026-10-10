import { connection } from "next/server";
import { summarize } from "@/lib/derive";
import { getSnapshot } from "@/server/store";

/** GET /api/v1/stats: a JSON summary of the network, for scripts and other sites. */
export async function GET() {
  await connection();

  const { serverTime, nodes, charts } = getSnapshot();
  const summary = summarize(nodes);

  return Response.json(
    {
      serverTime,
      bestBlock: summary.bestBlock,
      lastBlockArrived: summary.bestStats?.block.arrived ?? null,
      nodes: { total: summary.total, active: summary.active, synced: summary.synced },
      peerLatency: summary.peerLatency || null,
      avgBlockTime: charts?.avgBlocktime ?? null,
      avgHashrate: charts?.avgHashrate ?? null,
      difficulty: summary.bestStats?.block.difficulty ?? null,
    },
    { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } },
  );
}
