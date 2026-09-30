/**
 * adapter-history-differential.test.ts — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2: the retired vs the rewired Bitget /
 * OKX getCandles, on the synthetic venue (proven page-for-page against the captures by
 * adapter-history-synthetic-fidelity.test.ts). The retired bodies are pinned verbatim in
 * tests/fixtures/adapter-history/retired/ (LRW-Q9(b) shape).
 *
 *   (a) SERVING byte-identical (OAH-Q6): every serving-shaped call — get_trade_call / scan (100 bars), the
 *       ATRP rank lens (50 bars), get_market_regime (1h 168 · 4h 42 · 1d 100) — on every timeframe, for a long-
 *       listed coin AND for young coins listed inside the lookback (the F branch serving reaches), returns the
 *       SAME bars, time and OHLCV. The AC is DERIVED, not hoped: per pair it asserts
 *       HISTORY_PAGE_CAP × served step ≥ lookback, the inequality under which the new anchor cannot move a
 *       serving window.
 *   (b) history identical on every non-violator pair (same-grid Bitget tfs, every OKX tf).
 *   (c) on the violator pairs (Bitget 2h served 1H, 8h served 6H) the only difference is EXACTLY the slots the
 *       retired page was missing inside the window — counted per case.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { SyntheticVenue } from '../harness/adapter-history-synthetic.js';
import { accountPage, historyMetaOf } from '../../src/lib/adapters/_history-plan.js';

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
  BITGET: { now: (c: string, tf: string, s: number, e?: number) => new bitget.BitgetAdapter().getCandles(c, tf, s, undefined, e), old: retiredBitget, served: bitget.servedIntervalMs, cap: bitget.HISTORY_PAGE_CAP },
  OKX: { now: (c: string, tf: string, s: number, e?: number) => new okx.OKXAdapter().getCandles(c, tf, s, undefined, e), old: retiredOkx, served: okx.servedIntervalMs, cap: okx.HISTORY_PAGE_CAP },
} as const;
const TFS = ['1m', ...CRON_TIMEFRAMES];
const NOWS = [Date.UTC(2026, 8, 30, 3, 7, 11), Date.UTC(2026, 8, 30, 16, 59, 59), Date.UTC(2026, 9, 1, 0, 0, 0)];
const REGIME: Record<string, number> = { '1h': 168, '4h': 42, '1d': 100 };
const shapesFor = (tf: string) => [['trade_call', 100], ['atrp', 50], ...(REGIME[tf] ? [['regime', REGIME[tf]]] : [])] as [string, number][];

let clock = 0;
beforeAll(() => { vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1_000)); });
afterAll(() => { vi.restoreAllMocks(); });

async function both(v: V, nowMs: number, listingMs: number, coin: string, tf: string, start: number, end?: number) {
  venue.current = new SyntheticVenue(v, () => nowMs, () => ({ listingMs }));
  const run = async (f: () => Promise<Candle[]>) => {
    calls.n = 0;
    try { const bars = await f(); return { bars, err: null as string | null, requests: calls.n }; }
    catch (e) { return { bars: [] as Candle[], err: (e as Error).message, requests: calls.n }; }
  };
  const a = await run(() => ADAPTERS[v].old(coin, tf, start));
  const b = await run(() => ADAPTERS[v].now(coin, tf, start, end));
  venue.current = null;
  return { old: a, now: b };
}

describe('(a) serving-shaped calls are byte-identical, retired vs rewired', () => {
  const cases: [V, string, string, number][] = [];
  for (const v of ['BITGET', 'OKX'] as V[]) for (const tf of TFS) for (const [shape, n] of shapesFor(tf)) cases.push([v, tf, shape, n]);

  it('covers every venue × timeframe × serving shape (vacuity guard)', () => { expect(cases.length).toBeGreaterThanOrEqual(2 * TFS.length * 2); });

  it.each(cases)('%s %s %s (%i bars)', async (v, tf, _shape, n) => {
    const lookback = n * TF_MS[tf];
    const served = ADAPTERS[v].served(tf);
    // The derived AC: the new anchor (start + cap × served) cannot move a serving window when EITHER the venue
    // serves the requested step (the anchor is numerically the retired one) OR one page of served bars spans the
    // whole lookback. OKX 1h regime (168 bars > the 100-bar page) is the first case: it reads a history page
    // ending ~68 h before now today and keeps doing so — a recorded serving defect (OPS-SERVED-CANDLE-TRUTH-W1),
    // byte-identical by construction and by the comparison below.
    if (served != null) {
      const anchorUnchanged = served === TF_MS[tf];
      expect(anchorUnchanged || ADAPTERS[v].cap * served >= lookback, 'derived AC: the new anchor cannot move this serving window').toBe(true);
    }
    let compared = 0;
    for (const now of NOWS) {
      const start = now - lookback;
      // a long-listed coin, and young coins listed inside the lookback (the F branch serving reaches)
      for (const listingMs of [Date.UTC(2019, 0, 1), now - 0.3 * lookback, now - 0.7 * lookback, now - 0.95 * lookback, now - 1.05 * lookback]) {
        const r = await both(v, now, listingMs, 'BTC', tf, start);
        expect(r.now.err).toBe(r.old.err);
        expect(JSON.stringify(r.now.bars)).toBe(JSON.stringify(r.old.bars));
        compared++;
      }
    }
    expect(compared).toBe(NOWS.length * 5);
  });
});

describe('(a′) the recent-branch ROUTING guard is byte-identical at its boundary (OAH-Q4)', () => {
  // The guard accepts the recent page when its oldest bar is at most 5 REQUESTED bars after startTime. Walk
  // startTime across that boundary — the recent page (newest RECENT_PAGE_CAP served bars) starting 0…12
  // requested bars after startTime — and require the retired and the rewired adapter to take the same branch and
  // return the same bars. A widened or narrowed tolerance re-routes serving and reddens this.
  const RECENT = { BITGET: bitget.RECENT_PAGE_CAP, OKX: okx.RECENT_PAGE_CAP };
  const cases: [V, string][] = [];
  for (const v of ['BITGET', 'OKX'] as V[]) for (const tf of ['5m', '1h', '2h', '4h', '8h', '1d']) cases.push([v, tf]);
  it.each(cases)('%s %s', async (v, tf) => {
    const served = ADAPTERS[v].served(tf);
    if (served == null || (v === 'OKX' && tf === '8h')) return;
    const now = NOWS[0];
    let compared = 0;
    for (let k = 0; k <= 12; k++) {
      // the recent page's oldest bar opens (RECENT − 1) served slots before the current one
      const oldest = now - (now % served) - (RECENT[v] - 1) * served;
      const start = oldest - k * TF_MS[tf] + 1; // the oldest bar sits ~k requested bars after startTime
      const r = await both(v, now, Date.UTC(2019, 0, 1), 'BTC', tf, start);
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
    if (r.old.err || r.now.err) { expect(r.now.err).toBe(r.old.err); return; } // OKX/8h: the venue rejects the bar
    const inW = (bars: Candle[]) => bars.map((c) => c.time).filter((t) => t >= from && t < to);
    const oldIn = inW(r.old.bars), newIn = inW(r.now.bars);
    const facts = accountPage({ bars: r.now.bars.map((c) => ({ ts: c.time })), servedStepMs: served, from, to, nowMs: now });
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
