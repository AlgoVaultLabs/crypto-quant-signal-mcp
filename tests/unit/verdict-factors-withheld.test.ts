/**
 * verdict-factors-withheld.test.ts — SIGNAL-LEDGER-INTEGRITY-W1 CH4.
 *
 * `stripped_remainder.count` moved 1,1,1,2 across four live samples under a label that
 * reads as a fixed cardinality — for TWO independent reasons, and fixing only one would
 * have reproduced the bug behind a more confident name:
 *   1. the SET was not fixed (the EMA term was folded in when regime could not name it);
 *   2. the COUNT filtered to non-zero contributions, which is a different statistic.
 *
 * The V2 spec that specified this field was itself ambiguous — "count + net sign of
 * moat-1-stripped CONTRIBUTING rows", with no ruling on whether a neutral withheld row
 * counts. The implementation resolved it one way and a reader the other. That is the
 * generator lesson: an ambiguous spec ships an ambiguous field.
 *
 * Prints one terminal `LEDGER_WITHHELD_VERDICT=PASS|FAIL|INDETERMINATE` (INDETERMINATE = 3).
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import {
  buildFactorLedger,
  formatFactorLedgerRemainder,
  WEIGHT_TERM_FIELD,
  WITHHELD_WEIGHT_TERMS,
  type FactorLedgerInput,
  type WeightTerm,
} from '../../src/lib/verdict-factors.js';
import { FUNDING_Z_WINDOW_DAYS } from '../../src/lib/funding-window.js';

const WEIGHTS = { rsi: 0.30, ema: 0.10, funding: 0.25, oi: 0.15, volume: 0.20 };
const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
  expect(cond, msg).toBe(true);
};

/** The four live samples the wave was opened over, by their distinguishing inputs. */
function sample(o: {
  name: string; ema: number; rsi: number; vol: number; regime: FactorLedgerInput['regime'];
  raw: number; rsiVal?: number | null; avgVol?: number;
}): { name: string; input: FactorLedgerInput } {
  return {
    name: o.name,
    input: {
      coin: 'TESTC',
      scores: {
        rsiScore: o.rsi, emaScore: o.ema, fundingScore: 40, oiScore: -20, volumeScore: o.vol,
        hurstVal: 0.60, squeezeActive: false,
        rsiVal: o.rsiVal === undefined ? 52 : o.rsiVal,
        avgCandleVol: o.avgVol === undefined ? 1000 : o.avgVol,
      },
      weights: WEIGHTS,
      outcome: { rawScore: o.raw },
      regime: o.regime,
      indicators: {
        funding_rate: -0.00006, funding_state: 'NORMAL', oi_change_pct: 2.4, oi_change_window: '24h',
        volume_24h: 1e9, trend_persistence: 'MEDIUM', breakout_pending: 'INACTIVE',
      },
      gates: { fundingZScore: -0.8, fundingWindowDays: FUNDING_Z_WINDOW_DAYS },
    },
  };
}

/** The four measured samples. XRP is the RANGING-with-signed-EMA case that made the set 3. */
const FIXTURES = [
  sample({ name: 'XRP', ema: -100, rsi: 0, vol: -30, regime: 'TRENDING_DOWN', raw: -27 }),
  sample({ name: 'BTC', ema: 100, rsi: 40, vol: -70, regime: 'TRENDING_UP', raw: 8 }),
  sample({ name: 'SOL', ema: -100, rsi: 0, vol: -30, regime: 'TRENDING_DOWN', raw: -15 }),
  // The divergence case: regime RANGING while emaScore is signed, which is exactly when
  // the old implementation folded `ema` into the withheld set and count went to 2.
  sample({ name: 'DOGE (regime/ema divergence)', ema: -100, rsi: -60, vol: 10, regime: 'RANGING', raw: -8 }),
  // SIGN-FLIP PROBE. The four measured samples all have |rsi+volume| large enough that
  // adding the EMA term (max ±10, the smallest weight) cannot change the sign — so a
  // corpus of only those four CANNOT detect the ema-fold regression, and a RED-VERIFY
  // that reinstated it passed against them. Here rsi+volume net +2 while ema is −10, so
  // folding ema in flips bullish → bearish and the assertion has something to catch.
  sample({ name: 'ema-fold sign-flip probe', ema: -100, rsi: 0, vol: 10, regime: 'RANGING', raw: -3 }),
];

/** |rsi+volume| vs the ema term — the fixtures where folding ema in would flip `net`. */
function wouldFlipIfEmaFolded(input: FactorLedgerInput): boolean {
  const withheld = input.scores.rsiScore * WEIGHTS.rsi + input.scores.volumeScore * WEIGHTS.volume;
  const withEma = withheld + input.scores.emaScore * WEIGHTS.ema;
  return Math.sign(withheld) !== Math.sign(withEma);
}

describe('CH4 — the withheld accounting has one unambiguous definition', () => {
  it('the fixture set is non-empty and contains the divergence case (VACUITY GUARD)', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(4);
    const diverged = FIXTURES.filter(({ input }) => buildFactorLedger(input).strippedRemainder.unnameableThisResponse.length > 0);
    check(diverged.length >= 1, 'VACUOUS: no fixture exercises the regime/ema divergence that caused the second variance');
  });

  it('AC4.1 — withheld_term_count is IDENTICAL across all four replayed fixtures', () => {
    const counts = FIXTURES.map(({ input }) => buildFactorLedger(input).strippedRemainder.withheldTermCount);
    check(new Set(counts).size === 1, `withheld_term_count still varies: ${JSON.stringify(counts)}`);
    expect(counts).toEqual(FIXTURES.map(() => 2));
    // The deprecated alias must agree, or a compat reader gets the old moving number.
    const legacy = FIXTURES.map(({ input }) => buildFactorLedger(input).strippedRemainder.count);
    expect(legacy).toEqual(counts);
  });

  it('AC4.2 — withheld + mapped = 5, derived from ONE object', () => {
    const terms = Object.keys(WEIGHT_TERM_FIELD) as WeightTerm[];
    const mapped = terms.filter((t) => WEIGHT_TERM_FIELD[t] !== null);
    // A total that does not reconcile is a HALT, not a rounding.
    check(
      WITHHELD_WEIGHT_TERMS.length + mapped.length === terms.length && terms.length === 5,
      `withheld ${WITHHELD_WEIGHT_TERMS.length} + mapped ${mapped.length} ≠ ${terms.length}`,
    );
    // And the emitted count is that same number, not a parallel constant.
    const emitted = buildFactorLedger(FIXTURES[0].input).strippedRemainder.withheldTermCount;
    check(emitted === WITHHELD_WEIGHT_TERMS.length, `emitted ${emitted} ≠ derived ${WITHHELD_WEIGHT_TERMS.length}`);
  });

  it('AC4.2b — unnameable_this_response is DISJOINT from the withheld set', () => {
    for (const { name, input } of FIXTURES) {
      const r = buildFactorLedger(input).strippedRemainder;
      for (const t of r.unnameableThisResponse) {
        check(
          !(WITHHELD_WEIGHT_TERMS as readonly string[]).includes(t),
          `${name}: "${t}" is reported unnameable AND withheld — the two sets must not overlap`,
        );
      }
    }
  });

  it('AC4.3 — `flat` renders distinctly from "not evaluated"', () => {
    // Genuinely cancelled: both withheld terms evaluated, contributions sum to zero.
    const cancelled = buildFactorLedger(
      sample({ name: 'cancelled', ema: 0, rsi: 100, vol: -150, regime: 'RANGING', raw: 0 }).input,
    ).strippedRemainder;
    // Not evaluated: RSI had too few candles, so its 0 is an absence, not a reading.
    const unmeasured = buildFactorLedger(
      sample({ name: 'unmeasured', ema: 0, rsi: 0, vol: 0, regime: 'RANGING', raw: 0, rsiVal: null, avgVol: 0 }).input,
    ).strippedRemainder;

    check(cancelled.net === 'flat', `cancelled case should be flat, got ${cancelled.net}`);
    check(cancelled.unevaluatedTerms.length === 0, `cancelled case reports unevaluated ${JSON.stringify(cancelled.unevaluatedTerms)}`);
    check(unmeasured.unevaluatedTerms.length === 2, `unmeasured case reports ${JSON.stringify(unmeasured.unevaluatedTerms)}, expected both terms`);
    // The two states must be TELLABLE APART on the wire — the whole point of the field.
    check(
      JSON.stringify(cancelled) !== JSON.stringify(unmeasured),
      'a cancelled remainder and an unmeasured one serialise identically — V2-D9 on a second field',
    );
  });

  it('AC4.4 — net reconciles with the withheld terms\' own signs, recomputed', () => {
    let flipProbes = 0;
    for (const { name, input } of FIXTURES) {
      const r = buildFactorLedger(input).strippedRemainder;
      // Recompute independently from the inputs rather than trusting the field.
      const expectedSum = input.scores.rsiScore * WEIGHTS.rsi + input.scores.volumeScore * WEIGHTS.volume;
      const expected = expectedSum > 0 ? 'bullish' : expectedSum < 0 ? 'bearish' : 'flat';
      check(r.net === expected, `${name}: net=${r.net} but rsi+volume sum to ${expectedSum.toFixed(2)} (${expected})`);
      if (wouldFlipIfEmaFolded(input)) flipProbes += 1;
    }
    // VACUITY GUARD. The assertion above only detects the ema-fold regression on a
    // fixture where including ema CHANGES the sign. Without one, a build that folds ema
    // back in passes — measured: a deliberate RED-VERIFY did exactly that against the
    // four live samples, all of whose |rsi+volume| dwarfs the 10%-weight ema term.
    check(flipProbes >= 1, 'VACUOUS: no fixture where folding ema in would flip `net` — this assertion cannot catch the regression it exists for');
  });

  it('AC4.5 — no NOUN-LESS count is the only reading available on the wire', () => {
    // CH4's Scope requires `count` to survive one deprecation cycle (additive within the
    // object; no consumer loses a key), so AC4.5 is read as its intent: a bare count must
    // never stand alone. It ships beside a noun-carrying name and equals it.
    const r = buildFactorLedger(FIXTURES[0].input).strippedRemainder;
    const wire = formatFactorLedgerRemainder(r);
    check('withheld_term_count' in wire, 'the noun-carrying name is absent from the wire shape');
    check(wire.count === wire.withheld_term_count, `count ${wire.count} ≠ withheld_term_count ${wire.withheld_term_count}`);
    check(Array.isArray(wire.unnameable_this_response), 'unnameable_this_response missing from the wire shape');
    check(Array.isArray(wire.unevaluated_terms), 'unevaluated_terms missing from the wire shape');
    expect(Object.keys(wire).sort()).toEqual(
      ['count', 'net', 'unevaluated_terms', 'unnameable_this_response', 'withheld_term_count'],
    );
  });
});

/**
 * The verdict token must tell the truth about the WHOLE suite.
 *
 * `check()` records into `failures[]`, but a bare `expect()` throws without touching it —
 * so a failing assertion produced a red suite and a `…_VERDICT=PASS` line at the same
 * time. Measured on this file. A token that can disagree with the run it describes is
 * worse than no token, because callers gate on the token by design.
 */
afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') failures.push(`test failed: ${ctx.task.name}`);
});

afterAll(() => {
  const vacuous = FIXTURES.length === 0;
  const verdict = vacuous ? 'INDETERMINATE' : failures.length === 0 ? 'PASS' : 'FAIL';
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.log(`LEDGER_WITHHELD_VERDICT=${verdict}`);
  if (vacuous) process.exitCode = 3;
});
