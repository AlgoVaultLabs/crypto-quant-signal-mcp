/**
 * regime-served-windows.ts — REGIME-15M-SERVE-W1 CH1. The windows get_market_regime SERVES, per timeframe, in bars.
 * DATA ONLY: its one import is `CANDLE_COUNTS`, so `tool-param-schema.ts` (which the docs builders load from dist)
 * can derive get_market_regime's timeframe enum from here without pulling in the classifier (pinned by
 * tests/unit/serving-windows.test.ts, which walks that closure). The fetch lives in `regime-served-fetch.ts`.
 *
 * Why a registry of its own. The 1h, 4h and 1d windows are declared in `serving-windows.ts` (`CANDLE_COUNTS`) and
 * turned into a fetch window by `regimeFetchWindow` (`market-regime-core.ts`). Both files are sha256-pinned by
 * T9's registration (vault audits/regime-confirmation-preregistration-2026-11-17.md, "Outside the harness"), whose
 * guard hashes them on disk at its 2027-06-16 read, so neither can gain a 15m row. This module serves every
 * CANDLE_COUNTS entry by reference (the same numbers, never copies) plus 15m.
 *
 * 15m = 100 bars — EDGE-REGIME-15M-BACKTEST-W1's registered window (`REGIME_15M_WINDOW_BARS`); the served 15m read
 * is the window that backtest scored. 100 × 15m spans exactly get_trade_call's 15m window (trade_call@100), so
 * contract-suite S and `HEAD_STALE_BARS['15m']` already cover it on every venue, with no edit to the pinned registry.
 *
 * The snapshot-fed tools (scan_market_regimes, pre_trade_check, the sampler, the regime track record) do NOT read
 * this: they serve `REGIME_SNAPSHOT_TIMEFRAMES`, the set the sampler writes (G2 keeps 15m snapshots out of scope).
 */
import { CANDLE_COUNTS } from './serving-windows.js';

/**
 * Bars per served timeframe, ordered by bar duration (finest first). `CANDLE_COUNTS` is already in duration order
 * and 15m is finer than all of it, so a leading 15m keeps the order; tests/unit/regime-served-windows.test.ts
 * asserts it against `intervalMsFor`.
 */
export const REGIME_SERVED_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  '15m': 100,
  ...CANDLE_COUNTS,
});

/** The timeframes get_market_regime serves, in duration order. `REGIME_TIMEFRAMES` (tool-param-schema.ts) IS this array. */
export const REGIME_SERVED_TIMEFRAMES: readonly string[] = Object.freeze(Object.keys(REGIME_SERVED_WINDOWS));
