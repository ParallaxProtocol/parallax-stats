"use client";

import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode } from "react";
import { formatMs } from "@/lib/format";
import type { Incident, IncidentKind, IncidentLog } from "@/lib/protocol";
import { AnimatePresence, motion } from "motion/react";
import { Alerts, WARNING_DOT, type Alert } from "./alerts";
import { Switch } from "./charts";
import { Ping } from "./indicator";
import { useServerNow } from "./live/provider";
import { SPRING } from "./motion";
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
/** The narrowest an incident is drawn, in pixels, so a few minutes stay visible over 30 days. */
const MIN_BAR_PX = 3;

const FILL: Record<Incident["level"], string> = { critical: "bg-critical", warn: "bg-warn" };
/** Incident bars, hatched like the unrecorded stretches but in their severity's colour, over a tint of it. */
const STRIPES: Record<Incident["level"], string> = {
  critical: "repeating-linear-gradient(135deg, var(--critical) 0 2px, color-mix(in oklch, var(--critical) 30%, transparent) 2px 5px)",
  warn: "repeating-linear-gradient(135deg, var(--warn) 0 2px, color-mix(in oklch, var(--warn) 30%, transparent) 2px 5px)",
};
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
/** The bars' height, the same on every row. */
const BAR = "h-4 rounded-[3px]";

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
 * incidents themselves, newest first. Hovering or dragging along a row says
 * what was happening then; choosing an incident marks it.
 */
function Timeline({ log, headline, children }: { log: IncidentLog; headline: ReactNode; children: ReactNode }) {
  const now = useServerNow();
  const [range, setRange] = usePersistent<Range>("incident-range", "day");
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
  const caption = useRef<HTMLSpanElement>(null);
  // The row under the pointer, measured once as the pointer arrives: measuring on every move would make
  // the browser lay the page out again before it could draw
  const measured = useRef<{ track: HTMLDivElement; left: number; width: number; x: number; y: number } | null>(null);

  const { span, label: rangeLabel, heading } = RANGES[range in RANGES ? range : "day"];
  const from = now - span;
  const recent = useMemo(() => log.list.filter((incident) => overlaps(incident, from, now, now)), [log, from, now]);
  const picked = recent.find((incident) => incident.id === chosen) ?? null;
  // Since when each kind is on record: quiet spells and the majority were rebuilt from saved blocks
  const recordedFrom = useCallback(
    (kind: IncidentKind) =>
      log.rebuiltFrom === null ? log.since : kind === "withholding" ? log.rebuiltFrom : kind === "majority" ? Math.min(log.since, log.rebuiltFrom + WEEK_MS) : log.since,
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

    if (cursor.current) cursor.current.style.transform = `translate(${x}px, ${track.y}px)`;

    // Over the row, sliding from left of the cursor to right of it across the row, so it never leaves the
    // area and is never measured
    if (caption.current) caption.current.style.transform = `translate(calc(${x}px - ${fraction * 100}%), calc(${track.y}px - 100% - 6px))`;

    // A few pixels either way, so a thin bar can be found
    const tolerance = (MIN_BAR_PX / track.width) * span;
    const under = recent.filter((i) => at_.kinds.includes(i.kind) && overlaps(i, moment - tolerance, moment + tolerance, now));
    const unrecorded = at_.kinds.filter((kind) => moment < recordedFrom(kind)).length;
    // The row of every kind names each incident's kind; a kind's own row names it once
    const one = at_.kinds.length === 1 ? at_.kinds[0] : null;
    const what =
      under.length > 0
        ? under.map((i) => (one ? i.detail : `${LABEL[i.kind]}: ${i.detail}`)).join("; ")
        : unrecorded === at_.kinds.length
          ? "not on record"
          : unrecorded > 0
            ? "nothing on record"
            : "nothing";
    const text = `${at(moment)} · ${one ? `${LABEL[one]}: ` : ""}${what}`;

    // To the minute, so most frames leave it as it is
    if (caption.current && caption.current.textContent !== text) caption.current.textContent = text;
  }, []);

  const point = useCallback(
    (kinds: IncidentKind[], e: PointerEvent<HTMLDivElement>) => {
      const track = e.currentTarget;

      if (measured.current?.track !== track) {
        measured.current = { track, left: track.getBoundingClientRect().left, width: track.offsetWidth, x: track.offsetLeft, y: track.offsetTop };

        if (cursor.current) cursor.current.style.height = `${track.offsetHeight}px`;
      }

      // Only on arriving: setting it again on every move, even unchanged, has the browser restyle every row
      if (!area.current?.hasAttribute("data-hover")) area.current?.setAttribute("data-hover", "");

      pointer.current = { kinds, clientX: e.clientX };
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
    const marks = ticks(range, from, now);

    // A row's timeline: every incident of its kinds over the range, hatched until all of them were on record.
    // The status line's note says the range too, and opens the history
    const row = (kinds: IncidentKind[], label: ReactNode, name: string, main = false) => {
      const ofKinds = recent.filter((incident) => kinds.includes(incident.kind)).sort((a, b) => DEPTH[a.level] - DEPTH[b.level]);
      const ongoing = ofKinds.filter((incident) => incident.end === null);
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
          <div
            className={`relative col-span-2 ${BAR} touch-pan-y overflow-hidden tap-chart sm:col-span-1`}
            role="img"
            aria-label={`${name}, ${heading.toLowerCase()}: ${ofKinds.length === 0 ? "no incidents" : count}`}
            onPointerDown={(e) => point(kinds, e)}
            onPointerMove={(e) => point(kinds, e)}
            onPointerLeave={leave}
          >
            {/* Before records began: hatched, unknown rather than clear */}
            {since > from && <div className="absolute inset-y-0 left-0" style={{ width: `${x(since)}%`, background: UNRECORDED }} />}
            <div className="absolute inset-y-0 right-0 bg-foreground/[0.07]" style={{ left: `${x(since)}%` }} />
            {marks.map((mark) => (
              <div key={mark.at} aria-hidden className="absolute inset-y-0 w-px bg-card/70" style={{ left: `${x(mark.at)}%` }} />
            ))}
            {ofKinds.map((incident) => (
              <div
                key={incident.id}
                className={`absolute inset-y-0 rounded-[2px] ${picked?.id === incident.id ? "ring-1 ring-foreground ring-offset-1 ring-offset-card" : ""}`}
                style={{
                  left: `${x(incident.start)}%`,
                  width: `${x(incident.end ?? now) - x(incident.start)}%`,
                  minWidth: MIN_BAR_PX,
                  background: STRIPES[incident.level],
                }}
              />
            ))}
          </div>
        </div>
      );
    };

    return (
      <>
        {row(ALL_KINDS, headline, "All kinds", true)}
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
                    )}
                  </motion.div>
                ))}

                {/* The axis, under the rows' timelines */}
                <div className="grid grid-cols-[minmax(0,1fr)] sm:grid-cols-[11rem_minmax(0,1fr)_11rem] sm:gap-x-4">
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
                {list}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </>
    );
  }, [recent, from, now, span, range, rangeLabel, heading, picked, recordedFrom, point, leave, open, setOpen, history, headline, children, list, setRange]);

  return (
    // data-hover is set while the pointer is on a row, showing the cursor and the caption
    <div ref={area} className="group relative flex min-w-0 flex-col">
      {rows}

      {/* The cursor and what it is over, on the row under the pointer: moved directly, so the rows stay as
          they are. The caption is written by the pointer handler, never by a render */}
      <div ref={cursor} aria-hidden className="pointer-events-none absolute top-0 left-0 hidden w-px bg-foreground group-data-[hover]:block" />
      <span
        ref={caption}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 z-10 hidden w-max max-w-full border border-border bg-surface-elevated px-2 py-1 text-xs leading-snug text-muted-foreground shadow-lg group-data-[hover]:block"
      />
    </div>
  );
}
