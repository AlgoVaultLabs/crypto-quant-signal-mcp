/**
 * serving-windows.ts — OPS-SERVED-CANDLE-TRUTH-W1 CH1. The ONE registry of every candle window the product asks a
 * venue for when it SERVES (a `getCandles` call with no `endTime`), plus the constants a serving read is judged by.
 * Pure data. Its only runtime import is the TIMEFRAMES leaf (capabilities.ts imports types only), so adapters, the
 * `getAdapter` seam, scripts and tests can all import it without a require cycle.
 *
 * Why it exists. Each consumer kept its window as a private literal — get_trade_call's `100`, the regime
 * `CANDLE_COUNTS`, rank-metrics' `ATRP_CANDLE_COUNT`, the sampler's 4-bar reference read, the labeler's 5-bar probe —
 * so no test could ask "is every window the product serves complete, on every venue?". Two of them were longer than
 * one venue request and were served stale with nothing watching: BITGET 1d@100 (the recent endpoint clips at 90 days,
 * so the window ended ~10 days before every call) and OKX 1h@168 (a 100-bar recent page, so the history fallback
 * served a window ending ~68 h before now). Consumers now import their window from here, value-identical, and
 * contract-suite scenario S (tests/unit/adapter-history-contract.test.ts) iterates this registry, so a future window
 * change re-tests every venue before it can deploy.
 *
 * Units. A `requested` window starts `bars × intervalMsFor(tf)` before now, as every consumer but one computes it. A
 * `served` window starts `bars × servedCandleStepMs(venue, tf)` before now: the labeler's probe counts the venue's
 * own bars.
 */
import { TIMEFRAMES } from './capabilities.js';

export type ServingConsumer = 'trade_call' | 'market_regime' | 'atrp_lens' | 'regime_reference' | 'labeler_probe';
export type ServingWindowUnit = 'requested' | 'served';

/** get_trade_call and every scan_trade_calls cell: one flat window on every timeframe. */
export const TRADE_CALL_CANDLE_COUNT = 100;

/**
 * get_market_regime and the regime snapshot sampler: how many candles to fetch per timeframe. A LOOKBACK WINDOW in
 * bars, never a row limit: `regimeFetchWindow` (src/lib/market-regime-core.ts) turns it into `startTime`, and
 * `getCandles` has no limit parameter. Moved here from market-regime-core.ts by reference, values unchanged; that
 * module and get-market-regime.ts re-export it.
 *
 *   '1h' 168 = 7 × 24 · '4h' 42 = 7 × 6.
 *   '1d' 100 — SIGNAL-TREND-BLINDNESS-FIX-W1 CH1: 30 -> 100.
 *
 * At 30 this tool was DEAD at 1d on every startTime-honouring venue, and had been since the CANDLE_BASIS=closed flip.
 * The cause is the venue BOUNDARY BAR, not a limit: Hyperliquid's candleSnapshot INCLUDES the bar containing
 * `startTime` (window+1 rows) while Binance's `openTime >= startTime` EXCLUDES it (window rows). Measured with the
 * exact windows this code computes: 1d -> HL raw 31 / closed 30 (passed with ZERO margin), Binance raw 30 / closed 29
 * (threw `INSUFFICIENT_CANDLES: 29 / 30`). One bar of venue disagreement against zero headroom.
 *
 * 100 matches get_trade_call's flat window and clears REQUIRED_CANDLES by 69 bars under either venue semantic. It is
 * NOT inside every venue's single-request reach. That wave's note said "inside every adapter's own kline cap (the
 * tightest is OKX at 100)", and it was false for BITGET 1D: Bitget's recent endpoint returns at most 90 days, so this
 * window ended ~10 days before now on every BITGET 1d regime read (OPS-SERVED-CANDLE-TRUTH-W1 R0 E6). The window is
 * now completed by the serving assembler (src/lib/adapters/_history-plan.ts `assembleServingWindow`), and a window
 * that still comes back stale is refused at the `getAdapter` seam. Whether a window fits one request is now a
 * measured property of the venue, re-tested by suite S, and never an assumption written down here.
 *
 * '1h' and '4h' are deliberately UNTOUCHED. 4h is the default timeframe and 42 -> 100 would move adx / trend_strength
 * / confidence on the most-used path: Wilder's ADX is a recursive smoother whose seed residual after k = N-28 steps is
 * (13/14)^k, i.e. 35.4% contamination at 42 bars against 0.48% at 100. That is a real improvement and a deliberate
 * decision with its own before/after, not a side effect of a 1d bugfix -> SIGNAL-REGIME-WILDER-SEED-4H-W{NEXT}.
 */
export const CANDLE_COUNTS: Readonly<Record<string, number>> = Object.freeze({
  '1h': 168,
  '4h': 42,
  '1d': 100,
});

/** The ATRP rank lens (scan_trade_calls volatility rank). ATR(14) needs 15; 50 → a well-converged Wilder ATR + venue-count buffer. */
export const ATRP_CANDLE_COUNT = 50;

/** The regime sampler's short reference read: each venue's own record of its newest closed bar. Binance returned only
 *  2 bars at 3 intervals (R0), so 4. src/scripts/regime-snapshot-sampler.ts re-exports it. */
export const REGIME_REFERENCE_SHORT_BARS = 4;

/** The timeframes the regime sampler snapshots. They equal `REGIME_SNAPSHOT_TIMEFRAMES` (src/lib/regime-snapshots.ts).
 *  This leaf cannot import that module, because it loads performance-db, so tests/unit/serving-windows.test.ts pins
 *  the equality. */
const REGIME_REFERENCE_TIMEFRAMES = ['1h', '4h', '1d'] as const;

/** The directional labeler's `marketUnserved` probe (src/scripts/backfill-directional-labels.ts `recentPage`): 5 SERVED
 *  bars. That script is outside this registry's writers, so tests/unit/serving-windows.test.ts pins its literal. */
export const LABELER_PROBE_SERVED_BARS = 5;

export interface ServingWindowRow {
  readonly consumer: ServingConsumer;
  readonly unit: ServingWindowUnit;
  /** Bars per timeframe the consumer serves on. A timeframe absent here is one the consumer never asks for. */
  readonly bars: Readonly<Record<string, number>>;
}

const onEvery = (tfs: readonly string[], n: number): Readonly<Record<string, number>> =>
  Object.freeze(Object.fromEntries(tfs.map((tf) => [tf, n])));

const ROWS: ServingWindowRow[] = [
  { consumer: 'trade_call', unit: 'requested', bars: onEvery(TIMEFRAMES, TRADE_CALL_CANDLE_COUNT) },
  { consumer: 'market_regime', unit: 'requested', bars: CANDLE_COUNTS },
  { consumer: 'atrp_lens', unit: 'requested', bars: onEvery(TIMEFRAMES, ATRP_CANDLE_COUNT) },
  { consumer: 'regime_reference', unit: 'requested', bars: onEvery(REGIME_REFERENCE_TIMEFRAMES, REGIME_REFERENCE_SHORT_BARS) },
  { consumer: 'labeler_probe', unit: 'served', bars: onEvery(TIMEFRAMES, LABELER_PROBE_SERVED_BARS) },
];

/** Every serving window the product asks for, one row per consumer. */
export const SERVING_WINDOWS: readonly ServingWindowRow[] = Object.freeze(ROWS.map((r) => Object.freeze(r)));

/** Every declared window on `tf`, in registry order. The ONE own-key lookup into the registry: a prototype name
 *  ('constructor') is never a timeframe. Suite S, the differential and the live canary iterate it. */
export function servingWindowsFor(tf: string): { consumer: ServingConsumer; unit: ServingWindowUnit; bars: number }[] {
  return SERVING_WINDOWS.flatMap((r) => (Object.hasOwn(r.bars, tf) ? [{ consumer: r.consumer, unit: r.unit, bars: r.bars[tf] }] : []));
}

/** One consumer's window on `tf` in bars of its unit, or undefined when that consumer never asks for `tf`. */
export function servingWindowBars(consumer: ServingConsumer, tf: string): number | undefined {
  return servingWindowsFor(tf).find((w) => w.consumer === consumer)?.bars;
}

export interface ServingSpan { label: string; spanMs: number }

/**
 * The distinct serving windows on `tf`, in ms back from now. A `requested` window spans bars × `requestedStepMs`; a
 * `served` window spans bars × the venue's own `servedStepMs` (the requested step when null). Consumers whose windows
 * span the same time share one read, so they share one entry, labelled `consumer@bars+consumer@bars` in registry
 * order. The ONE derivation that contract-suite S, the Bitget/OKX differential (tests/harness/serving-spans.ts) and
 * the live canary's S probes (src/scripts/adapter-history-contiguity.ts) all read — moved here from the test harness
 * by OPS-SERVED-CANDLE-TRUTH-W1 CH2 so the canary cannot probe a different window set than the suite tests.
 */
export function servingSpans(tf: string, servedStepMs: number | null, requestedStepMs: number): ServingSpan[] {
  const seen = new Map<number, string>();
  for (const w of servingWindowsFor(tf)) {
    const spanMs = w.bars * (w.unit === 'served' ? (servedStepMs ?? requestedStepMs) : requestedStepMs);
    seen.set(spanMs, seen.has(spanMs) ? `${seen.get(spanMs)}+${w.consumer}@${w.bars}` : `${w.consumer}@${w.bars}`);
  }
  return [...seen].map(([spanMs, label]) => ({ label, spanMs }));
}

/**
 * The most requests ONE assembled serving read may make, the page already fetched included. Derived at R0 (vault
 * audits/OPS-SERVED-CANDLE-TRUTH-W1-endpoint-truth.md §3) as the max over the split venues of
 * ⌈window ÷ single-request reach⌉ + 1, both in served bars:
 *   Bitget 1d       ⌈100 / 90⌉ + 1 = 3   (the recent endpoint returns at most 90 days = 90 1D bars)
 *   Bitget sub-day  ⌈168 / 200⌉ + 1 = 2
 *   OKX             ⌈168 / 300⌉ + 1 = 2   (a serving read asks the recent endpoint's maximum, 300)
 * The + 1 is one page of slack. With it, a read can neither loop nor run past the budget the venue ledgers were
 * sized for. tests/unit/serving-windows.test.ts re-derives it from the registry and the adapters' declared reach.
 */
export const SERVING_MAX_PAGES = 3;

/**
 * The head-gap ceiling of a serving read per timeframe, in SERVED bars (`servedCandleStepMs`). A serving read whose
 * newest bar is more than HEAD_STALE_BARS[tf] closed served bars behind now is refused at the `getAdapter` seam with
 * StaleUpstreamWindowError (src/lib/exchange-adapter.ts). A timeframe absent here is never judged.
 *
 * Calibrated, not chosen. OPS-SERVED-CANDLE-TRUTH-W1 R0 P6, 2026-10-22, by the pre-registered rule
 * `HEAD_STALE_BARS[tf] = max + 1` over the LEGITIMATE head gaps of the whole admitted universe.
 *   Instrument I2: operator Mac vantage, the shipped adapters (origin/main e3d722c6), batch class, every coin that
 *   `fetchVenueUniverse` admitted at 09:53Z (10,340 coins on 15 venues), each read at its largest serving window.
 *   Empty windows (INSUFFICIENT_CANDLES's) and the two defect pairs are excluded.
 * The binding maxima are KuCoin thin books (ETHBTC: 16 bars at 1h). Both defect pairs sit above their ceiling
 * (OKX 1h: 67 > 17; BITGET 1d: 9 > 1), so the rule separates them; identifiability check Q-K did not fire.
 * Re-calibrate only by re-running that census and recording its instrument here. Evidence: vault
 * audits/OPS-SERVED-CANDLE-TRUTH-W1-endpoint-truth.md §P6.
 */
export const HEAD_STALE_BARS: Readonly<Record<string, number>> = Object.freeze({
  '1m': 50,
  '3m': 40,
  '5m': 24,
  '15m': 68,
  '30m': 34,
  '1h': 17,
  '2h': 9,
  '4h': 4,
  '8h': 2,
  '12h': 1,
  '1d': 1,
});
