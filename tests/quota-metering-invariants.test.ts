/**
 * QUOTA-CONSISTENCY-COUNT-ALL-W1 R2/R2b — cross-tool metering invariants.
 *
 * Locks "every billable tool charges trackCall once per billable result" across
 * crypto + equity + both trade-call tool names + the scanner, so a future
 * refactor can't silently drop metering:
 *   - get_trade_call (+ alias get_trade_signal): 1 on a non-HOLD verdict, 0 on
 *     HOLD (HOLDs are free).
 *   - get_market_regime / scan_funding_arb: exactly 1 per call (no HOLD concept).
 *   - get_equity_call: HOLD-free like get_trade_call (Q2=B behavior change).
 *   - get_equity_regime: 1 per call (no HOLD), like get_market_regime.
 *   - scan_trade_calls: max(1, non-HOLD returned) — 3 -> 3, all-HOLD -> 1.
 *
 * Meter read-back uses a FRESH starter key per assertion (the module-level
 * callTrackers map never bleeds across cases) + the read-only checkQuota seam.
 * Charge-position note: get_market_regime / scan_funding_arb charge at function
 * ENTRY (before any data work), so those assertions are robust to downstream
 * mock gaps; get_trade_call / get_equity_call charge AFTER the verdict.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Crypto tools: mock the exchange adapter + performance-db (no live API / SQLite).
vi.mock('../src/lib/exchange-adapter.js', () => ({ getAdapter: vi.fn() }));
vi.mock('../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordHoldCount: vi.fn(),
  recordFunding: vi.fn(),
  getFundingZScore: vi.fn(async () => null),
  dbExec: vi.fn(),
  dbQuery: vi.fn(async () => ({ rows: [] })),
  dbRun: vi.fn(),
  getDb: vi.fn(),
  isShortLivedScript: () => false,
}));
// Equity tools: mock the store (no live Postgres).
vi.mock('../src/lib/equities/equity-store.js', () => ({
  getEquityPool: vi.fn(() => ({})),
  getUniverseEntry: vi.fn(),
  getLatestVerdict: vi.fn(),
  getAllUniverseSymbols: vi.fn(async () => ['AAPL', 'MSFT', 'SPY']),
}));
// Scanner tool: mock the pure compute engine so we drive eligible_non_hold.
vi.mock('../src/lib/trade-call-scanner.js', () => ({ scanTradeCalls: vi.fn() }));

import { getTradeSignal } from '../src/tools/get-trade-call.js';
import { getMarketRegime } from '../src/tools/get-market-regime.js';
import { scanFundingArb } from '../src/tools/scan-funding-arb.js';
import { getEquityCall, getEquityRegime } from '../src/lib/equities/equity-tool-formatters.js';
import { runScanTradeCall } from '../src/tools/scan-trade-calls.js';
import { getAdapter } from '../src/lib/exchange-adapter.js';
import { getUniverseEntry, getLatestVerdict, type PublicVerdictRow } from '../src/lib/equities/equity-store.js';
import { scanTradeCalls, type ScanTradeCallsResult } from '../src/lib/trade-call-scanner.js';
import { checkQuota, resetLicenseCache } from '../src/lib/license.js';
import { readFileSync } from 'node:fs';
import type { ExchangeAdapter, Candle, AssetContext, LicenseInfo } from '../src/types.js';

// ── fixtures (mirror tests/get-trade-signal.test.ts) ──
const mockCandles = (count: number, basePrice = 3000, trend: 'up' | 'down' | 'flat' = 'flat'): Candle[] =>
  Array.from({ length: count }, (_, i) => {
    const offset = trend === 'up' ? i * 10 : trend === 'down' ? -i * 10 : Math.sin(i) * 20;
    const close = basePrice + offset;
    return { open: close - 5, high: close + 10, low: close - 10, close, volume: 1000 + i, time: Date.now() - (count - i) * 3600000 };
  });

const mockAssetContext = (coin: string, funding = 0.0001): AssetContext => ({
  coin, funding, openInterest: 5_000_000, prevDayPx: 2950, volume24h: 125_000_000, oraclePx: 3000, markPx: 3001,
});

function createMockAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    getName: () => 'MockExchange',
    getCandles: vi.fn().mockResolvedValue(mockCandles(120)),
    getAssetContext: vi.fn().mockResolvedValue(mockAssetContext('ETH')),
    getPredictedFundings: vi.fn().mockResolvedValue([]),
    getCurrentPrice: vi.fn().mockResolvedValue(3000),
    ...overrides,
  } as ExchangeAdapter;
}

let keyN = 0;
const freshStarter = (): LicenseInfo => ({ tier: 'starter', key: `meter-${keyN++}`, customerId: 'cus_test' });
const usedFor = (lic: LicenseInfo): number => checkQuota(lic).used;

const verdict = (call: 'BUY' | 'SELL' | 'HOLD'): PublicVerdictRow => ({
  symbol: 'AAPL', session_date: '2026-06-03', call, confidence: 0.6,
  regime: 'trending_up', factors: ['technical:x'], engine_version: 'equities-v1', pfe_horizon_sessions: 5,
});

const scanResult = (eligible_non_hold: number): ScanTradeCallsResult => ({
  scanned: 100, eligible_non_hold, holds: 100 - eligible_non_hold, errors: 0, partial: false, calls: [],
});

function scanUsed(r: Awaited<ReturnType<typeof runScanTradeCall>>): number {
  if ('error' in r) throw new Error('unexpected quota_exhausted response');
  return r._algovault.quota.used;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLicenseCache();
  process.env.CQS_API_KEY = 'test-key';
});

// ── crypto singles + alias ──
describe('crypto singles — trackCall once per billable result', () => {
  it('get_trade_call: charges 1 on non-HOLD, 0 on HOLD (HOLDs free) — rising tape', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter({ getCandles: vi.fn().mockResolvedValue(mockCandles(120, 3000, 'up')) }));
    const lic = freshStarter();
    const r = await getTradeSignal({ coin: 'ETH', timeframe: '1h', license: lic });
    expect(usedFor(lic)).toBe(r.call === 'HOLD' ? 0 : 1);
  });

  it('get_trade_call: charge==non-HOLD invariant holds on a flat tape', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter({ getCandles: vi.fn().mockResolvedValue(mockCandles(120, 3000, 'flat')) }));
    const lic = freshStarter();
    const r = await getTradeSignal({ coin: 'ETH', timeframe: '1h', license: lic });
    expect(usedFor(lic)).toBe(r.call === 'HOLD' ? 0 : 1);
  });

  it('get_market_regime: charges exactly 1 per call (no HOLD concept)', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());
    const lic = freshStarter();
    // Charge is booked at function entry, before any data work.
    try { await getMarketRegime({ coin: 'BTC', timeframe: '4h', license: lic }); } catch { /* entry-charge already booked */ }
    expect(usedFor(lic)).toBe(1);
  });

  it('scan_funding_arb: charges exactly 1 per call', async () => {
    vi.mocked(getAdapter).mockReturnValue(createMockAdapter());
    const lic = freshStarter();
    try { await scanFundingArb({ minSpreadBps: 5, limit: 10, license: lic }); } catch { /* entry-charge already booked */ }
    expect(usedFor(lic)).toBe(1);
  });

  it('get_trade_signal alias routes through the SAME makeTradeCallHandler as get_trade_call', () => {
    const src = readFileSync('src/index.ts', 'utf8');
    expect(src).toMatch(/makeTradeCallHandler\('get_trade_call'\)/);
    expect(src).toMatch(/makeTradeCallHandler\('get_trade_signal'\)/);
  });
});

// ── equity tools — get_equity_call HOLD-free (Q2=B); get_equity_regime per-call ──
describe('equity tools — HOLD-free call, per-call regime', () => {
  beforeEach(() => {
    vi.mocked(getUniverseEntry).mockResolvedValue({ symbol: 'AAPL', rank_adv: 12, is_etf: false });
  });

  it.each(['BUY', 'SELL'] as const)('get_equity_call charges 1 for a %s verdict', async (call) => {
    vi.mocked(getLatestVerdict).mockResolvedValue(verdict(call));
    const lic = freshStarter();
    await getEquityCall({ symbol: 'AAPL', license: lic });
    expect(usedFor(lic)).toBe(1);
  });

  it('get_equity_call does NOT charge a HOLD verdict (parity with get_trade_call)', async () => {
    vi.mocked(getLatestVerdict).mockResolvedValue(verdict('HOLD'));
    const lic = freshStarter();
    await getEquityCall({ symbol: 'AAPL', license: lic });
    expect(usedFor(lic)).toBe(0);
  });

  it('get_equity_call does NOT charge an error path (no verdict for session)', async () => {
    vi.mocked(getLatestVerdict).mockResolvedValue(null);
    const lic = freshStarter();
    await getEquityCall({ symbol: 'AAPL', license: lic });
    expect(usedFor(lic)).toBe(0);
  });

  it('get_equity_regime charges 1 per call (no HOLD concept, like get_market_regime)', async () => {
    vi.mocked(getLatestVerdict).mockResolvedValue(verdict('HOLD')); // call ignored; regime charges at entry
    const lic = freshStarter();
    await getEquityRegime({ symbol: 'SPY', license: lic });
    expect(usedFor(lic)).toBe(1);
  });
});

// ── scanner — max(1, non-HOLD returned) ──
describe('scan_trade_calls — 1 per non-HOLD returned, floor 1', () => {
  it('3 non-HOLD returned → charges 3', async () => {
    vi.mocked(scanTradeCalls).mockResolvedValue(scanResult(3));
    const r = await runScanTradeCall({ topN: 100, timeframe: '15m', exchange: 'BINANCE', limit: 10 }, freshStarter());
    expect(scanUsed(r)).toBe(3);
  });

  it('5 non-HOLD returned → charges 5', async () => {
    vi.mocked(scanTradeCalls).mockResolvedValue(scanResult(5));
    const r = await runScanTradeCall({ topN: 100, timeframe: '15m', exchange: 'BINANCE', limit: 10 }, freshStarter());
    expect(scanUsed(r)).toBe(5);
  });

  it('all-HOLD scan → charges the 1-unit floor (HOLDs free, scan itself costs 1)', async () => {
    vi.mocked(scanTradeCalls).mockResolvedValue(scanResult(0));
    const r = await runScanTradeCall({ topN: 100, timeframe: '15m', exchange: 'BINANCE', limit: 10 }, freshStarter());
    expect(scanUsed(r)).toBe(1);
  });
});
