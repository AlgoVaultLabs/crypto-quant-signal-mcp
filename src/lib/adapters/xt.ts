/**
 * XT.COM adapter — PILOT-ADAPTERS-W3B C3, 2026-05-20.
 *
 * XT.COM (fapi.xt.com/future/market/v1/public/*). Per Plan-Mode probe 2026-05-20:
 *   - 893 PERPETUAL contracts (943 total — 47 CURRENT_QUARTER + 3 NEXT_QUARTER
 *     dated futures filtered out via contractType==PERPETUAL).
 *   - Symbol convention: `<coin>_<quote>` lowercase + underscore (UNIQUE).
 *   - Funding cadence 8h × 1095 (collectionInternal=8 verified).
 *   - HTTPS confirmed; HTTP redirects 301 (NOT HALT-class).
 *   - **Live API path `/future/market/v1/public/...` (NOT spec's
 *     `/future/api/v1/public/...` which returns placeholder `{result:
 *     {openapiDocs: "https://doc.xt.com"}}`).**
 *   - 2ND venue after Phemex with REAL S&P 500 perp (`sp500_usdt` = $7400.11
 *     live-verified). venue-coverage.ts SP500 row extended in same commit:
 *     `['HL', 'PHEMEX']` → `['HL', 'PHEMEX', 'XT']`.
 *   - Agg-ticker `/q/agg-ticker` bundles mark + index + last + bid + ask in
 *     single call (`{t,s,c,h,l,a,v,o,r, i (index), m (mark), bp, ap}`).
 *   - Funding `/q/funding-rate?symbol=` returns `{symbol, fundingRate,
 *     nextCollectionTime (ms), collectionInternal: 8}`.
 *   - Kline `/q/kline?symbol=&interval=1h&limit=N` returns
 *     `result: [{s, p, t (ms), o, c, h, l, a (base vol), v (quote vol)}]`.
 *   - OI endpoint NOT FOUND at `/q/open-interest` (404); adapter uses 0.
 *
 * TRADFI_ALIASES (3): PLATINUM→xpt, PALLADIUM→xpd, USOIL→cl. XT lists
 * gold_usdt/silver_usdt/sp500_usdt/natgas_usdt/copper_usdt/mstr_usdt/msft_usdt
 * DIRECT via identity-lowercase. SPX intentionally NOT aliased (memecoin trap
 * 7th sighting; spx_usdt = $0.37 verified).
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

const BASE_URL = 'https://fapi.xt.com';
const MAX_RETRIES = 1;
const KLINE_LIMIT = 1000;

const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '1d': '1d',
  '3m': '5m', '2h': '1h', '8h': '4h', '12h': '4h',
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms XT fetches for `tf` (single-derivation from INTERVAL_MAP). */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP);

// XT.COM uses lowercase + underscore. Stocks/commodities route DIRECT via
// identity-lowercase. Only 3 aliases needed (where XT uses cryptic ticker).
export const TRADFI_ALIASES: Record<string, string> = {
  PLATINUM: 'xpt',
  PALLADIUM: 'xpd',
  USOIL: 'cl',
};

export function toXtSymbol(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return mapped.toLowerCase() + '_usdt';
}

export function fromXtSymbol(symbol: string): string {
  const base = symbol.replace(/_usdt$/, '').toLowerCase();
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native.toLowerCase() === base) return canon;
  }
  return base.toUpperCase();
}

async function xtGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build unchanged; fetch/retry/ban via upstreamFetch.
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>({ ...VENUE_FETCH_CONFIGS.XT, transientRetries: retries }, { url: url.toString() });
}

// ── Response shapes ──────────────────────────────────────────────────────

interface XtEnvelope<T> {
  returnCode: number;
  msgInfo: string;
  error: { code: string; msg: string } | null;
  result: T;
}

interface XtKlineRow {
  s: string;
  p: string;
  t: number;   // ms
  o: string;
  c: string;
  h: string;
  l: string;
  a: string;   // base volume
  v: string;   // quote volume
}

interface XtAggTicker {
  t: number;   // ms
  s: string;
  c: string;   // last/close
  h: string;
  l: string;
  a: string;
  v: string;
  o: string;
  r: string;   // price change ratio
  i: string;   // index price
  m: string;   // mark price
  bp: string;  // bid
  ap: string;  // ask
}

interface XtFundingRate {
  symbol: string;
  fundingRate: number;
  nextCollectionTime: number;
  collectionInternal: number;
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class XtAdapter implements ExchangeAdapter {
  getName(): string { return 'XT'; }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = toXtSymbol(coin);
    const xtInterval = INTERVAL_MAP[interval] || '1h';

    const env = await xtGet<XtEnvelope<XtKlineRow[]>>('/future/market/v1/public/q/kline', {
      symbol,
      interval: xtInterval,
      limit: KLINE_LIMIT,
    });

    if (!env || env.returnCode !== 0 || !Array.isArray(env.result)) {
      throw new Error(`XT: kline returned non-OK envelope (returnCode=${env?.returnCode} msg=${env?.msgInfo})`);
    }

    return env.result
      .filter(r => r.t >= startTime)
      .map(r => ({
        time: r.t,   // already ms
        open: parseFloat(r.o),
        high: parseFloat(r.h),
        low: parseFloat(r.l),
        close: parseFloat(r.c),
        volume: parseFloat(r.a),   // base volume
      }))
      .sort((a, b) => a.time - b.time);
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const symbol = toXtSymbol(coin);

    // 2-call fan-out: agg-ticker (bundles mark+index+last+24h) + funding-rate
    // (separate endpoint). OI endpoint not surfaced (404); openInterest=0.
    const [tickerEnv, fundingEnv] = await Promise.all([
      xtGet<XtEnvelope<XtAggTicker>>('/future/market/v1/public/q/agg-ticker', { symbol }),
      xtGet<XtEnvelope<XtFundingRate>>('/future/market/v1/public/q/funding-rate', { symbol }),
    ]);

    if (!tickerEnv?.result || !fundingEnv?.result) {
      throw new Error(`XT: empty ticker/funding payload for ${coin} (symbol=${symbol})`);
    }

    const t = tickerEnv.result;
    const f = fundingEnv.result;
    // XT funding cadence 8h × 1095 (collectionInternal=8 verified).
    const fundingRaw = Number(f.fundingRate) || 0;
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: 0,    // XT OI endpoint not surfaced — adapter fail-soft per W3B Q-3 pattern
      prevDayPx: parseFloat(t.o || '0'),    // 24h open
      volume24h: parseFloat(t.v || '0'),
      oraclePx: parseFloat(t.i || t.m || '0'),
      markPx: parseFloat(t.m || '0'),
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // Shadow venue [] per W3B Q-3.
    return [];
  }

  async getFundingHistory(coin: string, _startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const symbol = toXtSymbol(coin);
      const env = await xtGet<XtEnvelope<XtFundingRate>>('/future/market/v1/public/q/funding-rate', { symbol });
      if (!env?.result) return [];
      const time = env.result.nextCollectionTime || Date.now();
      const rate = Number(env.result.fundingRate) || 0;
      return [{ time, fundingRate: rate }];
    } catch {
      return [];
    }
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const symbol = toXtSymbol(coin);
      const env = await xtGet<XtEnvelope<XtAggTicker>>('/future/market/v1/public/q/agg-ticker', { symbol });
      if (!env?.result?.m) return null;
      const px = parseFloat(env.result.m);
      return Number.isFinite(px) && px > 0 ? px : null;
    } catch {
      return null;
    }
  }
}
