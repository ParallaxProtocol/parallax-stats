// The link preview card: what Telegram, Discord and X show when the
// dashboard's address is shared. The wordmark over a tilted, blurred view
// of the dashboard (see assets/og/README.md). It has no live figures, so
// it is rendered once at build time.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Parallax Network Stats";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const FOREGROUND = "#f2f0ec";
const SUBTITLE = "rgba(242, 240, 236, 0.96)";

export default async function Image() {
  const [semibold, logo, backdrop] = await Promise.all([
    readFile(join(process.cwd(), "assets", "fonts", "Geist-SemiBold.ttf")),
    readFile(join(process.cwd(), "public", "logo.svg")),
    readFile(join(process.cwd(), "assets", "og", "dashboard-tilted.jpg")),
  ]);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#05060b", fontFamily: "Geist", color: FOREGROUND }}>
        <img
          src={`data:image/jpeg;base64,${backdrop.toString("base64")}`}
          width={size.width}
          height={size.height}
          alt=""
          style={{ position: "absolute", top: 0, left: 0 }}
        />
        {/* Shade the middle so the wordmark reads over the dashboard */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            backgroundImage: "radial-gradient(ellipse 60% 55% at 50% 50%, rgba(5,6,11,0.85) 0%, rgba(5,6,11,0.55) 55%, rgba(5,6,11,0.15) 100%)",
          }}
        />

        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <img src={`data:image/svg+xml;base64,${logo.toString("base64")}`} width={60} height={60} alt="" />
            <span style={{ fontSize: 60, fontWeight: 600, lineHeight: 1, letterSpacing: -1 }}>Parallax</span>
          </div>
          <div
            style={{
              width: 300,
              height: 2,
              marginTop: 30,
              marginBottom: 34,
              borderRadius: 1,
              backgroundImage: "linear-gradient(90deg, rgba(242,240,236,0), rgba(242,240,236,0.35) 20%, rgba(242,240,236,0.35) 80%, rgba(242,240,236,0))",
            }}
          />
          <span style={{ fontSize: 100, fontWeight: 600, lineHeight: 1, letterSpacing: -2, color: SUBTITLE }}>Network Stats</span>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: "Geist", data: semibold, weight: 600, style: "normal" }],
    },
  );
}
