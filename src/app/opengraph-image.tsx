// The link preview card: what Telegram, Discord and X show when the
// dashboard's address is shared. Rendered per request with live figures,
// in the main site's style.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { connection } from "next/server";
import { miningDifficulty } from "@/lib/asert";
import { summarize } from "@/lib/derive";
import { formatDifficulty, formatHashrate, formatInt, formatPoolDifficulty } from "@/lib/format";
import { getSnapshot } from "@/server/store";

export const alt = "Parallax network status: best block, hashrate, difficulty and uptime";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  // Live figures: render per request, never at build time
  await connection();

  const [semibold, light, logo] = await Promise.all([
    readFile(join(process.cwd(), "assets", "fonts", "Geist-SemiBold.ttf")),
    readFile(join(process.cwd(), "assets", "fonts", "Geist-Light.ttf")),
    readFile(join(process.cwd(), "public", "logo.svg")),
  ]);
  const { nodes, charts } = getSnapshot();
  const summary = summarize(nodes);
  const best = summary.bestStats?.block ?? null;
  const difficulty = best ? (miningDifficulty(best) ?? BigInt(best.difficulty)) : null;

  const stats = [
    { label: "Best block", value: best ? `#${formatInt(best.number)}` : "—", note: "" },
    { label: "Hashrate", value: charts?.avgHashrate ? formatHashrate(charts.avgHashrate) : "—", note: "" },
    {
      label: "Difficulty",
      value: difficulty ? formatDifficulty(difficulty) : "—",
      note: difficulty ? `${formatPoolDifficulty(difficulty)} in pool units` : "",
    },
    { label: "Uptime", value: summary.total ? `${Math.round(summary.uptime)}%` : "—", note: "average across nodes" },
  ];

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px 72px",
          background: "#06070d",
          color: "#eae7e4",
          fontFamily: "Geist",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <img src={`data:image/svg+xml;base64,${logo.toString("base64")}`} width={64} height={64} alt="" />
            <span style={{ fontSize: 40, fontWeight: 600 }}>Parallax</span>
            <span style={{ fontSize: 40, fontWeight: 300, color: "#8a8d94" }}>Network Status</span>
          </div>
          <div style={{ width: 72, height: 4, backgroundImage: "linear-gradient(90deg, #00ff80, #0080ff)" }} />
        </div>

        <div style={{ display: "flex", border: "1px solid rgba(255,255,255,0.08)" }}>
          {stats.map((stat, i) => (
            <div
              key={stat.label}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: 10,
                padding: "32px 28px",
                borderLeft: i === 0 ? "none" : "1px solid rgba(255,255,255,0.08)",
              }}
            >
              <span
                style={{ fontSize: 20, fontWeight: 300, letterSpacing: 3, textTransform: "uppercase", color: "#8a8d94", whiteSpace: "nowrap" }}
              >
                {stat.label}
              </span>
              <span style={{ fontSize: 46, fontWeight: 600, whiteSpace: "nowrap" }}>{stat.value}</span>
              <span style={{ fontSize: 20, fontWeight: 300, color: "#8a8d94", minHeight: 26 }}>{stat.note}</span>
            </div>
          ))}
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Geist", data: semibold, weight: 600, style: "normal" },
        { name: "Geist", data: light, weight: 300, style: "normal" },
      ],
      headers: { "Cache-Control": "public, max-age=300" },
    },
  );
}
