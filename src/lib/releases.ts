// The latest parallaxd release, from GitHub. Fetched on the server and
// cached for an hour, so every viewer shares one request: unauthenticated
// GitHub API calls are limited to 60 an hour per address.

import { cacheLife } from "next/cache";

export interface Release {
  /** Tag such as v2.1.1. */
  tag: string;
  url: string;
}

const LATEST = "https://api.github.com/repos/ParallaxProtocol/parallax/releases/latest";

/** fetchLatestRelease throws on failure, so a failed lookup is never cached. */
async function fetchLatestRelease(): Promise<Release> {
  "use cache";
  cacheLife("hours");

  const res = await fetch(LATEST, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "parallax-stats" },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);

  const release = (await res.json()) as { tag_name?: unknown; html_url?: unknown };

  if (typeof release.tag_name !== "string" || !/^v?\d+\.\d+\.\d+/.test(release.tag_name)) {
    throw new Error("GitHub releases: unexpected response");
  }

  return {
    tag: release.tag_name,
    url: typeof release.html_url === "string" ? release.html_url : "https://github.com/ParallaxProtocol/parallax/releases",
  };
}

/** getLatestRelease returns the latest release, or null while GitHub cannot be reached. */
export async function getLatestRelease(): Promise<Release | null> {
  try {
    return await fetchLatestRelease();
  } catch {
    return null;
  }
}
