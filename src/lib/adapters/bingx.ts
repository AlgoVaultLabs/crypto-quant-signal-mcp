/**
 * BingX adapter — implements ExchangeAdapter for BingX Swap V2 USDT-M Perpetual.
 *
 * BingX (`open-api.bingx.com/openApi/swap/v2/quote/*`) per PILOT-ADAPTERS-W3A
 * Plan-Mode probe 2026-05-20:
 *   - 638 USDT-perp listed (.data[currency=USDT, status=1] from /contracts).
 *   - Funding cadence 8h × 1095 annualization (fundingIntervalHours=8 verified).
 *   - Symbol convention: `<COIN>-USDT` (HYPHEN separator).
 *   - **Binance-style 3-call fan-out for getAssetContext** (unlike Phemex's
 *     all-in-one ticker): combines `/premiumIndex` (mark+index+funding) +
 *     `/openInterest` (OI) + `/ticker` (24h vol + lastPrice + openPrice) via
 *     `Promise.all`.
 *   - Kline interval: string family (`1m`, `5m`, `15m`, `30m`, `1h`, `2h`,
 *     `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`, `1M`).
 *   - All JSON fields are direct float STRINGS (no scaling, no encoding).
 *   - Kline limit is a normal integer range up to 1440 (probed 2026-05-20).
 *   - 88% derivs-volume mix; CoinGecko derivatives rank 19; Tier-A reputation;
 *     rate-limit upgrade 2025-10-16.
 *
 * Status: shadow (PILOT-ADAPTERS-W3A / C2, 2026-05-20).
 *
 * TRADFI_ALIASES map (1 entry — sparse TradFi catalog on BingX) — GOLD → XAUT
 * (Tether Gold; price-probe $4464.81 ≈ XAU spot $4465 within 0.05%; mirrors
 * MEXC + KuCoin pattern). SPX intentionally NOT aliased — BingX `SPX-USDT` is
 * SPX6900 memecoin ($0.36) per semantic-fingerprint probe 2026-05-20 (4th
 * sighting). BingX does NOT list a real S&P 500 perp.
 *
 * getPredictedFundings: returns [] for shadow venue (per W3A Plan-Mode Q-4) —
 * cross-venue funding fanout fires only for promoted venues; follow-up wave
 * wires per-canonical-universe funding fetch when BingX clears promotion.
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

const BASE_URL = 'https://open-api.bingx.com';
const MAX_RETRIES = 1;
const KLINE_LIMIT = 1000;   // BingX max is 1440; 1000 is a safe generous default

// BingX kline intervals (string family — DIFFERENT from Phemex's integer
// seconds AND from MEXC's `Min1`/`Hour4` prefix style).
const INTERVAL_MAP: Record<string, string> = {
  '1m':  '1m',
  '3m':  '3m',
  '5m':  '5m',
  '15m': '15m',
  '30m': '30m',
  '1h':  '1h',
  '2h':  '2h',
  '4h':  '4h',
  '6h':  '6h',
  '8h':  '8h',
  '12h': '12h',
  '1d':  '1d',
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms BingX fetches for `tf` (fully native, incl. 3m/6h). */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP);

// AlgoVault-canonical → BingX-native base symbol for TradFi.
// Per PILOT-ADAPTERS-W3A Plan-Mode probe 2026-05-20: BingX has only 2 TradFi
// listings (SPX-USDT = SPX6900 memecoin; XAUT-USDT = Tether Gold). SPX
// intentionally NOT mapped.
export const TRADFI_ALIASES: Record<string, string> = {
  GOLD: 'XAUT',     // BingX has only XAUT (no XAU). Tether Gold tracks spot within 0.05%.
};

export function toBingxSymbol(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return mapped + '-USDT';
}

export function fromBingxSymbol(symbol: string): string {
  const base = symbol.replace(/-USDT$/, '');
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native === base) return canon;
  }
  return base;
}

async function bingxGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build unchanged; fetch/retry/ban via upstreamFetch.
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>({ ...VENUE_FETCH_CONFIGS.BINGX, transientRetries: retries }, { url: url.toString() });
}

// ── Response shapes ──────────────────────────────────────────────────────

interface BingxKlineEnvelope {
  code: number;
  msg: string;
  data: Array<{
    open: string;
    close: string;
    high: string;
    low: string;
    volume: string;
    time: number;     // ms since epoch
  }>;
}

interface BingxPremiumIndexEnvelope {
  code: number;
  msg: string;
  data: {
    symbol: string;
    markPrice: string;
    indexPrice: string;
    lastFundingRate: string;
    nextFundingTime: number;
    fundingIntervalHours: number;
    minFundingRate: string;
    maxFundingRate: string;
    updateTime: number;
  };
}

interface BingxOpenInterestEnvelope {
  code: number;
  msg: string;
  data: {
    openInterest: string;
    symbol: string;
    time: number;
  };
}

interface BingxTickerEnvelope {
  code: number;
  msg: string;
  data: {
    symbol: string;
    priceChange: string;
    priceChangePercent: string;
    lastPrice: string;
    lastQty: string;
    highPrice: string;
    lowPrice: string;
    volume: string;          // base-asset 24h vol
    quoteVolume: string;     // USDT 24h vol
    openPrice: string;
    openTime: number;
    closeTime: number;
    askPrice: string;
    askQty: string;
    bidPrice: string;
    bidQty: string;
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class BingxAdapter implements ExchangeAdapter {
  getName(): string {
    return 'BingX';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = toBingxSymbol(coin);
    const bingxInterval = INTERVAL_MAP[interval] || '1h';

    const env = await bingxGet<BingxKlineEnvelope>('/openApi/swap/v2/quote/klines', {
      symbol,
      interval: bingxInterval,
      limit: KLINE_LIMIT,
    });

    if (!env || env.code !== 0 || !Array.isArray(env.data)) {
      throw new Error(`BingX: kline returned non-OK envelope (code=${env?.code} msg=${env?.msg})`);
    }

    // BingX returns newest-first; filter by startTime (ms-ms compare) + sort
    // oldest-first (canonical Candle[] ordering).
    return env.data
      .filter(r => r.time >= startTime)
      .map(r => ({
        time: r.time,    // already ms
        open: parseFloat(r.open),
        high: parseFloat(r.high),
        low: parseFloat(r.low),
        close: parseFloat(r.close),
        volume: parseFloat(r.volume),
      }))
      .sort((a, b) => a.time - b.time);
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const symbol = toBingxSymbol(coin);

    // Binance-style 3-call fan-out: premiumIndex (mark+funding) + openInterest (OI)
    // + ticker (24h vol + lastPrice + openPrice).
    const [pi, oi, tk] = await Promise.all([
      bingxGet<BingxPremiumIndexEnvelope>('/openApi/swap/v2/quote/premiumIndex', { symbol }),
      bingxGet<BingxOpenInterestEnvelope>('/openApi/swap/v2/quote/openInterest', { symbol }),
      bingxGet<BingxTickerEnvelope>('/openApi/swap/v2/quote/ticker', { symbol }),
    ]);

    if (!pi?.data || !tk?.data) {
      throw new Error(`BingX: empty premiumIndex/ticker payload for ${coin} (symbol=${symbol}) pi.code=${pi?.code} tk.code=${tk?.code}`);
    }

    // BingX funding cadence is 8h (fundingIntervalHours=8 verified live);
    // annualized = rate × 1095 (8h periods per year). Same as Binance/Bybit/
    // Bitget/Gate/MEXC/KuCoin/Phemex.
    const fundingRaw = parseFloat(pi.data.lastFundingRate || '0');
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: parseFloat(oi?.data?.openInterest || '0'),
      prevDayPx: parseFloat(tk.data.openPrice || '0'),    // 24h-ago open
      volume24h: parseFloat(tk.data.quoteVolume || '0'),
      oraclePx: parseFloat(pi.data.indexPrice || pi.data.markPrice || '0'),
      markPx: parseFloat(pi.data.markPrice || '0'),
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // BingX shadow venue returns [] per PILOT-ADAPTERS-W3A Plan-Mode Q-4:
    // cross-venue funding fanout fires only for promoted venues. Follow-up
    // wave wires per-canonical-universe funding fetch when BingX clears
    // promotion gates.
    return [];
  }

  async getFundingHistory(_coin: string, _startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    // BingX's public historical funding endpoint requires signed auth. Adapter
    // returns [] for shadow venue (callers fail-soft); promotion-ready
    // implementation can route via authenticated `/openApi/swap/v2/quote/
    // fundingRate` with HMAC.
    return [];
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const symbol = toBingxSymbol(coin);
      const env = await bingxGet<BingxPremiumIndexEnvelope>('/openApi/swap/v2/quote/premiumIndex', { symbol });
      if (!env?.data) return null;
      const px = parseFloat(env.data.markPrice);
      return Number.isFinite(px) ? px : null;
    } catch {
      return null;
    }
  }
}
