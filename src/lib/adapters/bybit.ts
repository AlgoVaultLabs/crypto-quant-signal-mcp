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

const BASE_URL = 'https://api.bybit.com';
const TIMEOUT_MS = 3000;
const MAX_RETRIES = 1;

// Map our intervals to Bybit kline intervals
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15',
  '30m': '30', '1h': '60', '2h': '120', '4h': '240',
  '8h': '480', '12h': '720', '1d': 'D',
};

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
      const res = await fetch(url.toString(), { signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 429) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw new Error('Bybit API rate limited (429)');
      }
      if (!res.ok) throw new Error(`Bybit API ${res.status}: ${res.statusText}`);

      const body = (await res.json()) as BybitResponse<T>;
      if (body.retCode !== 0) {
        throw new Error(`Bybit API error ${body.retCode}: ${body.retMsg}`);
      }
      return body.result;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('Bybit API: max retries exceeded');
}

export class BybitAdapter implements ExchangeAdapter {
  getName(): string {
    return 'Bybit';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = coin + 'USDT';
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
    const symbol = coin + 'USDT';

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

    const ticker = tickerData.list[0];
    const oi = oiData.list[0];

    return {
      coin,
      funding: parseFloat(ticker.fundingRate || '0'),
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
        coin: entry.symbol.replace(/USDT$/, ''),
        venues: [{
          venue: 'BybitPerp',
          fundingRate: parseFloat(entry.fundingRate || '0'),
          nextFundingTime: parseInt(entry.nextFundingTime || '0'),
        }],
      }));
  }

  async getFundingHistory(coin: string, startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const symbol = coin + 'USDT';
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
      const symbol = coin + 'USDT';
      const data = await bybitGet<{ list: BybitTicker[] }>('/v5/market/tickers', {
        category: 'linear',
        symbol,
      });
      return parseFloat(data.list[0].markPrice);
    } catch {
      return null;
    }
  }
}
