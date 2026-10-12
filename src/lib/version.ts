// Client release versions, as nodes report them in their client string.

/** parseVersion reads the release out of a client string like Parallax/v2.1.0-stable-abc/linux-amd64/go1.27. */
export function parseVersion(client: string): { label: string; parts: number[] | null } {
  const match = /\/v?(\d+)\.(\d+)\.(\d+)/.exec(client);

  return match ? { label: `v${match[1]}.${match[2]}.${match[3]}`, parts: match.slice(1, 4).map(Number) } : { label: "unknown", parts: null };
}

/** compareParts orders versions; an unknown version sorts first. */
export function compareParts(a: number[] | null, b: number[] | null): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0;

  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];

  return 0;
}

/**
 * reportsSyncing tells whether a client's syncing flag can be believed.
 * Releases before v2.1.2 send it reversed, a bug the reporter inherited from
 * go-ethereum's ethstats; an unknown version may be one of them.
 */
export function reportsSyncing(client: string): boolean {
  return compareParts(parseVersion(client).parts, [2, 1, 2]) >= 0;
}

/** The oldest release a verified node may run. */
export const MIN_VERIFIED = { label: "v2.1.2", parts: [2, 1, 2] };

/** canVerify tells whether a client runs a release a verified node may run; an unknown version may not. */
export function canVerify(client: string): boolean {
  const parts = parseVersion(client).parts;

  return parts !== null && compareParts(parts, MIN_VERIFIED.parts) >= 0;
}

const OS: Record<string, string> = { linux: "Linux", darwin: "macOS", windows: "Windows", freebsd: "FreeBSD", openbsd: "OpenBSD", android: "Android" };
const ARCH: Record<string, string> = { amd64: "x64", arm64: "ARM", "386": "x86", arm: "ARM 32-bit", riscv64: "RISC-V" };

/**
 * parsePlatform reads the operating system and processor out of a client
 * string like Parallax/v2.1.0-stable-abc/linux-amd64/go1.27: Linux x64. An
 * unrecognised one keeps its own name; none at all is "unknown".
 */
export function parsePlatform(client: string): string {
  const match = /\/([a-z0-9]+)-([a-z0-9]+)(?:\/|$)/.exec(client.toLowerCase());

  if (!match) return "unknown";

  return `${OS[match[1]] ?? match[1]} ${ARCH[match[2]] ?? match[2]}`;
}
