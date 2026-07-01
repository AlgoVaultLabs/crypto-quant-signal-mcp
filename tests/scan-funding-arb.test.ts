import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the exchange adapter module
vi.mock('../src/lib/exchange-adapter.js', () => ({
  getAdapter: vi.fn(),
}));

import { scanFundingArb, _resetScanFundingArbCaches, _resetPredictedFundingsCache, _getScanFundingArbCacheSizes, _setLiquidityOverrideForTest } from '../src/tools/scan-funding-arb.js';
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
    getFundingHistory: vi.fn().mockResolvedValue([]),
    getCurrentPrice: vi.fn().mockResolvedValue(3000),
  };
}

describe('scanFundingArb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLicenseCache();
    _resetScanFundingArbCaches(); // C5: clear module-level TTL caches between tests
    // OPS-FUNDING-ARB-EXPAND-W1: default every leg liquid so the pre-existing spread tests stay gate-
    // neutral (the gate is exercised by the dedicated liquidity-gate test) + no live SoT fetch.
    _setLiquidityOverrideForTest(() => Infinity);
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
    const { PKG_VERSION } = await import('../src/lib/pkg-version.js');
    expect(result._algovault.version).toBe(PKG_VERSION);
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

  // ── LATENCY-W1 C4: sort-then-slice (saves ~50% per-coin history fetches) ──

  it('AC4.1: limit=10 with 80 qualifying opps fetches history ≤20 times (limit*2 cushion), not 80', async () => {
    const manyFundings: FundingData[] = Array.from({ length: 80 }, (_, i) => ({
      coin: `COIN${i}`,
      venues: [
        { venue: 'HlPerp',  fundingRate: 0.0001 + i * 0.00001, nextFundingTime: 1712345600000 },
        { venue: 'BinPerp', fundingRate: 0.0010 + i * 0.00002, nextFundingTime: 1712348400000 },
      ],
    }));
    const historySpy = vi.fn().mockResolvedValue([]);
    const adapter = createMockAdapter(manyFundings);
    adapter.getFundingHistory = historySpy;
    vi.mocked(getAdapter).mockReturnValue(adapter);

    const result = await scanFundingArb({ minSpreadBps: 0, limit: 10 });

    // BEFORE C4: 80 calls. AFTER C4: ≤ limit*2 = 20.
    expect(historySpy.mock.calls.length).toBeLessThanOrEqual(20);
    expect(historySpy.mock.calls.length).toBeGreaterThan(0);

    // Response shape unchanged: opportunities ≤ limit
    expect(result.opportunities.length).toBeLessThanOrEqual(10);

    // scannedPairs reflects total venues scanned (true count), not the slice
    expect(result.scannedPairs).toBe(80);
  });

  it('AC4: top opportunity (sorted by spread DESC) survives the slice', async () => {
    const sortedFundings: FundingData[] = [
      { coin: 'TINY', venues: [
        { venue: 'HlPerp',  fundingRate: 0.00001, nextFundingTime: 1712345600000 },
        { venue: 'BinPerp', fundingRate: 0.00002, nextFundingTime: 1712348400000 },
      ]},
      { coin: 'HUGE', venues: [
        { venue: 'HlPerp',  fundingRate: 0.0001, nextFundingTime: 1712345600000 },
        { venue: 'BinPerp', fundingRate: 0.01, nextFundingTime: 1712348400000 },
      ]},
      { coin: 'MED', venues: [
        { venue: 'HlPerp',  fundingRate: 0.0001, nextFundingTime: 1712345600000 },
        { venue: 'BinPerp', fundingRate: 0.001, nextFundingTime: 1712348400000 },
      ]},
    ];
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter(sortedFundings));

    const result = await scanFundingArb({ minSpreadBps: 0, limit: 1 });
    expect(result.opportunities.length).toBe(1);
    expect(result.opportunities[0].coin).toBe('HUGE');
  });

  it('AC4: slice cushion of 2× limit fills `limit` exactly when N=30, limit=5', async () => {
    const fundings: FundingData[] = Array.from({ length: 30 }, (_, i) => ({
      coin: `C${i}`,
      venues: [
        { venue: 'HlPerp',  fundingRate: 0.0001, nextFundingTime: 1712345600000 },
        { venue: 'BinPerp', fundingRate: 0.001 + i * 0.0001, nextFundingTime: 1712348400000 },
      ],
    }));
    const historySpy = vi.fn().mockResolvedValue([]);
    const adapter = createMockAdapter(fundings);
    adapter.getFundingHistory = historySpy;
    vi.mocked(getAdapter).mockReturnValue(adapter);

    const result = await scanFundingArb({ minSpreadBps: 0, limit: 5 });
    expect(historySpy.mock.calls.length).toBeLessThanOrEqual(10); // limit*2
    expect(result.opportunities.length).toBe(5);                  // exactly limit
  });

  // ── LATENCY-W1 C5: TTL caches (predictedFundings 30s + fundingHistory 60s LRU 200) ──

  it('AC5.1: predictedFundings cache — back-to-back calls within TTL hit cache (1 fetch, not 2)', async () => {
    const predictedSpy = vi.fn().mockResolvedValue(mockFundings());
    const adapter = createMockAdapter();
    adapter.getPredictedFundings = predictedSpy;
    vi.mocked(getAdapter).mockReturnValue(adapter);

    await scanFundingArb({ minSpreadBps: 0 });
    await scanFundingArb({ minSpreadBps: 0 });
    await scanFundingArb({ minSpreadBps: 0 });

    expect(predictedSpy.mock.calls.length).toBe(5); // scan 1 = 5 fetch-adapters (HL/GATE/KUCOIN/ASTER/OKX); scans 2-3 = cache hits
  });

  it('AC5.1: fundingHistory cache — same coin within TTL hits cache', async () => {
    const historySpy = vi.fn().mockResolvedValue([
      { time: Date.now(), fundingRate: 0.0001 },
    ]);
    const adapter = createMockAdapter();
    adapter.getFundingHistory = historySpy;
    vi.mocked(getAdapter).mockReturnValue(adapter);

    // First call: 3 unique coins → 3 history fetches
    await scanFundingArb({ minSpreadBps: 0 });
    const firstCallCount = historySpy.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    // Second call: same 3 coins → 0 additional fetches (all cache hits)
    await scanFundingArb({ minSpreadBps: 0 });
    expect(historySpy.mock.calls.length).toBe(firstCallCount);
  });

  it('AC5.2: LRU cap — fundingHistorySize never exceeds FUNDING_HISTORY_CACHE_MAX (200) after inserts', async () => {
    // Use explicit pro-tier license to bypass free-tier limit cap of 5.
    // With limit=10, candidates per scan = limit*SLICE_CUSHION = 20.
    // 12 scans × 20 unique coins each = 240 attempted unique keys → cap should hold at 200.
    const proLicense = { tier: 'pro' as const, key: 'test-pro-key' };

    let scanIndex = 0;
    const historySpy = vi.fn().mockResolvedValue([]);
    vi.mocked(getAdapter).mockImplementation(() => {
      const fundings: FundingData[] = Array.from({ length: 22 }, (_, i) => ({
        coin: `LRU_${scanIndex}_${i}`,
        venues: [
          { venue: 'HlPerp',  fundingRate: 0.0001, nextFundingTime: 1712345600000 },
          { venue: 'BinPerp', fundingRate: 0.001 + i * 0.0001, nextFundingTime: 1712348400000 },
        ],
      }));
      const a = createMockAdapter(fundings);
      a.getFundingHistory = historySpy;
      return a;
    });

    for (let i = 0; i < 12; i++) {
      scanIndex = i;
      // Force fresh predictedFundings each iteration so each scan adds new
      // unique coins to fundingHistoryCache (otherwise scan 0's predicted
      // result would be cached and reused by scans 1-11). Doesn't touch
      // fundingHistoryCache — that's what we're stress-testing.
      _resetPredictedFundingsCache();
      await scanFundingArb({ minSpreadBps: 0, limit: 10, license: proLicense });
    }

    const sizes = _getScanFundingArbCacheSizes();
    // Cap MUST hold at 200 (240 attempted - 40 evicted = 200)
    expect(sizes.fundingHistorySize).toBe(sizes.fundingHistoryCap);
    expect(sizes.fundingHistorySize).toBe(200);
    // Spy was called 240 times (each scan = 20 fetches; LRU evicts cache slots, not fetches)
    expect(historySpy.mock.calls.length).toBe(240);
  });

  it('AC5: cache reset hook clears both caches (test isolation guarantee)', async () => {
    const predictedSpy = vi.fn().mockResolvedValue(mockFundings());
    const adapter = createMockAdapter();
    adapter.getPredictedFundings = predictedSpy;
    vi.mocked(getAdapter).mockReturnValue(adapter);

    await scanFundingArb({ minSpreadBps: 0 });
    expect(predictedSpy.mock.calls.length).toBe(5); // 5 fetch-adapters (HL/GATE/KUCOIN/ASTER/OKX)

    // Reset → next call must miss cache + re-fetch
    _resetScanFundingArbCaches();

    await scanFundingArb({ minSpreadBps: 0 });
    expect(predictedSpy.mock.calls.length).toBe(10); // +5 after reset
  });

  it('OPS-FUNDING-ARB-EXPAND-W1 (Q-B): per-leg liquidity gate excludes an illiquid leg (no false spread)', async () => {
    // THICK + DOGE both have a big HL/Bin funding spread; DOGE is ILLIQUID on Binance (below the $1M
    // floor) → its HL/Bin pair must NOT surface (left with <2 liquid legs). THICK stays liquid → surfaces.
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter([
      { coin: 'THICK', venues: [
        { venue: 'HlPerp',  fundingRate: 0.0001, nextFundingTime: 1712345600000 },
        { venue: 'BinPerp', fundingRate: 0.0009, nextFundingTime: 1712348400000 },
      ] },
      { coin: 'DOGE', venues: [
        { venue: 'HlPerp',  fundingRate: 0.0001, nextFundingTime: 1712345600000 },
        { venue: 'BinPerp', fundingRate: 0.0009, nextFundingTime: 1712348400000 },
      ] },
    ]));
    _setLiquidityOverrideForTest((exchangeId, coin) =>
      coin === 'DOGE' && exchangeId === 'BINANCE' ? 100 : 50_000_000);

    const coins = (await scanFundingArb({ minSpreadBps: 0 })).opportunities.map(o => o.coin);
    expect(coins).toContain('THICK');
    expect(coins).not.toContain('DOGE'); // illiquid Binance leg gated → DOGE has 1 liquid leg → no spread
  });
});
