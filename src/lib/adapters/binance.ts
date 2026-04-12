/**
 * Binance adapter — implements ExchangeAdapter for Binance USDT-M Futures.
 * Base URL: https://fapi.binance.com
 * All requests are public GET, no auth needed.
 * Rate limit: 2,400 req/min per IP.
 */
import type {
  ExchangeAdapter,
  Candle,
  AssetContext,
  FundingData,
  DexType,
} from '../../types.js';

const BASE_URL = 'https://fapi.binance.com';
const TIMEOUT_MS = 3000;
const MAX_RETRIES = 1;

// Map our intervals to Binance kline intervals
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m',
  '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h',
  '8h': '8h', '12h': '12h', '1d': '1d',
};

// Some Binance symbols use 1000-prefix for low-price coins
const SYMBOL_OVERRIDES: Record<string, string> = {
  'PEPE': '1000PEPE',
  'SHIB': '1000SHIB',
  'FLOKI': '1000FLOKI',
  'BONK': '1000BONK',
  'LUNC': '1000LUNC',
  'XEC': '1000XEC',
  'SATS': '1000SATS',
  'RATS': '1000RATS',
  'CAT': '1000CAT',
  'CHEEMS': '1000CHEEMS',
  'WHINE': '1000WHINE',
  'APU': '1000APU',
  'X': '1000X',
  'MOGCOIN': '1000MOGCOIN',
};

function toBinanceSymbol(coin: string): string {
  const mapped = SYMBOL_OVERRIDES[coin] || coin;
  return mapped + 'USDT';
}

// Reverse map: Binance symbol back to our coin name
function fromBinanceSymbol(symbol: string): string {
  const base = symbol.replace(/USDT$/, '');
  for (const [ourCoin, binName] of Object.entries(SYMBOL_OVERRIDES)) {
    if (binName === base) return ourCoin;
  }
  return base;
}

async function binGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const url = new URL(path, BASE_URL);
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          url.searchParams.set(k, String(v));
        }
      }
      const res = await fetch(url.toString(), {
        signal: controller.signal,
      });
      clearTimeout(timer);

      // Monitor rate limit usage
      const usedWeight = res.headers.get('X-MBX-USED-WEIGHT-1m');
      if (usedWeight && parseInt(usedWeight) > 1800) {
        console.warn(`[Binance] Rate limit warning: ${usedWeight}/2400 weight used`);
      }

      // Handle rate limiting
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 1000;
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw new Error('Binance API rate limited (429)');
      }

      if (!res.ok) {
        throw new Error(`Binance API ${res.status}: ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('Binance API: max retries exceeded');
}

// ── Response types from Binance ──

interface BinancePremiumIndex {
  symbol: string;
  markPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

interface BinanceOpenInterest {
  openInterest: string;
}

interface BinanceTicker24hr {
  symbol: string;
  volume: string;
  quoteVolume: string;
  lastPrice: string;
  prevClosePrice: string;
}

export class BinanceAdapter implements ExchangeAdapter {
  getName(): string {
    return 'Binance';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = toBinanceSymbol(coin);
    const binanceInterval = INTERVAL_MAP[interval] || '1h';

    // Use regular klines for real trading volume
    const raw = await binGet<(string | number)[][]>('/fapi/v1/klines', {
      symbol,
      interval: binanceInterval,
      startTime,
      limit: 200,
    });

    return raw.map(c => ({
      open: parseFloat(String(c[1])),
      high: parseFloat(String(c[2])),
      low: parseFloat(String(c[3])),
      close: parseFloat(String(c[4])),
      volume: parseFloat(String(c[5])),
      time: c[0] as number,
    }));
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const symbol = toBinanceSymbol(coin);

    // Parallel fetch: premiumIndex + openInterest + 24hr ticker
    const [premiumIndex, oi, ticker] = await Promise.all([
      binGet<BinancePremiumIndex>('/fapi/v1/premiumIndex', { symbol }),
      binGet<BinanceOpenInterest>('/fapi/v1/openInterest', { symbol }),
      binGet<BinanceTicker24hr>('/fapi/v1/ticker/24hr', { symbol }),
    ]);

    return {
      coin,
      funding: parseFloat(premiumIndex.lastFundingRate || '0'),
      openInterest: parseFloat(oi.openInterest || '0'),
      prevDayPx: parseFloat(ticker.prevClosePrice || '0'),
      volume24h: parseFloat(ticker.quoteVolume || '0'),
      oraclePx: parseFloat(premiumIndex.markPrice || '0'),
      markPx: parseFloat(premiumIndex.markPrice || '0'),
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // Fetch all premium indices (weight: 10)
    const raw = await binGet<BinancePremiumIndex[]>('/fapi/v1/premiumIndex');

    return raw
      .filter(entry => entry.symbol.endsWith('USDT'))
      .map(entry => ({
        coin: fromBinanceSymbol(entry.symbol),
        venues: [{
          venue: 'BinPerp',
          fundingRate: parseFloat(entry.lastFundingRate || '0'),
          nextFundingTime: entry.nextFundingTime || 0,
        }],
      }));
  }

  /**
   * Fetch historical Binance funding rates.
   * Endpoint: /fapi/v1/fundingRate (max 1000 records)
   */
  async getFundingHistory(coin: string, startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const symbol = toBinanceSymbol(coin);
      const raw = await binGet<Array<{ fundingTime: number; fundingRate: string }>>('/fapi/v1/fundingRate', {
        symbol,
        startTime,
        limit: 1000,
      });
      return (raw || [])
        .filter(r => r.fundingRate != null && !isNaN(parseFloat(r.fundingRate)))
        .map(r => ({
          time: r.fundingTime,
          fundingRate: parseFloat(r.fundingRate),
        }));
    } catch {
      return [];
    }
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const symbol = toBinanceSymbol(coin);
      const data = await binGet<BinancePremiumIndex>('/fapi/v1/premiumIndex', { symbol });
      return parseFloat(data.markPrice);
    } catch {
      return null;
    }
  }
}
