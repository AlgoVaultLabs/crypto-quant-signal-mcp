// regime-forward/forward-spec.ts — EDGE-REGIME-FORWARD-W1 (ARC-REGIME-ACCURACY T5): the registered constants.
//
// T5 scores the regime labels production SERVED (regime_snapshots) on bars after T3's registration: answers 4 and 5
// of T3 (audits/regime-diagnostic-preregistration-2026-11-16.md §4.8), per venue. Every constant here is a value of
// audits/regime-forward-preregistration-2026-11-18.md; tests/unit/regime-forward-spec.test.ts holds the two together
// and holds the host read (ops/monitoring/owed-read-regime-forward-30d.py) to the same window.
import { ALPHA, B_BOOT, B_PERM, B_SHUFFLE, FLOOR_PP, FLOOR_RATIO, TFS, type Tf, type Win } from '../regime-diag/diag-spec.js';

export const WAVE = 'EDGE-REGIME-FORWARD-W1';
export const REGISTRATION = 'audits/regime-forward-preregistration-2026-11-18.md';
/** The owed read whose PASS record carries the sha256 of every file this harness scores. */
export const READ_ID = 'regime-forward-30d';
export const READ_HOST = 'signal-1';
/** The host a test seam's record must name: a seam run refuses every record of READ_HOST (lesson 10). */
export const SEAM_HOST = 'sandbox';
/**
 * What a test seam's snapshot carries in every row's `computed_at` and every call's `caller` (re-check R3). The host
 * read can never write it: `regime_snapshots.computed_at` is `BIGINT NOT NULL` epoch ms (migrations/048) and the
 * caller is 12 hex digits of an md5, so a seam refuses the registered snapshot whatever its record says.
 */
export const SEAM_MARK = 'seam';
export const SEED = '20261118';

/** The window: bar closes W0 ≤ close < W1. */
export const W0_MS = Date.UTC(2026, 10, 16, 8);
export const W1_MS = Date.UTC(2026, 11, 16, 8);
/** Look-ahead past W1, and key A's price history before W0, in bars of the label's timeframe. */
export const LOOKAHEAD_BARS = 14;
export const HISTORY_BARS = 14;
/** W1 + 14 days (the 1d look-ahead): no bar is fetched and nothing is scored before it. */
export const NOT_BEFORE_MS = Date.UTC(2026, 11, 30, 8);
export const EXPIRES_MS = Date.UTC(2027, 0, 13, 8);
export const RULE_VERSION = 2;

export const VENUES = ['BINANCE', 'BYBIT', 'OKX', 'BITGET'] as const;
export type Venue = (typeof VENUES)[number];
/** Minutes after a UTC midnight at which the venue's daily bar closes (OKX and Bitget close 1d bars at 16:00Z). */
export const DAY_OFFSET_MIN: Readonly<Record<Venue, number>> = Object.freeze({ BINANCE: 0, BYBIT: 0, OKX: 960, BITGET: 960 });
/** Each venue's grid origin: 2026-11-01 at its daily boundary. Every bar of every timeframe is aligned to it. */
export const originMs = (v: Venue): number => Date.UTC(2026, 10, 1) + DAY_OFFSET_MIN[v] * 60_000;

/** The frozen census (vault): its panel is EXCLUDED on every venue (T9's corpus), its timeframe weights are used. */
export const CENSUS_SHA256 = '8f408d1d6b715dcaac9a9aaf29683deb297829a25290af2405ae27c2c73a684a';
export const FILES = ['snapshots.psv.gz', 'runs.psv', 'calls.psv'] as const;
export const SNAP_COLS = ['exchange', 'timeframe', 'coin', 'bar_close_ms', 'regime', 'confidence', 'trend_strength', 'adx',
  'adx_slope', 'volatility_ratio', 'price_structure', 'regime_since_ms', 'rule_version', 'computed_at'] as const;
export const CALL_COLS = ['timestamp', 'exchange', 'timeframe', 'asset', 'regime', 'verdict', 'lane', 'caller'] as const;

/** T3's resampling sizes, level and floors (T3 §4.6, §4.7, §5, §6), carried unchanged. */
export const B = Object.freeze({ boot: B_BOOT, shuffle: B_SHUFFLE, perm: B_PERM });
export { ALPHA, FLOOR_PP, FLOOR_RATIO, TFS, type Tf };
/** The `@day` variant needs this many UTC-day clusters; a 30-day window has at most 31. */
export const DAY_VARIANT_CLUSTERS_NEEDED = 50;
/**
 * A venue whose coins come back without bars (a failed request after three tries, or no closed bar in the span) in
 * more than this share reads INDETERMINATE on both answers, cause BARS_UNAVAILABLE (registration §3.4). Below it, such a
 * coin is dropped by name (`no_bars`) and counted.
 */
export const MAX_NO_BARS_SHARE = 0.05;

export const tfMs = (tf: Tf): number => tf.min * 60_000;
/** The last bar close (exclusive) a timeframe's rows may carry: W1 plus its look-ahead. */
export const windowEndMs = (tf: Tf): number => W1_MS + LOOKAHEAD_BARS * tfMs(tf);
export const inWindow = (tf: Tf, barMs: number): boolean => barMs >= W0_MS && barMs < windowEndMs(tf);

/** A T3 window in grid minutes of the venue. T3's bar functions read only `lo` and `hi`. */
export const gridWin = (v: Venue, loMs: number, hiMs: number): Win => ({ name: 'holdout', lo: (loMs - originMs(v)) / 60_000, hi: (hiMs - originMs(v)) / 60_000 });
/** The scored window [W0, W1); runs and lags close inside [W0, W1 + 14 bars); key A spans 14 bars either side. */
export const scoreWin = (v: Venue): Win => gridWin(v, W0_MS, W1_MS);
export const keyWin = (v: Venue, tf: Tf): Win => gridWin(v, W0_MS - HISTORY_BARS * tfMs(tf), windowEndMs(tf));

/**
 * The source fingerprint of the served code the read uses (served-fingerprint.ts): the four symbol functions, every
 * declaration they read, found by name, every top-level statement that reads or writes what is covered, and the
 * declaration of `ATR_RANGE_PER_SIGMA`, printed without comments by the TypeScript printer `SERVED_PRINTER`. The
 * guard checks it at the read against the served files of the registration's §10, never a test (arc lesson 15): a
 * tree byte-identical to its first pins is read whatever the printer; a re-pinned file is refused under another
 * printer and when the fingerprint moves (registration §1, leg `registration`). Necessary, not sufficient.
 */
export const SERVED_FINGERPRINT = 'a2dd97997797c6be9bee9ed5a3c532a0161af38076db934cbbf89489e0f067df';
/** The TypeScript version whose printer produced SERVED_FINGERPRINT (review PRN). */
export const SERVED_PRINTER = '5.9.3';

/**
 * Test-only mutation lever (the guard refuses a read while it is set). Each value disables one enforced rule:
 * clock | panel | window | rule | seal | postseal (the seal no longer stops a request).
 */
export const MUTATE: string = process.env.REGIME_FORWARD_MUTATE ?? '';
