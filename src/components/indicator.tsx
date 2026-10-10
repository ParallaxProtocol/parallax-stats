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
