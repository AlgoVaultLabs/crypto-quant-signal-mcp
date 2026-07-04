/**
 * Integration tests for TRADIFI-SIGNAL-HARDENING-W1 wiring through the full
 * getTradeSignal() path (R3/R4/R5/R7):
 *   - funding precision passthrough (0.00005 is NOT rounded to 0)
 *   - additive allow-list regression (BTC indicator keys: existing + the new
 *     underlying_session; no forbidden keys; key order preserved)
 *   - structured INSUFFICIENT_CANDLES error on a too-new listing
 *   - PREMARKET → FIXED_PREIPO funding_state + funding_note (resolver injected)
 *   - EQUITY weekend → CLOSED_WEEKEND + reasoning caveat (clock pinned to a Sat)
 *
 * Exchange data + the performance DB are mocked (as in the sibling reasoning
 * test); the underlying-type resolver is driven via its injectable fetcher so
 * the asset-class is deterministic and offline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/exchange-adapter.js', () => ({ getAdapter: vi.fn() }));
vi.mock('../../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordFunding: vi.fn(),
  recordHoldCount: vi.fn(),
  getFundingZScore: vi.fn().mockResolvedValue(null),
  getDb: vi.fn(),
  dbExec: vi.fn(),
  // SCAN-RANKBY-W3: computeOiDelta reads dbQuery; default [] → oi_snapshots warming → factor omitted.
  dbQuery: vi.fn().mockResolvedValue([]),
  // OPS-GRID-PROCESS-BOUNDARY-W1: cross-asset-grid imports isShortLivedScript from
  // performance-db (server-only refresh gate); false = server → grid stays active.
  isShortLivedScript: () => false,
}));

import { getTradeSignal } from '../../src/tools/get-trade-call.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { dbQuery } from '../../src/lib/performance-db.js';
import { resetLicenseCache } from '../../src/lib/license.js';
import { InsufficientCandlesError } from '../../src/lib/errors.js';
// OPS-VITEST-SUITE-REPAIR: neutralize the cross-asset grid so getTradeSignal's
// enrichment reads an injected (empty) snapshot instead of driving the live ~7s
// 42-cell refresh (v1.10.5 SHADOW-SEED-W1), which overruns the 5s test timeout.
import { _setSnapshotForTest, _clearCache, _setScorerOverride } from '../../src/lib/cross-asset-grid.js';
import {
  _clearUnderlyingTypeCache,
  _setUnderlyingTypeFetcherForTest,
  type UnderlyingTypeEntry,
} from '../../src/lib/underlying-type.js';
import { FUNDING_NOTE_PREIPO, FUNDING_NOTE_TRADFI } from '../../src/lib/market-sessions-constants.js';
import type { ExchangeAdapter, Candle, AssetContext } from '../../src/types.js';

function tradfi(underlyingType: string): UnderlyingTypeEntry {
  return { contractType: 'TRADIFI_PERPETUAL', underlyingType };
}
const PERP: UnderlyingTypeEntry = { contractType: 'PERPETUAL', underlyingType: null };

/** Candles spaced by `intervalMs`, ending at "now". */
function mockCandles(count: number, basePrice: number, intervalMs = 3_600_000): Candle[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const close = basePrice + Math.sin(i) * 20;
    return {
      open: close - 5, high: close + 10, low: close - 10, close,
      volume: 1000 + (i % 7) * 50,
      time: now - (count - i) * intervalMs,
    };
  });
}

function mockCtx(coin: string, funding: number, px: number): AssetContext {
  return { coin, funding, openInterest: 5_000_000, prevDayPx: px * 0.99, volume24h: 125_000_000, oraclePx: px, markPx: px + 1 };
}

function makeAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
  return {
    getName: () => 'MockExchange',
    getCandles: vi.fn().mockResolvedValue(mockCandles(100, 3000)),
    getAssetContext: vi.fn().mockResolvedValue(mockCtx('BTC', 0.0001, 30000)),
    getPredictedFundings: vi.fn().mockResolvedValue([]),
    getCurrentPrice: vi.fn().mockResolvedValue(30000),
    ...overrides,
  };
}

const CRYPTO_MAP = () => new Map<string, UnderlyingTypeEntry>([['BTCUSDT', PERP]]);

describe('get_trade_call — TradFi hardening wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLicenseCache();
    process.env.CQS_API_KEY = 'test-key';
    // Fresh empty grid snapshot → no live 42-cell refresh (see import comment).
    _clearCache();
    _setScorerOverride(null);
    _setSnapshotForTest([]);
    _clearUnderlyingTypeCache();
    _setUnderlyingTypeFetcherForTest(async () => CRYPTO_MAP());
  });

  afterEach(() => {
    _clearUnderlyingTypeCache();
    vi.useRealTimers();
  });

  it('funding precision: a small rate (0.00005) passes through un-rounded', async () => {
    const adapter = makeAdapter({ getAssetContext: vi.fn().mockResolvedValue(mockCtx('BTC', 0.00005, 30000)) });
    vi.mocked(getAdapter).mockReturnValue(adapter);

    const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h' });
    expect(result.indicators.funding_rate).toBe(0.00005);
    expect(result.indicators.funding_24h_avg).toBe(0.00005);
  });

  it('additive allow-list: BTC indicators add only underlying_session; no forbidden keys', async () => {
    vi.mocked(getAdapter).mockReturnValue(makeAdapter());

    const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h' });
    const keys = Object.keys(result.indicators);

    // Always-present allow-listed keys. SCAN-RANKBY-W3: oi_change_pct (+ oi_change_window)
    // is now CONDITIONAL — present only when the oi_snapshots store has ≥2 snapshots spanning
    // the window; here (no store in the test env) it's omitted (warming), never the old proxy.
    const required = [
      'funding_rate', 'funding_24h_avg', 'funding_state',
      'volume_24h', 'trend_persistence', 'breakout_pending', 'underlying_session',
    ];
    for (const k of required) expect(keys).toContain(k);
    // Only allow-listed keys may appear (no surprise/forbidden additions).
    const allowed = new Set([...required, 'oi_change_pct', 'oi_change_window', 'funding_note']);
    for (const k of keys) expect(allowed.has(k)).toBe(true);
    // oi_change_pct and its window are a pair (both present, or both absent).
    expect('oi_change_window' in result.indicators).toBe('oi_change_pct' in result.indicators);
    expect(result.indicators.underlying_session).toBe('ALWAYS_OPEN'); // BTC = CRYPTO
    expect('funding_note' in result.indicators).toBe(false); // omitted for crypto

    // Data-Integrity forbidden + legacy-stripped keys must NOT reappear.
    for (const forbidden of ['outcome_return_pct', 'outcome_price', 'signal', 'rsi', 'ema_9', 'funding_z_score', 'squeeze_active', 'try_next']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('SCAN-RANKBY-W3: oi_change_pct renders the REAL OI delta (computeOiDelta) when the store is warm', async () => {
    vi.mocked(getAdapter).mockReturnValue(makeAdapter());
    const now = Date.now();
    // Route ONLY the oi_snapshots SELECT (getVenueStatus etc. also use dbQuery) to 2 snapshots
    // spanning 24h: OI 100 → 120 = +20% (real OI, NOT the old priceChange×100 proxy).
    const q = vi.mocked(dbQuery);
    q.mockImplementation(async (sql: unknown) =>
      (typeof sql === 'string' && sql.includes('oi_snapshots')
        ? [{ ts: now - 24 * 60 * 60 * 1000, oi: 100 }, { ts: now, oi: 120 }]
        : []) as never,
    );
    try {
      const result = await getTradeSignal({ coin: 'BTC', timeframe: '1h' });
      expect(result.indicators.oi_change_pct).toBe(20);
      expect(result.indicators.oi_change_window).toBe('24h');
      expect(result.indicators).not.toHaveProperty('outcome_return_pct'); // never leak internals
    } finally {
      q.mockReset();
      q.mockResolvedValue([] as never); // restore the default (warming) for later tests
    }
  });

  it('structured INSUFFICIENT_CANDLES: a too-new listing throws with recovery hints', async () => {
    // 12 candles spaced 4h → 48h listing age → finer timeframes 1h/30m/15m qualify.
    const adapter = makeAdapter({ getCandles: vi.fn().mockResolvedValue(mockCandles(12, 3000, 14_400_000)) });
    vi.mocked(getAdapter).mockReturnValue(adapter);

    await expect(getTradeSignal({ coin: 'BTC', timeframe: '4h' })).rejects.toBeInstanceOf(InsufficientCandlesError);

    try {
      await getTradeSignal({ coin: 'BTC', timeframe: '4h' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientCandlesError);
      const err = e as InsufficientCandlesError;
      expect(err.candlesAvailable).toBe(12);
      expect(err.candlesRequired).toBe(30);
      expect(err.timeframe).toBe('4h');
      expect(err.suggestedTimeframes).toEqual(['1h', '30m', '15m']);
      expect(err.suggestedAction).toBe('Retry with timeframe=1h');
    }
  });

  it('PREMARKET: funding_state → FIXED_PREIPO + pre-IPO funding_note + PREIPO_INTERNAL session', async () => {
    // Inject the resolver to classify TSLAUSDT as PREMARKET (synthetic, to exercise
    // the FIXED_PREIPO branch end-to-end and time-independently).
    _setUnderlyingTypeFetcherForTest(async () => new Map([['TSLAUSDT', tradfi('PREMARKET')]]));
    vi.mocked(getAdapter).mockReturnValue(makeAdapter({ getAssetContext: vi.fn().mockResolvedValue(mockCtx('TSLA', 0.00005, 420)) }));

    const result = await getTradeSignal({ coin: 'TSLA', exchange: 'BINANCE', timeframe: '1h' });
    expect(result.indicators.underlying_session).toBe('PREIPO_INTERNAL');
    expect(result.indicators.funding_state).toBe('FIXED_PREIPO');
    expect(result.indicators.funding_note).toBe(FUNDING_NOTE_PREIPO);
    expect(result.indicators.funding_rate).toBe(0.00005); // precision preserved alongside the override
  });

  it('EQUITY weekend: CLOSED_WEEKEND + TradFi funding_note + provisional caveat in reasoning', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-06T12:00:00Z')); // Saturday
    _setUnderlyingTypeFetcherForTest(async () => new Map([['TSLAUSDT', tradfi('EQUITY')]]));
    vi.mocked(getAdapter).mockReturnValue(makeAdapter({ getAssetContext: vi.fn().mockResolvedValue(mockCtx('TSLA', 0.00002, 420)) }));

    const result = await getTradeSignal({ coin: 'TSLA', exchange: 'BINANCE', timeframe: '1h' });
    expect(result.indicators.underlying_session).toBe('CLOSED_WEEKEND');
    expect(result.indicators.funding_note).toBe(FUNDING_NOTE_TRADFI);
    expect(result.indicators.funding_state).not.toBe('FIXED_PREIPO'); // equity keeps z-bucket
    expect(result.reasoning).toMatch(/Underlying market closed/);
  });
});
