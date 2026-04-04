import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the hyperliquid module before importing the tool
vi.mock('../src/lib/hyperliquid.js', () => ({
  fetchCandles: vi.fn(),
  fetchMetaAndAssetCtxs: vi.fn(),
  fetchCurrentPrice: vi.fn(),
}));

// Mock performance-db to avoid SQLite in tests
vi.mock('../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  getDb: vi.fn(),
}));

import { getTradeSignal } from '../src/tools/get-trade-signal.js';
import { fetchCandles, fetchMetaAndAssetCtxs } from '../src/lib/hyperliquid.js';
import { resetLicenseCache } from '../src/lib/license.js';

const mockCandles = (count: number, basePrice: number = 3000, trend: 'up' | 'down' | 'flat' = 'flat') => {
  return Array.from({ length: count }, (_, i) => {
    const offset = trend === 'up' ? i * 10 : trend === 'down' ? -i * 10 : Math.sin(i) * 20;
    const close = basePrice + offset;
    return {
      open: close - 5,
      high: close + 10,
      low: close - 10,
      close,
      volume: 1000 + Math.random() * 500,
      time: Date.now() - (count - i) * 3600000,
    };
  });
};

const mockMeta = (coin: string, funding: string = '0.0001', oi: string = '5000000') => ({
  meta: {
    universe: [{ name: coin, szDecimals: 2, maxLeverage: 50 }],
  },
  assetCtxs: [{
    funding,
    openInterest: oi,
    prevDayPx: '2950',
    dayNtlVlm: '125000000',
    premium: '0.001',
    oraclePx: '3000',
    markPx: '3001',
  }],
});

describe('getTradeSignal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLicenseCache();
    // Set pro tier for tests
    process.env.CQS_API_KEY = 'test-key';
  });

  it('returns a valid signal for ETH', async () => {
    vi.mocked(fetchCandles).mockResolvedValue(mockCandles(100));
    vi.mocked(fetchMetaAndAssetCtxs).mockResolvedValue(mockMeta('ETH'));

    const result = await getTradeSignal({ coin: 'ETH', timeframe: '1h' });

    expect(result).toBeDefined();
    expect(['BUY', 'SELL', 'HOLD']).toContain(result.signal);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
    expect(result.coin).toBe('ETH');
    expect(result.timeframe).toBe('1h');
    expect(result.price).toBeGreaterThan(0);
    expect(result.indicators).toBeDefined();
    expect(result.indicators.rsi).not.toBeUndefined();
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('includes reasoning when requested', async () => {
    vi.mocked(fetchCandles).mockResolvedValue(mockCandles(100));
    vi.mocked(fetchMetaAndAssetCtxs).mockResolvedValue(mockMeta('BTC'));

    const result = await getTradeSignal({ coin: 'BTC', includeReasoning: true });
    expect(result.reasoning).toBeTruthy();
    expect(result.reasoning.length).toBeGreaterThan(10);
  });

  it('omits reasoning when not requested', async () => {
    vi.mocked(fetchCandles).mockResolvedValue(mockCandles(100));
    vi.mocked(fetchMetaAndAssetCtxs).mockResolvedValue(mockMeta('BTC'));

    const result = await getTradeSignal({ coin: 'BTC', includeReasoning: false });
    expect(result.reasoning).toBe('');
  });

  it('throws on free tier for non-BTC/ETH', async () => {
    delete process.env.CQS_API_KEY;
    resetLicenseCache();

    await expect(getTradeSignal({ coin: 'SOL', timeframe: '1h' }))
      .rejects.toThrow(/Pro/);
  });

  it('throws on free tier for non-1h timeframe', async () => {
    delete process.env.CQS_API_KEY;
    resetLicenseCache();

    await expect(getTradeSignal({ coin: 'BTC', timeframe: '4h' }))
      .rejects.toThrow(/Pro/);
  });

  it('throws on insufficient candle data', async () => {
    vi.mocked(fetchCandles).mockResolvedValue(mockCandles(5));
    vi.mocked(fetchMetaAndAssetCtxs).mockResolvedValue(mockMeta('ETH'));

    await expect(getTradeSignal({ coin: 'ETH' }))
      .rejects.toThrow(/Insufficient/);
  });

  it('throws when coin is not found on HL', async () => {
    vi.mocked(fetchCandles).mockResolvedValue(mockCandles(100));
    vi.mocked(fetchMetaAndAssetCtxs).mockResolvedValue(mockMeta('BTC'));

    await expect(getTradeSignal({ coin: 'ETH' }))
      .rejects.toThrow(/not found/);
  });

  it('detects bullish conditions with negative funding', async () => {
    vi.mocked(fetchCandles).mockResolvedValue(mockCandles(100, 3000, 'up'));
    vi.mocked(fetchMetaAndAssetCtxs).mockResolvedValue(mockMeta('ETH', '-0.0012'));

    const result = await getTradeSignal({ coin: 'ETH' });
    // With uptrend + negative funding, should lean bullish
    expect(['BUY', 'HOLD']).toContain(result.signal);
  });
});
