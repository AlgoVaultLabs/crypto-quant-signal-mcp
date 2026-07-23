/**
 * Bitmart adapter — PILOT-ADAPTERS-W3B C2, 2026-05-20.
 *
 * Bitmart Futures V2 (api-cloud-v2.bitmart.com/contract/public/*).
 * Per Plan-Mode probe 2026-05-20:
 *   - 949 USDT-quote perpetuals (977 total contracts; filter quote_currency==USDT
 *     + product_type==1).
 *   - Symbol convention: `BTCUSDT` (no separator, mirrors Binance).
 *   - Funding cadence 8h × 1095 annualization (standard).
 *   - **Kline `step` is MINUTES ENUM {1, 3, 5, 15, 30, 60, 120, 240, 720}**.
 *     step=480 returns HTTP 400; step=1440/4320/10080 return 0 rows.
 *     Same shape as Phemex's kline limit ENUM (W3A C1 hotfix lesson c2b258c).
 *   - **Kline `limit` param NOT honored** — Bitmart kline uses start_time
 *     + end_time window only. Adapter computes window from desired candle
 *     count × interval-in-seconds.
 *   - `/contract/public/details` bundles per-symbol funding_rate +
 *     open_interest + last_price + index_price + mark_price (CAN be null
 *     for low-volume — fallback to index_price or last_price).
 *   - Funding-rate dedicated endpoint `/contract/public/funding-rate?symbol=`
 *     returns {expected_rate, rate_value (actual), funding_time (ms)}.
 *
 * TRADFI_ALIASES (5): GOLD→XAU, SILVER→XAG, PLATINUM→XPT, PALLADIUM→XPD,
 * USOIL→CL. Bitmart has BOTH XAU + XAUT — prefer XAU spot (mirrors Gate
 * canonical). VIX/COPPER/MSFT route DIRECT. SPX intentionally NOT aliased
 * (memecoin trap; SPXUSDT = $0.37 verified).
 */
import type {
  ExchangeAdapter,
  Candle,
  AssetContext,
  FundingData,
  DexType,
} from '../../types.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS } from './_upstream-fetch.js';
import { reconstructPrevDayOpen } from './_prev-day-open.js';
import { makeServedIntervalMs } from '../served-interval.js';

const BASE_URL = 'https://api-cloud-v2.bitmart.com';
const MAX_RETRIES = 1; // TIMEOUT_MS now lives in VENUE_FETCH_CONFIGS.BITMART (timeoutMs: 4000)

// Bitmart kline `step` is MINUTES ENUM {1,3,5,15,30,60,120,240,720}.
// Adapter maps canonical timeframes; falls back to nearest valid enum value.
const STEP_MAP: Record<string, number> = {
  '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
  '1h': 60, '2h': 120, '4h': 240,
  '8h': 240,   // Bitmart has no 8h step; fall back to 4h
  '12h': 720,  // 720 minutes = 12h
  '1d': 720,   // Bitmart has no 1440 minute step; 12h is closest valid
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms BitMart fetches for `tf` (STEP_MAP is MINUTES). 3m native. */
export const servedIntervalMs = makeServedIntervalMs(STEP_MAP, 'minutes');

// AlgoVault-canonical → Bitmart-native base symbol for TradFi.
// Bitmart has BOTH XAU + XAUT (both ~$4505); prefer XAU spot.
export const TRADFI_ALIASES: Record<string, string> = {
  GOLD: 'XAU',
  SILVER: 'XAG',
  PLATINUM: 'XPT',
  PALLADIUM: 'XPD',
  USOIL: 'CL',
};

export function toBitmartSymbol(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return mapped + 'USDT';
}

export function fromBitmartSymbol(symbol: string): string {
  const base = symbol.replace(/USDT$/, '');
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native === base) return canon;
  }
  return base;
}

async function bitmartGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build unchanged; fetch/retry/ban handling
  // delegated to the shared upstreamFetch (BITMART's 429→418 escalation is now a
  // typed, no-retry UpstreamRateLimitError — was generic + retried).
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>({ ...VENUE_FETCH_CONFIGS.BITMART, transientRetries: retries }, { url: url.toString() });
}

// ── Response shapes ──────────────────────────────────────────────────────

interface BitmartKlineEnvelope {
  code: number;
  message: string;
  data: Array<{
    low_price: string;
    high_price: string;
    open_price: string;
    close_price: string;
    volume: string;
    timestamp: number;  // seconds
  }>;
}

interface BitmartFundingRateEnvelope {
  code: number;
  message: string;
  data: {
    symbol: string;
    expected_rate: string;
    rate_value: string;    // current/actual
    funding_time: number;  // ms
    funding_upper_limit: string;
    funding_lower_limit: string;
    timestamp: number;
  };
}

interface BitmartDetailsEnvelope {
  data: {
    symbols: Array<{
      symbol: string;
      base_currency: string;
      quote_currency: string;
      product_type: number;
      last_price: string | null;
      mark_price: string | null;
      index_price: string | null;
      funding_rate: string | null;
      open_interest: string | null;
      contract_size: string;
      vol_24h: string | null;
      high_24h?: string | null;   // present live; used only as the hi/lo-midpoint fallback for prevDayPx
      low_24h?: string | null;
    }>;
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class BitmartAdapter implements ExchangeAdapter {
  getName(): string { return 'Bitmart'; }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = toBitmartSymbol(coin);
    const step = STEP_MAP[interval] ?? 60;
    // Bitmart kline uses start_time + end_time WINDOW (limit not honored).
    // Compute a generous window from startTime → now.
    const startSec = Math.floor(startTime / 1000);
    const endSec = Math.floor(Date.now() / 1000);

    const env = await bitmartGet<BitmartKlineEnvelope>('/contract/public/kline', {
      symbol,
      step,
      start_time: startSec,
      end_time: endSec,
    });

    if (!env || env.code !== 1000 || !Array.isArray(env.data)) {
      throw new Error(`Bitmart: kline returned non-OK envelope (code=${env?.code} msg=${env?.message})`);
    }

    return env.data
      .map(r => ({
        time: r.timestamp * 1000,   // sec → ms
        open: parseFloat(r.open_price),
        high: parseFloat(r.high_price),
        low: parseFloat(r.low_price),
        close: parseFloat(r.close_price),
        volume: parseFloat(r.volume),
      }))
      .sort((a, b) => a.time - b.time);
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const symbol = toBitmartSymbol(coin);

    // Bitmart bundles funding + OI + mark + index in `/contract/public/details`
    // (per-symbol record in the array). One call returns all 949 symbols; we
    // filter to the requested coin.
    const env = await bitmartGet<BitmartDetailsEnvelope>('/contract/public/details');
    const row = env?.data?.symbols?.find(s => s.symbol === symbol);
    if (!row) {
      throw new Error(`Bitmart: symbol ${symbol} not found in /contract/public/details (coin=${coin})`);
    }

    const fundingRaw = parseFloat(row.funding_rate || '0');
    const last = parseFloat(row.last_price || row.index_price || '0');
    // /contract/public/details exposes no 24h-open or change field (verified live
    // 2026-06-11) — derive the 24h-prior price from the hourly kline (open of the
    // earliest candle in a trailing-24h window); fall back to the hi/lo midpoint,
    // never last_price (which made priceChange ≈ 0). Extends OPS-TRADE-CALL-CLUSTER-W1.
    let prevDayPx: number;
    try {
      const candles = await this.getCandles(coin, '1h', Date.now() - 24 * 60 * 60 * 1000);
      prevDayPx = candles.length > 0 ? candles[0].open : NaN;
    } catch {
      prevDayPx = NaN;
    }
    if (!Number.isFinite(prevDayPx) || prevDayPx <= 0) {
      prevDayPx = reconstructPrevDayOpen(last, NaN, parseFloat(row.high_24h || ''), parseFloat(row.low_24h || ''));
    }
    // Bitmart funding cadence 8h × 1095 annualization (standard).
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: parseFloat(row.open_interest || '0'),
      prevDayPx,
      volume24h: parseFloat(row.vol_24h || '0'),
      oraclePx: parseFloat(row.index_price || row.mark_price || row.last_price || '0'),
      markPx: parseFloat(row.mark_price || row.index_price || row.last_price || '0'),
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // Bitmart shadow venue returns [] per W3B Q-3 fail-soft pattern.
    return [];
  }

  async getFundingHistory(coin: string, _startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const symbol = toBitmartSymbol(coin);
      const env = await bitmartGet<BitmartFundingRateEnvelope>('/contract/public/funding-rate', { symbol });
      if (!env || env.code !== 1000 || !env.data) return [];
      const time = env.data.funding_time || Date.now();
      const rate = parseFloat(env.data.rate_value || '0');
      return [{ time, fundingRate: rate }];
    } catch {
      return [];
    }
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const symbol = toBitmartSymbol(coin);
      const env = await bitmartGet<BitmartDetailsEnvelope>('/contract/public/details');
      const row = env?.data?.symbols?.find(s => s.symbol === symbol);
      if (!row) return null;
      const px = parseFloat(row.mark_price || row.index_price || row.last_price || '0');
      return Number.isFinite(px) && px > 0 ? px : null;
    } catch {
      return null;
    }
  }
}
