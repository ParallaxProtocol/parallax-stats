// How many confirmations make a payment safe against a miner trying to
// replace it, by the calculation in section 11 of the Bitcoin paper. The
// attacker is assumed to have the largest miner's share of the hashrate.

/** Confidence levels the dashboard reports, as the chance an attack fails. */
export const CONFIDENCE = [0.99, 0.999, 0.9999] as const;

/** Above this many confirmations, the answer is reported as "more than". */
export const MAX_CONFIRMATIONS = 1000;

/**
 * attackerSuccess is the chance that a miner with share `q` of the
 * hashrate, mining a competing chain in secret, ever catches up once the
 * payment has `z` confirmations. The Poisson terms are worked out as
 * logarithms, so a large `z` does not underflow.
 */
export function attackerSuccess(q: number, z: number): number {
  if (q <= 0) return 0;
  if (q >= 0.5) return 1;

  const p = 1 - q;
  const lambda = z * (q / p);
  let sum = 1;
  // ln(k!), built up as k grows
  let lnFactorial = 0;

  for (let k = 0; k <= z; k++) {
    if (k > 0) lnFactorial += Math.log(k);

    const poisson = Math.exp(-lambda + (k === 0 ? 0 : k * Math.log(lambda)) - lnFactorial);

    sum -= poisson * (1 - Math.pow(q / p, z - k));
  }

  return Math.max(0, sum);
}

/**
 * confirmationsFor is the fewest confirmations that keep a miner with share
 * `q` below a `1 - confidence` chance of success: null when no number does
 * (a majority), or when it would take more than MAX_CONFIRMATIONS.
 */
export function confirmationsFor(q: number, confidence: number): number | null {
  if (q >= 0.5) return null;

  const risk = 1 - confidence;

  for (let z = 0; z <= MAX_CONFIRMATIONS; z++) if (attackerSuccess(q, z) < risk) return z;

  return null;
}
