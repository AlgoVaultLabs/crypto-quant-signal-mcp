// tests/unit/regime-forward-inputs.test.ts — EDGE-REGIME-FORWARD-W1: what the read may load and what it may fetch.
//
// Each ordering claim of the registration is a refusal with a test here (arc lesson 6): only rule_version 2 rows,
// only the window's rows, no census-panel coin, no bar before not_before and none once the read is sealed. Each of
// those tests turns red when its rule is disabled by the test-only lever (REGIME_FORWARD_MUTATE=rule | window |
// panel | clock | postseal), which is how the tests are proven able to fail; the guard refuses a read while the
// lever is set. The pager, the reply classifier and the pacer are pure: they run here on a fake clock, and the one
// function that reaches a venue (restSource) is shown to refuse with fetch never called, on an injected clock.
// lesson 14: imported first — the homes resolve under the suite's own directory, fetch throws (isolate.ts)
import '../fixtures/regime-forward/isolate.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../../src/types.js';
import { FILES, NOT_BEFORE_MS, SNAP_COLS, TFS, VENUES, W0_MS, W1_MS, keyWin, originMs, tfMs, windowEndMs, type Venue } from '../../src/scripts/regime-forward/forward-spec.js';
import { SEAL, forwardHome } from '../../src/scripts/regime-forward/forward-guard.js';
import { PRIOR_LOOK_SHA256, findRecord, loadCalls, loadSnapshot, recordRefusal } from '../../src/scripts/regime-forward/snapshot.js';
import {
  BAN_BODY_CODES, BAN_STATUSES, BINANCE_WEIGHT_BUDGET, DEFAULT_RETRY_AFTER_MS, PACE_MS, PAGE_MAX, Pacer, RateLimitedError, RefusedError, UnreachedError, barsOf, binanceWeight,
  classify, guardedSource, klineUrl, networkRefusal, pacerOf, pagedFetch, pagesOf, restSource, rowsOf, spanOf, spanRefusal, type BarSource, type Reply, type Send,
} from '../../src/scripts/regime-forward/venue-bars.js';
import { buildKeyA } from '../../src/scripts/regime-diag/keys.js';
import { toBinanceSymbol } from '../../src/lib/adapters/binance.js';
import { toBybitSymbol } from '../../src/lib/adapters/bybit.js';
import { toOKXInstId } from '../../src/lib/adapters/okx.js';
import { toBitgetSymbol } from '../../src/lib/adapters/bitget.js';
import { CALL_COLS } from '../../src/scripts/regime-forward/forward-spec.js';
import { SYNTH_COINS, SYNTH_PANEL, priorLookSymbol, snapLine } from '../fixtures/regime-forward/synth.js';
import { SUITE_NOW, TEST_HOMEDIR } from '../fixtures/regime-forward/isolate.js';

/** Coin tokens come only from the synthetic generator (R6). */
const C1 = SYNTH_COINS[0], C2 = SYNTH_COINS[1];
const H = tfMs(TFS[0]);
const header = SNAP_COLS.join('|');
const row = (o: Partial<Parameters<typeof snapLine>[0]> = {}): string => snapLine({ venue: 'BINANCE', tf: '1h', coin: C1, bar: W0_MS + H, label: 1, conf: 50, ...o });

describe('the snapshot loader keeps only what the registration scores, and counts every drop by name', () => {
  it('a rule_version 1 row is dropped (rule)', () => {
    const l = loadSnapshot([header, row(), row({ coin: C2, rv: 1 })].join('\n'), new Set());
    expect(l.rows).toBe(1);
    expect(l.drops.rule_version).toBe(1);
    expect(l.coins.BINANCE).toEqual([C1]);
  });

  it('a row before W0, or past its timeframe\'s look-ahead, is dropped (window)', () => {
    const l = loadSnapshot([header, row(), row({ bar: W0_MS - H }), row({ bar: windowEndMs(TFS[0]) }), row({ tf: '1d', bar: windowEndMs(TFS[2]) - 86_400_000 })].join('\n'), new Set());
    expect(l.drops.outside_window).toBe(2);
    expect(l.rows).toBe(2);
  });

  it('a census-panel coin is dropped on every venue (panel)', () => {
    const lines = [header, ...(['BINANCE', 'BYBIT', 'OKX', 'BITGET'] as const).flatMap((v) => [row({ venue: v }), row({ venue: v, coin: SYNTH_PANEL })])];
    const l = loadSnapshot(lines.join('\n'), new Set([SYNTH_PANEL]));
    expect(l.drops.panel).toBe(4);
    expect(Object.values(l.coins).flat()).not.toContain(SYNTH_PANEL);
  });

  it('E12: the one symbol a mutation proof asked a venue for is dropped on every venue (prior_look), its calls too — matched by sha256', () => {
    const p = priorLookSymbol();
    expect(crypto.createHash('sha256').update(p).digest('hex')).toBe(PRIOR_LOOK_SHA256);
    const lines = [header, ...(['BINANCE', 'BYBIT', 'OKX', 'BITGET'] as const).flatMap((v) => [row({ venue: v }), row({ venue: v, coin: p })])];
    const l = loadSnapshot(lines.join('\n'), new Set());
    expect([l.drops.prior_look, l.rows]).toEqual([4, 4]);
    expect(Object.values(l.coins).flat()).not.toContain(p);
    const c = loadCalls([CALL_COLS.join('|'), `2026-11-20T01:00:00Z|BYBIT|1h|${p}|TRENDING_UP|BUY|paid|abc`].join('\n'), new Set());
    expect([c.calls.length, c.dropped]).toEqual([0, 1]);
  });

  it('other venues, other timeframes and malformed rows are dropped by name; a foreign header is refused', () => {
    const l = loadSnapshot([header, row({ venue: 'HYPERLIQUID' }), row({ tf: '15m' }), 'a|b', row({ coin: 'bad coin' })].join('\n'), new Set());
    expect([l.drops.other_venue, l.drops.other_timeframe, l.drops.bad_row, l.rows]).toEqual([1, 1, 2, 0]);
    expect(() => loadSnapshot(['exchange|coin', row()].join('\n'), new Set())).toThrow(/header/);
  });

  it('labelled calls are parsed, a panel coin\'s call dropped', () => {
    const c = loadCalls([CALL_COLS.join('|'), `2026-11-20T01:00:00Z|BINANCE|1h|${C1}|TRENDING_UP|BUY|paid|abc`, `2026-11-20T01:00:00Z|BINANCE|1h|${SYNTH_PANEL}|RANGING|HOLD|paid|abc`].join('\n'), new Set([SYNTH_PANEL]));
    expect(c.calls).toEqual([{ venue: 'BINANCE', t: 0, coin: C1, atMs: Date.parse('2026-11-20T01:00:00Z'), label: 1 }]);
    expect(c.dropped).toBe(1);
  });
});

describe('the host read\'s record binds the files the Mac scores', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-record-'));
  const files: Record<string, { sha256: string; bytes: number; rows: number }> = {};
  for (const f of FILES) { fs.writeFileSync(path.join(dir, f), `bytes of ${f}\n`); files[f] = { sha256: crypto.createHash('sha256').update(`bytes of ${f}\n`).digest('hex'), bytes: 0, rows: 0 }; }
  const rec = (verdict: string, at: string, host = 'signal-1'): string => JSON.stringify({ at, host, canary: 'owed_read', verdict, exit_code: 0, metrics: { read_id: 'regime-forward-30d', files } });

  it('the newest record of this read is taken; other reads and other canaries are ignored', () => {
    const jsonl = [rec('INDETERMINATE', '2026-12-30T08:27:00Z'), rec('PASS', '2026-12-30T09:27:00Z'), JSON.stringify({ at: '2026-12-31T00:00:00Z', canary: 'owed_read', verdict: 'FAIL', metrics: { read_id: 'other' } })].join('\n');
    expect(findRecord(jsonl)?.at).toBe('2026-12-30T09:27:00Z');
    expect(recordRefusal(findRecord(jsonl), dir)).toBeNull();
  });

  it('no record, a non-PASS record, another host, or a file that differs from the record is refused', () => {
    expect(recordRefusal(null, dir)).toMatch(/no owed_read record/);
    expect(recordRefusal(findRecord(rec('INDETERMINATE', '2026-12-30T08:27:00Z')), dir)).toMatch(/not PASS/);
    expect(recordRefusal(findRecord(rec('PASS', '2026-12-30T08:27:00Z', 'mac')), dir)).toMatch(/not signal-1/);
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-record-'));
    for (const f of FILES) fs.writeFileSync(path.join(d2, f), f === 'runs.psv' ? 'changed\n' : `bytes of ${f}\n`);
    expect(recordRefusal(findRecord(rec('PASS', '2026-12-30T08:27:00Z')), d2)).toMatch(/runs\.psv does not hash/);
  });
});

describe('the door in front of any source refuses before it calls (clock, panel, seal, span)', () => {
  const ok: Candle[] = [{ time: W0_MS, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
  const spy = (): { src: BarSource; calls: number[] } => { const calls: number[] = []; return { calls, src: async (_v, _c, _t, s) => { calls.push(s); return ok; } }; };
  const home = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'regime-forward-door-'));
  const span = spanOf('BINANCE', TFS[0]);

  it('before not_before no bar is fetched (clock)', async () => {
    const s = spy();
    await expect(guardedSource(s.src, () => NOT_BEFORE_MS - 1, new Set(), home())('BINANCE', C1, TFS[0], span.startMs, span.endMs)).rejects.toThrow(RefusedError);
    expect(s.calls).toEqual([]);
  });

  it('a census-panel coin is never fetched (panel)', async () => {
    const s = spy(), sp = spanOf('OKX', TFS[0]);
    await expect(guardedSource(s.src, () => NOT_BEFORE_MS, new Set([SYNTH_PANEL]), home())('OKX', SYNTH_PANEL, TFS[0], sp.startMs, sp.endMs)).rejects.toThrow(/census-panel/);
    expect(s.calls).toEqual([]);
  });

  it('F16: once the read\'s seal exists no bar is fetched, whatever the source (postseal)', async () => {
    const s = spy(), h = home();
    const g = guardedSource(s.src, () => NOT_BEFORE_MS, new Set(), h);
    expect(await g('BINANCE', C1, TFS[0], span.startMs, span.endMs)).toBe(ok);
    fs.writeFileSync(path.join(h, SEAL), '{}\n');
    await expect(g('BINANCE', C1, TFS[0], span.startMs, span.endMs)).rejects.toThrow(/once the read is sealed/);
    fs.rmSync(path.join(h, SEAL));
    fs.symlinkSync(path.join(h, 'nowhere'), path.join(h, SEAL)); // a dangling link at the name is a seal too
    await expect(g('BINANCE', C1, TFS[0], span.startMs, span.endMs)).rejects.toThrow(/once the read is sealed/);
    expect(s.calls).toEqual([span.startMs]);
  });

  it('F5: a range is judged on each bar, its open at the start and its close at the end of key A\'s span', async () => {
    const s = spy(), g = guardedSource(s.src, () => NOT_BEFORE_MS, new Set(), home());
    for (const v of VENUES) for (const tf of TFS) {
      const sp = spanOf(v, tf), I = tfMs(tf);
      await expect(g(v, C1, tf, sp.startMs - I, sp.endMs)).rejects.toThrow(/before key A's span/);
      await expect(g(v, C1, tf, sp.startMs, sp.endMs + 1)).rejects.toThrow(/after key A's span/);
      expect(await g(v, C1, tf, sp.startMs, sp.endMs)).toBe(ok);
    }
    // the old open-time rule would have admitted the daily bar that opens before W1 + 14 days and closes after it
    const d = spanOf('BINANCE', TFS[2]), I = tfMs(TFS[2]);
    expect(windowEndMs(TFS[2]) - d.endMs).toBeGreaterThan(0);
    expect(windowEndMs(TFS[2]) - d.endMs).toBeLessThan(I);
    expect(spanRefusal('BINANCE', TFS[2], d.startMs, windowEndMs(TFS[2]))).toMatch(/closes at 2026-12-31T00:00:00.000Z, after key A's span \(2026-12-30T08:00:00.000Z\)/);
    expect(s.calls).toHaveLength(VENUES.length * TFS.length);
  });

  it('key A\'s span is the bars `buildKeyA` reads: open at or after W0 − 14 bars, close at or before W1 + 14 bars', () => {
    for (const v of VENUES) for (const tf of TFS) {
      const s = spanOf(v, tf), I = tfMs(tf), o = originMs(v);
      expect(s.startMs).toBe(o + s.k0 * I);
      expect(s.startMs).toBeGreaterThanOrEqual(W0_MS - 14 * I);
      expect(s.startMs - I).toBeLessThan(W0_MS - 14 * I);
      expect(s.endMs).toBeLessThanOrEqual(windowEndMs(tf));
      expect(s.endMs + I).toBeGreaterThan(windowEndMs(tf));
      // buildKeyA over keyWin reads exactly k0 … nb − 1 of a full bar set
      const nb = Math.ceil((windowEndMs(tf) + I - o) / I), b = { min: tf.min, nb, O: new Float64Array(nb).fill(1), H: new Float64Array(nb).fill(1), L: new Float64Array(nb).fill(1), C: new Float64Array(nb).fill(1), V: new Float64Array(nb), cnt: new Int32Array(nb).fill(tf.min) };
      const ka = buildKeyA(b, tf, keyWin(v, tf));
      expect([ka.bars[0], ka.bars[ka.bars.length - 1] + 1]).toEqual([s.k0, s.nb]);
    }
    // on the hourly grids W0 and W1 are bar edges: the span is [W0 − 14 h, W1 + 14 h)
    expect(spanOf('OKX', TFS[0])).toMatchObject({ startMs: W0_MS - 14 * H, endMs: W1_MS + 14 * H });
  });
});

describe('the module\'s own network path refuses on its own (lesson 10, F2, F16)', () => {
  it('before not_before, and once sealed, nothing is asked; between the two every bar is', () => {
    const sealed = (): boolean => true, open = (): boolean => false;
    expect(networkRefusal(NOT_BEFORE_MS - 1, open)).toMatch(/before not_before/);
    expect(networkRefusal(NOT_BEFORE_MS - 1, sealed)).toMatch(/before not_before/);
    expect(networkRefusal(NOT_BEFORE_MS, sealed)).toMatch(/once the read is sealed/);
    expect(networkRefusal(NOT_BEFORE_MS, open)).toBeNull();
  });

  it('F2 (ZZ7a), R2: restSource takes nothing injected; before not_before and once sealed it is refused before fetch, whatever today is', async () => {
    expect(restSource.length).toBe(0);
    // fetch throws and the clock is set here: the result never depends on the real date (arc lesson 14)
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('no network in this test'); });
    const home = forwardHome(), seal = path.join(home, SEAL);
    expect(path.relative(TEST_HOMEDIR, home).startsWith('..')).toBe(false);
    try {
      vi.setSystemTime(NOT_BEFORE_MS - 1);
      for (const tf of TFS) {
        const sp = spanOf('BYBIT', tf);
        await expect(restSource()('BYBIT', C1, tf, sp.startMs, sp.endMs)).rejects.toThrow(/before not_before/);
      }
      vi.setSystemTime(NOT_BEFORE_MS + 1);
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(seal, '{}\n');
      for (const tf of TFS) {
        const sp = spanOf('BYBIT', tf);
        await expect(restSource()('BYBIT', C1, tf, sp.startMs, sp.endMs)).rejects.toThrow(/once the read is sealed/);
      }
      expect(f).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(seal, { force: true });
      vi.setSystemTime(SUITE_NOW);
      f.mockRestore();
    }
  });
});

describe('the venue requests and their replies', () => {
  it('each venue is asked for its own instrument and interval over the bars that open in [from, to], `limit` of them', () => {
    const from = W0_MS, to = W0_MS + 10 * H - 1;
    expect(klineUrl('BINANCE', C1, TFS[0], from, to, 10)).toBe(`https://fapi.binance.com/fapi/v1/klines?symbol=${toBinanceSymbol(C1)}&interval=1h&startTime=${from}&endTime=${to}&limit=10`);
    expect(klineUrl('BYBIT', C1, TFS[1], from, to, 10)).toBe(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${toBybitSymbol(C1)}&interval=240&start=${from}&end=${to}&limit=10`);
    expect(klineUrl('OKX', C1, TFS[2], from, to, 10)).toBe(`https://www.okx.com/api/v5/market/history-candles?instId=${toOKXInstId(C1)}&bar=1D&after=${to + 1}&before=${from - 1}&limit=10`);
    expect(klineUrl('BITGET', C1, TFS[0], from, to, 10)).toBe(`https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${toBitgetSymbol(C1)}&productType=USDT-FUTURES&granularity=1H&startTime=${from + H}&endTime=${to + H}&limit=10`);
  });

  it('F16: `limit` is the bars asked; a Binance request stays at weight 5 or less; pages cover the span once', () => {
    for (const v of VENUES) for (const tf of TFS) {
      const sp = spanOf(v, tf), I = tfMs(tf), pages = pagesOf(v, C1, tf, sp.startMs, sp.endMs);
      expect(pages.reduce((n, p) => n + p.limit, 0)).toBe(sp.nb - sp.k0);
      expect(pages.every((p) => p.limit === (p.to + 1 - p.from) / I && p.limit <= PAGE_MAX[v] && p.url.endsWith(`&limit=${p.limit}`))).toBe(true);
      expect(pages[0].from).toBe(sp.startMs);
      expect(pages[pages.length - 1].to).toBe(sp.endMs - 1);
      if (v === 'BINANCE') expect(pages.every((p) => p.weight === binanceWeight(p.limit) && p.weight <= 5)).toBe(true);
    }
    expect([binanceWeight(99), binanceWeight(100), binanceWeight(499), binanceWeight(500), binanceWeight(1000), binanceWeight(1001)]).toEqual([1, 2, 2, 5, 5, 10]);
  });

  it('an error reply throws; the four reply shapes give their rows', () => {
    expect(() => rowsOf('BINANCE', { code: -1121, msg: 'Invalid symbol.' })).toThrow(/BINANCE/);
    expect(() => rowsOf('BYBIT', { retCode: 10001, result: {} })).toThrow(/BYBIT/);
    expect(() => rowsOf('OKX', { code: '51001', data: [] })).toThrow(/OKX/);
    expect(rowsOf('BITGET', { code: '00000', data: [['1', '2']] })).toEqual([['1', '2']]);
    expect(rowsOf('BINANCE', [[1, '2']])).toEqual([[1, '2']]);
  });

  it('F16: a reply is rows, a rate limit (never retried), transient, or the venue\'s error answer', () => {
    const r = (status: number, text: string, retryAfter: string | null = null): Reply => ({ status, text, retryAfter });
    expect(classify('BINANCE', r(429, '{"code":-1003,"msg":"Too many requests"}', '30'))).toEqual({ kind: 'rate', retryAfterMs: 30_000, why: 'HTTP 429' });
    expect(classify('BINANCE', r(200, '{"code":-1003,"msg":"Too many requests"}'))).toMatchObject({ kind: 'rate', retryAfterMs: DEFAULT_RETRY_AFTER_MS });
    expect(classify('BINANCE', r(418, '{"code":-1003}', '120'))).toMatchObject({ kind: 'rate', retryAfterMs: 120_000 });
    expect(classify('BYBIT', r(403, 'access too frequent'))).toMatchObject({ kind: 'rate' });
    expect(classify('BITGET', r(200, '{"code":"45001","msg":"x"}'))).toMatchObject({ kind: 'rate' });
    expect(classify('OKX', r(502, '<html>bad gateway</html>'))).toMatchObject({ kind: 'transient' });
    expect(classify('OKX', r(503, '{"code":"50001"}'))).toMatchObject({ kind: 'transient' });
    expect(classify('BINANCE', r(400, '{"code":-1121,"msg":"Invalid symbol."}'))).toMatchObject({ kind: 'error' });
    expect(classify('BYBIT', r(200, '{"retCode":0,"result":{"list":[["1","2"]]}}'))).toEqual({ kind: 'rows', rows: [['1', '2']] });
  });

  it('the rate-limit answers are the registered ones (§3), read from no served file (RV1)', () => {
    expect(BAN_STATUSES).toEqual({ BINANCE: [418, 429], BYBIT: [403, 418, 429], OKX: [418, 429], BITGET: [418, 429] });
    expect(BAN_BODY_CODES).toEqual({ BINANCE: [-1003], BYBIT: [], OKX: [], BITGET: [45001, 40725, 40808] });
  });

  it('F16: a {"code":-1003} 429 stops the venue at once — one request, no retry — until its Retry-After', async () => {
    const clock = fakeClock(), sent: string[] = [];
    const sp = spanOf('BINANCE', TFS[0]);
    const send: Send = async (_v, u) => { sent.push(u); return { status: 429, retryAfter: '45', text: '{"code":-1003,"msg":"Too many requests"}' }; };
    const err = await pagedFetch('BINANCE', C1, TFS[0], sp.startMs, sp.endMs, send, pacerOf('BINANCE', clock.now, clock.sleep)).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect([err.venue, err.untilMs - clock.now()]).toEqual(['BINANCE', 45_000]);
    expect(sent).toHaveLength(1);
  });

  it('F16: three transient failures are an unreachable venue; three error answers are the venue\'s error', async () => {
    const clock = fakeClock(), sp = spanOf('OKX', TFS[2]);
    let n = 0;
    const down: Send = async () => { n++; throw new TypeError('fetch failed'); };
    await expect(pagedFetch('OKX', C1, TFS[2], sp.startMs, sp.endMs, down, pacerOf('OKX', clock.now, clock.sleep))).rejects.toBeInstanceOf(UnreachedError);
    expect(n).toBe(3);
    n = 0;
    const no: Send = async () => { n++; return { status: 200, retryAfter: null, text: '{"code":"51001","msg":"Instrument ID does not exist"}' }; };
    const e = await pagedFetch('OKX', C1, TFS[2], sp.startMs, sp.endMs, no, pacerOf('OKX', clock.now, clock.sleep)).catch((x) => x);
    expect([e instanceof UnreachedError, e instanceof RateLimitedError, String(e.message)]).toEqual([false, false, expect.stringContaining('51001')]);
    expect(n).toBe(3);
  });

  it('pages cover the span once, out-of-range and duplicate bars dropped, sorted', async () => {
    const clock = fakeClock(), urls: string[] = [];
    const send: Send = async (_v, u) => {
      urls.push(u);
      const q = new URL(u).searchParams, s = Number(q.get('start')), e = Number(q.get('end'));
      const list: string[][] = [];
      for (let t = s - H; t <= e + H; t += H) list.push([String(t), '1', '2', '0.5', '1.5', '10']);
      return { status: 200, retryAfter: null, text: JSON.stringify({ retCode: 0, result: { list: [...list, ...list].reverse() } }) };
    };
    const sp = spanOf('BYBIT', TFS[0]), got = await pagedFetch('BYBIT', C1, TFS[0], sp.startMs, sp.endMs, send, pacerOf('BYBIT', clock.now, clock.sleep));
    expect(got.length).toBe((sp.endMs - sp.startMs) / H);
    expect(got[0].time).toBe(sp.startMs);
    expect(got.every((c, i) => i === 0 || c.time === got[i - 1].time + H)).toBe(true);
    expect(urls.length).toBe(Math.ceil(got.length / 1000));
  });

  it('F16: Binance\'s pace keeps every 60 s within its declared weight budget, under the repo\'s 2,000 ceiling', async () => {
    expect(BINANCE_WEIGHT_BUDGET).toBeLessThan(2000); // §3: under the repository's ceiling of 2,000
    const clock = fakeClock(), pacer = pacerOf('BINANCE', clock.now, clock.sleep), sent: Array<{ t: number; w: number }> = [];
    // a synthetic load of 1,000 coins (no figure of this study), every request answered at once
    const weights = TFS.map((tf) => pagesOf('BINANCE', C1, tf, spanOf('BINANCE', tf).startMs, spanOf('BINANCE', tf).endMs).map((p) => p.weight)).flat();
    for (let coin = 0; coin < 1000; coin++) for (const w of weights) { await pacer.take(w); sent.push({ t: clock.now(), w }); }
    let lo = 0, sum = 0, max = 0;
    for (let i = 0; i < sent.length; i++) {
      sum += sent[i].w;
      while (sent[lo].t <= sent[i].t - 60_000) sum -= sent[lo++].w;
      max = Math.max(max, sum);
      if (i > 0) expect(sent[i].t - sent[i - 1].t).toBeGreaterThanOrEqual(PACE_MS.BINANCE);
    }
    expect(max).toBeLessThanOrEqual(BINANCE_WEIGHT_BUDGET);
    expect(max).toBeGreaterThan(BINANCE_WEIGHT_BUDGET * 0.5); // the budget binds, or the gap does: the test measured something
  });

  it('a tight budget is the binding pace: the weight in any 60 s never passes it', async () => {
    const clock = fakeClock(), pacer = new Pacer(0, 50, clock.now, clock.sleep), sent: Array<{ t: number; w: number }> = [];
    for (let i = 0; i < 200; i++) { await pacer.take(5); sent.push({ t: clock.now(), w: 5 }); }
    for (const e of sent) expect(sent.filter((x) => x.t > e.t - 60_000 && x.t <= e.t).reduce((s, x) => s + x.w, 0)).toBeLessThanOrEqual(50);
    expect(clock.now()).toBeGreaterThan(19 * 60_000);
  });

  it('bars sit on the venue grid; an unaligned bar, a bar still open at read time and a bad price are counted, never kept', () => {
    const v: Venue = 'OKX', I = tfMs(TFS[2]), o = originMs(v), k = Math.ceil((W0_MS - o) / I); // OKX daily bars open at 16:00Z
    const c = (time: number, close = 2): Candle => ({ time, open: 1, high: 3, low: 0.5, close, volume: 1 });
    const r = barsOf([c(o + k * I), c(o + k * I + 60_000), c(o + (k + 1) * I, Number.NaN), c(o + (k + 2) * I)], v, TFS[2], o + (k + 2) * I + I - 1);
    expect([r.bars.cnt[k], r.misaligned, r.bad, r.open]).toEqual([1440, 1, 1, 1]);
    expect(r.bars.C[k]).toBe(2);
    expect(Number.isInteger(k)).toBe(true);
    // a bar past key A's span is not a bar of the read
    expect(barsOf([c(spanOf(v, TFS[2]).endMs)], v, TFS[2], Number.MAX_SAFE_INTEGER).misaligned).toBe(1);
  });
});

/** A clock that only moves when the code under test sleeps: requests answered in zero time. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = NOT_BEFORE_MS;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}
