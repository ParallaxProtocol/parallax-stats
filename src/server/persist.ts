// Saves the server's state to a SQLite file so a restart or redeploy
// keeps the node list, uptimes and block history. The server works from
// memory as before; the hub writes a snapshot every 30 seconds and on
// shutdown, and reads it back once at startup.
//
// The snapshot holds node addresses and the names behind pseudonyms, so
// the file is created readable by the server's user only. It never holds
// secrets.

import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { log } from "./log.ts";
import type { RegistryState } from "./registry.ts";

/** Bumped when the saved shape changes incompatibly; older snapshots are then ignored. */
export const STATE_VERSION = 1;

export interface SavedState {
  version: number;
  /** When the snapshot was written, ms. */
  savedAt: number;
  registry: RegistryState;
}

export interface Store {
  load(): SavedState | null;
  save(state: SavedState): void;
  close(): void;
}

/** openStore opens, or creates, the state file in `dir`. */
export function openStore(dir: string): Store {
  mkdirSync(dir, { recursive: true });

  const file = join(dir, "parallax-stats.db");
  const db = new DatabaseSync(file);

  chmodSync(file, 0o600);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

  const read = db.prepare("SELECT value FROM state WHERE key = 'snapshot'");
  const write = db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES ('snapshot', ?)");

  return {
    load() {
      const row = read.get() as { value: string } | undefined;

      if (!row) return null;

      try {
        const state = JSON.parse(row.value) as SavedState;

        if (state.version !== STATE_VERSION) {
          log.warn("DATA", `Ignoring saved state from version ${state.version}; starting fresh`);
          return null;
        }

        return state;
      } catch {
        log.warn("DATA", "Saved state is unreadable; starting fresh");
        return null;
      }
    },

    save(state) {
      // One statement, so it is atomic: a crash mid-write leaves the last snapshot
      write.run(JSON.stringify(state));
    },

    close() {
      db.close();
    },
  };
}
