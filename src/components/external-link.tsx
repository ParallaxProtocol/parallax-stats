import type { ReactNode } from "react";

/** ExternalLink opens another site in a new tab, marked with an arrow out. */
export function ExternalLink({ href, title, className = "", children }: { href: string; title?: string; className?: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={title} className={`inline-flex items-center gap-1 hover:text-foreground ${className}`}>
      {children}
      <svg viewBox="0 0 16 16" className="size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <path d="M6 3.5h6.5V10M12.5 3.5 4 12" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  );
}
