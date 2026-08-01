// FIX-CONVICTION-CALL-POSTS-W1 — the universe-side USD liquidity floor.
//
// WHY IT EXISTS: the weekly public "top setups" post was surfacing whatever the scan
// ranked highest with no liquidity qualification at all. A live scan on 2026-08-01
// returned 1000RATS / GIGGLE / KOMA — three illiquid microcaps, all at 51% conviction,
// all carrying byte-identical reasoning prose. `minConfidence` cannot fix that (they
// clear any honest confidence bar), and a CONSUMER cannot fix it either: the per-call
// payload carries no liquidity field. So the floor has to gate the universe, server-side.
//
// The rule itself (`effectiveLiquidityUsd`) is shared with scan_funding_arb's per-leg
// gate — one derivation, two consumers — and these tests pin the proxy-venue branch that
// makes the two agree.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { effectiveLiquidityUsd } from '../src/lib/exchange-universe.js';
import {
  scanTradeCalls,
  _setScanScorerForTest,
  _setLiquidityMapForTest,
  _clearScanCaches,
  type ScanScore,
} from '../src/lib/trade-call-scanner.js';
import type { ExchangeAsset } from '../src/lib/exchange-universe.js';

vi.mock('../src/lib/exchange-universe.js', async (importOriginal) => {
  // Keep the REAL effectiveLiquidityUsd — it is the thing under test — and stub only the
  // network-bound universe fetchers.
  const actual = await importOriginal<typeof import('../src/lib/exchange-universe.js')>();
  return {
    ...actual,
    getExchangeTopAssetsWithVolume: vi.fn(),
    fetchVenueUniverse: vi.fn(),
  };
});

import { getExchangeTopAssetsWithVolume } from '../src/lib/exchange-universe.js';
const mockUniverse = vi.mocked(getExchangeTopAssetsWithVolume);

/** LIQUID is comfortably large; THIN is deliberately below any floor used here. */
const LIQUID = 50_000_000;
const THIN = 250_000;

beforeEach(() => {
  _clearScanCaches();
  _setLiquidityMapForTest(null);
  // Universe: one liquid major + one thin microcap, both scoring BUY so neither is
  // filtered by verdict — any difference in the output is the floor's doing alone.
  mockUniverse.mockResolvedValue([
    { coin: 'BTC', notionalOI_usd: LIQUID, volume24h_usd: LIQUID },
    { coin: 'GIGGLE', notionalOI_usd: THIN, volume24h_usd: THIN },
  ] as ExchangeAsset[]);
  _setScanScorerForTest(async (coin, timeframe): Promise<ScanScore> => ({
    coin, timeframe, call: 'BUY', confidence: 51, regime: 'TRENDING_UP',
  }));
});

describe('effectiveLiquidityUsd — one rule, two consumers', () => {
  it('reads notional OI on a real-OI venue', () => {
    expect(effectiveLiquidityUsd({ notionalOI_usd: 10, volume24h_usd: 999 })).toBe(10);
  });

  it('reads 24h VOLUME on a proxy venue — reading OI there would mis-gate it', () => {
    // This is the branch that makes the scan floor agree with scan_funding_arb's per-leg
    // gate. A venue with no bulk-OI endpoint carries a volume proxy in notionalOI_usd.
    expect(effectiveLiquidityUsd({ notionalOI_usd: 10, volume24h_usd: 999, oiIsProxy: true })).toBe(999);
  });

  it('default-DENIES on a missing or non-finite figure (never admits the unknown)', () => {
    expect(effectiveLiquidityUsd({ notionalOI_usd: NaN, volume24h_usd: 0 })).toBe(0);
    expect(effectiveLiquidityUsd({ notionalOI_usd: -5, volume24h_usd: 0 })).toBe(0);
    expect(effectiveLiquidityUsd({ notionalOI_usd: Infinity, volume24h_usd: 0 })).toBe(0);
  });
});

describe('scan universe liquidity floor', () => {
  it('OMITTED ⇒ byte-identical: the thin microcap is still returned', async () => {
    const r = await scanTradeCalls({ exchange: 'BINANCE', timeframe: '1h', topN: 10, includeReasoning: false });
    expect(r.calls.map((c) => c.coin).sort()).toEqual(['BTC', 'GIGGLE']);
    expect(r.scanned).toBe(2);
  });

  it('THE FIX: a floor drops the illiquid microcap and keeps the major', async () => {
    _setLiquidityMapForTest(() => new Map([['BTC', LIQUID], ['GIGGLE', THIN]]));
    const r = await scanTradeCalls({
      exchange: 'BINANCE', timeframe: '1h', topN: 10, minLiquidityUsd: 5_000_000,
    });
    expect(r.calls.map((c) => c.coin)).toEqual(['BTC']);
    // `scanned` must reflect the GATED universe — it is the number the public post
    // prints as "N assets scanned", so an ungated count there would be a false claim.
    expect(r.scanned).toBe(1);
  });

  it('a floor of 0 is treated as no floor (not as "deny everything")', async () => {
    _setLiquidityMapForTest(() => new Map());
    const r = await scanTradeCalls({ exchange: 'BINANCE', timeframe: '1h', topN: 10, minLiquidityUsd: 0 });
    expect(r.calls.map((c) => c.coin).sort()).toEqual(['BTC', 'GIGGLE']);
  });

  it('an UNREACHABLE liquidity source default-DENIES rather than scanning ungated', async () => {
    // The dangerous failure is the opposite one: silently publishing an unqualified list
    // because the floor could not be evaluated. Empty map ⇒ nothing clears.
    _setLiquidityMapForTest(() => new Map());
    const r = await scanTradeCalls({
      exchange: 'BINANCE', timeframe: '1h', topN: 10, minLiquidityUsd: 5_000_000,
    });
    expect(r.calls).toEqual([]);
    expect(r.scanned).toBe(0);
  });

  it('an asset ABSENT from the liquidity map does not clear the floor', async () => {
    _setLiquidityMapForTest(() => new Map([['BTC', LIQUID]]));
    const r = await scanTradeCalls({
      exchange: 'BINANCE', timeframe: '1h', topN: 10, minLiquidityUsd: 5_000_000,
    });
    expect(r.calls.map((c) => c.coin)).toEqual(['BTC']);
  });
});
