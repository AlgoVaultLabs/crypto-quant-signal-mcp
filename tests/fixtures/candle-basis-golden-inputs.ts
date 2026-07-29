/**
 * candle-basis-golden-inputs.ts — SIGNAL-CLOSEDBAR-SHADOW-W1 CH2 Step 2.0
 *
 * Deterministic inputs behind the golden envelope fixture
 * (`tests/fixtures/get-trade-call-golden-preclosedbar.json`).
 *
 * NOT a test file: vitest's `include` is anchored at `tests/**\/*.{test,spec}.…`
 * (vitest.config.ts), so this module is imported, never collected.
 *
 * ── Why every number here is an integer literal ───────────────────────────────
 * AC1 deep-equals a COMMITTED envelope, so these inputs must produce bit-identical
 * output on macOS-local and ubuntu-CI alike. `Math.sin`/`Math.cos` are NOT correctly
 * rounded in ECMAScript (§21.3.2 — "implementation-approximated"), so a V8/libm
 * difference of one ulp in a close price would propagate through RSI/EMA into
 * `confidence` and break the fixture on CI only. The closes below are therefore a
 * pure integer recurrence: exactly representable, and IEEE-754 +−×÷ on them is
 * fully specified. (The existing envelope suite uses `Math.sin`, but it only
 * asserts SHAPE, never a byte-identical value — a weaker contract than AC1's.)
 *
 * ── Why the volume profile is shaped the way it is ───────────────────────────
 * This single input set has to satisfy AC1, AC2 and AC3 at once:
 *
 *   live basis  : avg over all 100 bars = 997.6 ; last = 160  (the PARTIAL bar)
 *                 volRatio = 0.160 → ≤ 0.50 → volumeScore = −70   (ladder FLOOR)
 *   closed basis: avg over the 99 closed  = 1006.06 ; last = 1600 (last CLOSED bar)
 *                 volRatio = 1.590 → > 1.50 → volumeScore = +50
 *
 * −70 is one of the ladder's six values and NOT the `avgCandleVol <= 0` default of
 * 0, which is what makes AC1 non-vacuous. −70 vs +50 is a material divergence,
 * which is what makes AC3 prove the fix is not a no-op. And because bar 99 stays
 * open at every `nowMs` inside its own bar, the closed-basis score is constant
 * across the bar — AC2.
 *
 * This is the diagnostic's defect reproduced exactly: a bar 10% elapsed scores the
 * FLOOR on volume (20% of model weight) purely because it is young.
 */
import type { Candle, AssetContext } from '../../src/types.js';

/** 2026-07-29T12:06:00Z — 6 minutes into the 12:00 1h bar ⇒ elapsedFraction 0.10. */
export const GOLDEN_NOW_MS = Date.UTC(2026, 6, 29, 12, 6, 0);
/** Open of the newest (in-progress) bar. */
export const GOLDEN_PARTIAL_BAR_OPEN_MS = Date.UTC(2026, 6, 29, 12, 0, 0);

export const GOLDEN_COIN = 'BTC';
export const GOLDEN_TIMEFRAME = '1h';
export const GOLDEN_INTERVAL_MS = 3_600_000;

/** 100 bars: indices 0..98 are CLOSED, index 99 is the in-progress bar. */
export const GOLDEN_CANDLE_COUNT = 100;
export const GOLDEN_LAST_CLOSED_INDEX = 98;
export const GOLDEN_PARTIAL_INDEX = 99;

/** Expected volume scores — asserted directly so a silent ladder change is caught. */
export const GOLDEN_VOL_SCORE_LIVE = -70;
export const GOLDEN_VOL_SCORE_CLOSED = 50;
/** The six values the volume ladder can produce; 0 is the `avgCandleVol <= 0` default. */
export const VOLUME_LADDER_VALUES = [100, 80, 50, 10, -30, -70] as const;

/**
 * Integer close price for bar `i`. `(i * 37) % 41` is a full-period walk over
 * 0..40 (37 and 41 coprime, 41 prime), so the series oscillates without repeating
 * for the whole 100-bar window and every value lands in [2980, 3020].
 */
export function goldenClose(i: number): number {
  return 3000 + ((i * 37) % 41) - 20;
}

/** Volume for bar `i` — see the profile rationale in the file header. */
export function goldenVolume(i: number): number {
  if (i === GOLDEN_PARTIAL_INDEX) return 160; // in-progress: ~10% of a full bar
  if (i === GOLDEN_LAST_CLOSED_INDEX) return 1600; // last COMPLETE bar: a real surge
  return 1000;
}

/**
 * The golden candle array, ascending. Bar `i` OPENS at
 * `GOLDEN_PARTIAL_BAR_OPEN_MS - (99 - i) * 3_600_000`, so bar 99 opens exactly at
 * `GOLDEN_PARTIAL_BAR_OPEN_MS` and is still open at `GOLDEN_NOW_MS`.
 */
export function goldenCandles(count: number = GOLDEN_CANDLE_COUNT): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = goldenClose(i);
    return {
      open: close - 2,
      high: close + 10,
      low: close - 10,
      close,
      volume: goldenVolume(i),
      time: GOLDEN_PARTIAL_BAR_OPEN_MS - (count - 1 - i) * GOLDEN_INTERVAL_MS,
    };
  });
}

/**
 * Fixed asset context. `fundingAnnualized` is written as the literal 0.0876 rather
 * than `0.00001 * 8760` so the value cannot depend on float multiply ordering; it
 * sits in [0, 4.38) ⇒ fundingScore 0. `prevDayPx` 3000 vs a last close of 2994
 * ⇒ priceChange −0.002 ⇒ oiScore −20 (openInterest > 0).
 */
export function goldenAssetContext(coin: string = GOLDEN_COIN): AssetContext {
  return {
    coin,
    funding: 0.00001,
    fundingAnnualized: 0.0876,
    openInterest: 5_000_000,
    prevDayPx: 3000,
    volume24h: 125_000_000,
    oraclePx: 2994,
    markPx: 2994,
  };
}
