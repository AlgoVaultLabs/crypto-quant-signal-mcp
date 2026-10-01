/**
 * adapter-history-contiguity.test.ts — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH3: the live canary's judgement, two-way.
 *
 *   - judgePair / aggregate on hand-built pages: PASS on the pinned class, FAIL on each drift / C1 / missing meta /
 *     meta that disagrees with the data, INDETERMINATE on an unreachable venue, SKIPPED on UNSERVABLE.
 *   - probeAll end-to-end through the REAL Bitget/OKX adapters on the synthetic venue (proven page-for-page by
 *     adapter-history-synthetic-fidelity.test.ts) against the pinned REACH.json / UNSERVABLE.json: the shipped
 *     code is PASS on every pair, and the RETIRED bodies (tests/fixtures/adapter-history/retired/) go FAIL on
 *     exactly BITGET 2h/8h C1 plus C3 (no meta) everywhere. The canary is therefore proven able to see the class
 *     it exists for, with no network.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SyntheticVenue } from '../harness/adapter-history-synthetic.js';

const { venue } = vi.hoisted(() => ({ venue: { current: null as null | { answer(url: string): unknown } } }));
vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
    if (!venue.current) throw new Error('contiguity test: no venue');
    return venue.current.answer(req.url);
  }),
}));

import {
  judgePair, aggregate, probeAll, reachClass, PACE_MS, HEAD_ALLOWANCE_BARS, DEEP_PROBE_RECENT_CAP,
  type Expectations, type PairResult,
} from '../../src/scripts/adapter-history-contiguity.js';
import { accountPage, type PageFacts } from '../../src/lib/adapters/_history-plan.js';
import * as bitget from '../../src/lib/adapters/bitget.js';
import * as okx from '../../src/lib/adapters/okx.js';
import { retiredGetCandles as retiredBitget } from '../fixtures/adapter-history/retired/bitget-getcandles.js';
import { retiredGetCandles as retiredOkx } from '../fixtures/adapter-history/retired/okx-getcandles.js';
import { CRON_TIMEFRAMES, isTimeframeFaithful } from '../../src/lib/tf-support.js';
import { EVAL_CANDLES } from '../../src/scripts/directional-labeler.js';
import type { ExchangeId } from '../../src/types.js';

const FIX = path.resolve(__dirname, '../fixtures/adapter-history');
const readJson = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')) as T;
const expected: Expectations = {
  reach: readJson<{ pairs: Expectations['reach'] }>('REACH.json').pairs,
  unservable: readJson<{ pairs: Expectations['unservable'] }>('UNSERVABLE.json').pairs,
};

const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 1, 10, 24, 7);
const clean: PageFacts = { returned: 25, inWindow: 25, outOfRangeBars: 0, offGridBars: 0, expectedSlots: 24, emptyWindow: false, frontGapBars: 0, gapSlots: 0, headGapBars: 0 };
const exp1: Expectations = { reach: { 'X/1h': { R: clean, D: clean } }, unservable: [{ pair: 'X/8h', reason: 'test' }] };
const ok = { facts: clean, phaseMs: 0 };
const deepOk = { facts: clean, meta: { complete: true, substitutedNewest: false } };

describe('judgePair — the recent page against the pinned reach class', () => {
  it('PASS when the class equals the pin', () => {
    expect(judgePair({ venue: 'X', tf: '1h', expected: exp1, recent: ok, deep: null, servedStepMs: H }).verdict).toBe('PASS');
  });
  it.each([
    ['front', { frontGapBars: 3 }],
    ['holes', { gapSlots: 1 }],
    ['head', { headGapBars: HEAD_ALLOWANCE_BARS + 1 }],
    ['offGrid', { offGridBars: 2 }],
    ['outOfRange', { outOfRangeBars: 5 }],
    ['empty', { emptyWindow: true }],
  ])('FAIL on %s drift', (k, delta) => {
    const r = judgePair({ venue: 'X', tf: '1h', expected: exp1, recent: { facts: { ...clean, ...delta }, phaseMs: 0 }, deep: null, servedStepMs: H });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.join(' ')).toContain(`reach drift: ${k}`);
  });
  it('a one-bar head lag is the allowance, not drift', () => {
    expect(judgePair({ venue: 'X', tf: '1h', expected: exp1, recent: { facts: { ...clean, headGapBars: HEAD_ALLOWANCE_BARS }, phaseMs: 0 }, deep: null, servedStepMs: H }).verdict).toBe('PASS');
  });
  it('FAIL on a pair with no pin (a new or re-mapped pair)', () => {
    expect(judgePair({ venue: 'Y', tf: '1h', expected: exp1, recent: ok, deep: null, servedStepMs: H }).verdict).toBe('FAIL');
  });
  it('INDETERMINATE when the venue cannot be read (never a FAIL)', () => {
    expect(judgePair({ venue: 'X', tf: '1h', expected: exp1, recent: { error: 'UpstreamRateLimitError: 429' }, deep: null, servedStepMs: H }).verdict).toBe('INDETERMINATE');
  });
  it('SKIPPED on a declared UNSERVABLE pair', () => {
    expect(judgePair({ venue: 'X', tf: '8h', expected: exp1, recent: ok, deep: null, servedStepMs: H }).verdict).toBe('SKIPPED');
  });
});

describe('judgePair — the deep history probe (C1 + C3 report)', () => {
  const run = (deep: Parameters<typeof judgePair>[0]['deep']) => judgePair({ venue: 'X', tf: '1h', expected: exp1, recent: ok, deep, servedStepMs: H });
  it('PASS on a complete window with meta', () => { expect(run(deepOk).verdict).toBe('PASS'); });
  it('FAIL C1 on an incomplete window pinned complete', () => {
    const r = run({ ...deepOk, facts: { ...clean, frontGapBars: 12 }, meta: { complete: false } });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.join(' ')).toContain('C1');
  });
  it('FAIL C3 when the history page carries no meta', () => {
    const r = run({ facts: clean, meta: undefined });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.join(' ')).toContain('C3');
  });
  it('FAIL when meta.complete disagrees with the data', () => {
    const r = run({ facts: clean, meta: { complete: false } });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.join(' ')).toContain('meta disagrees');
  });
  it('counts substitutedNewest (report-only, OAH-Q5) without failing', () => {
    const r = run({ facts: clean, meta: { complete: true, substitutedNewest: true } });
    expect(r.verdict).toBe('PASS');
    expect(r.substitutedNewest).toBe(1);
  });
  it('an unreadable deep probe is INDETERMINATE, and never masks a recent-page FAIL', () => {
    expect(run({ error: 'timeout' }).verdict).toBe('INDETERMINATE');
    const r = judgePair({ venue: 'X', tf: '1h', expected: exp1, recent: { facts: { ...clean, gapSlots: 2 }, phaseMs: 0 }, deep: { error: 'timeout' }, servedStepMs: H });
    expect(r.verdict).toBe('FAIL');
  });
});

describe('aggregate — one token', () => {
  const v = (verdict: PairResult['verdict']) => ({ verdict }) as PairResult;
  it('FAIL dominates, then INDETERMINATE; SKIPPED is neutral', () => {
    expect(aggregate([v('PASS'), v('INDETERMINATE'), v('FAIL')])).toBe('FAIL');
    expect(aggregate([v('PASS'), v('INDETERMINATE'), v('SKIPPED')])).toBe('INDETERMINATE');
    expect(aggregate([v('PASS'), v('SKIPPED')])).toBe('PASS');
  });
  it('reachClass is a pure projection of the facts', () => {
    expect(reachClass(clean)).toEqual({ front: false, holes: false, head: false, offGrid: false, outOfRange: false, empty: false });
  });
});

describe('probeAll — request shape and pacing', () => {
  it('asks R as serving does, the deep window only on BITGET/OKX, and paces every call after the first', async () => {
    const calls: { venue: string; tf: string; from: number; to?: number }[] = [];
    const waits: number[] = [];
    const s = H;
    const page = (from: number, to?: number) => {
      const end = to ?? NOW;
      const out: { time: number }[] = [];
      for (let t = Math.ceil(from / s) * s; t < end; t += s) out.push({ time: t });
      return out;
    };
    const res = await probeAll({
      venues: ['BINANCE', 'BITGET'],
      expected: { reach: { 'BINANCE/1h': { R: clean, D: clean }, 'BITGET/1h': { R: clean, D: clean } }, unservable: [] },
      nowMs: () => NOW,
      getCandles: async (venue, tf, from, to) => { calls.push({ venue, tf, from, to }); return page(from, to); },
      served: () => s,
      timeframes: () => ['1h'],
      pace: async (ms) => { waits.push(ms); },
    });
    expect(calls.map((c) => `${c.venue}:${c.to === undefined ? 'R' : 'D'}`)).toEqual(['BINANCE:R', 'BITGET:R', 'BITGET:D']);
    expect(waits).toEqual([PACE_MS, PACE_MS]);
    const W = EVAL_CANDLES['1h'];
    expect(calls[0].from).toBe(NOW - (2 * W + 1) * s);
    const cap = DEEP_PROBE_RECENT_CAP.BITGET!;
    expect(calls[2].from).toBe(NOW - (cap + 2 * W + 6) * s);
    expect(calls[2].to).toBe(calls[2].from + 2 * W * s);
    expect(res.map((r) => r.venue)).toEqual(['BINANCE', 'BITGET']);
  });
  it('never calls the venue on an UNSERVABLE pair', async () => {
    const get = vi.fn();
    const res = await probeAll({
      venues: ['OKX'], expected, nowMs: () => NOW, getCandles: get, served: () => 8 * H, timeframes: () => ['8h'], pace: async () => {},
    });
    expect(get).not.toHaveBeenCalled();
    expect(res[0].verdict).toBe('SKIPPED');
  });
});

describe('probeAll end-to-end through the adapters on the synthetic venue, against the pinned REACH', () => {
  type V = 'BITGET' | 'OKX';
  const shipped = {
    BITGET: (c: string, tf: string, s: number, e?: number) => new bitget.BitgetAdapter().getCandles(c, tf, s, undefined, e),
    OKX: (c: string, tf: string, s: number, e?: number) => new okx.OKXAdapter().getCandles(c, tf, s, undefined, e),
  };
  const retired = { BITGET: (c: string, tf: string, s: number) => retiredBitget(c, tf, s), OKX: (c: string, tf: string, s: number) => retiredOkx(c, tf, s) };
  const served = { BITGET: bitget.servedIntervalMs, OKX: okx.servedIntervalMs };

  beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterAll(() => { vi.useRealTimers(); venue.current = null; });

  const runWith = (impl: typeof shipped | typeof retired) => probeAll({
    venues: ['BITGET', 'OKX'],
    expected,
    nowMs: () => NOW,
    getCandles: async (v, tf, from, to) => {
      venue.current = new SyntheticVenue(v as V, () => NOW, () => ({ listingMs: Date.UTC(2020, 0, 1) }));
      try { return await impl[v as V]('BTC', tf, from, to); } finally { venue.current = null; }
    },
    served: (v, tf) => served[v as V](tf),
    timeframes: (v) => CRON_TIMEFRAMES.filter((tf) => isTimeframeFaithful(v as ExchangeId, tf)),
    pace: async () => {},
  });

  it('the shipped adapters are PASS on every pair; OKX/8h is SKIPPED (vacuity: ≥ 19 pairs judged)', async () => {
    const res = await runWith(shipped);
    const bad = res.filter((r) => r.verdict !== 'PASS' && r.verdict !== 'SKIPPED').map((r) => `${r.venue}/${r.tf} ${r.verdict} ${r.reasons.join('; ')}`);
    expect(bad).toEqual([]);
    expect(res.filter((r) => r.verdict === 'SKIPPED').map((r) => `${r.venue}/${r.tf}`)).toEqual(['OKX/8h']);
    expect(res.filter((r) => r.verdict === 'PASS').length).toBeGreaterThanOrEqual(19);
    expect(res.every((r) => r.verdict === 'SKIPPED' || r.deep?.meta === true)).toBe(true);
    expect(aggregate(res)).toBe('PASS');
  });

  it('the RETIRED bodies go FAIL: C1 on exactly BITGET 2h/8h, C3 (no meta) on every deep probe', async () => {
    const res = await runWith(retired);
    expect(aggregate(res)).toBe('FAIL');
    const c1 = res.filter((r) => r.reasons.some((x) => x.startsWith('C1'))).map((r) => `${r.venue}/${r.tf}`).sort();
    expect(c1).toEqual(['BITGET/2h', 'BITGET/8h']);
    const judged = res.filter((r) => r.verdict !== 'SKIPPED');
    expect(judged.every((r) => r.reasons.some((x) => x.startsWith('C3')))).toBe(true);
  });

  it('the accounting the canary uses is the ONE accounting (no second derivation)', () => {
    const a = accountPage({ bars: [], servedStepMs: H, from: NOW - 10 * H, to: NOW - 5 * H, nowMs: NOW });
    expect(a.emptyWindow).toBe(true);
  });
});
