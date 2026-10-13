"use client";

import { useMemo, useRef, useState, type FocusEvent, type PointerEvent } from "react";
import { countryName, gradeBehind, type Grade } from "@/lib/format";
import { geoMiller } from "@/lib/projection";
import type { PublicNode } from "@/lib/protocol";
import type { WorldMap } from "@/lib/world";
import { Indicator } from "./indicator";
import { Label, Plate } from "./plate";

/** Node counts per country, shaded in steps of the brand teal. */
const STEPS: { min: number; label: string; fill: string }[] = [
  { min: 1, label: "1", fill: "var(--country-1)" },
  { min: 2, label: "2–3", fill: "var(--country-2)" },
  { min: 4, label: "4–9", fill: "var(--country-3)" },
  { min: 10, label: "10+", fill: "var(--country-4)" },
];

const STATUS: { grade: Grade; label: string }[] = [
  { grade: "good", label: "At the best block" },
  { grade: "warn", label: "1 behind" },
  { grade: "serious", label: "2–3 behind" },
  { grade: "critical", label: "Further off" },
  { grade: "off", label: "Offline" },
];

/** Tooltips this near the map's top open below the pointer instead. */
const FLIP_Y = 110;
/** Half a tooltip's width, roughly: how far from the map's sides its centre keeps. */
const HALF_TIP = 96;

export function nodeGrade(node: PublicNode, bestBlock: number): Grade {
  return node.stats.active ? gradeBehind(bestBlock - node.stats.block.number) : "off";
}

function fillFor(count: number): string {
  return STEPS.findLast((s) => count >= s.min)?.fill ?? "var(--country)";
}

/** flag renders a country code as its flag emoji, or a globe for an unknown code. */
function flag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "🌐";

  const base = 0x1f1e6 - "A".charCodeAt(0);
  const upper = code.toUpperCase();

  return String.fromCodePoint(base + upper.charCodeAt(0), base + upper.charCodeAt(1));
}

interface Place {
  count: number;
  grades: Partial<Record<Grade, number>>;
  /** Where the country's first node was placed, for a country too small for the map to outline. */
  ll: [number, number];
}

/** places counts located nodes by country, and by status within each. */
function places(nodes: PublicNode[], bestBlock: number): Map<string, Place> {
  const byCountry = new Map<string, Place>();

  for (const node of nodes) {
    if (!node.geo?.country) continue;

    const place = byCountry.get(node.geo.country) ?? { count: 0, grades: {}, ll: node.geo.ll };
    const grade = nodeGrade(node, bestBlock);

    place.count++;
    place.grades[grade] = (place.grades[grade] ?? 0) + 1;
    byCountry.set(node.geo.country, place);
  }

  return byCountry;
}

function nodesLabel(count: number): string {
  return `${count} ${count === 1 ? "node" : "nodes"}`;
}

/** describe says a country's nodes and their status in a sentence, for screen readers. */
function describe(code: string, place: Place): string {
  const statuses = STATUS.filter((s) => place.grades[s.grade]).map((s) => `${place.grades[s.grade]} ${s.label.toLowerCase()}`);

  return `${countryName(code)}: ${nodesLabel(place.count)}, ${statuses.join(", ")}`;
}

/** Focus is the country pointed at, and where the tooltip opens, if anywhere: the list beside the map only highlights. */
interface Focus {
  code: string;
  at?: { x: number; y: number; width: number };
}

const TOP_COUNTRIES = 5;

/** Countries lists where located nodes run, as on the main site's network atlas. */
function Countries({
  byCountry,
  focus,
  onFocus,
}: {
  byCountry: Map<string, Place>;
  focus: string | null;
  onFocus: (code: string | null) => void;
}) {
  const located = [...byCountry.values()].reduce((sum, p) => sum + p.count, 0);
  const rows = [...byCountry]
    .sort(([a, x], [b, y]) => y.count - x.count || countryName(a).localeCompare(countryName(b)))
    .slice(0, TOP_COUNTRIES);
  const rest = byCountry.size - rows.length;

  if (rows.length === 0) return null;

  return (
    <div className="border-t border-border pt-3">
      <ol className="flex flex-col gap-0.5" onPointerLeave={() => onFocus(null)}>
        {rows.map(([code, place]) => (
          <li
            key={code}
            onPointerEnter={() => onFocus(code)}
            className={`-mx-2 grid grid-cols-[minmax(0,1fr)_minmax(3rem,7rem)_1.5rem] items-center gap-3 rounded-sm px-2 py-1 text-xs transition-colors duration-150 ${
              focus === code ? "bg-foreground/8" : ""
            }`}
          >
            <span className="truncate">
              <span aria-hidden className="mr-2">
                {flag(code)}
              </span>
              {countryName(code)}
            </span>
            <span className="relative h-1 bg-border/60">
              <span
                className="absolute inset-y-0 left-0 bg-brand-mark transition-[width] duration-700 ease-out"
                style={{ width: `${(place.count / located) * 100}%` }}
              />
            </span>
            <span className="text-right tabular-nums">{place.count}</span>
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

/** Legend reads the shading. */
function Legend() {
  return (
    <div className="flex flex-col gap-1 sm:absolute sm:bottom-0 sm:left-0">
      <span>Nodes per country</span>
      <ul className="flex gap-1">
        {STEPS.map((step) => (
          <li key={step.label} className="flex flex-col items-center gap-0.5">
            <span className="h-1.5 w-6 rounded-[2px]" style={{ background: step.fill }} aria-hidden />
            <span className="tabular-nums">{step.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** CountryTip names the country pointed at, with its nodes by status. */
function CountryTip({ code, place, at }: { code: string; place: Place; at: NonNullable<Focus["at"]> }) {
  const below = at.y < FLIP_Y;
  const x = Math.min(Math.max(at.x, HALF_TIP), Math.max(HALF_TIP, at.width - HALF_TIP));

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-20 w-max max-w-56 rounded-sm border border-border bg-surface-elevated px-3 py-2 text-xs shadow-lg"
      style={{ left: x, top: at.y, transform: below ? "translate(-50%, 16px)" : "translate(-50%, calc(-100% - 12px))" }}
    >
      <p className="flex items-baseline justify-between gap-4 font-medium">
        <span>
          <span className="mr-1.5">{flag(code)}</span>
          {countryName(code)}
        </span>
        <span className="text-muted-foreground tabular-nums">{nodesLabel(place.count)}</span>
      </p>
      <ul className="mt-1.5 flex flex-col gap-0.5 text-muted-foreground">
        {STATUS.filter((s) => place.grades[s.grade]).map((s) => (
          <li key={s.grade} className="flex items-center gap-2">
            <Indicator grade={s.grade} label="" />
            <span className="flex-1">{s.label}</span>
            <span className="tabular-nums">{place.grades[s.grade]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
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
  const [focus, setFocus] = useState<Focus | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const projection = useMemo(
    () => geoMiller().scale(world.scale).translate(world.translate),
    [world.scale, world.translate],
  );
  const byCountry = places(nodes, bestBlock);
  const located = [...byCountry.values()].reduce((sum, p) => sum + p.count, 0);
  const outlined = useMemo(() => new Set(world.countries.map((c) => c.code)), [world.countries]);

  // Countries too small for the map to outline, such as Singapore, get a marker where their nodes are
  const markers = [...byCountry].flatMap(([code, place]) => {
    if (outlined.has(code)) return [];

    const point = projection([place.ll[1], place.ll[0]]);

    // To a hundredth of a pixel: the server and the browser work the projection out a few
    // ulps apart, and the page would not match the server's when it takes over
    return point ? [{ code, place, x: Math.round(point[0] * 100) / 100, y: Math.round(point[1] * 100) / 100 }] : [];
  });

  /** at places the tooltip at a pointer, or at the middle of a focused element. */
  function at(clientX: number, clientY: number): Focus["at"] {
    const box = frame.current?.getBoundingClientRect();

    return box && { x: clientX - box.left, y: clientY - box.top, width: box.width };
  }

  // Hover follows a mouse; a tap shows a country until the next tap; keyboard focus shows the focused one
  const handlers = (code: string) => ({
    tabIndex: 0,
    onPointerMove: (e: PointerEvent<SVGElement>) => e.pointerType === "mouse" && setFocus({ code, at: at(e.clientX, e.clientY) }),
    onPointerLeave: (e: PointerEvent<SVGElement>) => e.pointerType === "mouse" && setFocus(null),
    onClick: (e: { clientX: number; clientY: number; stopPropagation: () => void }) => {
      e.stopPropagation();
      setFocus({ code, at: at(e.clientX, e.clientY) });
    },
    onFocus: (e: FocusEvent<SVGElement>) => {
      const box = e.currentTarget.getBoundingClientRect();

      setFocus({ code, at: at(box.left + box.width / 2, box.top + box.height / 2) });
    },
    onBlur: () => setFocus(null),
  });

  const focused = focus && byCountry.get(focus.code);
  const highlight = focus && world.countries.find((c) => c.code === focus.code);

  return (
    <Plate as="figure" className={`flex min-w-0 flex-col gap-4 p-5 ${className}`}>
      <figcaption className="flex items-baseline justify-between gap-3">
        <Label>Node distribution</Label>
        <span className="truncate text-xs text-muted-foreground">
          {located > 0
            ? `${located} located of ${nodes.length}, in ${byCountry.size} ${byCountry.size === 1 ? "country" : "countries"}`
            : undefined}
        </span>
      </figcaption>

      <div ref={frame} className="relative flex min-h-0 flex-1 items-center" onClick={() => setFocus(null)}>
        {located === 0 && nodes.length > 0 && (
          // An empty map would read as a failed load: dim it and say why
          <p className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 px-6 text-center">
            <span className="text-sm">No node located yet</span>
            <span className="max-w-xs text-xs text-muted-foreground">
              Nodes on a private or local address can&apos;t be placed on the map. Public nodes appear here as they report.
            </span>
          </p>
        )}
        <div className="relative w-full">
          <svg
            viewBox={`0 0 ${world.width} ${world.height}`}
            className={`h-auto w-full transition-opacity duration-500 ${located === 0 && nodes.length > 0 ? "opacity-30" : ""}`}
            role="group"
            aria-label={`World map of ${located} located nodes, shaded by nodes per country`}
          >
            {world.countries.map(({ code, d }, i) => {
              const place = byCountry.get(code);
  
              return place ? (
                <path
                  key={i}
                  d={d}
                  fill={fillFor(place.count)}
                  className="cursor-pointer stroke-surface-elevated transition-[fill] duration-500 outline-none"
                  strokeWidth={0.75}
                  vectorEffect="non-scaling-stroke"
                  role="img"
                  aria-label={describe(code, place)}
                  {...handlers(code)}
                />
              ) : (
                <path key={i} d={d} fill="var(--country)" className="stroke-surface-elevated" strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
              );
            })}
            {highlight && (
              // Drawn again on top, so its whole outline shows over its neighbours' borders
              <path
                d={highlight.d}
                fill="none"
                className="pointer-events-none stroke-foreground"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {markers.map(({ code, place, x, y }) => (
              <circle
                key={code}
                cx={x}
                cy={y}
                r={focus?.code === code ? 6.5 : 5}
                fill={fillFor(place.count)}
                className={`cursor-pointer outline-none ${focus?.code === code ? "stroke-foreground" : "stroke-surface-elevated"}`}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                role="img"
                aria-label={describe(code, place)}
                {...handlers(code)}
              />
            ))}
          </svg>
          {/* On wider maps these sit in the empty corners, the South Pacific and south of New Zealand; under the map otherwise */}
          <div className="mt-2 flex items-end justify-between gap-4 text-[0.6875rem] leading-tight text-muted-foreground sm:contents">
            <Legend />
            <p className="text-right sm:absolute sm:right-0 sm:bottom-0">
              Geolocation by{" "}
              <a href="https://ip-api.com" className="underline decoration-border underline-offset-2 hover:text-foreground">
                ip-api.com
              </a>
            </p>
          </div>
        </div>
        {focus?.at && focused && <CountryTip code={focus.code} place={focused} at={focus.at} />}
      </div>

      <Countries byCountry={byCountry} focus={focus?.code ?? null} onFocus={(code) => setFocus(code ? { code } : null)} />
    </Plate>
  );
}
