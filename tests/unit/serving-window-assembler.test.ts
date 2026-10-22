/**
 * serving-window-assembler.test.ts — OPS-SERVED-CANDLE-TRUTH-W1 CH1: `assembleServingWindow` (src/lib/adapters/
 * _history-plan.ts) and the two adapters that use it.
 *
 *   1. The pure assembler with fake fetchers: which direction it pages, when it stops, and that it can neither loop
 *      nor exceed its page budget.
 *   2. The OKX and Bitget adapters on the synthetic venue (tests/harness/adapter-history-synthetic.ts, proven
 *      page-for-page against live captures): the two R0 defects served complete (BITGET 1d@100 in 2 requests, OKX
 *      1h@168 in 1), the backward walk on windows longer than one page, young listings, and history reads untouched.
 *      Every page goes through the shared transport, upstreamFetch: a raw fetch would throw.
 *
 * The adapters read Date.now() for their serving decisions, so each read runs on a clock anchored at the venue's
 * own now that only moves FORWARD (the OKX throttle sleeps for any backward gap): every read runs one week after the
 * last, which keeps every grid and UTC+8 phase. Within a read the clock advances 1 s per call.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { SyntheticVenue } from '../harness/adapter-history-synthetic.js';

const { venue, ledger } = vi.hoisted(() => ({ venue: { current: null as null | { answer(url: string): unknown } }, ledger: [] as string[] }));
vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
    if (!venue.current) throw new Error('assembler test: no venue');
    ledger.push(req.url);
    return venue.current.answer(req.url);
  }),
}));

import { assembleServingWindow, accountPage, historyMetaOf, HEAD_ALLOWANCE_BARS, type ServingPage } from '../../src/lib/adapters/_history-plan.js';
import { SERVING_MAX_PAGES } from '../../src/lib/serving-windows.js';
import * as okx from '../../src/lib/adapters/okx.js';
import * as bitget from '../../src/lib/adapters/bitget.js';
import type { Candle } from '../../src/types.js';

const H = 3_600_000;
const DAY = 24 * H;

// ── 1. the pure assembler ──────────────────────────────────────────────────────────────────────
type Bar = { time: number; src?: string };
const F0 = Date.UTC(2026, 0, 5); // slot 0 of a 1h grid
/** Slots [a, b] of the 1h grid from F0. */
const slots = (a: number, b: number, src?: string): Bar[] => Array.from({ length: b - a + 1 }, (_, i) => ({ time: F0 + (a + i) * H, ...(src ? { src } : {}) }));
/** A 100-slot window [F0, now]: slots 0..98 closed, 99 forming. */
const NOW_100 = F0 + 99 * H + H / 2;
const facts = (bars: Bar[], nowMs = NOW_100) => accountPage({ bars: bars.map((b) => ({ ts: b.time })), servedStepMs: H, from: F0, to: null, nowMs });

/** A fetcher over the grid [0, 99] that answers `span` slots in its direction and records every call. */
function fetcher(dir: 'forward' | 'backward', span: number, opts: { exhaustedAt?: number } = {}) {
  const at: number[] = [];
  const fn = async (t: number): Promise<ServingPage<Bar>> => {
    at.push(t);
    const k = (t - F0) / H;
    const [a, b] = dir === 'forward' ? [k + 1, Math.min(99, k + span)] : [Math.max(0, k - span), k - 1];
    const bars = b >= a ? slots(a, b, 'page') : [];
    return { bars, exhausted: opts.exhaustedAt !== undefined ? at.length >= opts.exhaustedAt : bars.length === 0 };
  };
  return { fn, at };
}

describe('assembleServingWindow (pure)', () => {
  it('pages FORWARD while the head gap exceeds HEAD_ALLOWANCE_BARS, then stops', async () => {
    const fwd = fetcher('forward', 200);
    const r = await assembleServingWindow({ first: slots(0, 89), servedStepMs: H, from: F0, nowMs: NOW_100, maxPages: 3, forward: fwd.fn });
    expect(fwd.at).toEqual([F0 + 89 * H]); // from the newest held bar
    expect(r.pages).toBe(2);
    expect(r.bars).toHaveLength(100);
    expect(facts(r.bars)).toMatchObject({ frontGapBars: 0, gapSlots: 0, headGapBars: 0 });
  });

  it('a head gap of exactly HEAD_ALLOWANCE_BARS costs no request; one more bar of gap does', async () => {
    expect(HEAD_ALLOWANCE_BARS).toBe(1);
    const at1 = fetcher('forward', 200);
    const r1 = await assembleServingWindow({ first: slots(0, 97), servedStepMs: H, from: F0, nowMs: NOW_100, maxPages: 3, forward: at1.fn });
    expect(facts(slots(0, 97)).headGapBars).toBe(1);
    expect([r1.pages, at1.at.length]).toEqual([1, 0]);
    const at2 = fetcher('forward', 200);
    const r2 = await assembleServingWindow({ first: slots(0, 96), servedStepMs: H, from: F0, nowMs: NOW_100, maxPages: 3, forward: at2.fn });
    expect(facts(slots(0, 96)).headGapBars).toBe(2);
    expect([r2.pages, at2.at.length]).toEqual([2, 1]);
  });

  it('pages BACKWARD on a front gap from the oldest held bar, and stops at maxPages counting the first page', async () => {
    const back = fetcher('backward', 20);
    const r = await assembleServingWindow({ first: slots(40, 99), servedStepMs: H, from: F0, nowMs: NOW_100, maxPages: 3, backward: back.fn });
    expect(back.at).toEqual([F0 + 40 * H, F0 + 20 * H]);
    expect(r.pages).toBe(3);
    expect(r.bars[0].time).toBe(F0);
    expect(facts(r.bars)).toMatchObject({ frontGapBars: 0, gapSlots: 0, headGapBars: 0 });
  });

  it('the head is completed before the front', async () => {
    const order: string[] = [];
    const fwd = fetcher('forward', 200);
    const back = fetcher('backward', 200);
    const r = await assembleServingWindow({
      first: slots(10, 80), servedStepMs: H, from: F0, nowMs: NOW_100, maxPages: 3,
      forward: async (t) => { order.push('forward'); return fwd.fn(t); },
      backward: async (t) => { order.push('backward'); return back.fn(t); },
    });
    expect(order).toEqual(['forward', 'backward']);
    expect(r.bars).toHaveLength(100);
  });

  it('a page the venue calls exhausted drops that direction, even with budget left', async () => {
    const back = fetcher('backward', 5, { exhaustedAt: 1 });
    const r = await assembleServingWindow({ first: slots(40, 99), servedStepMs: H, from: F0, nowMs: NOW_100, maxPages: 5, backward: back.fn });
    expect(back.at).toHaveLength(1);
    expect(r.pages).toBe(2);
    expect(facts(r.bars).frontGapBars).toBe(35); // what the venue has is what is served; INSUFFICIENT_CANDLES and the guard judge it
  });

  it('a page that adds no bar drops that direction: the walk cannot loop', async () => {
    let calls = 0;
    const r = await assembleServingWindow({
      first: slots(0, 89), servedStepMs: H, from: F0, nowMs: NOW_100, maxPages: 10,
      forward: async () => { calls++; return { bars: slots(80, 89, 'page'), exhausted: false }; },
    });
    expect(calls).toBe(1);
    expect(r.pages).toBe(2);
  });

  it('never makes more than maxPages requests in all, however much the venue still holds', async () => {
    const back = fetcher('backward', 1); // one bar per page, never exhausted while bars remain
    const r = await assembleServingWindow({ first: slots(50, 99), servedStepMs: H, from: F0, nowMs: NOW_100, maxPages: 5, backward: back.fn });
    expect(back.at).toHaveLength(4);
    expect(r.pages).toBe(5);
    expect(r.bars[0].time).toBe(F0 + 46 * H);
  });

  it('no request for an empty first page, a window holding no bar, or a gap with no fetcher', async () => {
    const fwd = fetcher('forward', 200);
    const back = fetcher('backward', 200);
    expect(await assembleServingWindow({ first: [], servedStepMs: H, from: F0, nowMs: NOW_100, maxPages: 3, forward: fwd.fn, backward: back.fn })).toEqual({ bars: [], pages: 1 });
    const before = [{ time: F0 - 5 * H }, { time: F0 - 4 * H }];
    expect((await assembleServingWindow({ first: before, servedStepMs: H, from: F0, nowMs: NOW_100, maxPages: 3, forward: fwd.fn, backward: back.fn })).pages).toBe(1);
    expect((await assembleServingWindow({ first: slots(10, 80), servedStepMs: H, from: F0, nowMs: NOW_100, maxPages: 3 })).pages).toBe(1);
    expect([fwd.at, back.at]).toEqual([[], []]);
  });

  it('merges by open time: ascending, one bar per open time, the bar already held wins', async () => {
    const r = await assembleServingWindow({
      first: [...slots(50, 99, 'held')].reverse(), servedStepMs: H, from: F0, nowMs: NOW_100, maxPages: 2,
      backward: async () => ({ bars: slots(0, 60, 'page'), exhausted: false }),
    });
    expect(r.bars.map((b) => b.time)).toEqual(slots(0, 99).map((b) => b.time));
    expect(r.bars.filter((b) => b.src === 'held')).toHaveLength(50);
    expect(r.bars.find((b) => b.time === F0 + 55 * H)!.src).toBe('held');
  });
});

// ── 2. the adapters on the synthetic venue ─────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 9, 22, 9, 30); // mid-slot on every grid used here (1D opens 16:00Z on both venues)
const WEEK = 7 * DAY;
let clock = 0;
let weeks = 0;
const rawFetch = vi.fn(() => { throw new Error('a page bypassed upstreamFetch'); });
beforeAll(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1_000));
  vi.stubGlobal('fetch', rawFetch);
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type V = 'OKX' | 'BITGET';
const STEP: Record<string, number> = { '1h': H, '4h': 4 * H, '1d': DAY };

async function serve(v: V, tf: string, bars: number, opts: { listedAgoMs?: number; history?: boolean } = {}) {
  const now = NOW + ++weeks * WEEK;
  const listingMs = opts.listedAgoMs === undefined ? Date.UTC(2019, 0, 1) : now - opts.listedAgoMs;
  venue.current = new SyntheticVenue(v, () => now, () => ({ listingMs }));
  clock = now;
  ledger.length = 0;
  const start = now - bars * STEP[tf];
  const adapter = v === 'OKX' ? new okx.OKXAdapter() : new bitget.BitgetAdapter();
  const out: Candle[] = await adapter.getCandles('BTC', tf, start, undefined, opts.history ? now : undefined);
  venue.current = null;
  const servedStepMs = (v === 'OKX' ? okx.servedIntervalMs : bitget.servedIntervalMs)(tf)!;
  const f = accountPage({ bars: out.map((c) => ({ ts: c.time })), servedStepMs, from: start, to: null, nowMs: now });
  const paths = ledger.map((u) => new URL(u).pathname);
  return { out, branch: historyMetaOf(out)?.branch, requests: [...ledger], paths, facts: f, start, now };
}

describe('the two R0 defects, served complete', () => {
  it('BITGET 1d@100: the 90-day recent page plus ONE forward page — branch A, 2 requests, head-complete', async () => {
    const r = await serve('BITGET', '1d', 100);
    expect(r.paths).toEqual(['/api/v2/mix/market/candles', '/api/v2/mix/market/candles']);
    const first = r.out.find((c) => c.time >= r.start)!.time;
    expect(Number(new URL(r.requests[1]).searchParams.get('startTime'))).toBe(first + 89 * DAY + DAY); // newest held + one step
    expect(r.branch).toBe('A');
    expect(r.out).toHaveLength(100);
    expect(r.facts).toMatchObject({ frontGapBars: 0, gapSlots: 0, headGapBars: 0 });
    expect(r.requests.length).toBeLessThanOrEqual(SERVING_MAX_PAGES);
  });

  it('OKX 1h@168: ONE recent request at the serving limit — branch R, head-complete', async () => {
    const r = await serve('OKX', '1h', 168);
    expect(r.paths).toEqual(['/api/v5/market/candles']);
    expect(new URL(r.requests[0]).searchParams.get('limit')).toBe(String(okx.SERVING_PAGE_LIMIT));
    expect(okx.SERVING_PAGE_LIMIT).toBe(300);
    expect(r.branch).toBe('R');
    expect(r.out).toHaveLength(168);
    expect(r.facts).toMatchObject({ frontGapBars: 0, gapSlots: 0, headGapBars: 0 });
  });
});

describe('windows longer than one page walk BACKWARD, inside the budget', () => {
  it('OKX 1h@400: the full recent page plus one history page — branch A, 2 requests, complete', async () => {
    const r = await serve('OKX', '1h', 400);
    expect(r.paths).toEqual(['/api/v5/market/candles', '/api/v5/market/history-candles']);
    expect(r.branch).toBe('A');
    expect(r.out).toHaveLength(400);
    expect(r.facts).toMatchObject({ frontGapBars: 0, gapSlots: 0, headGapBars: 0 });
  });

  it('OKX 1h@600: stops at SERVING_MAX_PAGES with the head complete and the remaining gap at the front', async () => {
    const r = await serve('OKX', '1h', 600);
    expect(r.requests).toHaveLength(SERVING_MAX_PAGES);
    expect(r.paths).toEqual(['/api/v5/market/candles', '/api/v5/market/history-candles', '/api/v5/market/history-candles']);
    expect(r.branch).toBe('A');
    expect(r.out).toHaveLength(okx.SERVING_PAGE_LIMIT + 2 * okx.HISTORY_PAGE_CAP);
    expect(r.facts).toMatchObject({ frontGapBars: 600 - 500, gapSlots: 0, headGapBars: 0 });
  });

  it('BITGET 1h@300: the full 200-bar recent page plus one history page — branch A, 2 requests, complete', async () => {
    const r = await serve('BITGET', '1h', 300);
    expect(r.paths).toEqual(['/api/v2/mix/market/candles', '/api/v2/mix/market/history-candles']);
    expect(r.branch).toBe('A');
    expect(r.out).toHaveLength(300);
    expect(r.facts).toMatchObject({ frontGapBars: 0, gapSlots: 0, headGapBars: 0 });
  });
});

describe('young listings', () => {
  it('OKX 1h@168 listed 150 h ago: the recent page IS the answer (the retired fallback ended ~68 h back) — 1 request', async () => {
    const r = await serve('OKX', '1h', 168, { listedAgoMs: 150 * H });
    expect(r.paths).toEqual(['/api/v5/market/candles']);
    expect(r.branch).toBe('A');
    expect(r.out).toHaveLength(151); // the listing's own slot through the forming bar
    expect(r.facts.headGapBars).toBe(0);
  });

  it('OKX 4h@42 listed 50 h ago: the history fallback reaches the head, so it is kept — branch F, unchanged', async () => {
    const r = await serve('OKX', '4h', 42, { listedAgoMs: 50 * H });
    expect(r.paths).toEqual(['/api/v5/market/candles', '/api/v5/market/history-candles']);
    expect(r.branch).toBe('F');
    expect(r.facts.headGapBars).toBe(0);
  });

  it('BITGET 1d@100 listed 30 d ago: not full, the fallback reaches the head — branch F, unchanged', async () => {
    const r = await serve('BITGET', '1d', 100, { listedAgoMs: 30 * DAY });
    expect(r.paths).toEqual(['/api/v2/mix/market/candles', '/api/v2/mix/market/history-candles']);
    expect(r.branch).toBe('F');
    expect(r.facts.headGapBars).toBe(0);
  });
});

describe('history reads (endTime given) never assemble', () => {
  it('OKX 1h 168 bars back with endTime: the RECENT_PAGE_CAP request and the history fallback, as before', async () => {
    const r = await serve('OKX', '1h', 168, { history: true });
    expect(new URL(r.requests[0]).searchParams.get('limit')).toBe(String(okx.RECENT_PAGE_CAP));
    expect(r.paths).toEqual(['/api/v5/market/candles', '/api/v5/market/history-candles']);
    expect(r.branch).toBe('F');
  });

  it('BITGET 1d 100 bars back with endTime: the routed recent page alone, as before', async () => {
    const r = await serve('BITGET', '1d', 100, { history: true });
    expect(r.paths).toEqual(['/api/v2/mix/market/candles']);
    expect(r.branch).toBe('R');
  });

  it('every page above went through upstreamFetch: no raw fetch was made', () => {
    expect(rawFetch).not.toHaveBeenCalled();
  });
});
