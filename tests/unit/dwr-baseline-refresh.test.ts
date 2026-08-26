/**
 * dwr-baseline-refresh.test.ts — EDGE-DWR-REFRESH-W1 R2/R4.
 *
 * Covers the pure surface the refresh added: the corpus-window parsing, the descriptive
 * venue/timeframe rollups, and the snapshot writer's projection into `dwr_baseline_runs`.
 *
 * The load-bearing assertions here are the two that protect the BAR:
 *   (a) a rollup PARTITIONS the row set — every labeled row lands in exactly one venue group and
 *       exactly one timeframe group, so a per-venue figure can never double-count or drop rows;
 *   (b) a rollup carries NO `fdrReject` / `validated` key — it is a descriptive projection, not a
 *       member of the multiple-testing family. Adding 17 venue rows to BH-FDR would enlarge the
 *       family and move the bar, which the wave spec forbids.
 */
import { describe as suite, it, expect } from 'vitest';
import { computeCellStats, type LabelRow } from '../../src/scripts/dwr-baseline.js';
import {
  epochBound, parseArgs, rollup, describe as project, specVerdict, walkForward, type DimRow,
} from '../../src/scripts/dwr-baseline-report.js';
import {
  EXIT_FOR, SNAPSHOT_COLUMNS, upsertSql, runMonthOf, projectRow, type SpecSlice,
} from '../../src/scripts/dwr-baseline-snapshot.js';

function row(over: Partial<DimRow> = {}): DimRow {
  return { side: 'BUY', label: 1, ambiguous: false, coin: 'BTC', createdAt: 1_750_000_000, barrierPct: 0.3, venue: 'BINANCE', timeframe: '5m', ...over };
}

suite('epochBound — the only parsing in the report', () => {
  it('absent bound is null (a full-corpus run must not be filtered)', () => {
    expect(epochBound(undefined, '--signals-before')).toBeNull();
    expect(epochBound('', '--signals-before')).toBeNull();
  });

  it('a bare date is midnight UTC, not local midnight', () => {
    expect(epochBound('2026-07-05', '--signals-before')).toBe(Date.parse('2026-07-05T00:00:00Z') / 1000);
  });

  it('a full instant is honoured, with or without the Z', () => {
    expect(epochBound('2026-07-05T12:00:00Z', '--signals-before')).toBe(Date.parse('2026-07-05T12:00:00Z') / 1000);
    expect(epochBound('2026-07-05T12:00', '--signals-before')).toBe(Date.parse('2026-07-05T12:00:00Z') / 1000);
  });

  it('REFUSES anything that is not a date — the value is interpolated into SQL as an integer', () => {
    for (const bad of ['2026-7-5', 'yesterday', "2026-07-05'; DROP TABLE signals--", '1750000000']) {
      expect(() => epochBound(bad, '--signals-before')).toThrow(/expected YYYY-MM-DD/);
    }
  });
});

suite('parseArgs', () => {
  it('reads both window flags and nothing else', () => {
    expect(parseArgs(['--signals-before=2026-07-05'])).toEqual({ signalsBefore: '2026-07-05', labelsBefore: undefined });
    expect(parseArgs(['--labels-before=2026-07-05T12:00Z'])).toEqual({ signalsBefore: undefined, labelsBefore: '2026-07-05T12:00Z' });
    expect(parseArgs([])).toEqual({ signalsBefore: undefined, labelsBefore: undefined });
  });
});

suite('rollup — descriptive, and a strict partition', () => {
  const rows: DimRow[] = [
    row({ venue: 'BINANCE', timeframe: '5m', label: 1 }),
    row({ venue: 'BINANCE', timeframe: '1h', label: -1, side: 'SELL' }),
    row({ venue: 'PHEMEX', timeframe: '5m', label: 0 }),
    row({ venue: 'PHEMEX', timeframe: '5m', label: -1 }),
    row({ venue: 'BITMART', timeframe: '4h', label: 1, side: 'SELL' }),
  ];

  it('partitions the row set on venue — no row lost, none counted twice', () => {
    const out = rollup(rows, 'venue');
    expect(out.map((r) => r.key).sort()).toEqual(['BINANCE', 'BITMART', 'PHEMEX']);
    expect(out.reduce((a, r) => a + r.n, 0)).toBe(rows.length);
  });

  it('partitions the row set on timeframe too', () => {
    const out = rollup(rows, 'timeframe');
    expect(out.map((r) => r.key).sort()).toEqual(['1h', '4h', '5m']);
    expect(out.reduce((a, r) => a + r.n, 0)).toBe(rows.length);
  });

  it('sorts by n descending so the thinly-covered venues are visible at the tail', () => {
    const out = rollup(rows, 'venue');
    expect(out.map((r) => r.n)).toEqual([...out.map((r) => r.n)].sort((a, b) => b - a));
  });

  it('carries NO fdrReject / validated / bonferroni key — a rollup is not in the FDR family', () => {
    for (const r of rollup(rows, 'venue')) {
      expect(r).not.toHaveProperty('fdrReject');
      expect(r).not.toHaveProperty('validated');
      expect(r).not.toHaveProperty('bonferroni');
      expect(r).not.toHaveProperty('walkForward');
    }
  });

  it('an empty row set yields an empty rollup, not a phantom group', () => {
    expect(rollup([], 'venue')).toEqual([]);
  });
});

suite('describe — projection of the ONE derivation, never a second one', () => {
  const rows: LabelRow[] = [
    { side: 'BUY', label: 1, ambiguous: false, coin: 'BTC', createdAt: 1, barrierPct: 0.3 },
    { side: 'SELL', label: -1, ambiguous: false, coin: 'ETH', createdAt: 2, barrierPct: 0.3 },
    { side: 'BUY', label: 0, ambiguous: false, coin: 'SOL', createdAt: 3, barrierPct: 0.3 },
  ];

  it('every field equals computeCellStats on the same rows', () => {
    const s = computeCellStats(rows);
    const p = project(rows);
    expect(p.n).toBe(s.n);
    expect(p.decided).toBe(s.decided);
    expect(p.wins).toBe(s.wins);
    expect(p.losses).toBe(s.losses);
    expect(p.timeouts).toBe(s.timeouts);
    expect(p.dwr).toBeCloseTo(s.dwr, 4);
    expect(p.benchmark).toBeCloseTo(s.benchmark, 4);
    expect(p.edge).toBeCloseTo(s.edge, 4);
    expect(p.wilsonLo).toBeCloseTo(s.wilsonLo, 4);
    expect(p.wilsonHi).toBeCloseTo(s.wilsonHi, 4);
    expect(p.constantSide).toBe(s.constantSide);
  });

  it('a one-sided cell reports PT as undefined rather than inventing a z', () => {
    const allBuy: LabelRow[] = [
      { side: 'BUY', label: 1, ambiguous: false, coin: 'BTC', createdAt: 1, barrierPct: 0.3 },
      { side: 'BUY', label: -1, ambiguous: false, coin: 'ETH', createdAt: 2, barrierPct: 0.3 },
    ];
    const p = project(allBuy);
    expect(p.constantSide).toBe(true);
    expect(p.ptNa).toBe('CONSTANT_SIDE');
  });
});

suite('snapshot writer — the artifacts the DB seam bypasses', () => {
  function slice(over: Partial<SpecSlice> = {}): SpecSlice {
    return {
      spec: 'tau1.0-floor0.30-v1',
      familySize: 178, poweredCells: 104, testableCells: 43, constantSideCells: 59,
      rawPass: 2, fdrPass: 0, bonferroniPass: 0, validated: 0, verdict: 'NO-VALIDATED-EDGE',
      medianDwr: 0.4785, medianEdge: -0.0385,
      aggregate: { n: 400, decided: 300, dwr: 0.48, benchmark: 0.52, edge: -0.04, wilsonLo: 0.42, wilsonHi: 0.54 },
      byVenue: [{ key: 'BINANCE', n: 100 }], byTimeframe: [{ key: '5m', n: 100 }],
      ...over,
    };
  }
  const TS = '2026-08-24T06:41:02.000Z';
  const at = (c: string) => SNAPSHOT_COLUMNS.indexOf(c as (typeof SNAPSHOT_COLUMNS)[number]);

  it('upserts on the month key and RETURNS (dbRun is fire-and-forget on PG)', () => {
    const sql = upsertSql();
    expect(sql).toContain('ON CONFLICT (run_month, spec) DO UPDATE');
    expect(sql).toMatch(/RETURNING\s+run_month, spec, run_ts/);
  });

  it('has exactly one placeholder per column, and never updates the key columns', () => {
    const sql = upsertSql();
    expect(sql).toContain(`$${SNAPSHOT_COLUMNS.length}`);
    expect(sql).not.toContain(`$${SNAPSHOT_COLUMNS.length + 1}`);
    expect(sql).not.toMatch(/run_month = EXCLUDED/);
    expect(sql).not.toMatch(/\bspec = EXCLUDED/);
  });

  it('runMonthOf takes the month from the report clock, and refuses a non-instant', () => {
    expect(runMonthOf(TS)).toBe('2026-08');
    expect(() => runMonthOf('2026-08-24')).toThrow(/ISO instant/);
  });

  it('projectRow arity matches the column list exactly', () => {
    expect(projectRow('2026-08', TS, null, 1000, 860, slice(), []).length).toBe(SNAPSHOT_COLUMNS.length);
  });

  it('coverage_pct is labeled/eligible, and NULL when there is no denominator', () => {
    expect(projectRow('2026-08', TS, null, 1000, 860, slice(), [])[at('coverage_pct')]).toBe(0.86);
    expect(projectRow('2026-08', TS, null, 0, 0, slice(), [])[at('coverage_pct')]).toBeNull();
  });

  it('fdr_survivors carries `validated` (walk-forward survivors), not the raw fdrPass count', () => {
    const r = projectRow('2026-08', TS, null, 10, 5, slice({ validated: 3, fdrPass: 7 }), []);
    expect(r[at('fdr_survivors')]).toBe(3);
    expect(r[at('fdr_pass')]).toBe(7);
  });

  it('a NaN median lands as NULL — a stored float NaN reads as a real measurement later', () => {
    const r = projectRow('2026-08', TS, null, 10, 5, slice({ medianDwr: NaN, medianEdge: NaN }), []);
    expect(r[at('median_dwr')]).toBeNull();
    expect(r[at('median_edge')]).toBeNull();
  });

  it('JSONB columns are serialized before they reach the driver', () => {
    const r = projectRow('2026-08', TS, null, 10, 5, slice(), [{ venue: 'HL', pct: 0.39 }]);
    expect(typeof r[at('by_venue')]).toBe('string');
    expect(typeof r[at('by_timeframe')]).toBe('string');
    expect(JSON.parse(String(r[at('coverage_by_venue')]))).toEqual([{ venue: 'HL', pct: 0.39 }]);
  });

  it('the token to exit-code MAPPING is pinned, not just the token strings', () => {
    expect(EXIT_FOR).toEqual({ PASS: 0, FAIL: 1, INDETERMINATE: 3 });
    expect(new Set(Object.values(EXIT_FOR)).size).toBe(3);
  });
});


// ── EDGE-DWR-VALIDATED-PREDICATE-W1 ────────────────────────────────────────────────────────

suite('walkForward reports the holdout EDGE, not merely its sign', () => {
  /** n rows on ascending days; the 70/30 cut is at floor(0.7·n). */
  function series(labels: Array<[LabelRow['side'], number]>): DimRow[] {
    return labels.map(([side, label], i) => row({ side, label, coin: `C${i}`, createdAt: 1000 + i }));
  }

  it('exposes holdoutEdge so a NEGATIVE holdout can never read as "the edge persisted"', () => {
    // 10 rows: the first 7 train, the last 3 hold out. Every holdout row is a SELL that lost,
    // so the holdout's DWR is 0 against a benchmark of 1 — an unambiguously negative edge.
    const rows = series([
      ['BUY', 1], ['SELL', 1], ['BUY', 1], ['SELL', 1], ['BUY', 1], ['SELL', 1], ['BUY', 1],
      ['SELL', -1], ['SELL', -1], ['SELL', -1],
    ]);
    const wf = walkForward(rows, -0.5);
    expect(wf.holdoutN).toBe(3);
    expect(wf.holdoutEdge).toBeLessThan(0);
    // The exact defect this wave fixes: a negative full edge and a negative holdout edge are
    // "the same sign", so the retained diagnostic still says true while the bar now says no.
    expect(wf.holdoutSameSign).toBe(true);
  });

  it('holdoutSameSign is false when the sign genuinely flips', () => {
    const rows = series([
      ['BUY', -1], ['SELL', -1], ['BUY', -1], ['SELL', -1], ['BUY', -1], ['SELL', -1], ['BUY', -1],
      ['BUY', 1], ['BUY', 1], ['BUY', 1],
    ]);
    expect(walkForward(rows, -0.5).holdoutSameSign).toBe(false);
  });

  it('a single-day cell degrades to an empty holdout rather than inventing one', () => {
    const wf = walkForward([row({ coin: 'A', createdAt: 1 })], 0.1);
    expect(wf.holdoutN).toBe(1); // floor(1*0.7) = 0, so the one row IS the holdout
    expect(walkForward([], 0.1).holdoutN).toBe(0);
  });
});

suite('specVerdict — the vacuity guard, at the point the family is constructed', () => {
  it('EDGE-FOUND only when something actually cleared the bar', () => {
    expect(specVerdict(52, 1)).toEqual({ verdict: 'EDGE-FOUND', verdictReason: null });
  });

  it('NO-VALIDATED-EDGE means a REAL family was tested and none survived', () => {
    expect(specVerdict(52, 0)).toEqual({ verdict: 'NO-VALIDATED-EDGE', verdictReason: null });
  });

  it('zero testable cells is INDETERMINATE, never a clean NO-VALIDATED-EDGE', () => {
    // Before this guard, an empty corpus and a fully-measured corpus with no survivors emitted
    // the identical token — one value encoding both "verified, clean" and "verified nothing".
    expect(specVerdict(0, 0)).toEqual({ verdict: 'INDETERMINATE', verdictReason: 'no_powered_cells' });
  });

  it('the two zero-cases are DISTINGUISHABLE — which is the whole point', () => {
    expect(specVerdict(0, 0).verdict).not.toBe(specVerdict(52, 0).verdict);
  });
});

suite('the snapshot row is self-describing about WHICH bar produced it', () => {
  const slice = (over: Partial<SpecSlice> = {}): SpecSlice => ({
    spec: 'tau1.0-floor0.30-v1',
    familySize: 178, poweredCells: 104, testableCells: 43, constantSideCells: 59,
    rawPass: 2, fdrPass: 0, bonferroniPass: 0, validated: 0, verdict: 'NO-VALIDATED-EDGE',
    verdictReason: null,
    medianDwr: 0.4785, medianEdge: -0.0385,
    aggregate: { n: 400, decided: 300, dwr: 0.48, benchmark: 0.52, edge: -0.04, wilsonLo: 0.42, wilsonHi: 0.54 },
    byVenue: [], byTimeframe: [],
    ...over,
  });
  const at = (c: string) => SNAPSHOT_COLUMNS.indexOf(c as (typeof SNAPSHOT_COLUMNS)[number]);

  it('carries predicate_version, so a stored `validated` can never be read under the wrong bar', () => {
    const r = projectRow('2026-08', '2026-08-26T13:38:56.464Z', null, 10, 5, slice(), [], 'v2-ci-magnitude-2026-08');
    expect(r[at('predicate_version')]).toBe('v2-ci-magnitude-2026-08');
  });

  it('carries verdict_reason for the vacuity case, and NULL otherwise', () => {
    const vacuous = projectRow('2026-08', '2026-08-26T13:38:56.464Z', null, 10, 5,
      slice({ verdict: 'INDETERMINATE', verdictReason: 'no_powered_cells' }), [], 'v2');
    expect(vacuous[at('verdict')]).toBe('INDETERMINATE');
    expect(vacuous[at('verdict_reason')]).toBe('no_powered_cells');
    expect(projectRow('2026-08', '2026-08-26T13:38:56.464Z', null, 10, 5, slice(), [], 'v2')[at('verdict_reason')]).toBeNull();
  });

  it('arity still matches after the two added columns', () => {
    expect(projectRow('2026-08', '2026-08-26T13:38:56.464Z', null, 10, 5, slice(), [], 'v2'))
      .toHaveLength(SNAPSHOT_COLUMNS.length);
    expect(EXIT_FOR.INDETERMINATE).toBe(3);
    expect(upsertSql()).toContain('predicate_version = EXCLUDED.predicate_version');
  });
});
