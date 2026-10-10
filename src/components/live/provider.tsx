"use client";

import { createContext, use, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Snapshot } from "@/lib/protocol";
import { LiveStore, type LiveState } from "./store";

interface LiveContextValue {
  store: LiveStore;
  /** Server time of the rendered snapshot; the clock reads this until hydrated. */
  renderedAt: number;
}

const LiveContext = createContext<LiveContextValue | null>(null);

export function LiveProvider({ initial, children }: { initial: Snapshot; children: ReactNode }) {
  const [store] = useState(() => new LiveStore(initial));

  useEffect(() => {
    store.start();

    return () => store.stop();
  }, [store]);

  return <LiveContext value={{ store, renderedAt: initial.serverTime }}>{children}</LiveContext>;
}

function useLiveContext(): LiveContextValue {
  const value = use(LiveContext);

  if (!value) throw new Error("useLive must be used inside LiveProvider");

  return value;
}

export function useLive(): LiveState {
  const { store } = useLiveContext();

  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

// One shared one-second ticker for every relative time on the page

let tick = Date.now();
let ticker: number | undefined;
const tickListeners = new Set<() => void>();

function subscribeTick(listener: () => void): () => void {
  tickListeners.add(listener);

  if (ticker === undefined) {
    tick = Date.now();
    ticker = window.setInterval(() => {
      tick = Date.now();
      for (const l of tickListeners) l();
    }, 1000);
  }

  return () => {
    tickListeners.delete(listener);

    if (tickListeners.size === 0) {
      window.clearInterval(ticker);
      ticker = undefined;
    }
  };
}

/** useServerNow returns the current server time, ticking every second. */
export function useServerNow(): number {
  const { renderedAt } = useLiveContext();
  const { clockOffset } = useLive();
  const now = useSyncExternalStore(
    subscribeTick,
    () => tick + clockOffset,
    () => renderedAt,
  );

  return now;
}
