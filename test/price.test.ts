import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fetchPrice } from "../src/server/price.ts";

/** coingecko serves one canned body (or status) for the simple price endpoint and returns the API's base URL. */
async function coingecko(body: unknown, status = 200): Promise<{ api: string; close: () => void }> {
  const server = createServer((req, res) => {
    assert.match(req.url ?? "", /^\/simple\/price\?ids=parallax-2&vs_currencies=usd/);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test("the price is read from CoinGecko's simple price endpoint", async () => {
  const api = await coingecko({ "parallax-2": { usd: 0.01599805, last_updated_at: 1_791_779_574 } });

  assert.deepEqual(await fetchPrice("parallax-2", api.api), {
    usd: 0.01599805,
    at: 1_791_779_574_000,
    url: "https://www.coingecko.com/en/coins/parallax-2",
  });
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
