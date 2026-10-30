import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the exchange adapter module
vi.mock('../src/lib/exchange-adapter.js', () => ({
  getAdapter: vi.fn(),
}));

import { getMarketRegime } from '../src/tools/get-market-regime.js';
import { getAdapter } from '../src/lib/exchange-adapter.js';
import { InsufficientCandlesError } from '../src/lib/errors.js';
import type { ExchangeAdapter, Candle, FundingData } from '../src/types.js';
import { compatibleWith } from '../src/lib/primitive-projection.js';

const mockTrendingUpCandles = (count: number): Candle[] => {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + i * 3;
    const osc = Math.sin(i * 0.5) * 5;
    return {
      open: base - 1 + osc,
      high: base + 3 + osc,
      low: base - 3 + osc,
      close: base + osc,
      volume: 1000,
      time: Date.now() - (count - i) * 3600000,
    };
  });
};

const mockRangingCandles = (count: number): Candle[] => {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + Math.sin(i * 0.3) * 5;
    return {
      open: base - 0.5,
      high: base + 1,
      low: base - 1,
      close: base,
      volume: 1000,
      time: Date.now() - (count - i) * 3600000,
    };
  });
};

const mockFundings = (coin: string = 'BTC'): FundingData[] => [
  {
    coin,
    venues: [
      { venue: 'HlPerp', fundingRate: 0.0001, nextFundingTime: 1712345600000 },
      { venue: 'BinPerp', fundingRate: 0.0008, nextFundingTime: 1712348400000 },
      { venue: 'BybitPerp', fundingRate: 0.0006, nextFundingTime: 1712348400000 },
    ],
  },
];

function createMockAdapter(
  candles: Candle[] = mockTrendingUpCandles(168),
  fundings: FundingData[] = mockFundings()
): ExchangeAdapter {
  return {
    getName: () => 'MockExchange',
    getCandles: vi.fn().mockResolvedValue(candles),
    getAssetContext: vi.fn().mockResolvedValue({}),
    getPredictedFundings: vi.fn().mockResolvedValue(fundings),
    getCurrentPrice: vi.fn().mockResolvedValue(3000),
  };
}

describe('getMarketRegime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is input-order invariant — venue-descending candles yield the identical regime (EdgeX kline-order class)', async () => {
    const asc = mockTrendingUpCandles(168);
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter(asc));
    const fromAsc = await getMarketRegime({ coin: 'BTC', timeframe: '1h' });

    vi.mocked(getAdapter).mockReturnValue(createMockAdapter([...asc].reverse()));
    const fromDesc = await getMarketRegime({ coin: 'BTC', timeframe: '1h' });

    expect(fromDesc.regime).toBe(fromAsc.regime);
    expect(fromDesc.confidence).toBe(fromAsc.confidence);
    expect(fromDesc.metrics).toEqual(fromAsc.metrics);
  });

  it('returns valid regime for trending data', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());

    const result = await getMarketRegime({ coin: 'BTC', timeframe: '1h' });

    expect(result).toBeDefined();
    expect(['TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'VOLATILE']).toContain(result.regime);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
    expect(result.coin).toBe('BTC');
    expect(result.timeframe).toBe('1h');
    expect(result.metrics).toBeDefined();
    expect(result.suggestion).toBeTruthy();
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('includes _algovault metadata', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());

    const result = await getMarketRegime({ coin: 'BTC' });
    const { PKG_VERSION } = await import('../src/lib/pkg-version.js');
    expect(result._algovault).toBeDefined();
    expect(result._algovault.version).toBe(PKG_VERSION);
    expect(result._algovault.tool).toBe('get_market_regime');
    // OPS-EDITORIAL-PRIMITIVE-RESOLUTION-GATE-W1 CH3: the envelope now PROJECTS from
    // ops/primitive-registry.json, so assert it equals the projection rather than naming
    // packages here. Naming them is exactly what let two bin:null stubs outlive the
    // decision to stop advertising them. `[]` today, and that is the truthful value.
    expect(result._algovault.compatible_with).toEqual(compatibleWith());
  });

  it('includes cross-venue funding sentiment', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());

    const result = await getMarketRegime({ coin: 'BTC' });
    expect(result.metrics.cross_venue_funding_sentiment).toBeDefined();
    expect(['BEARISH_BIAS', 'NEUTRAL', 'BULLISH_BIAS']).toContain(result.metrics.cross_venue_funding_sentiment);
    expect(result.metrics.funding_divergence_note).toBeDefined();
    expect(result.metrics.funding_divergence_note.length).toBeGreaterThan(0);
  });

  it('returns valid metrics structure', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());

    const result = await getMarketRegime({ coin: 'ETH', timeframe: '4h' });

    expect(result.metrics.adx_interpretation).toBeDefined();
    expect(result.metrics.volatility_ratio).toBeDefined();
    expect(result.metrics.volatility_interpretation).toBeDefined();
    expect(result.metrics.price_structure).toBeDefined();
    expect(['HIGHER_HIGHS', 'LOWER_LOWS', 'MIXED']).toContain(result.metrics.price_structure);
    expect(['STRONG', 'MODERATE', 'WEAK']).toContain(result.metrics.trend_strength);
  });

  it('throws the structured InsufficientCandlesError on insufficient data', async () => {
    // TRADIFI-SIGNAL-HARDENING-W1 (R5): structured error replaces the plain
    // "Insufficient candle data ..." string; assert the type, not the message.
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter(mockTrendingUpCandles(10)));

    await expect(getMarketRegime({ coin: 'BTC' }))
      .rejects.toBeInstanceOf(InsufficientCandlesError);
  });

  it('defaults to 4h timeframe', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());

    const result = await getMarketRegime({ coin: 'BTC' });
    expect(result.timeframe).toBe('4h');
  });

  it('provides actionable suggestions', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());

    const result = await getMarketRegime({ coin: 'SOL' });
    expect(result.suggestion.length).toBeGreaterThan(20);
    expect(
      result.suggestion.toLowerCase().includes('trend') ||
      result.suggestion.toLowerCase().includes('mean-reversion') ||
      result.suggestion.toLowerCase().includes('position') ||
      result.suggestion.toLowerCase().includes('range') ||
      result.suggestion.toLowerCase().includes('volatile')
    ).toBe(true);
  });

  it('DECISION-CALL-V1-W1 R4: a 4 h BinPerp row → BINANCE interval_min 240, rate_8h_equiv 2×, sentiment on rate / 4', async () => {
    const fundings: FundingData[] = [{ coin: 'BTC', venues: [
      { venue: 'HlPerp', fundingRate: 0.0001, nextFundingTime: 1712345600000 },
      { venue: 'BinPerp', fundingRate: 0.0008, nextFundingTime: 1712348400000, intervalHours: 4 },
      { venue: 'BybitPerp', fundingRate: 0.0006, nextFundingTime: 1712348400000 },
    ] }];
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter(mockTrendingUpCandles(168), fundings));
    const result = await getMarketRegime({ coin: 'BTC' });
    const fbv = result.metrics.funding_by_venue!;
    expect(fbv.BINANCE).toEqual({ rate: 0.0008, interval_min: 240, rate_8h_equiv: 0.0016 });
    expect(fbv.BYBIT).toEqual({ rate: 0.0006, interval_min: 480, rate_8h_equiv: 0.0006 }); // absent → declared 8 h
    expect(fbv.HL).toEqual({ rate: 0.0001, interval_min: 60, rate_8h_equiv: 0.0008 });
    const bps = (cexBin: number) => (Math.abs(0.0001 - (cexBin + 0.0006 / 8) / 2) * 10000).toFixed(1);
    expect(bps(0.0008 / 4)).not.toBe(bps(0.0008 / 8));                   // the correction is visible
    expect(result.metrics.funding_divergence_note).toContain(`${bps(0.0008 / 4)} bps/hr`);
  });

  it('DECISION-CALL-V1-W1 R4: a row with an unreadable interval is skipped, never priced at 8 h', async () => {
    const fundings: FundingData[] = [{ coin: 'BTC', venues: [
      { venue: 'HlPerp', fundingRate: 0.0001, nextFundingTime: 1712345600000 },
      { venue: 'BinPerp', fundingRate: 0.0008, nextFundingTime: 1712348400000, intervalHours: NaN },
      { venue: 'BybitPerp', fundingRate: 0.0006, nextFundingTime: 1712348400000 },
    ] }];
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter(mockTrendingUpCandles(168), fundings));
    const result = await getMarketRegime({ coin: 'BTC' });
    expect(result.metrics.funding_by_venue).not.toHaveProperty('BINANCE');
    expect(result.metrics.funding_divergence_note).not.toContain('Binance');
  });

  it('detects NEUTRAL sentiment when no cross-venue data', async () => {
    const emptyFundings: FundingData[] = [];
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter(mockTrendingUpCandles(168), emptyFundings));

    const result = await getMarketRegime({ coin: 'BTC' });
    expect(result.metrics.cross_venue_funding_sentiment).toBe('NEUTRAL');
  });
});
