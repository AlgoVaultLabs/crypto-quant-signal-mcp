// OPS-PERFSTATS-SQL-PUSHDOWN-W1 CH1 — byte-equivalence oracle gate.
//
// Proves the NEW pure path (aggregateRowsInJs → rollupStats) reconstructs the
// EXACT same PerformanceStats as the frozen oracle computeStats, on the live
// fixture AND hand-crafted edges. This is the gate the CH2 SQL path is held to.
//
// Q1 (architect): gate = deep VALUE equality with recursive canonical key-sort
// (byAsset/byExchange order is non-deterministic in the oracle itself — created_at
// is unix SECONDS, no id tiebreak — so raw JSON.stringify can't be the gate).
// Q2 (architect): recentSignals is EXCLUDED from the deep-compare and gated
// separately — (i) shared-id formatted fields identical, (ii) output IS a valid
// (created_at DESC, id DESC) top-20, (iii) zero outcome_* (PII).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  aggregateRowsInJs,
  rollupStats,
  canonicalizeForCompare,
  _computeStatsOracle,
} from '../../src/lib/performance-db.js';
import type { SignalRecord } from '../../src/types.js';

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'audits', 'perfstats-fixture-2026-06-07.json'), 'utf8'),
) as { top20: string[]; rows: SignalRecord[] };

// ── helpers ──
const canonJSON = (o: unknown) => JSON.stringify(canonicalizeForCompare(o));
const omitRecent = (s: Record<string, unknown>) => {
  const { recentSignals, ...rest } = s as { recentSignals: unknown };
  return rest;
};
// The deterministic (created_at DESC, id DESC) top-20 the SQL LIMIT query will use (Q2).
//
// OPS-RECENT-SIGNALS-VENUE-FILTER-W1 gave this helper a VENUE dimension, and that is the whole
// coupling. This function is the test's model of `recentSql`; the real SQL now carries
// `WHERE coalesce(exchange,'HL') = ANY(?)` BEFORE its LIMIT, so the model must filter before
// slicing too. If the production predicate is applied to only one branch, the two paths stop
// agreeing here — which is precisely RED-verify (c), and the reason this file is extended
// rather than a parallel test being written beside it.
const top20Recent = (rows: SignalRecord[], scope: ReadonlySet<string> | null = null) =>
  [...rows]
    .filter(r => scope === null || scope.has(r.exchange || 'HL'))
    .sort((a, b) => (b.created_at - a.created_at) || ((b.id ?? 0) - (a.id ?? 0)))
    .slice(0, 20);

function assertDeepEquivalent(label: string, rows: SignalRecord[], top20: Set<string> | null, scope: ReadonlySet<string> | null = null) {
  const oracle = _computeStatsOracle(rows, top20, scope);
  const { groups, period } = aggregateRowsInJs(rows);
  const rolled = rollupStats(groups, period, top20, top20Recent(rows, scope), scope);
  // Q1: everything EXCEPT recentSignals, canonical value-equality
  expect(canonJSON(omitRecent(rolled as unknown as Record<string, unknown>)),
    `${label}: rollup != oracle (ex-recentSignals)`)
    .toBe(canonJSON(omitRecent(oracle as unknown as Record<string, unknown>)));
  return { oracle, rolled };
}

function assertRecentSignalsGate(label: string, rows: SignalRecord[], rolled: { recentSignals: Array<{ id: number; created_at: number }> }, oracle: { recentSignals: Array<{ id: number }> }, scope: ReadonlySet<string> | null = null) {
  const r = rolled.recentSignals;
  // (ii) IS a valid (created_at DESC, id DESC) top-20 of the ADMITTED input
  const expectedIds = top20Recent(rows, scope).map(x => x.id);
  expect(r.map(x => x.id), `${label}: recentSignals not the valid top-20`).toEqual(expectedIds);
  for (let i = 1; i < r.length; i++) {
    const ok = r[i - 1].created_at > r[i].created_at ||
      (r[i - 1].created_at === r[i].created_at && (r[i - 1].id ?? 0) >= (r[i].id ?? 0));
    expect(ok, `${label}: recentSignals not sorted created_at DESC, id DESC at ${i}`).toBe(true);
  }
  // (i) shared-id formatted records byte-identical to the oracle's formatter
  const oracleById = new Map(oracle.recentSignals.map(x => [x.id, x] as const));
  for (const rec of r) {
    const o = oracleById.get(rec.id);
    if (o) expect(canonJSON(rec), `${label}: recentSignals[id=${rec.id}] fields differ`).toBe(canonJSON(o));
  }
  // (iii) PII — no outcome_* / pfe_* / confidence / call leaked into recentSignals
  expect(JSON.stringify(r)).not.toMatch(/outcome_|pfe_|mae_|confidence|"call"|signal_hash|merkle_/);
}

// ── SignalRecord factory for hand-crafted edges ──
let _id = 1;
function mkRow(p: Partial<SignalRecord> & { coin: string; signal: SignalRecord['signal']; timeframe: string }): SignalRecord {
  return {
    id: p.id ?? _id++,
    coin: p.coin, signal: p.signal, timeframe: p.timeframe,
    confidence: p.confidence ?? 75,
    price_at_signal: 100,
    price_after_15m: null, price_after_1h: null, price_after_4h: null, price_after_24h: null,
    return_pct_15m: null, return_pct_1h: null, return_pct_4h: null, return_pct_24h: null,
    outcome_price: null, outcome_return_pct: null,
    pfe_return_pct: p.pfe_return_pct ?? null,
    mae_return_pct: null, pfe_price: null, mae_price: null, pfe_candles: null, return_1candle: null,
    created_at: p.created_at ?? (1_700_000_000 + _id),
    exchange: p.exchange,
  };
}

describe('OPS-PERFSTATS-SQL-PUSHDOWN-W1 CH1 — rollupStats ≡ computeStats (byte-equivalence)', () => {
  it('live fixture (2000 rows, 17 ex × 9 tf × 162 coins, pfe==0 + null-pfe)', () => {
    const top20 = new Set(FIXTURE.top20);
    const { oracle, rolled } = assertDeepEquivalent('live', FIXTURE.rows, top20);
    assertRecentSignalsGate('live', FIXTURE.rows, rolled as never, oracle as never);
    // sanity: the fixture actually exercised the breakdowns
    expect(Object.keys((rolled as { byExchange: object }).byExchange).length).toBeGreaterThan(1);
    expect(Object.keys((rolled as { byTimeframe: object }).byTimeframe).length).toBeGreaterThan(1);
  });

  it('empty', () => { assertDeepEquivalent('empty', [], new Set()); });

  it('HOLD-only coin + BUY/SELL elsewhere (fixed-literal byCallType/byTier emit)', () => {
    const rows = [
      mkRow({ coin: 'ZZZHOLD', signal: 'HOLD', timeframe: '5m' }),
      mkRow({ coin: 'ZZZHOLD', signal: 'HOLD', timeframe: '1h', pfe_return_pct: 0.5 }), // pfe ignored for HOLD
      mkRow({ coin: 'BTC', signal: 'BUY', timeframe: '5m', pfe_return_pct: 1.2 }),
      mkRow({ coin: 'SOL', signal: 'SELL', timeframe: '15m', pfe_return_pct: -0.8 }),
    ];
    const { oracle, rolled } = assertDeepEquivalent('hold-only', rows, new Set(['SOL']));
    // HOLD key MUST exist with count>0, evaluated 0, null WR
    expect((rolled as { byCallType: Record<string, { count: number; evaluated: number; pfeWinRate: number | null }> }).byCallType.HOLD)
      .toEqual({ count: 2, evaluated: 0, pfeWinRate: null });
    expect((oracle as { byCallType: Record<string, unknown> }).byCallType.HOLD)
      .toEqual({ count: 2, evaluated: 0, pfeWinRate: null });
  });

  it('pfe==0 BUY and SELL are NOT wins (strict >0 / <0)', () => {
    const rows = [
      mkRow({ coin: 'BTC', signal: 'BUY', timeframe: '5m', pfe_return_pct: 0 }),    // eval, not win
      mkRow({ coin: 'BTC', signal: 'SELL', timeframe: '5m', pfe_return_pct: 0 }),   // eval, not win
      mkRow({ coin: 'BTC', signal: 'BUY', timeframe: '5m', pfe_return_pct: 0.01 }), // win
      mkRow({ coin: 'BTC', signal: 'SELL', timeframe: '5m', pfe_return_pct: -0.01 }), // win
    ];
    assertDeepEquivalent('pfe0', rows, new Set());
  });

  it('null-pfe rows excluded from eval', () => {
    const rows = [
      mkRow({ coin: 'ETH', signal: 'BUY', timeframe: '1h', pfe_return_pct: null }),
      mkRow({ coin: 'ETH', signal: 'BUY', timeframe: '1h', pfe_return_pct: 2.0 }),
      mkRow({ coin: 'ETH', signal: 'SELL', timeframe: '1h', pfe_return_pct: null }),
    ];
    assertDeepEquivalent('null-pfe', rows, new Set());
  });

  it('single exchange + null-exchange coalesces to HL', () => {
    const rows = [
      mkRow({ coin: 'BTC', signal: 'BUY', timeframe: '5m', pfe_return_pct: 1, exchange: undefined }), // → HL
      mkRow({ coin: 'BTC', signal: 'BUY', timeframe: '5m', pfe_return_pct: 1, exchange: 'HL' }),       // → HL (merge)
    ];
    const { rolled } = assertDeepEquivalent('null-exchange', rows, new Set());
    expect(Object.keys((rolled as { byExchange: object }).byExchange)).toEqual(['HL']);
  });

  it('multi-tier (BTC=1, top20=2, TradFi=3, meme=4)', () => {
    const rows = [
      mkRow({ coin: 'BTC', signal: 'BUY', timeframe: '5m', pfe_return_pct: 1, exchange: 'BINANCE' }),
      mkRow({ coin: 'SOL', signal: 'BUY', timeframe: '5m', pfe_return_pct: 1, exchange: 'BINANCE' }),  // top20 → 2
      mkRow({ coin: 'TSLA', signal: 'SELL', timeframe: '1h', pfe_return_pct: -1, exchange: 'BINANCE' }), // TradFi → 3
      mkRow({ coin: 'WIF', signal: 'BUY', timeframe: '1h', pfe_return_pct: 0, exchange: 'BYBIT' }),     // meme → 4
    ];
    assertDeepEquivalent('multi-tier', rows, new Set(['SOL']));
  });

  it('aggregateRowsInJs groups carry max_ca/max_id for deterministic ordering (Q1)', () => {
    const rows = [
      mkRow({ coin: 'BTC', signal: 'BUY', timeframe: '5m', pfe_return_pct: 1, created_at: 100, id: 5 }),
      mkRow({ coin: 'BTC', signal: 'BUY', timeframe: '5m', pfe_return_pct: 1, created_at: 200, id: 9 }),
    ];
    const { groups } = aggregateRowsInJs(rows);
    const g = groups.find(x => x.coin === 'BTC' && x.signal === 'BUY' && x.timeframe === '5m')!;
    expect(g.cnt).toBe(2);
    expect(g.pfe_eval).toBe(2);
    expect(g.pfe_win).toBe(2);
    expect(g.max_ca).toBe(200);
    expect(g.max_id).toBe(9);
  });
});

// ── OPS-RECENT-SIGNALS-VENUE-FILTER-W1 — the ROW lane inherits the venue allow-list ──
//
// The previous wave gave the AGGREGATE sections one allow-list. `recentSignals` was not covered:
// both producer branches were a bare recency slice. This block is the venue dimension that the
// byte-equivalence claim above has never had.
//
// WHY THE POOL IS HAND-BUILT AND NOT THE LIVE FIXTURE. The fixture DOES carry all three
// non-promoted venues (EDGEX 72, BITMART 19, WEEX 5 of 2,000), and the first version of this
// block used it — and passed with the predicate deliberately broken. Measured: the fixture's
// UNFILTERED top-20 contains ZERO non-promoted rows, because those venues are too sparse to
// reach a 20-row recency window. The assertions were therefore true for a reason that had
// nothing to do with the filter. RED-verify (a) is what surfaced it. The pool below puts the
// non-promoted rows at the HEAD of the recency order, which is the hazard being guarded — a
// shadow venue whose cadence lands it in the window — and every test here first proves the
// UNFILTERED projection leaks, so it can never quietly go vacuous again.
//
// HONEST SCOPE, because this wave should not be sold as catching a live leak. Measured on prod
// 2026-08-29: over 7 days 208 non-promoted rows were recorded (all WEEX; BITMART and EDGEX are
// retired and dormant, zero rows in the last 5,000), and ZERO was ever inside an unfiltered
// top-20 — the best position any reached was 118 against a window of 20. The ~6x margin is a
// function of relative CADENCE, not of any guard. The hole is structurally open and currently
// unreachable; these tests exist so it stays closed when the cadence changes, which nothing
// today would announce.
describe('OPS-RECENT-SIGNALS-VENUE-FILTER-W1 — recentSignals is venue-scoped on BOTH branches', () => {
  const NON_PROMOTED = ['WEEX', 'EDGEX', 'BITMART'];
  const PROMOTED = new Set(['BINANCE', 'HL']);

  /**
   * 3 non-promoted rows as the MOST RECENT, then 25 promoted — the hazard, modelled.
   *
   * Rows are emitted in `created_at DESC` order ON PURPOSE. `computeStats` takes the FIRST 20
   * of the array it is handed; it does not sort, because its production caller
   * (`loadSignalsForStats`) already returns `ORDER BY created_at DESC`. A pool built ascending
   * makes the non-promoted heads land at the TAIL, outside the window, and every assertion here
   * passes without the filter doing anything — which is how the first draft of this block went
   * vacuous. The ordering is part of the fixture's contract, not incidental.
   */
  function hazardPool(): SignalRecord[] {
    const rows: SignalRecord[] = [];
    NON_PROMOTED.forEach((ex, i) => rows.push(mkRow({
      coin: 'ETH', signal: 'BUY', timeframe: '5m', pfe_return_pct: 1,
      exchange: ex, created_at: 1_800_001_100 - i,   // strictly newer than every promoted row
    })));
    for (let i = 0; i < 25; i++) {
      rows.push(mkRow({
        coin: 'BTC', signal: 'BUY', timeframe: '5m', pfe_return_pct: 1,
        exchange: i % 2 ? 'BINANCE' : 'HL', created_at: 1_800_000_100 - i,
      }));
    }
    return rows;
  }

  const venuesOf = (stats: { recentSignals: Array<{ exchange: string }> }) =>
    new Set(stats.recentSignals.map(r => r.exchange));

  it('PRECONDITION: unfiltered, all three non-promoted venues DO reach the window', () => {
    // If this ever stops holding, every assertion below is vacuous and must be treated as such.
    const leaked = venuesOf(_computeStatsOracle(hazardPool(), null, null));
    for (const ex of NON_PROMOTED) expect(leaked.has(ex), `${ex} absent from the UNFILTERED window`).toBe(true);
  });

  it('a SHADOW or RETIRED venue row never reaches recentSignals — on either branch', () => {
    const rows = hazardPool();
    const oracle = _computeStatsOracle(rows, null, PROMOTED);                                  // branch A
    const { groups, period } = aggregateRowsInJs(rows);
    const rolled = rollupStats(groups, period, null, top20Recent(rows, PROMOTED), PROMOTED);   // branch B
    for (const stats of [oracle, rolled]) {
      const venues = venuesOf(stats);
      for (const ex of NON_PROMOTED) expect(venues.has(ex), `${ex} reached recentSignals`).toBe(false);
      expect([...venues].every(v => PROMOTED.has(v))).toBe(true);
    }
  });

  it('BOTH branches produce the IDENTICAL scoped window — the parity claim gains a venue dimension', () => {
    // Production shape for branch B: the SQL has already applied the predicate, so `recentRows`
    // arrives scoped and the two branches must agree row-for-row.
    const rows = hazardPool();
    const oracle = _computeStatsOracle(rows, null, PROMOTED);
    const { groups, period } = aggregateRowsInJs(rows);
    const rolled = rollupStats(groups, period, null, top20Recent(rows, PROMOTED), PROMOTED);
    expect(canonJSON(rolled.recentSignals)).toBe(canonJSON(oracle.recentSignals));
  });

  it('rollupStats refuses a non-promoted row even when HANDED one — the SQL is not the only guard', () => {
    // THIS is RED-verify (c), and the first version of the test above could not be it. That
    // assertion feeds branch B a pre-filtered `recentRows`, so removing branch B's own predicate
    // changes nothing and the test stays green over an unguarded branch — the exact vacuity the
    // spec warned about. Feeding it UNFILTERED rows is what exercises the predicate that lives
    // in `rollupStats` itself. Both assertions are kept: one pins production parity, this one
    // pins defence-in-depth, and only this one fails when the live branch loses its filter.
    const rows = hazardPool();
    const { groups, period } = aggregateRowsInJs(rows);
    const unscopedInput = top20Recent(rows, null);   // as if the SQL predicate were missing
    expect(unscopedInput.some(r => NON_PROMOTED.includes(r.exchange || 'HL')), 'input must carry the hazard').toBe(true);
    const rolled = rollupStats(groups, period, null, unscopedInput, PROMOTED);
    const venues = venuesOf(rolled);
    for (const ex of NON_PROMOTED) expect(venues.has(ex), `${ex} survived rollupStats`).toBe(false);
    expect([...venues].every(v => PROMOTED.has(v))).toBe(true);
  });

  it('the window is still exactly 20 — the POOL is filtered, never the 20', () => {
    // Slice-then-filter would return 17 here (20 minus the 3 non-promoted heads), and that
    // LENGTH is itself a disclosure: it counts how many rows were withheld.
    const scoped = _computeStatsOracle(hazardPool(), null, PROMOTED);
    expect(scoped.recentSignals).toHaveLength(20);
    expect([...venuesOf(scoped)].every(v => PROMOTED.has(v))).toBe(true);
  });

  it('FAIL-CLOSED: an empty scope yields ZERO rows — it never falls through to unfiltered', () => {
    const rows = hazardPool();
    const empty = _computeStatsOracle(rows, null, new Set<string>());
    expect(empty.recentSignals).toHaveLength(0);
    expect(rows.length).toBeGreaterThan(20);  // non-empty pool: zero is the predicate, not the input
  });

  it('an UNDEFINED scope is refused loudly — it is never read as unfiltered', () => {
    // TypeScript makes this unreachable from a typed caller (the parameter is required), so it
    // can only arrive from untyped JS or a stale call site. Asserting the message keeps the
    // failure legible instead of a bare TypeError several frames from the cause.
    expect(() => _computeStatsOracle(hazardPool(), null, undefined as never))
      .toThrow(/recentVenues is required/);
  });
});
