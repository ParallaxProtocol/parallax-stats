// The LAX price in US dollars, from CoinGecko's public API, which needs no
// key. The hub polls it every few minutes for everyone, so viewers never
// call CoinGecko themselves and the free rate limit is never near.

import type { Price } from "../lib/protocol.ts";

const TIMEOUT_MS = 5000;
/** Anything outside this is a broken response, not a price. */
const MAX_USD = 1e9;

export const COINGECKO_API = "https://api.coingecko.com/api/v3";

/** fetchPrice returns the coin's price, or null when it cannot be read. */
export async function fetchPrice(id: string, api = COINGECKO_API): Promise<Price | null> {
  try {
    const res = await fetch(`${api}/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_last_updated_at=true`, {
      headers: { Accept: "application/json", "User-Agent": "parallax-stats" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const body = (await res.json()) as Record<string, { usd?: unknown; last_updated_at?: unknown } | undefined>;
    const { usd, last_updated_at: updated } = body[id] ?? {};

    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || usd > MAX_USD) return null;

    return {
      usd,
      at: typeof updated === "number" && Number.isFinite(updated) ? updated * 1000 : Date.now(),
      url: `https://www.coingecko.com/en/coins/${encodeURIComponent(id)}`,
    };
  } catch {
    return null;
  }
}
