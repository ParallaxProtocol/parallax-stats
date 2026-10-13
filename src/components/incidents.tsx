"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { formatMs } from "@/lib/format";
import type { Incident, IncidentKind, IncidentLog } from "@/lib/protocol";
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";
import { Alerts, WARNING_DOT, type Alert } from "./alerts";
import { Switch } from "./charts";
import { Ping } from "./indicator";
import { useServerNow } from "./live/provider";
import { FADE_IN, FADE_OUT, REVEAL, SPRING } from "./motion";
import { Label, Plate } from "./plate";
import { Tooltip } from "./tooltip";
import { usePersistent } from "./use-persistent";

/** Each kind of incident, in the timeline's order. */
const KINDS: { kind: IncidentKind; label: string; help?: string }[] = [
  { kind: "majority", label: "Mining majority" },
  {
    kind: "withholding",
    label: "Potential hidden mining",
    help: "The largest miner published fewer blocks than its share predicts, as it would while mining a chain in secret. A sudden drop in its hashrate looks the same.",
  },
  { kind: "spread", label: "Slow propagation" },
  { kind: "split", label: "Chain split" },
  { kind: "reorg", label: "Deep reorg" },
];
const LABEL = Object.fromEntries(KINDS.map(({ kind, label }) => [kind, label])) as Record<IncidentKind, string>;
const ALL_KINDS = KINDS.map(({ kind }) => kind);

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
const SHOWN = 4;
/** A majority is judged over a week, so rebuilt records of it begin a week after the oldest saved block. */
const WEEK_MS = 7 * DAY;
/** How near a thin bar the pointer finds it, in pixels, beside half the row's height for a moment's dot. */
const MIN_BAR_PX = 3;
/** How far the hover cursor stands over a row, above and below. */
const CURSOR_OVER_PX = 4;

const FILL: Record<Incident["level"], string> = { critical: "bg-critical", warn: "bg-warn" };
/** Stripes drift toward now by one every so many seconds while an incident goes on. */
const DRIFT_S = 2.2;
/** How far apart along a row the stripes of an ongoing incident are (globals.css): 5px at 135°. */
const STRIPE_PX = 7.071;
/** Drawing order where kinds share a row: the critical over the warnings. */
const DEPTH: Record<Incident["level"], number> = { warn: 0, critical: 1 };
const LEVEL: Record<Incident["level"], string> = { critical: "critical", warn: "warning" };
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

/**
 * worst flattens incidents into spans that do not overlap, each in the
 * colour of the most severe incident over it, for the row of every kind:
 * bars of different kinds stacked there tinted each other and crossed
 * their hatching. A span is live where an incident of its level over it
 * is still going on. Moments, with no length, are left to be drawn on their own.
 */
function worst(incidents: Incident[], now: number): { start: number; end: number; level: Incident["level"]; live: boolean }[] {
  const spans = incidents.filter((incident) => (incident.end ?? now) > incident.start);
  const edges = [...new Set(spans.flatMap((incident) => [incident.start, incident.end ?? now]))].sort((a, b) => a - b);
  const out: { start: number; end: number; level: Incident["level"]; live: boolean }[] = [];

  for (let i = 0; i < edges.length - 1; i++) {
    const [start, end] = [edges[i], edges[i + 1]];
    const over = spans.filter((incident) => incident.start <= start && (incident.end ?? now) >= end);

    if (over.length === 0) continue;

    const level = over.some((incident) => incident.level === "critical") ? "critical" : "warn";
    const live = over.some((incident) => incident.level === level && incident.end === null);
    const previous = out.at(-1);

    // One span where the level and whether it goes on carry on across an edge
    if (previous && previous.end === start && previous.level === level && previous.live === live) previous.end = end;
    else out.push({ start, end, level, live });
  }

  return out;
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

/** captionLine is a line of the hover caption, built outside React: the pointer handler writes the caption. */
function captionLine(text: string, className = ""): HTMLElement {
  const line = document.createElement("div");

  line.className = className;
  line.textContent = text;

  return line;
}

/** captionIncident is an incident's line in the hover caption: its severity's dot, its kind where the row has several, and what happened. */
function captionIncident({ level, kind, detail }: { level: Incident["level"]; kind: string | null; detail: string }): HTMLElement {
  const line = document.createElement("div");
  const dot = document.createElement("span");
  const text = document.createElement("span");

  line.className = "flex items-baseline gap-2";
  dot.className = `size-1.5 shrink-0 -translate-y-px rounded-full ${FILL[level]}`;

  if (kind) {
    const name = document.createElement("span");

    name.className = "font-medium text-foreground";
    name.textContent = kind;
    text.append(name, " ");
  }

  text.append(detail);
  line.append(dot, text);

  return line;
}

/** A question mark in a circle that explains its row on hover or focus. */
function Help({ text }: { text: string }) {
  return (
    <Tooltip content={text}>
      <span role="img" aria-label={text} tabIndex={0} className="shrink-0 rounded-full outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="size-3" aria-hidden="true">
          <circle cx="8" cy="8" r="6.25" />
          <path d="M6.25 6.25a1.75 1.75 0 1 1 2.5 1.6c-.45.22-.75.6-.75 1.1v.3" />
          <circle cx="8" cy="11.25" r=".4" fill="currentColor" />
        </svg>
      </span>
    </Tooltip>
  );
}

/** The grid every row shares: its label, its bar and a note at the end. On phones the bar goes under the other two. */
const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[11rem_minmax(0,1fr)_11rem]";
/** The status line's track: a pill a little taller than each kind's, which is [--bar-h:10px]. */
const BAR = "[--bar-h:14px] h-(--bar-h) rounded-full";

/**
 * NetworkStatus is the first thing on the page, a line of it until asked
 * for more: whether anything needs attention now, and over it what went
 * wrong lately, every kind on one bar. The alerts follow it, each
 * minimized to a line until expanded to a banner. Expanding the line
 * opens the history: a row per kind and the incidents themselves.
 */
export function NetworkStatus({ log, alerts }: { log: IncidentLog | null; alerts: Alert[] }) {
  // Days and times are the viewer's own, unknown to the server render
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const headline = <Headline alerts={alerts} />;
  // Always there, so an alert coming up on a clear page animates in. Edge to edge across the card when
  // expanded; the lines' own spacing trimmed at the end
  const below = <Alerts alerts={alerts} className={alerts.length > 0 ? "mt-2.5 -mb-[3px]" : ""} />;

  return (
    <Plate as="section" id="incidents" aria-labelledby="status-title" className="flex min-w-0 scroll-mt-16 flex-col px-5 py-4">
      <h2 id="status-title" className="sr-only">
        Network status
      </h2>
      {log !== null && hydrated ? (
        <Timeline log={log} headline={headline}>
          {below}
        </Timeline>
      ) : (
        <>
          <div className={ROW}>
            {headline}
            <span className="text-right text-xs text-muted-foreground sm:order-last">{log === null ? "history not recorded" : ""}</span>
            <div className={`col-span-2 sm:col-span-1 ${BAR} bg-foreground/[0.07]`} />
          </div>
          {below}
        </>
      )}
    </Plate>
  );
}

/** Headline says whether anything needs attention: all clear, or how many alerts, in the most severe one's colour. */
function Headline({ alerts }: { alerts: Alert[] }) {
  // Alerts come most severe first
  const tone = alerts[0]?.tone;

  return (
    <span className="inline-flex min-w-0 items-center gap-2.5 text-sm" role="status">
      <span aria-hidden className="relative flex size-2 shrink-0">
        {tone === "critical" && <Ping color={WARNING_DOT.critical} critical />}
        <span className={`relative inline-flex size-2 rounded-full ${tone ? WARNING_DOT[tone] : "bg-good"}`} />
      </span>
      <span className="truncate">{alerts.length === 0 ? "All clear" : `${alerts.length} ${alerts.length === 1 ? "alert" : "alerts"} now`}</span>
    </span>
  );
}

/**
 * Timeline shows what went wrong and when, each incident a bar from its
 * exact start to its end, over the last 24 hours, 7 days or 30 days: every
 * kind on the status line, and once expanded a row per kind and the
 * incidents themselves, newest first. What is over is a solid tint; what
 * goes on is hatched, its stripes drifting toward now. Changing the period
 * springs the bars to their new places. Hovering or dragging along a row
 * says what was happening then; choosing an incident marks it.
 */
function Timeline({ log, headline, children }: { log: IncidentLog; headline: ReactNode; children: ReactNode }) {
  const now = useServerNow();
  const still = useReducedMotion() ?? false;
  const [range, setRange] = usePersistent<Range>("incident-range", "month");
  const [chosen, setChosen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  // The status line alone until the viewer asks for the history. The section bar's alert panel opens it too,
  // by the same key
  const [open, setOpen] = usePersistent("incident-history", false);
  const history = useId();
  // Hovering moves the cursor and the caption on the page directly, in the pointer's own event: going
  // through a render would put them a frame or two behind a fast drag
  const area = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  // The caption is placed by the outer box and faded in and out by the inner one, which holds the text
  const captionAt = useRef<HTMLDivElement>(null);
  const caption = useRef<HTMLDivElement>(null);
  // The row under the pointer, measured once as the pointer arrives: measuring on every move would make
  // the browser lay the page out again before it could draw
  const measured = useRef<{ track: HTMLDivElement; left: number; width: number; height: number; x: number; y: number } | null>(null);

  const { span, label: rangeLabel, heading } = RANGES[range in RANGES ? range : "month"];
  const from = now - span;
  const recent = useMemo(() => log.list.filter((incident) => overlaps(incident, from, now, now)), [log, from, now]);
  // Drawn: everything over the longest period, so the bars a shorter one leaves out slide off the row
  // rather than vanish, and slide back
  const drawn = useMemo(() => log.list.filter((incident) => overlaps(incident, now - RANGES.month.span, now, now)), [log, now]);
  const picked = recent.find((incident) => incident.id === chosen) ?? null;
  // Since when each kind is on record: quiet spells and the majority were rebuilt from saved blocks
  const recordedFrom = useCallback(
    (kind: IncidentKind) =>
      log.rebuiltFrom === null ? log.since : kind === "withholding" ? log.rebuiltFrom : kind === "majority" ? Math.min(log.since, log.rebuiltFrom + WEEK_MS) : log.since,
    [log],
  );

  // The figures a frame's drawing needs, as of the latest render, so drawing does not wait on one
  const latest = useRef({ from, span, recent, now, recordedFrom, still });

  useLayoutEffect(() => {
    latest.current = { from, span, recent, now, recordedFrom, still };
  });

  // Ongoing incidents' stripes drift toward now, all together
  useEffect(() => {
    if (still || !area.current) return;

    const drift = animate(area.current, { "--stripe-drift": ["0px", `${STRIPE_PX}px`] }, { duration: DRIFT_S, ease: "linear", repeat: Infinity });

    return () => drift.stop();
  }, [still]);

  // The pointer's latest place on a row, drawn at most once a frame, just before the browser paints:
  // Firefox handles a stream of moves before painting, so drawing on each one held the cursor still
  // until the pointer stopped
  const pointer = useRef<{ kinds: IncidentKind[]; clientX: number } | null>(null);
  const frame = useRef(0);

  const draw = useCallback(() => {
    frame.current = 0;

    const at_ = pointer.current;
    const track = measured.current;

    if (!at_ || !track) return;

    const { from, span, recent, now, recordedFrom } = latest.current;
    const fraction = Math.min(1, Math.max(0, (at_.clientX - track.left) / track.width));
    const moment = from + fraction * span;
    const x = track.x + fraction * track.width;
    // The cursor stands a little over the row, above and below
    const y = track.y - CURSOR_OVER_PX;

    if (cursor.current) cursor.current.style.transform = `translate(${x}px, ${y}px)`;

    // Over the row, sliding from left of the cursor to right of it across the row, so it never leaves the
    // area and is never measured
    if (captionAt.current) captionAt.current.style.transform = `translate(calc(${x}px - ${fraction * 100}%), calc(${y}px - 100% - 6px))`;

    // A few pixels either way, so a thin bar or a moment's dot can be found
    const tolerance = (Math.max(MIN_BAR_PX, track.height / 2) / track.width) * span;
    const under = recent.filter((i) => at_.kinds.includes(i.kind) && overlaps(i, moment - tolerance, moment + tolerance, now));

    // The bars under the pointer stay bright as the row's others dim
    for (const bar of track.track.querySelectorAll<HTMLElement>("[data-start]")) {
      const hit = Number(bar.dataset.start) <= moment + tolerance && Number(bar.dataset.end) >= moment - tolerance;

      if (hit !== bar.hasAttribute("data-active")) bar.toggleAttribute("data-active", hit);
    }

    const unrecorded = at_.kinds.filter((kind) => moment < recordedFrom(kind)).length;
    // The row of every kind names each incident's kind; a kind's own row names it once, in the heading
    const one = at_.kinds.length === 1 ? at_.kinds[0] : null;
    const heading = `${at(moment)}${one ? ` · ${LABEL[one]}` : ""}`;
    const quiet = unrecorded === at_.kinds.length ? "not on record" : unrecorded > 0 ? "nothing on record" : "nothing";
    // An incident a line, the most severe first, then the newest
    const lines = [...under]
      .sort((a, b) => DEPTH[b.level] - DEPTH[a.level] || b.start - a.start)
      .map((i) => ({ level: i.level, kind: one ? null : LABEL[i.kind], detail: i.detail }));
    const text = JSON.stringify([heading, quiet, lines]);

    // To the minute, so most frames leave it as it is
    if (!caption.current || caption.current.dataset.text === text) return;

    caption.current.dataset.text = text;
    caption.current.replaceChildren(captionLine(lines.length > 0 ? heading : `${heading} · ${quiet}`, "tabular-nums"), ...lines.map(captionIncident));
  }, []);

  // Leaves the row the pointer was on: its bars brighten again
  const unmeasure = useCallback(() => {
    const track = measured.current?.track;

    track?.removeAttribute("data-pointer");
    track?.querySelectorAll("[data-active]").forEach((bar) => bar.removeAttribute("data-active"));
    measured.current = null;
  }, []);

  const point = useCallback(
    (kinds: IncidentKind[], e: PointerEvent<HTMLDivElement>) => {
      const track = e.currentTarget;

      if (measured.current?.track !== track && area.current) {
        unmeasure();

        // Against the area, which the cursor and caption are placed in: the row's own box is not it
        const box = track.getBoundingClientRect();
        const outer = area.current.getBoundingClientRect();

        measured.current = { track, left: box.left, width: box.width, height: box.height, x: box.left - outer.left, y: box.top - outer.top };
        track.setAttribute("data-pointer", "");

        if (cursor.current) cursor.current.style.height = `${box.height + 2 * CURSOR_OVER_PX}px`;
      }

      // Only on arriving: setting it again on every move, even unchanged, has the browser restyle every row
      if (!area.current?.hasAttribute("data-hover")) {
        area.current?.setAttribute("data-hover", "");

        if (caption.current) animate(caption.current, { opacity: [0, 1], y: [4, 0] }, latest.current.still ? { duration: 0 } : { duration: 0.18, ease: "easeOut" });
      }

      pointer.current = { kinds, clientX: e.clientX };
      frame.current ||= requestAnimationFrame(draw);
    },
    [draw, unmeasure],
  );

  const leave = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    pointer.current = null;
    unmeasure();

    if (!area.current?.hasAttribute("data-hover")) return;

    area.current.removeAttribute("data-hover");

    // Back to the corner once faded, so a caption left at the row's far end never widens the page
    if (caption.current) {
      animate(caption.current, { opacity: 0, y: 2 }, latest.current.still ? { duration: 0 } : { duration: 0.12, ease: "easeOut" }).then(() => {
        if (pointer.current || !captionAt.current) return;

        captionAt.current.style.transform = "";
      });
    }
  }, [unmeasure]);

  // What is over, under the range it ended in: what is going on has its alert above, and its bar.
  // With nothing over, the empty rows already say so: no list at all.
  const past = useMemo(() => recent.filter((incident) => incident.end !== null && incident.end >= from), [recent, from]);

  const list = useMemo(() => {
    const shown = all ? past : past.slice(0, SHOWN);

    return past.length === 0 ? null : (
      <div className="flex flex-col gap-1 border-t border-border pt-3">
        <Label as="h4" className="text-[10px]">
          Earlier
        </Label>
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
        {past.length > SHOWN && (
          <button type="button" onClick={() => setAll(!all)} className="mt-2 self-start text-xs text-muted-foreground hover:text-foreground">
            {all ? "Show fewer" : `Show all ${past.length}`}
          </button>
        )}
      </div>
    );
  }, [past, all, chosen, now]);

  // The rows change with the data, the range, the chosen incident and whether the history is open, not with
  // the pointer: worked out once for those, so moving the pointer redraws only the cursor and the caption
  const rows = useMemo(() => {
    const x = (t: number) => ((Math.min(Math.max(t, from), now) - from) / span) * 100;
    // Bars are placed unclamped, so those before the period sit off the row's left end, ready to slide in
    const place = (t: number) => ((t - from) / span) * 100;
    const marks = ticks(range, from, now);
    const glide = still ? { duration: 0 } : SPRING;
    const fadeIn = still ? { duration: 0 } : FADE_IN;
    const fadeOut = still ? { duration: 0 } : FADE_OUT;

    // A row's timeline: every incident of its kinds over the range, hatched until all of them were on record.
    // The status line's note says the range too, and opens the history. Its bars sweep in from the left
    // when it first shows, `reveal` seconds in
    const row = (kinds: IncidentKind[], label: ReactNode, name: string, reveal: number, main = false) => {
      const ofKinds = recent.filter((incident) => kinds.includes(incident.kind));
      const ongoing = ofKinds.filter((incident) => incident.end === null).sort((a, b) => DEPTH[b.level] - DEPTH[a.level]);
      const mine = drawn.filter((incident) => kinds.includes(incident.kind)).sort((a, b) => DEPTH[a.level] - DEPTH[b.level]);
      const moments = mine
        .filter((incident) => incident.end === incident.start)
        .map((incident) => ({ key: incident.id, start: incident.start, end: incident.start, level: incident.level, look: "incident-moment" }));
      // A kind's own row draws its incidents as they are; the row of every kind, flattened by the worst
      const bars = [
        ...(main
          ? worst(mine, now).map((span) => ({ key: `span:${span.start}`, ...span }))
          : mine.filter((incident) => incident.end !== incident.start).map((incident) => ({ key: incident.id, start: incident.start, end: incident.end ?? now, level: incident.level, live: incident.end === null }))
        ).map(({ live, ...bar }) => ({ ...bar, look: live ? "incident-live" : "incident-ended" })),
        ...moments,
      ];
      const chosenHere = picked && kinds.includes(picked.kind) ? picked : null;
      const since = Math.max(from, ...kinds.map(recordedFrom));
      const count = `${ofKinds.length} ${ofKinds.length === 1 ? "incident" : "incidents"}`;
      const note =
        ongoing.length > 1
          ? `${ongoing.length} ongoing`
          : ongoing.length === 1
            ? `ongoing since ${ongoing[0].startKnown ? "" : "before "}${dayFormat.format(ongoing[0].start)}`
            : ofKinds.length === 0
              ? main
                ? `none in ${rangeLabel}`
                : "none"
              : main
                ? `${count} in ${rangeLabel}`
                : count;

      return (
        <div className={ROW}>
          {label}
          {main ? (
            <button
              type="button"
              onClick={() => {
                setOpen(!open);
                leave();
              }}
              aria-expanded={open}
              aria-controls={history}
              className="inline-flex items-center gap-1.5 justify-self-end text-xs text-muted-foreground tabular-nums hover:text-foreground sm:order-last"
            >
              {note}
              <span className="sr-only">, {open ? "hide" : "show"} history</span>
              <svg viewBox="0 0 16 16" className={`size-3 shrink-0 transition-transform ${open ? "-rotate-90" : "rotate-90"}`} fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
                <path d="m6 3.5 4.5 4.5L6 12.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ) : (
            <span className="text-right text-xs text-muted-foreground tabular-nums sm:order-last">{note}</span>
          )}
          <div className="relative col-span-2 sm:col-span-1">
            <div
              className={`relative ${main ? BAR : "[--bar-h:10px] h-(--bar-h) rounded-full"} touch-pan-y overflow-hidden tap-chart [container-type:inline-size]`}
              role="img"
              aria-label={`${name}, ${heading.toLowerCase()}: ${ofKinds.length === 0 ? "no incidents" : count}`}
              onPointerDown={(e) => point(kinds, e)}
              onPointerMove={(e) => point(kinds, e)}
              onPointerLeave={leave}
            >
              {/* Before records began: hatched, unknown rather than clear */}
              <motion.div className="absolute inset-y-0 left-0" style={{ background: UNRECORDED }} initial={false} animate={{ width: `${x(since)}%` }} transition={glide} />
              <motion.div className="absolute inset-y-0 right-0 bg-foreground/[0.07]" initial={false} animate={{ left: `${x(since)}%` }} transition={glide} />
              {/* Under the bars, so they only mark the empty track; the old period's fade as the new one's come */}
              <AnimatePresence initial={false}>
                <motion.div
                  key={range}
                  aria-hidden
                  className="absolute inset-0"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: fadeIn }}
                  exit={{ opacity: 0, transition: fadeOut }}
                >
                  {marks.map((mark) => (
                    <div key={mark.at} className="absolute inset-y-0 w-px bg-card/70" style={{ left: `${x(mark.at)}%` }} />
                  ))}
                </motion.div>
              </AnimatePresence>
              <motion.div
                className="absolute inset-0"
                initial={still ? false : { clipPath: "inset(0 100% 0 0)" }}
                animate={{ clipPath: "inset(0 0% 0 0)" }}
                transition={{ ...REVEAL, delay: reveal }}
              >
                {bars.map((bar) => (
                  <motion.div
                    key={bar.key}
                    data-start={bar.start}
                    data-end={bar.end}
                    className={`incident-bar ${bar.look} transition-[opacity,filter] duration-200 in-data-[pointer]:opacity-50 data-[active]:opacity-100 data-[active]:brightness-110`}
                    style={{ "--bar-c": `var(--${bar.level})` } as CSSProperties}
                    initial={false}
                    animate={{ "--bar-x": place(bar.start), "--bar-w": place(bar.end) - place(bar.start) }}
                    transition={glide}
                  />
                ))}
              </motion.div>
              {/* The chosen incident, outlined over the bars it may have been flattened into */}
              {chosenHere && (
                <div
                  aria-hidden
                  className="absolute inset-y-0 rounded-full ring-1 ring-foreground ring-offset-1 ring-offset-card"
                  style={{ left: `${x(chosenHere.start)}%`, width: `${x(chosenHere.end ?? now) - x(chosenHere.start)}%`, minWidth: "var(--bar-h)" }}
                />
              )}
            </div>
            {/* Now, at the status line's end, in the colour of the worst that goes on */}
            {main && ongoing.length > 0 && (
              <span aria-hidden className="pointer-events-none absolute top-1/2 left-full flex size-2 -translate-x-1/2 -translate-y-1/2">
                <Ping color={FILL[ongoing[0].level]} critical={ongoing[0].level === "critical"} cause={ongoing[0].id} />
                <span className={`relative inline-flex size-2 rounded-full ring-2 ring-card ${FILL[ongoing[0].level]}`} />
              </span>
            )}
          </div>
        </div>
      );
    };

    return (
      <>
        {row(ALL_KINDS, headline, "All kinds", 0, true)}
        {children}

        {/* Not positioned, so the cursor still measures each row against the whole area. Its space opens and
            closes on a spring, the rows following one after another; the gap before it is inside, so it
            eases too */}
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="history"
              id={history}
              // Clipped only while it moves, so a chosen incident's ring is never cut off once open
              initial={{ height: 0, opacity: 0, overflow: "hidden" }}
              animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
              exit={{ height: 0, opacity: 0, overflow: "hidden" }}
              transition={SPRING}
            >
              <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <Label as="h3" className="text-[10px]">
                    By kind
                  </Label>
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
                {KINDS.map(({ kind, label, help }, i) => (
                  <motion.div key={kind} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SPRING, delay: i * 0.04 }}>
                    {row(
                      [kind],
                      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                        <span className="truncate">{label}</span>
                        {help && <Help text={help} />}
                      </span>,
                      label,
                      0.1 + i * 0.06,
                    )}
                  </motion.div>
                ))}

                {/* The axis, under the rows' timelines, its labels faded across as the period changes */}
                <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[11rem_minmax(0,1fr)_11rem] sm:gap-x-4">
                  <div className="relative h-3 font-mono text-[10px] text-muted-foreground sm:col-start-2">
                    <AnimatePresence initial={false}>
                      <motion.div key={range} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fadeIn }} exit={{ opacity: 0, transition: fadeOut }}>
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
                      </motion.div>
                    </AnimatePresence>
                  </div>
                </div>
                {list}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }, [recent, drawn, from, now, span, range, rangeLabel, heading, picked, recordedFrom, point, leave, open, setOpen, history, headline, children, list, setRange, still]);

  return (
    // data-hover is set while the pointer is on a row, showing the cursor and the caption
    <div ref={area} className="group relative flex min-w-0 flex-col">
      {rows}

      {/* The cursor and what it is over, on the row under the pointer: moved directly, so the rows stay as
          they are. The caption is written by the pointer handler, never by a render */}
      <div ref={cursor} aria-hidden className="pointer-events-none absolute top-0 left-0 hidden w-px bg-foreground/55 group-data-[hover]:block">
        <span className="absolute top-1/2 left-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-2 ring-card" />
      </div>
      <div ref={captionAt} aria-hidden className="pointer-events-none absolute top-0 left-0 z-10 w-max max-w-full">
        <div
          ref={caption}
          style={{ opacity: 0 }}
          className="flex flex-col gap-1 rounded-[8px] border border-border bg-surface-elevated/80 px-2.5 py-1.5 text-xs leading-snug text-muted-foreground shadow-lg backdrop-blur-md backdrop-saturate-150"
        />
      </div>
    </div>
  );
}
