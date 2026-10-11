"use client";

import { useSyncExternalStore } from "react";

// Dark by default, as on the main site; the choice persists per viewer.

const listeners = new Set<() => void>();

function isLight(): boolean {
  return document.documentElement.dataset.theme === "light";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

function setLight(light: boolean): void {
  if (light) document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;

  try {
    if (light) localStorage.setItem("theme", "light");
    else localStorage.removeItem("theme");
  } catch {
    // Storage may be unavailable; the choice still applies to this page
  }

  for (const l of listeners) l();
}

/** ThemeToggle switches between the dark and light themes; `compact` sizes it for the section bar. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const light = useSyncExternalStore(subscribe, isLight, () => false);

  return (
    <button
      type="button"
      onClick={() => setLight(!light)}
      className={`inline-flex items-center justify-center rounded-md border border-border hover:bg-accent/50 ${compact ? "size-7" : "size-8 sm:size-9"}`}
      aria-label={light ? "Switch to dark theme" : "Switch to light theme"}
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        {light ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path
              d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
              strokeLinecap="round"
            />
          </>
        ) : (
          <path d="M20.5 14.1A8.5 8.5 0 0 1 9.9 3.5a8.5 8.5 0 1 0 10.6 10.6Z" strokeLinejoin="round" />
        )}
      </svg>
    </button>
  );
}
