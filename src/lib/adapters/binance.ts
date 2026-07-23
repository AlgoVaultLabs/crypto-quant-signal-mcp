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
import { upstreamFetch, VENUE_FETCH_CONFIGS } from './_upstream-fetch.js';
import { makeServedIntervalMs } from '../served-interval.js';

const BASE_URL = 'https://fapi.binance.com';
const MAX_RETRIES = 1;

// ── OPS-BINANCE-RATELIMITER-W1: fapi request → documented IP weight ──
// Binance USD-M Futures REST weights (per binance-docs fapi/v1, re-verified
// 2026-06-05). Single-symbol info requests are weight 1; the all-symbol
// (no `symbol` param) variants are the expensive ones. klines weight scales
// with `limit` (≤100→1, ≤500→2, ≤1000→5, else 10). Unknown paths default to a
// conservative 5 — never under-count (under-counting lets the IP burst past
// 2400 → 418 ban, the exact failure this budget prevents).
export function weightForBinance(path: string, params?: Record<string, string | number>): number {
  const hasSymbol = params?.symbol !== undefined;
  if (path.includes('/ticker/24hr')) return hasSymbol ? 1 : 40;
  if (path.includes('/premiumIndex')) return hasSymbol ? 1 : 10;
  if (path.includes('/ticker/price')) return hasSymbol ? 1 : 2;
  if (path.includes('/klines')) {
    const limit = Number(params?.limit ?? 100);
    if (limit <= 100) return 1;
    if (limit <= 500) return 2;
    if (limit <= 1000) return 5;
    return 10;
  }
  if (path.includes('/openInterest')) return 1;
  if (path.includes('/fundingRate')) return 1;
  if (path.includes('/ping') || path.includes('/time')) return 1;
  return 5; // conservative default — never under-count
}

// OPS-BINANCE-POLITE-DELAY-W1 (2026-05-22): per-coin getAssetContext used to
// issue 3 separate per-symbol calls (premiumIndex@symbol + openInterest@symbol
// + ticker/24hr@symbol = 3 weight per coin); plus seed-signals.fetchBinanceCoins
// and exchange-universe.fetchBinance each issued their own full-universe
// ticker/24hr fetch (weight 40 each, redundant). At top-50 5m fires this drove
// per-fire weight to ~290 (universe 40 + 3×50 per-coin + 50×2 klines); at top-
// 100 15m fires ~540. Cron burst-stacking at minute :02 (5m+1h) / :07 (5m+30m)
// pushed peak per-minute weight to 1835-1846 / 2400 cap (76-77%) on
// 2026-05-22T13:13:58 — 37 in-adapter "Rate limit warning" hits in a 1.7-second
// concurrent-fire burst. This in-process coalescing collapses three patterns:
//   (a) full-universe ticker/24hr fetched by N callers → 1 backend fetch / 60s
//       (consumers: fetchBinanceCoins, exchange-universe.fetchBinance,
//       getAssetContext per-coin ticker24hr@symbol replaced by cache lookup);
//   (b) bulk premiumIndex (weight 10 for all 746 perps) fetched by N callers
//       → 1 backend fetch / 60s (consumers: getAssetContext per-coin
//       premiumIndex@symbol replaced by cache lookup, getPredictedFundings).
// openInterest has NO bulk endpoint (confirmed via Binance docs) — stays per
// symbol at weight 1. Cross-process coalescing (separate cron-fire node
// processes) is out of scope; deferred to OPS-BINANCE-RATELIMITER-W2 if R4
// verification gates do not clear. Pattern mirrors OPS-HL-RATELIMIT-W1's
// metaAndAssetCtxs coalescer at hyperliquid.ts:34-67.
const TICKER24HR_TTL_MS = 60_000;
const PREMIUM_INDEX_TTL_MS = 60_000;

interface Ticker24hrCacheEntry {
  value: BinanceTicker24hr[];
  ts: number;
}
interface PremiumIndexCacheEntry {
  value: BinancePremiumIndex[];
  ts: number;
}

let ticker24hrCache: Ticker24hrCacheEntry | null = null;
let ticker24hrInflight: Promise<BinanceTicker24hr[]> | null = null;
let premiumIndexCache: PremiumIndexCacheEntry | null = null;
let premiumIndexInflight: Promise<BinancePremiumIndex[]> | null = null;

// Map our intervals to Binance kline intervals
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m',
  '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h',
  '8h': '8h', '12h': '12h', '1d': '1d',
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms Binance fetches for `tf` (fully native). */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP);

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

// AlgoVault-canonical → Binance-native base symbol for TradFi assets where Binance's
// listing uses a different ticker (e.g. GOLD trades as XAUUSDT on Binance, not GOLDUSDT).
// Derived from live Binance exchangeInfo probe (TRADFI-SYMBOL-ALIAS-W1, 2026-05-15).
// IMPORTANT: SP500 → SPX was NOT included even though SPXUSDT exists — Binance's
// SPXUSDT is the SPX6900 memecoin (~$0.40), NOT the S&P 500 index (~$7400 on HL).
// SP500 stays HL-only via venue-coverage.ts. SPX (the memecoin) is a direct match
// on all CEXs and HL standard perps; no alias needed.
const TRADFI_ALIASES: Record<string, string> = {
  GOLD: 'XAU',
  SILVER: 'XAG',
  PLATINUM: 'XPT',
  PALLADIUM: 'XPD',
};

export function toBinanceSymbol(coin: string): string {
  // Resolution order: TRADFI alias wins over meme-coin 1000-prefix override
  // (they don't actually overlap, but the order documents the intent).
  const mapped = TRADFI_ALIASES[coin] || SYMBOL_OVERRIDES[coin] || coin;
  return mapped + 'USDT';
}

// Reverse map: Binance symbol back to our coin name
export function fromBinanceSymbol(symbol: string): string {
  const base = symbol.replace(/USDT$/, '');
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native === base) return canon;
  }
  for (const [ourCoin, binName] of Object.entries(SYMBOL_OVERRIDES)) {
    if (binName === base) return ourCoin;
  }
  return base;
}

/**
 * OPS-BINANCE-POLITE-DELAY-W1 (2026-05-22): coalesced full-universe
 * ticker/24hr (weight 40). Returns ALL USDT-perp 24hr stats. Cached
 * for 60s in-process, with inflight-promise dedup. Consumers should
 * read per-symbol fields via `.find(t => t.symbol === ...)`.
 *
 * Mirrors OPS-HL-RATELIMIT-W1's getMetaAndAssetCtxsCoalesced shape.
 */
export async function getTicker24hrFullCoalesced(): Promise<BinanceTicker24hr[]> {
  if (ticker24hrCache && Date.now() - ticker24hrCache.ts < TICKER24HR_TTL_MS) {
    return ticker24hrCache.value;
  }
  if (ticker24hrInflight) {
    return ticker24hrInflight;
  }
  const promise = binGet<BinanceTicker24hr[]>('/fapi/v1/ticker/24hr')
    .then((value) => {
      ticker24hrCache = { value, ts: Date.now() };
      ticker24hrInflight = null;
      return value;
    })
    .catch((err) => {
      ticker24hrInflight = null;
      throw err;
    });
  ticker24hrInflight = promise;
  return promise;
}

/**
 * OPS-BINANCE-POLITE-DELAY-W1 (2026-05-22): coalesced bulk premiumIndex
 * (weight 10 for all ~750 perps, vs weight 1 × N for per-symbol). Cached
 * for 60s in-process, with inflight-promise dedup. Consumers should read
 * per-symbol fields via `.find(t => t.symbol === ...)`.
 */
export async function getPremiumIndexBulkCoalesced(): Promise<BinancePremiumIndex[]> {
  if (premiumIndexCache && Date.now() - premiumIndexCache.ts < PREMIUM_INDEX_TTL_MS) {
    return premiumIndexCache.value;
  }
  if (premiumIndexInflight) {
    return premiumIndexInflight;
  }
  const promise = binGet<BinancePremiumIndex[]>('/fapi/v1/premiumIndex')
    .then((value) => {
      premiumIndexCache = { value, ts: Date.now() };
      premiumIndexInflight = null;
      return value;
    })
    .catch((err) => {
      premiumIndexInflight = null;
      throw err;
    });
  premiumIndexInflight = promise;
  return promise;
}

/**
 * Test-only reset of the adapter's coalescing caches. Production code MUST
 * NOT call this — used by unit tests to isolate cases.
 */
export function _resetBinanceAdapterCaches(): void {
  ticker24hrCache = null;
  ticker24hrInflight = null;
  premiumIndexCache = null;
  premiumIndexInflight = null;
}

async function binGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build + venue weight (weightForBinance) unchanged;
  // the cross-process budget acquire (via the registry), 418/429→typed-no-retry, and the
  // X-MBX-USED-WEIGHT forensic warn (cfg.onResponse) all move into the shared upstreamFetch.
  // Behavior byte-identical (OPS-BINANCE-RATELIMITER-W1 budget + 418 handling preserved).
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>(
    { ...VENUE_FETCH_CONFIGS.BINANCE, transientRetries: retries },
    { url: url.toString(), weightHint: weightForBinance(path, params) },
  );
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
  // OPS-TRADE-CALL-CLUSTER-W1 CH3: Binance Futures /fapi/v1/ticker/24hr does NOT
  // populate prevClosePrice for futures (spot-only field); openPrice IS present
  // and represents the 24h-rolling open. Use openPrice for prevDayPx mapping to
  // get a non-zero priceChange / oi_change_pct in the verdict output.
  openPrice: string;
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

    // OPS-BINANCE-POLITE-DELAY-W1 (2026-05-22): premiumIndex + ticker/24hr served
    // from in-process coalesced bulk caches (60s TTL each); openInterest stays
    // per-symbol — Binance has no bulk OI endpoint. Reduces per-coin weight from
    // 3 (3 per-symbol calls: premiumIndex@symbol + openInterest@symbol +
    // ticker24hr@symbol) to 1 (openInterest only) once the per-fire bulk
    // fetches are warm. Net per-50-coin fire: 290 weight → 200 (-31%).
    const [premiumIndexBulk, ticker24hrBulk, oi] = await Promise.all([
      getPremiumIndexBulkCoalesced(),
      getTicker24hrFullCoalesced(),
      binGet<BinanceOpenInterest>('/fapi/v1/openInterest', { symbol }),
    ]);

    const premiumIndex = premiumIndexBulk.find(p => p.symbol === symbol);
    const ticker = ticker24hrBulk.find(t => t.symbol === symbol);

    if (!premiumIndex) {
      throw new Error(`Binance premiumIndex not found for symbol ${symbol}`);
    }
    if (!ticker) {
      throw new Error(`Binance ticker24hr not found for symbol ${symbol}`);
    }

    // R2: Binance funding is per-8h period → annualized = raw × 1095 (8h periods/year)
    const fundingRaw = parseFloat(premiumIndex.lastFundingRate || '0');
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: parseFloat(oi.openInterest || '0'),
      // OPS-TRADE-CALL-CLUSTER-W1 CH3 (OPS-BOT-NO-TRADE-CALLS-AUDIT-W1 surfaced
      // indicators.oi_change_pct: 0 on every BINANCE probe; Plan-Mode #1 root-cause
      // = Path (a)): Binance Futures `prevClosePrice` field is undefined on
      // /fapi/v1/ticker/24hr (spot-only); falls through to '0' default → 0.
      // `openPrice` IS present + is the 24h-rolling open; using it yields a
      // non-zero priceChange / oi_change_pct matching the API's priceChangePercent
      // field exactly. BYBIT/OKX/BITGET adapters use their own per-venue 24h-prev
      // fields that already work correctly (BYBIT uses prevPrice24h).
      prevDayPx: parseFloat(ticker.openPrice || ticker.prevClosePrice || '0'),
      volume24h: parseFloat(ticker.quoteVolume || '0'),
      oraclePx: parseFloat(premiumIndex.markPrice || '0'),
      markPx: parseFloat(premiumIndex.markPrice || '0'),
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // OPS-BINANCE-POLITE-DELAY-W1 (2026-05-22): served from in-process coalesced
    // bulk premiumIndex cache (60s TTL). Saves weight 10 per `scan_funding_arb`
    // tool invocation when called within 60s of any other premiumIndex consumer
    // (esp. concurrent getAssetContext callers from the seed loop).
    const raw = await getPremiumIndexBulkCoalesced();

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
