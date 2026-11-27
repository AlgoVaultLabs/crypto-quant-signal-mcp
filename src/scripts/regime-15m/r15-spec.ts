// regime-15m/r15-spec.ts — EDGE-REGIME-15M-BACKTEST-W1 (ARC-REGIME-15M T0): the registered constants of the 15m
// backtest. Pure data, no I/O.
//
// The study scores the served regime rule at 15m beside 1h, 4h and 1d on T3's fit rows (Binance USDⓈ-M, the
// 2024-01 … 2025-12 window, T3's census panel, entry grid, shapes, holds, fee, seed and bootstrap constants), and
// decides Bar A: 15m non-inferior to 1h on direction agreement (A4) and on the TRENDING edge (Δ1), with no more
// flip-flops than the most of 1h, 4h and 1d. Every value below is fixed by
// `audits/regime-15m-backtest-preregistration-<date>.md`; T3's values are imported, never copied.
//
// T3's harness (src/scripts/regime-diag/**, scripts/regime-diag/**) is import-only: nothing here edits it.
// The file is not called spec.ts: the caller-tag gate names every file under src/scripts by its basename.
import { ALPHA, FIT, MIN_MS, REGIME_AGAINST_MIN_CONFIDENCE, SEED, SPAN, TFS, type Span, type Tf, type Win } from '../regime-diag/diag-spec.js';

export const WAVE = 'EDGE-REGIME-15M-BACKTEST-W1';
/** The registration: the one file of this name on origin/main (its date is its landing date). */
export const REGISTRATION_RE = /^audits\/regime-15m-backtest-preregistration-\d{4}-\d{2}-\d{2}\.md$/;
/** T3's registration: its Tables 2a–2e are the label-free skeleton the fit frame must reproduce before any outcome. */
export const T3_REGISTRATION = 'audits/regime-diagnostic-preregistration-2026-11-16.md';

/** The test-only lever of the mutation proofs. Unset in every real run: the guard refuses when it is set. */
export const MUTATE: string = process.env.REGIME_15M_MUTATE ?? '';
/** The named breaks the mutation tests turn on, one at a time. */
export const MUTATIONS = Object.freeze(['bars99', 'swap', 'pooled', 'sign', 'baseline'] as const);

/**
 * The 15m window in bars (item 1). Exported once, here: REGIME-15M-SERVE-W1 serves the same number. 100 bars is
 * 25 h, under T3's 7-day history floor, so every T3 entry has a full 15m window.
 */
export const REGIME_15M_WINDOW_BARS = 100;

/** A timeframe of this study: T3's three, and 15m. `min` is I_τ in minutes, `n` the served window in bars. */
export interface Tf4 { key: '15m' | '1h' | '4h' | '1d'; min: number; n: number }
/** 15m, beside T3's TFS. The mutation `bars99` shortens its window by one bar. */
export const TF15: Tf4 = Object.freeze({ key: '15m' as const, min: 15, n: MUTATE === 'bars99' ? REGIME_15M_WINDOW_BARS - 1 : REGIME_15M_WINDOW_BARS });
/** T3's harness types a timeframe as one of its three keys; its functions read only `min` and `n`, and the key as a label. */
export const asT3Tf = (t: Tf4): Tf => t as unknown as Tf;
/** Every timeframe of the readout, 15m first, then T3's three in T3's order. */
export const TIMEFRAMES: readonly Tf4[] = Object.freeze([TF15, ...TFS.map((t) => Object.freeze({ key: t.key, min: t.min, n: t.n }) as Tf4)]);
export const TF_KEYS: readonly Tf4['key'][] = Object.freeze(TIMEFRAMES.map((t) => t.key));

/** T3's fit window and the grid that ends with it: no month after 2025-12 is opened (item 2, G3). */
export const STUDY_SPAN: Span = Object.freeze({ t0Ms: SPAN.t0Ms, n: FIT.hi });
export const STUDY_WIN: Win = Object.freeze({ ...FIT });
export const FIRST_MONTH = '2024-01';
export const LAST_MONTH = '2025-12';
/** The window's end as an instant: no bar opening at or after it is read. */
export const WINDOW_END_MS = STUDY_SPAN.t0Ms + STUDY_SPAN.n * MIN_MS;

/** T3's constants the study inherits by name (item 2). */
export const STUDY_SEED = SEED;
export const STUDY_ALPHA = ALPHA;
/** Δ1's rows: TRENDING at confidence ≥ 60, as T3's primary and its label-timeframe map row read them. */
export const D1_MIN_CONFIDENCE = REGIME_AGAINST_MIN_CONFIDENCE;
/** Bar A's retention (item 4): each margin is this share of the 1h arm's edge — the standard non-inferiority rule. */
export const RETENTION = 0.5;
/** T3's descriptive floor (pp) for a key reading's `works` (T3 §6): the answer-key readout only, never the verdict. */
export const KEY_FLOOR_PP = 3.0;

/** The pinned inputs, by sha256 of their bytes. */
export const CENSUS_SHA256 = '8f408d1d6b715dcaac9a9aaf29683deb297829a25290af2405ae27c2c73a684a';
export const T3_ARCHIVES_SHA256 = 'b177bd0d4cba9ff46f4a8bc8e2f44b57c0f996457e8a2f3f0b21308b33e6ae1a';
/** T3's fit result, the parity reference, and the registration commit it was read under (T3's carry). */
export const T3_FIT_SHA256 = '46454f07a58c53154a081fa50bcc2709fb5ec11043d5e4db612e19a39cb0b312';
export const T3_REGISTRATION_COMMIT = '22f01dc912beade374ab4bd7c0f6706e07df332e';

// ── the check venues (item 6, PROCEDURE §4e) ─────────────────────────────────────────────────────────────────

export const CHECK_VENUES = Object.freeze(['BYBIT', 'OKX', 'BITGET'] as const);
export type CheckVenue = (typeof CHECK_VENUES)[number];
/**
 * The finest bar resolution, in minutes, that covers the window in at most 2 h of fetching per venue (R0: each
 * venue's history depth and its measured request rate, vault evidence). The Binance twin is read at the same one.
 */
export const CHECK_RESOLUTION_MIN: Readonly<Record<CheckVenue, number>> = Object.freeze({ BYBIT: 1, OKX: 3, BITGET: 3 });
/** The gap between two requests to one venue (R0: no throttle answer at this pace; Bitget throttled below it). */
export const CHECK_PACE_MS: Readonly<Record<CheckVenue, number>> = Object.freeze({ BYBIT: 120, OKX: 120, BITGET: 250 });
/** The most bars one request returns: Bybit kline 1,000, OKX history-candles 100, Bitget history-candles 200. */
export const CHECK_PAGE_MAX: Readonly<Record<CheckVenue, number>> = Object.freeze({ BYBIT: 1000, OKX: 100, BITGET: 200 });
/** The fetching budget per venue (item 6): the guard refuses check bars whose venue took longer to fetch. */
export const CHECK_BUDGET_MS = 2 * 3_600_000;

// ── the read's home ──────────────────────────────────────────────────────────────────────────────────────────

/** Under `~/.cache/algovault` (the home the code resolves for the user): this study's own directory. */
export const HOME_NAME = 'regime-15m';
/** The one-read seal, in the fixed seal directory of the home. */
export const SEAL_DIR = 'seal';
export const SEAL_FILE = 'read.seal';
/** The one rerun a §8 deviation may authorize (spec CH3 and item 5), and the registration line that authorizes it. */
export const RERUN_SEAL_FILE = 'rerun.seal';
export const RERUN_LINE_RE = /^RERUN_AUTHORIZED:[ \t]*(\S.{19,})$/m;
/** The check venues' bars, fetched before the registration lands and pinned by their manifest. */
export const CHECK_DIR = 'check';
export const CHECK_MANIFEST = 'check-manifest.json';
/** The registration row that pins the check manifest. */
export const CHECK_PIN = `check:${CHECK_MANIFEST}`;
export const CENSUS_PIN = 'census:regime-census-2026-11-16.json';
export const ARCHIVES_PIN = 'store:regime-diag-archives.json';
export const T3_FIT_PIN = 'carry:regime-diag-fit.json';

/** The read's outputs, written in its output directory. */
export const RESULT_FILE = 'regime-15m-read.json';
export const RESULT_SHA_FILE = 'regime-15m-read.json.sha256';
export const PRE_FILE = 'regime-15m-pre-outcome.json';
export const LOG_FILE = 'regime-15m-read.log';
export const OUT_FILES: readonly string[] = Object.freeze([PRE_FILE, RESULT_FILE, RESULT_SHA_FILE]);

/** Half this host's memory: the read refuses to start its outcomes above it. */
export const MEMORY_BUDGET = 9 * 2 ** 30;
/** The runtime itself, one coin's grid and bars, the bridge's buffers: allowed for beside the planned arrays. */
export const MEMORY_OVERHEAD = 2 ** 30;
/**
 * Peak resident bytes per planned array byte: the garbage the collector has not yet returned rides on the live
 * arrays. Measured at four synthetic scales (the main run end to end; /usr/bin/time -l maximum resident set size of
 * `node --import tsx`, node 24, macOS, an 18 GiB host; vault evidence, sizing): the peak grows by about 1.7 bytes
 * per planned byte. 2.5 keeps the plan above the measured line well past the read's scale.
 */
export const MEMORY_GROWTH = 2.5;

// ── the pins (spec CH1: a pin list of every sibling file and the registration) ─────────────────────────────────

/** Every file of this directory, sorted. A test holds it equal to the directory's listing. */
export const SIBLING_FILES: readonly string[] = Object.freeze([
  'r15-decide.ts', 'r15-fetch.ts', 'r15-frame.ts', 'r15-guard.ts', 'r15-parity.ts', 'r15-run.ts', 'r15-spec.ts', 'r15-stats.ts', 'r15-venues.ts',
]);
/**
 * The repository files the read's bytes depend on, beyond this directory: every T3 harness module the read loads,
 * the bridge, the served rule and the library files T3 pinned for it (T3 §10) that the read loads (T3's list less
 * `venue-fees.ts`, which nothing the read loads imports), the two statistics modules behind the bridge, and T3's
 * registration (its skeleton tables). The registration pins each by sha256; the guard refuses a read on any other
 * bytes. The rest of the read's runtime closure (what `errors.ts`'s message helpers load) computes nothing it uses.
 */
export const CLOSURE_FILES: readonly string[] = Object.freeze([
  ...['archive', 'bars', 'diag-spec', 'engine', 'frame', 'keys', 'labeler', 'mutate', 'prims', 'replay', 'rng', 'stats'].map((m) => `src/scripts/regime-diag/${m}.ts`),
  'scripts/regime-diag/prims.py',
  ...['market-regime-core', 'indicators', 'candle-window', 'candle-guard', 'serving-windows', 'errors', 'pre-trade-calc', 'pre-trade-odds-calibration', 'funding-venues']
    .map((m) => `src/lib/${m}.ts`),
  'src/scripts/cluster-perm-stats.py',
  'ops/monitoring/population_comparison.py',
  T3_REGISTRATION,
]);
export const PINNED_REPO_FILES: readonly string[] = Object.freeze([...SIBLING_FILES.map((f) => `src/scripts/regime-15m/${f}`), ...CLOSURE_FILES]);
/** The non-repository inputs, pinned by the sha256 of their bytes. */
export const INPUT_PINS: readonly string[] = Object.freeze([CENSUS_PIN, ARCHIVES_PIN, T3_FIT_PIN, CHECK_PIN]);

/**
 * The seed arm of one bootstrap stream of this study: `arm_seed(STUDY_SEED, 'r15|<run>|<statistic>|bootstrap')`. The
 * `r15|` prefix keeps every arm of this study apart from T3's (`<window>|<statistic>|<purpose>`).
 */
export const armOf = (run: string, stat: string): string => `r15|${run}|${stat}|bootstrap`;
