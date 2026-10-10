"use client";

import { useLayoutEffect, useRef, useState } from "react";

/** useSize tracks an element's size; it starts from a guess so server renders draw something. */
export function useSize<T extends HTMLElement>(initial: { width: number; height: number }) {
  const ref = useRef<T>(null);
  const [size, setSize] = useState(initial);

  useLayoutEffect(() => {
    const el = ref.current;

    if (!el) return;

    const observer = new ResizeObserver(([entry]) =>
      setSize({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) }),
    );

    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}
