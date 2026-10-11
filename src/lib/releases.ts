// parallaxd releases, from GitHub: the latest one, and the commit each
// release tag points at. Fetched on the server and cached, so every viewer
// shares the requests: unauthenticated GitHub API calls are limited to 60
// an hour per address, and refreshing both every 10 minutes uses 12 of
// them while a new release shows up soon after it is published.

import { cacheLife } from "next/cache";

export interface Release {
  /** Tag such as v2.1.1. */
  tag: string;
  url: string;
}

const LATEST = "https://api.github.com/repos/ParallaxProtocol/parallax/releases/latest";
const TAGS = "https://api.github.com/repos/ParallaxProtocol/parallax/tags?per_page=100";

/** fetchLatestRelease throws on failure, so a failed lookup is never cached. */
async function fetchLatestRelease(): Promise<Release> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 3600 });

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

/** ReleaseCommits maps a release tag such as v2.1.2 to the full hash of the commit it points at. */
export type ReleaseCommits = Record<string, string>;

/** fetchReleaseCommits throws on failure, so a failed lookup is never cached. */
async function fetchReleaseCommits(): Promise<ReleaseCommits> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 600, expire: 3600 });

  const res = await fetch(TAGS, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "parallax-stats" },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) throw new Error(`GitHub tags: HTTP ${res.status}`);

  const tags = (await res.json()) as { name?: unknown; commit?: { sha?: unknown } }[];

  if (!Array.isArray(tags)) throw new Error("GitHub tags: unexpected response");

  const commits: ReleaseCommits = {};

  // Only plain release tags: release candidates and other tags are not stable builds
  for (const tag of tags) {
    if (typeof tag.name === "string" && /^v\d+\.\d+\.\d+$/.test(tag.name) && typeof tag.commit?.sha === "string") {
      commits[tag.name] = tag.commit.sha.toLowerCase();
    }
  }

  return commits;
}

/** getReleaseCommits returns each release's commit, or none while GitHub cannot be reached. */
export async function getReleaseCommits(): Promise<ReleaseCommits> {
  try {
    return await fetchReleaseCommits();
  } catch {
    return {};
  }
}
