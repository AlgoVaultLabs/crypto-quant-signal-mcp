/**
 * OPS-SERVED-CANDLE-TRUTH-W1 CH3 (rulings Q1 = A″, Q6, Q7 = A, Q9 = A) — the declared scoring exclusions.
 *
 * Calls priced from an incomplete venue candle window (its newest bar was not the venue's) leave
 * WIN-RATE ELIGIBILITY and nothing else: the published population, every total, the Merkle anchors
 * and /verify keep them. Each registry row belongs to a class the public methodology rule names.
 *
 * What is pinned here, and why:
 *   - the registry: its fields are interpolated into SQL, and `from` / `before` are SECONDS literals
 *     (`signals.created_at` is INTEGER epoch seconds; a millisecond bound would put every row ever
 *     written inside the window); membership is a tuple (exchange, timeframe?, coin?, from?, before),
 *     raw ids only where a tuple cannot express it;
 *   - registry-class coverage: a row whose class the public rule does not name fails, two-way;
 *   - TS <-> SQL parity, evaluated by a real SQL engine instead of a JS model of one: the pushdown
 *     (`PERF_STATS_SQL_PUSHDOWN=1`) is the branch prod executes, so the TypeScript predicate alone
 *     proves nothing about the published number;
 *   - the READERS: every function that scores PFE for a public surface names the shared predicate.
 *     An enumeration, not a detector: a new reader means a new row here;
 *   - a cohort the exclusion empties renders null, never 100.00% and never 0;
 *
 * THIS COMMIT IS INERT: the registry, its predicates and its SQL fragment exist, and nothing
 * applies them yet. The blocks marked INERT assert that, and the switch commit flips each one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  PFE_DEFECT_WINDOWS,
  PFE_EXCLUSION_CLASS_NAMED_BY,
  SCORING_EXCLUSIONS_RULE,
  uncoveredExclusionClasses,
  isDefectWindowEvaluation,
  isDefectWindowEvaluationOf,
  sqlNotDefectWindowOf,
  isPfeEligible,
  pfeExclusionOf,
  pfeWinRateOf,
  sqlNotDefectWindow,
  sqlPfeEligible,
  SQL_PFE_ELIGIBLE,
  type PfeScorable,
} from '../../src/lib/pfe-scoring.js';
import { TIMEFRAMES } from '../../src/lib/capabilities.js';
import { aggregateRowsInJs, rollupStats, _computeStatsOracle } from '../../src/lib/performance-db.js';
import type { SignalRecord } from '../../src/types.js';

const require = createRequire(import.meta.url);
const W = PFE_DEFECT_WINDOWS[0];

type Row = PfeScorable;
let nextId = 1;
const mk = (
  exchange: string | null, timeframe: string, created_at: number,
  signal = 'BUY', pfe: number | null = 1.2, mae: number | null = -0.3, coin = 'BTC',
): Row => ({ id: nextId++, signal, pfe_return_pct: pfe, mae_return_pct: mae, timeframe, created_at, exchange, coin });

const INSIDE_BUY_WIN = mk('BITGET', '1d', W.before - 1);
const MATRIX: Row[] = [
  INSIDE_BUY_WIN,
  mk('BITGET', '1d', W.before),                               // the bound itself: outside (strict <)
  mk('BITGET', '1d', W.before + 1),
  mk('BITGET', '4h', W.before - 1),                           // same venue, other timeframe
  mk('BINANCE', '1d', W.before - 1),                          // same timeframe, other venue
  mk(null, '1d', W.before - 1),                               // NULL exchange is HL
  mk('HL', '1d', W.before - 1),
  mk('BITGET', '1d', W.before - 186 * 86_400),                // 2026-04-19: the start of the history is inside too
  mk('BITGET', '1d', W.before - 1, 'SELL', -0.8, 0.4),        // a SELL winner
  mk('BITGET', '1d', W.before - 1, 'BUY', 0, -2.1),           // an S1 loss
  mk('BITGET', '1d', W.before - 1, 'BUY', 0, 0),              // frozen inside the window
  mk('BITGET', '1d', W.before - 1, 'BUY', null, null),        // never evaluated
  mk('BITGET', '1d', W.before - 1, 'HOLD', null, null),
  mk('BINANCE', '1d', W.before + 1, 'SELL', 0, 0),            // frozen outside
  mk('BINANCE', '1d', W.before + 1, 'SELL', 0, 3.3),          // S1 loss outside
];

/** Evaluate `expr` per row in SQLite. `= 1` is the WHERE / FILTER reading: NULL and false both drop. */
function sqlSelects(rows: Row[], expr: string, alias = ''): Map<number, boolean> {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE signals (id INTEGER PRIMARY KEY, signal TEXT, pfe_return_pct REAL, mae_return_pct REAL, timeframe TEXT, created_at INTEGER, exchange TEXT, coin TEXT)');
  const ins = db.prepare('INSERT INTO signals VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.id, r.signal, r.pfe_return_pct ?? null, r.mae_return_pct ?? null, r.timeframe, r.created_at, r.exchange ?? null, r.coin ?? null);
  const out = new Map<number, boolean>();
  for (const x of db.prepare(`SELECT id, (${expr}) = 1 AS hit FROM signals ${alias}`).all() as { id: number; hit: number | null }[]) {
    out.set(x.id, x.hit === 1);
  }
  db.close();
  return out;
}

/** A full SignalRecord for the stats paths; the confidence is inside the published population. */
const rec = (r: Row): SignalRecord => ({
  id: r.id, coin: r.coin, signal: r.signal, confidence: 70, timeframe: r.timeframe, price_at_signal: 100,
  price_after_15m: null, price_after_1h: null, price_after_4h: null, price_after_24h: null,
  return_pct_15m: null, return_pct_1h: null, return_pct_4h: null, return_pct_24h: null,
  pfe_return_pct: r.pfe_return_pct ?? null, mae_return_pct: r.mae_return_pct ?? null,
  created_at: r.created_at, exchange: r.exchange ?? undefined,
} as unknown as SignalRecord);

describe('the registry', () => {
  it('declares exactly the ruled rows, frozen, with `before` in epoch SECONDS (commit 1: row 1 only)', () => {
    expect(PFE_DEFECT_WINDOWS.map(({ reason: _r, ...w }) => w)).toEqual([{
      class: 'INCOMPLETE_VENUE_WINDOW',
      exchange: 'BITGET',
      timeframe: '1d',
      before: 1792677791,
      owner: 'OPS-SERVED-CANDLE-TRUTH-W1',
    }]);
    // The CH1 prod container start (deploy run 39791489391).
    expect(new Date(W.before * 1000).toISOString()).toBe('2026-10-22T14:03:11.000Z');
    expect(Object.isFrozen(PFE_DEFECT_WINDOWS)).toBe(true);
    for (const w of PFE_DEFECT_WINDOWS) expect(Object.isFrozen(w)).toBe(true);
  });

  it('every window is well-formed and safe to interpolate into SQL', () => {
    for (const w of PFE_DEFECT_WINDOWS) {
      expect(w.exchange).toMatch(/^[A-Z0-9]+$/);
      if (w.timeframe !== undefined) expect((TIMEFRAMES as readonly string[]).includes(w.timeframe), w.timeframe).toBe(true);
      if (w.coin !== undefined) expect(w.coin).toMatch(/^[A-Za-z0-9:._-]+$/);
      for (const t of [w.before, ...(w.from === undefined ? [] : [w.from])]) {
        expect(Number.isSafeInteger(t)).toBe(true);
        expect(t).toBeGreaterThan(1_600_000_000);   // seconds, not 1970
        expect(t).toBeLessThan(10_000_000_000);     // seconds, not milliseconds
      }
      if (w.from !== undefined) expect(w.from).toBeLessThan(w.before);
      if (w.ids !== undefined) expect(w.ids.length).toBeGreaterThan(0);
      expect(w.owner).toMatch(/^[A-Z0-9-]+-W\d+$/);
      expect(w.reason.length).toBeGreaterThan(20);  // INTERNAL: why the row is there, never rendered
      expect(w).not.toHaveProperty('publicReason');
    }
  });

  it('the generator refuses a value it cannot interpolate safely', () => {
    expect(() => sqlNotDefectWindowOf([{ ...PFE_DEFECT_WINDOWS[0], coin: "X' OR '1'='1" }])).toThrow(/unsafe coin/);
    expect(() => sqlNotDefectWindowOf([{ ...PFE_DEFECT_WINDOWS[0], before: 1792677791000 }])).toThrow(/epoch seconds/);
    expect(() => sqlNotDefectWindowOf([{ ...PFE_DEFECT_WINDOWS[0], ids: [] }])).toThrow(/ids/);
  });
});

describe('registry-class coverage: every row is a class the public rule names (ruling Q6)', () => {
  it('the shipped registry is covered, and the rule is the ruled text', () => {
    expect(uncoveredExclusionClasses(PFE_DEFECT_WINDOWS)).toEqual([]);
    expect(SCORING_EXCLUSIONS_RULE).toBe('Win rate counts only calls that can be scored from complete venue data: calls on a market that did not trade during the evaluation window, or priced from an incomplete venue candle window, are excluded. Every call stays counted, Merkle-anchored and verifiable.');
    for (const words of Object.values(PFE_EXCLUSION_CLASS_NAMED_BY)) expect(SCORING_EXCLUSIONS_RULE).toContain(words);
  });
  it('two-way: an unnamed class, or a rule that stops naming one, fails', () => {
    expect(uncoveredExclusionClasses([{ class: 'SOMETHING_ELSE' }])).toEqual(['SOMETHING_ELSE']);
    expect(uncoveredExclusionClasses(PFE_DEFECT_WINDOWS, 'Win rate counts every call.')).toEqual(['INCOMPLETE_VENUE_WINDOW']);
  });
});

describe('tuple membership: coin, from and ids narrow a row, both sides', () => {
  const B = PFE_DEFECT_WINDOWS[0].before;
  const rows = [
    { class: 'INCOMPLETE_VENUE_WINDOW' as const, exchange: 'WHITEBIT', timeframe: '1h', coin: 'ETH', from: B - 1000, before: B, owner: 'OPS-SERVED-CANDLE-TRUTH-W1', reason: 'fixture: one coin, one tf, a from' },
    { class: 'INCOMPLETE_VENUE_WINDOW' as const, exchange: 'PHEMEX', before: B, owner: 'OPS-SERVED-CANDLE-TRUTH-W1', reason: 'fixture: every coin, every tf' },
    { class: 'INCOMPLETE_VENUE_WINDOW' as const, exchange: 'BITGET', timeframe: '4h', before: B, ids: [777001, 777002], owner: 'OPS-SERVED-CANDLE-TRUTH-W1', reason: 'fixture: raw ids' },
  ];
  const T: [Row, boolean][] = [
    [mk('WHITEBIT', '1h', B - 1, 'BUY', 1, -1, 'ETH'), true],
    [mk('WHITEBIT', '1h', B - 1000, 'BUY', 1, -1, 'ETH'), true],     // from is inclusive
    [mk('WHITEBIT', '1h', B - 1001, 'BUY', 1, -1, 'ETH'), false],
    [mk('WHITEBIT', '1h', B, 'BUY', 1, -1, 'ETH'), false],            // before is exclusive
    [mk('WHITEBIT', '1h', B - 1, 'BUY', 1, -1, 'BTC'), false],        // other coin
    [mk('WHITEBIT', '4h', B - 1, 'BUY', 1, -1, 'ETH'), false],        // other tf
    [mk('PHEMEX', '5m', B - 1, 'BUY', 1, -1, 'AGPU'), true],
    [mk('PHEMEX', '1d', B - 9_999_999, 'BUY', 1, -1, 'BTC'), true],
    [mk('PHEMEX', '1d', B + 1, 'BUY', 1, -1, 'BTC'), false],
    [{ ...mk('BITGET', '4h', B - 1), id: 777001 }, true],
    [{ ...mk('BITGET', '4h', B - 1), id: 777003 }, false],
    [{ ...mk('BITGET', '4h', B + 1), id: 777002 }, false],
  ];
  it('TS and SQL agree row for row', () => {
    const notIn = sqlSelects(T.map(([r]) => r), sqlNotDefectWindowOf(rows));
    for (const [r, want] of T) {
      expect(isDefectWindowEvaluationOf(rows, r), JSON.stringify(r)).toBe(want);
      expect(!notIn.get(r.id), `SQL ${JSON.stringify(r)}`).toBe(want);
    }
  });
});

describe('TS <-> SQL parity, row for row, in a real SQL engine', () => {
  it('in the window', () => {
    const notIn = sqlSelects(MATRIX, sqlNotDefectWindow());
    for (const r of MATRIX) expect(isDefectWindowEvaluation(r), JSON.stringify(r)).toBe(!notIn.get(r.id));
    expect(MATRIX.filter(isDefectWindowEvaluation).length).toBe(7);   // the matrix exercises both sides
  });

  it('eligible (the SQL fragment leaves HOLD to the caller, which groups on signal)', () => {
    const sql = sqlSelects(MATRIX, SQL_PFE_ELIGIBLE);
    for (const r of MATRIX) expect(isPfeEligible(r), JSON.stringify(r)).toBe(r.signal !== 'HOLD' && sql.get(r.id));
  });

  it('a NULL timeframe or created_at is outside the window on both sides, never a silent NULL', () => {
    const odd: Row[] = [
      { id: 9001, signal: 'BUY', pfe_return_pct: 1, mae_return_pct: -1, timeframe: null as unknown as string, created_at: W.before - 1, exchange: 'BITGET' },
      { id: 9002, signal: 'BUY', pfe_return_pct: 1, mae_return_pct: -1, timeframe: '1d', created_at: null as unknown as number, exchange: 'BITGET' },
    ];
    const notIn = sqlSelects(odd, sqlNotDefectWindow());
    for (const r of odd) {
      expect(isDefectWindowEvaluation(r)).toBe(false);
      expect(notIn.get(r.id)).toBe(true);
    }
  });

  it('the aliased form selects the same rows; a bad alias throws', () => {
    const bare = sqlSelects(MATRIX, sqlPfeEligible());
    const aliased = sqlSelects(MATRIX, sqlPfeEligible('s'), 's');
    expect([...aliased]).toEqual([...bare]);
    expect(sqlPfeEligible('s')).not.toMatch(/(?<![\w.'])(pfe_return_pct|mae_return_pct|exchange|timeframe|created_at)\b/);
    expect(() => sqlPfeEligible('s; DROP TABLE signals')).toThrow(/bad SQL alias/);
  });

  it('INERT: SQL_PFE_ELIGIBLE is sqlPfeEligible(), byte-identical to the fragment before this wave', () => {
    expect(SQL_PFE_ELIGIBLE).toBe(sqlPfeEligible());
    expect(SQL_PFE_ELIGIBLE).toBe('pfe_return_pct IS NOT NULL AND NOT (pfe_return_pct = 0 AND mae_return_pct = 0)');
  });
});

describe('INERT: a window row still counts in this commit', () => {
  it('stays eligible; the other exclusions are unchanged', () => {
    expect(pfeExclusionOf(INSIDE_BUY_WIN)).toBeNull();
    expect(isPfeEligible(INSIDE_BUY_WIN)).toBe(true);
    expect(pfeExclusionOf(mk('BITGET', '1d', W.before - 1, 'BUY', 0, 0))).toBe('frozen');
    expect(pfeExclusionOf(mk('BITGET', '1d', W.before - 1, 'HOLD', null, null))).toBe('hold');
  });

  it('pfeWinRateOf reports the window exclusion beside the frozen one, and it is 0', () => {
    const r = pfeWinRateOf(MATRIX);
    expect(r.excludedDefectWindow).toBe(0);
    expect(r.excludedFrozen).toBe(2);
    expect(r.evaluated).toBe(MATRIX.filter(isPfeEligible).length);
  });
});

describe('an emptied cohort renders null, never 100.00% and never 0', () => {
  // BINANCE 1d is the control in both cohorts: one win, one S1 loss, outside the window.
  const control = [mk('BINANCE', '1d', W.before + 100), mk('BINANCE', '1d', W.before + 200, 'BUY', 0, -1)];
  const COHORTS: [string, Row[]][] = [
    // BITGET 1d, 4 calls, every one a frozen book (S2): the exclusion that predates this wave.
    ['emptied by S2', [0, 1, 2, 3].map((i) => mk('BITGET', '1d', W.before + 300 + i, 'BUY', 0, 0))],
  ];

  for (const [cohort, bitgetRows] of COHORTS) {
    const rows = [...bitgetRows, ...control].map(rec).sort((a, b) => b.created_at - a.created_at);
    for (const [branch, stats] of [
      ['scan branch (computeStats)', () => _computeStatsOracle(rows, null, null)],
      ['pushdown branch (rollupStats over the grouped rows)', () => {
        const { groups, period } = aggregateRowsInJs(rows);
        return rollupStats(groups, period, null, [], null);
      }],
    ] as const) {
      it(`${cohort} — ${branch}`, () => {
        const s = stats();
        const bitget = s.byExchange.BITGET;
        expect(bitget.count).toBe(4);                        // the calls stay counted …
        expect(bitget.evaluated).toBe(0);                    // … and none is scored
        expect(bitget.pfeWinRate).toBeNull();
        expect(bitget.byTimeframe['1d'].pfeWinRate).toBeNull();
        expect(s.byExchange.BINANCE.pfeWinRate).toBe(0.5);   // the control is untouched
        expect(s.totalCalls).toBe(6);
        expect(s.overall.totalEvaluated).toBe(2);
        expect(s.overall.pfeWinRate).toBe(0.5);
      });
    }
  }
});

describe('READERS: every public PFE scorer names the shared predicate', () => {
  const READERS: { fn: string; names: RegExp; why: string }[] = [
    { fn: 'computeStats', names: /\bisPfeEligible\b/, why: 'scan branch of /api/performance-public, performance://signal-performance, get_track_record' },
    { fn: 'aggregateRowsInJs', names: /\bisPfeEligible\b/, why: 'the in-JS reference grouping the pushdown is pinned against' },
    { fn: 'buildStatsAggregateSql', names: /\bSQL_PFE_ELIGIBLE\b|\bsqlPfeEligible\(/, why: 'the LIVE prod branch (PERF_STATS_SQL_PUSHDOWN=1)' },
  ];
  const src = stripComments(readFileSync(resolve(__dirname, '../../src/lib/performance-db.ts'), 'utf8'));

  for (const { fn, names, why } of READERS) {
    it(`${fn} — ${why}`, () => {
      const body = extractFunctionBody(src, fn);
      expect(body, `${fn} no longer exists in performance-db.ts`).not.toBe('');
      expect(names.test(body), `${fn} scores PFE without the shared eligibility predicate`).toBe(true);
      expect(body, `${fn} carries a bare eligibility copy`).not.toMatch(/pfe_return_pct IS NOT NULL/);
    });
  }

  it('INERT: getConfidenceBands (/api/confidence-bands-public) still carries the bare copy the switch replaces', () => {
    expect(extractFunctionBody(src, 'getConfidenceBands')).toMatch(/pfe_return_pct IS NOT NULL/);
  });
});

// ── helpers (the band-population-invariance.test.ts forms) ──

/** Strip line and block comments so a ban-grep cannot false-positive on explanatory prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * A named function's source, from its declaration to the next top-level declaration of any kind.
 * Wider than the band-population-invariance form, which stops only at a function or const: this
 * file also asserts ABSENCE, and an interface's trailing comment past the function is not its body.
 */
function extractFunctionBody(src: string, name: string): string {
  const re = new RegExp(`(export )?(async )?function ${name}\\b`);
  const m = re.exec(src);
  if (!m) return '';
  const rest = src.slice(m.index);
  const next = rest.slice(1).search(/\n(export )?(async )?(function|const|let|interface|type|class) /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}
