// Private secrets from a file, on top of WS_SECRET, picked up while the
// server runs: add or remove a line and it takes effect within a second,
// without a restart. One entry per line, in WS_SECRET's form (`secret` or
// `pattern=secret`); blank lines and lines starting with # are ignored.
//
// The file is polled rather than watched for events: polling works the same
// on Docker volumes and with editors that save by replacing the file. Only
// counts are logged, never secrets.

import { readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import { log } from "./log.ts";
import { privateSecret, type PrivateSecret, type Settings } from "./settings.ts";

const POLL_MS = 1000;

/** readSecretsFile reads the entries in `path`; a missing file has none. */
export function readSecretsFile(path: string): PrivateSecret[] {
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(privateSecret);
}

/**
 * watchSecrets keeps `settings.privateSecrets` to WS_SECRET's entries plus
 * the file's, reloading when the file changes and calling `onChange` after,
 * so connections the change revokes can be closed. It returns a function
 * that stops watching.
 */
export function watchSecrets(settings: Settings, path: string, onChange: () => void): () => void {
  // WS_SECRET's entries, read at startup; the file's are added to them
  const fromEnv = settings.privateSecrets;

  function load(): void {
    try {
      const fromFile = readSecretsFile(path).filter((s) => s.secret !== settings.publicSecret);

      settings.privateSecrets = [...fromEnv, ...fromFile];
      log.ok("CFG", `Private secrets: ${fromEnv.length} from WS_SECRET, ${fromFile.length} from ${path}`);

      const weak = fromFile.filter(({ secret }) => secret.length < 16).length;

      if (weak > 0) log.warn("CFG", `${weak} secret(s) in ${path} shorter than 16 characters; use a random one, e.g. \`openssl rand -hex 32\``);

      // Others on the machine should not be able to read the secrets
      try {
        if ((statSync(path).mode & 0o077) !== 0) log.warn("CFG", `${path} is readable by other users; run chmod 600 on it`);
      } catch {
        // No file yet
      }
    } catch (err) {
      // Keep the secrets already loaded rather than revoke everyone over a read error
      log.error("CFG", `Could not read ${path}, keeping the secrets loaded before:`, (err as Error).message);
      return;
    }

    onChange();
  }

  load();
  watchFile(path, { interval: POLL_MS }, (now, before) => {
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size || now.ino !== before.ino) load();
  });

  return () => unwatchFile(path);
}
