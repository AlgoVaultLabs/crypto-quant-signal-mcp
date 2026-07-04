/**
 * Integration test (v1.10.0 C3): exercises the full getTradeSignal() against
 * mocked exchange data and asserts the emitted `reasoning` string passes the
 * forbidden-regex blocklist for representative regime/funding/breakout/persistence
 * combinations.
 *
 * This is the same blocklist that the unit-level sanitized-reasoning.test.ts
 * applies to the prose helpers — repeated here at the integration boundary so
 * any future regression in the call-site composition (e.g. a developer
 * accidentally re-introducing a "RSI at <num>" parts.push call) is caught
 * before deploy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/exchange-adapter.js', () => ({
  getAdapter: vi.fn(),
}));
vi.mock('../../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordFunding: vi.fn(),
  recordHoldCount: vi.fn(),
  getFundingZScore: vi.fn().mockResolvedValue(null),
  getDb: vi.fn(),
  // Complete the partial mock so getVenueStatus (venue-shadow) reads a stubbed
  // dbQuery instead of throwing "No dbExec export" — mirrors the tradfi sibling.
  dbExec: vi.fn(),
  dbQuery: vi.fn().mockResolvedValue([]),
  // OPS-GRID-PROCESS-BOUNDARY-W1: cross-asset-grid imports isShortLivedScript from
  // performance-db (server-only refresh gate); false = server → grid stays active.
  isShortLivedScript: () => false,
}));

import { getTradeSignal } from '../../src/tools/get-trade-call.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { resetLicenseCache } from '../../src/lib/license.js';
import { getFundingZScore } from '../../src/lib/performance-db.js';
// OPS-VITEST-SUITE-REPAIR: neutralize the cross-asset grid so getTradeSignal's
// enrichment reads an injected (empty) snapshot instead of driving the live ~7s
// 42-cell refresh (v1.10.5 SHADOW-SEED-W1), which overruns the 5s test timeout.
import { _setSnapshotForTest, _clearCache, _setScorerOverride } from '../../src/lib/cross-asset-grid.js';
import type { ExchangeAdapter, Candle, AssetContext } from '../../src/types.js';

const FORBIDDEN_REGEX: ReadonlyArray<RegExp> = [
  /\d+\.\d+/,
  /boosted\s+\d+\s+pts?/i,
  /[+\-]\d+\s+pts?/i,
  /RSI\s+at\s+/i,
  /Hurst\s+(exponent\s+)?\d/i,
  /Funding\s+Z[\s\-]Score/i,
  /Confidence:\s+\d/i,
  /Regime:\s+(TRENDING|RANGING|VOLATILE)/i,
];

function mockCandles(count: number, basePrice: number, trend: 'up' | 'down' | 'flat' = 'flat'): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const offset = trend === 'up' ? i * 10 : trend === 'down' ? -i * 10 : Math.sin(i) * 20;
    const close = basePrice + offset;
    return { open: close - 5, high: close + 10, low: close - 10, close, volume: 1000 + Math.random() * 500, time: Date.now() - (count - i) * 3_600_000 };
  });
}

function mockCtx(coin: string, funding: number, oraclePx: number): AssetContext {
  return { coin, funding, openInterest: 5_000_000, prevDayPx: oraclePx * 0.985, volume24h: 125_000_000, oraclePx, markPx: oraclePx + 1 };
}

function makeAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    getName: () => 'MockExchange',
    getCandles: vi.fn().mockResolvedValue(mockCandles(100, 3000, 'flat')),
    getAssetContext: vi.fn().mockResolvedValue(mockCtx('ETH', 0.0001, 3000)),
    getPredictedFundings: vi.fn().mockResolvedValue([]),
    getCurrentPrice: vi.fn().mockResolvedValue(3000),
    ...overrides,
  };
}

describe('getTradeSignal — emitted reasoning is sanitized', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLicenseCache();
    process.env.CQS_API_KEY = 'test-key';
    // Fresh empty grid snapshot → no live 42-cell refresh (see import comment).
    _clearCache();
    _setScorerOverride(null);
    _setSnapshotForTest([]);
  });

  // Sweep representative inputs to exercise the prose-helper composition end-to-end.
  // For each variant we confirm the concrete `reasoning` string emitted by the
  // full tool call (NOT just helper outputs) is forbidden-regex-clean.
  const variants: Array<{ name: string; trend: 'up' | 'down' | 'flat'; funding: number; zScore: number | null }> = [
    { name: 'flat-low-funding-no-zscore',     trend: 'flat', funding: 0.0001,  zScore: null },
    { name: 'up-trend-mild-funding',          trend: 'up',   funding: 0.0002,  zScore: 0.5 },
    { name: 'down-trend-elevated-funding',    trend: 'down', funding: -0.0005, zScore: -1.8 },
    { name: 'flat-extreme-z-score',           trend: 'flat', funding: 0.0008,  zScore: 2.7 },
    { name: 'up-trend-extreme-negative-z',    trend: 'up',   funding: -0.0008, zScore: -2.9 },
    { name: 'down-trend-zero-funding',        trend: 'down', funding: 0,       zScore: 0 },
    { name: 'flat-elevated-positive-z',       trend: 'flat', funding: 0.0003,  zScore: 1.6 },
  ];

  it.each(variants)('variant=$name → reasoning passes forbidden-regex blocklist', async ({ trend, funding, zScore }) => {
    vi.mocked(getFundingZScore).mockResolvedValue(zScore);
    const adapter = makeAdapter({
      getCandles: vi.fn().mockResolvedValue(mockCandles(100, 3000, trend)),
      getAssetContext: vi.fn().mockResolvedValue(mockCtx('BTC', funding, 30000)),
    });
    vi.mocked(getAdapter).mockReturnValue(adapter);

    const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h' });
    expect(result.reasoning).toBeDefined();
    expect(typeof result.reasoning).toBe('string');
    expect(result.reasoning.length).toBeGreaterThanOrEqual(30);
    expect(result.reasoning.length).toBeLessThanOrEqual(500);
    for (const re of FORBIDDEN_REGEX) {
      expect(result.reasoning, `variant=${trend}/${funding}/${zScore}: matched forbidden ${re} in: "${result.reasoning}"`).not.toMatch(re);
    }
  });

  it('indicators key-order: funding_rate, funding_24h_avg, funding_state are adjacent (first three keys)', async () => {
    const adapter = makeAdapter();
    vi.mocked(getAdapter).mockReturnValue(adapter);
    const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h' });
    const keys = Object.keys(result.indicators);
    const idxFundingRate = keys.indexOf('funding_rate');
    const idxFunding24 = keys.indexOf('funding_24h_avg');
    const idxFundingState = keys.indexOf('funding_state');
    expect(idxFundingRate).toBeGreaterThanOrEqual(0);
    expect(idxFunding24).toBe(idxFundingRate + 1);
    expect(idxFundingState).toBe(idxFunding24 + 1);
  });

  it('bucket fields are populated (trend_persistence, funding_state, breakout_pending)', async () => {
    const adapter = makeAdapter();
    vi.mocked(getAdapter).mockReturnValue(adapter);
    const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h' });
    expect(result.indicators.trend_persistence).toMatch(/^(LOW|MEDIUM|HIGH)$/);
    expect(result.indicators.funding_state).toMatch(/^(NORMAL|ELEVATED|EXTREME)$/);
    expect(result.indicators.breakout_pending).toMatch(/^(INACTIVE|IMMINENT)$/);
  });
});
