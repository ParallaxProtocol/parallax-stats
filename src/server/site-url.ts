// The site's public address, for absolute links in the page head.

import { headers } from "next/headers";

/**
 * Absolute links in the page head (the link preview image) need the public
 * address, which only the request knows behind a proxy: SITE_URL when set,
 * else the forwarded host. Read per request, as the address can differ
 * between deployments of the same image.
 */
export async function siteURL(): Promise<URL | undefined> {
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
