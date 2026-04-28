/**
 * Indicator-bucketing helpers for the v1.10.0 trade-call output sanitization.
 *
 * Why this bucketing: closes moat-1 (composite-verdict quant weighting) leakage
 * by converting raw scoring inputs (Hurst exponent, Funding-Z, BB/Keltner squeeze)
 * to coarse public-facing buckets. Agents reading the response see direction +
 * conviction prose without enough numeric texture to reverse-engineer the
 * weighting function or rebuild the scoring system locally.
 *
 * All three functions are PURE: deterministic given inputs, no I/O, no random,
 * no side-effects. Easy to unit-test exhaustively.
 */

/** Trend-persistence bucket derived from Hurst exponent. Public-facing enum. */
export type TrendPersistence = 'LOW' | 'MEDIUM' | 'HIGH';

/** Funding-pressure bucket derived from |z| of cross-venue funding. Public-facing enum. */
export type FundingState = 'NORMAL' | 'ELEVATED' | 'EXTREME';

/** Bollinger/Keltner squeeze enum. 'FIRING' reserved for future when an active-breakout signal lands. */
export type BreakoutPending = 'INACTIVE' | 'IMMINENT';

/**
 * Hurst exponent → trend-persistence bucket.
 *
 * - hurst < 0.45 → LOW (mean-reverting regime; reversion plays preferred)
 * - 0.45 ≤ hurst ≤ 0.55 → MEDIUM (random walk; no persistence edge)
 * - hurst > 0.55 → HIGH (trending; momentum continuations preferred)
 *
 * Boundary convention: BOTH 0.45 AND 0.55 map to MEDIUM (inclusive both sides
 * of the random-walk band). Chosen because Hurst at the literal boundary is
 * statistically indistinguishable from random; biasing it to the adjacent
 * trending/mean-reverting bucket would be over-claiming.
 *
 * `null` → MEDIUM (insufficient data — neutral default; we don't claim a
 * regime we can't measure).
 */
export function bucketTrendPersistence(hurst: number | null): TrendPersistence {
  if (hurst === null) return 'MEDIUM';
  if (hurst < 0.45) return 'LOW';
  if (hurst > 0.55) return 'HIGH';
  return 'MEDIUM';
}

/**
 * Funding-Z absolute value → funding-pressure state.
 *
 * - |z| ≤ 1.5 → NORMAL (within typical funding range; no crowd pressure)
 * - 1.5 < |z| ≤ 2.5 → ELEVATED (one-sided crowd; potential mean-reversion)
 * - |z| > 2.5 → EXTREME (heavy one-sided crowd; counter-trend setups favored)
 *
 * Boundary convention: 1.5 → NORMAL (inclusive lower band), 2.5 → ELEVATED
 * (inclusive lower band of ELEVATED). Symmetry-aware: takes |z| so positive
 * AND negative funding pressure map to the same bucket. Direction is derived
 * separately from `funding_rate` sign.
 *
 * `null` → NORMAL (insufficient data — neutral default).
 */
export function bucketFundingState(z: number | null): FundingState {
  if (z === null) return 'NORMAL';
  const absZ = Math.abs(z);
  if (absZ <= 1.5) return 'NORMAL';
  if (absZ <= 2.5) return 'ELEVATED';
  return 'EXTREME';
}

/**
 * Bollinger/Keltner squeeze boolean → breakout-pending enum.
 *
 * - false → INACTIVE (no compression detected; volatility neither expanding nor pent)
 * - true  → IMMINENT (compression detected; breakout setup pending direction)
 *
 * 'FIRING' is reserved for a future enum value when we ship active-breakout
 * detection (squeeze RELEASE event with directional confirmation). Not used in v1.10.0.
 */
export function bucketBreakoutPending(squeezeActive: boolean): BreakoutPending {
  return squeezeActive ? 'IMMINENT' : 'INACTIVE';
}
