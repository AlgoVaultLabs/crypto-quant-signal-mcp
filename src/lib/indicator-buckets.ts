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

/**
 * Funding-pressure bucket derived from |z| of cross-venue funding. Public-facing enum.
 * `FIXED_PREIPO` (TRADIFI-SIGNAL-HARDENING-W1) is a TradFi override, NOT a z-score
 * bucket: pre-IPO perp funding is administratively fixed (+0.005%/8h on Binance),
 * so it is never produced by `bucketFundingState` — it is set explicitly by the
 * tool when the underlying asset class is PREMARKET.
 */
export type FundingState = 'NORMAL' | 'ELEVATED' | 'EXTREME' | 'FIXED_PREIPO';

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

// ── v1.10.0 sanitized-reasoning prose helpers ──
// Pure string-mapping functions: 2–4 branches each, deterministic given inputs,
// no numbers/thresholds/point-values/raw-indicator-echoes. Each helper returns
// a sentence ending in a period, intended to compose via space-join.
//
// Allowed prose patterns: bucket-name reference, direction/conviction language.
// FORBIDDEN: any decimal number, "boosted N pts", "RSI at <num>", "Hurst <num>",
// "Funding Z-Score", "Confidence: <num>", "Regime: TRENDING/RANGING/VOLATILE"
// (redundant restatement of regime field that's already in the JSON).
import type { RegimeType } from '../types.js';

export function regimeProse(regime: RegimeType): string {
  switch (regime) {
    case 'TRENDING_UP':   return 'Trending regime, upward bias.';
    case 'TRENDING_DOWN': return 'Trending regime, downward bias.';
    case 'RANGING':       return 'Ranging regime, no clear direction.';
    case 'VOLATILE':      return 'Volatile regime, directional uncertainty.';
  }
}

export function fundingProse(state: FundingState): string {
  switch (state) {
    case 'NORMAL':       return 'Funding pressure mild.';
    case 'ELEVATED':     return 'Funding pressure elevated; one-sided crowd forming.';
    case 'EXTREME':      return 'Funding pressure extreme; heavy one-sided crowd.';
    case 'FIXED_PREIPO': return 'Funding is fixed pre-IPO; not a market-sentiment signal.';
  }
}

export function breakoutProse(state: BreakoutPending): string {
  switch (state) {
    case 'INACTIVE': return 'Volatility neither expanding nor compressed.';
    case 'IMMINENT': return 'Compression building, breakout setup pending.';
  }
}

export function trendProse(state: TrendPersistence): string {
  switch (state) {
    case 'LOW':    return 'Trend persistence low; mean-reverting structure.';
    case 'MEDIUM': return 'Trend persistence balanced.';
    case 'HIGH':   return 'Trend persistence elevated; momentum structure.';
  }
}

import type { SignalVerdict } from '../types.js';

/**
 * Conviction prose derived from verdict + confidence bucket. Confidence is
 * bucketed into LOW/MEDIUM/HIGH internally to avoid leaking the literal numeric
 * value (CIs read the integer from the `confidence` field of the JSON; the
 * prose describes conviction qualitatively).
 *
 * Buckets:
 *   - LOW    : confidence < 40
 *   - MEDIUM : 40 ≤ confidence ≤ 65
 *   - HIGH   : confidence > 65
 */
export function convictionProse(verdict: SignalVerdict, confidence: number): string {
  const bucket: 'LOW' | 'MEDIUM' | 'HIGH' = confidence < 40 ? 'LOW' : confidence > 65 ? 'HIGH' : 'MEDIUM';
  if (verdict === 'HOLD') {
    if (bucket === 'LOW')    return 'No actionable setup at this snapshot.';
    if (bucket === 'MEDIUM') return 'Conditions mixed; better setups likely available elsewhere.';
    return 'Conditions clearly inactive on this pair.';
  }
  // BUY / SELL
  if (bucket === 'LOW')    return 'Low conviction; directional cue but mixed supporting signals.';
  if (bucket === 'MEDIUM') return 'Moderate conviction from blended signals.';
  return 'Strong conviction from aligned signals.';
}
