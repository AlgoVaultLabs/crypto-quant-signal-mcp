// regime-diag/diag-spec.ts — EDGE-REGIME-DIAG-W1: the registered constants of the regime diagnostic. Pure data.
//
// Every value here is fixed by audits/regime-diagnostic-preregistration-2026-11-16.md (and its appended sections).
// The section that fixes a value is named beside it. Nothing in this file is tuned by a result.
//
// EDGE-REGIME-CONFIRM-W1: the harness serves a study, not a constant. `STUDIES` holds one frozen record per study;
// a run names its study, and no function of the harness falls back to one. The statistics, comparators, shapes,
// holds, floors and clusters below are shared: the successor reuses them unchanged (its registration cites each).
//
// The file is not called spec.ts: the caller-tag gate (scripts/check-caller-tags.mjs) names every file under
// src/scripts by its basename, and this one reaches the served constants' modules, as src/scripts/ads1/spec.ts does.
import { CANDLE_COUNTS } from '../../lib/serving-windows.js';

export const WAVE = 'EDGE-REGIME-DIAG-W1';
export const REGISTRATION = 'audits/regime-diagnostic-preregistration-2026-11-16.md';
/** §4.2, §4.6: every stream derives from this label. */
export const SEED = '20261116';
export const VENUE = 'BINANCE' as const;
export const MIN_MS = 60_000;

/** A 1 m grid: minute `i` opens at `t0Ms + i·60 000`. */
export interface Span { t0Ms: number; n: number }
/** A window of entry instants, `[lo, hi)` in grid minutes. */
export interface Win { name: 'fit' | 'holdout'; lo: number; hi: number }

/** §3: 2024-01-01T00:00Z … T_END = 2026-10-31T23:59Z (the last minute of the grid). */
export const SPAN: Span = { t0Ms: Date.UTC(2024, 0, 1), n: (Date.UTC(2026, 10, 1) - Date.UTC(2024, 0, 1)) / MIN_MS };
export const FIT: Win = { name: 'fit', lo: 0, hi: (Date.UTC(2026, 0, 1) - SPAN.t0Ms) / MIN_MS };
export const HOLDOUT: Win = { name: 'holdout', lo: FIT.hi, hi: SPAN.n };
export const FIRST_MONTH = '2024-01';
export const LAST_MONTH = '2026-10';

/** The one fit result a successor carries: its sha256, and the registration commit it was read under. */
export interface Carry { sha256: string; registrationCommit: string }
/** One read a study serves: the result line's name and the result file's name. */
export interface Read { line: 'REGIME_DIAG_FIT' | 'REGIME_DIAG_VERDICT' | 'REGIME_CONFIRM_VERDICT'; file: string }
/**
 * A study: everything a run takes from its registration by name. Frozen; a run names one by `id`.
 * `months.pinned` is the last month the archive-store manifest pins; later months are checked at read time.
 * `skeleton` says what the read does with the label-only skeleton: compare it with the registered tables, or
 * record it (a corpus that did not exist at registration has no table to compare with).
 */
export interface StudyRecord {
  id: string; wave: string; registration: string; seed: string; span: Span; windows: readonly Win[];
  months: { first: string; pinned: string; last: string };
  seal: string;
  reads: { fit?: Read; holdout: Read };
  skeleton: 'registered' | 'recorded';
  carry: Carry | null;
  /** The registered read date: no run before it. */
  notBefore: string | null;
  /** A closed study has spent its read. It keeps refusing. */
  closed: boolean;
}

/** T3 (EDGE-REGIME-DIAG-W1): its values unchanged. Closed — the 2026 hold-out is spent, and its seal keeps refusing. */
const T3: StudyRecord = {
  id: 'diag-2026-11-16', wave: WAVE, registration: REGISTRATION, seed: SEED, span: SPAN, windows: [FIT, HOLDOUT],
  months: { first: FIRST_MONTH, pinned: LAST_MONTH, last: LAST_MONTH },
  seal: 'holdout.seal',
  reads: { fit: { line: 'REGIME_DIAG_FIT', file: 'regime-diag-fit.json' }, holdout: { line: 'REGIME_DIAG_VERDICT', file: 'regime-diag-holdout.json' } },
  skeleton: 'registered', carry: null, notBefore: null, closed: true,
};

/** The successor's grid: T3's origin, through T_END2 = 2027-05-31T23:59Z (its registration, §1). */
const CONFIRM_SPAN: Span = { t0Ms: SPAN.t0Ms, n: (Date.UTC(2027, 5, 1) - SPAN.t0Ms) / MIN_MS };
/**
 * The successor (EDGE-REGIME-CONFIRM-W1): T3 §6's hold-out test on entries after T_END, read once. Nothing is
 * re-fit: it has no fit read, and it carries T3's fit result by sha256. History reaches back into T3's months.
 */
const CONFIRM: StudyRecord = {
  id: 'confirm', wave: 'EDGE-REGIME-CONFIRM-W1', registration: 'audits/regime-confirmation-preregistration-2026-11-17.md', seed: '20261117',
  span: CONFIRM_SPAN, windows: [{ name: 'holdout', lo: SPAN.n, hi: CONFIRM_SPAN.n }],
  months: { first: FIRST_MONTH, pinned: LAST_MONTH, last: '2027-05' },
  seal: 'confirm.seal',
  reads: { holdout: { line: 'REGIME_CONFIRM_VERDICT', file: 'regime-confirm.json' } },
  skeleton: 'recorded',
  carry: { sha256: '46454f07a58c53154a081fa50bcc2709fb5ec11043d5e4db612e19a39cb0b312', registrationCommit: '22f01dc912beade374ab4bd7c0f6706e07df332e' },
  notBefore: '2027-06-16T00:00:00Z', closed: false,
};

const frozen = (r: StudyRecord): StudyRecord =>
  Object.freeze({ ...r, span: Object.freeze({ ...r.span }), windows: Object.freeze(r.windows.map((w) => Object.freeze({ ...w }))), months: Object.freeze({ ...r.months }),
    reads: Object.freeze({ ...(r.reads.fit ? { fit: Object.freeze({ ...r.reads.fit }) } : {}), holdout: Object.freeze({ ...r.reads.holdout }) }),
    carry: r.carry ? Object.freeze({ ...r.carry }) : null });
export const STUDIES: readonly StudyRecord[] = Object.freeze([frozen(T3), frozen(CONFIRM)]);
/** The study a run names, or null: there is no default. */
export const studyOf = (id: unknown): StudyRecord | null => STUDIES.find((s) => s.id === id) ?? null;

export interface Tf { key: '1h' | '4h' | '1d'; min: number; n: number }
/** §4.1: I_τ in minutes and n_τ = CANDLE_COUNTS[τ]. */
export const TFS: readonly Tf[] = Object.freeze([
  { key: '1h', min: 60, n: CANDLE_COUNTS['1h'] },
  { key: '4h', min: 240, n: CANDLE_COUNTS['4h'] },
  { key: '1d', min: 1440, n: CANDLE_COUNTS['1d'] },
] as Tf[]);

/** §4.2: history every entry needs (the 1h and 4h windows), the path it needs, and the entry rate. */
export const HISTORY_MIN = 10_080;
export const PATH_MIN = 4_320;
export const ENTRIES_PER_DAY = 24;

/** §4.4: (stop, target), in percent or in multiples of σ_H, in the registered order. */
export interface Shape { id: string; stop: number; target: number; sigma: boolean }
export const SHAPES: readonly Shape[] = Object.freeze([
  { id: 'S1', stop: 0.5, target: 0.75, sigma: false },
  { id: 'S2', stop: 1, target: 2, sigma: false },
  { id: 'S3', stop: 2.5, target: 5, sigma: false },
  { id: 'S4', stop: 5, target: 10, sigma: false },
  { id: 'S5', stop: 1, target: 2, sigma: true },
  { id: 'S6', stop: 0.5, target: 0.5, sigma: false },
  { id: 'S7', stop: 1, target: 1, sigma: true },
  { id: 'S8', stop: 1, target: 0.5, sigma: false },
  { id: 'S9', stop: 1, target: 0.5, sigma: true },
]);
export const HOLDS_H: readonly number[] = Object.freeze([0.5, 4, 8, 24, 72]);
export const N_SHAPES = SHAPES.length;
export const N_HOLDS = HOLDS_H.length;
/** A cell is one shape at one hold; a cell-side adds the side (0 long, 1 short). */
export const N_CELLS = N_SHAPES * N_HOLDS;
export const N_CS = N_CELLS * 2;
export const cellOf = (shape: number, hold: number): number => shape * N_HOLDS + hold;
export const csOf = (cell: number, side: 0 | 1): number => cell * 2 + side;

/** §4.7 (a): the round-trip fee in percent of notional (two taker fills at takerFeeBps('BINANCE')). */
export const FEE_PCT = 0.1;

/** §8 correction 1: the dials outside the core, carried as registered constants. */
export const REGIME_AGAINST_MIN_CONFIDENCE = 60;
export const VOLATILE_MIN_CONFIDENCE = 70;
export const DEFAULT_TIMEFRAME = '4h';
/** §4.9: the volatility line, and the ratio at which a VOLATILE label reaches confidence 70. */
export const VOL_LINE = 0.03;
export const VOL_LINE_CONF70 = 0.03475;

/** §4.9, §4.10, §4.8, component map row 1. */
export const KEY_A = Object.freeze({ w: 7, lambda: 6 });
export const KEY_A_VOL_BARS = 14;
export const KEY_B_LEAD = 14;
export const KEY_B_DESCRIPTIVE_LEADS: readonly number[] = Object.freeze([7, 28]);
export const N_FF = 3;
export const YOUNG_BARS = 14;
export const CONF_BINS: readonly number[] = Object.freeze([50, 60, 70, 80]);

/** §4.6, §4.7, §4.8, §4.11. B_SHUFFLE_A3 is the appended section's value (1,000 shuffles cannot reach 0.025 / 36). */
export const B_BOOT = 10_000;
export const B_BOOT_A3 = 20_000;
export const B_SHUFFLE = 1_000;
export const B_SHUFFLE_A3 = 20_000;
export const B_PERM = 1_000;
export const ALPHA = 0.025;
export const A3_FAMILY = 36;
export const BH_Q = 0.1;
/** §6: the floors. */
export const FLOOR_PP = 3.0;
export const FLOOR_RATIO = 1.1;

/** Served labels, in the order every table uses. */
export const LABELS = ['RANGING', 'TRENDING_UP', 'TRENDING_DOWN', 'VOLATILE'] as const;
export const L_RANGING = 0;
export const L_UP = 1;
export const L_DOWN = 2;
export const L_VOLATILE = 3;
/** A row with no label under a key (key B past the window, key A undated). */
export const NO_LABEL = 255;

/** §3: the named drops. Every exclusion is counted under exactly one of them. */
export const DROPS = ['no_archive', 'short_history', 'path_beyond_window', 'gap', 'no_1d_history', 'core_refusal', 'both_touch', 'null_odds',
  'undated', 'key_b_beyond_window', 'censored_run', 'di_tie'] as const;
export type Drop = (typeof DROPS)[number];

/** A3's label groups, in the registered order (ties in the selection go to the lower shape, then to this order). */
export const A3_GROUPS = ['TRENDING-with', 'TRENDING-against', 'RANGING', 'VOLATILE'] as const;

/** The answer keys (PROCEDURE §4d): S the served label, B key B (NO_LAG), A key A (CEILING). */
export const KEYS = ['S', 'B', 'A'] as const;
export type Key = (typeof KEYS)[number];

/** Sensitivity variants of a primary (§4.11). `panel13` exists in the hold-out only. */
export const VARIANTS = ['day', 'week', 'unit', 'panel13'] as const;
export type Variant = (typeof VARIANTS)[number];

export interface StatDef { id: string; what: string; boot: number; shuffle: number; perm: number }
const def = (id: string, what: string, boot = B_BOOT, shuffle = 0, perm = 0): StatDef => ({ id, what, boot, shuffle, perm });
const primaries: StatDef[] = [
  def('A1.S', 'Δ1 on served TRENDING rows at confidence ≥ 60', B_BOOT, B_SHUFFLE),
  def('A2.S', 'S2 on served VOLATILE rows at confidence ≥ 70', B_BOOT, B_SHUFFLE),
  def('A3.cells', 'E(shape, group) in the 36 cells, served labels', B_BOOT_A3),
  def('A3.S', 'S3 = E in the fit-selected cell, served labels', B_BOOT_A3, B_SHUFFLE_A3),
  def('A4.S', 'S4 = A − A_0 on served TRENDING rows with a dated phase', B_BOOT, B_SHUFFLE),
  def('A5.S', 'R5 on the TRENDING runs of the served per-closed-bar series', B_BOOT, B_SHUFFLE),
];
const variants: StatDef[] = [];
for (const p of primaries) for (const v of VARIANTS) variants.push({ ...p, id: `${p.id}@${v}`, what: `${p.what} — sensitivity variant ${v}` });
const mapRow = (n: number, what: string): StatDef => def(`M${String(n).padStart(2, '0')}`, what);

/**
 * §4.6: the statistic registry. Its keys are the `<statistic id>` of every seed
 * `arm_seed('20261116', '<window>|<statistic id>|<purpose>')`. Pinned with the harness.
 */
export const STATISTICS: readonly StatDef[] = Object.freeze([
  ...primaries,
  def('A1.B', 'Δ1 under key B (NO_LAG)', B_BOOT, B_SHUFFLE),
  def('A1.A', 'Δ1 under key A (CEILING)', B_BOOT, B_SHUFFLE),
  def('A2.B', 'S2 under key B (NO_LAG)', B_BOOT, B_SHUFFLE),
  def('A2.A', 'S2 under key A (CEILING: the forward volatility leg)', B_BOOT, B_SHUFFLE),
  def('A3.B', 'S3 in the fit-selected cell under key B', B_BOOT_A3, B_SHUFFLE_A3),
  def('A3.A', 'S3 in the fit-selected cell under key A', B_BOOT_A3, B_SHUFFLE_A3),
  def('A4.B', 'S4 under key B (NO_LAG)', B_BOOT, B_SHUFFLE),
  def('A5.B', 'R5 on the runs of key B\'s series', B_BOOT, B_SHUFFLE),
  def('A4.mono', 'confidence monotonicity of the agreement g', 0, 0, B_PERM),
  def('A1.all', 'secondary: Δ1 on all TRENDING rows'),
  def('A2.all', 'secondary: S2 on all VOLATILE rows'),
  ...TFS.map((tf) => def(`A2.tf.${tf.key}`, `descriptive: S2 on the ${tf.key} rows of A2's primary`)),
  mapRow(1, 'young labels'), mapRow(2, 'ADX (18, 25]'), mapRow(3, 'ADX (25, 30]'), mapRow(4, 'ADX (30, 40]'), mapRow(5, 'ADX above 40'),
  mapRow(6, 'slope RISING minus FALLING'), mapRow(7, 'exhaustion'), mapRow(8, 'structure against ±DI'), mapRow(9, 'volatility line'),
  mapRow(10, 'TRENDING confidence'), mapRow(11, 'VOLATILE confidence'), mapRow(12, 'label timeframe'),
  ...variants,
]);
export const STAT_IDS: readonly string[] = Object.freeze(STATISTICS.map((s) => s.id));
export const statDef = (id: string): StatDef => {
  const s = STATISTICS.find((x) => x.id === id);
  if (!s) throw new Error(`regime-diag: ${id} is not in the statistic registry`);
  return s;
};
/** The arm of `arm_seed` for one stream. */
export const seedArm = (win: string, id: string, purpose: 'bootstrap' | 'shuffle' | 'perm'): string => {
  statDef(id);
  return `${win}|${id}|${purpose}`;
};

/** The secondary family of §4.11, in its registered order: the 12 map rows, then the two all-rows cells. */
export const SECONDARY_IDS: readonly string[] = Object.freeze([...Array.from({ length: 12 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`), 'A1.all', 'A2.all']);
