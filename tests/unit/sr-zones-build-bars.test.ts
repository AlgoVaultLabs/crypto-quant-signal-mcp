/**
 * SR-ZONES-W3 R5 — buildBars (src/lib/sr-zones/build-bars.ts): a bar a venue does not serve, built from its native
 * divisor. Buckets open on UTC multiples of the requested step; open = first open, high = max, low = min, close = last
 * close, volume = sum; a closed bucket missing a constituent is a hole (left out); the forming bucket is built from the
 * constituents read so far, without a gap from its open.
 *
 * AC1.3 oracle: Binance's own 4h built into 8h, and 1h into 2h, equal Binance's native 8h and 2h bars (OHLC exact,
 * volume within 1e-9 relative), on the R0 addendum captures (tests/fixtures/sr-zones/w3-walk-btc-binance-r5r6-20261120.json).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle } from '../../src/types.js';
import { buildBars } from '../../src/lib/sr-zones/build-bars.js';

const H = 3_600_000;
const FIX = join(__dirname, '..', 'fixtures', 'sr-zones');

interface Capture { servedStepMs: number; requestedStepMs: number; nowMs: number; series: number[][] }
const BINANCE = (JSON.parse(readFileSync(join(FIX, 'w3-walk-btc-binance-r5r6-20261120.json'), 'utf8')) as { pairs: Record<string, Capture> }).pairs;
const toCandle = ([time, open, high, low, close, volume]: number[]): Candle => ({ time, open, high, low, close, volume });

/** n native bars of `step` from `start`, each distinct, so every built field shows which constituent it came from. */
function bars(start: number, step: number, n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: start + i * step,
    open: 100 + i,
    high: 110 + i + (i % 3) * 5,
    low: 90 - i - (i % 2) * 4,
    close: 101 + i,
    volume: 10 + i * 0.25,
  }));
}

describe('SR-ZONES-W3 AC1.3 — the build oracle: Binance built bars equal Binance native bars', () => {
  it.each([
    ['8h <- 4h', '8h<-4h', '8h'],
    ['2h <- 1h', '2h<-1h', '2h'],
  ])('%s: every closed bucket both captures hold, OHLC exact and volume within 1e-9', (_label, builtKey, nativeKey) => {
    const src = BINANCE[builtKey];
    const nat = BINANCE[nativeKey];
    const built = buildBars(src.series.map(toCandle), src.servedStepMs, src.requestedStepMs, src.nowMs);
    const native = new Map(nat.series.map((r) => [r[0], toCandle(r)]));
    const closedBefore = Math.min(src.nowMs, nat.nowMs);
    let compared = 0;
    for (const b of built) {
      const n = native.get(b.time);
      if (!n || b.time + src.requestedStepMs > closedBefore) continue;
      compared++;
      expect([b.open, b.high, b.low, b.close]).toEqual([n.open, n.high, n.low, n.close]);
      expect(Math.abs(b.volume - n.volume)).toBeLessThanOrEqual(1e-9 * Math.abs(n.volume));
    }
    expect(compared).toBeGreaterThanOrEqual(1000); // a full window, not a vacuous pass
  });

  it('the oracle can fail: a built bar off by one constituent (wrong close) is caught', () => {
    const src = BINANCE['8h<-4h'];
    const nat = new Map(BINANCE['8h'].series.map((r) => [r[0], toCandle(r)]));
    // A builder that took the FIRST constituent's close would differ from the native close on nearly every bucket.
    const wrong = buildBars(src.series.map(toCandle), src.servedStepMs, src.requestedStepMs, src.nowMs).map((b) => {
      const first = src.series.find((r) => r[0] === b.time)!;
      return { ...b, close: first[4] };
    });
    const mismatched = wrong.filter((b) => nat.has(b.time) && b.time + src.requestedStepMs <= src.nowMs && nat.get(b.time)!.close !== b.close);
    expect(mismatched.length).toBeGreaterThan(900);
  });
});

describe('SR-ZONES-W3 R5 — buildBars', () => {
  const NOW = Date.parse('2026-11-20T05:30:00.000Z'); // inside the 00:00–08:00 UTC bucket of 8h, the 04:00–06:00 of 2h

  it('OHLCV: first open, max high, min low, last close, summed volume, at the bucket open', () => {
    const native = bars(Date.parse('2026-11-19T00:00:00.000Z'), 4 * H, 2);
    const [b] = buildBars(native, 4 * H, 8 * H, NOW);
    expect(b).toEqual({
      time: native[0].time,
      open: native[0].open,
      high: Math.max(native[0].high, native[1].high),
      low: Math.min(native[0].low, native[1].low),
      close: native[1].close,
      volume: native[0].volume + native[1].volume,
    });
  });

  it('buckets open on UTC multiples of the requested step, whatever slot the series starts on', () => {
    // 4h bars from 04:00 UTC: the 00:00 bucket holds only its second constituent, so it is a hole; 08:00 is the first.
    const native = bars(Date.parse('2026-11-18T04:00:00.000Z'), 4 * H, 11);
    const out = buildBars(native, 4 * H, 8 * H, NOW);
    expect(out.map((b) => new Date(b.time).toISOString())).toEqual([
      '2026-11-18T08:00:00.000Z', '2026-11-18T16:00:00.000Z', '2026-11-19T00:00:00.000Z',
      '2026-11-19T08:00:00.000Z', '2026-11-19T16:00:00.000Z',
    ]);
    expect(out.every((b) => b.time % (8 * H) === 0)).toBe(true);
    // 2h from 1h bars starting on an odd hour: buckets on even hours only.
    const hourly = bars(Date.parse('2026-11-20T01:00:00.000Z'), H, 5); // 01..05
    expect(buildBars(hourly, H, 2 * H, NOW).map((b) => new Date(b.time).getUTCHours())).toEqual([2, 4]);
  });

  it('a closed bucket missing a constituent is a hole: left out, its neighbours unchanged', () => {
    const native = bars(Date.parse('2026-11-18T00:00:00.000Z'), 4 * H, 12); // 6 closed buckets
    const full = buildBars(native, 4 * H, 8 * H, NOW);
    const dropped = native.filter((_, i) => i !== 5); // the second constituent of the third bucket
    const out = buildBars(dropped, 4 * H, 8 * H, NOW);
    expect(full).toHaveLength(6);
    expect(out.map((b) => b.time)).toEqual(full.filter((_, i) => i !== 2).map((b) => b.time));
    expect(out).toEqual(full.filter((_, i) => i !== 2));
  });

  it('a native bar off its own UTC grid fills no slot: its bucket is a hole', () => {
    const native = bars(Date.parse('2026-11-18T00:00:00.000Z'), 4 * H, 4);
    native[1] = { ...native[1], time: native[1].time + H }; // 05:00 instead of 04:00
    const out = buildBars(native, 4 * H, 8 * H, NOW);
    expect(out.map((b) => new Date(b.time).toISOString())).toEqual(['2026-11-18T08:00:00.000Z']);
  });

  it('the forming bucket follows the native forming-bar rule: the constituents read so far, from its open', () => {
    const open = Date.parse('2026-11-20T00:00:00.000Z');
    const one = bars(open, 4 * H, 1); // 00:00 only, the bucket still forming at 05:30
    expect(buildBars(one, 4 * H, 8 * H, NOW)).toEqual([{ ...one[0] }]);
    const two = bars(open, 4 * H, 2); // 00:00 and the forming 04:00
    expect(buildBars(two, 4 * H, 8 * H, NOW)[0]).toMatchObject({ time: open, open: two[0].open, close: two[1].close });
    // Its first constituent missing: no forming bar (its open would not be the bucket's).
    expect(buildBars(two.slice(1), 4 * H, 8 * H, NOW)).toEqual([]);
    // A gap inside it (k = 4: slots 0 and 2 of the 05:00 hour, forming at 05:30): no forming bar.
    const fifteen = bars(Date.parse('2026-11-20T05:00:00.000Z'), 15 * 60_000, 3);
    expect(buildBars(fifteen, 15 * 60_000, H, NOW)).toHaveLength(1);
    expect(buildBars([fifteen[0], fifteen[2]], 15 * 60_000, H, NOW)).toEqual([]);
  });

  it('a step that does not divide evenly builds nothing; duplicates and order do not matter', () => {
    const native = bars(Date.parse('2026-11-18T00:00:00.000Z'), 6 * H, 8);
    expect(buildBars(native, 6 * H, 8 * H, NOW)).toEqual([]);
    const four = bars(Date.parse('2026-11-18T00:00:00.000Z'), 4 * H, 4);
    expect(buildBars([four[3], four[1], four[0], four[2], four[0]], 4 * H, 8 * H, NOW)).toEqual(buildBars(four, 4 * H, 8 * H, NOW));
  });

  it('a bucket that opens after now is not built', () => {
    const native = bars(Date.parse('2026-11-20T08:00:00.000Z'), 4 * H, 2);
    expect(buildBars(native, 4 * H, 8 * H, NOW)).toEqual([]);
  });
});
