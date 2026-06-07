/**
 * Aster adapter — implements ExchangeAdapter for Aster DEX USDT-M perpetuals.
 *
 * Aster (`fapi.asterdex.com`) is a BNB-Chain-based perp DEX whose REST API is
 * a near-verbatim Binance Futures API clone (same paths, same response shapes,
 * same query-param conventions). 410 listed perps as of PILOT-ADAPTERS-W1
 * Plan-Mode probe (2026-05-16). Status: shadow.
 *
 * Differences from Binance adapter pattern:
 *   - No `SYMBOL_OVERRIDES` (Aster does not use the 1000-prefix meme-coin
 *     convention — base assets are listed at their native ticker).
 *   - No `TRADFI_ALIASES` (Aster does not list TradFi instruments — stocks,
 *     commodities, indices are HL-only / not on Aster's perp catalog).
 *   - Rate-limit headers not surfaced; conservative single-retry pattern.
 *
 * Base URL: https://fapi.asterdex.com
 * Auth: public REST, no auth needed.
 */
import type {
  ExchangeAdapter,
  Candle,
  AssetContext,
  FundingData,
  DexType,
} from '../../types.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS, safeUpstreamNum } from './_upstream-fetch.js';

const BASE_URL = 'https://fapi.asterdex.com';
const MAX_RETRIES = 1;

// Map AlgoVault intervals to Aster kline intervals (Binance-compatible)
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m',
  '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h',
  '8h': '8h', '12h': '12h', '1d': '1d',
};

export function toAsterSymbol(coin: string): string {
  return coin + 'USDT';
}

export function fromAsterSymbol(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

async function asterGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build unchanged; fetch/retry/ban via upstreamFetch.
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>({ ...VENUE_FETCH_CONFIGS.ASTER, transientRetries: retries }, { url: url.toString() });
}

// ── Response types (mirror Binance shapes verbatim) ──

interface AsterPremiumIndex {
  symbol: string;
  markPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

interface AsterOpenInterest {
  openInterest: string;
}

interface AsterTicker24hr {
  symbol: string;
  volume: string;
  quoteVolume: string;
  lastPrice: string;
  prevClosePrice: string;
}

export class AsterAdapter implements ExchangeAdapter {
  getName(): string {
    return 'Aster';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = toAsterSymbol(coin);
    const asterInterval = INTERVAL_MAP[interval] || '1h';

    const raw = await asterGet<(string | number)[][]>('/fapi/v1/klines', {
      symbol,
      interval: asterInterval,
      startTime,
      limit: 200,
    });

    // SV-04: default-deny — drop any candle with a non-finite OHLCV field
    // rather than emit a NaN/wrong-but-finite price into the signal engine.
    return raw.flatMap(c => {
      const open = safeUpstreamNum(c[1]);
      const high = safeUpstreamNum(c[2]);
      const low = safeUpstreamNum(c[3]);
      const close = safeUpstreamNum(c[4]);
      const volume = safeUpstreamNum(c[5]);
      if (open === null || high === null || low === null || close === null || volume === null) return [];
      return [{ open, high, low, close, volume, time: c[0] as number }];
    });
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const symbol = toAsterSymbol(coin);

    const [premiumIndex, oi, ticker] = await Promise.all([
      asterGet<AsterPremiumIndex>('/fapi/v1/premiumIndex', { symbol }),
      asterGet<AsterOpenInterest>('/fapi/v1/openInterest', { symbol }),
      asterGet<AsterTicker24hr>('/fapi/v1/ticker/24hr', { symbol }),
    ]);

    // Aster funding is per-8h period (Binance-compatible); annualize × 1095.
    // SV-04: default-deny — invalid markPrice throws (3-tier fallback fires);
    // non-price fields fall back to a safe neutral 0 (never propagate garbage).
    const fundingRaw = safeUpstreamNum(premiumIndex.lastFundingRate) ?? 0;
    const markPx = safeUpstreamNum(premiumIndex.markPrice);
    if (markPx === null) throw new Error('Aster getAssetContext: invalid markPrice');
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: safeUpstreamNum(oi.openInterest) ?? 0,
      prevDayPx: safeUpstreamNum(ticker.prevClosePrice) ?? 0,
      volume24h: safeUpstreamNum(ticker.quoteVolume) ?? 0,
      oraclePx: markPx,
      markPx,
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    const raw = await asterGet<AsterPremiumIndex[]>('/fapi/v1/premiumIndex');
    return raw
      .filter(entry => entry.symbol.endsWith('USDT'))
      .map(entry => ({
        coin: fromAsterSymbol(entry.symbol),
        venues: [{
          venue: 'AsterPerp',
          fundingRate: safeUpstreamNum(entry.lastFundingRate) ?? 0,
          nextFundingTime: entry.nextFundingTime || 0,
        }],
      }));
  }

  async getFundingHistory(coin: string, startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const symbol = toAsterSymbol(coin);
      const raw = await asterGet<Array<{ fundingTime: number; fundingRate: string }>>('/fapi/v1/fundingRate', {
        symbol,
        startTime,
        limit: 1000,
      });
      return (raw || [])
        .map(r => ({ time: r.fundingTime, fundingRate: safeUpstreamNum(r.fundingRate) }))
        .filter((r): r is { time: number; fundingRate: number } => r.fundingRate !== null);
    } catch {
      return [];
    }
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const symbol = toAsterSymbol(coin);
      const data = await asterGet<AsterPremiumIndex>('/fapi/v1/premiumIndex', { symbol });
      return safeUpstreamNum(data.markPrice);
    } catch {
      return null;
    }
  }
}
