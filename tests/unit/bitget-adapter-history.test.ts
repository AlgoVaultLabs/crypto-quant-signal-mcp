import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const calls: string[] = [];
// `safeUpstreamNum` is a PURE strict-parse helper the candle mapper depends on — pull the
// real one through rather than stubbing it, or the mapper silently sees `undefined`.
// OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2: the venue is the synthetic BITGET model (tests/harness/adapter-history-synthetic.ts),
// proven page-for-page against live captures. The hand-written mock this replaced modelled the recent endpoint as
// the OLDEST page after the cursor; measured from two vantages, the venue answers with its NEWEST page, so between
// one and two pages back the old mock routed to the recent branch where the venue routes to the history fallback.
// The assertions below are unchanged.
const { venueNow, recorded, keyOf } = vi.hoisted(() => ({
  venueNow: 2_000_000_000_000,
  /** SR-ZONES-W3 R8: when set, every request is answered from these recorded live bodies (keyed by keyOf). */
  recorded: { bodies: null as Map<string, unknown> | null },
  /** A request's key: its path and its query, sorted, so the adapter's parameter order does not matter. */
  keyOf: (url: string): string => {
    const u = new URL(url);
    return `${u.pathname}?${[...u.searchParams].sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => `${k}=${v}`).join('&')}`;
  },
}));
vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => {
  const { SyntheticVenue } = await import('../harness/adapter-history-synthetic.js');
  const venue = new SyntheticVenue('BITGET', () => venueNow, () => ({ listingMs: Date.UTC(2019, 0, 1) }));
  return {
    ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
    VENUE_FETCH_CONFIGS: { BITGET: {} },
    upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
      calls.push(req.url);
      if (recorded.bodies) {
        const key = keyOf(req.url);
        if (!recorded.bodies.has(key)) throw new Error(`unrecorded request ${key}`);
        return recorded.bodies.get(key);
      }
      return venue.answer(req.url);
    }),
  };
});

import { BitgetAdapter } from '../../src/lib/adapters/bitget.js';

beforeEach(() => {
  calls.length = 0;
  recorded.bodies = null;
});

describe('BitgetAdapter.getCandles historical fallback', () => {
  it('recent startTime → uses /market/candles only (live path unchanged)', async () => {
    // On the hour grid: for an OFF-grid startTime Bitget also returns the bar CONTAINING it (one bar before
    // startTime — measured, and pinned in tests/fixtures/adapter-history/REACH.json as an out-of-range bar).
    const startTime = Math.floor((2_000_000_000_000 - 50 * 3_600_000) / 3_600_000) * 3_600_000;
    const out = await new BitgetAdapter().getCandles('BTC', '1h', startTime);
    expect(calls.some((u) => u.includes('/market/candles'))).toBe(true);
    expect(calls.some((u) => u.includes('/market/history-candles'))).toBe(false);
    expect(out[0].time).toBeGreaterThanOrEqual(startTime);
    expect(out[0].time).toBeLessThan(out[out.length - 1].time); // ascending
  });

  it('historical startTime → falls back to /market/history-candles and returns bars at startTime', async () => {
    const startTime = 1_776_200_000_000; // ~April 2026
    // OPS-SERVED-CANDLE-TRUTH-W1 CH1: a HISTORY read names its end (every history consumer has since
    // OPS-ADAPTER-HISTORY-ANCHOR-W1). A read with no endTime is a SERVING read, completed by the serving assembler
    // instead (serving-window-assembler.test.ts).
    const out = await new BitgetAdapter().getCandles('BTC', '1h', startTime, undefined, startTime + 100 * 3_600_000);
    expect(calls.some((u) => u.includes('/market/history-candles'))).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.time >= startTime)).toBe(true);
    expect(out[0].time).toBeLessThan(out[out.length - 1].time); // ascending
  });
});

// ── SR-ZONES-W3 R8 (Mr.1: "Fix it in this wave") — the fallback anchor covers the page's start ──────────────────────────

/**
 * Bitget's /market/history-candles answers at most 90 days of bars ending at `endTime` (1D 90, 12H 180, 4H 200; R0 P1,
 * and the lead's probe: 1D → 90 bars for limit 200). Anchored at start + 200 bars, a 12H or 1D fallback page came back
 * with its front uncovered: near a listing it held nothing the page asked for (ASTER 1D: 90 bars from 2025-12-08 for a
 * page from 2025-08-20), so get_support_resistance_zones' walk ended 61 bars short of the listing. The bodies are the
 * venue's own, read once each (tests/fixtures/sr-zones/w3-bitget-fallback-20261120.json): each case's recent request,
 * its history request at every anchor the fallback has used, and (R9) the recent-endpoint reads that serve as the oracle.
 */
interface RecordedCase {
  name: string;
  symbol: string;
  granularity: string;
  stepMs: number;
  startTime: number;
  reachBars: number;
  requests: Array<{ role?: 'oracle'; path: string; query: Record<string, string>; body: { data: string[][] } }>;
}
const FALLBACK = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'sr-zones', 'w3-bitget-fallback-20261120.json'), 'utf8')) as { cases: RecordedCase[] };
const caseOf = (name: string): RecordedCase => FALLBACK.cases.find((c) => c.name === name)!;
const TF: Record<string, [string, { utcBars: true } | undefined]> = {
  '1D': ['1d', undefined], '1Dutc': ['1d', { utcBars: true }], '12H': ['12h', undefined], '12Hutc': ['12h', { utcBars: true }], '4H': ['4h', undefined],
};
function play(c: RecordedCase): void {
  recorded.bodies = new Map(c.requests.map((r) => [keyOf(`https://api.bitget.com${r.path}?${new URLSearchParams(r.query)}`), r.body]));
}
const opensOf = (c: RecordedCase, path: string, endTime?: number): number[] =>
  c.requests.find((r) => r.path.endsWith(path) && (endTime === undefined || r.query.endTime === String(endTime)))!.body.data.map((row) => Number(row[0]));
const historyEnds = () => calls.filter((u) => u.includes('/market/history-candles')).map((u) => Number(new URL(u).searchParams.get('endTime')));

/**
 * SR-ZONES-W3 R9 #1: the fallback covers the whole old window, [start, start + HISTORY_PAGE_CAP bars), by walking
 * reach-sized pages forward (1D: ends at 90, 180, 200 bars; 12H: 180, 200) and returning their union. One reach-sized
 * page alone answered empty when it lay wholly before a listing (ASTER 1D from L-150d, 12H from L-95d), so a walker
 * stepping 200 bars skipped the listing's first bars with no hole reported.
 */
const walkEnds = (c: RecordedCase): number[] => {
  const ends: number[] = [];
  for (let k = 1; ; k++) {
    const bars = Math.min(k * c.reachBars, 200);
    ends.push(c.startTime + bars * c.stepMs);
    if (bars === 200) return ends;
  }
};
/** The venue's own bars for [start, start + 200 bars), read through its RECENT endpoint (the oracle requests, never
 *  asked by the adapter): row for row what the walk must return. */
const oracleBars = (c: RecordedCase): number[][] => {
  const end = c.startTime + 200 * c.stepMs;
  const byOpen = new Map<number, number[]>();
  for (const r of c.requests.filter((q) => q.role === 'oracle')) {
    for (const row of r.body.data) if (Number(row[0]) >= c.startTime && Number(row[0]) < end) byOpen.set(Number(row[0]), row.slice(0, 6).map(Number));
  }
  return [...byOpen.values()].sort((a, b) => a[0] - b[0]);
};

describe('SR-ZONES-W3 R8 + R9 #1 — the Bitget history fallback covers [start, start + 200 bars) from its first bar', () => {
  it.each([
    'ASTER 1D young-listing page',
    'ASTER 1Dutc young-listing page',
    'ASTER 12H page with the listing 10 bars in',
    'ASTER 12Hutc page with the listing 10 bars in',
    'ASTER 1D page 150 days before the listing',
    'ASTER 12H page 95 days before the listing',
  ])('%s: every bar the venue holds in the old window comes back, walked forward in reach-sized pages', async (name) => {
    const c = caseOf(name);
    const [tf, opts] = TF[c.granularity];
    play(c);
    const out = await new BitgetAdapter().getCandles('ASTER', tf, c.startTime, undefined, c.startTime + 200 * c.stepMs - 1, opts);
    const held = oracleBars(c);
    expect(held.length).toBeGreaterThan(0);
    expect(out.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume])).toEqual(held);
    expect(historyEnds()).toEqual(walkEnds(c)); // forward, reach-sized pages ending on the old window's end
    expect(historyEnds()).toHaveLength(c.reachBars === 90 ? 3 : 2); // 1D at most 3 requests, 12H at most 2
  });

  it('the recorded old anchor (start + 200 bars) is what left the front uncovered (the defect the fix answers)', () => {
    for (const name of ['ASTER 1D young-listing page', 'ASTER 1Dutc young-listing page', 'ASTER 12H page with the listing 10 bars in', 'ASTER 12Hutc page with the listing 10 bars in']) {
      const c = caseOf(name);
      const old = opensOf(c, '/market/history-candles', c.startTime + 200 * c.stepMs);
      const listing = opensOf(c, '/market/candles')[0];
      expect(old[0], name).toBeGreaterThan(listing); // the old answer starts past the listing: its front is missing
    }
  });

  it('BTC 4H: a window the old anchor already served whole keeps the same request and the same bars', async () => {
    const c = caseOf('BTC 4H fallback page');
    play(c);
    const end = c.startTime + 200 * c.stepMs;
    const out = await new BitgetAdapter().getCandles('BTC', '4h', c.startTime, undefined, end - 1);
    expect(historyEnds()).toEqual([end]); // 4H reach = 200 bars: the anchor is unchanged
    expect(out.map((b) => b.time)).toEqual(opensOf(c, '/market/history-candles', end).filter((t) => t >= c.startTime));
    expect(out).toHaveLength(200);
  });

  it('BTC 1D: a page the recent route serves never asks the fallback; same bars', async () => {
    const c = caseOf('BTC 1D recent-routed page');
    play(c);
    const out = await new BitgetAdapter().getCandles('BTC', '1d', c.startTime, undefined, c.startTime + 90 * c.stepMs - 1);
    expect(historyEnds()).toEqual([]);
    expect(out.map((b) => b.time)).toEqual(opensOf(c, '/market/candles'));
  });
});
