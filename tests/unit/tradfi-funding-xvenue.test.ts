/**
 * Unit tests for the cross-venue TradFi funding aggregation
 * (OPS-TRADFI-XVENUE-FUNDING-W1, R2/R7).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/exchange-adapter.js', () => ({ getAdapter: vi.fn() }));

import { getAdapter } from '../../src/lib/exchange-adapter.js';
import {
  normalizeTo8h,
  priceFingerprintPass,
  computeTradFiFundingSentiment,
  buildFundingByVenue,
  fetchTradFiFundingByVenue,
  _clearTradFiFundingCache,
  _getTradFiFundingCacheState,
  TRADFI_DIVERGENCE_BAND_8H,
  type VenueFunding,
} from '../../src/lib/tradfi-funding.js';
import type { AssetContext, ExchangeId } from '../../src/types.js';

function vf(venue: ExchangeId, rate8hEquiv: number): VenueFunding {
  return { venue, venueSymbol: `${venue}:X`, rate: rate8hEquiv, intervalMinutes: 480, rate8hEquiv, fetchedAt: 0 };
}

describe('normalizeTo8h', () => {
  it('480min (8h) → ×1, 60min (1h) → ×8', () => {
    expect(normalizeTo8h(0.0001, 480)).toBeCloseTo(0.0001, 12);
    expect(normalizeTo8h(0.0001, 60)).toBeCloseTo(0.0008, 12);
  });
  it('invalid inputs → 0 (no silent NaN)', () => {
    expect(normalizeTo8h(NaN, 480)).toBe(0);
    expect(normalizeTo8h(0.0001, 0)).toBe(0);
    expect(normalizeTo8h(0.0001, -60)).toBe(0);
  });
});

describe('priceFingerprintPass (2×-magnitude guard)', () => {
  it('within 2× of median → PASS', () => {
    expect(priceFingerprintPass(421, 422)).toBe(true);
    expect(priceFingerprintPass(800, 422)).toBe(true);  // <2×
    expect(priceFingerprintPass(215, 422)).toBe(true);  // >0.5×
  });
  it('off-magnitude → FAIL (SPX6900 reject)', () => {
    expect(priceFingerprintPass(0.03, 422)).toBe(false);  // ~14000× off
    expect(priceFingerprintPass(1000, 422)).toBe(false);  // >2×
    expect(priceFingerprintPass(100, 422)).toBe(false);   // <0.5×
  });
  it('zero / negative → false', () => {
    expect(priceFingerprintPass(0, 422)).toBe(false);
    expect(priceFingerprintPass(422, 0)).toBe(false);
  });
});

describe('computeTradFiFundingSentiment', () => {
  it('<2 venues → NEUTRAL + "Insufficient cross-venue data" (quorum)', () => {
    const r = computeTradFiFundingSentiment('TSLA', [vf('BINANCE', 0)], false);
    expect(r.sentiment).toBe('NEUTRAL');
    expect(r.divergenceNote).toBe('Insufficient cross-venue data');
  });

  it('aligned (spread within band) → NEUTRAL "within normal band", cites venues + 8h %', () => {
    const r = computeTradFiFundingSentiment('TSLA', [vf('BINANCE', 0), vf('OKX', 0), vf('HL', 0.00008)], false);
    expect(r.sentiment).toBe('NEUTRAL');
    expect(r.divergenceNote).toMatch(/TSLA 8h-funding:/);
    expect(r.divergenceNote).toMatch(/BINANCE 0\.0000% \/ OKX 0\.0000% \/ HL \+0\.0080%/);
    expect(r.divergenceNote).toMatch(/divergence within normal band/);
  });

  it('divergent + net positive → BULLISH_BIAS', () => {
    // spread = 0.002 > band 0.001; mean > 0
    const r = computeTradFiFundingSentiment('GME', [vf('BINANCE', 0.0005), vf('OKX', 0.0025)], false);
    expect(r.sentiment).toBe('BULLISH_BIAS');
    expect(r.divergenceNote).toMatch(/divergent \(spread .* band\)/);
  });

  it('divergent + net negative → BEARISH_BIAS', () => {
    const r = computeTradFiFundingSentiment('GME', [vf('BINANCE', -0.0005), vf('OKX', -0.0025)], false);
    expect(r.sentiment).toBe('BEARISH_BIAS');
  });

  it('weekend-closed appends the structural-premium note', () => {
    const r = computeTradFiFundingSentiment('TSLA', [vf('BINANCE', 0), vf('HL', 0)], true);
    expect(r.divergenceNote).toMatch(/weekend funding premium is structural on frozen-index venues/);
  });

  it('band constant is the calibrated 10 bps', () => {
    expect(TRADFI_DIVERGENCE_BAND_8H).toBe(0.001);
  });
});

describe('buildFundingByVenue', () => {
  it('empty → undefined; populated → venue map', () => {
    expect(buildFundingByVenue([])).toBeUndefined();
    const m = buildFundingByVenue([vf('BINANCE', 0.0001), vf('HL', 0.00008)]);
    expect(Object.keys(m!)).toEqual(['BINANCE', 'HL']);
    expect(m!.BINANCE).toEqual({ rate: 0.0001, interval_min: 480, rate_8h_equiv: 0.0001 });
  });
});

// ── fetchTradFiFundingByVenue (I/O, cache trio, fingerprint) ──
function ctx(funding: number, markPx: number): AssetContext {
  return { coin: 'X', funding, fundingAnnualized: funding * 1095, openInterest: 1, prevDayPx: markPx, volume24h: 1, oraclePx: markPx, markPx };
}
function adapterReturning(map: Partial<Record<ExchangeId, { funding: number; px: number } | 'throw'>>) {
  return (venue: ExchangeId) => {
    const spec = map[venue];
    return {
      getName: () => venue,
      getCandles: vi.fn(),
      getAssetContext: vi.fn(async () => {
        if (!spec || spec === 'throw') throw new Error(`${venue} down`);
        return ctx(spec.funding, spec.px);
      }),
      getPredictedFundings: vi.fn(),
      getFundingHistory: vi.fn(),
      getCurrentPrice: vi.fn(),
    };
  };
}

describe('fetchTradFiFundingByVenue (cache trio + fail-soft + fingerprint)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearTradFiFundingCache();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => { _clearTradFiFundingCache(); vi.restoreAllMocks(); });

  it('aggregates promoted venues; caches per coin (cache-trio inspector)', async () => {
    // TSLA is supported on all 5 promoted venues. All return sane prices ~421.
    vi.mocked(getAdapter).mockImplementation(adapterReturning({
      HL: { funding: -0.000015, px: 421.6 }, BINANCE: { funding: 0, px: 421.7 },
      BYBIT: { funding: 0, px: 421.9 }, OKX: { funding: 0, px: 422.1 }, BITGET: { funding: 0, px: 0.03 },
    }));
    const out = await fetchTradFiFundingByVenue('TSLA');
    expect(out.length).toBe(5); // Bitget kept despite broken price (funding trusted)
    expect(out.map(v => v.venue).sort()).toContain('BITGET');
    expect(_getTradFiFundingCacheState()).toEqual({ size: 1, coins: ['TSLA'] });

    // 2nd call within TTL is served from cache (no new adapter calls).
    const callsBefore = vi.mocked(getAdapter).mock.calls.length;
    await fetchTradFiFundingByVenue('TSLA');
    expect(vi.mocked(getAdapter).mock.calls.length).toBe(callsBefore);

    _clearTradFiFundingCache();
    expect(_getTradFiFundingCacheState()).toEqual({ size: 0, coins: [] });
  });

  it('fail-soft: venues that throw are omitted (never throws)', async () => {
    vi.mocked(getAdapter).mockImplementation(adapterReturning({
      HL: { funding: 0, px: 421 }, BINANCE: 'throw', BYBIT: 'throw', OKX: 'throw', BITGET: 'throw',
    }));
    const out = await fetchTradFiFundingByVenue('TSLA');
    expect(out.map(v => v.venue)).toEqual(['HL']); // only HL survived → quorum handled downstream
  });

  it('fingerprint drops a non-Bitget venue with off-magnitude price; keeps Bitget', async () => {
    vi.mocked(getAdapter).mockImplementation(adapterReturning({
      HL: { funding: 0, px: 421.6 }, BINANCE: { funding: 0, px: 421.7 },
      BYBIT: { funding: 0, px: 421.9 },
      OKX: { funding: 0.05, px: 9999 },     // 24× off → symbol misID → DROPPED
      BITGET: { funding: 0, px: 0.03 },     // adapter-bug price → EXEMPT → kept
    }));
    const out = await fetchTradFiFundingByVenue('TSLA');
    const venues = out.map(v => v.venue);
    expect(venues).not.toContain('OKX');   // fingerprint-dropped
    expect(venues).toContain('BITGET');    // exempt (funding trusted)
    expect(venues).toContain('HL');
  });
});
