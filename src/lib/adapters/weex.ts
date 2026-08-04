/**
 * WEEX adapter — PILOT-ADAPTERS-W3B C1, 2026-05-20.
 *
 * Symbol convention: cmt_<coin>usdt (lowercase + cmt_ prefix). Most-divergent
 * W3B convention; unique among 13 prior adapters. Funding cadence 4h (×2190
 * annualization, NOT ×1095) per contract metadata delivery field [00,04,08,12,
 * 16,20]. First non-8h venue in adapter fleet. No public funding/OI endpoints
 * surfaced — adapter returns funding=0 + openInterest=0 (fail-soft per W3B
 * Plan-Mode Q-3 ratification 2026-05-20). Ticker bundles markPrice + indexPrice
 * + 24h vol + last. Kline granularity = string family 1m/5m/15m/1h/4h/1d.
 * Direct-array row shape [ts_ms, open, high, low, close, base_vol, quote_vol].
 *
 * TRADFI_ALIASES (4): SILVER→XAG, PLATINUM→XPT, PALLADIUM→XPD, USOIL→CL.
 * WEEX has NO XAU/GOLD listing. SPX intentionally NOT aliased — cmt_spxusdt
 * = $0.37 SPX6900 memecoin per semantic-fingerprint probe 2026-05-20 (5th
 * sighting). WEEX has NO real S&P 500 perp.
 */
import type {
  ExchangeAdapter,
  Candle,
  AssetContext,
  FundingData,
  DexType,
} from '../../types.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS, safeUpstreamNum } from './_upstream-fetch.js';
import { reconstructPrevDayOpen } from './_prev-day-open.js';
import { makeServedIntervalMs } from '../served-interval.js';

const BASE_URL = 'https://api-contract.weex.com';
const MAX_RETRIES = 1;
const KLINE_LIMIT = 1000;

const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '15m',
  '1h': '1h', '4h': '4h', '1d': '1d',
  '3m': '5m', '2h': '1h', '8h': '4h', '12h': '4h',
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms WEEX fetches for `tf`. 3m→5m (1.67×), 30m→15m/8h→4h finer. */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP);

export const TRADFI_ALIASES: Record<string, string> = {
  SILVER: 'XAG', PLATINUM: 'XPT', PALLADIUM: 'XPD', USOIL: 'CL',
};

export function toWeexSymbol(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return 'cmt_' + mapped.toLowerCase() + 'usdt';
}

export function fromWeexSymbol(symbol: string): string {
  const base = symbol.replace(/^cmt_/, '').replace(/usdt$/, '').toUpperCase();
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native.toUpperCase() === base) return canon;
  }
  return base;
}

async function weexGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build unchanged; fetch/retry/ban via upstreamFetch.
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>({ ...VENUE_FETCH_CONFIGS.WEEX, transientRetries: retries }, { url: url.toString() });
}

type WeexKlineRow = [string, string, string, string, string, string, string];

interface WeexTicker {
  symbol: string;
  last: string;
  best_ask: string;
  best_bid: string;
  high_24h: string;
  low_24h: string;
  volume_24h: string;
  timestamp: string;
  priceChangePercent: string;
  base_volume: string;
  markPrice: string;
  indexPrice: string;
}

export class WeexAdapter implements ExchangeAdapter {
  getName(): string { return 'WEEX'; }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = toWeexSymbol(coin);
    const granularity = INTERVAL_MAP[interval] || '1h';
    const rows = await weexGet<WeexKlineRow[]>('/capi/v2/market/candles', { symbol, granularity, limit: KLINE_LIMIT });
    if (!Array.isArray(rows)) {
      throw new Error(`WEEX: kline returned non-array shape for ${coin} (symbol=${symbol})`);
    }
    // SV-04: drop a candle whose OHLC does not parse strictly rather than emit a
    // NaN/wrong-but-finite price into the signal engine.
    return rows
      .filter(r => parseInt(r[0], 10) >= startTime)
      .flatMap(r => {
        const open = safeUpstreamNum(r[1]);
        const high = safeUpstreamNum(r[2]);
        const low = safeUpstreamNum(r[3]);
        const close = safeUpstreamNum(r[4]);
        if (open === null || high === null || low === null || close === null) return [];
        return [{
          time: parseInt(r[0], 10),
          open, high, low, close,
          volume: parseFloat(r[5]),
        }];
      })
      .sort((a, b) => a.time - b.time);
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const symbol = toWeexSymbol(coin);
    const t = await weexGet<WeexTicker>('/capi/v2/market/ticker', { symbol });
    if (!t || !t.symbol) {
      throw new Error(`WEEX: empty ticker payload for ${coin} (symbol=${symbol})`);
    }
    // WEEX 4h funding cadence × 2190 annualization (first non-8h venue).
    // Funding rate NOT exposed publicly — adapter returns 0 per W3B Q-3 fail-soft.
    const fundingRaw = 0;
    // SV-04: default-deny — an invalid markPrice throws (the 3-tier fallback fires)
    // rather than scoring a wrong-but-finite price; non-price fields fall back to a
    // safe neutral 0. Same contract as the aster adapter.
    const last = safeUpstreamNum(t.last) ?? 0;
    const markPx = safeUpstreamNum(t.markPrice);
    if (markPx === null) throw new Error('WEEX getAssetContext: invalid markPrice');
    // WEEX priceChangePercent is a 24h change FRACTION (0.0055 = 0.55%; verified
    // live 2026-06-11) — NOT a percent-number, so do NOT divide by 100.
    const prevDayPx = reconstructPrevDayOpen(
      last,
      safeUpstreamNum(t.priceChangePercent) ?? NaN,
      safeUpstreamNum(t.high_24h) ?? undefined,
      safeUpstreamNum(t.low_24h) ?? undefined,
    );
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 2190,
      openInterest: 0,
      prevDayPx,
      volume24h: parseFloat(t.volume_24h || '0'),
      oraclePx: safeUpstreamNum(t.indexPrice) ?? markPx,
      markPx,
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    return [];
  }

  async getFundingHistory(_coin: string, _startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    return [];
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const symbol = toWeexSymbol(coin);
      const t = await weexGet<WeexTicker>('/capi/v2/market/ticker', { symbol });
      if (!t || !t.markPrice) return null;
      return safeUpstreamNum(t.markPrice);
    } catch {
      return null;
    }
  }
}
