/**
 * DECISION-CALL-V2-W4 CH2 — `noEdgeOdds` (src/lib/pre-trade-calc.ts): the no-edge odds the check log
 * records and never serves.
 *
 * AC2.1 — on the study's own fixture vectors (tests/fixtures/odds-calibration/bm-vectors.json, written by
 * gen_bm_vectors.py from the study's bm_probs / log_barriers / liq_log_distance), the raw BM values agree
 * within 1e-9, stay in [0, 1], and time-out + target-first + stop-first = 1 ± 1e-9, with stop-first computed
 * by its own swapped-barrier series. The calibrated values are the generated table's bin for the bin index
 * the study's `searchsorted(edges, v, side="right")` selects, recorded in the fixture.
 *
 * AC2.2 — each mutation goes red here: the recalibration skipped (the calibrated values become the raw
 * ones), a side flip in the log-barrier mapping (the short vectors' raw values move). The third mutation,
 * an odds key reaching the response, is caught by the wire test in pre-trade-check-log.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { noEdgeOdds } from '../../src/lib/pre-trade-calc.js';
import { ODDS_CALIBRATION, ODDS_VERSION } from '../../src/lib/pre-trade-odds-calibration.js';

const ROOT = path.resolve(__dirname, '../..');
const TOL = 1e-9;

interface BracketVector {
  label: string; side: 'long' | 'short'; stopPct: number; targetPct: number; sigmaHoldPct: number; guarded: boolean;
  timeout?: number; targetFirst?: number; stopFirst?: number; timeoutBin?: number; targetFirstBin?: number;
  /** Every bin a TS value may land in: the study's own, plus the neighbour across an edge within 1e-12. */
  timeoutBins?: number[]; targetFirstBins?: number[]; nearEdge?: boolean;
  pTimeout?: number; pTargetFirst?: number; pStopFirst?: number;
}
interface LiqVector {
  label: string; side: 'long' | 'short'; liqDistancePct: number; sigmaHoldPct: number; guarded: boolean;
  dOverSigmaH?: number; liqBin?: number; liqBins?: number[]; nearEdge?: boolean; pLiqHold?: number;
}
interface Fixture {
  _study_sha256: string; _table_sha256: string; saturationRatio: number; saturationExactSigma: number;
  bracket: BracketVector[]; liquidation: LiqVector[];
}

const FIX: Fixture = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'odds-calibration', 'bm-vectors.json'), 'utf8'));
const sha = (rel: string) => createHash('sha256').update(readFileSync(path.join(ROOT, rel))).digest('hex');
const bracketOdds = (v: BracketVector) =>
  noEdgeOdds({ side: v.side, stopPct: v.stopPct, targetPct: v.targetPct, sigmaHoldPct: v.sigmaHoldPct, liqDistancePct: null });
const scored = FIX.bracket.filter((v) => !v.guarded);
const bins = ODDS_CALIBRATION.fields;

describe('AC2.1 — the fixture is the study\'s, for the table as committed', () => {
  it('generated from this study script and this generated table (a re-emit or a study edit regenerates it)', () => {
    expect(FIX._study_sha256).toBe(sha('scripts/odds-calibration-study.py'));
    expect(FIX._table_sha256).toBe(sha('src/lib/pre-trade-odds-calibration.ts'));
  });

  it('covers both sides, the study\'s cells, the production domain, the clamp and every guard', () => {
    expect(scored.length).toBeGreaterThan(400);
    expect(scored.filter((v) => v.side === 'short').length).toBeGreaterThan(150);
    // the single-bin vectors carry the exact bin assertion; a near-edge one allows only the two bins beside it
    expect(scored.filter((v) => !v.nearEdge).length).toBeGreaterThan(150);
    for (const v of scored) expect((v.timeoutBins as number[]).length + (v.targetFirstBins as number[]).length).toBeLessThanOrEqual(4);
    for (const l of ['study bracket', 'study 1 sigma / 2 sigma', 'random production domain', 'clamp: calibrated sum above 1',
      'exact saturation: both barriers far', 'guard: saturated with a near stop', 'guard: short target 100% (barrier inf)',
      'guard: short target 150% (barrier nan)']) {
      expect(FIX.bracket.some((v) => v.label === l), l).toBe(true);
    }
    expect(FIX.liquidation.filter((v) => !v.guarded).length).toBeGreaterThan(100);
    expect(FIX.liquidation.filter((v) => v.guarded).length).toBe(3);
  });
});

describe('AC2.1 — raw driftless-BM odds equal the study\'s', () => {
  it('every scored bracket vector: time-out, target-first and stop-first within 1e-9', () => {
    for (const v of scored) {
      const o = bracketOdds(v);
      expect(Math.abs((o.raw.timeout as number) - (v.timeout as number)), `${v.label} ${v.side} ${v.stopPct}/${v.targetPct}/${v.sigmaHoldPct}`).toBeLessThanOrEqual(TOL);
      expect(Math.abs((o.raw.targetFirst as number) - (v.targetFirst as number))).toBeLessThanOrEqual(TOL);
      expect(Math.abs((o.raw.stopFirst as number) - (v.stopFirst as number))).toBeLessThanOrEqual(TOL);
    }
  });

  it('each raw value stays in [0, 1], and the three partition the outcomes: sum = 1 ± 1e-9', () => {
    for (const v of scored) {
      const r = bracketOdds(v).raw;
      for (const p of [r.timeout, r.targetFirst, r.stopFirst] as number[]) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
      expect(Math.abs((r.timeout as number) + (r.targetFirst as number) + (r.stopFirst as number) - 1)).toBeLessThanOrEqual(TOL);
    }
  });

  it('a short is not a long: on asymmetric brackets the two sides differ, and each matches its own study value', () => {
    let asym = 0;
    for (const v of scored.filter((x) => x.label === 'study bracket' && x.side === 'short' && x.sigmaHoldPct >= 0.5)) {
      const long = bracketOdds({ ...v, side: 'long' });
      const short = bracketOdds(v);
      if (Math.abs((long.raw.targetFirst as number) - (short.raw.targetFirst as number)) > 1e-6) asym += 1;
    }
    expect(asym).toBeGreaterThan(10);
  });

  it('the guarded region is null, never a shortcut value: a saturated bracket with a near barrier, a non-finite short barrier', () => {
    for (const v of FIX.bracket.filter((x) => x.guarded)) {
      const o = bracketOdds(v);
      expect([o.raw.timeout, o.raw.targetFirst, o.raw.stopFirst, o.pTimeout, o.pTargetFirst, o.pStopFirst], v.label).toEqual([null, null, null, null, null, null]);
    }
    const far = FIX.bracket.find((x) => x.label === 'exact saturation: both barriers far') as BracketVector;
    expect(bracketOdds(far).raw).toMatchObject({ timeout: 1, targetFirst: 0, stopFirst: 0 });
  });
});

describe('AC2.1 — the odds-v1 recalibration, as the study bins', () => {
  it('every scored vector: the calibrated time-out and target-first are the table value of the study\'s bin', () => {
    for (const v of scored) {
      const o = bracketOdds(v);
      const at = `${v.label} ${v.side} ${v.stopPct}/${v.targetPct}/${v.sigmaHoldPct}`;
      expect((v.timeoutBins as number[]).map((j) => bins.timeout.recalBins[j].value), at).toContain(o.pTimeout);
      expect((v.targetFirstBins as number[]).map((j) => bins.target_first.recalBins[j].value), at).toContain(o.pTargetFirst);
      if (v.nearEdge) continue;
      expect(o.pTimeout, at).toBe(bins.timeout.recalBins[v.timeoutBin as number].value);
      expect(o.pTargetFirst, at).toBe(bins.target_first.recalBins[v.targetFirstBin as number].value);
      expect(o.pTimeout).toBe(v.pTimeout);
      expect(o.pTargetFirst).toBe(v.pTargetFirst);
    }
  });

  it('p_stop_first is max(0, 1 − p_timeout − p_target_first), in [0, 1]', () => {
    for (const v of scored) {
      const o = bracketOdds(v);
      expect(o.pStopFirst).toBe(Math.max(0, 1 - (o.pTimeout as number) - (o.pTargetFirst as number)));
      if (!v.nearEdge) expect(o.pStopFirst).toBe(v.pStopFirst);
      expect(o.pStopFirst as number).toBeGreaterThanOrEqual(0);
      expect(o.pStopFirst as number).toBeLessThanOrEqual(1);
    }
  });

  it('the clamp vector: the calibrated pair sums above 1, so p_stop_first is exactly 0 (ruling Q1)', () => {
    const v = FIX.bracket.find((x) => x.label === 'clamp: calibrated sum above 1') as BracketVector;
    const o = bracketOdds(v);
    expect(Math.abs((o.raw.timeout as number) - 0.96)).toBeLessThan(0.01);
    expect(Math.abs((o.raw.targetFirst as number) - 0.036)).toBeLessThan(0.006);
    expect((o.pTimeout as number) + (o.pTargetFirst as number)).toBeGreaterThan(1);
    expect(o.pStopFirst).toBe(0);
  });

  it('the recalibration is applied, not passed through: most calibrated values differ from their raw BM value', () => {
    const moved = scored.filter((v) => { const o = bracketOdds(v); return o.pTimeout !== o.raw.timeout && o.pTargetFirst !== o.raw.targetFirst; });
    expect(moved.length).toBeGreaterThan(scored.length * 0.9);
  });

  it('liquidation: d_ln/σ_H equals the study\'s (1e-9 relative), p_liq_hold is its bin\'s value; d ≤ 0 or an infinite distance is null', () => {
    for (const v of FIX.liquidation) {
      const o = noEdgeOdds({ side: v.side, stopPct: null, targetPct: null, sigmaHoldPct: v.sigmaHoldPct, liqDistancePct: v.liqDistancePct });
      if (v.guarded) {
        expect([o.raw.liqDOverSigmaH, o.pLiqHold], v.label).toEqual([null, null]);
        continue;
      }
      const x = v.dOverSigmaH as number;
      expect(Math.abs((o.raw.liqDOverSigmaH as number) - x) / Math.max(1, Math.abs(x)), `${v.side} ${v.liqDistancePct}/${v.sigmaHoldPct}`).toBeLessThanOrEqual(TOL);
      expect((v.liqBins as number[]).map((j) => bins.liquidation.recalBins[j].value)).toContain(o.pLiqHold);
      if (v.nearEdge) continue;
      expect(o.pLiqHold).toBe(bins.liquidation.recalBins[v.liqBin as number].value);
      expect(o.pLiqHold).toBe(v.pLiqHold);
    }
  });
});

describe('noEdgeOdds — null when an input is absent, and always the table it used', () => {
  const base = { side: 'long' as const, stopPct: 2, targetPct: 4, sigmaHoldPct: 1.7726, liqDistancePct: 4.6185 };

  it('a full order yields all four values and odds-v1', () => {
    const o = noEdgeOdds(base);
    expect(o.oddsVersion).toBe(ODDS_VERSION);
    expect(o.oddsVersion).toBe('odds-v1');
    for (const p of [o.pTimeout, o.pTargetFirst, o.pStopFirst, o.pLiqHold]) expect(typeof p).toBe('number');
  });

  it('no σ: every value null; no stop or no target: the bracket null, liquidation kept; no distance: liquidation null', () => {
    const none = noEdgeOdds({ ...base, sigmaHoldPct: null });
    expect([none.pTimeout, none.pTargetFirst, none.pStopFirst, none.pLiqHold, none.raw.liqDOverSigmaH]).toEqual([null, null, null, null, null]);
    for (const over of [{ stopPct: null }, { targetPct: null }, { stopPct: 0 }, { targetPct: -1 }]) {
      const o = noEdgeOdds({ ...base, ...over });
      expect([o.raw.timeout, o.pTimeout, o.pTargetFirst, o.pStopFirst], JSON.stringify(over)).toEqual([null, null, null, null]);
      expect(typeof o.pLiqHold).toBe('number');
    }
    const noLiq = noEdgeOdds({ ...base, liqDistancePct: null });
    expect([noLiq.raw.liqDOverSigmaH, noLiq.pLiqHold]).toEqual([null, null]);
    expect(typeof noLiq.pTimeout).toBe('number');
    for (const bad of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(noEdgeOdds({ ...base, sigmaHoldPct: bad }).pTimeout).toBeNull();
    }
  });
});
