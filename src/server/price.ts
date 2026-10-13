// The LAX price in US dollars, from CoinGecko's public API, which needs no
// key. The hub polls it every few minutes for everyone, so viewers never
// call CoinGecko themselves and the free rate limit is never near. Where it
// trades, exchange by exchange, comes from the same API less often.

import type { Market, Price } from "../lib/protocol.ts";

const TIMEOUT_MS = 5000;
/** Anything outside this is a broken response, not a price. */
const MAX_USD = 1e9;

export const COINGECKO_API = "https://api.coingecko.com/api/v3";

/** A share of the price, up or down, beyond which a day's change is a broken response. */
const MAX_CHANGE_PCT = 1e6;

/** fetchPrice returns the coin's price and market, or null when the price cannot be read. */
export async function fetchPrice(id: string, api = COINGECKO_API): Promise<Price | null> {
  try {
    const res = await fetch(`${api}/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd,btc&include_24hr_vol=true&include_24hr_change=true&include_last_updated_at=true`, {
      headers: { Accept: "application/json", "User-Agent": "parallax-stats" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const body = (await res.json()) as Record<string, Record<string, unknown> | undefined>;
    const { usd, btc, usd_24h_vol: volume, usd_24h_change: change, last_updated_at: updated } = body[id] ?? {};

    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || usd > MAX_USD) return null;

    // The rest are extras: one missing or broken leaves the price standing
    const within = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);

    return {
      usd,
      btc: within(btc, Number.MIN_VALUE, MAX_USD),
      volume24h: within(volume, 0, 1e15),
      change24h: within(change, -100, MAX_CHANGE_PCT),
      at: typeof updated === "number" && Number.isFinite(updated) ? updated * 1000 : Date.now(),
      url: `https://www.coingecko.com/en/coins/${encodeURIComponent(id)}`,
    };
  } catch {
    return null;
  }
}

/** Pairs kept, most volume first: enough for any exchange that trades. */
const MAX_MARKETS = 20;

/** fetchMarkets returns the pairs the coin trades in, most volume first, or null when they cannot be read. */
export async function fetchMarkets(id: string, api = COINGECKO_API): Promise<Market[] | null> {
  try {
    // depth=true adds what it takes to move each pair's price 2%
    const res = await fetch(`${api}/coins/${encodeURIComponent(id)}/tickers?depth=true&order=volume_desc`, {
      headers: { Accept: "application/json", "User-Agent": "parallax-stats" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const body = (await res.json()) as { tickers?: unknown };

    if (!Array.isArray(body.tickers)) return null;

    const dollars = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e15 ? v : null);
    const text = (v: unknown) => (typeof v === "string" && v.length > 0 ? v.slice(0, 40) : null);

    return (
      body.tickers
        .flatMap((t: Record<string, unknown>): Market[] => {
          // CoinGecko leaves anomalous and stale pairs out of its own price, and so do we
          if (!t || t.is_anomaly === true || t.is_stale === true) return [];

          const market = t.market as Record<string, unknown> | undefined;
          const exchange = text(market?.name);
          const base = text(t.base);
          const target = text(t.target);
          const volume24h = dollars((t.converted_volume as Record<string, unknown> | undefined)?.usd);

          if (!exchange || !base || !target || volume24h === null) return [];

          const url = typeof t.trade_url === "string" && /^https?:\/\//.test(t.trade_url) ? t.trade_url : null;
          const spread = t.bid_ask_spread_percentage;
          const traded = typeof t.last_traded_at === "string" ? Date.parse(t.last_traded_at) : NaN;

          return [
            {
              exchange,
              url,
              // Some exchanges list the pair under the coin's contract address: show the symbol
              pair: `${base.length > 12 ? "LAX" : base}/${target.length > 12 ? "?" : target}`,
              volume24h,
              spread: typeof spread === "number" && Number.isFinite(spread) && spread >= 0 && spread <= 100 ? spread : null,
              depthUp: dollars(t.cost_to_move_up_usd),
              depthDown: dollars(t.cost_to_move_down_usd),
              lastTrade: Number.isFinite(traded) ? traded : null,
            },
          ];
        })
        .sort((a, b) => b.volume24h - a.volume24h)
        .slice(0, MAX_MARKETS)
    );
  } catch {
    return null;
  }
}
