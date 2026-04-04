import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/hyperliquid.js', () => ({
  fetchPredictedFundings: vi.fn(),
}));

import { scanFundingArb } from '../src/tools/scan-funding-arb.js';
import { fetchPredictedFundings } from '../src/lib/hyperliquid.js';
import { resetLicenseCache } from '../src/lib/license.js';

const mockFundings = () => [
  [
    'DOGE',
    [
      ['HlPerp', { fundingRate: '0.0001', nextFundingTime: 1712345600000 }],
      ['BinPerp', { fundingRate: '0.0008', nextFundingTime: 1712348400000 }],
      ['BybitPerp', { fundingRate: '0.0006', nextFundingTime: 1712348400000 }],
    ],
  ],
  [
    'BTC',
    [
      ['HlPerp', { fundingRate: '0.0002', nextFundingTime: 1712345600000 }],
      ['BinPerp', { fundingRate: '0.0003', nextFundingTime: 1712348400000 }],
    ],
  ],
  [
    'ETH',
    [
      ['HlPerp', { fundingRate: '-0.0001', nextFundingTime: 1712345600000 }],
      ['BinPerp', { fundingRate: '0.0010', nextFundingTime: 1712348400000 }],
      ['BybitPerp', { fundingRate: '0.0005', nextFundingTime: 1712348400000 }],
    ],
  ],
] as any;

describe('scanFundingArb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLicenseCache();
    process.env.CQS_API_KEY = 'test-key';
  });

  it('returns opportunities sorted by annualized spread', async () => {
    vi.mocked(fetchPredictedFundings).mockResolvedValue(mockFundings());

    const result = await scanFundingArb({ minSpreadBps: 0 });
    expect(result.opportunities.length).toBeGreaterThan(0);
    expect(result.scannedPairs).toBe(3);
    expect(result.timestamp).toBeGreaterThan(0);

    // Should be sorted descending by annualized pct
    for (let i = 1; i < result.opportunities.length; i++) {
      expect(result.opportunities[i - 1].bestArb.annualizedPct)
        .toBeGreaterThanOrEqual(result.opportunities[i].bestArb.annualizedPct);
    }
  });

  it('filters by minSpreadBps', async () => {
    vi.mocked(fetchPredictedFundings).mockResolvedValue(mockFundings());

    const result = await scanFundingArb({ minSpreadBps: 100 });
    // With high min spread, fewer or no results
    for (const opp of result.opportunities) {
      expect(opp.bestArb.spreadBps).toBeGreaterThanOrEqual(100);
    }
  });

  it('respects limit', async () => {
    vi.mocked(fetchPredictedFundings).mockResolvedValue(mockFundings());

    const result = await scanFundingArb({ minSpreadBps: 0, limit: 1 });
    expect(result.opportunities.length).toBeLessThanOrEqual(1);
  });

  it('applies free tier limit of 5', async () => {
    delete process.env.CQS_API_KEY;
    resetLicenseCache();
    vi.mocked(fetchPredictedFundings).mockResolvedValue(mockFundings());

    const result = await scanFundingArb({ minSpreadBps: 0, limit: 100 });
    expect(result.opportunities.length).toBeLessThanOrEqual(5);
  });

  it('correctly identifies long/short venues', async () => {
    vi.mocked(fetchPredictedFundings).mockResolvedValue(mockFundings());

    const result = await scanFundingArb({ minSpreadBps: 0 });
    for (const opp of result.opportunities) {
      expect(opp.bestArb.longVenue).toBeDefined();
      expect(opp.bestArb.shortVenue).toBeDefined();
      expect(opp.bestArb.longVenue).not.toBe(opp.bestArb.shortVenue);
      expect(opp.bestArb.annualizedPct).toBeGreaterThan(0);
    }
  });

  it('handles coins with only one venue', async () => {
    vi.mocked(fetchPredictedFundings).mockResolvedValue([
      ['SOLO', [['HlPerp', { fundingRate: '0.0001', nextFundingTime: 1712345600000 }]]],
    ] as any);

    const result = await scanFundingArb({ minSpreadBps: 0 });
    expect(result.opportunities.length).toBe(0);
  });
});
