/**
 * Bybit adapter — implements ExchangeAdapter for Bybit USDT Linear Perpetuals.
 * Base URL: https://api.bybit.com
 * All requests are public GET, no auth needed.
 * Rate limit: 50 req/sec.
 */
import type {
  ExchangeAdapter,
  Candle,
  AssetContext,
  FundingData,
  DexType,
} from '../../types.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS } from './_upstream-fetch.js';
import { makeServedIntervalMs } from '../served-interval.js';

const BASE_URL = 'https://api.bybit.com';
const MAX_RETRIES = 1;

// AlgoVault-canonical → Bybit-native base symbol for TradFi assets where Bybit's
// listing uses a different ticker (e.g. GOLD trades as XAUUSDT on Bybit, not GOLDUSDT).
// Derived from live Bybit instruments-info probe (TRADFI-SYMBOL-ALIAS-W1, 2026-05-15).
// Symmetric reverse-map applied in fromBybitSymbol.
const TRADFI_ALIASES: Record<string, string> = {
  GOLD: 'XAU',
  SILVER: 'XAG',
};

export function toBybitSymbol(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return mapped + 'USDT';
}

export function fromBybitSymbol(symbol: string): string {
  const base = symbol.replace(/USDT$/, '');
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native === base) return canon;
  }
  return base;
}

// Map our intervals to Bybit kline intervals
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15',
  '30m': '30', '1h': '60', '2h': '120', '4h': '240',
  '8h': '480', '12h': '720', '1d': 'D',
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms Bybit fetches for `tf` (bare number = minutes, D = 1d; native). */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP);

// ── Bybit response wrapper ──

interface BybitResponse<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

// ── Bybit response types ──

interface BybitTicker {
  symbol: string;
  lastPrice: string;
  markPrice: string;
  fundingRate: string;
  nextFundingTime: string;
  volume24h: string;
  turnover24h: string;
  prevPrice24h: string;
}

interface BybitOpenInterestEntry {
  openInterest: string;
  timestamp: string;
}

interface BybitFundingHistoryEntry {
  symbol: string;
  fundingRate: string;
  fundingRateTimestamp: string;
}

async function bybitGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build + retCode envelope check unchanged;
  // fetch/retry/ban via upstreamFetch — incl. Bybit's public-IP **403 "access too
  // frequent"** ban (banStatuses [403,418,429]), previously a generic retried Error.
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  const body = await upstreamFetch<BybitResponse<T>>({ ...VENUE_FETCH_CONFIGS.BYBIT, transientRetries: retries }, { url: url.toString() });
  if (body.retCode !== 0) {
    throw new Error(`Bybit API error ${body.retCode}: ${body.retMsg}`);
  }
  return body.result;
}

export class BybitAdapter implements ExchangeAdapter {
  getName(): string {
    return 'Bybit';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = toBybitSymbol(coin);
    const bybitInterval = INTERVAL_MAP[interval] || '60';

    const data = await bybitGet<{ list: string[][] }>('/v5/market/kline', {
      category: 'linear',
      symbol,
      interval: bybitInterval,
      start: startTime,
      limit: 200,
    });

    // CRITICAL: Bybit returns candles in DESCENDING order (newest first). Reverse.
    const reversed = (data.list || []).slice().reverse();

    return reversed.map(c => ({
      time: parseInt(c[0]),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const symbol = toBybitSymbol(coin);

    // Parallel fetch: ticker (single symbol) + open interest
    const [tickerData, oiData] = await Promise.all([
      bybitGet<{ list: BybitTicker[] }>('/v5/market/tickers', {
        category: 'linear',
        symbol,
      }),
      bybitGet<{ list: BybitOpenInterestEntry[] }>('/v5/market/open-interest', {
        category: 'linear',
        symbol,
        intervalTime: '5min',
        limit: 1,
      }),
    ]);

    const ticker = tickerData.list?.[0];
    // OPS-MCP-DEFENSE-IN-DEPTH-W1 R3 — row-identity assert (List-endpoint
    // single-entity-read rule; Bitget precedent bitget.ts:166): a symbol-filtered
    // list can silently ignore its filter and return a wrong-but-plausible [0] row.
    if (!ticker || ticker.symbol !== symbol) {
      throw new Error(`BYBIT_TICKER_SYMBOL_MISMATCH: requested ${symbol}, got ${ticker?.symbol ?? 'none'} from /v5/market/tickers`);
    }
    const oi = oiData.list[0];

    // R2: Bybit funding is per-8h period → annualized = raw × 1095 (8h periods/year)
    const fundingRaw = parseFloat(ticker.fundingRate || '0');
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: parseFloat(oi.openInterest || '0'),
      prevDayPx: parseFloat(ticker.prevPrice24h || '0'),
      volume24h: parseFloat(ticker.turnover24h || '0'),
      oraclePx: parseFloat(ticker.markPrice || '0'),
      markPx: parseFloat(ticker.markPrice || '0'),
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // Fetch all linear tickers
    const data = await bybitGet<{ list: BybitTicker[] }>('/v5/market/tickers', {
      category: 'linear',
    });

    return (data.list || [])
      .filter(entry => entry.symbol.endsWith('USDT'))
      .map(entry => ({
        coin: fromBybitSymbol(entry.symbol),
        venues: [{
          venue: 'BybitPerp',
          fundingRate: parseFloat(entry.fundingRate || '0'),
          nextFundingTime: parseInt(entry.nextFundingTime || '0'),
        }],
      }));
  }

  async getFundingHistory(coin: string, startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const symbol = toBybitSymbol(coin);
      const data = await bybitGet<{ list: BybitFundingHistoryEntry[] }>('/v5/market/funding/history', {
        category: 'linear',
        symbol,
        startTime,
        limit: 200,
      });

      return (data.list || []).map(r => ({
        time: parseInt(r.fundingRateTimestamp),
        fundingRate: parseFloat(r.fundingRate),
      }));
    } catch {
      return [];
    }
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const symbol = toBybitSymbol(coin);
      const data = await bybitGet<{ list: BybitTicker[] }>('/v5/market/tickers', {
        category: 'linear',
        symbol,
      });
      const ticker = data.list?.[0];
      // OPS-MCP-DEFENSE-IN-DEPTH-W1 R3 — same row-identity assert; the throw is
      // caught below → null (fail-soft preserved, wrong-symbol price can't leak).
      if (!ticker || ticker.symbol !== symbol) {
        throw new Error(`BYBIT_TICKER_SYMBOL_MISMATCH: requested ${symbol}, got ${ticker?.symbol ?? 'none'} from /v5/market/tickers`);
      }
      return parseFloat(ticker.markPrice);
    } catch {
      return null;
    }
  }
}
