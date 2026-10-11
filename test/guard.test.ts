import assert from "node:assert/strict";
import test from "node:test";
import { authenticate, clientIP, RateLimiter, TokenBucket } from "../src/server/guard.ts";
import { cleanBlock, cleanHistory, cleanId, cleanInfo, cleanStats } from "../src/server/sanitize.ts";
import { addressList, inList, loadSettings, miningPools } from "../src/server/settings.ts";

const settings = loadSettings({ WS_SECRET: "private-a|private-b|open", PUBLIC_SECRET: "open", TRUSTED_PROXIES: "10.0.0.1" });

function req(remote: string, xff?: string, extra: Record<string, string> = {}) {
  return { socket: { remoteAddress: remote }, headers: { ...(xff ? { "x-forwarded-for": xff } : {}), ...extra } };
}

test("authenticate maps secrets to trust levels", () => {
  assert.equal(authenticate(settings, "private-a"), "trusted");
  assert.equal(authenticate(settings, "private-b"), "trusted");
  assert.equal(authenticate(settings, "open"), "public");
  assert.equal(authenticate(settings, "wrong"), null);
  assert.equal(authenticate(settings, ""), null);
  assert.equal(authenticate(settings, undefined), null);
  // Near misses and oversized input are refused
  assert.equal(authenticate(settings, "private-a "), null);
  assert.equal(authenticate(settings, "private-"), null);
  assert.equal(authenticate(settings, "x".repeat(5000)), null);
});

test("the public secret never doubles as a private one", () => {
  assert.deepEqual(settings.privateSecrets, ["private-a", "private-b"]);
});

test("clientIP ignores forwarding headers from untrusted peers", () => {
  assert.equal(clientIP(settings, req("1.2.3.4", "9.9.9.9")), "1.2.3.4");
  assert.equal(clientIP(settings, req("::ffff:1.2.3.4")), "1.2.3.4");
});

test("clientIP takes the right-most non-proxy hop behind a trusted proxy", () => {
  assert.equal(clientIP(settings, req("10.0.0.1", "5.5.5.5")), "5.5.5.5");
  // A client-supplied hop left of the real one is ignored
  assert.equal(clientIP(settings, req("10.0.0.1", "6.6.6.6, 5.5.5.5")), "5.5.5.5");
  assert.equal(clientIP(settings, req("10.0.0.1", "5.5.5.5, 10.0.0.1")), "5.5.5.5");
  // Garbage stops the walk and falls back to the proxy
  assert.equal(clientIP(settings, req("10.0.0.1", "not-an-ip")), "10.0.0.1");
});

test("clientIP takes CF-Connecting-IP only from a Cloudflare edge", () => {
  const behind = loadSettings({ PUBLIC_SECRET: "open", TRUSTED_PROXIES: "10.0.0.0/8", BEHIND_CLOUDFLARE: "true" });
  const visitor = { "cf-connecting-ip": "5.5.5.5" };

  // Traefik replacing X-Forwarded-For with the edge, or appending to Cloudflare's
  assert.equal(clientIP(behind, req("10.0.1.2", "172.68.10.1", visitor)), "5.5.5.5");
  assert.equal(clientIP(behind, req("10.0.1.2", "6.6.6.6, 172.68.10.1", visitor)), "5.5.5.5");
  assert.equal(clientIP(behind, req("10.0.1.2", "2606:4700:3030::1", { "cf-connecting-ip": "2a02:4780::1" })), "2a02:4780::1");
  // A client reaching the server directly cannot claim an address
  assert.equal(clientIP(behind, req("10.0.1.2", "9.9.9.9", visitor)), "9.9.9.9");
  assert.equal(clientIP(behind, req("9.9.9.9", undefined, visitor)), "9.9.9.9");
  // A broken header leaves the edge address
  assert.equal(clientIP(behind, req("10.0.1.2", "172.68.10.1", { "cf-connecting-ip": "nope" })), "172.68.10.1");
  // Off by default
  assert.equal(clientIP(settings, req("172.68.10.1", undefined, visitor)), "172.68.10.1");
});

test("RateLimiter allows a fixed number per minute per key", () => {
  const limiter = new RateLimiter(2);

  assert.ok(limiter.allow("a", 1000));
  assert.ok(limiter.allow("a", 1001));
  assert.ok(!limiter.allow("a", 1002));
  assert.ok(limiter.allow("b", 1002));
  assert.ok(limiter.allow("a", 1000 + 60_000 + 1));
});

test("TokenBucket refills over time", () => {
  const bucket = new TokenBucket(1, 2, 0);

  assert.ok(bucket.take(0));
  assert.ok(bucket.take(0));
  assert.ok(!bucket.take(0));
  assert.ok(bucket.take(1000));
});

test("cleanId accepts plain names and rejects the rest", () => {
  assert.equal(cleanId("my-node 1"), "my-node 1");
  assert.equal(cleanId("<script>"), null);
  assert.equal(cleanId("a:b"), null);
  assert.equal(cleanId(""), null);
  assert.equal(cleanId("x".repeat(65)), "x".repeat(64));
  assert.equal(cleanId({}), null);
});

test("cleanInfo strips control characters and unknown fields", () => {
  const info = cleanInfo({ name: "a‮b\u0000c", node: "Parallax/v2.1.0", extra: "x", port: 99999 });

  assert.equal(info?.name, "abc");
  assert.equal(info?.port, 65535);
  assert.equal("extra" in info!, false);
  assert.equal(cleanInfo("nope"), null);
});

const HASH = "0x" + "ab".repeat(32);

test("cleanBlock compacts transactions and validates fields", () => {
  const block = cleanBlock({
    number: 42,
    hash: HASH,
    difficulty: "2984345036800",
    totalDifficulty: 123,
    transactions: [{ hash: HASH }, { hash: HASH }],
    uncles: [],
    miner: "not an address",
  });

  assert.equal(block?.number, 42);
  assert.equal(block?.txCount, 2);
  assert.equal(block?.totalDifficulty, "123");
  assert.equal(block?.miner, "0x" + "0".repeat(40));
  assert.equal("transactions" in block!, false);

  assert.equal(cleanBlock({ number: 1, hash: "nope", difficulty: "1", totalDifficulty: "1" }), null);
  assert.equal(cleanBlock({ number: -1, hash: HASH, difficulty: "1", totalDifficulty: "1" }), null);
  assert.equal(cleanBlock({ number: 1, hash: HASH, difficulty: "1e9", totalDifficulty: "1" }), null);
  assert.equal(cleanBlock({ number: 1, hash: HASH, difficulty: 1e30, totalDifficulty: "1" })?.difficulty, "1000000000000000019884624838656");
});

test("cleanHistory keeps at most 50 valid blocks", () => {
  const blocks: unknown[] = [];

  for (let i = 1; i <= 80; i++) blocks.push({ number: i, hash: HASH, difficulty: "1", totalDifficulty: String(i) });

  blocks.push({ bogus: true });

  assert.equal(cleanHistory(blocks)?.length, 50);
  assert.equal(cleanHistory("x"), null);
});

test("cleanStats clamps numbers and coerces flags", () => {
  const stats = cleanStats({ peers: -5, peerLatency: "213", syncing: "yes", mining: true, hashrate: "NaN" });

  assert.equal(stats?.peers, 0);
  assert.equal(stats?.peerLatency, 213);
  assert.equal(stats?.syncing, false);
  assert.equal(stats?.mining, true);
  assert.equal(stats?.hashrate, 0);
});

test("trusted proxies and banned addresses accept CIDR ranges", () => {
  // Coolify's Traefik reaches the app from a Docker network address that changes between deploys
  const behindTraefik = loadSettings({ PUBLIC_SECRET: "open", TRUSTED_PROXIES: "10.0.0.0/8, fd00::/8" });

  assert.equal(clientIP(behindTraefik, req("10.0.1.7", "203.0.113.9")), "203.0.113.9");
  assert.equal(clientIP(behindTraefik, req("::ffff:10.0.1.7", "203.0.113.9")), "203.0.113.9");
  assert.equal(clientIP(behindTraefik, req("fd12::3", "203.0.113.9")), "203.0.113.9");
  // A client inside the range adding its own hop is skipped past
  assert.equal(clientIP(behindTraefik, req("10.0.1.7", "198.51.100.1, 10.0.1.9")), "198.51.100.1");
  // Peers outside the range cannot forward
  assert.equal(clientIP(behindTraefik, req("11.0.0.1", "203.0.113.9")), "11.0.0.1");

  const banned = addressList(["198.51.100.0/24", "2001:db8::1", "not-an-address", "1.2.3.4/99"]);

  assert.equal(inList(banned, "198.51.100.77"), true);
  assert.equal(inList(banned, "198.51.101.1"), false);
  assert.equal(inList(banned, "2001:db8::1"), true);
  assert.equal(inList(banned, "garbage"), false);
});

test("mining pools are read with optional websites", () => {
  const a = "0x" + "a".repeat(40);
  const b = "0x" + "B".repeat(40);
  const pools = miningPools(`Pool One=https://one.example/?ref=x,${a}| Pool Two = ${b} |Nameless|=${a}|Bad=javascript:alert(1),0x12`);

  assert.deepEqual(pools.get(a), { name: "Pool One", url: "https://one.example/?ref=x" });
  assert.deepEqual(pools.get(b.toLowerCase()), { name: "Pool Two", url: null });
  assert.equal(pools.size, 2);
});
