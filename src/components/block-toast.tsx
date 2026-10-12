"use client";

// A toast for each new best block, with who mined it, how long it took and
// what it carried, and a chime unless the viewer turned sound off.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toLax } from "@/lib/emission";
import { formatBlockTime, formatInt, shortHash } from "@/lib/format";
import type { Block, MiningPool } from "@/lib/protocol";
import { audioUnlocked, chime, subscribeAudio, unlockAudio } from "./chime";
import { usePersistent } from "./use-persistent";
import { Tooltip } from "./tooltip";

/** How long a toast stays up. */
const SHOW_MS = 10_000;
/** Toasts shown at once; older ones give way. */
const MAX_TOASTS = 3;
/** A jump of more blocks than this is catching up (a reconnect), not news. */
const MAX_JUMP = 3;

export const SOUND_KEY = "sound";

interface Toast {
  block: Block;
  /** Seconds since the parent block, when the parent is the block shown before. */
  took: number | null;
}

const significant = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

function formatFees(fees: string | null): string {
  if (fees === null) return "not reported";

  const lax = toLax(BigInt(fees));

  return lax === 0 ? "none" : `${lax >= 1 ? lax.toFixed(2) : significant.format(lax)} LAX`;
}

function BlockToast({
  toast,
  pools,
  onDismiss,
}: {
  toast: Toast;
  pools: Record<string, MiningPool>;
  onDismiss: (hash: string) => void;
}) {
  const { block, took } = toast;
  const pool = pools[block.miner] ?? null;
  const [leaving, setLeaving] = useState(false);
  // Fade out, or go at once when animations are off and would never end
  const leave = useCallback(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) onDismiss(block.hash);
    else setLeaving(true);
  }, [onDismiss, block.hash]);

  // The countdown bar's end dismisses the toast, so hovering pauses both.
  // Without animations (reduced motion) a timer does it instead.
  useEffect(() => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const timer = window.setTimeout(() => onDismiss(block.hash), SHOW_MS);

    return () => window.clearTimeout(timer);
  }, [onDismiss, block.hash]);

  const stats: [string, string][] = [
    ["Took", took !== null && took > 0 ? formatBlockTime(took) : "n/a"],
    ["Txs", formatInt(block.txCount)],
    ["Fees", formatFees(block.fees)],
  ];

  return (
    <li
      className={`block-toast group pointer-events-auto relative overflow-hidden rounded-lg border border-border bg-surface-elevated/90 shadow-[0_8px_24px_oklch(0_0_0/0.35),0_2px_6px_oklch(0_0_0/0.25)] backdrop-blur-md ${leaving ? "block-toast-leave" : ""}`}
      onAnimationEnd={(e) => {
        if (e.animationName === "toast-leave") onDismiss(block.hash);
      }}
    >
      <span aria-hidden className="brand-gradient absolute inset-x-0 top-0 h-0.5" />

      <div className="flex items-start gap-3 p-4 pb-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-brand-muted text-brand">
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" strokeLinejoin="round" />
            <path d="M4 7.5 12 12l8-4.5M12 12v9" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-mono text-[10px] tracking-[0.15em] text-muted-foreground uppercase">New block</span>
          <span className="text-xl leading-tight font-semibold tabular-nums">#{formatInt(block.number)}</span>
          <span className="truncate text-xs text-muted-foreground">
            mined by{" "}
            <span className={`text-foreground ${pool ? "" : "font-mono"}`}>{pool?.name ?? shortHash(block.miner)}</span>
          </span>
        </div>
        <button
          type="button"
          onClick={leave}
          className="-mt-1 -mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          aria-label="Dismiss"
        >
          <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <dl className="mx-4 mb-4 grid grid-cols-[0.9fr_0.7fr_1.4fr] divide-x divide-border rounded-md border border-border bg-background/40">
        {stats.map(([label, value]) => (
          <div key={label} className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
            <dt className="font-mono text-[9px] tracking-[0.15em] text-muted-foreground uppercase">{label}</dt>
            <dd className="truncate text-sm tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      <span
        aria-hidden
        className="block-toast-countdown absolute inset-x-0 bottom-0 h-0.5 origin-left bg-brand-mark/70 group-hover:[animation-play-state:paused]"
        style={{ animationDuration: `${SHOW_MS}ms` }}
        onAnimationEnd={(e) => {
          e.stopPropagation();
          leave();
        }}
      />
    </li>
  );
}

/**
 * BlockToasts announces each new best block while the dashboard is live.
 * The first block seen, and jumps after a reconnect, are not announced.
 */
export function BlockToasts({ best, pools, live }: { best: Block | null; pools: Record<string, MiningPool>; live: boolean }) {
  const [sound] = usePersistent(SOUND_KEY, true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const last = useRef<Block | null>(null);
  const dismiss = useCallback((hash: string) => setToasts((shown) => shown.filter((t) => t.block.hash !== hash)), []);

  useEffect(() => {
    const before = last.current;

    last.current = best;

    if (!best || !before || !live || best.number <= before.number || best.number - before.number > MAX_JUMP) return;

    const toast: Toast = { block: best, took: best.parentHash === before.hash ? best.timestamp - before.timestamp : null };

    setToasts((shown) => [...shown.filter((t) => t.block.hash !== best.hash), toast].slice(-MAX_TOASTS));
    if (sound) chime();
  }, [best, live, sound]);

  return (
    <ol
      aria-live="polite"
      aria-label="New blocks"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[22rem]"
    >
      {toasts.map((toast) => (
        <BlockToast key={toast.block.hash} toast={toast} pools={pools} onDismiss={dismiss} />
      ))}
    </ol>
  );
}

/**
 * SoundToggle turns the new-block chime on or off for this viewer. While the
 * browser still blocks audio it shows that, and a click allows it and plays
 * the chime so the viewer hears it works.
 */
export function SoundToggle({ compact = false }: { compact?: boolean }) {
  const [sound, setSound] = usePersistent(SOUND_KEY, true);
  const unlocked = useSyncExternalStore(subscribeAudio, audioUnlocked, () => false);
  const blocked = sound && !unlocked;

  async function onClick() {
    if (sound && unlocked) {
      setSound(false);
      return;
    }

    setSound(true);
    if (await unlockAudio()) chime();
  }

  return (
    <Tooltip content={blocked ? "Your browser blocks sound until you interact with the page: click to allow it" : null}>
      <button
        type="button"
        onClick={() => void onClick()}
        className={`relative inline-flex items-center justify-center rounded-md border border-border hover:bg-accent/50 ${compact ? "size-7" : "size-8 sm:size-9"}`}
        aria-label={blocked ? "Allow the new block sound" : sound ? "Mute new block sound" : "Play a sound for new blocks"}
        aria-pressed={sound && unlocked}
      >
        <svg
          viewBox="0 0 24 24"
          className={`size-4 ${blocked ? "text-muted-foreground" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden
        >
          <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" strokeLinejoin="round" />
          {sound && unlocked ? (
            <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" strokeLinecap="round" />
          ) : (
            <path d="m16 9.5 5 5M21 9.5l-5 5" strokeLinecap="round" />
          )}
        </svg>
        {blocked && <span aria-hidden className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-warn" />}
      </button>
    </Tooltip>
  );
}
