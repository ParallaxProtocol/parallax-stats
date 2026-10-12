import type { Metadata } from "next";
import { headers } from "next/headers";
import Image from "next/image";
import { Suspense } from "react";
import { connection } from "next/server";
import { Dashboard } from "@/components/dashboard";
import { About } from "@/components/about";
import { SoundToggle } from "@/components/block-toast";
import { ThemeToggle } from "@/components/theme-toggle";
import { getLatestRelease, getReleaseCommits } from "@/lib/releases";
import { getWorld } from "@/lib/world";
import { getPublicNodes, getSnapshot } from "@/server/store";

const title = "Network Status | Parallax";
const description = "Live status of Parallax nodes: block times, hashrate, difficulty, propagation and sync state.";

/**
 * Absolute links in the page head (the link preview image) need the public
 * address, which only the request knows behind a proxy: SITE_URL when set,
 * else the forwarded host. Read per request, as the address can differ
 * between deployments of the same image. The page renders per request
 * anyway (LiveDashboard), so this costs no prerendering.
 */
async function siteURL(): Promise<URL | undefined> {
  if (process.env.SITE_URL) return new URL(process.env.SITE_URL);

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() ?? "https";

  try {
    return host ? new URL(`${proto}://${host}`) : undefined;
  } catch {
    return undefined;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  return {
    title,
    description,
    metadataBase: await siteURL(),
    openGraph: { type: "website", siteName: "Parallax", title, description },
    // X falls back to the Open Graph image
    twitter: { card: "summary_large_image", title, description },
  };
}

export default function Page() {
  return (
    <main className="mx-auto flex max-w-[1800px] flex-col gap-4 px-4 pt-4 pb-10 sm:px-6">
      <header className="flex items-center justify-between gap-3 py-2">
        <h1 className="flex min-w-0 items-center gap-2 whitespace-nowrap sm:gap-3">
          <a href="https://parallaxprotocol.org" className="flex items-center gap-2 sm:gap-3">
            <Image src="/logo.svg" width={200} height={200} alt="" priority className="size-7 w-auto sm:size-8 md:size-10" />
            <span className="font-sans text-base font-semibold sm:text-lg">Parallax</span>
          </a>
          {/* Shown by the Network status card below; still the page's heading for screen readers */}
          <span className="sr-only">Network Status</span>
        </h1>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <ThemeToggle />
          <SoundToggle />
          <About />
        </div>
      </header>

      <Suspense fallback={<Placeholder />}>
        <LiveDashboard />
      </Suspense>
    </main>
  );
}

async function LiveDashboard() {
  // The node list is live state: render it per request, never at build time
  await connection();

  const [world, latestRelease, releaseCommits] = await Promise.all([getWorld(), getLatestRelease(), getReleaseCommits()]);

  return (
    <Dashboard
      initial={getSnapshot()}
      world={world}
      publicNodes={getPublicNodes()}
      latestRelease={latestRelease}
      releaseCommits={releaseCommits}
    />
  );
}

function Placeholder() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the network status">
      <div className="h-52 animate-pulse border border-border bg-surface-elevated" />
      <div className="h-48 animate-pulse border border-border bg-surface-elevated" />
      <div className="h-96 animate-pulse border border-border bg-surface-elevated" />
    </div>
  );
}
