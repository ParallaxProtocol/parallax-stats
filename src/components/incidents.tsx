"use client";

import { useState, useSyncExternalStore } from "react";
import { formatMs } from "@/lib/format";
import type { Incident, IncidentKind, IncidentLog } from "@/lib/protocol";
import { Alerts, type Alert } from "./alerts";
import { useServerNow } from "./live/provider";
import { Label, Plate } from "./plate";

/** Each kind of incident, in the strip's order: the chain's health first, the dashboard's own last. */
const KINDS: { kind: IncidentKind; label: string }[] = [
  { kind: "majority", label: "Mining majority" },
  { kind: "spread", label: "Slow propagation" },
  { kind: "split", label: "Chain split" },
  { kind: "stall", label: "Possible stall" },
  { kind: "reorg", label: "Deep reorg" },
  { kind: "unverified", label: "No verified node" },
];
const LABEL = Object.fromEntries(KINDS.map(({ kind, label }) => [kind, label])) as Record<IncidentKind, string>;

/** Days the strip shows, and incidents listed before "show all". */
const DAYS = 30;
const SHOWN = 8;
/** A majority is judged over a week, so rebuilt records of it begin a week after the oldest saved block. */
const WEEK_MS = 7 * 86_400_000;

const RANK = { info: 0, warn: 1, critical: 2 } as const;
const FILL: Record<Incident["level"], string> = { critical: "bg-critical", warn: "bg-warn", info: "bg-info" };
const LEVEL: Record<Incident["level"], string> = { critical: "critical", warn: "warning", info: "notice" };

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

const subscribeNothing = () => () => {};

/** days gives the start of each of the last DAYS local days, oldest first, the last being today. */
function days(now: number): number[] {
  return Array.from({ length: DAYS }, (_, i) => {
    const day = new Date(now);

    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - (DAYS - 1 - i));

    return day.getTime();
  });
}

/** overlaps reports whether an incident touches the span from `from` to `to`; one still going lasts until now. */
function overlaps(incident: Incident, from: number, to: number, now: number): boolean {
  return incident.start < to && (incident.end ?? now) >= from;
}

/** when renders an incident's time: a moment's date and time, or a span's start and end. */
function when(incident: Incident): string {
  const at = (ms: number) => `${dayFormat.format(ms)}, ${timeFormat.format(ms)}`;
  const start = `${incident.startKnown ? "" : "before "}${at(incident.start)}`;

  if (incident.end === incident.start) return start;
  if (incident.end === null) return `${start} – ongoing`;

  // The same day needs saying once
  return dayFormat.format(incident.end) === dayFormat.format(incident.start)
    ? `${start} – ${timeFormat.format(incident.end)}`
    : `${start} – ${at(incident.end)}`;
}

/**
 * NetworkStatus is the first thing on the page: what needs attention now,
 * as the alerts' banners, or that nothing does, and below it what went
 * wrong over the last 30 days.
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
 * Timeline shows what went wrong and when: a strip per kind over the last
 * 30 days, each day in its worst incident's colour, and the incidents
 * themselves, newest first. Hovering or tapping a day says what happened
 * then; choosing an incident marks its days.
 */
function Timeline({ log }: { log: IncidentLog | null }) {
  const now = useServerNow();
  // Days and times are the viewer's own, unknown to the server render
  const hydrated = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const [focus, setFocus] = useState<{ kind: IncidentKind; day: number } | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  if (log === null) {
    return <p className="text-sm text-muted-foreground">This server does not record incidents yet.</p>;
  }

  if (!hydrated) return <div className="min-h-56" />;

  const starts = days(now);
  const from = starts[0];
  const recent = log.list.filter((incident) => overlaps(incident, from, Infinity, now));
  const shown = all ? recent : recent.slice(0, SHOWN);
  const picked = recent.find((incident) => incident.id === chosen) ?? null;
  // Since when each kind is on record: stalls and the majority were rebuilt from saved blocks
  const recordedFrom = (kind: IncidentKind) =>
    log.rebuiltFrom === null ? log.since : kind === "stall" ? log.rebuiltFrom : kind === "majority" ? Math.min(log.since, log.rebuiltFrom + WEEK_MS) : log.since;
  const focused = focus ? recent.filter((i) => i.kind === focus.kind && overlaps(i, focus.day, focus.day + 86_400_000, now)) : [];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Label as="h3">Last {DAYS} days</Label>
        <span className="text-xs text-muted-foreground">
          Recording since {dayFormat.format(log.since)}
          {log.rebuiltFrom !== null && log.rebuiltFrom < log.since && `; stalls and mining majority rebuilt from ${dayFormat.format(log.rebuiltFrom)}`}
        </span>
      </div>

      <div className="flex flex-col gap-3" onPointerLeave={() => setFocus(null)}>
        {KINDS.map(({ kind, label }) => {
          const ofKind = recent.filter((incident) => incident.kind === kind);
          const ongoing = ofKind.find((incident) => incident.end === null);
          const since = recordedFrom(kind);

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
              <div className="col-span-2 flex h-5 gap-[2px] sm:col-span-1" role="img" aria-label={`${label}, last ${DAYS} days: ${ofKind.length === 0 ? "no incidents" : `${ofKind.length} incidents`}`}>
                {starts.map((day) => {
                  const end = day + 86_400_000;
                  const worst = ofKind
                    .filter((incident) => overlaps(incident, day, end, now))
                    .reduce<Incident["level"] | null>((top, i) => (top === null || RANK[i.level] > RANK[top] ? i.level : top), null);
                  const unrecorded = end <= since;
                  const marked = picked?.kind === kind && overlaps(picked, day, end, now);
                  const focusHere = focus?.kind === kind && focus.day === day;

                  return (
                    <button
                      key={day}
                      type="button"
                      tabIndex={-1}
                      aria-hidden
                      onPointerEnter={() => setFocus({ kind, day })}
                      onClick={() => setFocus({ kind, day })}
                      className={`flex-1 rounded-[2px] transition-opacity ${
                        worst ? FILL[worst] : unrecorded ? "bg-foreground/[0.03]" : "bg-foreground/10"
                      } ${marked || focusHere ? "ring-1 ring-foreground ring-offset-1 ring-offset-card" : ""}`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* What the day under the pointer held: a line of its own, so the strip never moves */}
        <p className="min-h-5 text-xs text-muted-foreground sm:pl-[10rem]" aria-live="polite">
          {focus
            ? `${dayFormat.format(focus.day)} · ${LABEL[focus.kind]}: ${
                focus.day + 86_400_000 <= recordedFrom(focus.kind)
                  ? "not on record"
                  : focused.length === 0
                    ? "nothing"
                    : focused.map((i) => i.detail).join("; ")
              }`
            : `${dayFormat.format(from)} to today. Hover or tap a day to see what happened.`}
        </p>
      </div>

      {recent.length === 0 ? (
        <p className="border-t border-border pt-4 text-sm text-muted-foreground">No incidents in the last {DAYS} days.</p>
      ) : (
        <div className="flex flex-col border-t border-border pt-3">
          <ol className="flex flex-col">
            {shown.map((incident) => (
              <li key={incident.id}>
                <button
                  type="button"
                  onClick={() => setChosen(chosen === incident.id ? null : incident.id)}
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
      )}
    </div>
  );
}
