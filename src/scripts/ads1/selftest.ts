// ads1/selftest.ts — EDGE-ADS1-SCORECARD-W1-V2 CH2 R1.
//
//   node dist/scripts/ads1/selftest.js
//
// Runs every ADS-1 known-answer check and prints EXACTLY ONE line:
//   ADS1_SELFTEST: PASS (<k> checks)      exit 0
//   ADS1_SELFTEST: FAIL <name>[, <name>…]  exit 1
// Every check is wrapped: a check that THROWS reports FAIL by name (an assertion that raises is not an
// assertion). The corpus is constructed here, so fewer checks than declared is itself a FAIL (vacuity).
// Proven able to fail: the mutation matrix in the wave's endpoint-truth addendum turns it red.

import { clusterEdgeCompleteWithCi, ciLowerNearestRank, percentileNearestRank } from '../dwr-cluster-edge.js';
import {
  completeLabel,
  dwrComplete,
  dwrDecided,
  edge,
  engineOutcome,
  iccAnova,
  identifiability,
  kishNEff,
  mixMatchedNull,
  nEff,
  sideOutcomes,
  toRaceRows,
  type Ads1Row,
} from './core.js';
import { breakEven, calibration, coverageEmitted, payoff, renderVerdict, trimByConviction, verdict, type VerdictInput } from './layers.js';
import { spearman } from './rank.js';
import {
  ALPHA_ONE_SIDED,
  BOOTSTRAP_B,
  BOOTSTRAP_SEED,
  COST_TIERS_PCT,
  EXCEPTIONAL_MIN_LIVE_DAYS,
  FLAT_FLOOR_PCT,
  N_EFF_FLOOR,
  T_DIAG_END,
  serializeAds1Spec,
  withinTCap,
} from './spec.js';
import { ROUND_TRIP_COST_PCT } from '../directional-labeler.js';

/** The number of checks this file declares — a run that executes fewer is vacuous. */
export const DECLARED_CHECKS = 42;

const DAY0 = 1788220800; // 2026-09-01T00:00:00Z
const approx = (a: number, b: number, tol = 1e-9): boolean => Number.isFinite(a) && Math.abs(a - b) <= tol;

export function row(p: Partial<Ads1Row> & Pick<Ads1Row, 'side' | 'label'>): Ads1Row {
  return {
    createdAt: DAY0, exchange: 'BINANCE', coin: 'BTC', timeframe: '1h', confidence: 60,
    ambiguous: false, barrierPct: 1.0, expiryRetPct: null, ...p,
  };
}
/** A decided race: `race` is where price went; the row's side-relative label follows from it. */
function raced(side: 'BUY' | 'SELL', race: 'up' | 'down', extra: Partial<Ads1Row> = {}): Ads1Row {
  const win = (side === 'BUY') === (race === 'up');
  return row({ side, label: win ? 1 : -1, ...extra });
}
function many(n: number, f: (i: number) => Ads1Row): Ads1Row[] {
  return Array.from({ length: n }, (_, i) => f(i));
}
/** One UTC day of rows: counts of (BUY-up, BUY-down, SELL-up, SELL-down), all decided. */
function dayOf(d: number, bu: number, bd: number, su: number, sd: number, extra: Partial<Ads1Row> = {}): Ads1Row[] {
  const t = DAY0 + d * 86_400;
  let j = 0;
  const mk = (side: 'BUY' | 'SELL', race: 'up' | 'down', n: number) => many(n, () => raced(side, race, { createdAt: t + j++, ...extra }));
  return [...mk('BUY', 'up', bu), ...mk('BUY', 'down', bd), ...mk('SELL', 'up', su), ...mk('SELL', 'down', sd)];
}

type Check = [name: string, fn: () => boolean];

export function checks(): Check[] {
  const t0 = (r: number | null, side: 'BUY' | 'SELL' = 'BUY', bp = 1.2) => completeLabel(0, r, side, bp);

  // L0 / L1 fixtures
  const decidedAndTimeouts: Ads1Row[] = [
    ...many(5, () => raced('BUY', 'up')), ...many(5, () => raced('BUY', 'down')),
    ...many(6, () => row({ side: 'BUY', label: 0, expiryRetPct: 0.5 })),
    ...many(4, () => row({ side: 'BUY', label: 0, expiryRetPct: -0.5 })),
  ];
  const fiftyFifty: Ads1Row[] = [
    ...many(3, () => raced('BUY', 'up')), ...many(2, () => raced('BUY', 'down')),
    ...many(3, () => raced('SELL', 'up')), ...many(2, () => raced('SELL', 'down')),
  ];
  const oneSided: Ads1Row[] = [...many(7, () => raced('BUY', 'up')), ...many(3, () => raced('BUY', 'down'))];
  const withAmbiguous: Ads1Row[] = [...fiftyFifty, row({ side: 'SELL', label: -1, ambiguous: true })];
  const invariantRows: Ads1Row[] = [
    ...fiftyFifty, ...withAmbiguous, row({ side: 'SELL', label: 0, expiryRetPct: 0.4, barrierPct: 1 }),
    row({ side: 'BUY', label: 0, expiryRetPct: -0.2 }), row({ side: 'SELL', label: 0, expiryRetPct: null }),
    row({ side: 'BUY', label: 0, expiryRetPct: 1.5, barrierPct: 1 }),
  ];

  // per-day headline vs pooled: 10 small days at +7.5 pp, 10 large days at -1.25 pp
  const perDay: Ads1Row[] = [];
  for (let d = 0; d < 10; d++) perDay.push(...dayOf(d, 12, 8, 9, 11));
  for (let d = 10; d < 20; d++) perDay.push(...dayOf(d, 95, 105, 100, 100));
  const underClustered = perDay.filter((r) => r.createdAt < DAY0 + 19 * 86_400);

  // coverage: each day 40 high-conviction (+25 pp) and 40 low-conviction (−25 pp) calls
  const coverageRows: Ads1Row[] = [];
  for (let d = 0; d < 20; d++) {
    coverageRows.push(...dayOf(d, 15, 5, 5, 15, { confidence: 80 }));
    coverageRows.push(...dayOf(d, 5, 15, 15, 5, { confidence: 55 }));
  }

  // calibration: realized = confidence/100 (calibrated) and its inversion
  const calibRows = (inv: boolean): Ads1Row[] => {
    const out: Ads1Row[] = [];
    for (const c of [60, 70, 90]) {
      const wins = inv ? 100 - c : c;
      out.push(...many(wins, () => raced('BUY', 'up', { confidence: c })));
      out.push(...many(100 - wins, () => raced('BUY', 'down', { confidence: c })));
    }
    return out;
  };

  // identifiability
  const skew95: Ads1Row[] = [...many(50, () => raced('BUY', 'up')), ...many(45, () => raced('BUY', 'down')), ...many(3, () => raced('SELL', 'up')), ...many(2, () => raced('SELL', 'down'))];
  const mix85: Ads1Row[] = [...many(43, () => raced('BUY', 'up')), ...many(42, () => raced('BUY', 'down')), ...many(8, () => raced('SELL', 'up')), ...many(7, () => raced('SELL', 'down'))];
  const frechetOnly: Ads1Row[] = [...many(2, () => raced('BUY', 'up')), ...many(498, () => raced('BUY', 'down')), ...many(2, () => raced('SELL', 'up')), ...many(498, () => raced('SELL', 'down'))];

  const baseV: VerdictInput = {
    identifiable: true, edgePp: 2.0, edgePpPooled: 2.0, ciLbPp: 0.5, tStat: 2.5, nEff: 5000, dwrComplete: 0.52,
    wilsonLb: 0.51, liveDays: 100, regimesCiLbAbove0: 1, medianBarrierPct: 1.0,
  };
  const RECORD_START = 1775790993; // first signals row, 2026-04-10
  const AS_OF_2027_04_01 = 1806537600;

  const c = (x: Ads1Row[]) => clusterEdgeCompleteWithCi(toRaceRows(x), { alpha: ALPHA_ONE_SIDED, B: BOOTSTRAP_B, seed: BOOTSTRAP_SEED });

  return [
    // ── L0: the complete label
    ['L0 timeout +0.31% BUY (barrier 1.2) -> WIN', () => t0(0.31, 'BUY') === 'WIN'],
    ['L0 timeout +0.31% SELL (barrier 1.2) -> LOSS', () => t0(0.31, 'SELL') === 'LOSS'],
    ['L0 timeout +/-0.29% -> FLAT', () => t0(0.29) === 'FLAT' && t0(-0.29) === 'FLAT' && t0(-0.29, 'SELL') === 'FLAT'],
    ['L0 floor-bound barrier 0.30: every consistent timeout is FLAT', () =>
      [-0.29, -0.1, 0, 0.1, 0.299].every((r) => completeLabel(0, r, 'BUY', 0.3) === 'FLAT' && completeLabel(0, r, 'SELL', 0.3) === 'FLAT')],
    ['L0 timeout with |expiry| >= barrier -> INCONSISTENT', () => completeLabel(0, 0.3, 'BUY', 0.3) === 'INCONSISTENT' && t0(-1.5, 'SELL', 1.2) === 'INCONSISTENT'],
    ['L0 null expiry -> UNRESOLVED', () => t0(null) === 'UNRESOLVED'],
    ['L0 decided labels pass through', () => completeLabel(1, null, 'SELL', 1) === 'WIN' && completeLabel(-1, 5, 'BUY', 1) === 'LOSS'],
    ['L0 an ambiguous race is a LOSS for both always-side callers', () => {
      const o = sideOutcomes(row({ side: 'SELL', label: -1, ambiguous: true }));
      return o.BUY === 'LOSS' && o.SELL === 'LOSS';
    }],
    ['L0 engineOutcome == completeLabel on every fixture row', () =>
      invariantRows.every((r) => engineOutcome(r) === completeLabel(r.label, r.expiryRetPct, r.side, r.barrierPct))],
    ['L0 dwrDecided 0.50 and dwrComplete 0.55 on the fixture', () =>
      approx(dwrDecided(decidedAndTimeouts).dwr, 0.5) && approx(dwrComplete(decidedAndTimeouts).dwr, 0.55)],
    ['L0 dwrComplete counts FLAT / UNRESOLVED / INCONSISTENT apart', () => {
      const d = dwrComplete(invariantRows);
      return d.flat === 1 && d.unresolved === 1 && d.inconsistent === 1 && d.timeouts === 4;
    }],
    // ── L1: the mix-matched null and the edge
    ['L1 null: 50/50 shares, always-BUY 0.6, always-SELL 0.4 -> p0 0.50', () => {
      const n = mixMatchedNull(fiftyFifty);
      return approx(n.qBuy, 0.6) && approx(n.qSell, 0.4) && approx(n.shareBuy, 0.5) && approx(n.p0, 0.5);
    }],
    ['L1 null: one-sided -> p0 == q_BUY', () => { const n = mixMatchedNull(oneSided); return approx(n.p0, n.qBuy) && approx(n.p0, 0.7); }],
    ['L1 null: an ambiguous row is a loss for BOTH sides (q_BUY + q_SELL < 1)', () => {
      const n = mixMatchedNull(withAmbiguous);
      return n.n === 11 && approx(n.qBuy, 6 / 11) && approx(n.qSell, 4 / 11);
    }],
    ['L1 pooled identity: edgePpPooled == (dwrComplete - p0) * 100 to 1e-9', () => {
      const e = edge(perDay);
      return approx(e.edgePpPooled, (e.dwrComplete - e.p0) * 100, 1e-9);
    }],
    ['L1 headline is the per-day mean (+3.125 pp), not the pooled figure', () => {
      const e = edge(perDay);
      return e.edgePp !== null && approx(e.edgePp, 3.125, 1e-9) && e.edgePpPooled < 0;
    }],
    ['L1 under 20 day-clusters the headline is INDETERMINATE (null), never a point estimate', () => {
      const r = c(underClustered);
      return r.verdict === 'INDETERMINATE' && r.meanPp === null && r.ciLbPp === null;
    }],
    ['L1 bootstrap is reproducible under the fixed seed and its lower bound sits below the mean', () => {
      const a = c(perDay), b = c(perDay);
      return a.ciLbPp !== null && a.ciLbPp === b.ciLbPp && a.meanPp !== null && a.ciLbPp <= a.meanPp && a.p === b.p;
    }],
    ['L1 nearest-rank percentile (cluster-perm-stats rule): 1..100 at 0.025 -> 3, 0.5 -> 50', () => {
      const v = Array.from({ length: 100 }, (_, i) => i + 1);
      return percentileNearestRank(v, 0.025) === 3 && percentileNearestRank(v, 0.5) === 50 && ciLowerNearestRank(v, 0.05) === 5;
    }],
    // ── nEff
    ['nEff: rho = 0 -> nEff = n', () => approx(kishNEff(120, [40, 40, 40], 0), 120)],
    ['nEff: rho = 1 on equal day clusters -> nEff = nDays', () => approx(kishNEff(120, [40, 40, 40], 1), 3)],
    ['nEff: a negative rho is floored at 0 in the design effect (nEff <= n)', () => approx(kishNEff(120, [40, 40, 40], -0.3), 120)],
    ['nEff: ICC(1) known answer 0.5 on {1,1,0 | 0,0,0}', () => approx(iccAnova([1, 1, 0, 0, 0, 0], ['a', 'a', 'a', 'b', 'b', 'b']) ?? NaN, 0.5)],
    ['nEff: on the per-day fixture nEff <= n and nDays = 20', () => { const e = nEff(perDay); return e.nDays === 20 && e.nEff !== null && e.nEff <= e.n; }],
    // ── identifiability
    ['ID: 95/5 side mix -> NOT_IDENTIFIABLE (minority)', () => { const i = identifiability(skew95); return i.status === 'NOT_IDENTIFIABLE' && i.reason === 'minority'; }],
    ['ID: 85/15 side mix -> OK', () => identifiability(mix85).status === 'OK'],
    ['ID: balanced mix, always-BUY 0.4 % -> NOT_IDENTIFIABLE (frechet)', () => { const i = identifiability(frechetOnly); return i.status === 'NOT_IDENTIFIABLE' && i.reason === 'frechet'; }],
    // ── L2 calibration
    ['L2 calibrated fixture -> BSS > 0 and ECE ~ 0', () => { const k = calibration(calibRows(false)); return k.bss !== null && k.bss > 0 && k.ece < 1e-9; }],
    ['L2 inverted fixture -> BSS < 0', () => { const k = calibration(calibRows(true)); return k.bss !== null && k.bss < 0; }],
    ['L2 spearman is +1 on the calibrated bins, -1 on the inverted', () =>
      approx(calibration(calibRows(false)).spearman ?? NaN, 1) && approx(calibration(calibRows(true)).spearman ?? NaN, -1) && approx(spearman([1, 2, 3], [3, 2, 1]), -1)],
    // ── L3 emitted-arm coverage
    ['L3 trimming the bottom half by conviction raises the edge', () => {
      const cov = coverageEmitted(coverageRows, null);
      const e100 = cov.edgeAt[0].edgePp, e50 = cov.edgeAt[2].edgePp;
      return e100 !== null && e50 !== null && e50 > e100 && approx(e50, 25, 1e-9) && cov.coverageReason === 'NO_CENSUS';
    }],
    ['L3 incommensurate census -> coverage n/a, never a ratio', () => {
      const cov = coverageEmitted(coverageRows, { signals: 10, bandSignals: 2, holdCounts: 400, emitSuppressions: 1, unitsCommensurate: false });
      return cov.coverage === null && cov.holdShare === null && cov.coverageReason === 'COVERAGE_UNITS_INCOMMENSURATE';
    }],
    ['L3 ties at the conviction cut-off are kept whole', () => {
      const t = trimByConviction([row({ side: 'BUY', label: 1, confidence: 70 }), row({ side: 'BUY', label: 1, confidence: 60 }), row({ side: 'BUY', label: 1, confidence: 60 })], 0.5);
      return t.minConfidence === 60 && t.kept.length === 3;
    }],
    // ── L4 payoff & cost
    ['L4 break-even: B 0.30 %, taker -> 66.67 %; B 2.0 %, maker -> 51.0 %', () =>
      approx(breakEven(0.3, COST_TIERS_PCT.taker), 2 / 3, 1e-9) && approx(breakEven(2.0, COST_TIERS_PCT.maker), 0.51, 1e-9)],
    ['L4 payoff: side-signed expiry in barrier units', () => {
      const p = payoff([row({ side: 'SELL', label: 0, expiryRetPct: -0.5, barrierPct: 1 }), row({ side: 'BUY', label: 1, expiryRetPct: 1.0, barrierPct: 2 })]);
      return approx(p.meanSignedExpiryRetR, 0.5) && p.nWithExpiry === 2;
    }],
    // ── verdicts, one fixture per token
    ['V NOT_IDENTIFIABLE outranks everything', () => verdict({ ...baseV, identifiable: false, dwrComplete: 0.9 }).token === 'NOT_IDENTIFIABLE'],
    ['V AUDIT on edge >= 5 pp with nEff >= 617, and on hit rate > 0.60', () =>
      verdict({ ...baseV, edgePp: 6, nEff: 700 }).token === 'AUDIT' && verdict({ ...baseV, dwrComplete: 0.61 }).token === 'AUDIT'],
    ['V PROVISIONAL below the nEff floor and when under-clustered', () =>
      verdict({ ...baseV, nEff: N_EFF_FLOOR - 1 }).token === 'PROVISIONAL' && verdict({ ...baseV, edgePp: null, ciLbPp: null }).token === 'PROVISIONAL'],
    ['V CREDIBLE / EXCEPTIONAL / NO_CLAIM bands, rendered literally', () =>
      renderVerdict(verdict(baseV)) === 'verdict: CREDIBLE' &&
      verdict({ ...baseV, edgePp: 4, tStat: 3.2, liveDays: 400, regimesCiLbAbove0: 2 }).token === 'EXCEPTIONAL' &&
      verdict({ ...baseV, edgePp: 0.5 }).token === 'NO_CLAIM' && verdict({ ...baseV, ciLbPp: -0.1 }).token === 'NO_CLAIM'],
    ['V EXCEPTIONAL is unreachable before 2027-04 (live days < 365 from the record start)', () =>
      (AS_OF_2027_04_01 - RECORD_START) / 86_400 < EXCEPTIONAL_MIN_LIVE_DAYS &&
      verdict({ ...baseV, edgePp: 4, tStat: 9, regimesCiLbAbove0: 5, liveDays: (AS_OF_2027_04_01 - RECORD_START) / 86_400 }).token !== 'EXCEPTIONAL'],
    ['V tradeable = wilsonLb vs the break-even at the median barrier', () =>
      verdict({ ...baseV, wilsonLb: 0.7, medianBarrierPct: 0.3 }).tradeable === 'taker' &&
      verdict({ ...baseV, wilsonLb: 0.6, medianBarrierPct: 0.3 }).tradeable === 'maker' &&
      verdict({ ...baseV, wilsonLb: 0.5, medianBarrierPct: 0.3 }).tradeable === 'none'],
    // ── spec
    ['SPEC constants: FLAT floor 0.30, taker = ROUND_TRIP_COST_PCT, T_CAP embargo, JSON round-trip', () => {
      const j = JSON.parse(serializeAds1Spec()) as Record<string, unknown>;
      return FLAT_FLOOR_PCT === 0.3 && COST_TIERS_PCT.taker === ROUND_TRIP_COST_PCT && j.n_eff_floor === N_EFF_FLOOR &&
        withinTCap(T_DIAG_END - 9 * 3600, '1h') && !withinTCap(T_DIAG_END - 8 * 3600, '1h') && !withinTCap(T_DIAG_END + 1, '5m');
    }],
  ];
}

export function runSelftest(log: (line: string) => void = console.log): number {
  const failed: string[] = [];
  let ran = 0;
  for (const [name, fn] of checks()) {
    ran++;
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    if (!ok) failed.push(name);
  }
  if (ran < DECLARED_CHECKS) failed.push(`vacuous: ${ran} < ${DECLARED_CHECKS} declared checks`);
  if (failed.length === 0) { log(`ADS1_SELFTEST: PASS (${ran} checks)`); return 0; }
  log(`ADS1_SELFTEST: FAIL ${failed.join(', ')}`);
  return 1;
}

if (require.main === module) {
  process.exit(runSelftest());
}
