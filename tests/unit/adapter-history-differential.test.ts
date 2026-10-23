/**
 * adapter-history-differential.test.ts — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2: the retired vs the rewired Bitget /
 * OKX getCandles, on the synthetic venue (proven page-for-page against the captures by
 * adapter-history-synthetic-fidelity.test.ts). The retired bodies are pinned verbatim in
 * tests/fixtures/adapter-history/retired/ (LRW-Q9(b) shape).
 *
 *   (a) SERVING (OPS-SERVED-CANDLE-TRUTH-W1 CH1, Cowork Q3a): every window the serving-window registry declares
 *       (src/lib/serving-windows.ts SERVING_WINDOWS), on every timeframe, for a long-listed coin AND for young coins
 *       listed inside the lookback. A case whose RETIRED page was head-incomplete is a defect case, and its rewired
 *       page must be head-complete (head gap ≤ HEAD_ALLOWANCE_BARS). Every other case is byte-identical, bars and
 *       error. The defect set is DERIVED from the retired output, never listed by hand, and must be exactly the two
 *       pairs R0 measured stale in production: OKX 1h@168 (a 100-bar recent page, so the history fallback ended
 *       ~68 h before now) and BITGET 1d@100 (a 90-day recent endpoint, so the page ended ~10 days before now). The
 *       retired note here called the first "byte-identical by construction". It was, and it was the defect.
 *   (a′) ROUTING. The history read (`endTime` given) keeps the retired routing at its RECENT_PAGE_CAP boundary,
 *       branch and bars. A SERVING read routes by the venue's declared single-request serving reach
 *       (`servingReachBars`). OKX 1h@168 fits one request and routes R; BITGET 1d@100 does not and routes A. At the
 *       reach boundary it never takes the history fallback, it is always head-complete, and the assembler stays
 *       inside SERVING_MAX_PAGES.
 *   (b) history identical on every non-violator pair (same-grid Bitget tfs, every OKX tf).
 *   (c) on the violator pairs (Bitget 2h served 1H, 8h served 6H) the only difference is EXACTLY the slots the
 *       retired page was missing inside the window — counted per case.
 *
 * The adapters read Date.now() for their serving decisions, so each read pair runs on a clock anchored at the
 * venue's own now. That clock may only move FORWARD, or the OKX throttle sleeps for the gap, so every pair runs one
 * whole week later than the last. A week keeps every timeframe's grid and every UTC+8 phase, and the pair's bars,
 * windows and listing all move with it (`r.shift`). Within a pair the clock advances 1 s per call, so the throttle
 * never sleeps.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { SyntheticVenue } from '../harness/adapter-history-synthetic.js';
import { accountPage, historyMetaOf, HEAD_ALLOWANCE_BARS } from '../../src/lib/adapters/_history-plan.js';
import { SERVING_MAX_PAGES } from '../../src/lib/serving-windows.js';
import { servingSpans } from '../harness/serving-spans.js';

const { venue, calls } = vi.hoisted(() => ({ venue: { current: null as null | { answer(url: string): unknown } }, calls: { n: 0 } }));
vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
    if (!venue.current) throw new Error('differential: no venue');
    calls.n++;
    return venue.current.answer(req.url);
  }),
}));

import * as bitget from '../../src/lib/adapters/bitget.js';
import * as okx from '../../src/lib/adapters/okx.js';
import { retiredGetCandles as retiredBitget } from '../fixtures/adapter-history/retired/bitget-getcandles.js';
import { retiredGetCandles as retiredOkx } from '../fixtures/adapter-history/retired/okx-getcandles.js';
import { CRON_TIMEFRAMES } from '../../src/lib/tf-support.js';
import { TF_MS } from '../../src/lib/pfe-mae.js';
import type { Candle } from '../../src/types.js';

type V = 'BITGET' | 'OKX';
const ADAPTERS = {
  BITGET: { now: (c: string, tf: string, s: number, e?: number) => new bitget.BitgetAdapter().getCandles(c, tf, s, undefined, e), old: retiredBitget, served: bitget.servedIntervalMs, cap: bitget.HISTORY_PAGE_CAP, recentCap: bitget.RECENT_PAGE_CAP, reach: bitget.servingReachBars },
  OKX: { now: (c: string, tf: string, s: number, e?: number) => new okx.OKXAdapter().getCandles(c, tf, s, undefined, e), old: retiredOkx, served: okx.servedIntervalMs, cap: okx.HISTORY_PAGE_CAP, recentCap: okx.RECENT_PAGE_CAP, reach: okx.servingReachBars },
} as const;
const TFS = ['1m', ...CRON_TIMEFRAMES];
const NOWS = [Date.UTC(2026, 8, 30, 3, 7, 11), Date.UTC(2026, 8, 30, 16, 59, 59), Date.UTC(2026, 9, 1, 0, 0, 0)];
/** The registry's distinct serving windows on `tf`, in ms back from now (tests/harness/serving-spans.ts). */
const spansOf = (v: V, tf: string) => servingSpans(tf, ADAPTERS[v].served(tf));

const WEEK = 7 * 86_400_000;
let clock = 0;
let weeks = 0;
beforeAll(() => { vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1_000)); });
afterAll(() => { vi.restoreAllMocks(); });

async function both(v: V, nowMs: number, listingMs: number, coin: string, tf: string, start: number, end?: number) {
  const shift = ++weeks * WEEK;
  const venueNow = nowMs + shift;
  venue.current = new SyntheticVenue(v, () => venueNow, () => ({ listingMs: listingMs + shift }));
  clock = venueNow;
  const run = async (f: () => Promise<Candle[]>) => {
    calls.n = 0;
    try { const bars = await f(); return { bars, err: null as string | null, requests: calls.n }; }
    catch (e) { return { bars: [] as Candle[], err: (e as Error).message, requests: calls.n }; }
  };
  const a = await run(() => ADAPTERS[v].old(coin, tf, start + shift));
  const b = await run(() => ADAPTERS[v].now(coin, tf, start + shift, end === undefined ? undefined : end + shift));
  venue.current = null;
  return { old: a, now: b, shift };
}

/** A serving page's head gap on the served grid (null = no bar in the window). */
function headGap(bars: Candle[], served: number, from: number, nowMs: number): number | null {
  return accountPage({ bars: bars.map((c) => ({ ts: c.time })), servedStepMs: served, from, to: null, nowMs }).headGapBars;
}

describe('(a) serving windows: head-complete where the retired page was stale, byte-identical everywhere else', () => {
  const cases: [V, string, string, number][] = [];
  for (const v of ['BITGET', 'OKX'] as V[]) for (const tf of TFS) for (const { label, spanMs } of spansOf(v, tf)) cases.push([v, tf, label, spanMs]);
  const defects = new Set<string>();
  const formingDefects = new Set<string>();

  it('covers every venue × timeframe × registry window (vacuity guard)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(2 * TFS.length * 3);
    expect(cases.some(([v, tf, l]) => v === 'OKX' && tf === '1h' && l.includes('market_regime@168'))).toBe(true);
    expect(cases.some(([v, tf, l]) => v === 'BITGET' && tf === '1d' && l.includes('market_regime@100'))).toBe(true);
  });

  it.each(cases)('%s %s %s', async (v, tf, label, lookback) => {
    const served = ADAPTERS[v].served(tf);
    let compared = 0;
    for (const now of NOWS) {
      const start = now - lookback;
      // a long-listed coin, and young coins listed inside the lookback (the F branch serving reaches)
      for (const listingMs of [Date.UTC(2019, 0, 1), now - 0.3 * lookback, now - 0.7 * lookback, now - 0.95 * lookback, now - 1.05 * lookback]) {
        const r = await both(v, now, listingMs, 'BTC', tf, start);
        compared++;
        if (served == null) {
          // OPS-SERVED-CANDLE-TRUTH-W1 CH2: the rewired adapter refuses a timeframe its map does not hold (OKX 8h)
          // before any request. The retired body asked the venue, which rejected the bar.
          expect(r.now.err, `${v} ${tf} ${label}`).toMatch(/^OKX does not serve the 8h timeframe/);
          expect(r.now.requests, `${v} ${tf} ${label}: a refused read makes no request`).toBe(0);
          expect(r.old.err, `${v} ${tf} ${label}: the retired body reached the venue`).not.toBeNull();
          continue;
        }
        const oldHead = r.old.err ? null : headGap(r.old.bars, served, start + r.shift, now + r.shift);
        if (oldHead !== null && oldHead > HEAD_ALLOWANCE_BARS) {
          defects.add(`${v} ${tf} ${label}`);
          expect(r.now.err, `${v} ${tf} ${label}: the rewired read errs`).toBeNull();
          const newHead = headGap(r.now.bars, served, start + r.shift, now + r.shift);
          expect(newHead, `${v} ${tf} ${label} listed ${listingMs}: the rewired page is head-complete`).not.toBeNull();
          expect(newHead!).toBeLessThanOrEqual(HEAD_ALLOWANCE_BARS);
          expect(r.now.requests).toBeLessThanOrEqual(SERVING_MAX_PAGES);
          continue;
        }
        // OPS-SERVED-CANDLE-TRUTH-W1 CH3a (Cowork Q5): the second defect class, invisible to closed-bar arithmetic. A
        // retired page whose newest bar is not the venue's forming bar (a young listing routed to Bitget's closed-only
        // history endpoint) must now end ON the forming bar, through the serving assembler, with every bar it held
        // unchanged: the fix adds exactly the forming bar.
        const vNow = now + r.shift;
        const formingOn = (t: number) => vNow - (((vNow - t) % served) + served) % served; // the slot holding now, on t's grid
        const oldNewest = r.old.bars.length > 0 ? r.old.bars[r.old.bars.length - 1].time : null;
        if (!r.old.err && oldNewest !== null && oldNewest !== formingOn(oldNewest)) {
          const id = `${v} ${tf} ${label} listed ${listingMs}`;
          if (vNow === formingOn(oldNewest)) {
            // NOWS[2] sits exactly on the grid: the forming slot opens at this very instant, and no venue can be required
            // to hold a bar opened 0 ms ago (OKX's history page, anchored on an aligned start, ends there by `after`).
            // The rewired page keeps every retired bar and adds at most that one.
            expect(r.now.err, `${id}: the rewired read errs`).toBeNull();
            expect(JSON.stringify(r.now.bars.slice(0, r.old.bars.length)), `${id}: every retired bar unchanged`).toBe(JSON.stringify(r.old.bars));
            expect(r.now.bars.length - r.old.bars.length, id).toBeLessThanOrEqual(1);
            continue;
          }
          formingDefects.add(`${v} ${tf} ${label}`);
          expect(r.now.err, `${id}: the rewired read errs`).toBeNull();
          const newest = r.now.bars[r.now.bars.length - 1].time;
          expect(newest, `${id}: the rewired page ends on the forming bar`).toBe(formingOn(newest));
          expect(JSON.stringify(r.now.bars.slice(0, -1)), `${id}: every retired bar unchanged`).toBe(JSON.stringify(r.old.bars));
          const meta = historyMetaOf(r.now.bars);
          expect(meta?.branch, `${id}: a serving read never takes the history fallback`).toBe('A');
          expect(meta?.headClosedOnly, id).toBe(false);
          expect(r.now.requests).toBeLessThanOrEqual(SERVING_MAX_PAGES);
          continue;
        }
        expect(r.now.err).toBe(r.old.err);
        expect(JSON.stringify(r.now.bars), `${v} ${tf} ${label} listed ${listingMs}`).toBe(JSON.stringify(r.old.bars));
      }
    }
    expect(compared).toBe(NOWS.length * 5);
  });

  it('the defect set is EXACTLY the two pairs R0 measured stale in production (derived, not listed)', () => {
    expect([...defects].sort()).toEqual([
      'BITGET 1d trade_call@100+market_regime@100',
      'OKX 1h market_regime@168',
    ]);
  });

  it('the forming-bar defect set is derived: Bitget young listings on every timeframe class, never OKX (its history endpoint carries the forming bar)', () => {
    const set = [...formingDefects];
    expect(set.length).toBeGreaterThan(10);
    expect(set.filter((d) => !d.startsWith('BITGET ')), 'an OKX young listing never lost its forming bar').toEqual([]);
    expect(set).toContain('BITGET 1d trade_call@100+market_regime@100');
    expect(set).toContain('BITGET 1h market_regime@168');
    expect(set).toContain('BITGET 5m trade_call@100');
  });
});

describe('(a′) routing: history keeps the retired boundary; serving routes by the declared serving reach', () => {
  // The guard accepts the recent page when its oldest bar is at most 5 REQUESTED bars after startTime. Walk startTime
  // across that boundary — the recent page starting 0…12 requested bars after startTime. For a HISTORY read
  // (endTime given) the retired and the rewired adapter take the same branch and return the same bars; a widened or
  // narrowed tolerance re-routes history and reddens this.
  const cases: [V, string][] = [];
  for (const v of ['BITGET', 'OKX'] as V[]) for (const tf of ['5m', '1h', '2h', '4h', '8h', '1d']) cases.push([v, tf]);
  const walk = (v: V, tf: string, pageBars: number) => {
    const served = ADAPTERS[v].served(tf)!;
    const now = NOWS[0];
    // the recent page's oldest bar opens (pageBars − 1) served slots before the current one
    const oldest = now - (now % served) - (pageBars - 1) * served;
    return Array.from({ length: 13 }, (_, k) => ({ k, now, start: oldest - k * TF_MS[tf] + 1 }));
  };

  it.each(cases)('history %s %s: retired == rewired at the RECENT_PAGE_CAP boundary', async (v, tf) => {
    const served = ADAPTERS[v].served(tf);
    if (served == null) return; // OKX 8h: refused before any request ((a) pins it)
    let compared = 0;
    for (const { k, now, start } of walk(v, tf, ADAPTERS[v].recentCap)) {
      const r = await both(v, now, Date.UTC(2019, 0, 1), 'BTC', tf, start, now);
      expect(r.now.err).toBe(r.old.err);
      // the SAME branch: the retired body took R iff it made one request; the rewired page says so in its meta
      const oldBranch = r.old.requests === 1 ? 'R' : 'F';
      expect(historyMetaOf(r.now.bars)?.branch, `${v} ${tf} k=${k} routed differently`).toBe(oldBranch);
      // the SAME bars whenever the anchor cannot have moved: the R branch, or a pair served on its requested step
      if (oldBranch === 'R' || served === TF_MS[tf]) expect(JSON.stringify(r.now.bars), `${v} ${tf} k=${k}`).toBe(JSON.stringify(r.old.bars));
      compared++;
    }
    expect(compared).toBe(13);
  });

  it.each(cases)('serving %s %s: never the history fallback, always head-complete, at the declared serving reach', async (v, tf) => {
    const served = ADAPTERS[v].served(tf);
    const reach = ADAPTERS[v].reach(tf);
    if (served == null || reach == null) return; // OKX 8h: refused before any request ((a) pins it)
    const branches = new Set<string>();
    for (const { k, now, start } of walk(v, tf, reach)) {
      const r = await both(v, now, Date.UTC(2019, 0, 1), 'BTC', tf, start);
      expect(r.now.err).toBeNull();
      const branch = historyMetaOf(r.now.bars)?.branch;
      branches.add(branch ?? 'none');
      expect(branch === 'R' || branch === 'A', `${v} ${tf} k=${k}: a serving read took ${branch}`).toBe(true);
      expect(branch === 'R' ? r.now.requests === 1 : r.now.requests >= 1 && r.now.requests <= SERVING_MAX_PAGES, `${v} ${tf} k=${k}: ${r.now.requests} requests on ${branch}`).toBe(true);
      const head = headGap(r.now.bars, served, start + r.shift, now + r.shift);
      expect(head !== null && head <= HEAD_ALLOWANCE_BARS, `${v} ${tf} k=${k}: head gap ${head}`).toBe(true);
    }
    expect(branches.size, `${v} ${tf}: the walk crossed the reach boundary`).toBeGreaterThan(0);
  });

  it('the two R0 pairs route by the declared reach: OKX 1h@168 → R (fits one request), BITGET 1d@100 → A', async () => {
    const pairs: [V, string, number][] = [['OKX', '1h', 168], ['BITGET', '1d', 100]];
    for (const [v, tf, window] of pairs) {
      const served = ADAPTERS[v].served(tf)!;
      const expected = Math.ceil((window * TF_MS[tf]) / served) <= ADAPTERS[v].reach(tf)! ? 'R' : 'A';
      expect(expected).toBe(v === 'OKX' ? 'R' : 'A');
      for (const now of NOWS) {
        const r = await both(v, now, Date.UTC(2019, 0, 1), 'BTC', tf, now - window * TF_MS[tf]);
        expect(historyMetaOf(r.now.bars)?.branch, `${v} ${tf}@${window} at ${new Date(now).toISOString()}`).toBe(expected);
        expect(r.now.requests).toBe(expected === 'R' ? 1 : 2);
      }
    }
  });
});

describe('(b)+(c) history windows: identical on non-violators, exactly the missing slots on violators', () => {
  const cases: [V, string, number][] = [];
  for (const v of ['BITGET', 'OKX'] as V[]) for (const tf of CRON_TIMEFRAMES) for (const depth of [1.1, 3, 10]) cases.push([v, tf, depth]);

  it.each(cases)('%s %s depth ×%s page', async (v, tf, depth) => {
    const served = ADAPTERS[v].served(tf);
    if (served == null) return;
    const now = NOWS[0];
    const W = { '3m': 12, '5m': 12, '15m': 12, '30m': 8, '1h': 8, '2h': 6, '4h': 6, '8h': 4, '12h': 4, '1d': 3 }[tf] ?? 6;
    const from = now - depth * ADAPTERS[v].cap * served - 17_000; // off-grid
    const to = from + 2 * W * served;
    const r = await both(v, now, Date.UTC(2019, 0, 1), 'BTC', tf, from, to);
    if (r.old.err || r.now.err) { expect(r.now.err).toBe(r.old.err); return; } // a venue error is the retired body's error
    const inW = (bars: Candle[]) => bars.map((c) => c.time).filter((t) => t >= from + r.shift && t < to + r.shift);
    const oldIn = inW(r.old.bars), newIn = inW(r.now.bars);
    const facts = accountPage({ bars: r.now.bars.map((c) => ({ ts: c.time })), servedStepMs: served, from: from + r.shift, to: to + r.shift, nowMs: now + r.shift });
    expect(facts.emptyWindow || facts.frontGapBars || facts.gapSlots || facts.headGapBars, 'the rewired page covers the window').toBeFalsy();
    const violator = v === 'BITGET' && (tf === '2h' || tf === '8h');
    if (!violator) {
      expect(JSON.stringify(r.now.bars)).toBe(JSON.stringify(r.old.bars));
      return;
    }
    const added = newIn.filter((t) => !oldIn.includes(t));
    const removed = oldIn.filter((t) => !newIn.includes(t));
    expect(removed).toEqual([]);
    expect(added.length, 'the fix adds exactly the slots the retired page missed').toBe(facts.expectedSlots - oldIn.length);
    expect(added.length).toBeGreaterThan(0);
  });
});
