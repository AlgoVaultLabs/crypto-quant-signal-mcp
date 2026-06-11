/**
 * WhiteBIT adapter — PILOT-ADAPTERS-W3B C4, 2026-05-20. WAVE COMPLETE.
 *
 * WhiteBIT (whitebit.com/api/v4/public/* + /api/v1/public/kline). Per Plan-Mode
 * probe 2026-05-20:
 *   - 315 USDT-margined perpetual markets. **100% USDT-settled** — `_PERP`
 *     suffix doesn't encode settlement, but in practice all `money_currency`
 *     values are `"USDT"` (Plan-Mode probe verified). Filter is a no-op
 *     safety belt against future divergence.
 *   - Symbol convention: `<coin>_PERP` (underscore + `_PERP` suffix; UNIQUE
 *     across adapter fleet — most-divergent W3B convention).
 *   - Funding cadence 8h × 1095 annualization (per `next_funding_rate_
 *     timestamp` 8h delta).
 *   - **`/api/v4/public/futures` is a single all-in-one endpoint** —
 *     returns 315 markets each with `{ticker_id, stock_currency,
 *     money_currency, last_price, stock_volume, money_volume, bid, ask,
 *     high, low, product_type: "Perpetual", open_interest, index_price,
 *     index_name, funding_rate, next_funding_rate_timestamp, brackets}`.
 *     Bundles instruments + funding + OI + mark + 24h vol in single call.
 *   - **Kline lives at `/api/v1/public/kline` (NOT v4!)** — v4 path returns
 *     empty. Interval is STRING family `1m`/`15m`/`30m`/`1h`/`4h`/`1d`
 *     (integers `60`/`3600` FAIL with "Invalid interval"). Row shape:
 *     `[ts_sec, open, close, high, low, base_vol, quote_vol]` (note the
 *     CLOSE-then-HIGH ordering, different from most CEXes' OHLC).
 *   - First W3-batch venue WITHOUT SPX listing — no memecoin trap.
 *
 * TRADFI_ALIASES (5): GOLD→XAU, SILVER→XAG, PLATINUM→XPT, PALLADIUM→XPD,
 * USOIL→CL. WhiteBIT has BOTH XAU + XAUT — prefer XAU spot (mirrors Gate
 * canonical). 5 stocks (AMZN/MSTR/NVDA/TSLA + others) + NATGAS route DIRECT.
 * NO SPX listing — first W3-batch venue without memecoin trap.
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

const BASE_URL = 'https://whitebit.com';
const MAX_RETRIES = 1;
const KLINE_LIMIT = 1000;

// WhiteBIT kline intervals: STRING family.
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '1d': '1d',
  '3m': '15m',   // no 3m
  '5m': '15m',   // no 5m
  '2h': '1h', '8h': '4h', '12h': '4h',
};

export const TRADFI_ALIASES: Record<string, string> = {
  GOLD: 'XAU',
  SILVER: 'XAG',
  PLATINUM: 'XPT',
  PALLADIUM: 'XPD',
  USOIL: 'CL',
};

export function toWhitebitSymbol(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return mapped + '_PERP';
}

export function fromWhitebitSymbol(symbol: string): string {
  const base = symbol.replace(/_PERP$/, '');
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native === base) return canon;
  }
  return base;
}

async function whitebitGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build unchanged; fetch/retry/ban via upstreamFetch.
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>({ ...VENUE_FETCH_CONFIGS.WHITEBIT, transientRetries: retries }, { url: url.toString() });
}

// ── Response shapes ──────────────────────────────────────────────────────

// Kline row: [ts_sec, open, close, high, low, base_vol, quote_vol]
// NOTE: WhiteBIT's order is OPEN-CLOSE-HIGH-LOW (NOT standard OHLC).
type WhitebitKlineRow = [number, string, string, string, string, string, string];

interface WhitebitKlineEnvelope {
  success: boolean;
  message: unknown;
  result: WhitebitKlineRow[];
}

interface WhitebitFuturesMarket {
  ticker_id: string;
  stock_currency: string;
  money_currency: string;
  last_price: string;
  stock_volume: string;
  money_volume: string;
  bid: string;
  ask: string;
  high: string;
  low: string;
  product_type: string;       // "Perpetual"
  open_interest: string;
  index_price: string;
  index_name: string;
  index_currency: string;
  funding_rate: string;
  next_funding_rate_timestamp: string;
}

interface WhitebitFuturesEnvelope {
  message: string | null;
  result: WhitebitFuturesMarket[];
  success: boolean;
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class WhitebitAdapter implements ExchangeAdapter {
  getName(): string { return 'WhiteBIT'; }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const market = toWhitebitSymbol(coin);
    const wbInterval = INTERVAL_MAP[interval] || '1h';

    const env = await whitebitGet<WhitebitKlineEnvelope>('/api/v1/public/kline', {
      market,
      interval: wbInterval,
      limit: KLINE_LIMIT,
    });

    if (!env || !env.success || !Array.isArray(env.result)) {
      throw new Error(`WhiteBIT: kline returned non-OK envelope for ${coin} (market=${market}) msg=${JSON.stringify(env?.message)}`);
    }

    const startSec = Math.floor(startTime / 1000);
    return env.result
      .filter(r => r[0] >= startSec)
      .map(r => ({
        time: r[0] * 1000,    // sec → ms
        open: parseFloat(r[1]),
        // WhiteBIT row order: [ts, open, close, high, low, base_vol, quote_vol]
        close: parseFloat(r[2]),
        high: parseFloat(r[3]),
        low: parseFloat(r[4]),
        volume: parseFloat(r[5]),    // base volume
      }))
      .sort((a, b) => a.time - b.time);
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const market = toWhitebitSymbol(coin);

    // Single all-in-one /api/v4/public/futures call returns all 315 markets;
    // adapter filters to requested coin + safety-belts on money_currency=USDT.
    const env = await whitebitGet<WhitebitFuturesEnvelope>('/api/v4/public/futures');
    const row = env?.result?.find(m =>
      m.ticker_id === market &&
      m.money_currency === 'USDT'   // safety belt — Plan-Mode confirmed 100% USDT but filter guards against future divergence
    );
    if (!row) {
      throw new Error(`WhiteBIT: market ${market} not found in /api/v4/public/futures (coin=${coin})`);
    }

    const fundingRaw = parseFloat(row.funding_rate || '0');
    const last = parseFloat(row.last_price || '0');
    // /api/v4/public/futures exposes no 24h-open or change field (verified live
    // 2026-06-11) — derive the 24h-prior price from the v1 kline (open of the
    // earliest candle in a trailing-24h window); fall back to the hi/lo midpoint,
    // never low (which biased priceChange almost-always positive). OPS-TRADE-CALL-CLUSTER-W1 class.
    let prevDayPx: number;
    try {
      const candles = await this.getCandles(coin, '1h', Date.now() - 24 * 60 * 60 * 1000);
      prevDayPx = candles.length > 0 ? candles[0].open : NaN;
    } catch {
      prevDayPx = NaN;
    }
    if (!Number.isFinite(prevDayPx) || prevDayPx <= 0) {
      prevDayPx = reconstructPrevDayOpen(last, NaN, parseFloat(row.high || ''), parseFloat(row.low || ''));
    }
    // WhiteBIT funding cadence 8h × 1095 annualization (standard).
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: parseFloat(row.open_interest || '0'),
      prevDayPx,
      volume24h: parseFloat(row.money_volume || '0'),
      oraclePx: parseFloat(row.index_price || row.last_price || '0'),
      markPx: parseFloat(row.last_price || row.index_price || '0'),    // WhiteBIT doesn't expose explicit mark_price — use last_price
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // Shadow venue [] per W3B Q-3.
    return [];
  }

  async getFundingHistory(_coin: string, _startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    // WhiteBIT funding history requires authenticated v4 endpoint. Adapter
    // returns [] for shadow venue fail-soft.
    return [];
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const market = toWhitebitSymbol(coin);
      const env = await whitebitGet<WhitebitFuturesEnvelope>('/api/v4/public/futures');
      const row = env?.result?.find(m => m.ticker_id === market && m.money_currency === 'USDT');
      if (!row) return null;
      const px = parseFloat(row.last_price || row.index_price || '0');
      return Number.isFinite(px) && px > 0 ? px : null;
    } catch {
      return null;
    }
  }
}
