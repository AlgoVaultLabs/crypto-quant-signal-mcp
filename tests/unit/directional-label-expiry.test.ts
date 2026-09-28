// EDGE-ADS1-SCORECARD-W1-V2 CH2 R3 (ruling Q2 = A) — the expiry column's writers.
//
//  * expiryReturnPct: the W-th forward candle's close over the entry, PERCENT; NULL when the window is
//    short or had not closed when the candles were fetched — never a live price, never a guess.
//  * `--expiry-only`: a LABEL-INDEPENDENT worklist bounded by T_CAP (the race-end embargo), allow-listed
//    columns only, an UPDATE that never overwrites, rows past the measured candle depth skipped without
//    a fetch, and `--check` = zero writes. DB and adapter replaced at their seams.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const env = vi.hoisted(() => ({
  rows: [] as Array<{ id: number; created_at: number; price_at_signal: number }>,
  updates: [] as unknown[][],
  fetches: [] as Array<{ start: number; end?: number }>,
  candles: [] as Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>,
  emptyPageStarts: new Set<number>(),
  resets: [] as unknown[][],
}));
vi.mock('../../src/lib/performance-db.js', () => ({
  dbExec: () => undefined,
  dbQuery: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT DISTINCT s.id, s.created_at, s.price_at_signal')) return env.rows;
    if (sql.startsWith('SELECT count(*)::int AS n FROM directional_labels')) return [{ n: 7 }];
    if (sql.startsWith('UPDATE directional_labels SET ret_at_expiry_pct = NULL')) {
      env.resets.push(params);
      return Array.from({ length: 7 }, (_, i) => ({ signal_id: i }));
    }
    if (sql.startsWith('UPDATE directional_labels')) {
      env.updates.push(params);
      return (params[0] as number[]).flatMap((id) => [{ signal_id: id }, { signal_id: id }, { signal_id: id }]);
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  },
}));
vi.mock('../../src/lib/exchange-adapter.js', () => ({
  getAdapter: () => ({
    getCandles: async (_coin: string, _tf: string, start: number, _dex: unknown, end?: number) => {
      env.fetches.push({ start, end });
      if (env.emptyPageStarts.has(start)) { env.emptyPageStarts.delete(start); return []; } // one transient empty page
      return env.candles.filter((c) => c.time >= start && (end === undefined || c.time <= end)).slice(0, 1000);
    },
  }),
}));

import { expiryReturnPct, EVAL_CANDLES, TF_MS } from '../../src/scripts/directional-labeler.js';
import {
  EXPIRY_COLUMN_CREATED_AT,
  EXPIRY_RESET_SQL,
  expiryResetWindow,
  mainExpiryReset,
  parseCli,
  buildExpiryGroupsSql,
  buildExpiryRowsSql,
  EXPIRY_UPDATE_SQL,
  expiryReachDays,
  processExpiryGroup,
  tfValuesSql,
} from '../../src/scripts/backfill-directional-labels.js';

const H = 3_600_000;
const candle = (time: number, close: number) => ({ time, open: close, high: close * 1.001, low: close * 0.999, close, volume: 1 });

describe('expiryReturnPct', () => {
  const fwd = Array.from({ length: 10 }, (_, i) => candle(1_000 * H + i * H, 100 + i));
  it('is the W-th forward close over the entry, in percent', () => {
    expect(expiryReturnPct(fwd, 8, 100, 1_000 * H, H, 2_000 * H)).toBeCloseTo(7, 12);
  });
  it('is NULL when fewer than W forward candles are in hand', () => {
    expect(expiryReturnPct(fwd.slice(0, 7), 8, 100, 1_000 * H, H, 2_000 * H)).toBeNull();
  });
  it('is NULL when the window may not have closed before the fetch', () => {
    expect(expiryReturnPct(fwd, 8, 100, 1_000 * H, H, 1_000 * H + 8.9 * H)).toBeNull();
    expect(expiryReturnPct(fwd, 8, 100, 1_000 * H, H, 1_000 * H + 9 * H)).not.toBeNull();
  });
  it('is NULL when a candle inside the window is missing — never the close of a LATER candle', () => {
    const gapped = fwd.filter((c) => c.time !== 1_003 * H); // the 4th forward candle never arrived
    expect(gapped[7].close).toBe(108); // by index, the "8th" would be the 9th candle in time
    expect(expiryReturnPct(gapped, 8, 100, 1_000 * H, H, 2_000 * H)).toBeNull();
  });
  it('is NULL when the first candle in hand is not the first after the entry', () => {
    expect(expiryReturnPct(fwd.slice(1), 8, 100, 1_000 * H, H, 2_000 * H)).toBeNull();
    // an entry mid-candle: the first forward candle opens within one period after it, and that is fine
    expect(expiryReturnPct(fwd, 8, 100, 1_000 * H - 0.4 * H, H, 2_000 * H)).toBeCloseTo(7, 12);
  });
  it('is NULL on a non-positive entry or close', () => {
    expect(expiryReturnPct(fwd, 8, 0, 1_000 * H, H, 2_000 * H)).toBeNull();
    expect(expiryReturnPct([...fwd.slice(0, 7), candle(1_007 * H, 0)], 8, 100, 1_000 * H, H, 2_000 * H)).toBeNull();
  });
});

describe('--expiry-only CLI + SQL shape', () => {
  it('parses the mode and the pass selector; the nightly defaults are unchanged', () => {
    expect(parseCli([]).expiryOnly).toBe(false);
    const c = parseCli(['--expiry-only', '--since', '1788169595', '--venue', 'OKX', '--time-budget-min', '450']);
    expect(c).toMatchObject({ expiryOnly: true, since: 1788169595, venue: 'OKX', timeBudgetMin: 450 });
  });

  it('the group worklist is label-independent and bounded by T_CAP', () => {
    const { text, params } = buildExpiryGroupsSql({ since: 1788169595, venue: 'OKX' });
    expect(text).toContain('d.ret_at_expiry_pct IS NULL');
    expect(text).toContain('s.created_at <= 1790402400 AND s.created_at + (tf.w + 1) * tf.sec <= 1790402400');
    expect(text).toContain('s.created_at > 1788169595');
    expect(text).toMatch(/status = 'retired'/);
    expect(text).not.toMatch(/\bd\.label\b|\blabel\s*[=<>]/);
    expect(text).not.toMatch(/hold_decision|raw_final|outcome_return_pct/);
    expect(params).toEqual(['OKX']);
  });

  it('the row query selects only the allow-listed columns, under T_CAP', () => {
    const sql = buildExpiryRowsSql({ since: 5 });
    expect(sql).toMatch(/SELECT DISTINCT s\.id, s\.created_at, s\.price_at_signal FROM/);
    expect(sql).toContain('(tf.w + 1) * tf.sec <= 1790402400');
    expect(sql).not.toMatch(/\bd\.label\b|raw_final|hold_decision/);
  });

  it('the UPDATE never overwrites a stored expiry and never reads a label', () => {
    expect(EXPIRY_UPDATE_SQL).toContain('AND d.ret_at_expiry_pct IS NULL');
    expect(EXPIRY_UPDATE_SQL).not.toMatch(/\blabel\b/);
  });

  it('the timeframe table is EVAL_CANDLES / TF_MS, never retyped', () => {
    for (const t of Object.keys(EVAL_CANDLES)) expect(tfValuesSql()).toContain(`('${t}', ${TF_MS[t] / 1000}, ${EVAL_CANDLES[t]})`);
  });

  it('the measured reach table: HL 5m is 5,000 candles; an unlisted pair is deep', () => {
    expect(expiryReachDays('HL', '5m')).toBeCloseTo((5000 * 5) / 1440, 1);
    expect(expiryReachDays('BINANCE', '1h')).toBe(Infinity);
  });
});

describe('processExpiryGroup (DB + adapter at their seams)', () => {
  const NOW = 1_790_600_000_000; // ms, fixed; every row below is under T_CAP
  beforeEach(() => {
    env.rows = []; env.updates = []; env.fetches = []; env.emptyPageStarts.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });

  it('fills reachable rows from the forward window only, and skips rows past the measured depth', { timeout: 30_000 }, async () => {
    const tf = 300_000; // 5m, W = 12; HL 5m depth 17.36 d
    const recentEntry = Math.floor((NOW - 5 * 86_400_000) / tf) * tf;
    const oldEntry = Math.floor((NOW - 30 * 86_400_000) / tf) * tf;
    env.candles = Array.from({ length: 40 }, (_, i) => candle(recentEntry + i * tf, 200 + i));
    env.rows = [
      { id: 11, created_at: recentEntry / 1000, price_at_signal: 200 },
      { id: 22, created_at: oldEntry / 1000, price_at_signal: 50 },
    ];
    try {
      await processExpiryGroup(parseCli(['--expiry-only']), { exchange: 'HL', coin: 'BTC', timeframe: '5m' });
    } finally { vi.useRealTimers(); }
    expect(env.fetches.every((f) => f.start >= recentEntry)).toBe(true); // forward-only: no sigma history
    expect(env.fetches.length).toBeGreaterThan(0);
    expect(env.updates).toHaveLength(1);
    const [ids, rets] = env.updates[0] as [number[], number[]];
    expect(ids).toEqual([11]); // row 22 is past HL 5m's depth: skipped, never fetched
    expect(rets[0]).toBeCloseTo(((200 + 11) / 200 - 1) * 100, 12);
  });

  // The review's reproduction (2026-09-28): rows off the candle grid, spaced 1.5 periods apart. The old
  // extension start `coveredUntil + tf` skipped one candle per step and the third row got the close of the
  // 10th candle after its entry instead of the 8th.
  const T0 = 1_000 * H; // aligned
  const gridCandles = () => Array.from({ length: 60 }, (_, i) => candle(T0 + i * H, 1000 + i));
  const gridRows = () => [10.3, 11.8, 13.3].map((h, k) => ({ id: 100 + k, created_at: (T0 + h * H) / 1000, price_at_signal: 1000 }));
  const trueExpiry = (entryH: number) => ((1000 + Math.ceil(entryH) + 7) / 1000 - 1) * 100; // 8th candle after the entry

  it('off-grid rows spaced inside the window each get the TRUE W-th candle', { timeout: 30_000 }, async () => {
    env.candles = gridCandles();
    env.rows = gridRows();
    vi.setSystemTime(new Date(T0 + 500 * H));
    try {
      await processExpiryGroup(parseCli(['--expiry-only']), { exchange: 'BINANCE', coin: 'BTC', timeframe: '1h' });
    } finally { vi.useRealTimers(); }
    const [ids, rets] = env.updates[0] as [number[], number[]];
    expect(ids).toEqual([100, 101, 102]);
    [10.3, 11.8, 13.3].forEach((h, k) => expect(rets[k]).toBeCloseTo(trueExpiry(h), 12));
  });

  it('a transient empty page is fetched again for the next row, never left as a hole', { timeout: 30_000 }, async () => {
    env.candles = gridCandles();
    env.rows = gridRows();
    env.emptyPageStarts.add(T0 + 21 * H); // the second row's extension comes back empty once
    vi.setSystemTime(new Date(T0 + 500 * H));
    try {
      await processExpiryGroup(parseCli(['--expiry-only']), { exchange: 'BINANCE', coin: 'BTC', timeframe: '1h' });
    } finally { vi.useRealTimers(); }
    const [ids, rets] = env.updates[0] as [number[], number[]];
    expect(ids).toEqual([100, 101, 102]);
    [10.3, 11.8, 13.3].forEach((h, k) => expect(rets[k]).toBeCloseTo(trueExpiry(h), 12));
    expect(env.fetches.filter((f) => f.start === T0 + 21 * H)).toHaveLength(2); // retried, not skipped
  });

  it('a candle the venue never serves makes the affected rows NULL — never a later close', { timeout: 30_000 }, async () => {
    env.candles = gridCandles().filter((c) => c.time !== T0 + 16 * H); // inside all three windows
    env.rows = gridRows();
    vi.setSystemTime(new Date(T0 + 500 * H));
    try {
      await processExpiryGroup(parseCli(['--expiry-only']), { exchange: 'BINANCE', coin: 'BTC', timeframe: '1h' });
    } finally { vi.useRealTimers(); }
    expect(env.updates).toHaveLength(0); // nothing written: all three windows are missing a candle
  });

  it('--check reports and writes nothing', { timeout: 30_000 }, async () => {
    env.rows = [{ id: 11, created_at: Math.floor((NOW - 86_400_000) / 1000), price_at_signal: 1 }];
    try {
      await processExpiryGroup(parseCli(['--expiry-only', '--check']), { exchange: 'BINANCE', coin: 'BTC', timeframe: '1h' });
    } finally { vi.useRealTimers(); }
    expect(env.fetches).toHaveLength(0);
    expect(env.updates).toHaveLength(0);
  });
});

describe('the bounded blind reset of values written by the pre-fix code', () => {
  const NOW_S = EXPIRY_COLUMN_CREATED_AT + 86_400;
  it('touches only this column, only values written inside the window, and reads nothing', () => {
    expect(EXPIRY_RESET_SQL.startsWith('UPDATE directional_labels SET ret_at_expiry_pct = NULL WHERE ')).toBe(true);
    expect(EXPIRY_RESET_SQL).toContain('computed_at >= to_timestamp($1) AND computed_at < to_timestamp($2)');
    expect(EXPIRY_RESET_SQL).not.toMatch(/\blabel\b|barrier|created_at/);
    expect((EXPIRY_RESET_SQL.match(/SET/g) ?? []).length).toBe(1);
  });

  it('refuses a window that could reach anything but this wave\'s own writes', () => {
    const w = (from?: number, to?: number) => expiryResetWindow({ expiryResetFrom: from, expiryResetTo: to }, NOW_S);
    expect(w(EXPIRY_COLUMN_CREATED_AT, NOW_S)).toEqual([EXPIRY_COLUMN_CREATED_AT, NOW_S]);
    expect(() => w(EXPIRY_COLUMN_CREATED_AT, undefined)).toThrow(/BOTH/);
    expect(() => w(EXPIRY_COLUMN_CREATED_AT - 1, NOW_S)).toThrow(/before the column existed/);
    expect(() => w(NOW_S, EXPIRY_COLUMN_CREATED_AT)).toThrow(/inverted/);
    expect(() => w(EXPIRY_COLUMN_CREATED_AT, NOW_S + 60)).toThrow(/future/);
    expect(() => expiryResetWindow({ expiryResetFrom: EXPIRY_COLUMN_CREATED_AT, expiryResetTo: EXPIRY_COLUMN_CREATED_AT + 3 * 86_400 }, NOW_S + 3 * 86_400)).toThrow(/wider/);
  });

  it('--check counts and writes nothing; without it the one bounded UPDATE runs', { timeout: 30_000 }, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW_S * 1000));
    env.resets = [];
    const args = ['--expiry-only', '--expiry-reset-written-from', String(EXPIRY_COLUMN_CREATED_AT), '--expiry-reset-written-to', String(NOW_S - 60)];
    try {
      await mainExpiryReset(parseCli([...args, '--check']));
      expect(env.resets).toHaveLength(0);
      await mainExpiryReset(parseCli(args));
      expect(env.resets).toEqual([[EXPIRY_COLUMN_CREATED_AT, NOW_S - 60]]);
    } finally { vi.useRealTimers(); }
  });
});
