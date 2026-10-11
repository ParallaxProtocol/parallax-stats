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
