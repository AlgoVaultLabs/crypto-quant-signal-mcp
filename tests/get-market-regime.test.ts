import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/hyperliquid.js', () => ({
  fetchCandles: vi.fn(),
}));

import { getMarketRegime } from '../src/tools/get-market-regime.js';
import { fetchCandles } from '../src/lib/hyperliquid.js';

const mockTrendingUpCandles = (count: number) => {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + i * 3;
    // Add oscillation for swing highs/lows
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

const mockRangingCandles = (count: number) => {
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

const mockVolatileCandles = (count: number) => {
  return Array.from({ length: count }, (_, i) => {
    const base = 100 + (Math.random() - 0.5) * 40;
    return {
      open: base - 5,
      high: base + 15,
      low: base - 15,
      close: base,
      volume: 1000,
      time: Date.now() - (count - i) * 3600000,
    };
  });
};

describe('getMarketRegime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns valid regime for trending data', async () => {
    vi.mocked(fetchCandles).mockResolvedValue(mockTrendingUpCandles(168));

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

  it('returns valid metrics structure', async () => {
    vi.mocked(fetchCandles).mockResolvedValue(mockTrendingUpCandles(168));

    const result = await getMarketRegime({ coin: 'ETH', timeframe: '4h' });

    expect(result.metrics.adx_interpretation).toBeDefined();
    expect(result.metrics.volatility_ratio).toBeDefined();
    expect(result.metrics.volatility_interpretation).toBeDefined();
    expect(result.metrics.price_structure).toBeDefined();
    expect(['HIGHER_HIGHS', 'LOWER_LOWS', 'MIXED']).toContain(result.metrics.price_structure);
    expect(['STRONG', 'MODERATE', 'WEAK']).toContain(result.metrics.trend_strength);
  });

  it('throws on insufficient data', async () => {
    vi.mocked(fetchCandles).mockResolvedValue(mockTrendingUpCandles(10));

    await expect(getMarketRegime({ coin: 'BTC' }))
      .rejects.toThrow(/Insufficient/);
  });

  it('defaults to 4h timeframe', async () => {
    vi.mocked(fetchCandles).mockResolvedValue(mockTrendingUpCandles(168));

    const result = await getMarketRegime({ coin: 'BTC' });
    expect(result.timeframe).toBe('4h');
  });

  it('provides actionable suggestions', async () => {
    vi.mocked(fetchCandles).mockResolvedValue(mockTrendingUpCandles(168));

    const result = await getMarketRegime({ coin: 'SOL' });
    expect(result.suggestion.length).toBeGreaterThan(20);
    // Suggestion should mention strategy guidance
    expect(
      result.suggestion.toLowerCase().includes('trend') ||
      result.suggestion.toLowerCase().includes('mean-reversion') ||
      result.suggestion.toLowerCase().includes('position') ||
      result.suggestion.toLowerCase().includes('range') ||
      result.suggestion.toLowerCase().includes('volatile')
    ).toBe(true);
  });
});
