/**
 * Bitget adapter — implements ExchangeAdapter for Bitget USDT-M Futures.
 * Base URL: https://api.bitget.com
 * All requests are public GET, no auth needed.
 * Rate limit: 20-50 req/sec.
 */
import type {
  ExchangeAdapter,
  Candle,
  AssetContext,
  FundingData,
  DexType,
} from '../../types.js';

const BASE_URL = 'https://api.bitget.com';
const TIMEOUT_MS = 3000;
const MAX_RETRIES = 1;

// Map our intervals to Bitget granularity values
// Bitget uses: 1m,3m,5m,15m,30m,1H,4H,6H,12H,1D,1W,1M
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m',
  '30m': '30m', '1h': '1H', '2h': '1H', '4h': '4H',
  '8h': '6H', '12h': '12H', '1d': '1D',
};

// ── Bitget response wrapper ──

interface BitgetResponse<T> {
  code: string;
  msg: string;
  data: T;
}

// ── Bitget response types ──

interface BitgetTicker {
  symbol: string;
  lastPr: string;
  markPrice: string;
  open24h: string;
  high24h: string;
  low24h: string;
  baseVolume: string;
  quoteVolume: string;
  fundingRate: string;
  nextFundingTime: string;
}

interface BitgetOpenInterest {
  openInterestList: Array<{ symbol: string; size: string }>;
  ts: string;
}

interface BitgetFundingRate {
  symbol: string;
  fundingRate: string;
}

interface BitgetFundingHistoryEntry {
  symbol: string;
  fundingRate: string;
  fundingTime: string;
}



async function bitgetGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
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
        throw new Error('Bitget API rate limited (429)');
      }
      if (!res.ok) throw new Error(`Bitget API ${res.status}: ${res.statusText}`);

      const body = (await res.json()) as BitgetResponse<T>;
      if (body.code !== '00000') {
        throw new Error(`Bitget API error ${body.code}: ${body.msg}`);
      }
      return body.data;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('Bitget API: max retries exceeded');
}

export class BitgetAdapter implements ExchangeAdapter {
  getName(): string {
    return 'Bitget';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = coin + 'USDT';
    const granularity = INTERVAL_MAP[interval] || '1h';

    // Response: array of string arrays [ts, open, high, low, close, baseVol, quoteVol]
    // Returns ASCENDING order — no need to reverse
    const data = await bitgetGet<string[][]>('/api/v2/mix/market/candles', {
      productType: 'USDT-FUTURES',
      symbol,
      granularity,
      startTime,
      limit: 200,
    });

    return (data || []).map(c => ({
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

    // Parallel fetch: ticker (single via filtering all tickers) + open interest + current funding rate
    const [tickersData, oiData, fundingData] = await Promise.all([
      bitgetGet<BitgetTicker[]>('/api/v2/mix/market/tickers', {
        productType: 'USDT-FUTURES',
        symbol,
      }),
      // Note: open-interest returns an OBJECT, not an array
      bitgetGet<BitgetOpenInterest>('/api/v2/mix/market/open-interest', {
        productType: 'USDT-FUTURES',
        symbol,
      }),
      bitgetGet<BitgetFundingRate[]>('/api/v2/mix/market/current-fund-rate', {
        productType: 'USDT-FUTURES',
        symbol,
      }),
    ]);

    const ticker = tickersData[0];
    const fundingRate = fundingData[0]?.fundingRate || '0';
    const oiEntry = oiData.openInterestList?.[0];

    // R2: Bitget funding is per-8h period → annualized = raw × 1095 (8h periods/year)
    const fundingRaw = parseFloat(fundingRate);
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: parseFloat(oiEntry?.size || '0'),
      prevDayPx: parseFloat(ticker.open24h || '0'),
      volume24h: parseFloat(ticker.quoteVolume || '0'),
      oraclePx: parseFloat(ticker.markPrice || '0'),
      markPx: parseFloat(ticker.markPrice || '0'),
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // Fetch ALL tickers for USDT-FUTURES
    const data = await bitgetGet<BitgetTicker[]>('/api/v2/mix/market/tickers', {
      productType: 'USDT-FUTURES',
    });

    return (data || [])
      .filter(entry => entry.symbol.endsWith('USDT'))
      .map(entry => ({
        coin: entry.symbol.replace(/USDT$/, ''),
        venues: [{
          venue: 'BitgetPerp',
          fundingRate: parseFloat(entry.fundingRate || '0'),
          nextFundingTime: parseInt(entry.nextFundingTime || '0'),
        }],
      }));
  }

  async getFundingHistory(coin: string, _startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const symbol = coin + 'USDT';
      const data = await bitgetGet<BitgetFundingHistoryEntry[]>('/api/v2/mix/market/history-fund-rate', {
        productType: 'USDT-FUTURES',
        symbol,
        pageSize: 100,
      });

      return (data || []).map(r => ({
        time: parseInt(r.fundingTime),
        fundingRate: parseFloat(r.fundingRate),
      }));
    } catch {
      return [];
    }
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const symbol = coin + 'USDT';
      const data = await bitgetGet<BitgetTicker[]>('/api/v2/mix/market/tickers', {
        productType: 'USDT-FUTURES',
        symbol,
      });
      return parseFloat(data[0].markPrice);
    } catch {
      return null;
    }
  }
}
