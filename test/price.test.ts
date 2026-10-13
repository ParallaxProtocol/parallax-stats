import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { log } from "../src/server/log.ts";
import { fetchHistory, fetchMarkets, fetchPrice } from "../src/server/price.ts";

// Refused reads are logged; the tests make plenty on purpose
log.quiet = true;

/** coingecko serves one canned body (or status) for an endpoint and returns the API's base URL. */
async function coingecko(body: unknown, status = 200, path = /^\/simple\/price\?ids=parallax-2&vs_currencies=usd/): Promise<{ api: string; close: () => void }> {
  const server = createServer((req, res) => {
    assert.match(req.url ?? "", path);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test("the price is read from CoinGecko's simple price endpoint", async () => {
  const api = await coingecko({
    "parallax-2": { usd: 0.01599805, btc: 1.80614e-7, usd_24h_vol: 626.95, usd_24h_change: -6.68, last_updated_at: 1_791_779_574 },
  });

  assert.deepEqual(await fetchPrice("parallax-2", api.api), {
    usd: 0.01599805,
    btc: 1.80614e-7,
    volume24h: 626.95,
    change24h: -6.68,
    at: 1_791_779_574_000,
    url: "https://www.coingecko.com/en/coins/parallax-2",
  });
  api.close();
});

test("a missing or broken market figure leaves the price standing", async () => {
  const api = await coingecko({ "parallax-2": { usd: 0.016, btc: "x", usd_24h_vol: -5, usd_24h_change: null, last_updated_at: 1_791_779_574 } });
  const price = await fetchPrice("parallax-2", api.api);

  assert.equal(price?.usd, 0.016);
  assert.equal(price?.btc, null);
  assert.equal(price?.volume24h, null);
  assert.equal(price?.change24h, null);
  api.close();
});

test("unusable answers give no price", async () => {
  for (const [body, status] of [
    [{}, 200],
    [{ "parallax-2": { usd: "0.016" } }, 200],
    [{ "parallax-2": { usd: -1 } }, 200],
    [{ status: { error_code: 429 } }, 429],
  ] as const) {
    const api = await coingecko(body, status);

    assert.equal(await fetchPrice("parallax-2", api.api), null);
    api.close();
  }
});

const TICKERS = /^\/coins\/parallax-2\/tickers\?depth=true/;

/** ticker is one pair as CoinGecko's tickers endpoint gives it. */
function ticker(exchange: string, usd: number, extra: Record<string, unknown> = {}) {
  return {
    base: "LAX",
    target: "USDT",
    market: { name: exchange },
    converted_volume: { usd },
    bid_ask_spread_percentage: 0.5,
    cost_to_move_up_usd: 1.14,
    cost_to_move_down_usd: 1.15,
    last_traded_at: "2026-10-13T02:11:39+00:00",
    trade_url: `https://${exchange.toLowerCase()}.example/LAX_USDT`,
    is_anomaly: false,
    is_stale: false,
    ...extra,
  };
}

test("where the coin trades is read from CoinGecko's tickers, most volume first", async () => {
  const api = await coingecko(
    {
      tickers: [
        ticker("Nonkyc", 26),
        ticker("SafeTrade", 601, { bid_ask_spread_percentage: 40, cost_to_move_up_usd: 0, cost_to_move_down_usd: 0, trade_url: "javascript:alert(1)" }),
        ticker("Stale", 50, { is_stale: true }),
        ticker("Odd", 50, { is_anomaly: true }),
      ],
    },
    200,
    TICKERS,
  );

  assert.deepEqual(await fetchMarkets("parallax-2", api.api), [
    { exchange: "SafeTrade", url: null, pair: "LAX/USDT", volume24h: 601, spread: 40, depthUp: 0, depthDown: 0, lastTrade: Date.parse("2026-10-13T02:11:39Z") },
    {
      exchange: "Nonkyc",
      url: "https://nonkyc.example/LAX_USDT",
      pair: "LAX/USDT",
      volume24h: 26,
      spread: 0.5,
      depthUp: 1.14,
      depthDown: 1.15,
      lastTrade: Date.parse("2026-10-13T02:11:39Z"),
    },
  ]);
  api.close();
});

test("a pair missing its figures keeps what it has, and one without volume is left out", async () => {
  const api = await coingecko(
    { tickers: [ticker("A", 10, { bid_ask_spread_percentage: null, cost_to_move_up_usd: undefined, last_traded_at: "never" }), ticker("B", 5, { converted_volume: {} })] },
    200,
    TICKERS,
  );
  const markets = await fetchMarkets("parallax-2", api.api);

  assert.equal(markets?.length, 1);
  assert.equal(markets?.[0].spread, null);
  assert.equal(markets?.[0].depthUp, null);
  assert.equal(markets?.[0].depthDown, 1.15);
  assert.equal(markets?.[0].lastTrade, null);
  api.close();
});

test("unusable ticker answers give no markets", async () => {
  for (const [body, status] of [
    [{}, 200],
    [{ tickers: "none" }, 200],
    [{ error: "coin not found" }, 404],
  ] as const) {
    const api = await coingecko(body, status, TICKERS);

    assert.equal(await fetchMarkets("parallax-2", api.api), null);
    api.close();
  }
});

const HISTORY = /^\/coins\/parallax-2\/market_chart\?vs_currency=usd&days=7$/;

test("the week's price and volume are read from CoinGecko's market chart, oldest first", async () => {
  const api = await coingecko(
    {
      prices: [
        [2000, 0.015],
        [1000, 0.004],
        [3000, "x"],
      ],
      total_volumes: [
        [1000, 62.9],
        [2000, 627],
        [3000, 500],
      ],
      market_caps: [],
    },
    200,
    HISTORY,
  );

  assert.deepEqual(await fetchHistory("parallax-2", api.api), [
    { at: 1000, usd: 0.004, volume: 62.9 },
    { at: 2000, usd: 0.015, volume: 627 },
    // The broken price is left out, the volume beside it kept
    { at: 3000, usd: null, volume: 500 },
  ]);
  api.close();
});

test("unusable market chart answers give no history", async () => {
  for (const [body, status] of [
    [{}, 200],
    [{ prices: [] }, 200],
    [{ error: "coin not found" }, 404],
  ] as const) {
    const api = await coingecko(body, status, HISTORY);

    assert.equal(await fetchHistory("parallax-2", api.api), null);
    api.close();
  }
});
