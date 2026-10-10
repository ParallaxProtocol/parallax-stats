"use client";

import { useCallback, useSyncExternalStore } from "react";

// Per-viewer preferences in localStorage, readable during render. The
// server render and hydration use the fallback.

const cache = new Map<string, { raw: string | null; value: unknown }>();
const listeners = new Set<() => void>();

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function usePersistent<T>(key: string, fallback: T): [T, (value: T) => void] {
  const getSnapshot = useCallback((): T => {
    const raw = readRaw(key);
    const hit = cache.get(key);

    if (hit && hit.raw === raw) return hit.value as T;

    let value: T = fallback;

    try {
      if (raw !== null) value = JSON.parse(raw) as T;
    } catch {
      // Keep the fallback for unreadable values
    }

    cache.set(key, { raw, value });

    return value;
  }, [key, fallback]);

  const value = useSyncExternalStore(subscribe, getSnapshot, () => fallback);

  const set = useCallback(
    (next: T) => {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        cache.set(key, { raw: readRaw(key), value: next });
      }

      for (const l of listeners) l();
    },
    [key],
  );

  return [value, set];
}
