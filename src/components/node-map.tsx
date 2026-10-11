"use client";

import { useMemo, useState } from "react";
import { geoEqualEarth } from "d3-geo";
import { gradeBehind, type Grade } from "@/lib/format";
import type { PublicNode } from "@/lib/protocol";
import type { WorldMap } from "@/lib/world";
import { Indicator } from "./indicator";
import { Label, Plate } from "./plate";

const FILL: Record<Grade, string> = {
  good: "fill-good",
  warn: "fill-warn",
  serious: "fill-serious",
  critical: "fill-critical",
  info: "fill-info",
  off: "fill-off",
};

const LEGEND: { grade: Grade; label: string }[] = [
  { grade: "good", label: "At the best block" },
  { grade: "warn", label: "1 behind" },
  { grade: "serious", label: "2–3 behind" },
  { grade: "critical", label: "Further off" },
  { grade: "off", label: "Offline" },
];

export function nodeGrade(node: PublicNode, bestBlock: number): Grade {
  return node.stats.active ? gradeBehind(bestBlock - node.stats.block.number) : "off";
}

/** flag renders a country code as its flag emoji, or a globe for an unknown code. */
function flag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "🌐";

  const base = 0x1f1e6 - "A".charCodeAt(0);
  const upper = code.toUpperCase();

  return String.fromCodePoint(base + upper.charCodeAt(0), base + upper.charCodeAt(1));
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

const TOP_COUNTRIES = 5;

/** Countries lists where located nodes run, as on the main site's network atlas. */
function Countries({ nodes }: { nodes: PublicNode[] }) {
  const counts = new Map<string, number>();

  for (const node of nodes) if (node.geo?.country) counts.set(node.geo.country, (counts.get(node.geo.country) ?? 0) + 1);

  const located = [...counts.values()].reduce((a, b) => a + b, 0);
  const rows = [...counts]
    .sort(([a, x], [b, y]) => y - x || countryName(a).localeCompare(countryName(b)))
    .slice(0, TOP_COUNTRIES);
  const rest = counts.size - rows.length;

  if (rows.length === 0) return null;

  return (
    <div className="border-t border-border pt-3">
      <ol className="flex flex-col gap-1.5">
        {rows.map(([code, count]) => (
          <li key={code} className="grid grid-cols-[minmax(0,1fr)_minmax(3rem,7rem)_1.5rem] items-center gap-3 text-xs">
            <span className="truncate">
              <span aria-hidden className="mr-2">
                {flag(code)}
              </span>
              {countryName(code)}
            </span>
            <span className="relative h-1 bg-border/60">
              <span className="absolute inset-y-0 left-0 bg-brand-mark transition-[width] duration-700 ease-out" style={{ width: `${(count / located) * 100}%` }} />
            </span>
            <span className="text-right tabular-nums">{count}</span>
          </li>
        ))}
      </ol>
      {rest > 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          and {rest} more {rest === 1 ? "country" : "countries"}
        </p>
      )}
    </div>
  );
}

function place(node: PublicNode): string {
  if (!node.geo) return "";

  return [node.geo.city, node.geo.country].filter(Boolean).join(", ");
}

export function NodeMap({
  world,
  nodes,
  bestBlock,
  className = "",
}: {
  world: WorldMap;
  nodes: PublicNode[];
  bestBlock: number;
  /** Placement classes, for the map in a grid. */
  className?: string;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const projection = useMemo(
    () => geoEqualEarth().scale(world.scale).translate(world.translate),
    [world.scale, world.translate],
  );
  const dots = nodes.flatMap((node) => {
    const point = node.geo && projection([node.geo.ll[1], node.geo.ll[0]]);

    return point ? [{ node, x: point[0], y: point[1], grade: nodeGrade(node, bestBlock) }] : [];
  });
  // Draw offline nodes first so live ones sit on top
  dots.sort((a, b) => Number(a.node.stats.active) - Number(b.node.stats.active));

  const focus = dots.find((d) => d.node.id === hovered);

  return (
    <Plate as="figure" className={`flex min-w-0 flex-col gap-4 p-5 ${className}`}>
      <figcaption className="flex items-baseline justify-between gap-3">
        <Label>Where nodes run</Label>
        <span className="truncate text-xs text-muted-foreground" aria-live="polite">
          {focus
            ? `${focus.node.info.name}, ${place(focus.node)}`
            : dots.length > 0
              ? `${dots.length} located of ${nodes.length}`
              : undefined}
        </span>
      </figcaption>

      <div className="relative flex min-h-0 flex-1 items-center">
        {dots.length === 0 && nodes.length > 0 && (
          // An empty map would read as a failed load: dim it and say why
          <p className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 px-6 text-center">
            <span className="text-sm">No node located yet</span>
            <span className="max-w-xs text-xs text-muted-foreground">
              Nodes on a private or local address can&apos;t be placed on the map. Public nodes appear here as they report.
            </span>
          </p>
        )}
        <svg
          viewBox={`0 0 ${world.width} ${world.height}`}
          className={`h-auto max-h-full w-full transition-opacity duration-500 ${dots.length === 0 && nodes.length > 0 ? "opacity-30" : ""}`}
          role="img"
          aria-label={`World map with ${dots.length} node locations`}
          onPointerLeave={() => setHovered(null)}
        >
          {/* Land as a dot matrix, like the main site's network atlas */}
          <defs>
            <pattern id="land-dots" width="6" height="10.4" patternUnits="userSpaceOnUse">
              <circle cx="1.5" cy="1.5" r="1.25" fill="var(--land)" />
              <circle cx="4.5" cy="6.7" r="1.25" fill="var(--land)" />
            </pattern>
          </defs>
          <path d={world.path} fill="url(#land-dots)" />
          {dots.map(({ node, x, y, grade }) => (
            <circle
              key={node.id}
              cx={x}
              cy={y}
              r={node.id === hovered ? 8 : 5.5}
              className={`${FILL[grade]} stroke-surface-elevated`}
              strokeWidth={2}
              onPointerEnter={() => setHovered(node.id)}
            >
              <title>{`${node.info.name}, ${place(node)}`}</title>
            </circle>
          ))}
        </svg>
      </div>

      <Countries nodes={nodes} />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <ul className="flex flex-wrap gap-x-4 gap-y-1">
          {LEGEND.map((item) => (
            <li key={item.grade} className="flex items-center gap-1.5">
              <Indicator grade={item.grade} label="" />
              {item.label}
            </li>
          ))}
        </ul>
        <span>
          Geolocation by{" "}
          <a href="https://ip-api.com" className="underline decoration-border underline-offset-2 hover:text-foreground">
            ip-api.com
          </a>
        </span>
      </div>
    </Plate>
  );
}
