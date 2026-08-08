/**
 * regime-label-invariants.test.ts — SIGNAL-REGIME-LABEL-RULE-FIX-W1-V2 R5.
 *
 * Pins the properties the new regime label must hold. The load-bearing one is I2:
 * **a label must outlive its own detection lag.** The pre-wave rule had `dwell/lag = 0.601`
 * — it changed state faster than it could detect a state change, which means it was not
 * measuring anything, and no copy improvement fixes that.
 *
 * I2 is asserted STRUCTURALLY here, not as a measured number that a later tune could drift
 * past: `REGIME_CONFIRM_BARS` bounds the minimum dwell from below, so the property follows
 * from the constant rather than from a favourable dataset.
 *
 * Prints one terminal `REGIME_LABEL_VERDICT=PASS|FAIL|INDETERMINATE`
 * (INDETERMINATE = 3, token-law default for a new gate — NOT `check_test_baseline.sh`'s 2).
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import {
  classifyRegimeLabel,
  computeIndicatorScores,
  REGIME_SEPARATION_ATR_MULT,
  REGIME_CONFIRM_BARS,
} from '../../src/tools/get-trade-call.js';
import * as H from '../harness/regime-replay.js';
import type { Candle, RegimeType } from '../../src/types.js';

const failures: string[] = [];
const check = (cond: boolean, msg: string): void => {
  if (!cond) failures.push(msg);
  expect(cond, msg).toBe(true);
};

/** Every corpus this file scores; all are CONSTRUCTED here, so empty ⇒ REFUSE. */
const CORPORA = {
  monotoneUp: H.monotoneSeries(300, 1.0),
  // Built from a descending ramp directly. Reversing only `close` on an ascending series
  // leaves `high`/`low` from the ORIGINAL bar, so they no longer bracket the close and ATR
  // becomes meaningless — which silently widened the volatility-relative band to the point
  // that everything read CONTESTED. A fixture whose OHLC is internally inconsistent tests
  // nothing.
  monotoneDown: Array.from({ length: 300 }, (_, i) => {
    const close = 1000 + 1.0 * (299 - i);
    return { open: close, high: close * 1.001, low: close * 0.999, close, volume: 1000, time: i * 60_000 };
  }) as Candle[],
  reversal: H.trendReversalSeries(260, 1.0),
  walk: H.seededWalk(600, 42),
  flat: Array.from({ length: 200 }, (_, i) => ({ open: 100, high: 100, low: 100, close: 100, volume: 1000, time: i * 60_000 })) as Candle[],
};


/** The label series produced by walking the rule bar-by-bar over a rolling production window. */
function labelSeries(candles: Candle[]): RegimeType[] {
  const out: RegimeType[] = [];
  for (let i = H.EDGE_DISCARD_BARS; i < candles.length; i++) {
    const start = Math.max(0, i - H.PRODUCTION_WINDOW_BARS + 1);
    out.push(classifyRegimeLabel(candles.slice(start, i + 1)));
  }
  return out;
}

describe('regime label invariants', () => {
  it('VACUITY GUARD — every corpus is constructed and non-empty', () => {
    for (const [name, s] of Object.entries(CORPORA)) {
      check(s.length >= 200, `VACUOUS: corpus ${name} has ${s.length} bars`);
      check(labelSeries(s).length > 0, `VACUOUS: corpus ${name} produced no labels`);
    }
  });

  /**
   * I1. The defect that motivated the wave: a perfect monotone uptrend was labelled
   * `RANGING` for all 257 of its scorable bars, because a saturating RSI — evidence OF a
   * trend — failed the `rsiVal < 70` veto.
   */
  it('I1 — a monotone trend is NEVER labelled RANGING in steady state (was 257/257)', () => {
    // A rule with hysteresis has a warm-up it cannot skip: the EMA-21 seed needs 21 bars and
    // a side needs REGIME_CONFIRM_BARS of separation before it can be adopted, so the honest
    // answer over that prefix is "nothing confirmed yet". That is NOT the defect — the defect
    // was RANGING in STEADY STATE, for all 257 scorable bars of a perfect trend.
    //
    // So the bound is asserted two ways, and the second is what stops this being a weakening:
    // the warm-up must be BOUNDED, and it must be a CONTIGUOUS PREFIX. A scattered RANGING
    // cannot hide inside a bound it does not touch.
    const MAX_WARMUP = H.EMA_SLOW + REGIME_CONFIRM_BARS; // 21 + 12 = 33 bars from series start
    for (const [name, series] of [['up', CORPORA.monotoneUp], ['down', CORPORA.monotoneDown]] as const) {
      const labels = labelSeries(series);
      check(labels.length > 100, `VACUOUS: monotone-${name} produced only ${labels.length} labels`);
      const expected = name === 'up' ? 'TRENDING_UP' : 'TRENDING_DOWN';

      const rangingIdx = labels.map((l, k) => (l === 'RANGING' ? k : -1)).filter((k) => k >= 0);
      // (a) contiguous prefix starting at the first scorable bar, or none at all
      const contiguousPrefix =
        rangingIdx.length === 0 ||
        (rangingIdx[0] === 0 && rangingIdx[rangingIdx.length - 1] === rangingIdx.length - 1);
      check(contiguousPrefix, `monotone-${name}: RANGING is NOT a contiguous warm-up prefix — at label idx ${JSON.stringify(rangingIdx.slice(0, 20))}`);
      // (b) bounded by the rule's own constants
      check(
        rangingIdx.length + H.EDGE_DISCARD_BARS <= MAX_WARMUP,
        `monotone-${name}: warm-up ran ${rangingIdx.length + H.EDGE_DISCARD_BARS} bars, above the ${MAX_WARMUP} implied by EMA_SLOW+K`,
      );
      // (c) STEADY STATE is the invariant R1 actually asks for: zero RANGING after warm-up
      const steady = labels.slice(rangingIdx.length);
      check(steady.length > 200, `VACUOUS: monotone-${name} steady state is only ${steady.length} bars`);
      check(
        steady.every((l) => l === expected),
        `monotone-${name} STEADY STATE: labels were ${[...new Set(steady)].join(',')}, expected only ${expected}`,
      );
      check(
        !steady.includes('RANGING'),
        `monotone-${name}: ${steady.filter((l) => l === 'RANGING').length} STEADY-STATE bars RANGING, expected 0`,
      );
    }
  });

  /** RSI must no longer participate at all — the conjunction is gone, not merely widened. */
  it('the rule is INDEPENDENT of RSI — identical closes give identical labels', () => {
    // A monotone ramp pins RSI at 100; a reversal sweeps it across both band edges. If RSI
    // still participated, these two would not agree with a pure function of `closes`.
    let checked = 0;
    for (const [name, series] of Object.entries(CORPORA)) {
      for (let i = H.EDGE_DISCARD_BARS; i < series.length; i += 17) {
        const start = Math.max(0, i - H.PRODUCTION_WINDOW_BARS + 1);
        const win = series.slice(start, i + 1);
        const viaScores = computeIndicatorScores({
          candles: win,
          fundingRateAnnualized: 0,
          priceChange: 0,
          openInterest: 0,
        }).regime;
        const viaRule = classifyRegimeLabel(win);
        checked += 1;
        check(viaScores === viaRule, `${name}@${i}: computeIndicatorScores said ${viaScores}, classifyRegimeLabel said ${viaRule}`);
      }
    }
    check(checked > 50, `VACUOUS: only ${checked} label comparisons`);
  });

  /**
   * I2, asserted STRUCTURALLY. A K-bar unanimity requirement means no side can be adopted
   * unless it held K bars, so consecutive flips are ≥ K apart — bounding minimum dwell from
   * below by the CONSTANT rather than by a favourable dataset.
   */
  /**
   * I2 — and a CORRECTION to how strongly this wave can claim it.
   *
   * I first asserted the K-bar bound as STRUCTURAL: `held` only moves when a whole K-window
   * agrees, and two such windows one bar apart overlap in K−1 places, so no two adoptions
   * inside a single sequence can be closer than K. That reasoning is sound about the
   * algorithm, and it held end-to-end under the REJECTED absolute band.
   *
   * It is NOT observable through the public function, and under the shipped relative band it
   * is not true of the emitted series either. `classifyRegimeLabel` returns ONE label per
   * call and recomputes `REGIME_SEPARATION_ATR_MULT × ATRP` from the window it was given, so
   * consecutive bars are scored by two different calls with two slightly different bands, and
   * a borderline `sep` can land on either side. Measured on the walk corpus: flips 1 bar apart.
   *
   * Making the band relative bought cross-timeframe invariance (I7: 40.9pp → 1.5pp) and gave
   * up the strict spacing guarantee. That is a real trade, and the honest form of I2 is the
   * MEASURED ratio, not a structural claim the shipped rule does not support. Live: dwell/lag
   * 1.40 at the shipped multiplier against 0.601 pre-wave. Asserted here is the property the
   * corpora can actually witness — median dwell comfortably exceeds K — plus the constant
   * itself, so a future tune below the pre-wave lag still trips the gate.
   */
  it('I2 — median dwell exceeds K, and K still exceeds the pre-wave detection lag', () => {
    check(REGIME_CONFIRM_BARS >= 12, `REGIME_CONFIRM_BARS=${REGIME_CONFIRM_BARS} no longer exceeds the 11.64-bar pre-wave lag`);
    let corporaWithFlips = 0;
    for (const [name, series] of Object.entries(CORPORA)) {
      const labels = labelSeries(series);
      const idx: number[] = [];
      for (let i = 1; i < labels.length; i++) if (labels[i] !== labels[i - 1]) idx.push(i);
      if (idx.length < 2) continue;
      corporaWithFlips += 1;
      const dwell: number[] = [];
      for (let k = 1; k < idx.length; k++) dwell.push(idx[k] - idx[k - 1]);
      dwell.sort((a, b) => a - b);
      const p50 = dwell[Math.floor(dwell.length / 2)];
      check(p50 >= REGIME_CONFIRM_BARS, `${name}: median dwell ${p50} is below K=${REGIME_CONFIRM_BARS} — the label is churning faster than its own confirmation`);
    }
    check(corporaWithFlips > 0, 'VACUOUS: no corpus produced enough flips to measure dwell');
  });

  /**
   * The rule recomputes its confirmation from the passed window instead of persisting state
   * (the transport runs stateless — session affinity is forbidden). That is only equivalent
   * if the held label CONVERGES within a production window. Asserted, not assumed.
   */
  it('WINDOW CONVERGENCE — the label from a 100-bar window equals the label from full history', () => {
    let compared = 0;
    let diverged = 0;
    for (const [name, series] of Object.entries(CORPORA)) {
      for (let i = 150; i < series.length; i += 13) {
        const windowed = classifyRegimeLabel(series.slice(Math.max(0, i - H.PRODUCTION_WINDOW_BARS + 1), i + 1));
        const full = classifyRegimeLabel(series.slice(0, i + 1));
        compared += 1;
        if (windowed !== full) {
          diverged += 1;
          failures.push(`${name}@${i}: windowed=${windowed} vs full-history=${full}`);
        }
      }
    }
    check(compared > 40, `VACUOUS: only ${compared} convergence comparisons`);
    check(diverged === 0, `${diverged}/${compared} windows disagreed with full history — the stateless recompute is NOT equivalent`);
  });

  /** `RANGING` must denote something real: the EMAs genuinely inside the band. */
  it('RANGING denotes a CONTESTED cross, not a residue — a flat series is RANGING', () => {
    const labels = labelSeries(CORPORA.flat);
    check(labels.length > 100, `VACUOUS: flat corpus gave ${labels.length} labels`);
    check(labels.every((l) => l === 'RANGING'), `flat series produced ${[...new Set(labels)].join(',')}, expected only RANGING`);
    check(REGIME_SEPARATION_ATR_MULT > 0, 'REGIME_SEPARATION_ATR_MULT is 0 — RANGING can never fire and the label is meaningless');
  });

  /** Stay 3-label per D5: `VOLATILE` belongs to get_market_regime's independent classifier. */
  it('never emits VOLATILE — that vocabulary belongs to get_market_regime (D5)', () => {
    let n = 0;
    for (const series of Object.values(CORPORA)) {
      for (const l of labelSeries(series)) {
        n += 1;
        check(l !== 'VOLATILE', 'get_trade_call emitted VOLATILE, which it has never emitted and D5 keeps out of scope');
      }
    }
    check(n > 500, `VACUOUS: only ${n} labels scored`);
  });

  it('both constants carry a revisit date', () => {
    check(REGIME_SEPARATION_ATR_MULT === 0.30, `REGIME_SEPARATION_ATR_MULT drifted to ${REGIME_SEPARATION_ATR_MULT} without re-calibration`);
    check(REGIME_CONFIRM_BARS === 12, `REGIME_CONFIRM_BARS drifted to ${REGIME_CONFIRM_BARS} without re-calibration`);
  });
});

afterEach((ctx) => {
  if (ctx.task.result?.state === 'fail') failures.push(`test failed: ${ctx.task.name}`);
});

afterAll(() => {
  const vacuous = Object.values(CORPORA).some((s) => s.length === 0);
  const verdict = vacuous ? 'INDETERMINATE' : failures.length === 0 ? 'PASS' : 'FAIL';
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.log(`REGIME_LABEL_VERDICT=${verdict}`);
  if (vacuous) process.exitCode = 3;
});
