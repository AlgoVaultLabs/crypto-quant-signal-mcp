// tests/unit/regime-15m-venues.test.ts — EDGE-REGIME-15M-BACKTEST-W1 item 6 (PROCEDURE §4e): the check venues' bars.
// The fetcher against a fake venue (no network: the suite's fetch throws), the stored-bar loader, and the Binance
// twin at a venue's resolution. Synthetic bars only.
import '../fixtures/regime-15m/isolate.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { aggregate, emptyGrid, finishGrid, type Grid } from '../../src/scripts/regime-diag/archive.js';
import { MIN_MS, type Span } from '../../src/scripts/regime-diag/diag-spec.js';
import {
  NOT_LISTED_CODES, Pacer, VenueAnswerError, classify, fetchCheck, fetchCoin, fetchRefusal, firstDayOf, getPage, klineUrl, pagesOf, venueSymbol, type Reply, type Send, type Tally,
} from '../../src/scripts/regime-15m/r15-fetch.js';
import { CHECK_MANIFEST, CHECK_VENUES, SEAL_DIR, SEAL_FILE, STUDY_SPAN, WINDOW_END_MS, type CheckVenue } from '../../src/scripts/regime-15m/r15-spec.js';
import { checkDirOf, coinRecordOf, loadCheckGrid, replicate, twinGrid, type CheckManifest } from '../../src/scripts/regime-15m/r15-venues.js';

const DAY = 86_400_000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regime-15m-venues-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const sha = (s: string | Buffer): string => crypto.createHash('sha256').update(s).digest('hex');
const ivMin = (iv: string): number => ({ '1': 1, '3': 3, D: 1440, '1m': 1, '3m': 3, '1Dutc': 1440 } as Record<string, number>)[iv];

interface FakeCoin { status: 'listed' | 'not_listed' | 'none'; fromMs?: number }
/** A venue that answers like the real three: Bybit and OKX newest bar first, Bitget oldest first and filtered on the close. */
function fakeVenue(coins: Record<string, FakeCoin>, calls: string[] = []): Send {
  return async (url) => {
    calls.push(url);
    const u = new URL(url), q = u.searchParams;
    let v: CheckVenue, sym: string, iv: string, from: number, to: number;
    const limit = Number(q.get('limit'));
    if (u.host === 'api.bybit.com') { v = 'BYBIT'; sym = q.get('symbol') as string; iv = q.get('interval') as string; from = Number(q.get('start')); to = Number(q.get('end')); }
    else if (u.host === 'www.okx.com') { v = 'OKX'; sym = q.get('instId') as string; iv = q.get('bar') as string; to = Number(q.get('after')) - 1; from = Number(q.get('before')) + 1; }
    else { v = 'BITGET'; sym = q.get('symbol') as string; iv = q.get('granularity') as string; const I = ivMin(iv) * MIN_MS; from = Number(q.get('startTime')) - I; to = Number(q.get('endTime')) - I; }
    const coin = sym.replace('-USDT-SWAP', '').replace(/USDT$/, ''), c = coins[coin];
    if (!c || c.status === 'not_listed') {
      const body = v === 'BYBIT' ? { retCode: 10001, retMsg: 'params error: symbol invalid' } : v === 'OKX' ? { code: '51001', msg: 'Instrument ID does not exist' } : { code: '40034', msg: 'Parameter does not exist' };
      return { status: v === 'BYBIT' ? 200 : 400, retryAfter: null, text: JSON.stringify(body) };
    }
    const I = ivMin(iv) * MIN_MS, rows: string[][] = [];
    if (c.status === 'listed') for (let t = Math.ceil(Math.max(from, c.fromMs ?? 0) / I) * I; t <= to && rows.length < limit; t += I) rows.push([String(t), '1.5', '2', '1', '1.75', '10', '0', '0', '1']);
    if (v !== 'BITGET') rows.reverse();
    const body = v === 'BYBIT' ? { retCode: 0, result: { list: rows } } : { code: v === 'OKX' ? '0' : '00000', data: rows };
    return { status: 200, retryAfter: null, text: JSON.stringify(body) };
  };
}
const noSleep = async (): Promise<void> => undefined;
const clock = (): (() => number) => { let t = 0; return () => (t += 1); };
const pacer = (): Pacer => new Pacer(0, clock(), noSleep);
const tally = (): Tally => ({ requests: 0, throttled: 0, transient: 0 });

describe('regime-15m: the check fetch, against a fake venue', () => {
  it('asks each venue for exactly the bars that open in a page, at most its page size', () => {
    expect([venueSymbol('BYBIT', 'AAA'), venueSymbol('OKX', 'AAA'), venueSymbol('BITGET', 'AAA')]).toEqual(['AAAUSDT', 'AAA-USDT-SWAP', 'AAAUSDT']);
    const t = STUDY_SPAN.t0Ms;
    expect(klineUrl('BYBIT', 'AAA', 1, t, t + 59_999, 1)).toBe(`https://api.bybit.com/v5/market/kline?category=linear&symbol=AAAUSDT&interval=1&start=${t}&end=${t + 59_999}&limit=1`);
    expect(klineUrl('OKX', 'AAA', 3, t, t + 179_999, 1)).toBe(`https://www.okx.com/api/v5/market/history-candles?instId=AAA-USDT-SWAP&bar=3m&after=${t + 180_000}&before=${t - 1}&limit=1`);
    expect(klineUrl('BITGET', 'AAA', 3, t, t + 179_999, 1)).toBe(`https://api.bitget.com/api/v2/mix/market/history-candles?symbol=AAAUSDT&productType=USDT-FUTURES&granularity=3m&startTime=${t + 180_000}&endTime=${t + 359_999}&limit=1`);
    expect(() => klineUrl('BYBIT', 'AAA', 7, t, t, 1)).toThrow(/no 7-minute interval/);
    const pages = pagesOf('OKX', 'AAA', 3, t, t + 250 * 180_000, 100);
    expect(pages.map((p) => [p.from - t, p.to - t, p.limit])).toEqual([[0, 100 * 180_000 - 1, 100], [100 * 180_000, 200 * 180_000 - 1, 100], [200 * 180_000, 250 * 180_000 - 1, 50]]);
    expect(() => pagesOf('OKX', 'AAA', 3, t + 60_000, t + DAY)).toThrow(/boundary/);
  });

  it('classifies a reply: rows, a throttle, a transient failure, or the venue\'s own error answer', () => {
    const r = (status: number, body: unknown, retryAfter: string | null = null): Reply => ({ status, retryAfter, text: typeof body === 'string' ? body : JSON.stringify(body) });
    expect(classify('BYBIT', r(200, { retCode: 0, result: { list: [['1', '2', '3', '4', '5', '6']] } }))).toEqual({ kind: 'rows', rows: [['1', '2', '3', '4', '5', '6']] });
    expect(classify('OKX', r(429, { code: '50011' }, '7'))).toMatchObject({ kind: 'rate', retryAfterMs: 7000 });
    expect(classify('BITGET', r(200, { code: '429', msg: 'too many' }))).toMatchObject({ kind: 'rate' });
    expect(classify('BYBIT', r(502, '<html>'))).toMatchObject({ kind: 'transient' });
    expect(classify('OKX', r(503, { code: '1' }))).toMatchObject({ kind: 'transient' });
    expect(classify('OKX', r(400, { code: '51001', msg: 'no instrument' }))).toMatchObject({ kind: 'error', code: '51001' });
    expect(classify('BYBIT', r(200, { retCode: 0, result: { list: [['1', '2']] } }))).toMatchObject({ kind: 'error' });
    expect(NOT_LISTED_CODES).toEqual({ BYBIT: ['10001'], OKX: ['51001'], BITGET: ['40034'] });
  });

  it('waits out a throttle (Retry-After, else 5 s doubling), retries a transient failure 5 times, and never retries an error answer', async () => {
    const page = pagesOf('BYBIT', 'AAA', 1, STUDY_SPAN.t0Ms, STUDY_SPAN.t0Ms + 3 * MIN_MS)[0];
    const slept: number[] = [];
    const p = new Pacer(0, clock(), async (ms) => { slept.push(ms); });
    let n = 0;
    const flaky: Send = async (url) => (++n <= 2 ? { status: 429, retryAfter: null, text: '{}' } : fakeVenue({ AAA: { status: 'listed' } })(url));
    const t = tally();
    // the rows come back in the venue's own order (Bybit: newest first)
    expect((await getPage('BYBIT', page, flaky, p, t)).map((row) => Number(row[0]) - STUDY_SPAN.t0Ms)).toEqual([120_000, 60_000, 0]);
    expect([t.requests, t.throttled, slept]).toEqual([3, 2, [5000, 10_000]]);
    let m = 0;
    const down: Send = async () => { m++; throw new Error('socket hang up'); };
    await expect(getPage('BYBIT', page, down, pacer(), tally())).rejects.toThrow(/unreached after 5 tries/);
    expect(m).toBe(5);
    const err = await getPage('OKX', pagesOf('OKX', 'ZZZ', 3, STUDY_SPAN.t0Ms, STUDY_SPAN.t0Ms + 3 * 180_000)[0], fakeVenue({}), pacer(), tally()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VenueAnswerError);
    expect((err as VenueAnswerError).code).toBe('51001');
  });

  it('finds a coin\'s first day in the window, or none, and fetches its bars deduplicated in time order', async () => {
    const from = WINDOW_END_MS - 2 * DAY;
    const send = fakeVenue({ AAA: { status: 'listed', fromMs: from }, NNN: { status: 'none' } });
    for (const v of CHECK_VENUES) {
      expect(await firstDayOf(v, 'AAA', send, pacer(), tally()), v).toBe(from);
      expect(await firstDayOf(v, 'NNN', send, pacer(), tally()), v).toBeNull();
    }
    const got = await fetchCoin('OKX', 'AAA', 3, from, send, pacer(), tally());
    const lines = got.text.trim().split('\n');
    expect([got.rows, got.first, got.last, lines[0]]).toEqual([960, from, WINDOW_END_MS - 180_000, 'open_time,open,high,low,close,volume']);
    expect(lines.slice(1).map((l) => Number(l.split(',')[0]))).toEqual(Array.from({ length: 960 }, (_, i) => from + i * 180_000));
    expect(lines[1].split(',')).toEqual([String(from), '1.5', '2', '1', '1.75', '10']);
  });

  it('writes every venue, then the manifest last and once; refuses after the seal and over a manifest', async () => {
    const home = path.join(tmp, 'home-fetch');
    const coins: Record<string, FakeCoin> = { AAA: { status: 'listed', fromMs: WINDOW_END_MS - DAY }, BBB: { status: 'not_listed' }, CCC: { status: 'none' } };
    const x = { panel: ['AAA', 'BBB', 'CCC'], censusSha256: 'c'.repeat(64), home, send: fakeVenue(coins), now: clock(), sleep: noSleep };
    const r = await fetchCheck(x);
    const text = fs.readFileSync(r.manifest, 'utf8'), m = JSON.parse(text) as CheckManifest;
    expect([r.manifest, r.sha256]).toEqual([path.join(checkDirOf(home), CHECK_MANIFEST), sha(text)]);
    expect([m.window, m.census_sha256, m.fetcher_sha256]).toEqual([{ from: '2024-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' }, 'c'.repeat(64), sha(fs.readFileSync(path.resolve(__dirname, '../../src/scripts/regime-15m/r15-fetch.ts')))]);
    expect(m.venues.map((v) => [v.venue, v.resolution_min, v.coins.map((c) => c.status)])).toEqual([['BYBIT', 1, ['bars', 'not_listed', 'no_bars_in_window']], ['OKX', 3, ['bars', 'not_listed', 'no_bars_in_window']], ['BITGET', 3, ['bars', 'not_listed', 'no_bars_in_window']]]);
    for (const v of m.venues) {
      const c = v.coins[0];
      expect([c.file, c.rows], v.venue).toEqual([`${v.venue}/AAA-${v.resolution_min}m.csv`, 1440 / v.resolution_min]);
      expect(sha(fs.readFileSync(path.join(checkDirOf(home), c.file as string))), v.venue).toBe(c.sha256);
    }
    expect(fetchRefusal(home)).toMatch(/exists/);
    await expect(fetchCheck(x)).rejects.toThrow(/exists/);
    const sealedHome = path.join(tmp, 'home-sealed');
    fs.mkdirSync(path.join(sealedHome, SEAL_DIR), { recursive: true });
    fs.writeFileSync(path.join(sealedHome, SEAL_DIR, SEAL_FILE), '{}');
    expect(fetchRefusal(sealedHome)).toMatch(/seal/);
    await expect(fetchCheck({ ...x, home: sealedHome })).rejects.toThrow(/seal/);
    expect(fs.existsSync(path.join(checkDirOf(sealedHome), CHECK_MANIFEST))).toBe(false);
  });

  it('a failed venue leaves no manifest', async () => {
    const home = path.join(tmp, 'home-failed');
    const send: Send = async (url) => (url.includes('okx') ? { status: 200, retryAfter: null, text: JSON.stringify({ code: '50000', msg: 'boom' }) } : fakeVenue({ AAA: { status: 'listed', fromMs: WINDOW_END_MS - DAY } })(url));
    await expect(fetchCheck({ panel: ['AAA'], censusSha256: 'c'.repeat(64), home, send, now: clock(), sleep: noSleep })).rejects.toThrow(/wrote no manifest — OKX/);
    expect(fs.existsSync(path.join(checkDirOf(home), CHECK_MANIFEST))).toBe(false);
  });
});

describe('regime-15m: the stored bars and the Binance twin', () => {
  const span: Span = { t0Ms: Date.UTC(2021, 0, 1), n: 3 * 1440 };
  const bar = (k: number, R: number, o: number): [number, number, number, number, number, number] => [span.t0Ms + k * R * MIN_MS, o, o + 2, o - 1, o + 1, 7];

  it('replicates an R-minute bar into its R minutes so T3\'s aggregation gives it back exactly, and no minute shows a later price', () => {
    const { g, rejected } = replicate(span, 3, [bar(0, 3, 10), bar(1, 3, 20), [span.t0Ms + 60_000, 1, 1, 1, 1, 1], [span.t0Ms + span.n * MIN_MS, 1, 1, 1, 1, 1], [span.t0Ms + 6 * MIN_MS, 0, 1, 1, 1, 1]]);
    expect(rejected).toBe(3);
    const b = aggregate(g, 3);
    expect([b.O[0], b.H[0], b.L[0], b.C[0], b.V[0], b.cnt[0]]).toEqual([10, 12, 9, 11, 7, 3]);
    expect([b.O[1], b.H[1], b.L[1], b.C[1], b.V[1], b.cnt[1]]).toEqual([20, 22, 19, 21, 7, 3]);
    // the first two minutes of a bar hold its open only
    expect([g.H[0], g.L[0], g.C[0], g.V[0], g.H[2], g.C[2]]).toEqual([10, 10, 10, 0, 12, 11]);
    expect([g.has[5], g.has[6], g.first, g.last]).toEqual([1, 0, 0, 5]);
  });

  it('loads a venue\'s stored bars only when they are the file the manifest records', () => {
    const dir = path.join(tmp, 'check-load');
    fs.mkdirSync(path.join(dir, 'OKX'), { recursive: true });
    const text = `open_time,open,high,low,close,volume\n${[bar(0, 3, 10), bar(1, 3, 20)].map((r) => r.join(',')).join('\n')}\nnot,a,row\n`;
    fs.writeFileSync(path.join(dir, 'OKX', 'AAA-3m.csv'), text);
    const m: CheckManifest = { wave: 'w', window: { from: '', to: '' }, census_sha256: '', fetcher_sha256: '', venues: [{ venue: 'OKX', resolution_min: 3, pace_ms: 0, page_max: 0, requests: 0, throttled: 0, transient: 0, started_at: '', finished_at: '', seconds: 0,
      coins: [{ coin: 'AAA', position: 1, status: 'bars', file: 'OKX/AAA-3m.csv', sha256: sha(text) }, { coin: 'BBB', position: 2, status: 'not_listed' }] }] };
    expect(coinRecordOf(m, 'OKX', 'BBB')).toBeNull();
    expect(loadCheckGrid(m, dir, 'OKX', 'BBB', span)).toBeNull();
    const g = loadCheckGrid(m, dir, 'OKX', 'AAA', span) as Grid;
    expect([aggregate(g, 3).C[1], g.counts.rejected]).toEqual([21, 1]);
    fs.appendFileSync(path.join(dir, 'OKX', 'AAA-3m.csv'), 'x');
    expect(() => loadCheckGrid(m, dir, 'OKX', 'AAA', span)).toThrow(/not the file the check manifest records/);
  });

  it('the twin: Binance\'s 1 m grid at the venue\'s resolution, whole bars only; at 1 m it is the grid itself', () => {
    const g = emptyGrid(span);
    for (let i = 0; i < 12; i++) { if (i === 7) continue; g.O[i] = 100 + i; g.H[i] = 101 + i; g.L[i] = 99 + i; g.C[i] = 100.5 + i; g.V[i] = 1; g.has[i] = 1; }
    finishGrid(g);
    expect(twinGrid(g, 1)).toBe(g);
    const t = twinGrid(g, 3), a = aggregate(g, 3), b = aggregate(t, 3);
    for (const k of [0, 1, 3]) expect([b.O[k], b.H[k], b.L[k], b.C[k], b.V[k], b.cnt[k]], `bar ${k}`).toEqual([a.O[k], a.H[k], a.L[k], a.C[k], a.V[k], 3]);
    // the bar with a missing minute is not in the twin
    expect([a.cnt[2], b.cnt[2], t.has[6], t.has[8]]).toEqual([2, 0, 0, 0]);
  });
});
