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
    const fwd = H.transitionsOf(H.liveSeries(s));
    const bwd = H.transitionsOf(H.backwardSeries(s));
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
    const pairs = H.pairLags(H.transitionsOf(H.liveSeries(s)), H.transitionsOf(H.backwardSeries(s)));
    check(pairs.length > 0, 'VACUOUS: no pair to test the rejection against');
    // The SAME measurement that passes against the true prediction must FAIL against the
    // perturbed one. If it passes both, the tolerance is too wide to detect anything.
    check(
      Math.abs(pairs[0].lagBars - perturbed) > 1.0,
      `the tolerance accepts BOTH the true (${real.toFixed(2)}) and the perturbed (${perturbed.toFixed(2)}) prediction — it cannot discriminate`,
    );
  });

  it('a monotone ramp yields NO crossover transition — the harness does not hallucinate flips', () => {
    const fwd = H.transitionsOf(H.liveSeries(CORPORA.monotone));
    const emaDriven = fwd.filter((t) => t.cause === 'ema_cross' || t.cause === 'both');
    check(emaDriven.length === 0, `monotone ramp produced ${emaDriven.length} EMA-driven transitions`);
  });

  /**
   * The RSI-band path, demonstrated on a DETERMINISTIC fixture rather than argued for. A
   * perfect uptrend pins RSI at 100, so `rsiVal < 70` fails and the public label collapses to
   * RANGING for the entire trend. Pinned here so that if the gate is ever changed, the change
   * is deliberate and visible.
   */
  it('DEMONSTRATED — a perfect uptrend is labelled RANGING for its entire duration', () => {
    const samples = H.liveSeries(CORPORA.monotone);
    check(samples.length > 100, `VACUOUS: only ${samples.length} samples on the monotone ramp`);
    const labels = new Set(samples.map((s) => s.regime));
    check(labels.size === 1 && labels.has('RANGING'), `monotone uptrend labels: ${[...labels].join(', ')}`);
    const mid = samples[Math.floor(samples.length / 2)];
    check(mid.emaCross === 'BULLISH', `mid-ramp emaCross = ${mid.emaCross}, expected BULLISH`);
    check(mid.rsiVal !== null && mid.rsiVal >= 70, `mid-ramp rsiVal = ${mid.rsiVal}, expected >= 70`);
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
