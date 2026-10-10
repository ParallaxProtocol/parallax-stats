// The link preview card: what Telegram, Discord and X show when the
// dashboard's address is shared. Rendered per request with live figures,
// over the black hole still parallaxprotocol.org uses for its own cards:
// the best block sits in the hole's dark core, the other figures in the
// dark field left of it.

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

const FOREGROUND = "#f2f0ec";
const MUTED = "rgba(242, 240, 236, 0.55)";
/** Centre of the ring's dark core in the background still. */
const CORE = { x: 875, y: 295 };

export default async function Image() {
  // Live figures: render per request, never at build time
  await connection();

  const [semibold, light, logo, backdrop] = await Promise.all([
    readFile(join(process.cwd(), "assets", "fonts", "Geist-SemiBold.ttf")),
    readFile(join(process.cwd(), "assets", "fonts", "Geist-Light.ttf")),
    readFile(join(process.cwd(), "public", "logo.svg")),
    readFile(join(process.cwd(), "assets", "og", "blackhole-right.jpg")),
  ]);
  const { nodes, charts } = getSnapshot();
  const summary = summarize(nodes);
  const best = summary.bestStats?.block ?? null;
  const difficulty = best ? (miningDifficulty(best) ?? BigInt(best.difficulty)) : null;

  const figures = [
    { label: "Hashrate", value: charts?.avgHashrate ? formatHashrate(charts.avgHashrate) : "—", note: "" },
    {
      label: "Difficulty",
      value: difficulty ? formatDifficulty(difficulty) : "—",
      note: difficulty ? `${formatPoolDifficulty(difficulty)} in pool units` : "",
    },
    {
      label: "Uptime",
      value: summary.total ? `${Math.round(summary.uptime)}%` : "—",
      note: summary.total ? `average of ${summary.total} ${summary.total === 1 ? "node" : "nodes"}` : "",
    },
  ];

  const label = { fontSize: 15, fontWeight: 300, letterSpacing: 4, color: MUTED, textTransform: "uppercase" as const };

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#000", fontFamily: "Geist", color: FOREGROUND }}>
        <img
          src={`data:image/jpeg;base64,${backdrop.toString("base64")}`}
          width={size.width}
          height={size.height}
          alt=""
          style={{ position: "absolute", top: 0, left: 0 }}
        />

        {/* The site's wordmark, where its own cards put it, a little smaller to clear the ring */}
        <div style={{ position: "absolute", top: 48, left: 56, display: "flex", alignItems: "center", gap: 14 }}>
          <img src={`data:image/svg+xml;base64,${logo.toString("base64")}`} width={58} height={58} alt="" />
          <span style={{ fontSize: 40, fontWeight: 600 }}>Parallax</span>
          <span style={{ fontSize: 40, fontWeight: 300, color: MUTED }}>Network Status</span>
        </div>

        {/* Hashrate, difficulty and uptime down the dark field */}
        <div
          style={{
            position: "absolute",
            left: 56,
            bottom: 52,
            width: 500,
            display: "flex",
            flexDirection: "column",
            gap: 26,
          }}
        >
          {figures.map((figure) => (
            <div key={figure.label} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={label}>{figure.label}</span>
              <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
                <span style={{ fontSize: 44, fontWeight: 600, lineHeight: 1, whiteSpace: "nowrap" }}>{figure.value}</span>
                <span style={{ fontSize: 19, fontWeight: 300, color: MUTED, whiteSpace: "nowrap" }}>{figure.note}</span>
              </div>
            </div>
          ))}
        </div>

        {/* The best block in the hole's core */}
        <div
          style={{
            position: "absolute",
            left: CORE.x - 200,
            top: CORE.y - 70,
            width: 400,
            height: 140,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
          }}
        >
          {/* Letter-spacing trails the last glyph: nudge right to centre */}
          <span style={{ ...label, marginLeft: 4 }}>Best block</span>
          <span style={{ fontSize: best && best.number >= 10_000_000 ? 54 : 64, fontWeight: 600, lineHeight: 1 }}>
            {best ? formatInt(best.number) : "—"}
          </span>
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
