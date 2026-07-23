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
import { upstreamFetch, VENUE_FETCH_CONFIGS } from './_upstream-fetch.js';
import { makeServedIntervalMs } from '../served-interval.js';

const BASE_URL = 'https://api.bitget.com';
const MAX_RETRIES = 1;

// AlgoVault-canonical → Bitget-native base symbol for TradFi assets where Bitget's
// listing uses a different ticker (e.g. GOLD trades as XAUUSDT on Bitget, not GOLDUSDT).
// Derived from live Bitget contracts probe (TRADFI-SYMBOL-ALIAS-W1, 2026-05-15).
// Symmetric reverse-map applied in fromBitgetSymbol.
const TRADFI_ALIASES: Record<string, string> = {
  GOLD: 'XAU',
  SILVER: 'XAG',
  PLATINUM: 'XPT',
  PALLADIUM: 'XPD',
};

export function toBitgetSymbol(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return mapped + 'USDT';
}

export function fromBitgetSymbol(symbol: string): string {
  const base = symbol.replace(/USDT$/, '');
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native === base) return canon;
  }
  return base;
}

// Map our intervals to Bitget granularity values
// Bitget uses: 1m,3m,5m,15m,30m,1H,4H,6H,12H,1D,1W,1M
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m',
  '30m': '30m', '1h': '1H', '2h': '1H', '4h': '4H',
  '8h': '6H', '12h': '12H', '1d': '1D',
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms Bitget fetches for `tf`. 2h→1H/8h→6H are FINER (faithful). */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP);

// Bar duration in ms — to detect the historical-coverage gap + page the history endpoint.
const BAR_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

function mapBitgetCandle(c: string[]): Candle {
  return {
    time: parseInt(c[0]),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  };
}

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
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build + '00000' code-envelope check unchanged;
  // fetch/retry/ban via upstreamFetch — incl. Bitget body-code throttles
  // 45001/40725/40808 (banBodyCodes), now typed + no-retry (were generic + retried).
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  const body = await upstreamFetch<BitgetResponse<T>>({ ...VENUE_FETCH_CONFIGS.BITGET, transientRetries: retries }, { url: url.toString() });
  if (body.code !== '00000') {
    throw new Error(`Bitget API error ${body.code}: ${body.msg}`);
  }
  return body.data;
}

export class BitgetAdapter implements ExchangeAdapter {
  getName(): string {
    return 'Bitget';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = toBitgetSymbol(coin);
    const granularity = INTERVAL_MAP[interval] || '1h';
    const barMs = BAR_MS[interval] || 3_600_000;

    // Recent path (live/indicator use — UNCHANGED): `/market/candles` returns ASCENDING
    // [ts, open, high, low, close, baseVol, quoteVol]; no reverse needed.
    const data = await bitgetGet<string[][]>('/api/v2/mix/market/candles', {
      productType: 'USDT-FUTURES',
      symbol,
      granularity,
      startTime,
      limit: 200,
    });
    const candles = (data || []).map(mapBitgetCandle);

    // `/market/candles` only holds the recent window, so a HISTORICAL startTime yields the newest
    // bars instead of bars AT startTime (the labeler then filters them all → noKlines). Detect the
    // gap — the oldest returned bar should sit at ~startTime — and fall back to history-candles.
    // Recent requests satisfy the guard here and return the live path verbatim.
    if (candles.length > 0 && candles[0].time <= startTime + 5 * barMs) {
      return candles;
    }

    // Historical fallback: `/market/history-candles` returns bars BEFORE `endTime`, ascending.
    // Anchor endTime just past the wanted window so the page lands on [startTime, startTime + ~200 bars].
    const endTime = startTime + 200 * barMs;
    const hist = await bitgetGet<string[][]>('/api/v2/mix/market/history-candles', {
      productType: 'USDT-FUTURES',
      symbol,
      granularity,
      endTime,
      limit: 200,
    });
    const histAsc = (hist || []).map(mapBitgetCandle).filter(c => c.time >= startTime);
    return histAsc.length > 0 ? histAsc : candles;
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const symbol = toBitgetSymbol(coin);

    // Parallel fetch: ticker + open interest + current funding rate.
    // OPS-BITGET-TICKER-SYMBOL-FILTER-W1 (2026-06-04): use the SINGULAR
    // /api/v2/mix/market/ticker — the PLURAL /tickers IGNORES `symbol` and
    // returns all ~595 contracts, so `[0]` was YGGUSDT for every coin (wrong
    // price/volume/prevDayPx). The singular endpoint honors `symbol`.
    const [tickersData, oiData, fundingData] = await Promise.all([
      bitgetGet<BitgetTicker[]>('/api/v2/mix/market/ticker', {
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
    // Default-deny on drift: never silently use a mismatched row (guards against
    // the endpoint changing behavior again).
    if (!ticker || ticker.symbol !== symbol) {
      throw new Error(`BITGET_TICKER_SYMBOL_MISMATCH: requested ${symbol}, got ${ticker?.symbol ?? 'none'} from /api/v2/mix/market/ticker`);
    }
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
        coin: fromBitgetSymbol(entry.symbol),
        venues: [{
          venue: 'BitgetPerp',
          fundingRate: parseFloat(entry.fundingRate || '0'),
          nextFundingTime: parseInt(entry.nextFundingTime || '0'),
        }],
      }));
  }

  async getFundingHistory(coin: string, _startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const symbol = toBitgetSymbol(coin);
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
      const symbol = toBitgetSymbol(coin);
      // OPS-BITGET-TICKER-SYMBOL-FILTER-W1: singular /ticker (the plural ignores
      // `symbol` → `[0]`=YGGUSDT). Default-deny on a mismatched row.
      const data = await bitgetGet<BitgetTicker[]>('/api/v2/mix/market/ticker', {
        productType: 'USDT-FUTURES',
        symbol,
      });
      const ticker = data[0];
      if (!ticker || ticker.symbol !== symbol) {
        throw new Error(`BITGET_TICKER_SYMBOL_MISMATCH: requested ${symbol}, got ${ticker?.symbol ?? 'none'}`);
      }
      return parseFloat(ticker.markPrice);
    } catch {
      return null;
    }
  }
}
