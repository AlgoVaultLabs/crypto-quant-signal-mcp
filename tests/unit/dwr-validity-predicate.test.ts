/**
 * dwr-validity-predicate.test.ts — EDGE-DWR-VALIDATED-PREDICATE-W1.
 *
 * The bar itself, under test. Written RED-FIRST: §1 encodes the PREVIOUS predicate and proves
 * that the two fixtures below — both LIVE `validated: true` cells measured from production on
 * 2026-08-26 — satisfy it. Every assertion in §1 fails if the fixtures do not reproduce the
 * defect, so §2's green is meaningful rather than vacuous.
 *
 * FIXTURE PROVENANCE (all figures measured, none invented):
 *   - cell statistics: `node dist/scripts/dwr-baseline-report.js` in-container, 2026-08-26T13:38Z
 *   - holdout splits:  the 70/30 cut replayed in SQL against `directional_labels ⋈ signals`
 *   - barrier medians: `percentile_cont(0.5) … ORDER BY dl.barrier_pct` over the same rows
 */
import { describe, expect, it } from 'vitest';
import {
  validityVerdict, VALIDITY_PREDICATE_VERSION, VALIDITY_POWERED_FLOOR, VALIDITY_HOLDOUT_ALPHA,
  type ValidityInput,
} from '../../src/scripts/edge-stats.js';
import { ROUND_TRIP_COST_PCT, FLOOR_PCT } from '../../src/scripts/directional-labeler.js';

const COST = ROUND_TRIP_COST_PCT;

/**
 * THE PREVIOUS BAR, transcribed from `dwr-baseline-report.ts` as it stood at 40eb00f:
 *   powered (n≥50) ∧ PT defined ∧ BH-FDR ∧ sign(holdoutEdge) === sign(fullEdge) ∧ holdoutP<0.05
 * Kept here — and ONLY here — so the regression has something to be red against. It is not
 * imported from anywhere; production no longer contains this logic.
 */
function legacyValidated(c: {
  nDecided: number; ptDefined: boolean; fdrReject: boolean;
  fullEdge: number; holdoutEdge: number; holdoutP: number | null;
}): boolean {
  if (c.nDecided < 50 || !c.ptDefined || !c.fdrReject) return false;
  const sameSign = Math.sign(c.holdoutEdge) === Math.sign(c.fullEdge) && c.fullEdge !== 0;
  return sameSign && c.holdoutP != null && c.holdoutP < 0.05;
}

/** τ=0.5 `5m|rest|c60_74|RANGING` — the cell EDGE-DWR-REFRESH-W1 flagged and could not fix. */
const CELL_A = {
  key: 'tau0.5 5m|rest|c60_74|RANGING',
  nDecided: 10_377, wins: 5124, losses: 5253,
  dwr: 5124 / 10_377,        // 0.49378…
  benchmark: 0.4893, wilsonLo: 0.4842,
  fullEdge: 0.0045,
  ptDefined: true, fdrReject: true,
  holdoutEdge: 0.503731 - 0.500339,  // +0.003392 — POSITIVE, so "same sign" held
  holdoutP: 0.0071296879132410895,
  barrierPctMedian: 0.394435,
};

/**
 * τ=0.5 `3m|rest|c60_74|TRENDING_DOWN` — the second, worse false positive, which the wave spec
 * did not know about. Its edge is NEGATIVE in the full sample AND in the holdout; two negatives
 * are "the same sign", so a persistence check that never checks DIRECTION certified a cell
 * measurably worse than always-SELL on both halves of the split.
 */
const CELL_B = {
  key: 'tau0.5 3m|rest|c60_74|TRENDING_DOWN',
  nDecided: 2703, wins: 1331, losses: 1372,
  dwr: 1331 / 2703,
  benchmark: 0.5194, wilsonLo: 0.4736,
  fullEdge: -0.0270,
  holdoutEdge: 0.504938 - 0.545679,  // −0.040741 — NEGATIVE
  ptDefined: true, fdrReject: true,
  holdoutP: 0.009379448403763258,
  barrierPctMedian: 0.620945,
};

function inputOf(c: typeof CELL_A | typeof CELL_B, over: Partial<ValidityInput> = {}): ValidityInput {
  return {
    nDecided: c.nDecided, wins: c.wins, losses: c.losses,
    benchmark: c.benchmark, wilsonLo: c.wilsonLo,
    ptDefined: c.ptDefined, fdrReject: c.fdrReject,
    holdoutEdge: c.holdoutEdge, holdoutP: c.holdoutP,
    barrierPctMedian: c.barrierPctMedian, roundTripCostPct: COST,
    ...over,
  };
}

// ── §1 — RED: the fixtures reproduce the defect under the OLD bar ───────────────────────────

describe('the previous predicate certified both live cells (red-first anchor)', () => {
  it('CELL_A: a cell losing 5,124 of 10,377 races was `validated`', () => {
    expect(CELL_A.wins).toBeLessThan(CELL_A.losses);
    expect(legacyValidated(CELL_A)).toBe(true);
  });

  it('CELL_B: a cell with a NEGATIVE edge in BOTH halves was `validated`', () => {
    expect(CELL_B.fullEdge).toBeLessThan(0);
    expect(CELL_B.holdoutEdge).toBeLessThan(0);
    // The exact mechanism: "same sign" is satisfied by two negatives.
    expect(Math.sign(CELL_B.holdoutEdge)).toBe(Math.sign(CELL_B.fullEdge));
    expect(legacyValidated(CELL_B)).toBe(true);
  });

  it('both cells were CI-overlapping and cost-negative all along — the old bar just never asked', () => {
    for (const c of [CELL_A, CELL_B]) {
      expect(c.wilsonLo).toBeLessThan(c.benchmark);           // CI contains the benchmark
      expect(2 * (c.wilsonLo - c.benchmark) * c.barrierPctMedian).toBeLessThan(COST);
      expect(2 * (c.wilsonLo - 0.5) * c.barrierPctMedian).toBeLessThan(COST);
    }
  });
});

// ── §2 — GREEN: the corrected predicate rejects both, and says why ──────────────────────────

describe('validityVerdict rejects both live false positives', () => {
  it('CELL_A rejects at W_NOT_GT_L — the human-legible line', () => {
    const v = validityVerdict(inputOf(CELL_A));
    expect(v.validated).toBe(false);
    expect(v.rejectReason).toBe('W_NOT_GT_L');
  });

  it('CELL_B rejects at W_NOT_GT_L too', () => {
    const v = validityVerdict(inputOf(CELL_B));
    expect(v.validated).toBe(false);
    expect(v.rejectReason).toBe('W_NOT_GT_L');
  });

  it('CELL_A still rejects with W and L swapped — CI separation kills it independently', () => {
    const v = validityVerdict(inputOf(CELL_A, { wins: CELL_A.losses, losses: CELL_A.wins }));
    expect(v.validated).toBe(false);
    expect(v.rejectReason).toBe('CI_NOT_SEPARATED');
  });

  it('CELL_B still rejects once W>L and CI separation are FORCED — its holdout edge is negative', () => {
    const v = validityVerdict(inputOf(CELL_B, {
      wins: 2000, losses: 703, benchmark: 0.30, wilsonLo: 0.70,
    }));
    expect(v.validated).toBe(false);
    expect(v.rejectReason).toBe('WF_SIGN_FAIL');
  });

  it('reports HOW FAR short each cell fell, not merely that it fell', () => {
    const a = validityVerdict(inputOf(CELL_A));
    // 2 × (0.4842 − 0.4893) × 0.394435 — a NEGATIVE excess against a +0.10% cost.
    expect(a.excessReturnPct).toBeCloseTo(-0.004023, 5);
    expect(a.tradeableReturnPct).toBeCloseTo(-0.012463, 5);
    expect(a.excessReturnPct).toBeLessThan(COST);
  });
});

// ── §3 — the two magnitude conjuncts are genuinely different questions ──────────────────────

describe('EXCESS and TRADEABILITY are not the same condition', () => {
  /** A synthetic cell that CLEARS excess against a sub-breakeven benchmark yet loses money. */
  const belowBreakeven: ValidityInput = {
    nDecided: 5000, wins: 2450, losses: 2550,   // W<L on purpose is not the point here…
    benchmark: 0.40, wilsonLo: 0.49,            // …the bound sits 9 pp above a 0.40 benchmark
    ptDefined: true, fdrReject: true,
    holdoutEdge: 0.02, holdoutP: 0.001,
    barrierPctMedian: 1.0, roundTripCostPct: COST,
  };

  it('a cell can beat a sub-0.5 benchmark by 100× the cost and still be unprofitable', () => {
    const v = validityVerdict({ ...belowBreakeven, wins: 2600, losses: 2400 });
    // EXCESS = 2 × (0.49 − 0.40) × 1.0 = 0.18% — comfortably over the 0.10% round trip.
    expect(v.excessReturnPct).toBeCloseTo(0.18, 6);
    expect(v.excessReturnPct).toBeGreaterThan(COST);
    // TRADEABILITY = 2 × (0.49 − 0.5) × 1.0 = −0.02% — it loses money on every race.
    expect(v.tradeableReturnPct).toBeCloseTo(-0.02, 6);
    expect(v.validated).toBe(false);
    expect(v.rejectReason).toBe('NOT_TRADEABLE');
  });

  it('and clears both once the bound is genuinely above breakeven plus cost', () => {
    const v = validityVerdict({
      ...belowBreakeven, wins: 2600, losses: 2400, benchmark: 0.40, wilsonLo: 0.60,
    });
    expect(v.validated).toBe(true);
    expect(v.rejectReason).toBeNull();
  });
});

// ── §4 — every conjunct can fail ALONE, in its declared order ───────────────────────────────

describe('each condition is reachable and diagnosable on its own', () => {
  /** A cell that passes everything, so a single mutation isolates one conjunct. */
  const PASS: ValidityInput = {
    nDecided: 5000, wins: 3100, losses: 1900,
    benchmark: 0.50, wilsonLo: 0.60,
    ptDefined: true, fdrReject: true,
    holdoutEdge: 0.05, holdoutP: 0.001,
    barrierPctMedian: 1.0, roundTripCostPct: COST,
  };

  it('the control passes', () => {
    expect(validityVerdict(PASS).validated).toBe(true);
  });

  const cases: Array<[string, Partial<ValidityInput>]> = [
    ['INPUT_NOT_MEASURABLE', { benchmark: NaN }],
    ['INPUT_NOT_MEASURABLE', { barrierPctMedian: 0 }],
    ['N_LT_FLOOR', { nDecided: VALIDITY_POWERED_FLOOR - 1 }],
    ['PT_UNDEFINED', { ptDefined: false }],
    ['FDR_FAIL', { fdrReject: false }],
    ['W_NOT_GT_L', { wins: 1900, losses: 3100 }],
    ['CI_NOT_SEPARATED', { wilsonLo: 0.50 }],          // equal, not merely below: strict >
    ['EXCESS_BELOW_COST', { benchmark: 0.5999 }],       // separated, but by far too little
    ['NOT_TRADEABLE', { benchmark: 0.40, wilsonLo: 0.5004 }],
    ['WF_SIGN_FAIL', { holdoutEdge: 0 }],               // zero is not positive
    ['WF_SIGN_FAIL', { holdoutEdge: null }],
    ['WF_P_FAIL', { holdoutP: VALIDITY_HOLDOUT_ALPHA }], // equal, not below: strict <
    ['WF_P_FAIL', { holdoutP: null }],
  ];
  for (const [reason, mutation] of cases) {
    it(`${reason} — ${JSON.stringify(mutation)}`, () => {
      const v = validityVerdict({ ...PASS, ...mutation });
      expect(v.validated).toBe(false);
      expect(v.rejectReason).toBe(reason);
    });
  }
});

// ── §5 — the constants the bar rents from elsewhere ─────────────────────────────────────────

describe('cost constant and version stamp', () => {
  it('ROUND_TRIP_COST_PCT is DERIVED from FLOOR_PCT, not a second literal', () => {
    expect(ROUND_TRIP_COST_PCT).toBeCloseTo(0.1, 12);
    expect(ROUND_TRIP_COST_PCT).toBeCloseTo(FLOOR_PCT / 3, 12);
  });

  it('the predicate version is a non-empty stamp that changes when the bar changes', () => {
    expect(VALIDITY_PREDICATE_VERSION).toBe('v2-ci-magnitude-2026-08');
  });

  it('a zero cost degenerates EXCESS to plain CI separation and TRADEABILITY to DWR>0.5', () => {
    const base: ValidityInput = {
      nDecided: 5000, wins: 2600, losses: 2400,
      benchmark: 0.40, wilsonLo: 0.5000001,
      ptDefined: true, fdrReject: true,
      holdoutEdge: 0.01, holdoutP: 0.001,
      barrierPctMedian: 1.0, roundTripCostPct: 0,
    };
    expect(validityVerdict(base).validated).toBe(true);
    expect(validityVerdict({ ...base, wilsonLo: 0.5 }).rejectReason).toBe('NOT_TRADEABLE');
  });
});
