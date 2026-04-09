import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the exchange adapter module
vi.mock('../src/lib/exchange-adapter.js', () => ({
  getAdapter: vi.fn(),
}));

import { getMarketRegime } from '../src/tools/get-market-regime.js';
import { getAdapter } from '../src/lib/exchange-adapter.js';
import type { ExchangeAdapter, Candle, FundingData } from '../src/types.js';

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
    expect(result._algovault).toBeDefined();
    expect(result._algovault.version).toBe('1.4.0');
    expect(result._algovault.tool).toBe('get_market_regime');
    expect(result._algovault.compatible_with).toContain('crypto-quant-risk-mcp');
    expect(result._algovault.compatible_with).toContain('crypto-quant-backtest-mcp');
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

  it('throws on insufficient data', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter(mockTrendingUpCandles(10)));

    await expect(getMarketRegime({ coin: 'BTC' }))
      .rejects.toThrow(/Insufficient/);
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

  it('detects NEUTRAL sentiment when no cross-venue data', async () => {
    const emptyFundings: FundingData[] = [];
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter(mockTrendingUpCandles(168), emptyFundings));

    const result = await getMarketRegime({ coin: 'BTC' });
    expect(result.metrics.cross_venue_funding_sentiment).toBe('NEUTRAL');
  });
});
