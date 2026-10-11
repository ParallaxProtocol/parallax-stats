import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Newsreader } from "next/font/google";
import "./globals.css";

// The main site's type: Geist for text, Geist Mono for labels and
// figures, Newsreader for page titles.
const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const newsreader = Newsreader({ variable: "--font-serif", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Network Status | Parallax",
  description: "Live status of Parallax nodes: block times, hashrate, difficulty, propagation and sync state.",
  robots: { index: true, follow: true },
  // A fallback for routes without their own; the dashboard page sets the
  // real public address per request (see generateMetadata in page.tsx)
  metadataBase: new URL("http://localhost:3000"),
};

export const viewport: Viewport = {
  themeColor: "#06070d",
};

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
