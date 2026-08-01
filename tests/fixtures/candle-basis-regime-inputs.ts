/**
 * candle-basis-regime-inputs.ts — SIGNAL-CLOSEDBAR-SHADOW-W1 CH3
 *
 * Deterministic inputs behind the golden envelope fixture for `get_market_regime`
 * (`tests/fixtures/get-market-regime-golden-preclosedbar.json`).
 *
 * NOT a test file — vitest's `include` is anchored at `tests/**\/*.{test,spec}.…`,
 * so this module is imported, never collected.
 *
 * ── Why a SEPARATE input set from CH2's ──────────────────────────────────────
 * CH2's `candle-basis-golden-inputs.ts` is FROZEN: its numbers are the recorded
 * pre-image of `get-trade-call-golden-preclosedbar.json`, so editing them would
 * break CH2's AC1 rather than serve CH3's AC3. CH3 needs a differently-shaped
 * series (below), so it gets its own inputs and imports only the CLOCK constants
 * from CH2 — one clock story, single-derivation.
 *
 * ── The defect this series reproduces ────────────────────────────────────────
 * CH2's defect was the volRatio ladder scoring a young bar's small volume as the
 * FLOOR. `get_market_regime` never touches that ladder — it maps `volumes` into
 * `detectPriceStructure`, so its failure mode is DIFFERENT and had to be measured
 * rather than assumed (diagnostic §9). What it actually is:
 *
 *   `detectPriceStructure` finds 3-bar pivots with `for (i = 1; i < len - 1; i++)`
 *   — the LAST bar is never a pivot candidate, it is the right-hand CONFIRMING
 *   shoulder. Under the live basis that confirming shoulder is the IN-PROGRESS
 *   bar, so bar `n-2` is published as a confirmed, volume-weighted pivot on the
 *   strength of a high that is still forming and can still be exceeded.
 *
 * Bar 98 below is exactly that: a high-volume swing high that only qualifies as a
 * pivot because the unfinished bar 99 sits to its right. Drop the partial bar and
 * bar 98 becomes the final bar — excluded from the loop, no longer a pivot. So the
 * divergence is STRUCTURAL (which bars are eligible), not a rounding artefact:
 *
 *   live basis  : 100 bars, i ∈ [1, 98] ⇒ bar 98 IS a pivot (score ≈ 0.83)
 *   closed basis:  99 bars, i ∈ [1, 97] ⇒ bar 98 is NOT a pivot
 *
 * and it surfaces in the PUBLIC envelope at `metrics.pivot_quality` (AC3).
 *
 * ── Why every number is an integer literal ───────────────────────────────────
 * Same reason as CH2: AC2 deep-equals a COMMITTED envelope, and `Math.sin`/`cos`
 * are implementation-approximated in ECMAScript (§21.3.2), so a one-ulp libm
 * difference would break the fixture on ubuntu-CI while passing on macOS. Integer
 * closes are exactly representable and IEEE-754 +−×÷ on them is fully specified.
 */
import type { Candle } from '../../src/types.js';
import { GOLDEN_NOW_MS, GOLDEN_PARTIAL_BAR_OPEN_MS, GOLDEN_INTERVAL_MS } from './candle-basis-golden-inputs.js';

export { GOLDEN_NOW_MS, GOLDEN_PARTIAL_BAR_OPEN_MS, GOLDEN_INTERVAL_MS };

export const REGIME_COIN = 'BTC';
/** '1h' so the fixture's bar clock matches CH2's `GOLDEN_INTERVAL_MS`. */
export const REGIME_TIMEFRAME = '1h';
export const REGIME_EXCHANGE = 'BINANCE';

/** 100 bars: indices 0..98 CLOSED, index 99 in-progress (10% elapsed at `GOLDEN_NOW_MS`). */
export const REGIME_CANDLE_COUNT = 100;
export const REGIME_LAST_CLOSED_INDEX = 98;
export const REGIME_PARTIAL_INDEX = 99;

/**
 * The premature pivot. Bar 98 is a volume-confirmed swing high ONLY while the
 * in-progress bar 99 exists to its right.
 */
export const REGIME_PIVOT_INDEX = 98;
export const REGIME_PIVOT_CLOSE = 3030;
export const REGIME_PIVOT_VOLUME = 2000;
/** Bars 97 and 99 sit BELOW the pivot on both sides, which is what makes it a pivot. */
export const REGIME_SHOULDER_CLOSE = 2990;
/** The in-progress bar's volume — young, hence small. Never used as a pivot's own volume. */
export const REGIME_PARTIAL_VOLUME = 200;

/**
 * Integer close for bar `i`. Bars 0..96 walk `(i * 37) % 41` — a full-period
 * sequence (37, 41 coprime; 41 prime) that steps −4 and wraps +37, producing a
 * descending sawtooth whose turning points are ~10 qualified swing highs and ~10
 * qualified swing lows. That pool matters: `detectPriceStructure` falls back to
 * the volume-BLIND `detectPriceStructureSimple` when either side has < 2 pivots,
 * and this chapter is specifically about the volume-weighted path.
 */
export function regimeClose(i: number): number {
  if (i === REGIME_PIVOT_INDEX) return REGIME_PIVOT_CLOSE;
  if (i === REGIME_PIVOT_INDEX - 1 || i === REGIME_PARTIAL_INDEX) return REGIME_SHOULDER_CLOSE;
  return 3000 + ((i * 37) % 41) - 20;
}

/** Volume for bar `i`. Flat 1000 except the pivot's surge and the young partial bar. */
export function regimeVolume(i: number): number {
  if (i === REGIME_PIVOT_INDEX) return REGIME_PIVOT_VOLUME;
  if (i === REGIME_PARTIAL_INDEX) return REGIME_PARTIAL_VOLUME;
  return 1000;
}

/**
 * The regime candle array, ascending. Bar `i` opens at
 * `GOLDEN_PARTIAL_BAR_OPEN_MS - (count - 1 - i) * GOLDEN_INTERVAL_MS`, so bar 99
 * opens exactly at `GOLDEN_PARTIAL_BAR_OPEN_MS` and is still open at `GOLDEN_NOW_MS`.
 */
export function regimeCandles(count: number = REGIME_CANDLE_COUNT): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = regimeClose(i);
    return {
      open: close - 2,
      high: close + 10,
      low: close - 10,
      close,
      volume: regimeVolume(i),
      time: GOLDEN_PARTIAL_BAR_OPEN_MS - (count - 1 - i) * GOLDEN_INTERVAL_MS,
    };
  });
}
