import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
// `safeUpstreamNum` is a PURE strict-parse helper the candle mapper depends on — pull the
// real one through rather than stubbing it, or the mapper silently sees `undefined`.
// OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2: the venue is the synthetic BITGET model (tests/harness/adapter-history-synthetic.ts),
// proven page-for-page against live captures. The hand-written mock this replaced modelled the recent endpoint as
// the OLDEST page after the cursor; measured from two vantages, the venue answers with its NEWEST page, so between
// one and two pages back the old mock routed to the recent branch where the venue routes to the history fallback.
// The assertions below are unchanged.
const { venueNow } = vi.hoisted(() => ({ venueNow: 2_000_000_000_000 }));
vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => {
  const { SyntheticVenue } = await import('../harness/adapter-history-synthetic.js');
  const venue = new SyntheticVenue('BITGET', () => venueNow, () => ({ listingMs: Date.UTC(2019, 0, 1) }));
  return {
    ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
    VENUE_FETCH_CONFIGS: { BITGET: {} },
    upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
      calls.push(req.url);
      return venue.answer(req.url);
    }),
  };
});

import { BitgetAdapter } from '../../src/lib/adapters/bitget.js';

beforeEach(() => {
  calls.length = 0;
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
    const out = await new BitgetAdapter().getCandles('BTC', '1h', startTime);
    expect(calls.some((u) => u.includes('/market/history-candles'))).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.time >= startTime)).toBe(true);
    expect(out[0].time).toBeLessThan(out[out.length - 1].time); // ascending
  });
});
