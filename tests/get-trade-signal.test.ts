import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the exchange adapter module
vi.mock('../src/lib/exchange-adapter.js', () => ({
  getAdapter: vi.fn(),
}));

// Mock performance-db to avoid SQLite in tests
vi.mock('../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  getDb: vi.fn(),
}));

import { getTradeSignal } from '../src/tools/get-trade-signal.js';
import { getAdapter } from '../src/lib/exchange-adapter.js';
import { resetLicenseCache } from '../src/lib/license.js';
import type { ExchangeAdapter, Candle, AssetContext, FundingData } from '../src/types.js';

const mockCandles = (count: number, basePrice: number = 3000, trend: 'up' | 'down' | 'flat' = 'flat'): Candle[] => {
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

const mockAssetContext = (coin: string, funding: number = 0.0001): AssetContext => ({
  coin,
  funding,
  openInterest: 5000000,
  prevDayPx: 2950,
  volume24h: 125000000,
  oraclePx: 3000,
  markPx: 3001,
});

function createMockAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    getName: () => 'MockExchange',
    getCandles: vi.fn().mockResolvedValue(mockCandles(100)),
    getAssetContext: vi.fn().mockResolvedValue(mockAssetContext('ETH')),
    getPredictedFundings: vi.fn().mockResolvedValue([]),
    getCurrentPrice: vi.fn().mockResolvedValue(3000),
    ...overrides,
  };
}

describe('getTradeSignal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLicenseCache();
    process.env.CQS_API_KEY = 'test-key';
  });

  it('returns a valid signal for ETH', async () => {
    const adapter = createMockAdapter();
    vi.mocked(getAdapter).mockReturnValue(adapter);

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

  it('includes _algovault metadata', async () => {
    const adapter = createMockAdapter();
    vi.mocked(getAdapter).mockReturnValue(adapter);

    const result = await getTradeSignal({ coin: 'ETH' });
    expect(result._algovault).toBeDefined();
    expect(result._algovault.version).toBe('1.4.0');
    expect(result._algovault.tool).toBe('get_trade_signal');
    expect(result._algovault.compatible_with).toContain('crypto-quant-risk-mcp');
    expect(result._algovault.compatible_with).toContain('crypto-quant-backtest-mcp');
  });

  it('includes reasoning when requested', async () => {
    const adapter = createMockAdapter({
      getAssetContext: vi.fn().mockResolvedValue(mockAssetContext('BTC')),
    });
    vi.mocked(getAdapter).mockReturnValue(adapter);

    const result = await getTradeSignal({ coin: 'BTC', includeReasoning: true });
    expect(result.reasoning).toBeTruthy();
    expect(result.reasoning.length).toBeGreaterThan(10);
  });

  it('omits reasoning when not requested', async () => {
    const adapter = createMockAdapter({
      getAssetContext: vi.fn().mockResolvedValue(mockAssetContext('BTC')),
    });
    vi.mocked(getAdapter).mockReturnValue(adapter);

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
    const adapter = createMockAdapter({
      getCandles: vi.fn().mockResolvedValue(mockCandles(5)),
    });
    vi.mocked(getAdapter).mockReturnValue(adapter);

    await expect(getTradeSignal({ coin: 'ETH' }))
      .rejects.toThrow(/Insufficient/);
  });

  it('detects bullish conditions with negative funding', async () => {
    const adapter = createMockAdapter({
      getCandles: vi.fn().mockResolvedValue(mockCandles(100, 3000, 'up')),
      getAssetContext: vi.fn().mockResolvedValue(mockAssetContext('ETH', -0.0012)),
    });
    vi.mocked(getAdapter).mockReturnValue(adapter);

    const result = await getTradeSignal({ coin: 'ETH' });
    expect(['BUY', 'HOLD']).toContain(result.signal);
  });
});
