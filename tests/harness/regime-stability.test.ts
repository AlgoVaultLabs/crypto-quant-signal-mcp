/**
 * regime-stability.test.ts — SIGNAL-REGIME-LABEL-STABILITY-W1 R1-gate.
 *
 * Validates the zero-phase harness against a prediction computable from the CLASSIFIER'S
 * PARAMETERS ALONE. That ordering is the point: the closed form is the primary anchor and the
 * empirical run is its confirmation, not the other way round. A harness checked only against
 * its own output proves nothing.
 *
 * This REPLACES the method the wave was dispatched with. The original design compared a live
 * classification at bar `i` against a "hindsight" one computed with K more bars available;
 * because `ema()` and `rsi()` are strictly causal, that comparison is identically zero and its
 * golden check ("on a window with no transition the two agree at every index") is vacuously
 * true on every series. A golden check that cannot fail is not a golden check.
 *
 * Prints one terminal `REGIME_STABILITY_VERDICT=PASS|FAIL|INDETERMINATE`
 * (INDETERMINATE = 3, token-law default for a new gate — NOT `check_test_baseline.sh`'s 2).
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import * as H from './regime-replay.js';

const failures: string[] = [];
const check = (cond: boolean, msg: string): void => {
  if (!cond) failures.push(msg);
  expect(cond, msg).toBe(true);
};

/** Every corpus this file scores. Empty ⇒ the harness built nothing ⇒ REFUSE. */
const CORPORA = {
  reversal: H.trendReversalSeries(260, 1.0),
  monotone: H.monotoneSeries(300, 1.0),
  walk: H.seededWalk(600, 42),
};

describe('zero-phase regime harness', () => {
  it('VACUITY GUARD — every corpus is populated and scorable', () => {
    for (const [name, s] of Object.entries(CORPORA)) {
      check(s.length > 4 * H.EDGE_DISCARD_BARS, `VACUOUS: corpus ${name} has ${s.length} bars`);
      check(H.liveSeries(s).length > 0, `VACUOUS: corpus ${name} produced no live samples`);
      check(H.backwardSeries(s).length > 0, `VACUOUS: corpus ${name} produced no backward samples`);
    }
  });

  it('regime is a function of the CLOSES alone — funding / priceChange / OI cannot move it', () => {
    // Proves the comment on the harness's INERT inputs rather than trusting it.
    for (const [name, s] of Object.entries(CORPORA)) {
      check(H.assertRegimeIgnoresNonCandleInputs(s), `${name}: a non-candle input changed the regime`);
    }
  });

  /**
   * THE PRIMARY ANCHOR. Prediction is derived from the periods (9, 21) with no reference to
   * any measurement; the harness must reproduce it.
   */
  it('CLOSED FORM — measured crossover lag matches the parameter-only prediction', () => {
    const predicted = H.PREDICTED_CROSSOVER_LAG_BARS;
    check(Number.isFinite(predicted), 'the closed form did not converge — the prediction is unusable');
    check(predicted > 10 && predicted < 13, `closed form for 9/21 = ${predicted}, expected ≈11.64`);

    const s = CORPORA.reversal;
    // SIGNAL-REGIME-LABEL-RULE-FIX-W1-V2: keyed on the CROSSOVER, not the label. The closed
    // form is a property of sign(ema9 - ema21), which that wave left untouched; the LABEL now
    // carries a band + a 12-bar confirmation and has a deliberately different lag.
    const fwd = H.emaCrossTransitions(H.liveSeries(s));
    const bwd = H.emaCrossTransitions(H.backwardSeries(s));
    const pairs = H.pairLags(fwd, bwd);
    check(pairs.length > 0, 'VACUOUS: the reversal fixture produced no paired EMA-driven transition');

    const measured = pairs[0].lagBars;
    check(
      Math.abs(measured - predicted) <= 1.0,
      `measured ${measured} vs closed form ${predicted.toFixed(2)} — off by more than 1 bar`,
    );

    // And the FORWARD detection alone must land on ceil(prediction): the classifier fires on
    // the first bar whose sign has flipped.
    const reversalBar = 260 - 1;
    const emaFlip = fwd.find((t) => t.cause === 'ema_cross');
    check(!!emaFlip, 'VACUOUS: no EMA-driven transition in the forward series');
    if (emaFlip) {
      const fwdLag = emaFlip.index - reversalBar;
      check(
        Math.abs(fwdLag - Math.ceil(predicted)) <= 1,
        `forward detection lag ${fwdLag} vs ceil(closed form) ${Math.ceil(predicted)}`,
      );
    }
  });

  /**
   * PROVEN ABLE TO FAIL. The prediction is a pure function of the periods, so perturbing them
   * must move it — and the tolerance check must reject the unperturbed measurement against a
   * perturbed prediction. Without this the anchor could be a constant that happens to match.
   */
  it('the anchor is falsifiable — a perturbed period moves the prediction and the check rejects', () => {
    const real = H.PREDICTED_CROSSOVER_LAG_BARS;
    const perturbed = H.crossoverLagAfterReversal(5, 21);
    check(Number.isFinite(perturbed), 'perturbed closed form did not converge');
    check(
      Math.abs(perturbed - real) > 1.0,
      `perturbing EMA_FAST 9→5 moved the prediction only ${Math.abs(perturbed - real)} bars — the anchor is insensitive to the parameter it claims to depend on`,
    );

    const s = CORPORA.reversal;
    const pairs = H.pairLags(H.emaCrossTransitions(H.liveSeries(s)), H.emaCrossTransitions(H.backwardSeries(s)));
    check(pairs.length > 0, 'VACUOUS: no pair to test the rejection against');
    // The SAME measurement that passes against the true prediction must FAIL against the
    // perturbed one. If it passes both, the tolerance is too wide to detect anything.
    check(
      Math.abs(pairs[0].lagBars - perturbed) > 1.0,
      `the tolerance accepts BOTH the true (${real.toFixed(2)}) and the perturbed (${perturbed.toFixed(2)}) prediction — it cannot discriminate`,
    );
  });

  it('a monotone ramp yields NO crossover transition — the harness does not hallucinate flips', () => {
    const emaDriven = H.emaCrossTransitions(H.liveSeries(CORPORA.monotone));
    check(emaDriven.length === 0, `monotone ramp produced ${emaDriven.length} EMA-driven transitions`);
  });

  /**
   * ⚠️ FLIPPED by SIGNAL-REGIME-LABEL-RULE-FIX-W1-V2. This test used to ASSERT THE DEFECT:
   *
   *   it('DEMONSTRATED — a perfect uptrend is labelled RANGING for its entire duration')
   *
   * It was the predecessor's deterministic demonstration that a saturating RSI forced the
   * wrong label. That wave measured; this wave fixed it, so the assertion is inverted rather
   * than deleted — an exemption and the test that encoded it are a pair, and removing only
   * one half leaves either a guard that cannot fire or a lie in the suite.
   *
   * The PRECONDITIONS are still asserted (`emaCross` BULLISH, RSI still saturating at ≥ 70),
   * so this cannot pass because the fixture stopped exercising the path.
   */
  it('FIXED — a perfect uptrend is TRENDING_UP, though its RSI still saturates', () => {
    const samples = H.liveSeries(CORPORA.monotone);
    check(samples.length > 100, `VACUOUS: only ${samples.length} samples on the monotone ramp`);
    const mid = samples[Math.floor(samples.length / 2)];
    // Preconditions: the v1 defect path is still live in the DATA...
    check(mid.emaCross === 'BULLISH', `mid-ramp emaCross = ${mid.emaCross}, expected BULLISH`);
    check(mid.rsiVal !== null && mid.rsiVal >= 70, `mid-ramp rsiVal = ${mid.rsiVal}, expected >= 70 (else the fixture stopped testing the defect)`);
    // ...and the RULE no longer converts it into the wrong label.
    check(mid.regime === 'TRENDING_UP', `mid-ramp regime = ${mid.regime}, expected TRENDING_UP`);
    const steady = samples.slice(H.EMA_SLOW + 12);
    check(steady.length > 100, `VACUOUS: steady state only ${steady.length} samples`);
    check(steady.every((x) => x.regime === 'TRENDING_UP'), `steady-state labels: ${[...new Set(steady.map((x) => x.regime))].join(', ')}`);
    // And the v1 rule, frozen in the harness, still shows the old behaviour — so the
    // before/after comparison has a real "before".
    check(H.legacyRuleIsFrozen().length === 0, `legacy v1 reference drifted: ${H.legacyRuleIsFrozen().join('; ')}`);
  });

  it('churn metrics are computed and the round-trip rate is well-formed', () => {
    const c = H.churnOf(H.liveSeries(CORPORA.walk));
    check(c.bars > 0, 'VACUOUS: churn computed over zero bars');
    check(c.n_transitions > 0, 'VACUOUS: the walk corpus produced no transitions to characterise');
    check(
      c.round_trip_rate !== null && c.round_trip_rate >= 0 && c.round_trip_rate <= 1,
      `round_trip_rate out of range: ${c.round_trip_rate}`,
    );
    const causeSum = c.cause_ema_cross + c.cause_rsi_band + c.cause_both + c.cause_unknown;
    check(causeSum === c.n_transitions, `cause decomposition sums to ${causeSum}, expected ${c.n_transitions}`);
  });

  /**
   * The R4 sweep restates the 3-line decision rule so the hardcoded periods can be varied.
   * This is what makes that restatement safe: at the shipped (9, 21, 14) it must reproduce
   * production EXACTLY. An unpinned counterfactual silently stops describing the thing it is
   * counterfactual to.
   */
  it('PIN — the frozen v1 reference still reproduces the pre-wave rule', () => {
    // Was: "the sweep variant reproduces PRODUCTION at (9,21,14)". Production's rule changed,
    // so that pin is false by design; it is replaced rather than weakened. This asserts the
    // two behaviours that DEFINED v1, so the "before" side of every comparison stays honest.
    const violations = H.legacyRuleIsFrozen();
    check(violations.length === 0, `legacy v1 reference drifted: ${violations.join('; ')}`);
  });

  it('the sweep responds to its periods — a different setting yields different churn', () => {
    const base = H.sweepChurn(CORPORA.walk, H.EMA_FAST, H.EMA_SLOW);
    const faster = H.sweepChurn(CORPORA.walk, 5, 13);
    check(base > 0, 'VACUOUS: baseline sweep produced zero flips');
    check(faster !== base, `sweep is insensitive to its periods — (9,21) and (5,13) both give ${base}`);
  });

  it('the declared INDETERMINATE threshold is enforced, not advisory', () => {
    check(H.MIN_TRANSITIONS_FOR_LATENCY === 30, `threshold drifted to ${H.MIN_TRANSITIONS_FOR_LATENCY}`);
    check(
      H.latencyVerdict({ n_transitions_observed: 29, p50: 1, p90: 2, max: 3 }) === 'INDETERMINATE',
      '29 transitions did not report INDETERMINATE',
    );
    check(
      H.latencyVerdict({ n_transitions_observed: 30, p50: 1, p90: 2, max: 3 }) === 'MEASURED',
      '30 transitions did not report MEASURED',
    );
  });
});

afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') failures.push(`test failed: ${ctx.task.name}`);
});

afterAll(() => {
  const vacuous = Object.values(CORPORA).some((s) => s.length === 0);
  const verdict = vacuous ? 'INDETERMINATE' : failures.length === 0 ? 'PASS' : 'FAIL';
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.log(`REGIME_STABILITY_VERDICT=${verdict}`);
  if (vacuous) process.exitCode = 3;
});
