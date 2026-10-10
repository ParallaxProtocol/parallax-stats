import assert from "node:assert/strict";
import test from "node:test";
import { createGeoLookup } from "../src/server/geo.ts";

function fakeFetch(answer: (ips: string[]) => unknown[], calls: string[][]): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const ips = JSON.parse(init.body as string) as string[];

    calls.push(ips);
    return new Response(JSON.stringify(answer(ips)), { headers: { "x-rl": "14", "x-ttl": "60" } });
  }) as typeof fetch;
}

const boston = (ip: string) => ({ status: "success", query: ip, countryCode: "US", city: "Boston", lat: 42.36, lon: -71.06 });

test("lookups are batched into one request and cached", async () => {
  const calls: string[][] = [];
  const lookup = createGeoLookup(fakeFetch((ips) => ips.map(boston), calls));
  const a = lookup("168.231.74.175");
  const b = lookup("2a02:4780:2d:2d36::1");

  assert.ok(a instanceof Promise && b instanceof Promise);
  assert.deepEqual(await a, { country: "US", city: "Boston", ll: [42.36, -71.06] });
  assert.deepEqual((await b)?.country, "US");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["168.231.74.175", "2a02:4780:2d:2d36::1"]);

  // Cached: answered right away, no request
  assert.deepEqual(lookup("168.231.74.175"), { country: "US", city: "Boston", ll: [42.36, -71.06] });
  assert.equal(calls.length, 1);
});

test("private addresses are never looked up", () => {
  const calls: string[][] = [];
  const lookup = createGeoLookup(fakeFetch(() => [], calls));

  for (const ip of ["10.0.0.1", "192.168.1.5", "127.0.0.1", "::1", "fd00::1", "100.64.1.1", "not-an-ip"]) {
    assert.equal(lookup(ip), null);
  }
  assert.equal(calls.length, 0);
});

test("failures and unusable answers give no location", async () => {
  const lookup = createGeoLookup(fakeFetch((ips) => ips.map((query) => ({ status: "fail", query })), []));

  assert.equal(await lookup("8.8.8.8"), null);

  const odd = createGeoLookup(fakeFetch((ips) => ips.map((query) => ({ status: "success", query, lat: 500, lon: 0 })), []));

  assert.equal(await odd("8.8.8.8"), null);

  const down = createGeoLookup((async () => {
    throw new Error("unreachable");
  }) as typeof fetch);

  assert.equal(await down("8.8.8.8"), null);
});
