import { connection } from "next/server";
import { getLatestRelease } from "@/lib/releases";
import { publicStats } from "@/server/public-stats";
import { getSnapshot } from "@/server/store";

/**
 * GET /api/v2/stats: everything the dashboard shows, as JSON, for scripts and
 * other sites. See the README for the fields. Rate limited per address by
 * the hub before it gets here.
 */
export async function GET() {
  await connection();

  return Response.json(publicStats(getSnapshot(), await getLatestRelease()), {
    headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
  });
}
