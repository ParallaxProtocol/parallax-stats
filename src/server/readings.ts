// Readings of the network figures that come from the node list rather
// than from blocks: active and synced nodes, the recommended fee, latency,
// uptime, the mempool, and the LAX price and trading volume. The hub takes one every few minutes; each trend slice keeps
// the sums of its readings, so a slice shows their mean.

import type { Summary } from "../lib/derive.ts";
import { TREND_SLICE_S, TREND_SLICES, type Trends } from "../lib/protocol.ts";

/** A running mean: the sum of the readings that had a value, and how many did. */
type Mean = [sum: number, count: number];

interface Slice {
  /** Start of the slice, unix seconds. */
  start: number;
  active: Mean;
  synced: Mean;
  gasPrice: Mean;
  peerLatency: Mean;
  uptime: Mean;
  pending: Mean;
  price: Mean;
  volume: Mean;
}

const FIELDS = ["active", "synced", "gasPrice", "peerLatency", "uptime", "pending", "price", "volume"] as const;

/** Fields added after readings were first saved: a slice saved before them gets an empty mean. */
const LATER_FIELDS = ["pending", "price", "volume"] as const;

export type ReadingFields = Pick<Trends, (typeof FIELDS)[number]>;

/** What is saved of the readings across restarts. */
export interface ReadingsState {
  slices: Slice[];
}

function add(mean: Mean, value: number | null): void {
  if (value === null || !Number.isFinite(value)) return;

  mean[0] += value;
  mean[1]++;
}

export class Readings {
  /** Oldest first. */
  private slices: Slice[] = [];

  /**
   * record adds a reading to the slice in progress. Latency counts only
   * when some node measured it, and the fee, uptime, price and volume only when known.
   */
  record(summary: Summary, gasPrice: string | null, now = Date.now(), usd: number | null = null, volume: number | null = null): void {
    const start = Math.floor(now / 1000 / TREND_SLICE_S) * TREND_SLICE_S;
    let slice = this.slices.at(-1);

    if (!slice || slice.start !== start) {
      slice = { start, active: [0, 0], synced: [0, 0], gasPrice: [0, 0], peerLatency: [0, 0], uptime: [0, 0], pending: [0, 0], price: [0, 0], volume: [0, 0] };
      this.slices.push(slice);
      this.slices = this.slices.filter((s) => s.start > start - TREND_SLICES * TREND_SLICE_S);
    }

    add(slice.active, summary.active);
    add(slice.synced, summary.synced);
    add(slice.gasPrice, gasPrice === null ? null : Number(gasPrice));
    add(slice.peerLatency, summary.peerLatency > 0 ? summary.peerLatency : null);
    add(slice.uptime, summary.uptime);
    add(slice.pending, summary.pending);
    add(slice.price, usd);
    add(slice.volume, volume);
  }

  /** series gives each field's mean for the slices starting at `starts`, null where there was no reading. */
  series(starts: number[]): ReadingFields {
    const byStart = new Map(this.slices.map((slice) => [slice.start, slice]));
    const mean = (field: (typeof FIELDS)[number]) =>
      starts.map((start) => {
        const [sum, count] = byStart.get(start)?.[field] ?? [0, 0];

        return count > 0 ? sum / count : null;
      });

    return {
      active: mean("active"),
      synced: mean("synced"),
      gasPrice: mean("gasPrice"),
      peerLatency: mean("peerLatency"),
      uptime: mean("uptime"),
      pending: mean("pending"),
      price: mean("price"),
      volume: mean("volume"),
    };
  }

  toState(): ReadingsState {
    return { slices: this.slices };
  }

  /** restore takes saved readings, keeping only well-formed slices, oldest first. */
  restore(state: ReadingsState | undefined): void {
    const valid = (mean: unknown): mean is Mean =>
      Array.isArray(mean) && mean.length === 2 && mean.every((n) => typeof n === "number" && Number.isFinite(n));

    this.slices = (state?.slices ?? [])
      // Readings saved before a field was read have none of it: an empty mean, not a reason to drop the slice
      .map((slice) =>
        slice ? { ...slice, ...Object.fromEntries(LATER_FIELDS.filter((field) => slice[field] === undefined).map((field) => [field, [0, 0]])) } : slice,
      )
      .filter((slice) => typeof slice?.start === "number" && FIELDS.every((field) => valid(slice[field])))
      .sort((a, b) => a.start - b.start)
      .slice(-TREND_SLICES);
  }
}
