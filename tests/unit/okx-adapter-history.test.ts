import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the shared transport so we can drive OKX's two candle endpoints deterministically.
const calls: string[] = [];
vi.mock('../../src/lib/adapters/_upstream-fetch.js', () => ({
  VENUE_FETCH_CONFIGS: { OKX: {} },
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
    calls.push(req.url);
    const bar = 3_600_000; // 1H
    if (req.url.includes('/market/history-candles')) {
      // `after` anchors just past the wanted window → return desc candles at [startTime .. +100bars].
      const after = Number(new URL(req.url).searchParams.get('after'));
      const start = after - 100 * bar;
      const data = Array.from({ length: 100 }, (_, i) => {
        const t = after - (i + 1) * bar; // newest-first (descending)
        return [String(t), '10', '11', '9', '10.5', '100'];
      });
      void start;
      return { code: '0', msg: '', data };
    }
    // `/market/candles` — the RECENT-only endpoint. `before` = records newer than startTime, but it
    // only holds the recent window, so for an OLD `before` it returns the NEWEST bars (~now), desc.
    const before = Number(new URL(req.url).searchParams.get('before'));
    const now = 2_000_000_000_000; // far newer than any historical `before`
    const anchor = before > now - 200 * bar ? before : now; // recent → near before; historical → now
    const data = Array.from({ length: 100 }, (_, i) => {
      const t = anchor + (100 - i) * bar; // newer than anchor, descending
      return [String(t), '20', '21', '19', '20.5', '200'];
    });
    return { code: '0', msg: '', data };
  }),
}));

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
