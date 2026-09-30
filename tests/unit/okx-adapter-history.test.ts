import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the shared transport so we can drive OKX's two candle endpoints deterministically.
const calls: string[] = [];
// `safeUpstreamNum` is a PURE strict-parse helper the candle mapper depends on — pull the
// real one through rather than stubbing it, or the mapper silently sees `undefined`.
// OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2: the venue is the synthetic OKX model (tests/harness/adapter-history-synthetic.ts),
// proven page-for-page against live captures. The hand-written mock this replaced modelled the recent endpoint as
// the OLDEST page after the cursor; measured from two vantages, the venue answers with its NEWEST page, so between
// one and two pages back the old mock routed to the recent branch where the venue routes to the history fallback.
// The assertions below are unchanged.
const { venueNow } = vi.hoisted(() => ({ venueNow: 2_000_000_000_000 }));
vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => {
  const { SyntheticVenue } = await import('../harness/adapter-history-synthetic.js');
  const venue = new SyntheticVenue('OKX', () => venueNow, () => ({ listingMs: Date.UTC(2019, 0, 1) }));
  return {
    ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
    VENUE_FETCH_CONFIGS: { OKX: {} },
    upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
      calls.push(req.url);
      return venue.answer(req.url);
    }),
  };
});

import { OKXAdapter } from '../../src/lib/adapters/okx.js';

beforeEach(() => {
  calls.length = 0;
});

describe('OKXAdapter.getCandles historical fallback', () => {
  it('recent startTime → uses /market/candles only (live path unchanged)', async () => {
    const now = 2_000_000_000_000;
    const startTime = now - 50 * 3_600_000; // recent
    const out = await new OKXAdapter().getCandles('BTC', '1h', startTime);
    expect(calls.some((u) => u.includes('/market/candles'))).toBe(true);
    expect(calls.some((u) => u.includes('/market/history-candles'))).toBe(false);
    // ascending + starts at/after startTime
    expect(out[0].time).toBeLessThanOrEqual(out[out.length - 1].time);
    expect(out[0].time).toBeGreaterThanOrEqual(startTime);
  });

  it('historical startTime → falls back to /market/history-candles and returns bars at startTime', async () => {
    const startTime = 1_776_200_000_000; // ~April 2026, far in the past
    const out = await new OKXAdapter().getCandles('BTC', '1h', startTime);
    expect(calls.some((u) => u.includes('/market/candles'))).toBe(true); // recent tried first
    expect(calls.some((u) => u.includes('/market/history-candles'))).toBe(true); // then fell back
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.time >= startTime)).toBe(true); // covers the requested old window
    expect(out[0].time).toBeLessThan(out[out.length - 1].time); // ascending
  });
});
