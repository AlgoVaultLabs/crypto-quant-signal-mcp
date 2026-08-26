// edge-stats.ts — EDGE-DWR-METRIC-SOT-W1
// The ONE canonical implementation of the edge/directional statistics primitives.
// Leaf module: imports NOTHING from the project (no cycle) so E3' (meta-model) and a
// future AOE promotion-gate retrofit can import it without pulling in the audit harness.
// `calibration-audit.ts` re-exports the shared primitives from here (interface-preserved
// per CRYPTO-EDGE-METRIC-W1; its shipped tests stay green).
//
// Provenance: wilsonInterval / excessZP / benjaminiHochberg / bonferroni / normalCdf were
// authored in calibration-audit.ts (CRYPTO-EDGE-METRIC-W1) and MOVED here verbatim.
// pesaranTimmermann + dwrFromLabels are new to this wave.

/** erf via Abramowitz-Stegun 7.1.26. */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Wilson score interval for a binomial proportion k/n. */
export function wilsonInterval(k: number, n: number, z = 1.96): { lo: number; hi: number; pHat: number } {
  if (n === 0) return { lo: 0, hi: 1, pHat: NaN };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half), pHat: p };
}

/** One-sided z-test that the observed rate exceeds a benchmark rate p0. */
export function excessZP(hits: number, n: number, p0: number): { z: number; p: number } {
  if (n === 0 || p0 <= 0 || p0 >= 1) return { z: 0, p: 1 };
  const pHat = hits / n;
  const se = Math.sqrt((p0 * (1 - p0)) / n);
  const z = (pHat - p0) / se;
  return { z, p: 1 - normalCdf(z) };
}

/** Benjamini-Hochberg FDR at level q. Returns per-index rejection + the cut p. */
export function benjaminiHochberg(pvals: number[], q = 0.05): { rejected: boolean[]; threshold: number } {
  const m = pvals.length;
  const order = pvals.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let kMax = -1;
  for (let r = 0; r < m; r++) if (order[r].p <= ((r + 1) / m) * q) kMax = r;
  const rejected = new Array(m).fill(false);
  for (let r = 0; r <= kMax; r++) rejected[order[r].i] = true;
  return { rejected, threshold: kMax >= 0 ? order[kMax].p : 0 };
}

/** Bonferroni family-wise correction. */
export function bonferroni(pvals: number[], q = 0.05): boolean[] {
  const thr = q / Math.max(1, pvals.length);
  return pvals.map((p) => p <= thr);
}

// ── New this wave ────────────────────────────────────────────────────────────

export interface DwrSummary {
  wins: number; // label === +1  (target/side-favorable barrier first)
  losses: number; // label === -1 (adverse barrier first; incl. same-candle conservative)
  timeouts: number; // label === 0 (neither barrier inside the vertical window)
  nDecided: number; // wins + losses (timeouts excluded from the denominator)
  dwr: number; // wins / nDecided; NaN when nDecided === 0
}

/** Directional Win Rate from ternary triple-barrier labels (+1/-1/0). */
export function dwrFromLabels(labels: number[]): DwrSummary {
  let wins = 0;
  let losses = 0;
  let timeouts = 0;
  for (const l of labels) {
    if (l === 1) wins++;
    else if (l === -1) losses++;
    else if (l === 0) timeouts++;
    // any other value is not a valid ternary label → ignored
  }
  const nDecided = wins + losses;
  return { wins, losses, timeouts, nDecided, dwr: nDecided > 0 ? wins / nDecided : NaN };
}

export type PtNa = 'CONSTANT_SIDE' | 'INSUFFICIENT_N';
export interface PtResult {
  z: number | null;
  p: number | null; // one-sided upper: P(Z > z) = 1 - Φ(z); certifies directional skill
  na: PtNa | null; // set iff the test is undefined for this sample
  pHat: number; // realized correct-direction rate (diagnostic)
  pStar: number; // expected correct rate under independence (diagnostic)
}

/**
 * Pesaran-Timmermann (1992) test of directional/sign predictability.
 * `predicted[i]` and `actual[i]` carry direction in their sign (>0 up, <0 down).
 * Undefined when either series is one-sided (all-up or all-down) → na='CONSTANT_SIDE'
 * (an all-BUY cell can never certify skill), matching the report's PT_NA_CONSTANT_SIDE.
 */
export function pesaranTimmermann(predicted: number[], actual: number[]): PtResult {
  if (predicted.length !== actual.length) {
    throw new Error(`pesaranTimmermann: length mismatch ${predicted.length} vs ${actual.length}`);
  }
  const n = predicted.length;
  if (n < 2) return { z: null, p: null, na: 'INSUFFICIENT_N', pHat: NaN, pStar: NaN };

  let correct = 0;
  let predUp = 0;
  let actUp = 0;
  for (let i = 0; i < n; i++) {
    const x = predicted[i] > 0 ? 1 : 0;
    const y = actual[i] > 0 ? 1 : 0;
    if (x === y) correct++;
    predUp += x;
    actUp += y;
  }
  const pHat = correct / n;
  const px = predUp / n; // P(predicted up)
  const py = actUp / n; // P(actual up)
  const pStar = py * px + (1 - py) * (1 - px);

  // Test is undefined when either series is one-sided: var(P̂) − var(P̂*) → 0.
  if (px === 0 || px === 1 || py === 0 || py === 1) {
    return { z: null, p: null, na: 'CONSTANT_SIDE', pHat, pStar };
  }

  const varPhat = (pStar * (1 - pStar)) / n;
  const varPstar =
    ((2 * py - 1) ** 2 * px * (1 - px)) / n +
    ((2 * px - 1) ** 2 * py * (1 - py)) / n +
    (4 * py * px * (1 - py) * (1 - px)) / (n * n);
  const denom = varPhat - varPstar;
  if (denom <= 0) return { z: null, p: null, na: 'CONSTANT_SIDE', pHat, pStar };

  const z = (pHat - pStar) / Math.sqrt(denom);
  return { z, p: 1 - normalCdf(z), na: null, pHat, pStar };
}

// ── The validity predicate (EDGE-DWR-VALIDATED-PREDICATE-W1) ─────────────────
//
// THE ONE definition of `validated` for the DWR triple-barrier family. It lives in this leaf,
// not in the report, because the bar is not a property of one reporting script: it is the
// estate's certification contract, and every future directional result is judged by it.
//
// ── Why it was tightened, and why that is legitimate ──────────────────────────
// Loosening a bar after a failure is goalpost-moving and is forbidden. TIGHTENING a bar after
// it produced a DEMONSTRATED FALSE POSITIVE is the opposite act. Both of the following were
// live `validated: true` on 2026-08-26 under the previous predicate (*same edge sign in the
// holdout* + *holdout PT p<0.05*, with no magnitude, no CI-separation and no cost condition):
//
//   tau0.5 5m|rest|c60_74|RANGING        W/L 5,124 / 5,253 · edge +0.0045 · Wilson [.4842,.5034]
//     — it loses more barrier races than it wins, and its own CI contains the benchmark. It
//       "beat" the benchmark only because always-BUY (.4893) and always-SELL did worse.
//   tau0.5 3m|rest|c60_74|TRENDING_DOWN  W/L 1,331 / 1,372 · edge -0.0270 · holdout edge -0.0407
//     — a NEGATIVE edge in the full sample AND in the holdout. `Math.sign(ho) === Math.sign(full)`
//       is satisfied by two negatives, so "the edge persisted out of sample" certified a cell
//       that was worse than always-SELL on both halves of the split. Measured, not inferred:
//       the 70/30 cut replayed in SQL gives holdout DWR .5049 against holdout benchmark .5457.
//
// Every condition below is a CONJUNCT ADDED to the previous set; nothing was removed or
// weakened. It is therefore structurally impossible for a cell to GAIN validation under this
// change — a fact the re-run confirms rather than establishes.
//
// ── Why there are TWO magnitude conditions ────────────────────────────────────
// EXCESS answers "does the engine beat the directionless benchmark by more than it costs to
// trade?". TRADEABILITY answers "is it profitable at all?". They are not the same question
// whenever the benchmark sits below breakeven — and here it measurably does (the flagged cell's
// benchmark is 0.4893). A cell can clear EXCESS against a sub-0.5 benchmark while still losing
// money on every race, so both are required.
//
// Both are evaluated on the WILSON LOWER BOUND rather than the point estimate, so magnitude
// inherits the same winner's-curse control as CI separation: we promote on the bound, never on
// the estimate.
//
// ── Units ─────────────────────────────────────────────────────────────────────
// `barrierPctMedian` is PERCENT OF PRICE (`directional_labels.barrier_pct`; measured tau=0.5
// median 0.7212, mean 1.3776, max 30.99), and so is `roundTripCostPct`. A symmetric
// triple-barrier race pays +/- one barrier width on a decided outcome, so a rate difference `d`
// converts to expected return per decided race as `2*d*barrierPct` — the ONLY conversion used
// here, and it introduces no new statistic. NOTE that the "0.30" in every barrier-spec name is
// a minimum barrier WIDTH, not a fee; comparing a win-rate difference in percentage points
// directly against it is a unit error.
//
// MEDIAN, not mean, for ROBUSTNESS first and conservatism second: barrier width is strongly
// right-skewed within a cell (the flagged cell: median 0.3944, mean 1.0097, max 19.75, 35.6% of
// rows pinned at the floor), so a mean-based bar could certify a cell on the strength of a
// handful of unusually wide races.

/** Bumped whenever the predicate's MEANING changes. Stamped into every artifact that carries a
 *  `validated` count, so a consumer can refuse to render a figure computed under an older bar. */
export const VALIDITY_PREDICATE_VERSION = 'v2-ci-magnitude-2026-08';

/** Minimum decided calls for a cell to be testable at all. Owned here because it is part of the
 *  bar; `dwr-baseline-report.ts` imports it rather than declaring a second copy. */
export const VALIDITY_POWERED_FLOOR = 50;

/** One-sided significance level demanded of the walk-forward holdout's PT test. */
export const VALIDITY_HOLDOUT_ALPHA = 0.05;

/** First failing condition, in evaluation order. `null` iff the cell is validated. */
export type ValidityReject =
  | 'INPUT_NOT_MEASURABLE' // a required statistic is absent / non-finite — could not verify
  | 'N_LT_FLOOR'
  | 'PT_UNDEFINED'
  | 'FDR_FAIL'
  | 'W_NOT_GT_L'
  | 'CI_NOT_SEPARATED'
  | 'EXCESS_BELOW_COST'
  | 'NOT_TRADEABLE'
  | 'WF_SIGN_FAIL'
  | 'WF_P_FAIL';

export interface ValidityInput {
  nDecided: number;
  wins: number;
  losses: number;
  /** max(alwaysBUY, alwaysSELL) over the SAME races. */
  benchmark: number;
  /** Wilson lower bound of the cell's DWR. */
  wilsonLo: number;
  /** false when PT is undefined (constant-side / insufficient-n) — rejected by design. */
  ptDefined: boolean;
  /** BH-FDR rejection of the null at q, decided by the caller across the whole family. */
  fdrReject: boolean;
  /** Holdout edge (dwr − benchmark) of the walk-forward split; null when no holdout exists. */
  holdoutEdge: number | null;
  /** Holdout PT p-value; null when undefined. */
  holdoutP: number | null;
  /** Median `barrier_pct` over the cell's rows, PERCENT of price. */
  barrierPctMedian: number;
  /** Round-trip execution cost, PERCENT of price. Caller-supplied so this leaf imports nothing. */
  roundTripCostPct: number;
}

export interface ValidityVerdict {
  validated: boolean;
  rejectReason: ValidityReject | null;
  /** 2·(wilsonLo − benchmark)·barrierPctMedian — expected EXCESS return per decided race, %. */
  excessReturnPct: number;
  /** 2·(wilsonLo − 0.5)·barrierPctMedian — expected ABSOLUTE return per decided race, %. */
  tradeableReturnPct: number;
}

/**
 * The ONE `validated` predicate. Conjunctive; returns the FIRST failing condition so every
 * rejection is diagnosable rather than a bare false.
 *
 * `W > L` is deliberately REDUNDANT — TRADEABILITY subsumes it whenever the cost is positive.
 * It is kept because it is the human-legible line ("a cell that loses more barrier races than
 * it wins is never certified"), and redundancy in a validity bar is a feature, not a smell.
 */
export function validityVerdict(x: ValidityInput): ValidityVerdict {
  const excessReturnPct = 2 * (x.wilsonLo - x.benchmark) * x.barrierPctMedian;
  const tradeableReturnPct = 2 * (x.wilsonLo - 0.5) * x.barrierPctMedian;
  const reject = (rejectReason: ValidityReject): ValidityVerdict => ({
    validated: false, rejectReason, excessReturnPct, tradeableReturnPct,
  });

  // "Could not verify" is not "verified and rejected". A non-finite benchmark / Wilson bound /
  // barrier width means the statistic was never measurable for this cell, and reporting that as
  // a magnitude failure would misattribute a data gap to the market.
  if (
    !Number.isFinite(x.benchmark) || !Number.isFinite(x.wilsonLo) ||
    !Number.isFinite(x.barrierPctMedian) || x.barrierPctMedian <= 0 ||
    !Number.isFinite(x.roundTripCostPct) || x.roundTripCostPct < 0
  ) return reject('INPUT_NOT_MEASURABLE');

  if (x.nDecided < VALIDITY_POWERED_FLOOR) return reject('N_LT_FLOOR');
  if (!x.ptDefined) return reject('PT_UNDEFINED');
  if (!x.fdrReject) return reject('FDR_FAIL');
  if (!(x.wins > x.losses)) return reject('W_NOT_GT_L');
  if (!(x.wilsonLo > x.benchmark)) return reject('CI_NOT_SEPARATED');
  if (!(excessReturnPct > x.roundTripCostPct)) return reject('EXCESS_BELOW_COST');
  if (!(tradeableReturnPct > x.roundTripCostPct)) return reject('NOT_TRADEABLE');
  // "Same sign" is not "positive": two negative edges satisfy it. The holdout must show a
  // POSITIVE edge, or the check certifies a persistent loss.
  if (x.holdoutEdge == null || !Number.isFinite(x.holdoutEdge) || !(x.holdoutEdge > 0)) {
    return reject('WF_SIGN_FAIL');
  }
  if (x.holdoutP == null || !(x.holdoutP < VALIDITY_HOLDOUT_ALPHA)) return reject('WF_P_FAIL');

  return { validated: true, rejectReason: null, excessReturnPct, tradeableReturnPct };
}
