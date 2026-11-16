/**
 * Shared helpers for the SR-ZONES-W1 tests: the BTC 1d fixture and a synthetic candle builder.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '../../src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = join(HERE, '..', 'fixtures', 'sr-zones', 'btcusdt-1d-20261114.json');

/** BINANCE BTCUSDT 1d closed candles, 2024-02-18 … 2026-11-13 (one getCandles fetch). */
export function loadBtcFixture(): Candle[] {
  const fx = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { bars: number[][] };
  return fx.bars.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
}

export const DAY_MS = 86_400_000;
export const SYNTH_START_MS = Date.UTC(2026, 0, 1);

/** SR-ZONES-W2: the fixture plus the forming 2026-11-14 candle closing at `price` — what Binance serves at 2026-11-14T10:00Z. */
export function btcFixtureWithForming(price: number): Candle[] {
  const closed = loadBtcFixture();
  const last = closed[closed.length - 1];
  const open = last.close;
  return [...closed, { time: last.time + DAY_MS, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: 1 }];
}

/**
 * Builds a synthetic daily series step by step. Trend candles move 6 per candle with a 0.5 wick on each side; a base
 * at level L is candles (open L+2, high L+4, low L, close L+3), opened with a gap from wherever price was.
 */
export class SeriesBuilder {
  readonly candles: Candle[] = [];

  constructor(start: number) {
    this.push(start, start + 0.5, start - 0.5, start);
  }

  get last(): Candle {
    return this.candles[this.candles.length - 1];
  }

  push(open: number, high: number, low: number, close: number, volume = 100): this {
    this.candles.push({ time: SYNTH_START_MS + this.candles.length * DAY_MS, open, high, low, close, volume });
    return this;
  }

  /** Trend candles of ±6 until the close reaches `close` (must be a multiple of 6 away). */
  trendTo(close: number): this {
    const step = close > this.last.close ? 6 : -6;
    if ((close - this.last.close) % 6 !== 0) throw new Error(`trendTo(${close}) from ${this.last.close}: not a multiple of 6`);
    while (this.last.close !== close) {
      const o = this.last.close;
      const c = o + step;
      this.push(o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c);
    }
    return this;
  }

  /** `n` base candles at level L. Returns the index of the first one through `at`. */
  base(level: number, n = 6, at?: { first: number }): this {
    if (at) at.first = this.candles.length;
    for (let i = 0; i < n; i++) this.push(level + 2, level + 4, level, level + 3);
    return this;
  }
}

export const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
