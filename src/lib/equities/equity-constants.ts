/**
 * EQUITIES-ENGINE-W1 — frozen Phase-1 constants (pure data, test-importable).
 *
 * Values frozen in C1 from live Databento EQUS.MINI probes
 * (audits/EQUITIES-ENGINE-W1-contracts.md). No I/O here.
 */

/** Databento dataset + schema (Phase 1 = daily bars only). */
export const DATABENTO_DATASET = 'EQUS.MINI';
export const DATABENTO_SCHEMA = 'ohlcv-1d';
export const DATABENTO_HOST = 'https://hist.databento.com/v0';
/** EQUS.MINI raw_symbol uses the Nasdaq convention (BRK.B style). */
export const DATABENTO_STYPE_IN = 'raw_symbol';
/** Earliest available EQUS.MINI history (probed dataset_range). */
export const DATABENTO_HISTORY_START = '2023-03-28';

/** Composite-universe size (top-N by median daily dollar volume). */
export const UNIVERSE_TOP_N = 500;

/**
 * ETF whitelist — index ETFs + crypto-proxy ETFs + a Korea ETF — always in the
 * universe regardless of ADV rank. All 8 live-verified to resolve in EQUS.MINI
 * (C1 probe 2026-06-04). `is_etf = true` for these rows.
 */
export const ETF_WHITELIST: readonly string[] = [
  'SPY', 'QQQ', 'IWM', 'DIA',     // broad index ETFs
  'IBIT', 'FBTC', 'ETHA',         // crypto-proxy ETFs (BTC/ETH spot)
  'EWY',                          // iShares MSCI South Korea
] as const;

/** Universe-build lookback: median daily $-volume over this many calendar days. */
export const UNIVERSE_LOOKBACK_DAYS = 130;   // ~90 trading sessions
/** Backfill depth for universe symbols (calendar days ≈ 2y). */
export const BACKFILL_DAYS = 760;            // ~2 years of sessions

/** Engine identity stamped on every verdict row. */
export const ENGINE_VERSION = 'equities-v1';

/** PFE (Peak Favorable Excursion) evaluation horizon, in trading sessions. */
export const PFE_HORIZON_SESSIONS = 5;

/**
 * Gap-quarantine (used because adjustment factors are NOT entitled on the
 * usage-based plan — C1 ADJUSTMENT_FACTORS: NO-GO). An unexplained overnight
 * absolute gap larger than this fraction marks the symbol quarantined.
 */
export const GAP_QUARANTINE_PCT = 0.18;       // 18%
/** Fresh sessions required to re-warm a quarantined symbol. */
export const QUARANTINE_REWARM_SESSIONS = 20;
