// ads1/parity-fixture.ts — EDGE-ADS1-SCORECARD-W1-V2 CH3: the cross-repo PARITY FIXTURE (ruling Q4 = A:
// "AOE vendors the parity fixture").
//
// The autonomous-optimizer's dry-run objective re-implements ADS-1's L0 / L1 in Python. This module fixes a
// deterministic synthetic corpus (a mulberry32 stream, no DB, no figure of the product) and the outputs the
// COMMITTED TypeScript library computes on it. `ops/ads1-parity-fixture.json` is its serialisation; the AOE
// repo vendors those bytes with a pinned sha256 and asserts its Python port reproduces every number — so the
// two implementations cannot drift apart silently.
//
// Regenerate: `node dist/scripts/ads1-scorecard.js --print-parity-fixture > ops/ads1-parity-fixture.json`;
// tests/unit/ads1-parity-fixture-lock.test.ts locks the committed JSON to this module.

import { clusterEdge, clusterEdgeCompleteWithCi, mulberry32, percentileNearestRank } from '../dwr-cluster-edge.js';
import { dwrComplete, dwrDecided, identifiability, mixMatchedNull, sideOutcomes, toRaceRows, engineOutcome, type Ads1Row } from './core.js';
import { EVAL_CANDLES, TF_MS } from '../directional-labeler.js';
import {
  ALPHA_ONE_SIDED,
  BOOTSTRAP_B,
  BOOTSTRAP_SEED,
  COARSER_SERVED,
  PRIMARY_BARRIER_SPEC,
  T_DIAG_END,
  raceStepSeconds,
  withinTCap,
  withinTCapMax,
} from './spec.js';

const DAY0 = 1788220800; // 2026-09-01T00:00:00Z
const FIXTURE_SEED = 20260927;

/** The corpus: 24 UTC days, 60 calls a day (the last two days 20 — they fall under the cluster floor and
 *  must be dropped by both ports), every outcome class represented: decided, ambiguous, timeouts resolving
 *  WIN / LOSS / FLAT, UNRESOLVED (no expiry) and INCONSISTENT (expiry outside its barrier), plus the
 *  explicit boundary rows below. */
export function parityRows(): Ads1Row[] {
  const rand = mulberry32(FIXTURE_SEED);
  const barriers = [0.3, 0.8, 1.5];
  const rows: Ads1Row[] = [];
  for (let d = 0; d < 24; d++) {
    const perDay = d >= 22 ? 20 : 60;
    for (let i = 0; i < perDay; i++) {
      const side = rand() < 0.68 ? 'BUY' : 'SELL';
      const barrierPct = barriers[Math.floor(rand() * barriers.length)];
      const u = rand();
      let label = 0;
      let ambiguous = false;
      let expiryRetPct: number | null = null;
      if (u < 0.3) label = 1;
      else if (u < 0.55) label = -1;
      else if (u < 0.6) { label = -1; ambiguous = true; }
      else {
        const v = rand();
        if (v < 0.08) expiryRetPct = null; // UNRESOLVED
        else if (v < 0.11) expiryRetPct = Math.round((barrierPct + 0.05) * 1e4) / 1e4; // INCONSISTENT
        else expiryRetPct = Math.round((rand() * 2 - 1) * barrierPct * 0.99 * 1e4) / 1e4;
      }
      rows.push({
        createdAt: DAY0 + d * 86_400 + i * 60,
        exchange: 'FIXTURE',
        coin: 'FIX',
        timeframe: '1h',
        side,
        confidence: 52 + Math.floor(rand() * 49),
        label,
        ambiguous,
        barrierPct,
        expiryRetPct,
      });
    }
  }
  // The boundaries a random stream never lands on, stated explicitly: a timeout EXACTLY on the ±0.30 %
  // floor (WIN / LOSS, both sides), one a hair inside it (FLAT), and one exactly ON its barrier
  // (INCONSISTENT). A port that reads the floor as strict, or the barrier as open, fails here.
  const edgeCases: Array<[Ads1Row['side'], number]> = [
    ['BUY', 0.3], ['BUY', -0.3], ['SELL', -0.3], ['SELL', 0.3], ['BUY', 0.2999], ['SELL', -0.2999], ['BUY', 0.8], ['SELL', -0.8],
  ];
  edgeCases.forEach(([side, expiryRetPct], k) => {
    rows.push({
      createdAt: DAY0 + 23 * 86_400 + 40_000 + k * 60, exchange: 'FIXTURE', coin: 'FIX', timeframe: '1h', side,
      confidence: 60, label: 0, ambiguous: false, barrierPct: 0.8, expiryRetPct,
    });
  });
  return rows;
}

/** Identifiability at and around the 10 % boundary, both sides (buys, sells) — decided rows, alternating
 *  race direction so the Fréchet range never binds. */
export const IDENTIFIABILITY_CASES: ReadonlyArray<[number, number]> = [[3600, 400], [400, 3600], [9, 1], [1, 9], [3601, 399], [399, 3601]];

export function identifiabilityCaseRows(buys: number, sells: number): Ads1Row[] {
  const mk = (side: Ads1Row['side'], n: number, t0: number): Ads1Row[] =>
    Array.from({ length: n }, (_, i) => {
      const up = i % 2 === 1;
      return {
        createdAt: DAY0 + t0 + i, exchange: 'FIXTURE', coin: 'FIX', timeframe: '1h', side, confidence: 60,
        label: (side === 'BUY') === up ? 1 : -1, ambiguous: false, barrierPct: 1, expiryRetPct: null,
      };
    });
  return [...mk('BUY', buys, 0), ...mk('SELL', sells, 100_000)];
}

/** Nearest-rank cases where q·m is NOT an integer — at the production B (q·m = 100) a floor and a ceiling
 *  agree, so only these tell the rule apart. */
export const PERCENTILE_CASES: ReadonlyArray<[number[], number]> = [
  [[3, 1, 2, 2, 5, 5, 5, 0.5], 0.3],
  [Array.from({ length: 100 }, (_, i) => i + 1), 0.025],
  [Array.from({ length: 37 }, (_, i) => (i * 7) % 37 - 18), 0.05],
  [[2, 1], 0.5],
  [[7], 0.05],
];

/**
 * T_CAP predicate parity cases (EDGE-ADS1-SCORECARD-W1-V3 R10): every coarser-served pair plus two same-grid pairs and
 * one timeframe outside the label window, each at its requested-form and max-form race-end edges (±1 s) and just past
 * the seal. The AOE seal guard must reproduce `within_max` on every case; `within_requested` is carried so the fixture
 * itself shows the max form admitting a SUBSET (cases the requested form admits and the max form excludes).
 */
export function tCapCases(): Array<{ exchange: string; timeframe: string; created_at: number; within_requested: boolean; within_max: boolean }> {
  const pairs: Array<[string, string]> = [
    ...COARSER_SERVED.map((c): [string, string] => [c.exchange, c.timeframe]),
    ['BINANCE', '1h'], ['OKX', '5m'], ['BINANCE', '1m'],
  ];
  const out: Array<{ exchange: string; timeframe: string; created_at: number; within_requested: boolean; within_max: boolean }> = [];
  for (const [exchange, timeframe] of pairs) {
    const W = EVAL_CANDLES[timeframe] ?? 0;
    const req = (TF_MS[timeframe] ?? 60_000) / 1000;
    const step = raceStepSeconds(exchange, timeframe) ?? req;
    const points = new Set<number>([T_DIAG_END + 1]);
    for (const edge of [T_DIAG_END - (W + 1) * req, T_DIAG_END - (W + 1) * step]) for (const d of [-1, 0, 1]) points.add(edge + d);
    for (const t of [...points].sort((a, b) => a - b)) {
      out.push({ exchange, timeframe, created_at: t, within_requested: withinTCap(t, timeframe), within_max: withinTCapMax(t, exchange, timeframe) });
    }
  }
  return out;
}

const r12 = (x: number | null): number | null => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1e12) / 1e12);

export function buildParityFixture(): Record<string, unknown> {
  const rows = parityRows();
  const dc = dwrComplete(rows);
  const dd = dwrDecided(rows);
  const nul = mixMatchedNull(rows);
  const decided = clusterEdge(rows.map((r) => ({ side: r.side, label: r.label, ambiguous: r.ambiguous, coin: r.coin, createdAt: r.createdAt, barrierPct: r.barrierPct })));
  const complete = clusterEdgeCompleteWithCi(toRaceRows(rows), { alpha: ALPHA_ONE_SIDED, B: BOOTSTRAP_B, seed: BOOTSTRAP_SEED });
  const id = identifiability(rows);
  const stream = mulberry32(BOOTSTRAP_SEED);
  return {
    purpose: 'ADS-1 L0/L1 parity between the cqsm TypeScript library and the AOE Python port. Synthetic; no product data.',
    primary_barrier_spec: PRIMARY_BARRIER_SPEC,
    bootstrap: { alpha: ALPHA_ONE_SIDED, b: BOOTSTRAP_B, seed: BOOTSTRAP_SEED },
    mulberry32_first8: Array.from({ length: 8 }, () => stream()),
    tcap_cases: tCapCases(),
    percentile_cases: PERCENTILE_CASES.map(([values, q]) => ({ values, q, expected: percentileNearestRank(values, q) })),
    identifiability_cases: IDENTIFIABILITY_CASES.map(([buys, sells]) => {
      const i = identifiability(identifiabilityCaseRows(buys, sells));
      return { buys, sells, status: i.status, reason: i.reason, minority_share: r12(i.minorityShare) };
    }),
    rows: rows.map((r) => ({
      created_at: r.createdAt, side: r.side, confidence: r.confidence, label: r.label, ambiguous: r.ambiguous,
      barrier_pct: r.barrierPct, expiry_ret_pct: r.expiryRetPct,
      engine: engineOutcome(r), always_buy: sideOutcomes(r).BUY, always_sell: sideOutcomes(r).SELL,
    })),
    expected: {
      dwr_decided: { wins: dd.wins, losses: dd.losses, timeouts: dd.timeouts, n_decided: dd.nDecided, dwr: r12(dd.dwr) },
      dwr_complete: {
        n: dc.n, wins: dc.wins, losses: dc.losses, flat: dc.flat, unresolved: dc.unresolved,
        inconsistent: dc.inconsistent, timeouts: dc.timeouts, dwr: r12(dc.dwr),
      },
      mix_matched_null: { n: nul.n, share_buy: r12(nul.shareBuy), q_buy: r12(nul.qBuy), q_sell: r12(nul.qSell), p0: r12(nul.p0) },
      cluster_edge_decided: { mean_pp: r12(decided.meanPp), sd_pp: r12(decided.sdPp), clusters: decided.clusters, clusters_dropped: decided.clustersDropped },
      cluster_edge_complete: {
        mean_pp: r12(complete.meanPp), sd_pp: r12(complete.sdPp), ci_lb_pp: r12(complete.ciLbPp), p: r12(complete.p),
        t_stat: r12(complete.tStat), clusters: complete.clusters, clusters_dropped: complete.clustersDropped, verdict: complete.verdict,
      },
      identifiability: { status: id.status, reason: id.reason, minority_share: r12(id.minorityShare), attainable_pp: r12(id.attainablePp) },
    },
  };
}

/** Byte-stable: 1-space indent, trailing newline (the AOE side pins the sha256 of these bytes). */
export function serializeParityFixture(): string {
  return JSON.stringify(buildParityFixture(), null, 1) + '\n';
}
