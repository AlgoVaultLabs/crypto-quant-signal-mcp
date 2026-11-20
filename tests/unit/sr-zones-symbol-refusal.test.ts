/**
 * SR-ZONES-W3 R9 #2 — a coin the venue does not list is refused as the venue's answer, never as a transient failure.
 * Binance and Bitget refuse it with HTTP 400; Bybit and OKX answer HTTP 200 with a body code (Bybit retCode 10001
 * "Symbol Is Invalid", OKX code 51001), which the handler used to read as "candle request failed", a 503. The two
 * adapters now throw one typed error (VenueSymbolRefusedError, src/lib/errors.ts) on exactly those codes, with today's
 * message text, so every other consumer sees what it saw before. The bodies are the venues' own, read once each
 * (tests/fixtures/sr-zones/w3-symbol-refusals-20261120.json).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VenueSymbolRefusedError } from '../../src/lib/errors.js';
import { BybitAdapter } from '../../src/lib/adapters/bybit.js';
import { OKXAdapter } from '../../src/lib/adapters/okx.js';
import { BinanceAdapter } from '../../src/lib/adapters/binance.js';
import { BitgetAdapter } from '../../src/lib/adapters/bitget.js';
import { runGetSrZones, isTransientSrUnservedReason, type SrZonesDeps, type GetSrZonesOutcome } from '../../src/tools/get-sr-zones.js';
import { _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';

interface RecordedRead { name: string; venue: string; url: string; status: number; statusText: string; body: string }
const RECORDED = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'sr-zones', 'w3-symbol-refusals-20261120.json'), 'utf8')) as { reads: RecordedRead[] };
const read = (name: string): RecordedRead => {
  const r = RECORDED.reads.find((x) => x.name === name);
  if (!r) throw new Error(`no recorded read named ${name}`);
  return r;
};

const NOW = Date.parse('2026-11-20T08:00:00.000Z');
const H = 3_600_000;

/** Every request answered with one recorded venue answer. */
function answerWith(r: RecordedRead): void {
  vi.spyOn(global, 'fetch').mockImplementation((async () => new Response(r.body, { status: r.status, statusText: r.statusText })) as typeof fetch);
}

/** The text the envelope check threw before this wave, from the recorded body. */
function envelopeText(r: RecordedRead): string {
  const b = JSON.parse(r.body) as { retCode?: number; retMsg?: string; code?: string; msg?: string };
  return r.venue === 'BYBIT' ? `Bybit API error ${b.retCode}: ${b.retMsg}` : `OKX API error code ${b.code}: ${b.msg}`;
}

const adapters: Record<string, () => { getCandles: (coin: string, tf: string, start: number, dex?: undefined, end?: number, opts?: { utcBars?: boolean }) => Promise<unknown[]> }> = {
  BINANCE: () => new BinanceAdapter(),
  BYBIT: () => new BybitAdapter(),
  OKX: () => new OKXAdapter(),
  BITGET: () => new BitgetAdapter(),
};

beforeEach(() => {
  _resetCallTrackersForTest();
  resetLicenseCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SR-ZONES-W3 R9 #2 — Bybit and OKX throw the typed refusal on their invalid-symbol codes only', () => {
  it.each([
    ['BYBIT kline, unlisted coin', 'ZZZNOTLISTED', undefined, 10001],
    ['BYBIT kline, PEPE (Bybit lists 1000PEPEUSDT)', 'PEPE', undefined, 10001],
    ['OKX candles, unlisted coin', 'ZZZNOTLISTED', undefined, 51001],
    ['OKX history-candles, unlisted coin', 'ZZZNOTLISTED', NOW - 300 * H, 51001],
  ] as const)('%s: VenueSymbolRefusedError, with the venue code and today\'s text, byte for byte', async (name, coin, end, venueCode) => {
    const r = read(name);
    answerWith(r);
    const start = end === undefined ? NOW - 100 * H : end - 100 * H;
    const err = await adapters[r.venue]().getCandles(coin, '1h', start, undefined, end).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VenueSymbolRefusedError);
    const e = err as VenueSymbolRefusedError;
    expect([e.exchange, e.venueCode]).toEqual([r.venue, venueCode]);
    // Every other consumer sees exactly the plain Error it saw before: message, name, String, JSON and own keys.
    const before = new Error(envelopeText(r));
    expect(e.message).toBe(before.message);
    expect([e.name, String(e), JSON.stringify(e), Object.keys(e)]).toEqual([before.name, String(before), JSON.stringify(before), Object.keys(before)]);
    expect(e).toBeInstanceOf(Error);
  });

  it.each([
    ['OKX candles, a bar it does not serve (not a symbol refusal)', 'BTC'],
    ['BYBIT kline, rate limited (not a symbol refusal; seen live 2026-11-20 during the R9 probes)', 'BTC'],
  ] as const)('%s: still a plain Error with today\'s text', async (name, coin) => {
    const r = read(name);
    answerWith(r);
    const err = await adapters[r.venue]().getCandles(coin, '1h', NOW - 100 * H).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(VenueSymbolRefusedError);
    expect((err as Error).message).toBe(envelopeText(r));
  });
});

describe('SR-ZONES-W3 R9 #2 — get_support_resistance_zones refuses an unlisted coin with a 422 on every venue', () => {
  const call = (venue: string, coin: string): Promise<GetSrZonesOutcome> => {
    const deps: SrZonesDeps = {
      nowMs: () => NOW,
      cache: new Map(),
      failures: new Map(),
      getCandles: (c, tf, start, end) => adapters[venue]().getCandles(c, tf, start, undefined, end, { utcBars: true }) as never,
      getPriceTick: async () => null,
    };
    return runGetSrZones({ coin, timeframes: ['1h'], venue: venue as never }, { tier: 'free', key: 'av_srz_symbol_refusal' }, deps);
  };

  it.each([
    ['BINANCE klines, unlisted coin', 'ZZZNOTLISTED', 'BINANCE refused the candle request for ZZZNOTLISTED (HTTP 400)'],
    ['BITGET candles, unlisted coin', 'ZZZNOTLISTED', 'BITGET refused the candle request for ZZZNOTLISTED (HTTP 400)'],
    ['BYBIT kline, unlisted coin', 'ZZZNOTLISTED', 'BYBIT refused the candle request for ZZZNOTLISTED (error 10001)'],
    ['BYBIT kline, PEPE (Bybit lists 1000PEPEUSDT)', 'PEPE', 'BYBIT refused the candle request for PEPE (error 10001)'],
    ['OKX candles, unlisted coin', 'ZZZNOTLISTED', 'OKX refused the candle request for ZZZNOTLISTED (error 51001)'],
  ] as const)('%s (coin %s) → 422, "%s", not transient', async (name, coin, reason) => {
    const r = read(name);
    answerWith(r);
    const o = await call(r.venue, coin);
    if (o.kind !== 'refused') throw new Error(`expected a refusal, got ${o.kind}`);
    expect(o.status).toBe(422);
    expect((o.payload as { unserved?: unknown }).unserved).toEqual([{ timeframe: '1h', reason }]);
    expect(isTransientSrUnservedReason(reason)).toBe(false);
  });
});
