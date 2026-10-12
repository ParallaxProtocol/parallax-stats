import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import { connection } from "next/server";
import { Suspense } from "react";
import { siteURL } from "@/server/site-url";
import "./globals.css";

// The main site's type: Geist for text, Geist Mono for labels and
// figures, Newsreader for page titles.
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const newsreader = Newsreader({ variable: "--font-serif", subsets: ["latin"], display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: "Network Status | Parallax",
    description: "Live status of Parallax nodes: block times, hashrate, difficulty, propagation and sync state.",
    robots: { index: true, follow: true },
    // Every route's absolute links (the link preview image) use the public
    // address, read per request (see siteURL)
    metadataBase: await siteURL(),
  };
}

export const viewport: Viewport = {
  themeColor: "#06070d",
};

// Renders nothing, but makes every route render per request, which the
// metadata above needs to read the request's address. Only the 404 page
// changes: the dashboard already renders per request.
async function PerRequest() {
  await connection();
  return null;
}

// Applies a saved light theme before first paint, so it never flashes dark
const themeScript = `try{if(localStorage.getItem("theme")==="light")document.documentElement.dataset.theme="light"}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${newsreader.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh antialiased">
        {children}
        <Suspense>
          <PerRequest />
        </Suspense>
        {/* The site-wide grain texture. Left out on touch screens: a full-screen
            SVG filter is redrawn whenever a phone's address bar resizes the
            viewport, which made scrolling lag, and at 2% it is barely seen */}
        <svg
          className="pointer-events-none fixed inset-0 z-[100] h-full w-full opacity-[0.02] light:opacity-[0.015] [@media(pointer:coarse)]:hidden"
          aria-hidden="true"
        >
          <filter id="grain">
            <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
          </filter>
          <rect width="100%" height="100%" filter="url(#grain)" />
        </svg>
      </body>
    </html>
  );
}
