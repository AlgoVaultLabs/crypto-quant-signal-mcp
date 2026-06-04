/**
 * Integration tests for OPS-TRADFI-XVENUE-FUNDING-W1 through get_market_regime:
 * TradFi 5-venue aggregation, PREMARKET exclusion, crypto path additive
 * funding_by_venue, and the metrics allow-list regression (R3/R4/R7).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/exchange-adapter.js', () => ({ getAdapter: vi.fn() }));
vi.mock('../../src/lib/performance-db.js', () => ({
  getFundingZScore: vi.fn().mockResolvedValue(null),
  recordFunding: vi.fn(),
  getDb: vi.fn(),
  dbExec: vi.fn(),
}));

import { getMarketRegime } from '../../src/tools/get-market-regime.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import {
  _clearUnderlyingTypeCache,
  _setUnderlyingTypeFetcherForTest,
  type UnderlyingTypeEntry,
} from '../../src/lib/underlying-type.js';
import { _clearTradFiFundingCache } from '../../src/lib/tradfi-funding.js';
import type { Candle, AssetContext, ExchangeId } from '../../src/types.js';

const INTERNAL = { tier: 'internal' as const, key: null };

function candles(n: number, base = 100): Candle[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const c = base + Math.sin(i * 0.4) * 4 + i * 0.05;
    return { open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 1000, time: now - (n - i) * 14_400_000 };
  });
}
function ctx(funding: number, px: number): AssetContext {
  return { coin: 'X', funding, fundingAnnualized: funding * 1095, openInterest: 1e6, prevDayPx: px * 0.99, volume24h: 1e6, oraclePx: px, markPx: px };
}

// Single adapter for all venues: sane prices (~px) so the fingerprint passes;
// getPredictedFundings drives the crypto path.
function mockAdapter(funding: number, px: number) {
  return {
    getName: () => 'mock',
    getCandles: vi.fn(async () => candles(40, px)),
    getAssetContext: vi.fn(async () => ctx(funding, px)),
    getPredictedFundings: vi.fn(async () => ([
      { coin: 'BTC', venues: [
        { venue: 'HlPerp', fundingRate: 0.0000033, nextFundingTime: 0 },
        { venue: 'BinPerp', fundingRate: 0.00002, nextFundingTime: 0 },
        { venue: 'BybitPerp', fundingRate: 0.00003, nextFundingTime: 0 },
      ] },
    ])),
    getFundingHistory: vi.fn(async () => []),
    getCurrentPrice: vi.fn(async () => px),
  };
}
function tradfi(u: string): UnderlyingTypeEntry { return { contractType: 'TRADIFI_PERPETUAL', underlyingType: u }; }
const PERP: UnderlyingTypeEntry = { contractType: 'PERPETUAL', underlyingType: null };

describe('get_market_regime — cross-venue TradFi funding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearUnderlyingTypeCache();
    _clearTradFiFundingCache();
    _setUnderlyingTypeFetcherForTest(async () => new Map<string, UnderlyingTypeEntry>([
      ['BTCUSDT', PERP], ['TSLAUSDT', tradfi('EQUITY')], ['ANTHROPICUSDT', tradfi('PREMARKET')],
    ]));
  });
  afterEach(() => { _clearUnderlyingTypeCache(); _clearTradFiFundingCache(); });

  it('TSLA → sentiment in enum (not "Insufficient"), note cites venues, funding_by_venue ≥2 keys', async () => {
    vi.mocked(getAdapter).mockReturnValue(mockAdapter(0, 421.8) as ReturnType<typeof getAdapter>);
    const r = await getMarketRegime({ coin: 'TSLA', exchange: 'BINANCE', timeframe: '4h', license: INTERNAL });
    expect(['BEARISH_BIAS', 'NEUTRAL', 'BULLISH_BIAS']).toContain(r.metrics.cross_venue_funding_sentiment);
    expect(r.metrics.funding_divergence_note).not.toMatch(/Insufficient cross-venue data/);
    expect(r.metrics.funding_divergence_note).toMatch(/8h-funding:/);
    expect(Object.keys(r.metrics.funding_by_venue ?? {}).length).toBeGreaterThanOrEqual(2);
  });

  it('ANTHROPIC (PREMARKET) → pre-IPO exclusion note, NO funding_by_venue', async () => {
    vi.mocked(getAdapter).mockReturnValue(mockAdapter(0.00005, 1790) as ReturnType<typeof getAdapter>);
    const r = await getMarketRegime({ coin: 'ANTHROPIC', exchange: 'BINANCE', timeframe: '1h', license: INTERNAL });
    expect(r.metrics.funding_divergence_note).toBe('Pre-IPO funding is fixed — cross-venue sentiment not applicable.');
    expect('funding_by_venue' in r.metrics).toBe(false);
  });

  it('BTC (crypto) → funding_by_venue present (additive); no forbidden keys; sentiment in enum', async () => {
    vi.mocked(getAdapter).mockReturnValue(mockAdapter(0.00002, 60000) as ReturnType<typeof getAdapter>);
    const r = await getMarketRegime({ coin: 'BTC', exchange: 'BINANCE', timeframe: '4h', license: INTERNAL });
    expect(['BEARISH_BIAS', 'NEUTRAL', 'BULLISH_BIAS']).toContain(r.metrics.cross_venue_funding_sentiment);
    expect(Object.keys(r.metrics.funding_by_venue ?? {}).length).toBeGreaterThanOrEqual(2);
    // Allow-list: no Data-Integrity-forbidden keys leak into metrics.
    for (const forbidden of ['outcome_return_pct', 'outcome_price', 'phase_e_wr', 'pnl']) {
      expect(Object.keys(r.metrics)).not.toContain(forbidden);
    }
  });
});
