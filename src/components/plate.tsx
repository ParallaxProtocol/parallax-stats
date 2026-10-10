import type { ElementType, ReactNode } from "react";

/**
 * Plate is the main site's structural surface: square corners, a hairline
 * border, and brand corner brackets that surface on hover.
 */
export function Plate({
  as: Tag = "div",
  className = "",
  children,
  ...rest
}: {
  as?: ElementType;
  className?: string;
  children: ReactNode;
  [attr: `aria-${string}`]: string | undefined;
}) {
  return (
    <Tag
      className={`group/plate relative border border-border bg-surface-elevated transition-colors duration-300 hover:border-foreground/20 ${className}`}
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
