/**
 * SR-ZONES-W3 AC1.2 — the Binance byte-identity cases. A call that names no venue must serve exactly what BASE
 * (87c3c335) served: the same response bytes and the same venue requests. `tests/fixtures/sr-zones/w3-binance-base-golden.json`
 * holds what BASE answered to every case below, generated once at BASE from these exact inputs (a one-off run of this
 * module against the unchanged handler); `tests/unit/sr-zones-venues.test.ts` replays them against the current handler.
 *
 * The fake answers like Binance's /fapi/v1/klines through the adapter: up to 200 candles from `startTime` on, `endTime`
 * ignored, an unknown coin or timeframe refused with HTTP 400.
 */
import type { Candle, LicenseInfo } from '../../src/types.js';
import { btcFixtureWithForming } from './sr-zones-helpers.js';

export const GOLDEN_NOW = Date.parse('2026-11-14T10:00:00.000Z');
export const GOLDEN_BASE_SHA = '87c3c335158428983102b3683a30b189661fe271';

const STEP: Record<string, number> = { '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };

/** A seeded random-walk series for `tf`: `bars` candles ending with the one forming at GOLDEN_NOW. */
function walk(tf: string, bars: number, seed: number): Candle[] {
  const step = STEP[tf];
  const formingOpen = Math.floor(GOLDEN_NOW / step) * step;
  let a = seed >>> 0;
  const rand = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const out: Candle[] = [];
  let close = 60_000;
  for (let i = bars - 1; i >= 0; i--) {
    const open = close;
    close = open * (1 + 0.02 * (rand() - 0.5));
    out.push({
      time: formingOpen - i * step,
      open,
      high: Math.max(open, close) * (1 + 0.004 * rand()),
      low: Math.min(open, close) * (1 - 0.004 * rand()),
      close,
      volume: 100 + 50 * rand(),
    });
  }
  return out;
}

const DATA: Record<string, Record<string, Candle[]>> = {
  // The real BINANCE BTCUSDT 1d window (tests/fixtures/sr-zones/btcusdt-1d-20261114.json) and two synthetic timeframes.
  BTC: { '1d': btcFixtureWithForming(67_585.6), '4h': walk('4h', 1500, 2), '1h': walk('1h', 1500, 3) },
  TWIN: { '1d': walk('1d', 1500, 7), '4h': walk('4h', 1500, 7) },
  YOUNG: { '1d': walk('1d', 46, 4) },
  NEWBORN: { '1d': walk('1d', 15, 5) },
};

/** Binance-shaped klines: up to 200 candles from startTime on; endTime ignored. */
function binanceLike(coin: string, tf: string, startTime: number): Candle[] {
  const series = DATA[coin]?.[tf];
  if (!series) throw new Error('Binance API 400: Bad Request');
  return series.filter((c) => c.time >= startTime).slice(0, 200);
}

export interface GoldenCase {
  name: string;
  params: { coin: string; timeframes: string[]; venue?: string };
  tick: number | null;
}

export const GOLDEN_CASES: readonly GoldenCase[] = [
  { name: 'real BTC 1d, tick 0.1', params: { coin: 'BTC', timeframes: ['1d'] }, tick: 0.1 },
  { name: 'real BTC 1d, venue BINANCE named, tick 0.1', params: { coin: 'btc', timeframes: ['1d'], venue: 'BINANCE' }, tick: 0.1 },
  { name: 'three timeframes, no tick (sig step)', params: { coin: 'BTC', timeframes: ['1d', '4h', '1h'] }, tick: null },
  { name: 'twin series, coarse tick 1000', params: { coin: 'TWIN', timeframes: ['1d', '4h'] }, tick: 1000 },
  { name: 'twin series, reversed order, no tick', params: { coin: 'TWIN', timeframes: ['4h', '1d'] }, tick: null },
  { name: 'young listing 1d, tick 0.01', params: { coin: 'YOUNG', timeframes: ['1d'] }, tick: 0.01 },
  { name: 'newborn listing: refused by the formula', params: { coin: 'NEWBORN', timeframes: ['1d'] }, tick: 0.01 },
  { name: 'unknown coin: refused (HTTP 400)', params: { coin: 'NOPE', timeframes: ['1d', '4h'] }, tick: null },
  { name: 'one timeframe the fake refuses, one served', params: { coin: 'BTC', timeframes: ['1d', '15m'] }, tick: 0.1 },
  { name: 'duplicate timeframes', params: { coin: 'BTC', timeframes: ['1d', '1d'] }, tick: 0.1 },
];

export type GoldenCall = [coin: string, tf: string, startTime: number, endTime: number | null];

/** The handler's deps for one case: the Binance-shaped fake, counted, and the case's tick. Extra trailing params are ignored. */
export function goldenDeps(tick: number | null) {
  const calls: GoldenCall[] = [];
  return {
    calls,
    deps: {
      nowMs: () => GOLDEN_NOW,
      cache: new Map(),
      failures: new Map(),
      getCandles: async (coin: string, tf: string, startTime: number, endTime?: number) => {
        calls.push([coin, tf, startTime, endTime ?? null]);
        return binanceLike(coin, tf, startTime);
      },
      getPriceTick: async () => tick,
    },
  };
}

export const goldenLicense = (i: number): LicenseInfo => ({ tier: 'free', key: `av_srz_w3_golden_${i}` });
