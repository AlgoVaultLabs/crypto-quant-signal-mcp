import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// EDGE-LABELER-RACE-WINDOW-V2-W1 CH3 — the historical `-v2` relabel and the `race_gap_candles` annotation.
// Drives the REAL processRelabelGroup / runAnnotation with the DB and the venue replaced at their seams. Every
// statement either issues is captured, so ADD-ONLY is asserted on what ran, not on what the code says it does
// (ruling LRW-Q7-C). Synthetic prices only.

type C = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Sig = { id: number; created_at: number; price_at_signal: number; signal: 'BUY' | 'SELL'; pfe_return_pct: number; mae_return_pct: number };

const env = vi.hoisted(() => ({
  signals: [] as Sig[],
  existing: [] as Array<{ signal_id: number; barrier_spec: string }>,
  candles: [] as C[],
  sql: [] as string[],
  inserted: [] as unknown[][],
  fetches: [] as number[], // real-time ms of each adapter call
  advanceMsOnFetch: 0, // moves the faked clock on every venue call (the in-group deadline tests)
  venueDown: false, // every market refused, the control too (a venue outage)
  controlDown: false, // the control (BTC 1h) alone refused
  flaky: {} as Record<string, string[]>, // coin → the errors its next calls throw, in order; served once spent
  refuseBeforeMs: undefined as number | undefined, // a page starting before this is refused (Gate's history limit)
  fetchLog: [] as string[], // coin:tf of each venue call
  fetchStarts: [] as number[], // the start of each venue call
  groupRows: [] as Array<Record<string, unknown>>, // what the group-list statement returns
  visits: [] as string[], // exchange:coin:timeframe of each group whose signals the relabel read, in order
  // annotation seams
  labelRows: [] as Array<{ t: string; signal_id: number; barrier_spec: string; gap: number | null }>,
  lockTimeout: '5s',
  updates: [] as Array<{ tids: string[]; gaps: number[] }>,
}));
vi.mock('../../src/lib/performance-db.js', () => ({
  dbExec: () => undefined,
  dbQuery: async (sql: string, params: unknown[] = []) => {
    env.sql.push(sql);
    if (sql.includes('FROM signals') && sql.includes('WHERE exchange = $1 AND coin = $2 AND timeframe = $3')) {
      env.visits.push(params.slice(0, 3).join(':'));
      return env.signals;
    }
    if (sql.startsWith('SELECT s.exchange, s.coin, s.timeframe, COUNT(*) AS todo')) return env.groupRows;
    if (sql.includes("FROM venues WHERE status = 'retired'")) return [];
    if (sql.includes('SELECT signal_id, barrier_spec FROM directional_labels')) {
      const [specs, ids] = params as [string[], number[]];
      return env.existing.filter((e) => specs.includes(e.barrier_spec) && ids.includes(e.signal_id));
    }
    if (sql.startsWith('INSERT INTO directional_labels')) {
      const cols = (sql.match(/\(([^)]*)\)\s*VALUES/) ?? ['', ''])[1].split(',').length;
      const rows: unknown[][] = [];
      for (let i = 0; i < params.length; i += cols) rows.push(params.slice(i, i + cols));
      env.inserted.push(...rows);
      return rows.map((r) => ({ signal_id: r[0] }));
    }
    if (sql.includes("current_setting('lock_timeout')")) return [{ v: env.lockTimeout }];
    if (sql.startsWith('SELECT ctid::text AS t')) {
      const [last, limit] = params as [string, number];
      const num = (t: string) => Number(t.slice(1, -1).split(',')[1]);
      return env.labelRows
        .filter((r) => r.gap === null && r.barrier_spec.endsWith('-v1') && num(r.t) > num(last))
        .sort((a, b) => num(a.t) - num(b.t))
        .slice(0, limit)
        .map(({ t, signal_id, barrier_spec }) => ({ t, signal_id: String(signal_id), barrier_spec }));
    }
    if (sql.startsWith('UPDATE directional_labels')) {
      const [tids, gaps] = params as [string[], number[]];
      env.updates.push({ tids: [...tids], gaps: [...gaps] });
      const out: unknown[] = [];
      tids.forEach((t, i) => {
        const row = env.labelRows.find((r) => r.t === t && r.gap === null && r.barrier_spec.endsWith('-v1'));
        if (row) { row.gap = gaps[i]; out.push(1); }
      });
      return out;
    }
    throw new Error(`unexpected SQL in the relabel suite: ${sql.slice(0, 80)}`);
  },
}));
vi.mock('../../src/lib/exchange-adapter.js', () => ({
  getAdapter: () => ({
    getCandles: async (coin: string, _tf: string, start: number, _dex: unknown, end?: number) => {
      env.fetches.push(performance.now());
      if (env.advanceMsOnFetch) vi.setSystemTime(Date.now() + env.advanceMsOnFetch);
      env.fetchLog.push(`${coin}:${_tf}`);
      env.fetchStarts.push(start);
      if (env.venueDown) throw new Error('503 Service Unavailable');
      if (env.controlDown && coin === 'BTC' && _tf === '1h') throw new Error('503 Service Unavailable');
      const queued = env.flaky[coin]?.shift();
      if (queued !== undefined) throw new Error(queued);
      if (env.refuseBeforeMs !== undefined && start < env.refuseBeforeMs) throw new Error('Gate API 400: Bad Request');
      if (coin === 'RATELIMITED') throw Object.assign(new Error('Venue API rate-limited (429)'), { code: 'UPSTREAM_RATE_LIMIT' });
      if (coin === 'DELISTED') throw new Error('400 Invalid symbol');
      return env.candles.filter((c) => c.time >= start && (end === undefined || c.time <= end)).slice(0, 1000);
    },
  }),
}));

import {
  processRelabelGroup, parseCli, INSERT_COLUMNS, _relabelCoverageForTest, setOwnRequestRate, setOwnDeadline,
  depthDeadlineOrder, HL_CANDLE_DEPTH, EXPIRY_REACH_DAYS, mainRelabel,
  runAnnotation, ANNOTATE_SELECT_SQL, ANNOTATE_UPDATE_SQL, RELABEL_INSERT_SQL_HEAD, RELABEL_INSERT_SQL_TAIL,
} from '../../src/scripts/backfill-directional-labels.js';
import { buildRelabelGroupsSql, buildRelabelMissingSql, relabelUntil } from '../../src/scripts/lrw/relabel-sql.js';
import { loadAnnotationSources, parseGapWorklists } from '../../src/scripts/lrw/annotation-sources.js';
import { T_CUT_EPOCH, ADAPTER_PENDING_CELLS, ADAPTER_CELL } from '../../src/scripts/lrw/registered.js';
import { BARRIER_SPECS, BARRIER_SPECS_V2, EVAL_CANDLES, TF_MS } from '../../src/scripts/directional-labeler.js';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const T = 497_000 * H; // 2026-09-12T08:00Z
const PX = 100;
const col = (n: (typeof INSERT_COLUMNS)[number]) => INSERT_COLUMNS.indexOf(n);
const V1 = new Set<string>(BARRIER_SPECS.map((s) => s.spec));
const V2 = new Set<string>(BARRIER_SPECS_V2.map((s) => s.spec));
const flat = (t: number): C => ({ time: t, open: PX, high: PX * 1.0005, low: PX * 0.9995, close: PX, volume: 1 });
const series = (from: number, to: number, step: number, at: (t: number) => C = flat) => {
  const out: C[] = [];
  for (let t = from; t <= to; t += step) out.push(at(t));
  return out;
};
const sig = (id: number, entryMs: number): Sig => ({ id, created_at: entryMs / 1000, price_at_signal: PX, signal: 'BUY', pfe_return_pct: 5, mae_return_pct: -5 });

async function relabel(g: { exchange: string; coin: string; timeframe: string }, argv: string[] = [], opts: { nowMs?: number; retired?: string[] } = {}) {
  env.sql.length = 0;
  env.inserted.length = 0;
  env.fetches.length = 0;
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
  const nowMs = opts.nowMs ?? T + 30 * D;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(nowMs));
  const c0 = _relabelCoverageForTest();
  try {
    await processRelabelGroup(parseCli(['--relabel-v2', ...argv]), g, { retired: new Set(opts.retired ?? []), nowMs });
  } finally {
    vi.useRealTimers();
    spy.mockRestore();
  }
  const c1 = _relabelCoverageForTest();
  const manifest = logs.filter((l) => l.startsWith('LRW_MANIFEST ')).map((l) => l.split(' ').slice(1));
  const classDelta: Record<string, number> = {};
  for (const [k, v] of Object.entries(c1.classes)) if (v - (c0.classes[k] ?? 0) > 0) classDelta[k] = v - (c0.classes[k] ?? 0);
  return {
    manifest, classDelta, written: c1.written - c0.written, wouldWrite: c1.wouldWrite - c0.wouldWrite, nonV2: c1.nonV2Refused - c0.nonV2Refused,
    errors: c1.errors - c0.errors, cutShort: c1.cutShort - c0.cutShort, unserved: c1.unservedGroups - c0.unservedGroups, logs,
  };
}
const writes = () => env.sql.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q));

beforeEach(() => {
  env.signals = [];
  env.existing = [];
  env.candles = [];
  env.advanceMsOnFetch = 0;
  setOwnRequestRate(undefined);
  setOwnDeadline(Infinity);
  env.venueDown = false;
  env.controlDown = false;
  env.flaky = {};
  env.refuseBeforeMs = undefined;
  env.fetchLog = [];
  env.fetchStarts = [];
  env.groupRows = [];
  env.visits = [];
});

describe('--relabel-v2 — ADD-ONLY, every eligible signal, every refusal counted', () => {
  it('writes the three -v2 rows for a signal with NO -v1 row (LRW-Q5 = B) and nothing else — no UPDATE, no DELETE, no -v1', async () => {
    const e = T + 17_000;
    env.signals = [sig(1, e)];
    env.candles = series(T - 600 * H, T + 20 * H, H); // ≥ 60·W + 1 contiguous served closes of σ history
    const r = await relabel({ exchange: 'BINANCE', coin: 'BTC', timeframe: '1h' });
    const v2 = env.inserted.filter((x) => V2.has(String(x[col('barrier_spec')])));
    expect(v2).toHaveLength(3);
    expect(env.inserted.filter((x) => V1.has(String(x[col('barrier_spec')])))).toHaveLength(0);
    for (const x of v2) {
      expect(x[col('race_gap_candles')]).toBe(0);
      expect(x[col('low_vol_history')]).toBe(false);
    }
    expect(writes().every((q) => q.startsWith(RELABEL_INSERT_SQL_HEAD) && q.endsWith(RELABEL_INSERT_SQL_TAIL))).toBe(true);
    expect(r.written).toBe(3);
    expect(r.nonV2).toBe(0);
  });

  it('write-once: an existing -v2 spec is never re-raced; a partial set is completed', async () => {
    const e = T + 17_000;
    env.signals = [sig(2, e), sig(3, e + H)];
    env.existing = [
      ...BARRIER_SPECS_V2.map((v) => ({ signal_id: 2, barrier_spec: v.spec })),
      { signal_id: 3, barrier_spec: 'tau1.0-floor0.30-v2' },
    ];
    env.candles = series(T - 600 * H, T + 20 * H, H);
    await relabel({ exchange: 'BINANCE', coin: 'BTC', timeframe: '1h' });
    expect(env.inserted.filter((x) => x[0] === 2)).toHaveLength(0);
    expect(env.inserted.filter((x) => x[0] === 3).map((x) => x[1]).sort()).toEqual(['tau0.5-floor0.30-v2', 'tau2.0-floor0.30-v2']);
  });

  it('every refusal is ONE manifest line with its registered class — a hole, a short history, an open window', async () => {
    const e1 = T + 17_000; // a hole inside its window → refused:gap
    const e2 = T + 300 * H + 17_000; // its σ history starts after a long gap → unreachable:history
    const e3 = T + 29 * D + 23 * H + 17_000; // its window is still open at "now" → deferred
    env.signals = [sig(11, e1), sig(12, e2), sig(13, e3)];
    env.candles = [
      ...series(T - 100 * H, T + 20 * H, H).filter((c) => c.time !== T + 4 * H),
      ...series(T + 290 * H, T + 320 * H, H),
      ...series(T + 29 * D - 100 * H, T + 30 * D, H),
    ];
    const r = await relabel({ exchange: 'BINANCE', coin: 'BTC', timeframe: '1h' });
    expect(Object.fromEntries(r.manifest.map(([id, cls]) => [id, cls]))).toEqual({ 11: 'refused:gap', 12: 'unreachable:history', 13: 'deferred' });
    expect(r.classDelta).toEqual({ 'refused:gap': 1, 'unreachable:history': 1, deferred: 1 });
    expect(env.inserted).toHaveLength(0);
  });

  it('classes decided WITHOUT a fetch: a retired venue, a window past the measured depth — and BITGET 2h/8h is ATTEMPTED since T_ADAPTER', async () => {
    env.signals = [sig(21, T + 17_000)];
    env.candles = series(T - 100 * H, T + 20 * H, H);
    const ret = await relabel({ exchange: 'BITMART', coin: 'BTC', timeframe: '1h' }, [], { retired: ['BITMART'] });
    expect(ret.manifest).toEqual([['21', 'unreachable:retired']]);
    // the pending set is the registration's — no flag opts a run into it or out of it. The amendment of 2026-10-01
    // (OPS-ADAPTER-HISTORY-ANCHOR-W1, OAH-Q8) EMPTIED it: from T_ADAPTER the relabel attempts the BITGET 2h/8h cell,
    // whose identity stays fixed (ADAPTER_CELL) for the table's cell assignment
    expect(ADAPTER_PENDING_CELLS.size).toBe(0);
    expect([...ADAPTER_CELL].sort()).toEqual(['BITGET:2h', 'BITGET:8h']);
    for (const tf of ['2h', '8h']) {
      const r = await relabel({ exchange: 'BITGET', coin: 'BTC', timeframe: tf });
      expect(r.manifest.some(([, cls]) => cls === 'unreachable:adapter-pending')).toBe(false);
      expect(env.fetches.length).toBeGreaterThan(0);
    }
    expect(() => parseCli(['--relabel-v2', '--adapter-pending', 'BITGET:2h'])).toThrow(/refused/);
    // a 3m GATE signal two years old is past the venue's measured candle depth
    env.signals = [sig(22, T - 730 * D + 17_000)];
    const deep = await relabel({ exchange: 'GATE', coin: 'BTC', timeframe: '3m' });
    expect(deep.manifest).toEqual([['22', 'unreachable:depth']]);
    expect(env.fetches).toHaveLength(0);
    // GATE's history floor would also stop that fetch, so the measured depth is proven on a venue that answers an
    // old range empty instead of refusing it: there the depth table alone saves the fetch
    env.signals = [sig(23, T - 730 * D + 17_000)];
    const deepXt = await relabel({ exchange: 'XT', coin: 'BTC', timeframe: '3m' });
    expect(deepXt.manifest).toEqual([['23', 'unreachable:depth']]);
    expect(env.fetches).toHaveLength(0);
  });

  it('--check counts what it would write and writes nothing', async () => {
    env.signals = [sig(31, T + 17_000), sig(32, T + H + 17_000)];
    env.existing = [{ signal_id: 32, barrier_spec: 'tau1.0-floor0.30-v2' }];
    env.candles = series(T - 100 * H, T + 20 * H, H);
    const r = await relabel({ exchange: 'BINANCE', coin: 'BTC', timeframe: '1h' }, ['--check']);
    expect(writes()).toHaveLength(0);
    expect(env.fetches).toHaveLength(0);
    expect(r.wouldWrite).toBe(5);
  });

  it('its OWN request ceiling (LRW-Q13): consecutive venue calls are spaced by 60 000 / --max-req-per-min ms', async () => {
    env.signals = [sig(41, T + 17_000), sig(42, T + 200 * H + 17_000)]; // two islands → ≥ 2 range fetches
    env.candles = series(T - 100 * H, T + 400 * H, H);
    // The interval must exceed the transport's own 250 ms inter-page sleep, or the assertion is vacuous: the
    // baseline run below proves calls land closer than 480 ms WITHOUT the ceiling.
    const gaps = () => env.fetches.slice(1).map((t, i) => t - env.fetches[i]);
    setOwnRequestRate(undefined);
    await relabel({ exchange: 'BINANCE', coin: 'BTC', timeframe: '1h' });
    expect(env.fetches.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...gaps())).toBeLessThan(480);
    setOwnRequestRate(120); // 500 ms
    await relabel({ exchange: 'BINANCE', coin: 'BTC', timeframe: '1h' });
    setOwnRequestRate(undefined);
    expect(env.fetches.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...gaps())).toBeGreaterThanOrEqual(480);
  }, 20_000);

  it('the group list is label-free, keyed on the -v2 specs of the run, and ends at T_CUT', () => {
    const { text, params } = buildRelabelGroupsSql({ v2Specs: BARRIER_SPECS_V2.map((v) => v.spec), since: 1788169595, until: relabelUntil(undefined), venue: 'OKX' });
    expect(params).toEqual([BARRIER_SPECS_V2.map((v) => v.spec), 3, 'OKX']);
    expect(text).toContain('s.created_at > 1788169595');
    expect(text).toContain(`s.created_at <= ${Math.floor(T_CUT_EPOCH)}`);
    for (const c of ['label', 'ambiguous_candle', 'barrier_pct', 'mfe_return_pct', 'mae_return_pct', 'ret_at_expiry_pct', 'outcome']) {
      expect(new RegExp(`\\b${c}\\b`).test(text)).toBe(false);
    }
    expect(EVAL_CANDLES['1h']).toBe(8);
  });

  it('the relabel never chases the live inflow: its population ends at T_CUT; --until may lower it, never raise it', () => {
    expect(relabelUntil(undefined)).toBe(Math.floor(T_CUT_EPOCH));
    expect(relabelUntil(1790000000)).toBe(1790000000);
    expect(() => relabelUntil(Math.floor(T_CUT_EPOCH) + 1)).toThrow(/above T_CUT/);
  });

  it('the completeness probe is the group list\'s own eligibility, inlined, over all three τ up to T_CUT', () => {
    const groups = buildRelabelGroupsSql({ v2Specs: BARRIER_SPECS_V2.map((v) => v.spec), until: relabelUntil(undefined) }).text;
    const probe = buildRelabelMissingSql();
    const whereOf = (sql: string) => sql.slice(sql.indexOf(' WHERE ') + 7, sql.search(/ (GROUP|ORDER) BY /));
    const inlined = whereOf(groups).replace('$1', `ARRAY[${BARRIER_SPECS_V2.map((v) => `'${v.spec}'`).join(', ')}]::text[]`).replace('$2', '3');
    expect(whereOf(probe)).toBe(inlined);
    expect(probe).toMatch(/^SELECT s\.id \|\| ',' \|\| s\.exchange \|\| ',' \|\| s\.timeframe FROM signals s WHERE /);
  });

  it('a market the venue refuses outright while it serves its control is unreachable:history — every todo signal, no error', async () => {
    env.signals = [sig(61, T + 17_000), sig(62, T + 300 * H + 17_000)];
    env.candles = series(T - 600 * H, T + 400 * H, H);
    const r = await relabel({ exchange: 'WHITEBIT', coin: 'DELISTED', timeframe: '1h' });
    expect(r.manifest).toEqual([['61', 'unreachable:history'], ['62', 'unreachable:history']]);
    expect([r.errors, r.written, r.unserved]).toEqual([0, 0, 1]);
    // the market's own recent page and the control (BTC 1h) were both asked
    expect(env.fetchLog).toContain('BTC:1h');
    expect(r.logs.filter((l) => l.startsWith('LRW_UNSERVED '))).toEqual(['LRW_UNSERVED WHITEBIT:DELISTED:1h Error:400 Invalid symbol']);
  });

  it('a venue that refuses its control too is an outage, never a class: the signals stay counted errors', async () => {
    env.signals = [sig(63, T + 17_000), sig(64, T + 300 * H + 17_000)];
    env.candles = series(T - 600 * H, T + 400 * H, H);
    env.venueDown = true;
    const r = await relabel({ exchange: 'WHITEBIT', coin: 'DELISTED', timeframe: '1h' });
    expect([r.errors, r.written, r.unserved, r.manifest.length]).toEqual([2, 0, 0, 0]);
    expect(r.logs.filter((l) => l.startsWith('LRW_ERROR '))).toEqual(['LRW_ERROR WHITEBIT:DELISTED:1h Error:503 Service Unavailable']);
  });

  it('a rate limit is never a class and never triggers the market probe', async () => {
    env.signals = [sig(65, T + 17_000)];
    env.candles = series(T - 600 * H, T + 20 * H, H);
    const r = await relabel({ exchange: 'BINGX', coin: 'RATELIMITED', timeframe: '1h' });
    expect([r.errors, r.unserved, r.manifest.length]).toEqual([1, 0, 0]);
    expect(env.fetchLog.includes('BTC:1h')).toBe(false);
    expect(r.logs.filter((l) => l.startsWith('LRW_ERROR '))).toEqual(['LRW_ERROR BINGX:RATELIMITED:1h UPSTREAM_RATE_LIMIT']);
  });

  it('a refusal that does not repeat after the control is served is transient: counted, never a class (night 2: Bybit 10006)', async () => {
    env.signals = [sig(66, T + 17_000)];
    env.candles = series(T - 600 * H, T + 20 * H, H);
    // the fetch and the first probe hit a rate limit the adapter does not type; the control is served; the repeat is served
    env.flaky = { ZEC: ['Bybit API error 10006: Too many visits.', 'Bybit API error 10006: Too many visits.'] };
    const r = await relabel({ exchange: 'BYBIT', coin: 'ZEC', timeframe: '1h' });
    expect([r.errors, r.unserved, r.manifest.length, r.written]).toEqual([1, 0, 0, 0]);
    expect(env.fetchLog).toEqual(['ZEC:1h', 'ZEC:1h', 'BTC:1h', 'ZEC:1h']); // market, market, control, market again
    expect(r.logs.filter((l) => l.startsWith('LRW_ERROR '))).toEqual(['LRW_ERROR BYBIT:ZEC:1h Error:Bybit API error 10006: Too many visits.']);
    // a repeat refused with ANOTHER key is no stable refusal either
    env.flaky = { ZEC: ['500 Internal Server Error', 'Bybit API error 10006: Too many visits.', '502 Bad Gateway'] };
    env.fetchLog = [];
    const k = await relabel({ exchange: 'BYBIT', coin: 'ZEC', timeframe: '1h' });
    expect([k.errors, k.unserved, k.manifest.length]).toEqual([1, 0, 0]);
    expect(env.fetchLog).toEqual(['ZEC:1h', 'ZEC:1h', 'BTC:1h', 'ZEC:1h']);
  });

  it('the control is asked afresh for every refused market — never a remembered answer', async () => {
    env.signals = [sig(67, T + 17_000)];
    env.candles = series(T - 600 * H, T + 20 * H, H);
    const a = await relabel({ exchange: 'WHITEBIT', coin: 'DELISTED', timeframe: '1h' });
    expect([a.unserved, a.errors]).toEqual([1, 0]);
    env.controlDown = true; // seconds later the venue stops serving its control: the next refusal is no class
    const b = await relabel({ exchange: 'WHITEBIT', coin: 'DELISTED', timeframe: '4h' });
    expect([b.unserved, b.errors, b.manifest.length]).toEqual([0, 1, 0]);
    expect(env.fetchLog.filter((x) => x === 'BTC:1h')).toHaveLength(2);
  });

  it('a venue that REFUSES pages past its history limit (Gate, 10 000 candles) is asked no further back: σ from what it serves, never an error', async () => {
    const S = 15 * M;
    const W = EVAL_CANDLES['15m'];
    const nowMs = T + 30 * D;
    env.refuseBeforeMs = nowMs - 10_000 * S; // the venue's own rule, measured 2026-10-04
    const L = env.refuseBeforeMs;
    // id 91: 20·W candles after the limit → fewer than 30 σ windows served → unreachable:history (no error)
    // id 92: 40·W candles after the limit → ≥ 30 windows (fewer than 60) → raced on what the venue serves
    env.signals = [sig(91, L + 20 * W * S + 17_000), sig(92, L + 40 * W * S + 17_000)];
    env.candles = series(L - 1_000 * S, L + 60 * W * S, S);
    const r = await relabel({ exchange: 'GATE', coin: 'BTC', timeframe: '15m' }, [], { nowMs });
    expect([r.errors, r.unserved, r.written]).toEqual([0, 0, 3]);
    expect(r.manifest).toEqual([['91', 'unreachable:history']]);
    expect(env.inserted.every((x) => x[0] === 92)).toBe(true);
    expect(env.fetchStarts.length).toBeGreaterThan(0);
    expect(env.fetchStarts.every((s) => s >= L)).toBe(true);
  }, 20_000);

  it('HL depth-deadline order (LRW-Q17 rider 1): time-to-depth-loss ascending, fully-lost groups first, ties keep horizon-first; HL only', () => {
    expect(parseCli(['--relabel-v2', '--venue', 'HL', '--order', 'depth-deadline']).order).toBe('depth-deadline');
    expect(parseCli(['--relabel-v2', '--venue', 'HL']).order).toBeUndefined();
    expect(() => parseCli(['--relabel-v2', '--venue', 'MEXC', '--order', 'depth-deadline'])).toThrow(/needs --venue HL/);
    expect(() => parseCli(['--relabel-v2', '--order', 'depth-deadline'])).toThrow(/needs --venue HL/);
    expect(() => parseCli(['--relabel-v2', '--venue', 'HL', '--order', 'oldest-first'])).toThrow(/unknown --order/);
    const nowS = 1_791_000_000;
    const DS = 86_400;
    const stepS = (tf: string) => TF_MS[tf] / 1000;
    // arriving in horizon-first order (oldest first); deadlines: 1d far off, 5m in 0.36 d, 15m in 2.08 d (twice)
    const g = (id: string, timeframe: string, atRiskOldest: number | null) => ({ id, timeframe, atRiskOldest });
    const listed = [
      g('A', '1d', nowS - 100 * DS), g('C', '15m', nowS - 50 * DS), g('E', '15m', nowS - 50 * DS),
      g('B', '5m', nowS - 17 * DS), g('D', '5m', null),
    ];
    expect(depthDeadlineOrder(listed, nowS, stepS).map((x) => x.id)).toEqual(['D', 'B', 'C', 'E', 'A']);
    expect(listed.map((x) => x.id)).toEqual(['A', 'C', 'E', 'B', 'D']); // the input is not reordered in place
    // the order's depth and the measured HL depth table are ONE number: 5,000 candles × the step
    for (const [tf, days] of Object.entries(EXPIRY_REACH_DAYS.HL)) {
      expect(Math.abs(days - (HL_CANDLE_DEPTH * TF_MS[tf]) / 86_400_000)).toBeLessThan(0.01);
    }
  });

  it('a run APPLIES the order: HL groups are visited deadline-first with --order depth-deadline, as listed (horizon-first) without it', async () => {
    const nowMs = T + 30 * D;
    const nowS = nowMs / 1000;
    const DS = 86_400;
    // the group statement's answer, horizon-first (oldest first): A 1d, C 15m, D 5m (every row past depth), B 5m
    env.groupRows = [
      { exchange: 'HL', coin: 'A', timeframe: '1d', todo: '3', oldest: nowS - 100 * DS, at_risk_oldest: nowS - 100 * DS },
      { exchange: 'HL', coin: 'C', timeframe: '15m', todo: '2', oldest: nowS - 60 * DS, at_risk_oldest: nowS - 50 * DS },
      { exchange: 'HL', coin: 'D', timeframe: '5m', todo: '4', oldest: nowS - 30 * DS, at_risk_oldest: null },
      { exchange: 'HL', coin: 'B', timeframe: '5m', todo: '1', oldest: nowS - 17 * DS, at_risk_oldest: nowS - 17 * DS },
    ];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(nowMs));
    try {
      await mainRelabel(parseCli(['--relabel-v2', '--venue', 'HL', '--order', 'depth-deadline']));
      expect(env.visits).toEqual(['HL:D:5m', 'HL:B:5m', 'HL:C:15m', 'HL:A:1d']);
      expect(env.sql.some((q) => q.includes('AS at_risk_oldest'))).toBe(true);
      env.visits = [];
      env.sql.length = 0;
      await mainRelabel(parseCli(['--relabel-v2', '--venue', 'HL']));
      expect(env.visits).toEqual(['HL:A:1d', 'HL:C:15m', 'HL:D:5m', 'HL:B:5m']);
      expect(env.sql.some((q) => q.includes('AS at_risk_oldest'))).toBe(false);
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });

  it('the group list\'s at-risk column leaves the eligibility untouched (the completeness probe still reads the same WHERE)', () => {
    const base = { v2Specs: BARRIER_SPECS_V2.map((v) => v.spec), until: relabelUntil(undefined), venue: 'HL' };
    const plain = buildRelabelGroupsSql(base);
    const ranked = buildRelabelGroupsSql({ ...base, atRiskAfter: { '5m': 1_789_500_000, '15m': 1_786_500_000 } });
    const whereOf = (sql: string) => sql.slice(sql.indexOf(' WHERE ') + 7, sql.search(/ (GROUP|ORDER) BY /));
    expect(whereOf(ranked.text)).toBe(whereOf(plain.text));
    expect(ranked.params).toEqual(plain.params);
    expect(plain.text).not.toContain('at_risk_oldest');
    expect(ranked.text).toContain("MIN(s.created_at) FILTER (WHERE s.created_at > CASE s.timeframe WHEN '5m' THEN 1789500000 WHEN '15m' THEN 1786500000 ELSE 0 END) AS at_risk_oldest");
  });

  it('the hard stop acts INSIDE a group: rows raced before it are written, the rest is the next pass\'s (counted cutShort)', async () => {
    env.signals = [sig(71, T + 17_000), sig(72, T + 200 * H + 17_000)]; // two islands: the second needs its own fetch
    env.candles = series(T - 600 * H, T + 400 * H, H);
    env.advanceMsOnFetch = 2_000;
    setOwnDeadline(T + 30 * D + 1_000); // the helper's clock: passed by the first fetch
    const r = await relabel({ exchange: 'BINANCE', coin: 'BTC', timeframe: '1h' });
    expect(r.cutShort).toBe(1);
    expect(r.written).toBe(3);
    expect(env.inserted.every((x) => x[0] === 71)).toBe(true);
    expect(r.manifest).toEqual([]);
  });
});

describe('--annotate-gaps — one column, -v1 only, NULL only, totals only', () => {
  const wl = (rows: string[]) => ['signal_id,barrier_spec,gap_served_L,sigma_holes_L', ...rows].join('\n');

  it('the worklists are keyed (signal_id, barrier_spec) and refuse a non -v1 row, a non-integer gap, or two files that disagree', () => {
    const m = parseGapWorklists([{ name: 'a', csv: wl(['5,tau1.0-floor0.30-v1,3,0', '5,tau0.5-floor0.30-v1,0,1']) }, { name: 'b', csv: wl(['6,tau2.0-floor0.30-v1,12,0']) }]);
    expect([...m.entries()]).toEqual([['5|tau1.0-floor0.30-v1', 3], ['5|tau0.5-floor0.30-v1', 0], ['6|tau2.0-floor0.30-v1', 12]]);
    expect(() => parseGapWorklists([{ name: 'v2', csv: wl(['5,tau1.0-floor0.30-v2,0,0']) }])).toThrow(/non -v1/);
    expect(() => parseGapWorklists([{ name: 'x', csv: wl(['5,tau1.0-floor0.30-v1,1.5,0']) }])).toThrow(/SMALLINT/);
    expect(() => parseGapWorklists([{ name: 'a', csv: wl(['5,tau1.0-floor0.30-v1,3,0']) }, { name: 'b', csv: wl(['5,tau1.0-floor0.30-v1,4,0']) }])).toThrow(/disagrees/);
    expect(() => parseGapWorklists([{ name: 'h', csv: 'id,spec,gap\n1,x,0' }])).toThrow(/header/);
  });

  it('pages by ctid, writes only matched NULL -v1 rows, counts the rest, and a re-run (or --check after it) writes 0', async () => {
    env.labelRows = [];
    for (let i = 1; i <= 23; i++) {
      env.labelRows.push({ t: `(0,${i})`, signal_id: 100 + i, barrier_spec: i % 2 ? 'tau1.0-floor0.30-v1' : 'tau1.0-floor0.30-v2', gap: i === 7 ? 4 : null });
    }
    const gaps = new Map<string, number>();
    for (let i = 1; i <= 23; i += 2) if (i !== 9) gaps.set(`${100 + i}|tau1.0-floor0.30-v1`, i % 5);
    env.updates.length = 0;
    const a = await runAnnotation(gaps, { batch: 5, check: false });
    expect(a.annotated).toBe(10); // 12 odd rows − #7 (already set) − #9 (not in the worklist)
    expect(a.unmatched).toBe(1);
    expect(env.labelRows.filter((r) => r.barrier_spec.endsWith('-v2')).every((r) => r.gap === null)).toBe(true);
    expect(env.labelRows.find((r) => r.t === '(0,7)')!.gap).toBe(4); // never overwritten
    expect(env.updates.every((u) => u.tids.length <= 5)).toBe(true);
    env.updates.length = 0;
    const again = await runAnnotation(gaps, { batch: 5, check: false });
    expect(again.annotated).toBe(0);
    const check = await runAnnotation(gaps, { batch: 5, check: true });
    expect([check.wouldAnnotate, env.updates.length]).toEqual([0, 0]);
  });

  it('reports complete only when the ctid scan reached the end — a deadline leaves outcome global-budget', async () => {
    env.labelRows = [{ t: '(0,1)', signal_id: 1, barrier_spec: 'tau1.0-floor0.30-v1', gap: null }];
    expect((await runAnnotation(new Map(), { batch: 2000, check: true })).outcome).toBe('complete');
    const cut = await runAnnotation(new Map(), { batch: 2000, check: true, deadlineMs: Date.now() - 1 });
    expect([cut.outcome, cut.scanned]).toEqual(['global-budget', 0]);
  });

  it('writes only from the two pinned files: any other worklist is refused by sha256 before a row is read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lrw-ann-'));
    const p = join(dir, 'race-gap-worklist.csv.gz');
    writeFileSync(p, gzipSync('signal_id,barrier_spec,gap_served_L\n1,tau1.0-floor0.30-v1,0\n'));
    expect(() => loadAnnotationSources([p])).toThrow(/not a pinned annotation source/);
    expect(() => loadAnnotationSources([])).toThrow(/names no file/);
  });

  it('refuses to write without lock_timeout = 5s (LRW-Q13), and --check needs no setting', async () => {
    env.lockTimeout = '0';
    env.labelRows = [{ t: '(0,1)', signal_id: 1, barrier_spec: 'tau1.0-floor0.30-v1', gap: null }];
    await expect(runAnnotation(new Map([['1|tau1.0-floor0.30-v1', 2]]), { batch: 2000, check: false })).rejects.toThrow(/lock_timeout/);
    const c = await runAnnotation(new Map([['1|tau1.0-floor0.30-v1', 2]]), { batch: 2000, check: true });
    expect(c.wouldAnnotate).toBe(1);
    env.lockTimeout = '5s';
  });

  it('LRW-Q7-C static assertion: the annotation SETs race_gap_candles alone; no -v1 label column, never computed_at, -v1 + NULL only', () => {
    const set = ANNOTATE_UPDATE_SQL.slice(ANNOTATE_UPDATE_SQL.indexOf(' SET '), ANNOTATE_UPDATE_SQL.indexOf(' FROM '));
    expect(set).toBe(' SET race_gap_candles = v.gap');
    for (const sql of [ANNOTATE_SELECT_SQL, ANNOTATE_UPDATE_SQL]) {
      for (const c of ['label', 'ambiguous_candle', 'low_vol_history', 't_hit_candles', 'mfe_return_pct', 'mae_return_pct', 'barrier_pct', 'ret_at_expiry_pct', 'computed_at']) {
        expect(new RegExp(`\\b${c}\\b`).test(sql)).toBe(false);
      }
      expect(sql).toContain('race_gap_candles IS NULL');
      expect(sql).toContain("('tau0.5-floor0.30-v1', 'tau1.0-floor0.30-v1', 'tau2.0-floor0.30-v1')");
    }
    // and in the source: the relabel / annotation code issues no UPDATE / DELETE but the one pinned statement
    const src = readFileSync('src/scripts/backfill-directional-labels.ts', 'utf8');
    const ch3 = src.slice(src.indexOf('EDGE-LABELER-RACE-WINDOW-V2-W1 CH3 — the historical'), src.indexOf('async function mainAnnotate'));
    expect((ch3.match(/UPDATE directional_labels/g) ?? []).length).toBe(1); // ANNOTATE_UPDATE_SQL, nothing else
    expect(/DELETE FROM|TRUNCATE/i.test(ch3)).toBe(false);
    expect(RELABEL_INSERT_SQL_TAIL).toContain('ON CONFLICT (signal_id, barrier_spec) DO NOTHING');
  });
});
