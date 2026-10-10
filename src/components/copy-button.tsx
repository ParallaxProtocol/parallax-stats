"use client";

import { useState } from "react";

/** CopyButton copies a value and confirms it briefly. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard access can be denied; the value stays selectable in its tooltip
        }
      }}
      className="shrink-0 rounded px-1 font-mono text-[10px] tracking-wider text-muted-foreground uppercase hover:bg-accent/50 hover:text-foreground"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
