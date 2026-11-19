// regime-challenge/challenge-r2.ts — EDGE-REGIME-CHALLENGE-R2-W1 (T6, round 2): the two new challengers and their pre-score.
//
// Round 2 judges four challengers in one Holm family: C2 and C3 as round 1 defined them (they carry round 1's
// in-sample points), and two new dials on the confidence the served rule attaches to a TRENDING label, from T3's
// component map:
//   C4 · M05  the strong tier's cap: `Math.min(90, round(2·ADX))` for ADX > 40, before the slope adjustment. 45 or 55.
//   C5 · M10  the trigger: a TRENDING row is read for A1 at confidence ≥ 60. 50 or 70.
// Each is the served label with ONE confidence rule changed. No indicator is recomputed, so neither needs a replay:
// `armLab` (challenger-replay.ts) rewrites C4's confidence on the strong rows, and `armParity` holds that copy to the
// served confidence on every strong row of the frame, before any outcome.
//
// The pre-score reads T3's fit window, 2024-01 … 2025-12, exactly as round 1's did, under round 2's own seed label,
// and picks one value per dial by round 1's rule (`selectionOf`). Round 2's judge window is 2020-01 … 2023-12, read
// once under its own registration and seal (CH4, R2-W2): until then no entry point of the harness computes an outcome
// there (challenge-run.ts refuses a record whose outcome months touch it).
import { months } from '../regime-diag/archive.js';
import { REGIME_AGAINST_MIN_CONFIDENCE } from '../regime-diag/diag-spec.js';
import { COIN_DAYS_PER_MONTH, PRESCORE, coinDaysOf, type Candidate, type ChallengeRecord, type PrescoreRound } from './challenge-spec.js';

export const R2_WAVE = 'EDGE-REGIME-CHALLENGE-R2-W1';
/** The served cap of the strong tier, and the ADX above which a TRENDING row is in that tier (classifyRegime). */
export const SERVED_CAP = 90;
export const STRONG_ADX = 40;
/** The served trigger: T3's statement of the served `REGIME_AGAINST_MIN_CONFIDENCE`. */
export const SERVED_TRIGGER = REGIME_AGAINST_MIN_CONFIDENCE;

const R2_CANDIDATES: readonly Candidate[] = Object.freeze([
  Object.freeze({ id: 'C4.45', challenger: 'C4', map: 'M05', dial: null, arm: Object.freeze({ kind: 'cap', cap: 45 }), what: `strong-tier confidence cap 45 (served: ${SERVED_CAP})` }),
  Object.freeze({ id: 'C4.55', challenger: 'C4', map: 'M05', dial: null, arm: Object.freeze({ kind: 'cap', cap: 55 }), what: `strong-tier confidence cap 55 (served: ${SERVED_CAP})` }),
  Object.freeze({ id: 'C5.50', challenger: 'C5', map: 'M10', dial: null, arm: Object.freeze({ kind: 'trigger', min: 50 }), what: `TRENDING read at confidence ≥ 50 (served: ${SERVED_TRIGGER})` }),
  Object.freeze({ id: 'C5.70', challenger: 'C5', map: 'M10', dial: null, arm: Object.freeze({ kind: 'trigger', min: 70 }), what: `TRENDING read at confidence ≥ 70 (served: ${SERVED_TRIGGER})` }),
] as Candidate[]);

/** In-sample: round 1's pre-score grid, window and months (T3's fit window), under round 2's names. No seal. */
const R2_PRESCORE: ChallengeRecord = Object.freeze({
  ...PRESCORE, id: 'challenge-r2-prescore', wave: R2_WAVE, file: 'regime-challenge-r2-prescore.json', line: 'REGIME_CHALLENGE_R2_PRESCORE',
});

/** Round 2's judge window (the spec's §1): only round 2's sealed judge reads an outcome of these months. */
export const R2_JUDGE_OUTCOMES: Readonly<{ first: string; last: string }> = Object.freeze({ first: '2020-01', last: '2023-12' });

/**
 * Round 2's pre-score. Its power arithmetic moves a half-width to the judge window at T3 §5's nominal rate on both
 * sides; the judge window's panel is narrower than the nominal one, and the vault evidence rescales by it.
 */
export const R2_ROUND: PrescoreRound = Object.freeze({
  rec: R2_PRESCORE, seed: 'regime-challenge-r2', log: 'regime-challenge-r2-prescore.log', home: 'regime-challenge-r2', candidates: R2_CANDIDATES,
  coinDays: Object.freeze({ prescore: coinDaysOf(R2_PRESCORE), judge: COIN_DAYS_PER_MONTH * months(R2_JUDGE_OUTCOMES.first, R2_JUDGE_OUTCOMES.last).length }),
});
