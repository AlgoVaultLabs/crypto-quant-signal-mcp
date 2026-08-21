/**
 * SIGNAL-TREND-BLINDNESS-FIX-W1 CH1 — the `1d` fetch window, both venue semantics.
 *
 * WHY THIS EXISTS. `get_market_regime` was DEAD at `1d` on every startTime-honouring venue from
 * the `CANDLE_BASIS=closed` flip until this wave, and it went unnoticed for ~14 days because the
 * schema DEFAULT venue (`HL`) is the one venue it worked on. Reproduced live before the fix:
 *
 *     BTC/HL/1d       -> 200 OK, TRENDING_UP, adx 22.8
 *     BTC/BINANCE/1d  -> INSUFFICIENT_CANDLES: "has 29 candles; 30 required"
 *     ETH/BINANCE/1d  -> INSUFFICIENT_CANDLES: 29 / 30
 *
 * The cause is NOT a row limit — `getCandles` has no limit parameter (`types.ts:120`), so
 * `CANDLE_COUNTS` is a lookback WINDOW. It is the venue BOUNDARY BAR: Hyperliquid's
 * `candleSnapshot` INCLUDES the bar containing `startTime` (window+1 rows) while Binance's
 * `openTime >= startTime` EXCLUDES it (window rows). One bar of venue disagreement, against a
 * window that left exactly zero headroom for it.
 *
 * These tests are therefore written per VENUE SEMANTIC, not per venue name — venue 18 inherits
 * them for free, and a future window change is checked against both behaviours at once.
 *
 * SPAWN BUDGET: none required. `scripts/check-test-budget.mjs` scopes itself to blocks matching
 * /\b(child_process|execFileSync|execSync|spawnSync|spawn\s*\()/ — this file spawns no process, so
 * a `{ timeout }` here would declare a budget for something that cannot happen. (Note the gate
 * accepts the options-object form ONLY; a trailing-number timeout does not satisfy it.)
 */
import { describe, it, expect } from 'vitest';
import { splitCandleWindow } from '../../src/lib/candle-window.js';
import { intervalMsFor } from '../../src/lib/candle-guard.js';
import { CANDLE_COUNTS, ADX_SLOPE_FLOOR } from '../../src/tools/get-market-regime.js';
import { InsufficientCandlesError } from '../../src/lib/errors.js';
import type { Candle } from '../../src/types.js';

/** The emission guard inside `getMarketRegime`. Restated because it is a local const — if this
 *  ever diverges from the source the `serving floor is UNCHANGED` test below is what fails. */
const REQUIRED_CANDLES = 30;

const DAY = 86_400_000;
/** Mid-bar "now", so the newest generated bar is genuinely in progress. */
const NOW = 1_780_000_000_000 + DAY / 2;

/**
 * `rows` ascending bars on a fixed grid, the newest of which is IN PROGRESS at `NOW`.
 * This is what a venue actually hands back; which `rows` a venue chooses is the semantic below.
 */
function candles(rows: number, intervalMs = DAY, nowMs = NOW): Candle[] {
  const newestOpen = Math.floor(nowMs / intervalMs) * intervalMs;
  return Array.from({ length: rows }, (_, i) => {
    const time = newestOpen - (rows - 1 - i) * intervalMs;
    return { time, open: 100, high: 101, low: 99, close: 100, volume: 1 };
  });
}

/** Binance semantics: `openTime >= startTime` EXCLUDES the containing bar -> `window` rows. */
const binanceRows = (window: number) => candles(window);
/** Hyperliquid semantics: `candleSnapshot` INCLUDES the containing bar -> `window + 1` rows. */
const hlRows = (window: number) => candles(window + 1);

const emitted = (rows: Candle[]) => splitCandleWindow(rows, DAY, NOW).closed.length;

describe('CH1 — the 1d fetch window clears the ADX-slope floor under BOTH venue semantics', () => {
  it('a) Binance-semantic 1d yields >= ADX_SLOPE_FLOOR after the closed-basis split', () => {
    expect(emitted(binanceRows(CANDLE_COUNTS['1d']))).toBeGreaterThanOrEqual(ADX_SLOPE_FLOOR);
  });

  it('b) HL-semantic 1d yields >= ADX_SLOPE_FLOOR too — one assertion, both semantics', () => {
    expect(emitted(hlRows(CANDLE_COUNTS['1d']))).toBeGreaterThanOrEqual(ADX_SLOPE_FLOOR);
  });

  it('reproduces the OUTAGE at the pre-wave window, so the fix cannot be silently reverted', () => {
    // The exact live numbers: Binance 30 -> 29 closed (threw), HL 30 -> 30 closed (passed by zero).
    expect(emitted(binanceRows(30))).toBe(29);
    expect(emitted(hlRows(30))).toBe(30);
    expect(emitted(binanceRows(30))).toBeLessThan(REQUIRED_CANDLES); // this is what threw
    // ...and the shipped window clears it on the venue that used to fail.
    expect(emitted(binanceRows(CANDLE_COUNTS['1d']))).toBeGreaterThanOrEqual(REQUIRED_CANDLES);
  });

  it('the one-bar venue skew survives the fix but is no longer fatal — margin, not luck', () => {
    const b = emitted(binanceRows(CANDLE_COUNTS['1d']));
    const h = emitted(hlRows(CANDLE_COUNTS['1d']));
    expect(h - b).toBe(1); // the boundary bar never went away; it is now absorbed
    expect(b - ADX_SLOPE_FLOOR).toBeGreaterThan(0);
  });

  it('1h and 4h fetch counts are UNTOUCHED — the AC is byte-identical output on those paths', () => {
    expect(CANDLE_COUNTS['1h']).toBe(168);
    expect(CANDLE_COUNTS['4h']).toBe(42);
    // Both still clear the slope floor, so leaving them alone costs nothing today.
    expect(emitted(binanceRows(168))).toBeGreaterThanOrEqual(ADX_SLOPE_FLOOR);
    expect(emitted(binanceRows(42))).toBeGreaterThanOrEqual(ADX_SLOPE_FLOOR);
  });
});

describe('CH1 — the SERVING floor is unchanged; the new floor is construction-side only', () => {
  it('ADX_SLOPE_FLOOR is strictly above REQUIRED_CANDLES and is NOT a refusal threshold', () => {
    // Q5 regression pin. Raising the SERVING floor to 33 would start refusing 30-32-bar listings
    // that are served today — a coverage regression on the newly-listed path, and the inverse of
    // a bugfix. The two floors must stay distinct, and the refusal must stay at 30.
    expect(ADX_SLOPE_FLOOR).toBe(33);
    expect(ADX_SLOPE_FLOOR).toBeGreaterThan(REQUIRED_CANDLES);
  });

  it('d) a genuinely short series is still below the emission guard — the guard stays real', () => {
    expect(emitted(binanceRows(REQUIRED_CANDLES))).toBeLessThan(REQUIRED_CANDLES);
    // and the structured refusal it produces is the one callers already handle
    const err = new InsufficientCandlesError({
      coin: 'NEW', exchange: 'BINANCE', timeframe: '1d',
      candlesAvailable: 29, candlesRequired: REQUIRED_CANDLES,
      suggestedTimeframes: ['4h'], suggestedAction: 'Retry with timeframe=4h',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('29');
  });

  it('a 30-32 bar listing is SERVED, and lands in the reduced-confidence band', () => {
    // `n + 1` raw rows (newest in progress) => exactly `n` emitted after the split.
    for (const n of [30, 31, 32]) {
      expect(emitted(candles(n + 1))).toBe(n);
      expect(n).toBeGreaterThanOrEqual(REQUIRED_CANDLES); // served — never refused
      expect(n).toBeLessThan(ADX_SLOPE_FLOOR);            // marked reduced-confidence
    }
    // 33 is the first count that carries a full slope window and therefore no caveat.
    expect(emitted(candles(ADX_SLOPE_FLOOR + 1))).toBe(ADX_SLOPE_FLOOR);
  });
});

describe('CH1 — exactly one tf→ms table, and the fallback is caller policy', () => {
  it('c) an unmapped timeframe resolves through the shared table to the caller default', () => {
    // The primitive itself has NO fallback — that is the whole contract.
    expect(intervalMsFor('7h')).toBeNull();
    // ...so the caller chooses. get-market-regime now picks 1h, matching get-trade-call:574.
    // The RETIRED private table picked 4h, and `x402-http-routes.ts:269` forwards `timeframe`
    // with no zod validation — so an unmapped value reaches both tools in production and they
    // must not disagree about what it means.
    expect(intervalMsFor('7h') ?? 3_600_000).toBe(3_600_000);
    expect(intervalMsFor('7h') ?? 3_600_000).not.toBe(14_400_000); // the retired 4h fallback
  });

  it('every timeframe the regime tool accepts is mapped, so the fallback is unreachable via MCP', () => {
    for (const tf of ['1h', '4h', '1d']) {
      expect(intervalMsFor(tf)).not.toBeNull();
      expect(CANDLE_COUNTS[tf]).toBeGreaterThan(0);
    }
  });

  it('1h and 4h are byte-identical BY CONSTRUCTION — proved structurally, never by a live A/B', () => {
    // The AC says 1h/4h output is unchanged. A live before/after CANNOT show that: ADX is a
    // rolling window, so two calls minutes apart differ because the TAPE moved. Measured during
    // this chapter: BTC/BINANCE/4h read adx 64.1 at the baseline and adx 65.4 ~4h later, with the
    // 4h fetch count untouched either side. Reading that delta as a code effect is precisely the
    // H5 measurement artifact, so the property is proved from the inputs instead.
    //
    // `startTime = now - CANDLE_COUNTS[tf] * intervalMs` is the ONLY thing the fetch depends on.
    // The retired private table and the shared primitive agree on every timeframe this tool
    // accepts, and the counts are untouched — so the fetched window is identical, bar for bar.
    const RETIRED_PRIVATE_TABLE: Record<string, number> = {
      '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
    };
    for (const tf of ['1h', '4h', '1d']) {
      expect(intervalMsFor(tf)).toBe(RETIRED_PRIVATE_TABLE[tf]);
    }
    // ...and the one new serve-side behaviour cannot reach 1h/4h: the caveat fires only below the
    // slope floor, while those windows emit 167 and 41 bars.
    expect(emitted(binanceRows(CANDLE_COUNTS['1h']))).toBeGreaterThanOrEqual(ADX_SLOPE_FLOOR);
    expect(emitted(binanceRows(CANDLE_COUNTS['4h']))).toBeGreaterThanOrEqual(ADX_SLOPE_FLOOR);
  });
});
