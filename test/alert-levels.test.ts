import assert from "node:assert/strict";
import test from "node:test";
import { thinMarket } from "../src/lib/alert-levels.ts";
import type { Market } from "../src/lib/protocol.ts";

function market(exchange: string, volume24h: number, spread: number | null): Market {
  return { exchange, url: null, pair: "LAX/USDT", volume24h, spread, depthUp: null, depthDown: null, lastTrade: null };
}

test("wide spreads where the volume is make the market thin", () => {
  assert.equal(thinMarket([market("SafeTrade", 601, 40), market("Nonkyc", 26, 0.5)]), "Wide spreads: the price is a rough guide");
});

test("tight spreads with nearly all trading on one exchange make it thin too", () => {
  assert.equal(thinMarket([market("Big", 900, 0.4), market("Small", 100, 0.5)]), "Most trading on Big");
});

test("a spread market with tight spreads is sound, as is one that tells nothing", () => {
  assert.equal(thinMarket([market("A", 500, 0.4), market("B", 400, 1), market("C", 100, null)]), null);
  assert.equal(thinMarket(null), null);
  assert.equal(thinMarket([]), null);
  assert.equal(thinMarket([market("A", 0, 50)]), null);
});
