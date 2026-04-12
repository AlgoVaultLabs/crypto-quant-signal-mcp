/**
 * OKX adapter — implements ExchangeAdapter for OKX USDT-M Swaps.
 * Base URL: https://www.okx.com
 * All requests are public GET, no auth needed.
 * Rate limit: 10 req/sec — throttle enforced at 100ms between requests.
 */
import type {
  ExchangeAdapter,
  Candle,
  AssetContext,
  FundingData,
  DexType,
} from '../../types.js';

const BASE_URL = 'https://www.okx.com';
const TIMEOUT_MS = 3000;
const MAX_RETRIES = 1;

// ── Symbol mapping ──

function toOKXInstId(coin: string): string {
  return `${coin}-USDT-SWAP`;
}

function fromOKXInstId(instId: string): string {
  return instId.replace(/-USDT-SWAP$/, '');
}

// ── Interval mapping ──

const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m',
  '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H',
  '8h': '8H', '12h': '12H', '1d': '1D',
};

// ── Rate-limited HTTP client ──

let lastRequestTime = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 100) {
    await new Promise(r => setTimeout(r, 100 - elapsed));
  }
  lastRequestTime = Date.now();
}

interface OKXResponse<T> {
  code: string;
  msg: string;
  data: T;
}

async function okxGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<OKXResponse<T>> {
  await throttle();

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

      if (res.status === 429) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        throw new Error('OKX API rate limited (429)');
      }

      if (!res.ok) {
        throw new Error(`OKX API ${res.status}: ${res.statusText}`);
      }

      const body = (await res.json()) as OKXResponse<T>;
      if (body.code !== '0') {
        throw new Error(`OKX API error code ${body.code}: ${body.msg}`);
      }
      return body;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('OKX API: max retries exceeded');
}

// ── Response types from OKX ──

interface OKXTicker {
  instId: string;
  last: string;
  askPx: string;
  bidPx: string;
  open24h: string;
  high24h: string;
  low24h: string;
  vol24h: string;
  volCcy24h: string;
  ts: string;
}

interface OKXFundingRate {
  instId: string;
  fundingRate: string;
  nextFundingRate: string;
  fundingTime: string;
  nextFundingTime: string;
}

interface OKXFundingHistory {
  instId: string;
  fundingRate: string;
  realizedRate: string;
  fundingTime: string;
}

interface OKXOpenInterest {
  instId: string;
  oi: string;
  oiCcy: string;
  ts: string;
}

interface OKXMarkPrice {
  instId: string;
  markPx: string;
  ts: string;
}

export class OKXAdapter implements ExchangeAdapter {
  getName(): string {
    return 'OKX';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const instId = toOKXInstId(coin);
    const bar = INTERVAL_MAP[interval] || '1H';

    // OKX candles response: [[ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm], ...]
    // OKX pagination: "before" returns records NEWER than the timestamp
    const resp = await okxGet<string[][]>('/api/v5/market/candles', {
      instId,
      bar,
      before: startTime,
      limit: 100,
    });

    // CRITICAL: OKX returns candles DESCENDING (newest first) — reverse to ascending
    const candles = (resp.data || []).reverse();

    return candles.map(c => ({
      time: parseInt(c[0], 10),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const instId = toOKXInstId(coin);

    // Parallel fetch: ticker + funding-rate + open-interest + mark-price
    const [tickerResp, fundingResp, oiResp, markResp] = await Promise.all([
      okxGet<OKXTicker[]>('/api/v5/market/ticker', { instId }),
      okxGet<OKXFundingRate[]>('/api/v5/public/funding-rate', { instId }),
      okxGet<OKXOpenInterest[]>('/api/v5/public/open-interest', { instType: 'SWAP', instId }),
      okxGet<OKXMarkPrice[]>('/api/v5/public/mark-price', { instType: 'SWAP', instId }),
    ]);

    const ticker = tickerResp.data[0];
    const funding = fundingResp.data[0];
    const oi = oiResp.data[0];
    const mark = markResp.data[0];

    return {
      coin,
      funding: parseFloat(funding?.fundingRate || '0'),
      openInterest: parseFloat(oi?.oi || '0'),
      prevDayPx: parseFloat(ticker?.open24h || '0'),
      volume24h: parseFloat(ticker?.volCcy24h || '0'),
      oraclePx: parseFloat(mark?.markPx || '0'),
      markPx: parseFloat(mark?.markPx || '0'),
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // Step 1: Fetch all swap tickers to find top coins by volume
    const tickersResp = await okxGet<OKXTicker[]>('/api/v5/market/tickers', {
      instType: 'SWAP',
    });

    // Filter to USDT-SWAP pairs and sort by volume descending
    const usdtTickers = (tickersResp.data || [])
      .filter(t => t.instId.endsWith('-USDT-SWAP'))
      .sort((a, b) => parseFloat(b.volCcy24h || '0') - parseFloat(a.volCcy24h || '0'))
      .slice(0, 30); // Top 30 by volume to stay under rate limits

    // Step 2: Fetch funding rate for each, throttled at 100ms apart
    const results: FundingData[] = [];

    for (const ticker of usdtTickers) {
      try {
        const fundingResp = await okxGet<OKXFundingRate[]>('/api/v5/public/funding-rate', {
          instId: ticker.instId,
        });

        const fr = fundingResp.data[0];
        if (!fr) continue;

        const rate = parseFloat(fr.fundingRate);
        if (isNaN(rate)) continue;

        results.push({
          coin: fromOKXInstId(ticker.instId),
          venues: [{
            venue: 'OKXPerp',
            fundingRate: rate,
            nextFundingTime: parseInt(fr.nextFundingTime || '0', 10),
          }],
        });
      } catch {
        // Skip coins whose funding rate fetch fails
        continue;
      }
    }

    return results;
  }

  async getFundingHistory(coin: string, startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const instId = toOKXInstId(coin);
      const resp = await okxGet<OKXFundingHistory[]>('/api/v5/public/funding-rate-history', {
        instId,
        before: startTime,
        limit: 100,
      });

      // OKX returns descending — reverse to ascending
      const records = (resp.data || []).reverse();

      return records
        .filter(r => r.fundingRate != null && !isNaN(parseFloat(r.fundingRate)))
        .map(r => ({
          time: parseInt(r.fundingTime, 10),
          fundingRate: parseFloat(r.fundingRate),
        }));
    } catch {
      return [];
    }
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const instId = toOKXInstId(coin);
      const resp = await okxGet<OKXMarkPrice[]>('/api/v5/public/mark-price', {
        instType: 'SWAP',
        instId,
      });
      const mark = resp.data[0];
      return mark ? parseFloat(mark.markPx) : null;
    } catch {
      return null;
    }
  }
}
