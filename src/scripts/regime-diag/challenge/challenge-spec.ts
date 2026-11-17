// regime-diag/challenge/challenge-spec.ts — EDGE-REGIME-CHALLENGE-R1-W1 (T6, round 1): the challengers and the two records.
//
// A challenger is the served rule with ONE input changed. Round 1 holds three, on the dials the component map
// flagged: M01 (the ADX smoothing period), M08 (direction precedence) and M12 (the label timeframe).
//
// Two records, and the months each may touch:
//   challenge-r1-prescore   2024-01 … 2025-12   in-sample, internal, selection only. No seal, no registration.
//   challenge-r1            2026-01 … 2026-10   the judge: one read, under a landed registration and a seal.
// The judge's entries, outcome paths and statistics lie wholly inside its window. The months before it are opened
// as label-free history only (a served call at t needs the bars before t), exactly as T3's hold-out frame was
// built. No record opens a month after 2026-10: those are the successor study's corpus.
//
// Nothing here is part of T3's or its successor's pinned harness: this module imports from it and edits none of it.
import { months } from '../archive.js';
import { FIT, FLOOR_PP, FLOOR_RATIO, HISTORY_MIN, HOLDOUT, LAST_MONTH, MIN_MS, PATH_MIN, SEED, SPAN, TFS, DEFAULT_TIMEFRAME, type Span, type StudyRecord, type Win } from '../diag-spec.js';
import { MUTATE } from '../mutate.js';

export const CHALLENGE_WAVE = 'EDGE-REGIME-CHALLENGE-R1-W1';
/** The seed label of every resample of this round (the entry draw keeps T3's label: the frames are T3's frames). */
export const CHALLENGE_SEED = 'regime-challenge-r1';
/** The census and the archive-store manifest T3 registered: this round reads the same panel and the same archives. */
export const CENSUS_SHA256 = '8f408d1d6b715dcaac9a9aaf29683deb297829a25290af2405ae27c2c73a684a';
export const T3_ARCHIVES_SHA256 = 'b177bd0d4cba9ff46f4a8bc8e2f44b57c0f996457e8a2f3f0b21308b33e6ae1a';

export const PRESCORE_FILE = 'regime-challenge-r1-prescore.json';
export const JUDGE_FILE = 'regime-challenge-r1.json';
/** The registration row that pins the one pre-score result the judge accepts. */
export const PRESCORE_PIN = `carry:${PRESCORE_FILE}`;
/** The judge's registration: the one file of this name on origin/main (its date is its landing date). */
export const REGISTRATION_RE = /^audits\/regime-challenge-r1-preregistration-\d{4}-\d{2}-\d{2}\.md$/;
/**
 * What a judge registration pins beyond T3's harness list (which the pinned guard asks for itself): the five files
 * of this round, and the fourteen modules outside that list which the harness and this round import — the same
 * fourteen T3's registration and its successor's pin. A file the registration does not pin is bound to nothing, so
 * the judge refuses a registration that leaves one out; a pinned one the pinned guard holds to its sha256.
 */
export const REQUIRED_PINS: readonly string[] = Object.freeze([
  ...['challenge-spec', 'challenger-replay', 'paired-stats', 'challenge-guard', 'challenge-run'].map((m) => `src/scripts/regime-diag/challenge/${m}.ts`),
  ...['market-regime-core', 'indicators', 'candle-window', 'candle-guard', 'serving-windows', 'errors', 'pre-trade-calc', 'pre-trade-odds-calibration', 'venue-fees', 'funding-venues']
    .map((m) => `src/lib/${m}.ts`),
  'src/scripts/cluster-perm-stats.py',
  'ops/monitoring/population_comparison.py',
  'src/scripts/sr-backtest/guard.ts',
  'src/scripts/sr-backtest/store.ts',
]);

// ── the dials ────────────────────────────────────────────────────────────────────────────────────────────

/** The served ADX smoothing period (`adx(highs, lows, closes, 14, 5)` in computeRegimeIndicators). */
export const SERVED_ADX_PERIOD = 14;
/** One rule: the ADX period, and where a trending row takes its direction from. */
export interface Dial { adxPeriod: number; direction: 'served' | 'di' }
export const SERVED_DIAL: Dial = Object.freeze({ adxPeriod: SERVED_ADX_PERIOD, direction: 'served' });
/** A dial that changes more than one input is not a one-dial challenger. */
export const dialRefusal = (d: Dial): string | null =>
  (d.direction === 'di' && d.adxPeriod !== SERVED_ADX_PERIOD ? 'a challenger changes one dial: this one changes the ADX period and the direction precedence' : null);

/** The served label timeframe (the `'4h'` default of `input.timeframe`), and C3's. */
export const SERVED_TF = TFS.findIndex((t) => t.key === DEFAULT_TIMEFRAME);
export const C3_TF = TFS.findIndex((t) => t.key === '1h');

export interface Candidate {
  id: 'C1.7' | 'C1.10' | 'C2' | 'C3';
  challenger: 'C1' | 'C2' | 'C3';
  /** The component-map row whose dial this is. */
  map: 'M01' | 'M08' | 'M12';
  /** The rule replayed for the challenger's arm; null for C3, whose arm is the served rule at another timeframe. */
  dial: Dial | null;
  what: string;
}
export const CANDIDATES: readonly Candidate[] = Object.freeze([
  Object.freeze({ id: 'C1.7', challenger: 'C1', map: 'M01', dial: Object.freeze({ adxPeriod: 7, direction: 'served' }), what: 'ADX smoothing period 7 (served: 14)' }),
  Object.freeze({ id: 'C1.10', challenger: 'C1', map: 'M01', dial: Object.freeze({ adxPeriod: 10, direction: 'served' }), what: 'ADX smoothing period 10 (served: 14)' }),
  Object.freeze({ id: 'C2', challenger: 'C2', map: 'M08', dial: Object.freeze({ adxPeriod: SERVED_ADX_PERIOD, direction: 'di' }), what: 'direction from ±DI on every row (served: price structure first)' }),
  Object.freeze({ id: 'C3', challenger: 'C3', map: 'M12', dial: null, what: `label timeframe 1h (served: ${DEFAULT_TIMEFRAME})` }),
] as const);
export const candidateOf = (id: unknown): Candidate | null => CANDIDATES.find((c) => c.id === id) ?? null;

// ── the guards and the decision's constants (the spec's §1; T3's floors, unchanged) ─────────────────────────

/** A4: the S4 difference fails when its interval lies wholly below this (pp). */
export const A4_GUARD_PP = -FLOOR_PP;
/** A5: the R5 ratio (challenger over served) fails when its interval lies wholly below this. */
export const A5_GUARD_RATIO = 1 / FLOOR_RATIO;
/** Coverage: the challenger's TRENDING ≥ 60 row share over the served's fails below this. */
export const COVERAGE_FLOOR = 0.5;
/** T3 §5's instrument: the detectable effect at 80% power and a one-sided 2.5% level is 2.80 · SE, and SE = h / 1.96. */
export const POWER_Z = 2.8;
export const HALF_WIDTH_Z = 1.96;
/** About 450 coin-days a month (15 positions), T3 §5. */
export const COIN_DAYS_PER_MONTH = 450;

// ── the records ──────────────────────────────────────────────────────────────────────────────────────────

export interface ChallengeRecord {
  id: 'challenge-r1-prescore' | 'challenge-r1';
  wave: string;
  /** The grid, and the window entries are drawn in. */
  span: Span; win: Win;
  /** The entry draw's seed label: T3's, so the frame is T3's frame of the same window. */
  entrySeed: string;
  /** The months that may carry an entry, an outcome path or a statistic. */
  outcomes: { first: string; last: string };
  /** The months whose archives may be opened: the outcome months, and before them label-free history only. */
  archives: { first: string; last: string };
  /** The seal the read claims (in the one seal home), or null: a record with no seal has no registration either. */
  seal: string | null;
  /** The result file, and the line a run prints. */
  file: string; line: string;
}

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
/** The first month a window's frame opens: the month of the earliest bar a served call inside it can need. */
const historyMonth = (span: Span, win: Win): string =>
  monthOf(span.t0Ms + Math.max(0, win.lo - Math.max(HISTORY_MIN, ...TFS.map((t) => t.n * t.min))) * MIN_MS);
const lastMonth = (span: Span, win: Win): string => monthOf(span.t0Ms + (win.hi - 1) * MIN_MS);
const firstMonth = (span: Span, win: Win): string => monthOf(span.t0Ms + win.lo * MIN_MS);

/** In-sample: T3's fit window, on a grid that ends where the window ends — a 2026 minute has no row to land in. */
const PRESCORE_SPAN: Span = Object.freeze({ t0Ms: SPAN.t0Ms, n: FIT.hi });
export const PRESCORE: ChallengeRecord = Object.freeze({
  id: 'challenge-r1-prescore', wave: CHALLENGE_WAVE, span: PRESCORE_SPAN, win: Object.freeze({ ...FIT }), entrySeed: SEED,
  outcomes: Object.freeze({ first: firstMonth(PRESCORE_SPAN, FIT), last: lastMonth(PRESCORE_SPAN, FIT) }),
  archives: Object.freeze({ first: historyMonth(PRESCORE_SPAN, FIT), last: lastMonth(PRESCORE_SPAN, FIT) }),
  seal: null, file: PRESCORE_FILE, line: 'REGIME_CHALLENGE_PRESCORE',
});
/** The judge: T3's hold-out window on T3's grid. Its outcome months are the window's; the history before is label-free. */
export const JUDGE: ChallengeRecord = Object.freeze({
  id: 'challenge-r1', wave: CHALLENGE_WAVE, span: Object.freeze({ ...SPAN }), win: Object.freeze({ ...HOLDOUT }), entrySeed: SEED,
  outcomes: Object.freeze({ first: firstMonth(SPAN, HOLDOUT), last: lastMonth(SPAN, HOLDOUT) }),
  archives: Object.freeze({ first: historyMonth(SPAN, HOLDOUT), last: lastMonth(SPAN, HOLDOUT) }),
  seal: 'challenge-r1.seal', file: JUDGE_FILE, line: 'REGIME_CHALLENGE_VERDICT',
});

// ── the month refusals ──────────────────────────────────────────────────────────────────────────────────────────

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
/** MUTATE=judgemonth (tests only): the judge takes the month after its window for one of its own. */
const leak = (rec: ChallengeRecord): boolean => MUTATE === 'judgemonth' && rec.id === JUDGE.id;
const nextMonth = (ym: string): string => monthOf(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 1));

/**
 * Why `rec` may not touch month `ym`, or null when it may. `outcome`: an entry, an outcome path or a statistic.
 * `archive`: opening the month's 1 m archive at all. A month after 2026-10 is refused for every record and use.
 */
export function monthRefusal(rec: ChallengeRecord, ym: string, use: 'outcome' | 'archive'): string | null {
  if (!YM.test(ym)) return `${ym} is not a month`;
  if (leak(rec) && ym === nextMonth(rec.outcomes.last)) return null;
  if (ym > LAST_MONTH) return `${ym} is after ${LAST_MONTH}: it belongs to the successor study's corpus, and ${rec.id} never reads it`;
  const span = use === 'outcome' ? rec.outcomes : rec.archives;
  if (ym < span.first || ym > span.last) {
    return use === 'outcome'
      ? `${rec.id} reads outcomes of ${rec.outcomes.first} … ${rec.outcomes.last} only: ${ym} is outside`
      : `${rec.id} opens archives of ${rec.archives.first} … ${rec.archives.last} only: ${ym} is outside`;
  }
  return null;
}

/** The months whose archives a run of `rec` opens, in order. */
export const monthsOpened = (rec: ChallengeRecord): string[] =>
  [...months(rec.archives.first, rec.archives.last), ...(leak(rec) ? [nextMonth(rec.archives.last)] : [])];

/**
 * Why a frame is not `rec`'s, or null when it is: the frame's window is the record's, and every entry and the
 * end of its outcome path sit in the record's outcome months.
 */
export function windowRefusal(rec: ChallengeRecord, f: { span: Span; win: Win; eM: Int32Array }): string | null {
  if (f.span.t0Ms !== rec.span.t0Ms || f.span.n !== rec.span.n) return `the frame's grid is not ${rec.id}'s`;
  if (f.win.lo !== rec.win.lo || f.win.hi !== rec.win.hi) return `the frame's window is not ${rec.id}'s`;
  for (let e = 0; e < f.eM.length; e++) {
    const m = f.eM[e];
    for (const at of [m, m + PATH_MIN - 1]) {
      const why = monthRefusal(rec, monthOf(rec.span.t0Ms + at * MIN_MS), 'outcome');
      if (why) return `entry ${e}: ${why}`;
    }
  }
  return null;
}

/** Coin-days of a record's outcome months, at T3 §5's rate. */
export const coinDaysOf = (rec: ChallengeRecord): number => COIN_DAYS_PER_MONTH * months(rec.outcomes.first, rec.outcomes.last).length;

/**
 * The judge as the pinned guard reads a study: the registration that names it, T3's grid and T3's archive months
 * (the manifest the registration pins is T3's, 2024-01 … 2026-10), this round's seal, and no later month.
 */
export function judgeStudyRecord(registration: string): StudyRecord {
  return {
    id: JUDGE.id, wave: JUDGE.wave, registration, seed: CHALLENGE_SEED, span: JUDGE.span, windows: [JUDGE.win],
    months: { first: monthOf(SPAN.t0Ms), pinned: LAST_MONTH, last: LAST_MONTH },
    seal: JUDGE.seal as string,
    // the pinned guard reads no `reads`: the line and the file are this module's own (JUDGE.line, JUDGE.file)
    reads: { holdout: { line: JUDGE.line, file: JUDGE.file } } as unknown as StudyRecord['reads'],
    skeleton: 'registered', carry: null, notBefore: null, closed: false,
  };
}
