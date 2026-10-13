import type { Grade } from "@/lib/format";

/** Text colors for values graded in place, as in the node table. */
export const GRADE_TEXT: Record<Grade, string> = {
  good: "text-good-ink",
  warn: "text-warn-ink",
  serious: "text-serious-ink",
  critical: "text-critical-ink",
  info: "text-info-ink",
  off: "text-muted-foreground",
};

const COLOR: Record<Grade, string> = {
  good: "bg-good",
  warn: "bg-warn",
  serious: "bg-serious",
  critical: "bg-critical",
  info: "bg-info",
  off: "bg-transparent ring-1 ring-inset ring-off",
};

export const GRADE_NAME: Record<Grade, string> = {
  good: "good",
  warn: "fair",
  serious: "poor",
  critical: "bad",
  info: "first",
  off: "offline",
};

/**
 * Indicator is the colored status mark beside a value. Its grade is
 * announced to screen readers, unless `label` is empty because adjacent
 * text already says it.
 */
export function Indicator({ grade, label, className = "" }: { grade: Grade; label?: string; className?: string }) {
  const classes = `inline-block size-2 shrink-0 rounded-full ${COLOR[grade]} ${className}`;

  if (label === "") return <span className={classes} aria-hidden />;

  return <span className={classes} role="img" aria-label={label ?? GRADE_NAME[grade]} />;
}

/**
 * Ping is the ring that spreads from a status dot to draw the eye. A
 * critical one keeps spreading while the state lasts; any other spreads
 * three times and rests, so a page with several warnings on it stays calm.
 * It goes under the dot, in a relative box the dot's size. A new `cause`
 * starts it again, so a change of state draws the eye anew.
 */
export function Ping({ color, critical = false, cause }: { color: string; critical?: boolean; cause?: string }) {
  return (
    <span
      key={cause}
      aria-hidden
      className={`absolute inline-flex size-full rounded-full opacity-60 motion-reduce:hidden ${critical ? "animate-ping" : "animate-ping-few"} ${color}`}
    />
  );
}
