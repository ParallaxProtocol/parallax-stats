import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fetchGasPrice } from "../src/server/rpc.ts";

/** rpc serves one canned JSON-RPC body (or status) and returns its URL. */
async function rpc(body: unknown, status = 200): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    let raw = "";

    req.on("data", (c) => (raw += c)).on("end", () => {
      assert.equal(JSON.parse(raw).method, "eth_gasPrice");
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test("the gas price is read from eth_gasPrice", async () => {
  const node = await rpc({ jsonrpc: "2.0", id: 1, result: "0x1b5517c33b" });

  assert.equal(await fetchGasPrice(node.url), 117_391_737_659n);
  node.close();
});

test("unusable answers give no price", async () => {
  for (const [body, status] of [
    [{ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope" } }, 200],
    [{ jsonrpc: "2.0", id: 1, result: "lots" }, 200],
    [{ jsonrpc: "2.0", id: 1, result: "0x" + "f".repeat(64) }, 200],
    [{}, 500],
  ] as const) {
    const node = await rpc(body, status);

    assert.equal(await fetchGasPrice(node.url), null, JSON.stringify(body));
    node.close();
  }

  assert.equal(await fetchGasPrice("http://127.0.0.1:1"), null);
});
