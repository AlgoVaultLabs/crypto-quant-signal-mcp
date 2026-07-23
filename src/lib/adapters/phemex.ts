/**
 * Phemex adapter — implements ExchangeAdapter for Phemex USDT-M Hedged Perpetual (V2).
 *
 * Phemex (`api.phemex.com/...`) ships TWO perpetual product families:
 *   - LEGACY `data.products` array — non-hedged inverse contracts (`cBTCUSD`,
 *     `cETHUSD`, etc.). Uses `Ev/Er` scaled-integer encoding (priceScale=4,
 *     ratioScale=8 typical). NOT TARGETED by this adapter.
 *   - V2 `data.perpProductsV2` array — hedged USDT-M perpetual (`BTCUSDT`,
 *     `ETHUSDT`, etc.). Uses `Rp/Rv/Rr/Rq` REAL-value suffix (priceScale=0,
 *     ratioScale=0). NO decoding required. TARGETED by this adapter.
 *
 * Per PILOT-ADAPTERS-W3A Plan-Mode probe 2026-05-20:
 *   - 538 USDT-margined hedged perpetuals listed under perpProductsV2.
 *   - Funding cadence 8h (fundingInterval=28800s; ×1095 annualization, matches
 *     Binance/Bybit/Bitget/Gate/MEXC/KuCoin).
 *   - Symbol convention: `<COIN>USDT` (no separator, no `c` prefix for V2).
 *   - All-in-one ticker endpoint `/md/v2/ticker/24hr?symbol=<sym>` bundles
 *     `closeRp + markPriceRp + indexPriceRp + fundingRateRr + openInterestRv +
 *     openRp + highRp + lowRp + turnoverRv + volumeRq` — single REST call for
 *     `getAssetContext`.
 *   - Kline endpoint `/exchange/public/md/v2/kline/last` returns NON-STANDARD
 *     10-field rows: `[ts_sec, interval_sec, last_close, open, high, low, close,
 *     volume, turnover, symbol]`. The `last_close` (idx 2) is the previous bar's
 *     close (kept for delta calc); `open` (idx 3) is THIS bar's open. **Min limit
 *     is ~10**; smaller limits return `30000 'Please double check input arguments'`.
 *
 * Status: shadow (PILOT-ADAPTERS-W3A / C1, 2026-05-20).
 *
 * TradFi alias map (6 entries) — gold/silver/platinum/palladium/natgas/usoil
 * route through `TRADFI_ALIASES` to Phemex's native symbol names. Stocks +
 * indices route direct (Phemex uses literal canonical names for TSLA/NVDA/META/
 * GOOGL/AAPL/AMZN/COIN/MSTR/MSFT/VIX/SP500). SPX intentionally NOT aliased —
 * `SPXUSDT` on Phemex is the SPX6900 memecoin ($0.36), NOT S&P 500 ($7338).
 * `SP500USDT` IS the real S&P 500 — Phemex uniquely lists BOTH; canonical
 * AlgoVault key `SP500` routes direct (identity, no alias row needed).
 * Verified via semantic-fingerprint price-probe 2026-05-20.
 *
 * getPredictedFundings: returns [] for shadow venue (per PILOT-ADAPTERS-W3A
 * Plan-Mode Q-4). Phemex has no working batch-tickers endpoint and is not yet
 * published to scan_funding_arb. Follow-up wave wires per-canonical-universe
 * funding fetch when Phemex clears promotion gates.
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

const BASE_URL = 'https://api.phemex.com';
const MAX_RETRIES = 1;

// Phemex kline `resolution` is INTEGER SECONDS (60=1m, 300=5m, …, 86400=1d).
// Per Plan-Mode probe of /exchange/public/md/v2/kline/last 2026-05-20.
const INTERVAL_MAP: Record<string, number> = {
  '1m':   60,
  '3m':   300,  // Phemex has no 3m; fall back to 5m (closest available)
  '5m':   300,
  '15m':  900,
  '30m':  1800,
  '1h':   3600,
  '2h':   3600, // Phemex has no 2h; fall back to 1h
  '4h':   14400,
  '8h':   14400, // Phemex has no 8h; fall back to 4h
  '12h':  86400, // Phemex has no 12h; fall back to 1d
  '1d':   86400,
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms Phemex fetches for `tf` (map is SECONDS). 12h→1d coarsens (2×). */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP, 'seconds');

// Phemex kline endpoint accepts `limit` as a FIXED ENUM (probed 2026-05-20
// post-deploy R7 verification gate):
//   {5, 10, 50, 100, 500, 1000} → HTTP 200 OK
//   any other value (11, 20, 30, 40, 60, 80, 150, 200, 250, 300, ...) → HTTP 400
//     with `code:30000 "Please double check input arguments"`.
// Adapter uses 1000 to fetch maximum history per call; downstream filters by
// startTime and downsamples as needed.
const KLINE_LIMIT = 1000;

// AlgoVault-canonical → Phemex-native base symbol for TradFi assets
// (per PILOT-ADAPTERS-W3A Plan-Mode semantic-fingerprint probe 2026-05-20).
// IMPORTANT: SPX intentionally NOT included — `SPXUSDT` on Phemex is the
// SPX6900 memecoin ($0.36 mark), NOT the S&P 500 index. `SP500USDT` IS the
// real S&P 500 ($7338 mark) — accessible via direct canonical key (no alias).
export const TRADFI_ALIASES: Record<string, string> = {
  GOLD:     'XAU',  // Phemex has XAU (real spot gold $4465); matches Gate canonical
  SILVER:   'XAG',
  PLATINUM: 'XPT',
  PALLADIUM:'XPD',
  NATGAS:   'NG',
  USOIL:    'CLO',  // Phemex uses CLO (oil/oil-spot prefix); Plan-Mode probe confirmed CLOUSDT exists
  // Stocks (TSLA/NVDA/META/GOOGL/AAPL/AMZN/COIN/MSTR/MSFT) + COPPER + VIX + SP500 route direct
};

export function toPhemexSymbol(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return mapped + 'USDT';
}

export function fromPhemexSymbol(symbol: string): string {
  const base = symbol.replace(/USDT$/, '');
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native === base) return canon;
  }
  return base;
}

async function phemexGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build unchanged; fetch/retry/ban via upstreamFetch.
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>({ ...VENUE_FETCH_CONFIGS.PHEMEX, transientRetries: retries }, { url: url.toString() });
}

// ── Response shapes ──────────────────────────────────────────────────────

interface PhemexKlineEnvelope {
  code: number;
  msg: string;
  data: {
    total: number;
    rows: Array<[
      number, // 0: timestamp (seconds since epoch)
      number, // 1: interval (seconds)
      string, // 2: last_close (previous bar's close — used for delta calc; NOT this bar's open)
      string, // 3: open
      string, // 4: high
      string, // 5: low
      string, // 6: close
      string, // 7: volume (in coin units)
      string, // 8: turnover (in USDT)
      string  // 9: symbol
    ]>;
  };
}

interface PhemexTickerEnvelope {
  error: { code: number; message: string } | null;
  id: number;
  result: {
    closeRp: string;          // last/close real price
    markPriceRp: string;      // mark real price
    indexPriceRp: string;     // index real price
    fundingRateRr: string;    // current funding real ratio (per 8h period)
    predFundingRateRr: string;// predicted next funding real ratio
    openInterestRv: string;   // OI in coin units (real value)
    openRp: string;           // 24h open real price
    highRp: string;           // 24h high real price
    lowRp: string;            // 24h low real price
    turnoverRv: string;       // 24h turnover in USDT (real value)
    volumeRq: string;         // 24h volume in coin units (real quantity)
    symbol: string;
    timestamp: number;
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class PhemexAdapter implements ExchangeAdapter {
  getName(): string {
    return 'Phemex';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = toPhemexSymbol(coin);
    const resolution = INTERVAL_MAP[interval] ?? 3600;

    const env = await phemexGet<PhemexKlineEnvelope>('/exchange/public/md/v2/kline/last', {
      symbol,
      resolution,
      limit: KLINE_LIMIT,
    });

    if (!env || env.code !== 0 || !env.data?.rows) {
      throw new Error(`Phemex: kline returned non-OK envelope (code=${env?.code} msg=${env?.msg})`);
    }

    // Phemex returns rows newest-first. Filter to >= startTime, sort oldest-first
    // (canonical Candle[] ordering across the adapter fleet).
    const startSec = Math.floor(startTime / 1000);
    return env.data.rows
      .filter(r => r[0] >= startSec)
      .map(r => ({
        time:   r[0] * 1000,    // seconds → ms
        open:   parseFloat(r[3]),
        high:   parseFloat(r[4]),
        low:    parseFloat(r[5]),
        close:  parseFloat(r[6]),
        volume: parseFloat(r[7]),
      }))
      .sort((a, b) => a.time - b.time);
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const symbol = toPhemexSymbol(coin);

    // Single all-in-one ticker call bundles funding + mark + index + OI + 24h ticker
    const env = await phemexGet<PhemexTickerEnvelope>('/md/v2/ticker/24hr', { symbol });
    const r = env?.result;
    if (env?.error || !r) {
      throw new Error(`Phemex: empty ticker payload for ${coin} (symbol=${symbol}) code=${env?.error?.code} msg=${env?.error?.message}`);
    }

    // Phemex funding is per-8h period (fundingInterval=28800s); annualize ×1095
    // (8h periods per year). Same as Binance/Bybit/Bitget/Gate/MEXC/KuCoin.
    const fundingRaw = parseFloat(r.fundingRateRr || '0');
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: parseFloat(r.openInterestRv || '0'),
      prevDayPx: parseFloat(r.openRp || r.closeRp || '0'),
      volume24h: parseFloat(r.turnoverRv || '0'),    // turnover is in USDT; canonical volume24h is quote-asset volume
      oraclePx: parseFloat(r.indexPriceRp || r.markPriceRp || '0'),
      markPx: parseFloat(r.markPriceRp || '0'),
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // Phemex has no working batch-tickers endpoint (probed 2026-05-20: both
    // /md/v2/ticker/24hr/all and /md/v3/ticker/24hr/all return empty data).
    // Per PILOT-ADAPTERS-W3A Plan-Mode Q-4: shadow venues return [] for
    // getPredictedFundings; cross-venue funding fanout fires only for
    // promoted venues. Follow-up wave wires per-canonical-universe funding
    // fetch when Phemex clears promotion gates.
    return [];
  }

  async getFundingHistory(_coin: string, _startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    // Phemex's public historical funding endpoint requires auth. Adapter
    // returns [] for shadow venue (callers fail-soft); promotion-ready
    // implementation can route via authenticated /api/funding-history/v2/list.
    return [];
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const symbol = toPhemexSymbol(coin);
      const env = await phemexGet<PhemexTickerEnvelope>('/md/v2/ticker/24hr', { symbol });
      const r = env?.result;
      if (!r || env?.error) return null;
      const px = parseFloat(r.markPriceRp);
      return Number.isFinite(px) ? px : null;
    } catch {
      return null;
    }
  }
}
