import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the exchange adapter module
vi.mock('../src/lib/exchange-adapter.js', () => ({
  getAdapter: vi.fn(),
}));

import { scanFundingArb } from '../src/tools/scan-funding-arb.js';
import { getAdapter } from '../src/lib/exchange-adapter.js';
import { resetLicenseCache } from '../src/lib/license.js';
import type { ExchangeAdapter, FundingData } from '../src/types.js';

const mockFundings = (): FundingData[] => [
  {
    coin: 'DOGE',
    venues: [
      { venue: 'HlPerp', fundingRate: 0.0001, nextFundingTime: 1712345600000 },
      { venue: 'BinPerp', fundingRate: 0.0008, nextFundingTime: 1712348400000 },
      { venue: 'BybitPerp', fundingRate: 0.0006, nextFundingTime: 1712348400000 },
    ],
  },
  {
    coin: 'BTC',
    venues: [
      { venue: 'HlPerp', fundingRate: 0.0002, nextFundingTime: 1712345600000 },
      { venue: 'BinPerp', fundingRate: 0.0003, nextFundingTime: 1712348400000 },
    ],
  },
  {
    coin: 'ETH',
    venues: [
      { venue: 'HlPerp', fundingRate: -0.0001, nextFundingTime: 1712345600000 },
      { venue: 'BinPerp', fundingRate: 0.0010, nextFundingTime: 1712348400000 },
      { venue: 'BybitPerp', fundingRate: 0.0005, nextFundingTime: 1712348400000 },
    ],
  },
];

function createMockAdapter(fundings: FundingData[] = mockFundings()): ExchangeAdapter {
  return {
    getName: () => 'MockExchange',
    getCandles: vi.fn().mockResolvedValue([]),
    getAssetContext: vi.fn().mockResolvedValue({}),
    getPredictedFundings: vi.fn().mockResolvedValue(fundings),
    getCurrentPrice: vi.fn().mockResolvedValue(3000),
  };
}

describe('scanFundingArb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLicenseCache();
    process.env.CQS_API_KEY = 'test-key';
  });

  it('returns opportunities sorted by annualized spread', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());

    const result = await scanFundingArb({ minSpreadBps: 0 });
    expect(result.opportunities.length).toBeGreaterThan(0);
    expect(result.scannedPairs).toBe(3);
    expect(result.timestamp).toBeGreaterThan(0);

    for (let i = 1; i < result.opportunities.length; i++) {
      expect(result.opportunities[i - 1].bestArb.annualizedPct)
        .toBeGreaterThanOrEqual(result.opportunities[i].bestArb.annualizedPct);
    }
  });

  it('includes _algovault metadata', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());

    const result = await scanFundingArb({ minSpreadBps: 0 });
    expect(result._algovault).toBeDefined();
    expect(result._algovault.version).toBe('1.4.0');
    expect(result._algovault.tool).toBe('scan_funding_arb');
    expect(result._algovault.compatible_with).toContain('crypto-quant-risk-mcp');
    expect(result._algovault.compatible_with).toContain('crypto-quant-execution-mcp');
  });

  it('filters by minSpreadBps', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());

    const result = await scanFundingArb({ minSpreadBps: 100 });
    for (const opp of result.opportunities) {
      expect(opp.bestArb.spreadBps).toBeGreaterThanOrEqual(100);
    }
  });

  it('respects limit', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());

    const result = await scanFundingArb({ minSpreadBps: 0, limit: 1 });
    expect(result.opportunities.length).toBeLessThanOrEqual(1);
  });

  it('applies free tier limit of 5', async () => {
    delete process.env.CQS_API_KEY;
    resetLicenseCache();
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());

    const result = await scanFundingArb({ minSpreadBps: 0, limit: 100 });
    expect(result.opportunities.length).toBeLessThanOrEqual(5);
  });

  it('correctly identifies long/short venues', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());

    const result = await scanFundingArb({ minSpreadBps: 0 });
    for (const opp of result.opportunities) {
      expect(opp.bestArb.longVenue).toBeDefined();
      expect(opp.bestArb.shortVenue).toBeDefined();
      expect(opp.bestArb.longVenue).not.toBe(opp.bestArb.shortVenue);
      expect(opp.bestArb.annualizedPct).toBeGreaterThan(0);
    }
  });

  it('handles coins with only one venue', async () => {
    const singleVenueFundings: FundingData[] = [
      { coin: 'SOLO', venues: [{ venue: 'HlPerp', fundingRate: 0.0001, nextFundingTime: 1712345600000 }] },
    ];
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter(singleVenueFundings));

    const result = await scanFundingArb({ minSpreadBps: 0 });
    expect(result.opportunities.length).toBe(0);
  });
});
