import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { createHub } from "../src/server/hub.ts";
import { log } from "../src/server/log.ts";
import { readSecretsFile, watchSecrets } from "../src/server/secrets.ts";
import { loadSettings } from "../src/server/settings.ts";

log.quiet = true;

async function waitFor(check: () => boolean, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms;

  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(50);
  }
}

function withDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "parallax-secrets-"));

  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("the secrets file has one entry per line, comments and blanks ignored", () =>
  withDir((dir) => {
    const path = join(dir, "secrets");

    assert.deepEqual(readSecretsFile(path), []);

    writeFileSync(path, "# pools\nrplant-*=rplant-secret-1\n\n  exchange-secret-2  \n");

    assert.deepEqual(
      readSecretsFile(path).map((s) => [s.pattern, s.secret]),
      [
        ["rplant-*", "rplant-secret-1"],
        [null, "exchange-secret-2"],
      ],
    );
  }));

test("secrets added to or removed from the file apply while running, and revoke connected nodes", () =>
  withDir(async (dir) => {
    const path = join(dir, "secrets");
    const settings = loadSettings({ WS_SECRET: "env-secret-1234567", PUBLIC_SECRET: "open" });

    writeFileSync(path, "pool-*=pool-secret-7f3a91\n", { mode: 0o600 });

    const hub = createHub(settings);
    const stop = watchSecrets(settings, path, () => hub.recheckSecrets());
    const server = createServer((req, res) => res.end());

    server.on("upgrade", (req, socket, head) => {
      if (!hub.handleUpgrade(req, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      // WS_SECRET's entry and the file's both count
      assert.deepEqual(
        settings.privateSecrets.map((s) => s.secret),
        ["env-secret-1234567", "pool-secret-7f3a91"],
      );

      // A node logs in with the file's secret
      const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api`);
      const messages: string[] = [];
      let closed = false;

      ws.on("message", (raw) => messages.push(raw.toString()));
      ws.on("close", () => (closed = true));
      await new Promise((resolve) => ws.on("open", resolve));
      ws.send(JSON.stringify({ emit: ["hello", { id: "pool-eu", secret: "pool-secret-7f3a91", info: { name: "pool-eu", node: "Parallax/v2.1.2" } }] }));
      await waitFor(() => messages.some((m) => m.includes('"ready"')));

      // A secret added to the file is picked up without a restart
      writeFileSync(path, "pool-*=pool-secret-7f3a91\nexchange-x=exchange-secret-9c2\n");
      await waitFor(() => settings.privateSecrets.some((s) => s.secret === "exchange-secret-9c2"));
      assert.equal(closed, false);

      // Removing the pool's secret disconnects its node at once
      writeFileSync(path, "exchange-x=exchange-secret-9c2\n");
      await waitFor(() => closed);
      assert.deepEqual(
        settings.privateSecrets.map((s) => s.secret),
        ["env-secret-1234567", "exchange-secret-9c2"],
      );
    } finally {
      stop();
      hub.close();
      server.close();
    }
  }));
