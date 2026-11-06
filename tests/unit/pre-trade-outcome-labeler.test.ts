/**
 * DECISION-CALL-V2-W4 CH3 — the pre_trade_check outcome labeler (src/scripts/pre-trade-outcome-labeler.ts).
 *
 * AC3.1 — on fixture candles: each `bracket_first` value, a bar touching both barriers, a leveraged check
 * touching its liquidation price, a venue gap that turns unlabelable only after 7 days, a re-run that labels
 * nothing twice, and a work-list that never hands over an unfinished hold.
 * AC3.2 — quarantine: the labeler writes no table but `pre_trade_check_outcomes`, and nothing else in src/
 * (so no public route) names that table.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Candle } from '../../src/types.js';

const fake = vi.hoisted(() => ({
  query: null as null | ((sql: string, params?: unknown[]) => Promise<unknown[]>),
  candles: null as null | ((coin: string, tf: string, start: number, end?: number) => Promise<Candle[]>),
}));
vi.mock('../../src/lib/performance-db.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/performance-db.js')>()),
  dbQuery: vi.fn(async (sql: string, params?: unknown[]) => fake.query!(sql, params)),
}));
vi.mock('../../src/lib/exchange-adapter.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/exchange-adapter.js')>()),
  getAdapter: vi.fn(() => ({ getCandles: (coin: string, tf: string, start: number, _dex?: unknown, end?: number) => fake.candles!(coin, tf, start, end) })),
}));

import {
  SETTLE_MS, UNREADABLE_AFTER_MS, CREATE_OUTCOMES_SQL, GRANT_OUTCOMES_READ_SQL, WORKLIST_SQL, INSERT_OUTCOME_SQL,
  intervalForHold, holdGrid, labelFromBars, missingBars, toCheckRow, runLabeler, main,
  type LabelerDeps,
} from '../../src/scripts/pre-trade-outcome-labeler.js';
import { WeightBudgetSkipError } from '../../src/lib/upstream-weight-budget.js';
import { _resetGracefulStopForTest } from '../../src/lib/graceful-stop.js';

const ROOT = resolve(__dirname, '../..');
const MIN = 60_000;
const H = 3_600_000;
const D = 24 * H;
const NOW = Date.parse('2026-11-06T12:00:00Z');
const LABELER = readFileSync(join(ROOT, 'src/scripts/pre-trade-outcome-labeler.ts'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'migrations/054_pre_trade_check_outcomes.sql'), 'utf8');

/** n bars on a `step` grid from `fromOpen`, each priced by `px(i)` (open, high, low, close). */
function bars(fromOpen: number, n: number, step: number, px: (i: number) => [number, number, number, number]): Candle[] {
  return Array.from({ length: n }, (_, i) => { const [open, high, low, close] = px(i); return { time: fromOpen + i * step, open, high, low, close, volume: 1 }; });
}
const flat = (p = 100): [number, number, number, number] => [p, p + 0.1, p - 0.1, p];
/** A path that sits flat at 100, then on bar `at` reaches `high` and `low`. */
const spike = (at: number, high: number, low: number) => (i: number): [number, number, number, number] => (i === at ? [100, high, low, 100] : flat());

/** One pre_trade_checks row as pg returns it (BIGINT as text, TIMESTAMPTZ as a Date). */
function checkRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: '1', checked_at: new Date(NOW - 3 * D), coin: 'BTC', side: 'long', hold_hours: 8, leverage: null,
    stop_pct: 2, target_pct: 4, decision_venue: 'BINANCE', liq_distance_pct: null, ...over,
  };
}

/** A fake database that implements the three statements and refuses any other. */
function fakeDb(checks: Record<string, unknown>[], opts: { failInsert?: boolean; staleWorklist?: boolean; failGrant?: boolean } = {}) {
  const outcomes = new Map<number, unknown[]>();
  const calls: { sql: string; params?: unknown[] }[] = [];
  const ms = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
  const query = async (sql: string, params?: unknown[]): Promise<unknown[]> => {
    calls.push({ sql, params });
    if (sql === CREATE_OUTCOMES_SQL) return [];
    if (sql === GRANT_OUTCOMES_READ_SQL) { if (opts.failGrant) throw new Error('role "aoe_readonly" does not exist'); return []; }
    if (sql === WORKLIST_SQL) {
      const settled = Date.parse(String(params![0]));
      return checks
        .filter((c) => (opts.staleWorklist || !outcomes.has(Number(c.id))) && ms(c.checked_at) + Number(c.hold_hours) * H <= settled)
        .sort((a, b) => ms(a.checked_at) - ms(b.checked_at) || Number(a.id) - Number(b.id))
        .slice(0, Number(params![1]));
    }
    if (sql === INSERT_OUTCOME_SQL) {
      if (opts.failInsert) throw new Error('connection terminated');
      const id = Number(params![0]);
      if (outcomes.has(id)) return [];
      outcomes.set(id, params!);
      return [{ check_id: String(id) }];
    }
    throw new Error(`fake db: unexpected SQL ${sql.slice(0, 60)}`);
  };
  return { query, outcomes, calls };
}

/** The outcome row a fake db holds for a check, by column. */
function outcomeOf(db: ReturnType<typeof fakeDb>, id: number) {
  const p = db.outcomes.get(id);
  if (!p) return undefined;
  const [checkId, labeledAt, venue, interval, refPx, endPx, highPx, lowPx, bracketFirst, liqTouched, status, reason] = p;
  return { checkId, labeledAt, venue, interval, refPx, endPx, highPx, lowPx, bracketFirst, liqTouched, status, reason };
}

/** Deps over a fake db and a fake venue: `serve` returns every bar the venue holds for a check's window. */
function deps(db: ReturnType<typeof fakeDb>, serve: LabelerDeps['candles'], over: Partial<LabelerDeps> = {}): LabelerDeps {
  return { query: db.query as LabelerDeps['query'], candles: serve, stepMs: (_v, tf) => ({ '1m': MIN, '5m': 5 * MIN, '15m': 15 * MIN } as Record<string, number>)[tf] ?? null, stop: () => false, ...over };
}
const opt = (over: Partial<{ nowMs: number; maxChecks: number; deadlineMs: number; clock: () => number }> = {}) =>
  ({ nowMs: NOW, maxChecks: 500, deadlineMs: NOW + 30 * MIN, clock: () => NOW, ...over });
/** A venue that serves the full grid of every window, priced by `px`. */
const fullVenue = (px: (i: number) => [number, number, number, number] = () => flat()): LabelerDeps['candles'] =>
  async (_venue, _coin, _tf, fromOpen, toOpen, step) => bars(fromOpen, Math.round((toOpen - fromOpen) / step) + 1, step, px);

describe('the schema: the labeler\'s ensure IS migrations/054', () => {
  const norm = (s: string) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join(' ').replace(/\s+/g, ' ').trim();
  /** The migration's statement that starts with `head`, up to its own `;`. */
  const stmt = (head: string) => { const i = MIGRATION.indexOf(head); return i < 0 ? '' : MIGRATION.slice(i, MIGRATION.indexOf(';', i)); };
  it('the same CREATE and the same GRANT, once normalized; the down drops only this table and says it is destructive', () => {
    expect(stmt('CREATE TABLE IF NOT EXISTS pre_trade_check_outcomes').length, 'migration parser found nothing').toBeGreaterThan(200);
    expect(norm(CREATE_OUTCOMES_SQL)).toBe(norm(stmt('CREATE TABLE IF NOT EXISTS pre_trade_check_outcomes')));
    expect(GRANT_OUTCOMES_READ_SQL).toBe(norm(stmt('GRANT SELECT ON pre_trade_check_outcomes')));
    expect(GRANT_OUTCOMES_READ_SQL).toBe('GRANT SELECT ON pre_trade_check_outcomes TO aoe_readonly');
    const down = readFileSync(join(ROOT, 'migrations/054_pre_trade_check_outcomes.down.sql'), 'utf8');
    expect(down).toContain('DESTRUCTIVE');
    expect(down.split('\n').filter((l) => /^\s*DROP /.test(l))).toEqual(['DROP TABLE IF EXISTS pre_trade_check_outcomes;']);
  });

  it('prices only: no return, P&L, pnl, profit or win column', () => {
    const cols = [...CREATE_OUTCOMES_SQL.matchAll(/^\s+"?([a-z_]+)"?\s+[A-Z]/gm)].map((m) => m[1]);
    expect(cols).toEqual(['check_id', 'labeled_at', 'venue', 'interval', 'ref_px', 'end_px', 'high_px', 'low_px', 'bracket_first', 'liq_touched', 'status', 'reason']);
    for (const c of cols) expect(c, c).not.toMatch(/ret|pnl|p_l|profit|win|loss|return/);
  });
});

describe('AC3.1 — the mechanics, one derivation each', () => {
  it('interval: 1m to a 24 h hold, 5m to 7 d, 15m beyond', () => {
    expect([1, 8, 24].map(intervalForHold)).toEqual(['1m', '1m', '1m']);
    expect([24.01, 72, 168].map(intervalForHold)).toEqual(['5m', '5m', '5m']);
    expect([168.5, 720].map(intervalForHold)).toEqual(['15m', '15m']);
  });

  it('the grid: the first bar opens at or after the check, the last closes at or before the hold\'s end', () => {
    const t = Date.parse('2026-11-01T05:24:30Z');
    const g = holdGrid(t, 8, MIN);
    expect(g.firstOpenMs).toBe(Date.parse('2026-11-01T05:25:00Z'));
    expect(g.bars).toBe(479);
    expect(g.firstOpenMs + g.bars * MIN).toBeLessThanOrEqual(g.endMs);
    expect(g.firstOpenMs + (g.bars + 1) * MIN).toBeGreaterThan(g.endMs);
    expect(holdGrid(Date.parse('2026-11-01T05:00:00Z'), 1, MIN)).toMatchObject({ firstOpenMs: Date.parse('2026-11-01T05:00:00Z'), bars: 60 });
  });

  it('missingBars names every grid step a window lacks, oldest first', () => {
    const b = bars(0, 5, MIN, () => flat()).filter((x) => x.time !== 2 * MIN);
    expect(missingBars(b, 0, 5, MIN)).toEqual([2 * MIN]);
    expect(missingBars(bars(0, 5, MIN, () => flat()), 0, 5, MIN)).toEqual([]);
  });
});

describe('AC3.1 — labelFromBars: each bracket_first value, both in one bar, the liquidation touch', () => {
  const long = { side: 'long' as const, stopPct: 2, targetPct: 4, leverage: null, liqDistancePct: null };
  const short = { ...long, side: 'short' as const };

  it('ref_px is the first bar\'s open; end_px the last close; high_px / low_px the extremes', () => {
    const b = bars(0, 4, MIN, (i) => [100 + i, 101 + i, 99 + i, 100.5 + i]);
    expect(labelFromBars(long, b)).toMatchObject({ refPx: 100, endPx: 103.5, highPx: 104, lowPx: 99 });
  });

  it('long: target (+4% first), stop (−2% first), timeout (neither)', () => {
    expect(labelFromBars(long, bars(0, 10, MIN, spike(3, 104, 99.9))).bracketFirst).toBe('target');
    expect(labelFromBars(long, bars(0, 10, MIN, spike(3, 100.1, 98))).bracketFirst).toBe('stop');
    expect(labelFromBars(long, bars(0, 10, MIN, spike(3, 103.99, 98.01))).bracketFirst).toBe('timeout');
  });

  it('short: the target is BELOW the reference, the stop above', () => {
    expect(labelFromBars(short, bars(0, 10, MIN, spike(3, 100.1, 96))).bracketFirst).toBe('target');
    expect(labelFromBars(short, bars(0, 10, MIN, spike(3, 102, 99.9))).bracketFirst).toBe('stop');
  });

  it('the FIRST touch decides: a stop on bar 2 beats a target on bar 5', () => {
    const px = (i: number): [number, number, number, number] => (i === 2 ? [100, 100.1, 97.9, 100] : i === 5 ? [100, 104.5, 99.9, 100] : flat());
    expect(labelFromBars(long, bars(0, 10, MIN, px)).bracketFirst).toBe('stop');
  });

  it('one bar crossing both barriers is both_in_one_bar — its order is unknowable at this resolution', () => {
    expect(labelFromBars(long, bars(0, 10, MIN, spike(4, 104.2, 97.5))).bracketFirst).toBe('both_in_one_bar');
  });

  it('no stop or no target: bracket_first is NULL, never a timeout', () => {
    for (const c of [{ ...long, stopPct: null }, { ...long, targetPct: null }]) {
      expect(labelFromBars(c, bars(0, 10, MIN, spike(3, 110, 90))).bracketFirst).toBeNull();
    }
  });

  it('a leveraged check: the liquidation price touched or not, by side; NULL without leverage or a distance', () => {
    const lev = { ...long, leverage: 20, liqDistancePct: 4.6185 };
    expect(labelFromBars(lev, bars(0, 10, MIN, spike(6, 100.1, 95.3))).liqTouched).toBe(true);   // 100·(1 − 0.046185) = 95.38
    expect(labelFromBars(lev, bars(0, 10, MIN, spike(6, 100.1, 95.4))).liqTouched).toBe(false);
    expect(labelFromBars({ ...lev, side: 'short' }, bars(0, 10, MIN, spike(6, 104.7, 99.9))).liqTouched).toBe(true); // 104.6185
    expect(labelFromBars({ ...lev, side: 'short' }, bars(0, 10, MIN, spike(6, 104.6, 99.9))).liqTouched).toBe(false);
    expect(labelFromBars({ ...lev, leverage: null }, bars(0, 10, MIN, spike(6, 100.1, 90))).liqTouched).toBeNull();
    expect(labelFromBars({ ...lev, liqDistancePct: null }, bars(0, 10, MIN, spike(6, 100.1, 90))).liqTouched).toBeNull();
  });

  it('a window that breaks its own invariants throws — the caller counts a FAIL, never writes a label', () => {
    expect(() => labelFromBars(long, [])).toThrow(/no bars/);
    expect(() => labelFromBars(long, bars(0, 3, MIN, (i) => (i === 1 ? [100, 101, 0, 100] : flat())))).toThrow(/non-positive/);
    expect(() => labelFromBars(long, bars(0, 3, MIN, (i) => (i === 1 ? [100, 99, 101, 100] : flat())))).toThrow(/high below low/);
  });
});

describe('AC3.1 — runLabeler: dispositions over a fake database and a fake venue', () => {
  it('labels a settled check: one row, the 1m path\'s label, status labeled', async () => {
    const db = fakeDb([checkRow({ id: '7', leverage: 20, liq_distance_pct: 4.6185 })]);
    const r = await runLabeler(deps(db, fullVenue(spike(100, 104.1, 99.9))), opt());
    expect(r).toMatchObject({ verdict: 'PASS', counts: { worklist: 1, labeled: 1 }, firstLabeledAt: new Date(NOW).toISOString() });
    expect(outcomeOf(db, 7)?.labeledAt, 'the anchor the log prints is the labeled_at written').toBe(r.firstLabeledAt);
    expect(outcomeOf(db, 7)).toMatchObject({ venue: 'BINANCE', interval: '1m', refPx: 100, bracketFirst: 'target', liqTouched: false, status: 'labeled', reason: null });
  });

  it('the work-list never hands over an unfinished hold: the predicate is now − 1 h, and the guard refuses what slips through', async () => {
    // the predicate, as written: the hold's end at or before $1, and $1 = now − SETTLE_MS
    expect(WORKLIST_SQL).toContain("c.checked_at + c.hold_hours * interval '1 hour' <= $1::timestamptz");
    expect(WORKLIST_SQL).toMatch(/LEFT JOIN pre_trade_check_outcomes o ON o\.check_id = c\.id\s+WHERE o\.check_id IS NULL/);
    expect(SETTLE_MS).toBe(H);
    const db = fakeDb([checkRow({ checked_at: new Date(NOW - 8 * H - 30 * MIN) })]);   // ended 30 min ago: not settled
    const r = await runLabeler(deps(db, fullVenue()), opt());
    const wl = db.calls.find((c) => c.sql === WORKLIST_SQL)!;
    expect(wl.params).toEqual([new Date(NOW - SETTLE_MS).toISOString(), 500]);
    expect([r.verdict, r.counts.worklist, db.outcomes.size]).toEqual(['PASS', 0, 0]);
    // a broken predicate that hands over an unfinished hold: refused, never fetched or written, and a FAIL
    const leaky = fakeDb([checkRow({ checked_at: new Date(NOW - 8 * H - 30 * MIN) })]);
    const leakyQuery: LabelerDeps['query'] = async <T,>(sql: string, params?: unknown[]) =>
      (sql === WORKLIST_SQL ? (leaky.query(sql, [new Date(NOW).toISOString(), params![1]]) as Promise<T[]>) : (leaky.query(sql, params) as Promise<T[]>));
    const serve = vi.fn(fullVenue());
    const r2 = await runLabeler({ ...deps(leaky, serve), query: leakyQuery }, opt());
    expect([r2.verdict, r2.counts.refused_unfinished, serve.mock.calls.length, leaky.outcomes.size]).toEqual(['FAIL', 1, 0, 0]);
  });

  it('a venue gap defers the check while the hold is younger than 7 days, then writes it unlabelable with its reason', async () => {
    const gap: LabelerDeps['candles'] = async (...a) => (await fullVenue()(...a)).filter((_, i) => i !== 50);
    const young = fakeDb([checkRow({ checked_at: new Date(NOW - 2 * D) })]);
    const r = await runLabeler(deps(young, gap), opt());
    expect([r.verdict, r.counts.deferred_gap, young.outcomes.size]).toEqual(['PASS', 1, 0]);
    const old = fakeDb([checkRow({ checked_at: new Date(NOW - 8 * D) })]);
    const r2 = await runLabeler(deps(old, gap), opt());
    expect([r2.verdict, r2.counts.unlabelable]).toEqual(['PASS', 1]);
    expect(outcomeOf(old, 1)).toMatchObject({ status: 'unlabelable', bracketFirst: null, refPx: null, reason: 'venue gap: 1 of 480 1m bars missing 7 days after the hold' });
    expect(UNREADABLE_AFTER_MS).toBe(7 * D);
  });

  it('a re-run labels nothing twice: the anti-join empties the work-list, and a raced insert is counted, not written', async () => {
    // the two database facts the fake below can only model: one row per check, and a conflicting insert writes nothing
    expect(CREATE_OUTCOMES_SQL).toMatch(/check_id\s+BIGINT\s+PRIMARY KEY REFERENCES pre_trade_checks \(id\)/);
    expect(INSERT_OUTCOME_SQL).toMatch(/ON CONFLICT \(check_id\) DO NOTHING\s+RETURNING check_id$/);
    const db = fakeDb([checkRow({ id: '1' }), checkRow({ id: '2', checked_at: new Date(NOW - 2 * D) })]);
    const first = await runLabeler(deps(db, fullVenue()), opt());
    expect([first.counts.labeled, db.outcomes.size]).toEqual([2, 2]);
    const snapshot = JSON.stringify([...db.outcomes]);
    const second = await runLabeler(deps(db, fullVenue()), opt());
    expect([second.verdict, second.counts.worklist, second.counts.labeled, JSON.stringify([...db.outcomes])]).toEqual(['PASS', 0, 0, snapshot]);
    // a work-list read before another run's insert landed: ON CONFLICT DO NOTHING returns no row
    const raced = fakeDb([checkRow({ id: '1' })], { staleWorklist: true });
    await runLabeler(deps(raced, fullVenue()), opt());
    const again = await runLabeler(deps(raced, fullVenue()), opt());
    expect([again.counts.worklist, again.counts.already_labeled, again.counts.labeled, raced.outcomes.size]).toEqual([1, 1, 0, 1]);
  });

  it('a failed fetch defers (INDETERMINATE) until 7 days after the hold, then the check is unlabelable', async () => {
    const down: LabelerDeps['candles'] = async () => { throw new Error('ECONNRESET'); };
    const young = fakeDb([checkRow()]);
    const r = await runLabeler(deps(young, down), opt());
    expect([r.verdict, r.counts.deferred_fetch, young.outcomes.size]).toEqual(['INDETERMINATE', 1, 0]);
    const old = fakeDb([checkRow({ checked_at: new Date(NOW - 9 * D) })]);
    const r2 = await runLabeler(deps(old, down), opt());
    expect(r2.verdict).toBe('PASS');
    expect(outcomeOf(old, 1)).toMatchObject({ status: 'unlabelable', reason: 'fetch failed 7 days after the hold: ECONNRESET' });
  });

  it('a spent venue budget defers that venue\'s checks, never another venue\'s', async () => {
    const db = fakeDb([
      checkRow({ id: '1', decision_venue: 'OKX' }), checkRow({ id: '2', decision_venue: 'OKX' }), checkRow({ id: '3', decision_venue: 'BYBIT' }),
    ]);
    const serve: LabelerDeps['candles'] = async (venue, ...rest) => { if (venue === 'OKX') throw new WeightBudgetSkipError('OKX', 5); return fullVenue()(venue, ...rest); };
    const r = await runLabeler(deps(db, serve), opt());
    expect([r.verdict, r.counts.deferred_budget, r.counts.labeled, [...db.outcomes.keys()]]).toEqual(['INDETERMINATE', 2, 1, [3]]);
  });

  it('no decision venue, or a venue outside the served-step table: unlabelable at once, with no fetch', async () => {
    const db = fakeDb([checkRow({ id: '1', decision_venue: null, checked_at: new Date(NOW - D) }), checkRow({ id: '2', decision_venue: 'NOWHERE' })]);
    const serve = vi.fn(fullVenue());
    const r = await runLabeler(deps(db, serve), opt());
    expect([r.verdict, r.counts.unlabelable, serve.mock.calls.length, r.firstLabeledAt]).toEqual(['PASS', 2, 0, null]);
    expect([outcomeOf(db, 1)?.reason, outcomeOf(db, 2)?.reason]).toEqual(['no decision venue', 'venue NOWHERE not in the served-step table']);
  });

  it('a broken window or a failed write is a FAIL; the time budget or a stop request is INDETERMINATE', async () => {
    const broken = fakeDb([checkRow()]);
    const r = await runLabeler(deps(broken, fullVenue((i) => (i === 3 ? [100, 99, 101, 100] : flat()))), opt());
    expect([r.verdict, r.counts.label_errors, broken.outcomes.size]).toEqual(['FAIL', 1, 0]);
    const writeFails = fakeDb([checkRow()], { failInsert: true });
    expect((await runLabeler(deps(writeFails, fullVenue()), opt())).verdict).toBe('FAIL');
    const late = fakeDb([checkRow()]);
    expect(await runLabeler(deps(late, fullVenue()), opt({ deadlineMs: NOW - 1 }))).toMatchObject({ verdict: 'INDETERMINATE', counts: { deferred_stop: 1 } });
    const stopped = fakeDb([checkRow()]);
    expect(await runLabeler(deps(stopped, fullVenue(), { stop: () => true }), opt())).toMatchObject({ verdict: 'INDETERMINATE', counts: { deferred_stop: 1 } });
  });

  it('an empty work-list is PASS with its size beside it; an unreadable one is INDETERMINATE, never PASS', async () => {
    expect(await runLabeler(deps(fakeDb([]), fullVenue()), opt())).toMatchObject({ verdict: 'PASS', counts: { worklist: 0 } });
    const down: LabelerDeps['query'] = async () => { throw new Error('relation "pre_trade_checks" does not exist'); };
    expect((await runLabeler({ ...deps(fakeDb([]), fullVenue()), query: down }, opt())).verdict).toBe('INDETERMINATE');
    // the owed read's grant failing is the first run's finding, never a read thirty days on
    const noGrant = fakeDb([checkRow()], { failGrant: true });
    const r = await runLabeler(deps(noGrant, fullVenue()), opt());
    expect([r.verdict, r.counts.worklist, noGrant.outcomes.size]).toEqual(['INDETERMINATE', 0, 0]);
    expect(r.reason).toMatch(/grant/);
  });

  it('toCheckRow reads pg\'s shapes: BIGINT text, a Date or ISO text, nullable numerics', () => {
    expect(toCheckRow(checkRow({ id: '42', checked_at: '2026-11-01T05:24:30.000Z', leverage: '20', stop_pct: null }))).toEqual({
      id: 42, checkedAtMs: Date.parse('2026-11-01T05:24:30Z'), coin: 'BTC', side: 'long', holdHours: 8, leverage: 20, stopPct: null, targetPct: 4, venue: 'BINANCE', liqDistancePct: null,
    });
  });
});

describe('main — the live wiring: dbQuery, the venue adapter paged forward, one token', () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { _resetGracefulStopForTest(); log = vi.spyOn(console, 'log').mockImplementation(() => {}); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); });
  afterEach(() => { log.mockRestore(); vi.useRealTimers(); });

  it('pages a 1 h hold forward through a 25-bar venue and prints PASS', async () => {
    const db = fakeDb([checkRow({ checked_at: new Date(NOW - 5 * H), hold_hours: 1 })]);
    fake.query = db.query;
    fake.candles = async (_coin, tf, start, end) => {
      expect([tf, typeof end]).toEqual(['1m', 'number']);   // a history read: never the serving branch
      return bars(start, 25, MIN, () => flat()).filter((b) => b.time <= (end as number));
    };
    expect(await main(['--max-checks', '5'])).toBe(0);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.startsWith('PRE_TRADE_OUTCOME_VERDICT='))).toEqual(['PRE_TRADE_OUTCOME_VERDICT=PASS']);
    expect(lines.find((l) => l.startsWith('PRE_TRADE_OUTCOME_COUNTS '))).toMatch(/"labeled":1.* first_labeled_at=2026-11-06T12:00:00\.000Z$/);
    expect(outcomeOf(db, 1)).toMatchObject({ status: 'labeled', interval: '1m', bracketFirst: 'timeout' });
  });
});

describe('AC3.2 — quarantine: one table written, and nothing public reads it', () => {
  const WRITE = /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(TABLE|INDEX)(\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE|MERGE\s+INTO|COPY)\s+("?[a-z_]+"?)/i;

  it('every statement a run issues writes only pre_trade_check_outcomes, and reads only the two tables', async () => {
    const db = fakeDb([checkRow({ id: '1' }), checkRow({ id: '2', decision_venue: null }), checkRow({ id: '3', checked_at: new Date(NOW - 9 * D) })]);
    await runLabeler(deps(db, async (...a) => (await fullVenue()(...a)).slice(1)), opt());
    expect(db.calls.length, 'a run must issue statements').toBeGreaterThan(3);
    for (const { sql } of db.calls) {
      const g = /^\s*(GRANT|REVOKE)\b/i.test(sql);
      if (g) expect(sql, 'the only grant is the owed read\'s SELECT on the outcome table').toBe('GRANT SELECT ON pre_trade_check_outcomes TO aoe_readonly');
      const w = WRITE.exec(sql);
      if (w) expect(w[w.length - 1].replace(/"/g, ''), sql.slice(0, 50)).toBe('pre_trade_check_outcomes');
      for (const t of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)) expect(['pre_trade_checks', 'pre_trade_check_outcomes']).toContain(t[1]);
    }
  });

  it('the module source: every write targets the outcome table, and no published table is named', () => {
    const writes = [...LABELER.matchAll(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\s+("?[a-z_]+"?)/g)].map((m) => m[2]);
    expect(writes.length, 'the scan must find the labeler\'s own writes').toBeGreaterThanOrEqual(2);
    for (const t of writes) expect(t).toBe('pre_trade_check_outcomes');
    for (const pub of ['signals', 'directional_labels', 'performance-public', 'performance_public', 'hold_decision_labels']) {
      expect(LABELER.replace(/^\s*(\*|\/\/).*$/gm, ''), pub).not.toMatch(new RegExp(`\\b${pub}\\b`));
    }
  });

  it('nothing else in src/ names pre_trade_check_outcomes — so no route, resource or tool can read it', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|js|mjs|cjs)$/.test(p)) files.push(p); } };
    walk(join(ROOT, 'src'));
    expect(files.length, 'the scan must have a corpus').toBeGreaterThan(100);
    const hits = files.filter((f) => /pre_trade_check_outcomes/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(ROOT.length + 1));
    expect(hits).toEqual(['src/scripts/pre-trade-outcome-labeler.ts']);
  });
});
