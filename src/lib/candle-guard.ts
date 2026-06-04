/**
 * Pure candle-sufficiency helpers (TRADFI-SIGNAL-HARDENING-W1).
 *
 * When a new listing (e.g. a pre-IPO perp 2 days post-launch) has fewer than
 * the required candles at the requested timeframe, the tools throw a structured
 * `INSUFFICIENT_CANDLES` error. This module computes the recovery hint: which
 * FINER timeframes already have enough candles, given the listing age.
 *
 * No I/O, no state — test-importable per the CLAUDE.md pure-constants rule.
 */

/** Interval ms for every timeframe the tools accept (mirrors getIntervalMs in the tools). */
const TF_INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
};

/**
 * Analysis-grade timeframe ladder, largest interval first. We only suggest
 * timeframes from this set (not the micro 1m/3m/5m bands) because TA on a
 * 1m chart of a 2-day-old synthetic-mark perp is noise, not recovery. This is
 * a deliberate, documented bound — NOT a silent numeric truncation.
 */
const SUGGESTION_LADDER_DESC: readonly string[] = ['1d', '4h', '2h', '1h', '30m', '15m'];

/** Interval ms for a timeframe, or `null` if unrecognized. */
export function intervalMsFor(tf: string): number | null {
  return TF_INTERVAL_MS[tf] ?? null;
}

/**
 * Given the first available candle's timestamp and the guard minimum, return
 * the analysis-grade timeframes (largest-first) FINER than the requested one
 * whose expected candle count already meets `requiredCandles`.
 *
 * The requested timeframe failed precisely because its expected count is below
 * the minimum; only FINER timeframes can have accumulated enough candles over
 * the same listing age, so coarser-or-equal timeframes are excluded.
 *
 * Returns `[]` when the listing is too young for even the finest analysis-grade
 * timeframe (15m) to qualify — the caller surfaces a "wait for more candles"
 * action in that case.
 */
export function computeSuggestedTimeframes(opts: {
  firstCandleTimeMs: number;
  nowMs: number;
  requiredCandles: number;
  requestedTimeframe: string;
}): string[] {
  const ageMs = Math.max(0, opts.nowMs - opts.firstCandleTimeMs);
  const requestedMs = intervalMsFor(opts.requestedTimeframe);

  return SUGGESTION_LADDER_DESC.filter((tf) => {
    const ms = TF_INTERVAL_MS[tf];
    if (ms === undefined) return false;
    // Only timeframes strictly FINER than the (failed) requested one.
    if (requestedMs !== null && ms >= requestedMs) return false;
    const expected = Math.floor(ageMs / ms);
    return expected >= opts.requiredCandles;
  });
}

/**
 * Build the `suggested_action` recovery sentence from the computed timeframe
 * list. Points at the LARGEST qualifying timeframe (most TA signal per bar).
 */
export function suggestedActionFor(suggestedTimeframes: string[]): string {
  if (suggestedTimeframes.length === 0) {
    return 'Listing is too new for reliable analysis at any timeframe; retry once more candles accumulate.';
  }
  return `Retry with timeframe=${suggestedTimeframes[0]}`;
}
