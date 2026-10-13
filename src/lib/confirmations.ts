// How many confirmations make a payment safe against a miner trying to
// replace it. Against a minority, by the chance it catches up in secret,
// worked out exactly (Rosenfeld, "Analysis of hashrate-based double
// spending", 2014) rather than by the Bitcoin paper's approximation, which
// understates it. That assumes the miner mined in secret all the while the
// payment was confirmed; one seen mining in the open meanwhile cannot have,
// beyond what it could hide from the watch, and starts nearly from scratch.
// Against a majority no wait is certain, so what counts is what reversing a
// payment would cost: the rewards of the blocks of its own that the miner
// throws away to do it.

import { OPEN_CHANCE, poissonAtMost, stretchWeight, WATCH_BLOCKS } from "./withholding.ts";

/** Confidence levels the dashboard reports, as the chance an attack fails. */
export const CONFIDENCE = [0.99, 0.999, 0.9999] as const;

/** Above this many confirmations, the answer is reported as "more than". */
export const MAX_CONFIRMATIONS = 1000;

/** The waits the cost of reversing a payment is reported for, against a majority. */
export const COST_DEPTHS = [6, 12, 24] as const;

/**
 * attackerSuccess is the chance that a miner with share `q` of the
 * hashrate ever replaces a payment with `z` confirmations, mining `hidden`
 * of its share in secret while they come (all of it unless said) and all of
 * it after. While the public chain finds those `z` blocks the secret one
 * finds `m`, negatively binomially distributed, and from `z - m` behind
 * catches up with chance (q/p)^(z - m). With all of its share hidden this
 * is Rosenfeld's; with none, it starts `z` behind. The terms are worked out
 * as logarithms, so a large `z` does not overflow.
 */
export function attackerSuccess(q: number, z: number, hidden = q): number {
  if (q <= 0) return 0;
  if (q >= 0.5) return 1;
  // With no confirmation the payment can be replaced outright
  if (z === 0) return 1;

  const ratio = q / (1 - q);
  const h = Math.min(q, Math.max(0, hidden));

  if (h === 0) return Math.pow(ratio, z);

  const lnPublic = Math.log(1 - h);
  const lnHidden = Math.log(h);
  let sum = 1;
  // ln C(m + z - 1, m), built up as m grows
  let lnChoose = 0;

  for (let m = 0; m < z; m++) {
    if (m > 0) lnChoose += Math.log(m + z - 1) - Math.log(m);

    sum -= Math.exp(lnChoose + z * lnPublic + m * lnHidden) * (1 - Math.pow(ratio, z - m));
  }

  return Math.min(1, Math.max(0, sum));
}

/**
 * hiddenShare is the most of its share `q` a miner could mine in secret
 * while a payment gets `z` confirmations and still, as a rule, be called
 * mining in the open by the watch: its blocks among them would come at
 * `q - h` of `1 - h`, against `q` expected, and pass for luck. The watch
 * sees no further back than WATCH_BLOCKS of its blocks.
 */
export function hiddenShare(q: number, z: number): number {
  if (q <= 0 || z === 0) return q;

  const window = Math.min(z, WATCH_BLOCKS / q);
  let low = 0;
  let high = q;

  for (let i = 0; i < 40; i++) {
    const h = (low + high) / 2;
    const seen = Math.floor(((q - h) * window) / (1 - h));
    const expected = (q * window) / (1 - h);

    if (stretchWeight(seen + 1) * poissonAtMost(seen, expected) >= OPEN_CHANCE) low = h;
    else high = h;
  }

  return low;
}

/**
 * confirmationsFor is the fewest confirmations that keep a miner with share
 * `q` below a `1 - confidence` chance of success: null when no number does
 * (a majority), or when it would take more than MAX_CONFIRMATIONS. With
 * `open`, for a miner seen mining in the open until the payment is
 * accepted, allowing for what it could hide meanwhile.
 */
export function confirmationsFor(q: number, confidence: number, open = false): number | null {
  if (q >= 0.5) return null;

  const risk = 1 - confidence;

  for (let z = 0; z <= MAX_CONFIRMATIONS; z++) if (attackerSuccess(q, z, open ? hiddenShare(q, z) : q) < risk) return z;

  return null;
}

/** The waits worked out so far, by share and whether the miner is seen in the open: near a majority they take a while. */
const WAITS = new Map<string, (number | null)[]>();

/** waitsFor is confirmationsFor at each of CONFIDENCE, remembered: the page asks every second. */
export function waitsFor(q: number, open: boolean): (number | null)[] {
  const key = `${q}:${open}`;
  let found = WAITS.get(key);

  if (!found) {
    found = CONFIDENCE.map((confidence) => confirmationsFor(q, confidence, open));
    // Shares change a block at a time: keep the latest few
    if (WAITS.size >= 32) WAITS.delete(WAITS.keys().next().value!);
    WAITS.set(key, found);
  }

  return found;
}

/**
 * reversalCost is what a miner with share `q` gives up to replace a payment
 * with `z` confirmations, in the unit of `pay`, what a block pays: about
 * `q` of the `z` blocks it replaces are its own, and their rewards go with
 * them. What it mines in secret meanwhile it would have earned anyway. It
 * leaves out what cannot be counted, such as the pool's miners leaving.
 */
export function reversalCost(q: number, z: number, pay: number): number {
  return q * z * pay;
}
