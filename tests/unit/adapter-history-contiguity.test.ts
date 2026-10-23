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
 *   - S (OPS-SERVED-CANDLE-TRUTH-W1 CH2): judgeServe two-way (a deliberately broken window FAILs; a seam refusal is a
 *     FAIL, never INDETERMINATE), the probe plan read from the registry and interleaved by venue, the pacing, and the
 *     same synthetic end-to-end: the shipped adapters PASS every window, the retired bodies FAIL on exactly the two
 *     windows R0 measured stale in production.
 *   - CH3a (OPS-SERVED-CANDLE-TRUTH-W1): judgeServe's forming-bar head two-way (one bar short FAILs on a non-declared
 *     venue; forming - 1 PASSes on the declared PHEMEX and its forming bar FAILs), the young-listing leg (screen,
 *     interleave, pacing, adoption on a refusal, FAIL on a young window one bar short; the shipped Bitget/OKX PASS a
 *     young synthetic listing), and the ticker leg two-way.
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
  judgeServe, servingProbePlan, probeServing, probeYoung, judgeTicker, youngCandidatesByVenue, YOUNG_FRONT_BARS,
  YOUNG_CANDIDATES_PER_VENUE, type Expectations, type PairResult, type ServeResult, type ServeWindow,
} from '../../src/scripts/adapter-history-contiguity.js';
import { servingSpans } from '../../src/lib/serving-windows.js';
import { StaleUpstreamWindowError } from '../../src/lib/errors.js';
import { TIMEFRAMES } from '../../src/lib/capabilities.js';
import { TF_MS } from '../../src/lib/pfe-mae.js';
import { accountPage, type PageFacts } from '../../src/lib/adapters/_history-plan.js';
import * as bitget from '../../src/lib/adapters/bitget.js';
import * as okx from '../../src/lib/adapters/okx.js';
import { retiredGetCandles as retiredBitget } from '../fixtures/adapter-history/retired/bitget-getcandles.js';
import { retiredGetCandles as retiredOkx } from '../fixtures/adapter-history/retired/okx-getcandles.js';
import { CRON_TIMEFRAMES, isTimeframeFaithful } from '../../src/lib/tf-support.js';
import { EVAL_CANDLES } from '../../src/scripts/directional-labeler.js';
import type { ExchangeId } from '../../src/types.js';
import { BOUNDARY_LAG_MS, LIVE_TICKER_MAX_AGE_MS, SNAPSHOT_KLINE_MAX_LAG_MS } from '../../src/lib/live-price.js';

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
    // UNSERVABLE.json is empty since OPS-SERVED-CANDLE-TRUTH-W1 CH2; the --expect contract still carries the list.
    const get = vi.fn();
    const res = await probeAll({
      venues: ['X'], expected: exp1, nowMs: () => NOW, getCandles: get, served: () => 8 * H, timeframes: () => ['8h'], pace: async () => {},
    });
    expect(get).not.toHaveBeenCalled();
    expect(res[0].verdict).toBe('SKIPPED');
  });
});

describe('judgeServe — one serving window, two-way', () => {
  const w: ServeWindow = { venue: 'X', tf: '1h', window: 'trade_call@100', spanMs: 100 * H, servedStepMs: H, coin: 'BTC' };
  const FORMING = Math.floor(NOW / H) * H;
  /** read at NOW, answered at once, newest bar the forming bar */
  const at = { newestMs: FORMING, calledAtMs: NOW, answeredAtMs: NOW };
  it('PASS when the served page reaches the newest bar, the one-bar allowance included', () => {
    expect(judgeServe(w, { facts: clean, branch: 'R', ...at }).verdict).toBe('PASS');
    expect(judgeServe(w, { facts: { ...clean, headGapBars: HEAD_ALLOWANCE_BARS }, branch: 'A', ...at }).verdict).toBe('PASS');
  });
  it('FAIL on a deliberately broken window: one bar past the allowance', () => {
    const r = judgeServe(w, { facts: { ...clean, headGapBars: HEAD_ALLOWANCE_BARS + 1 }, branch: 'F', ...at });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons.join(' ')).toContain("does not reach the venue's newest bar");
    expect([r.headGapBars, r.branch]).toEqual([HEAD_ALLOWANCE_BARS + 1, 'F']);
  });
  it('FAIL on a window that holds no bar', () => {
    const r = judgeServe(w, { facts: { ...clean, inWindow: 0, emptyWindow: true, headGapBars: null }, branch: null, ...at, newestMs: null });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons).toEqual(['no bar in the window']);
  });
  it('FAIL — never INDETERMINATE — when the getAdapter seam refused the window as stale', () => {
    const r = judgeServe(w, { refused: { headGapBars: 67, newestBarAt: '2026-09-28T13:00:00.000Z' } });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons[0]).toMatch(/^STALE_UPSTREAM_WINDOW: the getAdapter seam refused the window \(head gap 67 bars/);
  });
  it('INDETERMINATE only when the read could not be made', () => {
    expect(judgeServe(w, { error: 'UpstreamRateLimitError: 429' }).verdict).toBe('INDETERMINATE');
  });
  it('one token over R/D pairs and S windows: an S FAIL fails the run', () => {
    expect(aggregate([{ verdict: 'PASS' }, judgeServe(w, { facts: { ...clean, headGapBars: 9 }, branch: 'R', ...at })])).toBe('FAIL');
    expect(aggregate([{ verdict: 'PASS' }, judgeServe(w, { error: 'timeout' })])).toBe('INDETERMINATE');
  });
  it('CH3a: FAIL on a window one bar short at the head — closed-bar arithmetic passes it (head gap 0), the forming check does not', () => {
    const r = judgeServe(w, { facts: clean, branch: 'F', ...at, newestMs: FORMING - H });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons).toEqual(['head: newest bar 1 slot(s) before the forming bar']);
  });
  it('CH3a: inside BOUNDARY_LAG_MS after a boundary, one bar short is the venue not having opened the bar yet: PASS', () => {
    const justAfter = FORMING + BOUNDARY_LAG_MS;
    expect(judgeServe(w, { facts: clean, branch: 'R', newestMs: FORMING - H, calledAtMs: justAfter, answeredAtMs: justAfter }).verdict).toBe('PASS');
    expect(judgeServe(w, { facts: clean, branch: 'R', newestMs: FORMING - H, calledAtMs: justAfter + 1, answeredAtMs: justAfter + 1 }).verdict).toBe('FAIL');
  });
  it('CH3a: a read that crossed a boundary is judged over [calledAt, answeredAt]', () => {
    expect(judgeServe(w, { facts: clean, branch: 'R', newestMs: FORMING + H, calledAtMs: FORMING + H - 500, answeredAtMs: FORMING + H + 300 }).verdict).toBe('PASS');
  });
  it('CH3a: the declared PHEMEX owes forming - 1 (PASS), and serving its forming bar is a FINDING (FAIL)', () => {
    const px = { ...w, venue: 'PHEMEX' };
    expect(judgeServe(px, { facts: clean, branch: null, ...at, newestMs: FORMING - H }).verdict).toBe('PASS');
    const r = judgeServe(px, { facts: clean, branch: null, ...at });
    expect(r.verdict).toBe('FAIL');
    expect(r.reasons).toEqual(['head: a declared closed-only kline venue served its forming bar']);
    expect(judgeServe(px, { facts: clean, branch: null, ...at, newestMs: FORMING - 2 * H }).reasons).toEqual(['head: newest bar 2 slot(s) before the forming bar (declared: 1 expected)']);
  });
  it('Q13: on a declared venue\'s THIN reference the head lag is a metric, never a FAIL; its forming bar still FAILs', () => {
    const thin: ServeWindow = { ...w, venue: 'PHEMEX', coin: 'AGPU', window: 'young:AGPU@trade_call@100', reference: 'thin' };
    // as measured live: the closed-bar head gap (2) AND the forming check both see the lag; on a thin declared reference
    // both are metrics
    const lagged = { ...clean, headGapBars: 2 };
    const r = judgeServe(thin, { facts: lagged, branch: null, ...at, newestMs: FORMING - 3 * H });
    expect(r).toMatchObject({ verdict: 'PASS', reasons: [], headGapBars: 2, headLagSlots: 2, headLagMs: 2 * H + (NOW - FORMING) });
    // the same facts on the LIQUID reference FAIL on both legs
    expect(judgeServe({ ...thin, reference: 'liquid' }, { facts: lagged, branch: null, ...at, newestMs: FORMING - 3 * H }).reasons).toEqual([
      `head gap 2 bars > ${HEAD_ALLOWANCE_BARS}: the window does not reach the venue's newest bar`,
      'head: newest bar 3 slot(s) before the forming bar (declared: 1 expected)',
    ]);
    // a thin declared window with no bar at all is still a FAIL
    expect(judgeServe(thin, { facts: { ...clean, inWindow: 0, emptyWindow: true, headGapBars: null }, branch: null, ...at, newestMs: null }).verdict).toBe('FAIL');
    // a non-declared venue's thin reference keeps the head-gap FAIL (the leg alone: its newest bar is the forming one)
    expect(judgeServe({ ...thin, venue: 'BITGET' }, { facts: lagged, branch: null, ...at }).reasons).toEqual([
      `head gap 2 bars > ${HEAD_ALLOWANCE_BARS}: the window does not reach the venue's newest bar`,
    ]);
    expect(judgeServe(thin, { facts: clean, branch: null, ...at }).reasons).toEqual(['head: a declared closed-only kline venue served its forming bar']);
    // the same head on the LIQUID reference FAILs
    expect(judgeServe({ ...thin, reference: 'liquid' }, { facts: clean, branch: null, ...at, newestMs: FORMING - 3 * H }).verdict).toBe('FAIL');
    // a non-declared venue's thin reference is held to its forming bar like any other window
    expect(judgeServe({ ...thin, venue: 'BITGET' }, { facts: clean, branch: null, ...at, newestMs: FORMING - H }).verdict).toBe('FAIL');
  });
  it('Q11: a SNAPSHOT_KLINE venue (ASTER) passes up to 2 slots and 90 s behind, FAILs beyond, and records the lag', () => {
    const M = 60_000;
    const a1: ServeWindow = { venue: 'ASTER', tf: '1m', window: 'trade_call@100', spanMs: 100 * M, servedStepMs: M, coin: 'BTC' };
    const F = Math.floor(NOW / M) * M;
    const read = (newestMs: number, calledAtMs = NOW) => ({ facts: clean, branch: null, newestMs, calledAtMs, answeredAtMs: calledAtMs });
    expect(judgeServe(a1, read(F))).toMatchObject({ verdict: 'PASS', headLagSlots: 0, headLagMs: 0 });
    expect(judgeServe(a1, read(F - 2 * M))).toMatchObject({ verdict: 'PASS', headLagSlots: 2, headLagMs: M + (NOW - F) });
    const tooOld = judgeServe(a1, read(F - 2 * M, F + SNAPSHOT_KLINE_MAX_LAG_MS - M + 1_000));
    expect(tooOld.verdict).toBe('FAIL');
    expect(tooOld.reasons[0]).toMatch(/^head: newest bar 2 slot\(s\) before the forming bar, closed 91 s before the read/);
    expect(judgeServe(a1, read(F - 2 * M, F + SNAPSHOT_KLINE_MAX_LAG_MS - M)).verdict).toBe('PASS'); // exactly 90 s
    expect(judgeServe(a1, read(F - 2 * M, F + SNAPSHOT_KLINE_MAX_LAG_MS - M + 1)).verdict).toBe('FAIL'); // 1 ms past
    expect(judgeServe(a1, read(F - 3 * M)).verdict).toBe('FAIL');
    expect(judgeServe({ ...a1, reference: 'thin', coin: 'AXIS' }, read(F - 5 * M))).toMatchObject({ verdict: 'PASS', headLagSlots: 5 });
  });
  it('every judged window carries its head lag; an unread one carries null', () => {
    expect(judgeServe(w, { facts: clean, branch: 'R', ...at })).toMatchObject({ headLagSlots: 0, headLagMs: 0 });
    expect(judgeServe(w, { facts: clean, branch: 'F', ...at, newestMs: FORMING - H })).toMatchObject({ headLagSlots: 1, headLagMs: NOW - FORMING });
    expect(judgeServe(w, { error: 'timeout' })).toMatchObject({ headLagSlots: null, headLagMs: null });
  });
});

describe('CH3a — the ticker leg (a declared closed-only kline venue must be able to price a call)', () => {
  it('PASS on a fresh last trade; FAIL when it is stale or missing; INDETERMINATE when unreadable', () => {
    expect(judgeTicker('PHEMEX', { lastTrade: { price: 81_782.9, atMs: NOW - 2_000 }, nowMs: NOW }).verdict).toBe('PASS');
    const stale = judgeTicker('PHEMEX', { lastTrade: { price: 81_782.9, atMs: NOW - LIVE_TICKER_MAX_AGE_MS - 1 }, nowMs: NOW });
    expect(stale.verdict).toBe('FAIL');
    expect(stale.reasons[0]).toMatch(/^PHEMEX cannot price a call: its ticker is from/);
    expect(judgeTicker('PHEMEX', { lastTrade: undefined, nowMs: NOW }).verdict).toBe('FAIL');
    expect(judgeTicker('PHEMEX', { error: 'UpstreamRateLimitError: 429' }).verdict).toBe('INDETERMINATE');
    expect(judgeTicker('PHEMEX', { lastTrade: undefined, nowMs: NOW })).toMatchObject({ venue: 'PHEMEX', tf: 'ticker', window: 'ticker:BTC' });
  });
  it('Q11: ASTER (SNAPSHOT_KLINE) needs a positive last price and no age bound', () => {
    expect(judgeTicker('ASTER', { lastTrade: { price: 81_699.9, atMs: NOW - 6 * H }, nowMs: NOW }).verdict).toBe('PASS');
    for (const lastTrade of [undefined, { price: 0, atMs: NOW }, { price: Number.NaN, atMs: NOW }]) {
      const r = judgeTicker('ASTER', { lastTrade, nowMs: NOW });
      expect(r.verdict).toBe('FAIL');
      expect(r.reasons).toEqual(['ASTER cannot price a call: its ticker carried no last price']);
    }
  });
});

describe('CH3a — the young-listing leg: screen, interleave, pace, judge', () => {
  const served = (_v: string, tf: string) => TF_MS[tf];
  const tfs = () => ['1h', '1d'];
  const longest = (tf: string) => Math.max(...servingSpans(tf, TF_MS[tf], TF_MS[tf]).map((x) => x.spanMs));
  /** bars from max(from, listing) through the forming bar (or one short) */
  const page = (from: number, tf: string, listingMs: number, short = false) => {
    const st = TF_MS[tf];
    const out: { time: number }[] = [];
    const end = Math.floor(NOW / st) * st - (short ? st : 0);
    for (let t = Math.ceil(Math.max(from, listingMs) / st) * st; t <= end; t += st) out.push({ time: t });
    return out;
  };

  it('the corpus groups per venue and keeps the most-recently-first-seen order', () => {
    expect(youngCandidatesByVenue([{ exchange: 'A', coin: 'N1' }, { exchange: 'B', coin: 'M1' }, { exchange: 'A', coin: 'N2' }])).toEqual({ A: ['N1', 'N2'], B: ['M1'] });
  });

  it('passes over an old, an empty and an erroring candidate, adopts the first young one, reads its every timeframe, interleaved and paced', async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    const listing: Record<string, number> = { OLD: Date.UTC(2019, 0, 1), YNG: NOW - 10 * 86_400_000, B1: NOW - 20 * 86_400_000 };
    const out = await probeYoung({
      venues: ['A', 'B', 'C'],
      candidates: { A: ['OLD', 'GONE', 'ERR', 'YNG', 'NEVER'], B: ['B1'], C: [] },
      nowMs: () => NOW,
      getCandles: async (venue, tf, from, coin) => {
        calls.push(`${venue}/${coin}/${tf}`);
        if (coin === 'GONE') return [];
        if (coin === 'ERR') throw new Error('symbol not found');
        return page(from, tf, listing[coin]);
      },
      served, timeframes: tfs, pace: async (ms) => { waits.push(ms); },
    });
    expect(out.refs).toEqual({ A: 'YNG', B: 'B1' });
    expect(out.none).toEqual(['C']);
    // the longest window (1d) screens; the first two rounds interleave A and B
    expect(calls.slice(0, 4)).toEqual(['A/OLD/1d', 'B/B1/1d', 'A/GONE/1d', 'B/B1/1h']);
    expect(calls).toContain('A/YNG/1h');
    expect(calls).not.toContain('A/NEVER/1d');
    expect(waits).toEqual(calls.map(() => PACE_MS));
    expect(out.results.map((r) => `${r.venue}/${r.tf}/${r.window}/${r.verdict}`).sort()).toEqual([
      `A/1d/young:YNG@${servingSpans('1d', TF_MS['1d'], TF_MS['1d']).find((x) => x.spanMs === longest('1d'))!.label}/PASS`,
      `A/1h/young:YNG@${servingSpans('1h', TF_MS['1h'], TF_MS['1h']).find((x) => x.spanMs === longest('1h'))!.label}/PASS`,
      `B/1d/young:B1@${servingSpans('1d', TF_MS['1d'], TF_MS['1d']).find((x) => x.spanMs === longest('1d'))!.label}/PASS`,
      `B/1h/young:B1@${servingSpans('1h', TF_MS['1h'], TF_MS['1h']).find((x) => x.spanMs === longest('1h'))!.label}/PASS`,
    ].sort());
  });

  it('a venue whose candidates are all old is listed in `none`, never failed; at most YOUNG_CANDIDATES_PER_VENUE are screened', async () => {
    const calls: string[] = [];
    const out = await probeYoung({
      venues: ['A'], candidates: { A: Array.from({ length: YOUNG_CANDIDATES_PER_VENUE + 3 }, (_, k) => `O${k}`) }, nowMs: () => NOW,
      getCandles: async (venue, tf, from, coin) => { calls.push(coin); return page(from, tf, Date.UTC(2019, 0, 1)); },
      served, timeframes: tfs, pace: async () => {},
    });
    expect(out).toEqual({ results: [], refs: {}, none: ['A'] });
    expect(calls.length).toBe(YOUNG_CANDIDATES_PER_VENUE);
  });

  it('two-way: a young window one bar short FAILs (the Bitget class), and a refused screen adopts the candidate as a FAIL', async () => {
    const out = await probeYoung({
      venues: ['A', 'B'], candidates: { A: ['Y'], B: ['R'] }, nowMs: () => NOW,
      getCandles: async (venue, tf, from) => {
        if (venue === 'B') throw new StaleUpstreamWindowError({ coin: 'R', exchange: 'B', timeframe: tf, newestBarAt: NOW - 2 * TF_MS[tf], headGapBars: 1, headStaleBars: 0 });
        return page(from, tf, NOW - 10 * 86_400_000, tf === '1h');
      },
      served, timeframes: tfs, pace: async () => {},
    });
    expect(out.refs).toEqual({ A: 'Y', B: 'R' });
    const a = out.results.filter((r) => r.venue === 'A');
    expect(a.map((r) => `${r.tf}/${r.verdict}`).sort()).toEqual(['1d/PASS', '1h/FAIL']);
    expect(a.find((r) => r.tf === '1h')!.reasons).toEqual(['head: newest bar 1 slot(s) before the forming bar']);
    expect(out.results.filter((r) => r.venue === 'B').every((r) => r.verdict === 'FAIL' && r.reasons[0].startsWith('STALE_UPSTREAM_WINDOW'))).toBe(true);
  });

  it('Q13: the young leg judges its reference as THIN — a declared venue\'s late thin bars PASS with their lag, its forming bar FAILs', async () => {
    // PHEMEX young (AGPU-like): 1h ends 3 slots before the forming bar, 1d serves its forming bar
    const lagging = (from: number, tf: string) => {
      const st = TF_MS[tf];
      const end = Math.floor(NOW / st) * st - (tf === '1h' ? 3 * st : 0);
      const out: { time: number }[] = [];
      for (let t = Math.ceil(Math.max(from, NOW - 10 * 86_400_000) / st) * st; t <= end; t += st) out.push({ time: t });
      return out;
    };
    const out = await probeYoung({
      venues: ['PHEMEX'], candidates: { PHEMEX: ['AGPU'] }, nowMs: () => NOW,
      getCandles: async (_v, tf, from) => lagging(from, tf), served, timeframes: tfs, pace: async () => {},
    });
    expect(out.refs).toEqual({ PHEMEX: 'AGPU' });
    expect(out.results.every((r) => r.reference === 'thin')).toBe(true);
    const h1 = out.results.find((r) => r.tf === '1h')!;
    expect(h1).toMatchObject({ verdict: 'PASS', reasons: [], headLagSlots: 2 });
    expect(out.results.find((r) => r.tf === '1d')!.reasons).toEqual(['head: a declared closed-only kline venue served its forming bar']);
  });

  it('YOUNG_FRONT_BARS is the screen: a listing exactly that many bars inside the window is not young', async () => {
    const st = TF_MS['1d'];
    const from = (NOW - longest('1d'));
    const edge = Math.ceil(from / st) * st + YOUNG_FRONT_BARS * st;
    const out = await probeYoung({
      venues: ['A'], candidates: { A: ['E'] }, nowMs: () => NOW,
      getCandles: async (_v, tf, f) => page(f, tf, tf === '1d' ? edge : NOW - 3 * 86_400_000),
      served, timeframes: tfs, pace: async () => {},
    });
    expect(out.none).toEqual(['A']);
  });
});

describe('servingProbePlan / probeServing — the registry, interleaved by venue, paced', () => {
  const served = (_v: string, tf: string) => TF_MS[tf];
  const tfs = () => ['1h', '1d'];

  it('derives every window from the registry (the derivation suite S reads) and never asks one venue twice in a row', () => {
    const plan = servingProbePlan(['A', 'B', 'C'], tfs, served);
    const want = ['1h', '1d'].flatMap((tf) => servingSpans(tf, TF_MS[tf], TF_MS[tf]).map((x) => `${tf}/${x.label}`));
    expect(want.length).toBeGreaterThanOrEqual(8);
    for (const v of ['A', 'B', 'C']) expect(plan.filter((p) => p.venue === v).map((p) => `${p.tf}/${p.window}`)).toEqual(want);
    expect(plan.every((p, i) => i === 0 || p.venue !== plan[i - 1].venue)).toBe(true);
    expect(plan.slice(0, 3).map((p) => p.venue)).toEqual(['A', 'B', 'C']);
  });

  it('skips a timeframe the venue does not serve (no served step)', () => {
    expect(servingProbePlan(['A'], tfs, (_v, tf) => (tf === '1d' ? null : TF_MS[tf])).every((p) => p.tf === '1h')).toBe(true);
  });

  it('asks every window as serving does (no endTime, from now − span), paces before EVERY call, and judges each', async () => {
    const calls: { venue: string; tf: string; from: number }[] = [];
    const waits: number[] = [];
    const res = await probeServing({
      venues: ['A', 'B'],
      nowMs: () => NOW,
      getCandles: async (venue, tf, from) => {
        calls.push({ venue, tf, from });
        if (venue === 'B' && tf === '1d') throw new StaleUpstreamWindowError({ coin: 'BTC', exchange: 'B', timeframe: '1d', newestBarAt: NOW - 11 * 86_400_000, headGapBars: 10, headStaleBars: 1 });
        if (venue === 'A' && tf === '1d') throw new Error('UpstreamRateLimitError: 429');
        const s = TF_MS[tf];
        const out: { time: number }[] = [];
        for (let t = Math.ceil(from / s) * s; t <= Math.floor(NOW / s) * s; t += s) out.push({ time: t });
        return out;
      },
      served,
      timeframes: tfs,
      pace: async (ms) => { waits.push(ms); },
    });
    const plan = servingProbePlan(['A', 'B'], tfs, served);
    expect(calls.map((c) => `${c.venue}/${c.tf}`)).toEqual(plan.map((p) => `${p.venue}/${p.tf}`));
    expect(calls.map((c) => NOW - c.from)).toEqual(plan.map((p) => p.spanMs));
    expect(waits).toEqual(plan.map(() => PACE_MS));
    const by = (v: ServeResult['verdict']) => res.filter((r) => r.verdict === v).map((r) => `${r.venue}/${r.tf}`);
    expect(new Set(by('PASS'))).toEqual(new Set(['A/1h', 'B/1h']));
    expect(new Set(by('FAIL'))).toEqual(new Set(['B/1d']));
    expect(new Set(by('INDETERMINATE'))).toEqual(new Set(['A/1d']));
    expect(res.find((r) => r.venue === 'B' && r.tf === '1d')!.reasons[0]).toContain('STALE_UPSTREAM_WINDOW');
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

  it('the shipped adapters are PASS on every pair; OKX/8h is never probed (unserved since CH2) (vacuity: ≥ 19 pairs judged)', async () => {
    const res = await runWith(shipped);
    const bad = res.filter((r) => r.verdict !== 'PASS' && r.verdict !== 'SKIPPED').map((r) => `${r.venue}/${r.tf} ${r.verdict} ${r.reasons.join('; ')}`);
    expect(bad).toEqual([]);
    expect(res.filter((r) => r.verdict === 'SKIPPED').map((r) => `${r.venue}/${r.tf}`)).toEqual([]);
    expect(res.some((r) => r.venue === 'OKX' && r.tf === '8h')).toBe(false);
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

  const runServing = (impl: typeof shipped | typeof retired) => probeServing({
    venues: ['BITGET', 'OKX'],
    nowMs: () => NOW,
    getCandles: async (v, tf, from) => {
      venue.current = new SyntheticVenue(v as V, () => NOW, () => ({ listingMs: Date.UTC(2020, 0, 1) }));
      try { return await impl[v as V]('BTC', tf, from); } finally { venue.current = null; }
    },
    served: (v, tf) => served[v as V](tf),
    timeframes: (v) => TIMEFRAMES.filter((tf) => isTimeframeFaithful(v as ExchangeId, tf)),
    pace: async () => {},
  });

  it('S: the shipped adapters serve every registry window head-complete (vacuity: ≥ 60 windows, 21 pairs)', async () => {
    const res = await runServing(shipped);
    expect(res.filter((r) => r.verdict !== 'PASS').map((r) => `${r.venue}/${r.tf}/${r.window} ${r.reasons.join('; ')}`)).toEqual([]);
    expect(res.length).toBeGreaterThanOrEqual(60);
    expect(new Set(res.map((r) => `${r.venue}/${r.tf}`)).size).toBe(21); // BITGET 11 + OKX 10 (8h unserved)
    expect(aggregate(res)).toBe('PASS');
  });

  it('S: the RETIRED bodies FAIL on exactly the two windows R0 measured stale in production', async () => {
    const res = await runServing(retired);
    expect(res.filter((r) => r.verdict === 'FAIL').map((r) => `${r.venue}/${r.tf}/${r.window}`).sort()).toEqual([
      'BITGET/1d/trade_call@100+market_regime@100',
      'OKX/1h/market_regime@168',
    ]);
    expect(aggregate(res)).toBe('FAIL');
  });

  it('CH3a Y: the shipped Bitget/OKX serve a YOUNG synthetic listing (4.5 d, and 30 d) on every faithful timeframe, forming bar included', async () => {
    for (const ageDays of [4.5, 30]) {
      const out = await probeYoung({
        venues: ['BITGET', 'OKX'],
        candidates: { BITGET: ['YNG'], OKX: ['YNG'] },
        nowMs: () => NOW,
        getCandles: async (v, tf, from) => {
          venue.current = new SyntheticVenue(v as V, () => NOW, () => ({ listingMs: NOW - ageDays * 86_400_000 }));
          try { return await shipped[v as V]('BTC', tf, from); } finally { venue.current = null; }
        },
        served: (v, tf) => served[v as V](tf),
        timeframes: (v) => TIMEFRAMES.filter((tf) => isTimeframeFaithful(v as ExchangeId, tf)),
        pace: async () => {},
      });
      expect(out.refs, `${ageDays} d`).toEqual({ BITGET: 'YNG', OKX: 'YNG' });
      expect(out.results.filter((r) => r.verdict !== 'PASS').map((r) => `${ageDays} d ${r.venue}/${r.tf}/${r.window} ${r.reasons.join('; ')}`)).toEqual([]);
      expect(new Set(out.results.map((r) => `${r.venue}/${r.tf}`)).size).toBe(21);
    }
  });

  it('the accounting the canary uses is the ONE accounting (no second derivation)', () => {
    const a = accountPage({ bars: [], servedStepMs: H, from: NOW - 10 * H, to: NOW - 5 * H, nowMs: NOW });
    expect(a.emptyWindow).toBe(true);
  });
});
