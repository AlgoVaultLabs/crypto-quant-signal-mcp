/**
 * adapter-history-budget.test.ts — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2: what the served-step anchor costs, in
 * INTEGER pages per span (never a ratio: ×2 / ×4⁄3 are per-hour asymptotes; at the labelers' real spans the 8h
 * delta is 0 — measured in R0 §P7).
 *
 * The caller model is a NEUTRAL paging loop: ask from the cursor, move the cursor 1 ms past the newest bar
 * returned, stop at the span end. It is deliberately not the labelers' own advance rule (LRW-owned, and measured
 * in R0 to skip a slot itself: advancing by the REQUESTED tf skips a served slot on 2h/8h, and an on-grid cursor
 * loses OKX's strict-`before` boundary slot), so every hole it sees is the adapter's. It runs with the retired
 * and the rewired getCandles on the synthetic venue for every Bitget/OKX pair. Asserted:
 *   - every pair other than BITGET 2h / 8h: the SAME bars and the SAME number of venue requests (delta 0);
 *   - BITGET 2h / 8h: the rewired loop leaves strictly fewer holes than the retired one, and the request count
 *     is printed (the metered cost; the venue ceilings are untouched by this wave);
 *   - every hole the rewired loop still sees is REPORTED by the pages' own meta (OAH-Q4: the recent-branch
 *     guard keeps tolerating a front gap of up to 5 requested bars as a ROUTING predicate — it is reported,
 *     never absorbed).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { SyntheticVenue } from '../harness/adapter-history-synthetic.js';
import { accountPage, historyMetaOf } from '../../src/lib/adapters/_history-plan.js';

const { venue, calls } = vi.hoisted(() => ({ venue: { current: null as null | { answer(url: string): unknown } }, calls: { n: 0 } }));
vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
    calls.n++;
    if (!venue.current) throw new Error('budget: no venue');
    return venue.current.answer(req.url);
  }),
}));

import * as bitget from '../../src/lib/adapters/bitget.js';
import * as okx from '../../src/lib/adapters/okx.js';
import { retiredGetCandles as retiredBitget } from '../fixtures/adapter-history/retired/bitget-getcandles.js';
import { retiredGetCandles as retiredOkx } from '../fixtures/adapter-history/retired/okx-getcandles.js';
import { CRON_TIMEFRAMES } from '../../src/lib/tf-support.js';
import { TF_MS } from '../../src/lib/pfe-mae.js';
import { EVAL_CANDLES } from '../../src/scripts/directional-labeler.js';
import type { Candle } from '../../src/types.js';

type V = 'BITGET' | 'OKX';
const NEW = { BITGET: (c: string, tf: string, s: number, e?: number) => new bitget.BitgetAdapter().getCandles(c, tf, s, undefined, e), OKX: (c: string, tf: string, s: number, e?: number) => new okx.OKXAdapter().getCandles(c, tf, s, undefined, e) };
const OLD = { BITGET: retiredBitget, OKX: retiredOkx };
const SERVED = { BITGET: bitget.servedIntervalMs, OKX: okx.servedIntervalMs };
const NOW = Date.UTC(2026, 8, 30, 3, 7, 11);

let clock = 0;
beforeAll(() => { vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1_000)); });
afterAll(() => { vi.restoreAllMocks(); });

/** The neutral paging loop over [from, end): returns every bar collected and the venue requests it cost. */
async function page(fetch: (c: string, tf: string, s: number, e?: number) => Promise<Candle[]>, tf: string, from: number, end: number) {
  const got = new Map<number, Candle>();
  let cursor = from;
  let reportedFront = 0;
  calls.n = 0;
  for (let guard = 0; cursor < end && guard < 1_000; guard++) {
    let bars: Candle[] = [];
    try { bars = await fetch('BTC', tf, cursor, end); } catch { break; }
    reportedFront += historyMetaOf(bars)?.frontGapBars ?? 0;
    const fresh = bars.filter((b) => b.time >= cursor && b.time < end);
    if (fresh.length === 0) break;
    for (const b of fresh) got.set(b.time, b);
    cursor = Math.max(...fresh.map((b) => b.time)) + 1;
  }
  return { bars: [...got.values()].sort((a, b) => a.time - b.time), requests: calls.n, reportedFront };
}

const rows: string[] = [];
afterAll(() => { console.log(['BUDGET pair | span h | requests before -> after | holes before -> after', ...rows].join('\n')); });

describe('integer page cost per span, retired vs rewired', () => {
  const cases: [V, string, string][] = [];
  for (const v of ['BITGET', 'OKX'] as V[]) for (const tf of CRON_TIMEFRAMES) for (const span of ['sigma', 'long']) cases.push([v, tf, span]);

  it.each(cases)('%s %s %s span', async (v, tf, span) => {
    const served = SERVED[v](tf);
    if (served == null) return;
    const W = EVAL_CANDLES[tf];
    const spanMs = span === 'sigma' ? (60 * W + 2) * TF_MS[tf] : 10 * 200 * served;
    const from = NOW - spanMs - 3 * 24 * 3_600_000 - 17_000; // ends 3 days before now, off-grid
    const end = from + spanMs;
    venue.current = new SyntheticVenue(v, () => NOW, () => ({ listingMs: Date.UTC(2019, 0, 1) }));
    const before = await page(OLD[v], tf, from, end);
    const after = await page(NEW[v], tf, from, end);
    venue.current = null;
    const holes = (bars: Candle[]) => {
      const f = accountPage({ bars: bars.map((b) => ({ ts: b.time })), servedStepMs: served, from, to: end, nowMs: NOW });
      return f.emptyWindow ? f.expectedSlots : (f.frontGapBars ?? 0) + f.gapSlots + (f.headGapBars ?? 0);
    };
    const hb = holes(before.bars), ha = holes(after.bars);
    rows.push(`${v}/${tf} | ${Math.round(spanMs / 3_600_000)} | ${before.requests} -> ${after.requests} | ${hb} -> ${ha} (reported front ${after.reportedFront})`);
    if (v === 'OKX' && tf === '8h') { expect(after.requests).toBe(before.requests); return; } // the venue rejects the bar
    expect(ha, 'every hole the rewired loop sees is reported by the pages\' meta').toBeLessThanOrEqual(after.reportedFront);
    if (v === 'BITGET' && (tf === '2h' || tf === '8h')) {
      expect(hb, 'the retired loop left holes (C1)').toBeGreaterThan(ha);
      expect(after.requests).toBeGreaterThan(0);
    } else {
      expect(after.requests, 'delta 0 on every non-violator pair').toBe(before.requests);
      expect(JSON.stringify(after.bars)).toBe(JSON.stringify(before.bars));
    }
  });
});
