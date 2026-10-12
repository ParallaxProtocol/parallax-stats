"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent } from "react";
import { formatMs } from "@/lib/format";
import type { Incident, IncidentKind, IncidentLog } from "@/lib/protocol";
import { Alerts, type Alert } from "./alerts";
import { Switch } from "./charts";
import { useServerNow } from "./live/provider";
import { Label, Plate } from "./plate";
import { usePersistent } from "./use-persistent";

/** Each kind of incident, in the timeline's order. */
const KINDS: { kind: IncidentKind; label: string }[] = [
  { kind: "majority", label: "Mining majority" },
  { kind: "spread", label: "Slow propagation" },
  { kind: "split", label: "Chain split" },
  { kind: "stall", label: "Possible stall" },
  { kind: "reorg", label: "Deep reorg" },
];
const LABEL = Object.fromEntries(KINDS.map(({ kind, label }) => [kind, label])) as Record<IncidentKind, string>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Range = "day" | "week" | "month";

/** The spans the timeline can show, and how its axis is marked for each. */
const RANGES: Record<Range, { span: number; label: string; heading: string }> = {
  day: { span: DAY, label: "24 h", heading: "Last 24 hours" },
  week: { span: 7 * DAY, label: "7 days", heading: "Last 7 days" },
  month: { span: 30 * DAY, label: "30 days", heading: "Last 30 days" },
};

/** Incidents listed before "show all". */
const SHOWN = 8;
/** A majority is judged over a week, so rebuilt records of it begin a week after the oldest saved block. */
const WEEK_MS = 7 * DAY;
/** The narrowest an incident is drawn, in pixels, so a few minutes stay visible over 30 days. */
const MIN_BAR_PX = 3;

const FILL: Record<Incident["level"], string> = { critical: "bg-critical", warn: "bg-warn", info: "bg-info" };
const LEVEL: Record<Incident["level"], string> = { critical: "critical", warn: "warning", info: "notice" };
/** Hatching for time before recording began: neither clear nor troubled, just unknown. */
const UNRECORDED = "repeating-linear-gradient(135deg, var(--border) 0 1px, transparent 1px 5px)";

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
/** Short, for the axis: 3 PM, or 15 where the day runs to 24 hours. */
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

const subscribeNothing = () => () => {};

/** overlaps reports whether an incident touches the span from `from` to `to`; one still going lasts until now. */
function overlaps(incident: Incident, from: number, to: number, now: number): boolean {
  return incident.start <= to && (incident.end ?? now) >= from;
}

/** at renders a moment as a date and time: Oct 12, 14:20. */
function at(ms: number): string {
  return `${dayFormat.format(ms)}, ${timeFormat.format(ms)}`;
}

/** when renders an incident's time: a moment's date and time, or a span's start and end. */
function when(incident: Incident): string {
  const start = `${incident.startKnown ? "" : "before "}${at(incident.start)}`;

  if (incident.end === incident.start) return start;
  if (incident.end === null) return `${start} – ongoing`;

  // The same day needs saying once
  return dayFormat.format(incident.end) === dayFormat.format(incident.start)
    ? `${start} – ${timeFormat.format(incident.end)}`
    : `${start} – ${at(incident.end)}`;
}

/**
 * ticks marks the axis in the viewer's own time: every 3 hours over a day,
 * each midnight over a week, and each midnight over a month, labelled
 * weekly. Labelled ticks carry their text; the rest only draw a line.
 * Every other label is minor: phones have room for half of them.
 */
function ticks(range: Range, from: number, to: number): { at: number; label: string | null; minor: boolean }[] {
  const out: { at: number; label: string | null; minor: boolean }[] = [];
  const t = new Date(from);

  if (range === "day") {
    t.setMinutes(0, 0, 0);
    t.setHours(Math.ceil((t.getHours() + (from > t.getTime() ? 1 : 0)) / 3) * 3);

    for (let i = 0; t.getTime() < to; t.setHours(t.getHours() + 3), i++) out.push({ at: t.getTime(), label: hourFormat.format(t), minor: i % 2 === 1 });

    return out;
  }

  t.setHours(24, 0, 0, 0);

  for (let i = 0; t.getTime() < to; t.setDate(t.getDate() + 1), i++) {
    out.push({
      at: t.getTime(),
      label: range === "week" ? weekdayFormat.format(t) : i % 7 === 0 ? dayFormat.format(t) : null,
      minor: range === "week" ? i % 2 === 1 : false,
    });
  }

  return out;
}

/**
 * NetworkStatus is the first thing on the page: what needs attention now,
 * as the alerts' banners, or that nothing does, and below it what went
 * wrong before.
 */
export function NetworkStatus({ log, alerts }: { log: IncidentLog | null; alerts: Alert[] }) {
  return (
    <Plate as="section" id="incidents" aria-labelledby="status-title" className="flex min-w-0 scroll-mt-16 flex-col gap-5 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Label as="h2">
          <span id="status-title">Network status</span>
        </Label>
        <span className="text-xs text-muted-foreground">
          {alerts.length === 0 ? "All clear" : `${alerts.length} ${alerts.length === 1 ? "alert" : "alerts"} now`}
        </span>
      </div>
      {alerts.length > 0 ? (
        <Alerts alerts={alerts} />
      ) : (
        <p className="flex items-center gap-2.5 text-sm">
          <span aria-hidden className="size-2 rounded-full bg-good" />
          All clear: nothing needs attention right now.
        </p>
      )}
      <div className="border-t border-border pt-5">
        <Timeline log={log} />
      </div>
    </Plate>
  );
}

/**
 * Timeline shows what went wrong and when: a row per kind, each incident a
 * bar from its exact start to its end, over the last 24 hours, 7 days or 30
 * days, and the incidents themselves, newest first. Hovering or dragging
 * along a row says what was happening then; choosing an incident marks it.
 */
function Timeline({ log }: { log: IncidentLog | null }) {
  // Days and times are the viewer's own, unknown to the server render
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);

  if (log === null) {
    return <p className="text-sm text-muted-foreground">This server does not record incidents yet.</p>;
  }

  if (!hydrated) return <div className="min-h-56" />;

  return <TimelineBody log={log} />;
}

function TimelineBody({ log }: { log: IncidentLog }) {
  const now = useServerNow();
  const [range, setRange] = usePersistent<Range>("incident-range", "day");
  const [chosen, setChosen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  // Hovering moves the cursor and rewrites the caption on the page directly, in the pointer's own
  // event: going through a render would put the cursor a frame or two behind a fast drag
  const area = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const caption = useRef<HTMLSpanElement>(null);
  // The row under the pointer, measured once as the pointer arrives: measuring on every move would make
  // the browser lay the page out again before it could draw
  const measured = useRef<{ track: HTMLDivElement; left: number; width: number; x: number; y: number } | null>(null);

  const { span, heading } = RANGES[range in RANGES ? range : "day"];
  const from = now - span;
  const recent = useMemo(() => log.list.filter((incident) => overlaps(incident, from, now, now)), [log, from, now]);
  const picked = recent.find((incident) => incident.id === chosen) ?? null;
  // Since when each kind is on record: stalls and the majority were rebuilt from saved blocks
  const recordedFrom = useCallback(
    (kind: IncidentKind) =>
      log.rebuiltFrom === null ? log.since : kind === "stall" ? log.rebuiltFrom : kind === "majority" ? Math.min(log.since, log.rebuiltFrom + WEEK_MS) : log.since,
    [log],
  );

  // The figures a frame's drawing needs, as of the latest render, so drawing does not wait on one
  const latest = useRef({ from, span, recent, now, recordedFrom });

  useLayoutEffect(() => {
    latest.current = { from, span, recent, now, recordedFrom };
  });

  // The pointer's latest place on a row, drawn at most once a frame, just before the browser paints:
  // Firefox handles a stream of moves before painting, so drawing on each one held the cursor still
  // until the pointer stopped
  const pointer = useRef<{ kind: IncidentKind; clientX: number } | null>(null);
  const frame = useRef(0);

  const draw = useCallback(() => {
    frame.current = 0;

    const at_ = pointer.current;
    const track = measured.current;

    if (!at_ || !track) return;

    const { from, span, recent, now, recordedFrom } = latest.current;
    const fraction = Math.min(1, Math.max(0, (at_.clientX - track.left) / track.width));
    const moment = from + fraction * span;

    if (cursor.current) cursor.current.style.transform = `translate(${track.x + fraction * track.width}px, ${track.y}px)`;

    // A few pixels either way, so a thin bar can be found
    const tolerance = (MIN_BAR_PX / track.width) * span;
    const under = recent.filter((i) => i.kind === at_.kind && overlaps(i, moment - tolerance, moment + tolerance, now));
    const text = `${at(moment)} · ${LABEL[at_.kind]}: ${
      moment < recordedFrom(at_.kind) ? "not on record" : under.length === 0 ? "nothing" : under.map((i) => i.detail).join("; ")
    }`;

    // To the minute, so most frames leave it as it is
    if (caption.current && caption.current.textContent !== text) caption.current.textContent = text;
  }, []);

  const point = useCallback(
    (kind: IncidentKind, e: PointerEvent<HTMLDivElement>) => {
      const track = e.currentTarget;

      if (measured.current?.track !== track) {
        measured.current = { track, left: track.getBoundingClientRect().left, width: track.offsetWidth, x: track.offsetLeft, y: track.offsetTop };

        if (cursor.current) cursor.current.style.height = `${track.offsetHeight}px`;
      }

      // Only on arriving: setting it again on every move, even unchanged, has the browser restyle every row
      if (!area.current?.hasAttribute("data-hover")) area.current?.setAttribute("data-hover", "");

      pointer.current = { kind, clientX: e.clientX };
      frame.current ||= requestAnimationFrame(draw);
    },
    [draw],
  );

  const leave = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    pointer.current = null;
    measured.current = null;
    area.current?.removeAttribute("data-hover");
  }, []);

  // The rows and the list change with the data, the range and the chosen incident, not with the pointer:
  // worked out once for those, so moving the pointer redraws only the cursor and the caption
  const rows = useMemo(() => {
    const x = (t: number) => ((Math.min(Math.max(t, from), now) - from) / span) * 100;
    const marks = ticks(range, from, now);

    return (
      <>
        {KINDS.map(({ kind, label }) => {
          const ofKind = recent.filter((incident) => incident.kind === kind);
          const ongoing = ofKind.find((incident) => incident.end === null);
          const since = Math.max(from, recordedFrom(kind));

          return (
            <div key={kind} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[9rem_minmax(0,1fr)_10rem]">
              <span className="truncate text-xs">{label}</span>
              <span className="text-right text-xs text-muted-foreground tabular-nums sm:order-last">
                {ongoing
                  ? `ongoing since ${ongoing.startKnown ? "" : "before "}${dayFormat.format(ongoing.start)}`
                  : ofKind.length === 0
                    ? "none"
                    : `${ofKind.length} ${ofKind.length === 1 ? "incident" : "incidents"}`}
              </span>
              <div
                className="relative col-span-2 h-5 touch-pan-y overflow-hidden rounded-[3px] select-none sm:col-span-1"
                role="img"
                aria-label={`${label}, ${RANGES[range].heading.toLowerCase()}: ${ofKind.length === 0 ? "no incidents" : `${ofKind.length} incidents`}`}
                onPointerDown={(e) => point(kind, e)}
                onPointerMove={(e) => point(kind, e)}
                onPointerLeave={leave}
              >
                {/* Before records began: hatched, unknown rather than clear */}
                {since > from && <div className="absolute inset-y-0 left-0" style={{ width: `${x(since)}%`, background: UNRECORDED }} />}
                <div className="absolute inset-y-0 right-0 bg-foreground/[0.07]" style={{ left: `${x(since)}%` }} />
                {marks.map((mark) => (
                  <div key={mark.at} aria-hidden className="absolute inset-y-0 w-px bg-card/70" style={{ left: `${x(mark.at)}%` }} />
                ))}
                {ofKind.map((incident) => (
                  <div
                    key={incident.id}
                    className={`absolute inset-y-0 rounded-[2px] ${FILL[incident.level]} ${
                      picked?.id === incident.id ? "ring-1 ring-foreground ring-offset-1 ring-offset-card" : ""
                    }`}
                    style={{ left: `${x(incident.start)}%`, width: `${x(incident.end ?? now) - x(incident.start)}%`, minWidth: MIN_BAR_PX }}
                  />
                ))}
              </div>
            </div>
          );
        })}

        {/* The axis, under the rows' timelines */}
        <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[9rem_minmax(0,1fr)_10rem] sm:gap-x-4">
          <div className="relative h-3 font-mono text-[10px] text-muted-foreground sm:col-start-2">
            {marks
              // Too near an end, a centred label would be cut off
              .filter((mark) => mark.label !== null && x(mark.at) > 4 && x(mark.at) < 96)
              .map((mark) => (
                <span
                  key={mark.at}
                  className={`absolute -translate-x-1/2 whitespace-nowrap ${mark.minor ? "max-sm:hidden" : ""}`}
                  style={{ left: `${x(mark.at)}%` }}
                >
                  {mark.label}
                </span>
              ))}
          </div>
        </div>
      </>
    );
  }, [recent, from, now, span, range, picked, recordedFrom, point, leave]);

  const list = useMemo(() => {
    const shown = all ? recent : recent.slice(0, SHOWN);

    return recent.length === 0 ? (
      <p className="border-t border-border pt-4 text-sm text-muted-foreground">No incidents in the {heading.toLowerCase()}.</p>
    ) : (
      <div className="flex flex-col border-t border-border pt-3">
        <ol className="flex flex-col">
          {shown.map((incident) => (
            <li key={incident.id}>
              <button
                type="button"
                onClick={() => setChosen((current) => (current === incident.id ? null : incident.id))}
                aria-pressed={chosen === incident.id}
                className={`-mx-2 grid w-[calc(100%+1rem)] grid-cols-[0.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 rounded-sm px-2 py-2 text-left text-xs transition-colors hover:bg-foreground/5 sm:grid-cols-[0.5rem_9rem_minmax(0,16rem)_6rem_minmax(0,1fr)] ${
                  chosen === incident.id ? "bg-foreground/8" : ""
                }`}
              >
                <span aria-label={LEVEL[incident.level]} className={`size-2 translate-y-px rounded-full ${FILL[incident.level]}`} />
                <span className="font-medium">{LABEL[incident.kind]}</span>
                <span className="text-muted-foreground tabular-nums max-sm:col-start-2">{when(incident)}</span>
                <span className="text-muted-foreground tabular-nums max-sm:col-start-2">
                  {incident.end === incident.start ? "" : incident.end === null ? `for ${formatMs(now - incident.start)}` : formatMs(incident.end - incident.start)}
                </span>
                <span className="max-sm:col-start-2">{incident.detail}</span>
              </button>
            </li>
          ))}
        </ol>
        {recent.length > SHOWN && (
          <button type="button" onClick={() => setAll(!all)} className="mt-2 self-start text-xs text-muted-foreground hover:text-foreground">
            {all ? "Show fewer" : `Show all ${recent.length}`}
          </button>
        )}
      </div>
    );
  }, [recent, all, chosen, heading, now]);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Label as="h3">{heading}</Label>
        <Switch
          label="Period"
          options={(Object.keys(RANGES) as Range[]).map((key) => [key, RANGES[key].label])}
          value={range}
          onChange={(next) => {
            setRange(next);
            leave();
          }}
        />
      </div>

      {/* data-hover is set while the pointer is on a row, showing the cursor and the hover caption */}
      <div ref={area} className="group relative flex flex-col gap-3">
        {rows}
        {/* The cursor, over the row under the pointer: moved directly, so the rows stay as they are */}
        <div ref={cursor} aria-hidden className="pointer-events-none absolute top-0 left-0 hidden w-px bg-foreground group-data-[hover]:block" />

        {/* What the pointer is over: a line of its own, so the rows never move */}
        <p className="min-h-5 text-xs text-muted-foreground sm:pl-[10rem]">
          <span className="group-data-[hover]:hidden">
            Recording since {dayFormat.format(log.since)}
            {log.rebuiltFrom !== null && log.rebuiltFrom < log.since && `; stalls and mining majority rebuilt from ${dayFormat.format(log.rebuiltFrom)}`}. Hover or
            drag along a row to see what was happening.
          </span>
          {/* Written by the pointer handler, never by a render */}
          <span ref={caption} className="hidden group-data-[hover]:inline" />
        </p>
      </div>

      {list}
    </div>
  );
}
