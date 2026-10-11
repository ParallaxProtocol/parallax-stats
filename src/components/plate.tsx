import type { ElementType, ReactNode } from "react";
import type { Level } from "@/lib/alert-levels";

/**
 * A section a warning is about takes the warning's color: a tinted border, a
 * wash fading down, and the hover border and corner brackets in that color.
 */
const TONE: Record<Level | "none", string> = {
  none: "border-border hover:border-foreground/20",
  warn: "border-warn/45 bg-linear-to-b from-warn/[0.09] to-transparent to-60% hover:border-warn/80 [--plate-accent:var(--warn)]",
  critical:
    "border-critical/45 bg-linear-to-b from-critical/[0.10] to-transparent to-60% hover:border-critical/80 [--plate-accent:var(--critical)]",
};

/**
 * Plate is the main site's structural surface: square corners, a hairline
 * border, and brand corner brackets that surface on hover.
 */
export function Plate({
  as: Tag = "div",
  className = "",
  tone = null,
  children,
  ...rest
}: {
  as?: ElementType;
  className?: string;
  /** Tints the plate while a warning about it applies. */
  tone?: Level | null;
  id?: string;
  children: ReactNode;
  [attr: `aria-${string}`]: string | undefined;
}) {
  return (
    <Tag
      className={`group/plate relative border bg-surface-elevated transition-colors duration-300 ${TONE[tone ?? "none"]} ${className}`}
      {...rest}
    >
      <span aria-hidden className="plate-brackets" />
      {children}
    </Tag>
  );
}

/** Label is the site's small heading: mono, uppercase, widely tracked. */
export function Label({ as: Tag = "span", className = "", children }: { as?: ElementType; className?: string; children: ReactNode }) {
  return (
    <Tag className={`font-mono text-xs tracking-[0.15em] text-muted-foreground uppercase ${className}`}>{children}</Tag>
  );
}
