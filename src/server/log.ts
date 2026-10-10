// Minimal leveled console logging with colored level tags.

import { styleText } from "node:util";

type Level = "info" | "ok" | "warn" | "error";

const STYLE = {
  info: "cyan",
  ok: "green",
  warn: "yellow",
  error: "red",
} as const;

function write(level: Level, scope: string, args: unknown[]): void {
  const tag = styleText(STYLE[level], level.toUpperCase().padEnd(5));
  const out = level === "error" || level === "warn" ? console.error : console.log;

  out(new Date().toISOString(), tag, styleText("dim", scope.padEnd(4)), ...args);
}

export const log = {
  quiet: false,
  info(scope: string, ...args: unknown[]) {
    if (!log.quiet) write("info", scope, args);
  },
  ok(scope: string, ...args: unknown[]) {
    if (!log.quiet) write("ok", scope, args);
  },
  warn(scope: string, ...args: unknown[]) {
    if (!log.quiet) write("warn", scope, args);
  },
  error(scope: string, ...args: unknown[]) {
    write("error", scope, args);
  },
};
