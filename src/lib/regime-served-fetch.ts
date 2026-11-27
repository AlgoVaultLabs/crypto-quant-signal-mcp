/**
 * regime-served-fetch.ts — REGIME-15M-SERVE-W1 CH1. The fetch window get_market_regime asks a venue for.
 *
 * For every timeframe the pinned `regimeFetchWindow` (market-regime-core.ts) declares — 1h, 4h and 1d today — this
 * RETURNS `regimeFetchWindow(timeframe, nowMs)` itself, so those windows are byte-identical by construction, not by a
 * copied formula. For a timeframe only `REGIME_SERVED_WINDOWS` declares (15m), it applies the same formula on that
 * row: `startTime = nowMs − bars × intervalMsFor(tf)`. Anything else goes to `regimeFetchWindow`, which throws
 * exactly as it always has.
 *
 * Split from the data module (regime-served-windows.ts) so the timeframe enum's import closure stays free of the
 * classifier (tests/unit/serving-windows.test.ts).
 */
import { regimeFetchWindow, type RegimeFetchWindow } from './market-regime-core.js';
import { servingWindowBars } from './serving-windows.js';
import { intervalMsFor } from './candle-guard.js';
import { REGIME_SERVED_WINDOWS } from './regime-served-windows.js';

export function regimeServedFetchWindow(timeframe: string, nowMs: number): RegimeFetchWindow {
  // regimeFetchWindow's own test of "declared": the market_regime row of the pinned registry.
  if (servingWindowBars('market_regime', timeframe) !== undefined) return regimeFetchWindow(timeframe, nowMs);
  const candleCount = Object.hasOwn(REGIME_SERVED_WINDOWS, timeframe) ? REGIME_SERVED_WINDOWS[timeframe] : undefined;
  const intervalMs = intervalMsFor(timeframe);
  if (candleCount === undefined || intervalMs === null) return regimeFetchWindow(timeframe, nowMs); // throws, verbatim
  return { candleCount, intervalMs, startTime: nowMs - candleCount * intervalMs };
}
