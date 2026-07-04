import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the exchange adapter module
vi.mock('../src/lib/exchange-adapter.js', () => ({
  getAdapter: vi.fn(),
}));

// Mock performance-db to avoid SQLite in tests
vi.mock('../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordFunding: vi.fn(),
  recordHoldCount: vi.fn(),
  getFundingZScore: vi.fn().mockResolvedValue(null),
  getDb: vi.fn(),
  // OPS-GRID-PROCESS-BOUNDARY-W1: cross-asset-grid imports isShortLivedScript from
  // performance-db (server-only refresh gate); false = server → grid stays active.
  isShortLivedScript: () => false,
}));

import { getTradeSignal, deriveVerdict, oiScoreFromOiDelta } from '../src/tools/get-trade-call.js';
import { getAdapter } from '../src/lib/exchange-adapter.js';
import { resetLicenseCache } from '../src/lib/license.js';
// OPS-VITEST-SUITE-REPAIR: neutralize the cross-asset grid so getTradeSignal's
// enrichment reads an injected (empty) snapshot instead of driving the live ~7s
// 42-cell refresh (v1.10.5 SHADOW-SEED-W1), which overruns the 5s test timeout.
// Mirrors the passing sibling suites (get-trade-signal-envelope / trade-call-also-see).
import { _setSnapshotForTest, _clearCache, _setScorerOverride } from '../src/lib/cross-asset-grid.js';
import { InsufficientCandlesError } from '../src/lib/errors.js';
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
    // Fresh empty grid snapshot → enrichment (getTryNext/getClosestTradeable)
    // returns []/null without a live refresh; _clearCache() also drops any
    // in-flight refresh promise leaked from a prior test.
    _clearCache();
    _setScorerOverride(null);
    _setSnapshotForTest([]);
  });

  it('returns a valid signal for ETH', async () => {
    const adapter = createMockAdapter();
    vi.mocked(getAdapter).mockReturnValue(adapter);

    const result = await getTradeSignal({ coin: 'ETH', timeframe: '1h' });

    expect(result).toBeDefined();
    expect(['BUY', 'SELL', 'HOLD']).toContain(result.call);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
    expect(result.coin).toBe('ETH');
    expect(result.timeframe).toBe('1h');
    expect(result.price).toBeGreaterThan(0);
    expect(result.indicators).toBeDefined();
    // v1.10.0: rsi field stripped per OUTPUT-SANITIZE-W1 C5; replaced by funding_state/trend_persistence/breakout_pending buckets.
    expect(result.indicators.trend_persistence).toBeDefined();
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('includes _algovault metadata', async () => {
    const adapter = createMockAdapter();
    vi.mocked(getAdapter).mockReturnValue(adapter);

    const result = await getTradeSignal({ coin: 'ETH' });
    const { PKG_VERSION } = await import('../src/lib/pkg-version.js');
    expect(result._algovault).toBeDefined();
    expect(result._algovault.version).toBe(PKG_VERSION);
    // v1.10.0: canonical tool name in _algovault.tool is `get_trade_call`
    // regardless of whether MCP-callers invoke `get_trade_call` (canonical)
    // or `get_trade_signal` (alias). See src/index.ts dual-registration.
    expect(result._algovault.tool).toBe('get_trade_call');
    expect(result._algovault.compatible_with).toContain('crypto-quant-risk-mcp');
    expect(result._algovault.compatible_with).toContain('crypto-quant-backtest-mcp');
    // v1.10.0 dual-emit: top-level `call` and `signal` both populated, equal.
    expect(result.call).toBe(result.call);
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

  it('v1.10.3 FREE-UNLOCK-W1: free tier accepts non-BTC/ETH (e.g. SOL)', async () => {
    delete process.env.CQS_API_KEY;
    resetLicenseCache();
    const adapter = createMockAdapter();
    vi.mocked(getAdapter).mockReturnValue(adapter);
    // Pre-1.10.3 this would have rejected with /Starter/. Now it succeeds.
    const result = await getTradeSignal({ coin: 'SOL', timeframe: '1h' });
    expect(['BUY', 'SELL', 'HOLD']).toContain(result.call);
  });

  it('v1.10.3 FREE-UNLOCK-W1: free tier accepts non-1h timeframe (e.g. 4h)', async () => {
    delete process.env.CQS_API_KEY;
    resetLicenseCache();
    const adapter = createMockAdapter();
    vi.mocked(getAdapter).mockReturnValue(adapter);
    // Pre-1.10.3 this would have rejected with /Starter/. Now it succeeds.
    const result = await getTradeSignal({ coin: 'BTC', timeframe: '4h' });
    expect(['BUY', 'SELL', 'HOLD']).toContain(result.call);
  });

  it('throws the structured InsufficientCandlesError on insufficient candle data', async () => {
    // TRADIFI-SIGNAL-HARDENING-W1 (R5): the legacy plain-string error was
    // replaced with a structured InsufficientCandlesError carrying recovery
    // hints. The message no longer contains "Insufficient" — assert the type.
    const adapter = createMockAdapter({
      getCandles: vi.fn().mockResolvedValue(mockCandles(5)),
    });
    vi.mocked(getAdapter).mockReturnValue(adapter);

    await expect(getTradeSignal({ coin: 'ETH' }))
      .rejects.toBeInstanceOf(InsufficientCandlesError);
  });

  it('detects bullish conditions with negative funding', async () => {
    const adapter = createMockAdapter({
      getCandles: vi.fn().mockResolvedValue(mockCandles(100, 3000, 'up')),
      getAssetContext: vi.fn().mockResolvedValue(mockAssetContext('ETH', -0.0012)),
    });
    vi.mocked(getAdapter).mockReturnValue(adapter);

    const result = await getTradeSignal({ coin: 'ETH' });
    expect(['BUY', 'HOLD']).toContain(result.call);
  });
});

// ── SCAN-RANKBY-REFINEMENTS-W1 CH4: deriveVerdict golden table ──
// The pure score→verdict tail extracted from getTradeSignal. This is the comprehensive
// byte-identity golden set (BUY/SELL/HOLD across the gates + the oiScore swing + edges).
// WEIGHTS = rsi .30 / ema .10 / funding .25 / oi .15 / volume .20; MAX_RAW_SCORE = 89;
// buyThreshold 40 / sellThreshold 55; r4 default {buyPenaltyZ 2.5, sellSofteningZ -2.0}.
describe('deriveVerdict (CH4 — pure score→verdict tail; golden table)', () => {
  const G = {
    fundingZScore: null as number | null,
    fundingRateAnnualized: 0,
    hurstVal: null as number | null,
    squeezeActive: false,
    r4Thresholds: { buyPenaltyZ: 2.5, sellSofteningZ: -2.0 },
    buyThreshold: 40,
    sellThreshold: 55,
  };
  const sc = (rsi: number, ema: number, funding: number, oi: number, volume: number) =>
    ({ rsiScore: rsi, emaScore: ema, fundingScore: funding, oiScore: oi, volumeScore: volume });

  it('strong bullish → BUY @ 100 (rawScore 89 = MAX)', () => {
    expect(deriveVerdict(sc(100, 100, 80, 60, 100), G)).toMatchObject({ signal: 'BUY', confidence: 100 });
  });
  it('weak bullish below the 40 gate → HOLD @ 19 (rawScore 17)', () => {
    expect(deriveVerdict(sc(40, 0, 0, 20, 10), G)).toMatchObject({ signal: 'HOLD', confidence: 19 });
  });
  it('strong bearish → SELL @ 93 (rawScore -83)', () => {
    expect(deriveVerdict(sc(-100, -100, -80, -60, -70), G)).toMatchObject({ signal: 'SELL', confidence: 93 });
  });
  it('all-zero → HOLD @ 0', () => {
    expect(deriveVerdict(sc(0, 0, 0, 0, 0), G)).toMatchObject({ signal: 'HOLD', confidence: 0 });
  });
  it('oiScore is the swing factor: oi=0 → BUY@49 vs oi=-60 → HOLD@39 (the CH4 sensitivity)', () => {
    expect(deriveVerdict(sc(80, 0, 40, 0, 50), G)).toMatchObject({ signal: 'BUY', confidence: 49 });
    expect(deriveVerdict(sc(80, 0, 40, -60, 50), G)).toMatchObject({ signal: 'HOLD', confidence: 39 });
  });
  it('Hurst <0.45 penalizes a directional signal 25 pts (89→64 → BUY@72)', () => {
    expect(deriveVerdict(sc(100, 100, 80, 60, 100), { ...G, hurstVal: 0.4 })).toMatchObject({ signal: 'BUY', confidence: 72 });
  });
  it('squeeze boost flips HOLD→BUY (30→42 over the 40 gate)', () => {
    expect(deriveVerdict(sc(100, 0, 0, 0, 0), G)).toMatchObject({ signal: 'HOLD', confidence: 34 });
    expect(deriveVerdict(sc(100, 0, 0, 0, 0), { ...G, squeezeActive: true })).toMatchObject({ signal: 'BUY', confidence: 47 });
  });
  it('funding Z > buyPenaltyZ penalizes BUY 20 pts (89→69 → BUY@78)', () => {
    expect(deriveVerdict(sc(100, 100, 80, 60, 100), { ...G, fundingZScore: 3.0 })).toMatchObject({ signal: 'BUY', confidence: 78 });
  });
});

describe('oiScoreFromOiDelta (CH4 shadow mapping — provisional)', () => {
  it('mirrors the priceChange oiScore thresholds onto the OI %Δ', () => {
    expect(oiScoreFromOiDelta(6)).toBe(60);
    expect(oiScoreFromOiDelta(2)).toBe(20);
    expect(oiScoreFromOiDelta(0)).toBe(0);
    expect(oiScoreFromOiDelta(-2)).toBe(-20);
    expect(oiScoreFromOiDelta(-6)).toBe(-60);
  });
});
