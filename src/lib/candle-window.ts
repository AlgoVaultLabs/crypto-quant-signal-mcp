/**
 * SIGNAL-CLOSEDBAR-SHADOW-W1 CH1 — the shared confirmed-bar candle-window primitive.
 *
 * Every indicator in this repo currently reads `candles[candles.length - 1]` — the
 * IN-PROGRESS bar. No primitive in `src/` knew what "closed" meant. (`isClosedState`
 * in `market-sessions.ts` is a TradFi *market-session* helper, NOT candle closure —
 * a confirmed false lead; do not re-chase it.)
 *
 * Why a primitive rather than an inline `slice(0, -1)` at each call site: the identical
 * partial-bar input reaches BOTH `src/tools/get-trade-call.ts` and
 * `src/tools/get-market-regime.ts`. Two independent re-derivations of "what is closed"
 * would drift, which is the bug class this wave exists to retire.
 *
 * The unit distinction that motivates all of it: a price is a LEVEL — valid at any
 * instant, so reading it from an unclosed bar is legitimate. A volume is an INTEGRAL
 * over the bar — only comparable when the integration windows match. Comparing a
 * partial integral against a mean of complete ones is a unit mismatch, not a design
 * choice.
 *
 * Contract: pure, zero I/O, zero environment reads, and a ZERO-DEPENDENCY LEAF — this
 * module imports nothing, by design and by gate. The bar interval is supplied by the
 * caller as a plain number; the canonical timeframe→ms table stays under the sole
 * ownership of `candle-guard.ts` (a second copy would be a third derivation of the
 * same table).
 */

/** The result of splitting a venue candle array into confirmed and in-progress parts. */
export interface CandleWindow<T> {
  /** Bars whose interval has fully elapsed. Safe for integral quantities (volume). */
  closed: T[];
  /** The in-progress bar, or `null` when the newest bar is already closed. */
  partial: T | null;
  /** How far into `partial` we are, clamped to `[0,1]`; `null` when `partial` is null. */
  elapsedFraction: number | null;
}

/**
 * Venue clocks and ours disagree by small amounts. A bar that *should* have closed
 * within this many ms is treated as closed rather than as a 0.0001-elapsed partial,
 * which would otherwise discard a genuinely complete bar.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 2_000;

/**
 * Split an ASCENDING (oldest-first) candle array into its confirmed and in-progress parts.
 *
 * A bar opening at `t` is CLOSED iff `t + intervalMs <= nowMs + CLOCK_SKEW_TOLERANCE_MS`.
 *
 * Ordering is validated rather than assumed: a descending array would silently mis-split
 * (treating the OLDEST bar as in-progress and discarding it), so it throws instead. Venues
 * differ on payload order and the existing call sites sort defensively before use.
 *
 * @param candles   Oldest-first bars. An empty array is valid and yields an empty window.
 * @param intervalMs Bar width in ms, resolved by the caller. Must be finite and > 0.
 * @param nowMs     Current wall-clock ms. Injected so callers stay deterministic in tests.
 * @throws If `candles` is not ascending, or `intervalMs` is not a positive finite number.
 */
export function splitCandleWindow<T extends { time: number }>(
  candles: T[],
  intervalMs: number,
  nowMs: number,
): CandleWindow<T> {
  if (candles.length === 0) {
    return { closed: [], partial: null, elapsedFraction: null };
  }

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(
      `splitCandleWindow: intervalMs must be a positive finite number, received ${String(intervalMs)}`,
    );
  }

  for (let i = 1; i < candles.length; i++) {
    if (candles[i].time < candles[i - 1].time) {
      throw new Error(
        `splitCandleWindow: candles must be ascending (oldest-first); ` +
          `index ${i} (time ${candles[i].time}) precedes index ${i - 1} (time ${candles[i - 1].time})`,
      );
    }
  }

  const newest = candles[candles.length - 1];
  const newestIsClosed = newest.time + intervalMs <= nowMs + CLOCK_SKEW_TOLERANCE_MS;

  // The venue omitted the in-progress bar (or it just closed). Keep the FULL array —
  // dropping a genuinely-closed newest bar would silently discard the freshest data.
  if (newestIsClosed) {
    return { closed: candles.slice(), partial: null, elapsedFraction: null };
  }

  const rawFraction = (nowMs - newest.time) / intervalMs;
  const elapsedFraction = Math.min(1, Math.max(0, rawFraction));

  return {
    closed: candles.slice(0, -1),
    partial: newest,
    elapsedFraction,
  };
}
