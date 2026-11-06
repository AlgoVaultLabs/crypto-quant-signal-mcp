/**
 * A healthy, offline pre_trade_check world (DECISION-CALL-V2-W5 fixtures): BTC on four venues, quoted
 * 99,990 / 100,010, funding 1 bp per 8 h, a RANGING regime, public tier tables except Binance's. The same
 * world `tests/unit/pre-trade-check-log.test.ts` builds inline; the call-ledger suites share it from here.
 */
import type { ExchangeAsset } from '../../src/lib/exchange-universe.js';
import type { RegimeSnapshotRow, ServableGeneration } from '../../src/lib/regime-snapshots.js';
import type { VenueFundingRow } from '../../src/lib/venue-market-state.js';
import type { PreTradeCheckDeps } from '../../src/tools/pre-trade-check.js';

export const WORLD_H = 3_600_000;
export const WORLD_VENUES = ['BINANCE', 'BYBIT', 'OKX', 'BITGET'] as const;
const VENUE_STRING: Record<string, string> = { BINANCE: 'BinPerp', BYBIT: 'BybitPerp', OKX: 'OKXPerp', BITGET: 'BitgetPerp' };

/** The world's deps at `now` (epoch ms). */
export function preTradeWorld(now: number): PreTradeCheckDeps {
  const H = WORLD_H;
  return {
    now: () => now,
    retiredVenues: async () => new Set(),
    venueUniverse: async () => ({ rows: [{ coin: 'BTC', notionalOI_usd: 5e8, volume24h_usd: 1e10, bidPx: 99_990, askPx: 100_010 } as ExchangeAsset], failed: false }),
    fundingSnapshot: async () => ({
      byCoin: new Map([['BTC', WORLD_VENUES.map((v) => ({ venue: VENUE_STRING[v], fundingRate: 0.0001, nextFundingTime: now + 4 * H, intervalHours: 8 }) as VenueFundingRow)]]),
      failedVenues: new Set(),
    }),
    sampledRegimeVenues: async () => [...WORLD_VENUES],
    latestServableGeneration: async (venue, tf) => ({ exchange: venue, timeframe: tf, bar_close_ms: now - H, disposition: 'COMPLETE', universe_n: 1, written_n: 1, too_new_n: 0, window_stale_n: 0, coverage: 1, tick_at: now - H, finished_at: now - H }) as ServableGeneration,
    readGenerationRow: async (venue, tf, bar, coin) => ({ exchange: venue, timeframe: tf, bar_close_ms: bar, coin, regime: 'RANGING', confidence: 50, volatility_ratio: 0.01 }) as RegimeSnapshotRow,
    resolveAssetClass: async () => 'CRYPTO' as never,
    venueStatus: async () => 'promoted',
    marginTierAt: async (venue) => (venue === 'BINANCE' ? { rate: null, basis: 'tier_table_requires_key' } : { rate: 0.004, basis: 'public_tier_table' }),
    ruleProfile: async () => null,
  };
}
