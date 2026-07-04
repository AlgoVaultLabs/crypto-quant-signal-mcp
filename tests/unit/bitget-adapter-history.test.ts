import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
vi.mock('../../src/lib/adapters/_upstream-fetch.js', () => ({
  VENUE_FETCH_CONFIGS: { BITGET: {} },
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
    calls.push(req.url);
    const bar = 3_600_000; // 1H
    if (req.url.includes('/market/history-candles')) {
      const endTime = Number(new URL(req.url).searchParams.get('endTime'));
      // ascending bars strictly before endTime
      const data = Array.from({ length: 200 }, (_, i) => {
        const t = endTime - (200 - i) * bar;
        return [String(t), '10', '11', '9', '10.5', '100'];
      });
      return { code: '00000', msg: '', data };
    }
    // `/market/candles`: RECENT window only. Ascending. For a recent startTime it starts at
    // startTime; for a historical one it returns the recent window (far newer than startTime).
    const startTime = Number(new URL(req.url).searchParams.get('startTime'));
    const now = 2_000_000_000_000;
    const base = startTime > now - 300 * bar ? startTime : now - 200 * bar;
    const data = Array.from({ length: 200 }, (_, i) => {
      const t = base + i * bar;
      return [String(t), '20', '21', '19', '20.5', '200'];
    });
    return { code: '00000', msg: '', data };
  }),
}));

import { BitgetAdapter } from '../../src/lib/adapters/bitget.js';

beforeEach(() => {
  calls.length = 0;
});

describe('BitgetAdapter.getCandles historical fallback', () => {
  it('recent startTime → uses /market/candles only (live path unchanged)', async () => {
    const startTime = 2_000_000_000_000 - 50 * 3_600_000;
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
