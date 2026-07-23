/**
 * HTX (Huobi) adapter — implements ExchangeAdapter for HTX Linear USDT-Margined Swap.
 *
 * HTX (`api.hbdm.com/linear-swap-{api,ex}/*` — NOTE: derivatives use `hbdm.com`
 * host, NOT `htx.com` or `huobi.pro` which are spot/legacy). Per PILOT-
 * ADAPTERS-W3A Plan-Mode probe 2026-05-20:
 *   - 233 USDT swap perpetuals (.data[contract_status=1, business_type=swap]).
 *   - Funding cadence 8h × 1095 annualization (settlement_period:'8' verified).
 *   - Symbol convention: `<COIN>-USDT` (HYPHEN separator; mirrors BingX
 *     pattern). Field name is `contract_code` (not `symbol`).
 *   - **3-call fan-out for getAssetContext** via Promise.all: `/linear-swap-
 *     ex/market/detail/merged` (24h ticker: close + high + low + vol +
 *     trade_turnover) + `/linear-swap-api/v1/swap_funding_rate` (funding) +
 *     `/linear-swap-api/v1/swap_open_interest` (OI in coin/contract/USDT
 *     units). Different shape from BingX but same Promise.all pattern.
 *   - Kline period: string family (`1min`, `5min`, `15min`, `30min`, `60min`,
 *     `4hour`, `1day`, `1week`, `1mon`). Kline size: normal integer range
 *     (probed accepts up to ≥2000).
 *   - All JSON fields are direct numbers/strings (no scaling, no encoding).
 *   - Rate limit: 800 req/sec per-IP for market data — most generous of W3A
 *     batch; retry budget rarely fires.
 *
 * Status: shadow (PILOT-ADAPTERS-W3A / C3, 2026-05-20).
 *
 * TRADFI_ALIASES map (4 entries) — HTX has 15 TradFi listings (most after
 * Phemex's 19). GOLD→XAU (HTX has BOTH XAU and XAUT; prefer XAU spot,
 * matches Gate canonical), SILVER→XAG, PLATINUM→XPT, PALLADIUM→XPD.
 * NATGAS / BRENTOIL / USOIL / COPPER + 5 stocks (META/NVDA/MSFT/GOOGL/AAPL)
 * route DIRECT (HTX uses literal canonical names). SPX intentionally NOT
 * aliased — HTX `SPX-USDT` = $0.36 SPX6900 memecoin per semantic-fingerprint
 * probe 2026-05-20 (4th sighting affirmation). HTX does NOT list a real S&P
 * 500 perp (only Phemex does, among W3A venues).
 *
 * getPredictedFundings + getFundingHistory: return [] for shadow venue per
 * W3A Plan-Mode Q-4 — cross-venue funding fanout fires only for promoted
 * venues; HTX historical funding endpoint is auth-gated.
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

const BASE_URL = 'https://api.hbdm.com';
const MAX_RETRIES = 1;
const KLINE_SIZE = 1000;

// HTX kline period (string family with "min"/"hour"/"day" suffixes — DIFFERENT
// from BingX's `1m`/`1h` AND Phemex's integer seconds AND MEXC's `Min1`/`Hour4`).
const INTERVAL_MAP: Record<string, string> = {
  '1m':   '1min',
  '5m':   '5min',
  '15m':  '15min',
  '30m':  '30min',
  '1h':   '60min',
  '4h':   '4hour',
  '1d':   '1day',
  // HTX does NOT support 3m, 2h, 8h, 12h — fall back to nearest available
  '3m':   '5min',
  '2h':   '60min',
  '8h':   '4hour',
  '12h':  '4hour',
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms HTX fetches for `tf` (Nmin/Nhour/Nday). 3m→5m (1.67×), rest finer. */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP);

// AlgoVault-canonical → HTX-native base symbol for TradFi.
// Per PILOT-ADAPTERS-W3A Plan-Mode probe 2026-05-20: HTX lists META, USOIL,
// COPPER, NVDA, XAUT, BRENTOIL, SPX, NATGAS, MSFT, XPD, XPT, GOOGL, AAPL,
// XAU, XAG. SPX intentionally NOT aliased (SPX6900 memecoin trap).
export const TRADFI_ALIASES: Record<string, string> = {
  GOLD:     'XAU',   // HTX has BOTH XAU + XAUT; prefer XAU spot (mirrors Gate canonical)
  SILVER:   'XAG',
  PLATINUM: 'XPT',
  PALLADIUM:'XPD',
  // BRENTOIL → BRENTOIL (direct; HTX uses literal canonical name)
  // USOIL → USOIL (direct)
  // NATGAS → NATGAS (direct)
  // COPPER → COPPER (direct)
  // Stocks (META, NVDA, MSFT, GOOGL, AAPL) route direct
};

export function toHtxSymbol(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return mapped + '-USDT';
}

export function fromHtxSymbol(symbol: string): string {
  const base = symbol.replace(/-USDT$/, '');
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native === base) return canon;
  }
  return base;
}

async function htxGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build unchanged; fetch/retry/ban via upstreamFetch.
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>({ ...VENUE_FETCH_CONFIGS.HTX, transientRetries: retries }, { url: url.toString() });
}

// ── Response shapes ──────────────────────────────────────────────────────

interface HtxKlineEnvelope {
  ch: string;
  ts: number;
  status: string;
  data: Array<{
    id: number;          // unix SECONDS (NOT ms)
    open: number;
    close: number;
    high: number;
    low: number;
    amount: number;      // 24h base-asset amount
    vol: number;         // contract count (= amount × 1/contract_size)
    trade_turnover: number;  // USDT
    count: number;
  }>;
}

interface HtxMergedTickerEnvelope {
  ch: string;
  status: string;
  tick: {
    amount: string;
    ask: [number, number];
    bid: [number, number];
    close: string;
    count: number;
    high: string;
    id: number;
    low: string;
    open: string;
    trade_turnover: string;
    ts: number;
    vol: string;
  };
  ts: number;
}

interface HtxFundingRateEnvelope {
  status: string;
  data: {
    estimated_rate: string | null;
    funding_rate: string;
    contract_code: string;
    symbol: string;
    fee_asset: string;
    funding_time: string;
    next_funding_time: string | null;
    trade_partition: string;
  };
  ts: number;
}

interface HtxOpenInterestEnvelope {
  status: string;
  data: Array<{
    volume: number;            // contracts
    amount: number;            // OI in coin units
    symbol: string;
    value: number;             // OI in USDT
    contract_code: string;
    trade_amount: number;
    trade_volume: number;
    trade_turnover: number;
    business_type: string;
    pair: string;
    contract_type: string;
    trade_partition: string;
  }>;
  ts: number;
}

interface HtxContractInfoEnvelope {
  status: string;
  data: Array<{
    symbol: string;
    contract_code: string;
    contract_size: number;
    price_tick: number;
    contract_status: number;
    business_type: string;
    pair: string;
    contract_type: string;
    settlement_period: string;
  }>;
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class HTXAdapter implements ExchangeAdapter {
  getName(): string {
    return 'HTX';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const contractCode = toHtxSymbol(coin);
    const period = INTERVAL_MAP[interval] || '60min';

    const env = await htxGet<HtxKlineEnvelope>('/linear-swap-ex/market/history/kline', {
      contract_code: contractCode,
      period,
      size: KLINE_SIZE,
    });

    if (!env || env.status !== 'ok' || !Array.isArray(env.data)) {
      throw new Error(`HTX: kline returned non-OK envelope (status=${env?.status})`);
    }

    // HTX returns oldest-first OR newest-first depending on size? Probe shows
    // newest-first. Filter by startTime (sec compare) + sort oldest-first.
    const startSec = Math.floor(startTime / 1000);
    return env.data
      .filter(r => r.id >= startSec)
      .map(r => ({
        time: r.id * 1000,    // HTX id is unix seconds; convert to ms
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.amount,    // base-asset volume; vol is contract count
      }))
      .sort((a, b) => a.time - b.time);
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const contractCode = toHtxSymbol(coin);

    // 3-call fan-out: merged ticker (close + 24h vol + open + high + low) +
    // funding rate + open interest. Different endpoint paths from BingX but
    // same Promise.all pattern.
    const [merged, funding, oi] = await Promise.all([
      htxGet<HtxMergedTickerEnvelope>('/linear-swap-ex/market/detail/merged', { contract_code: contractCode }),
      htxGet<HtxFundingRateEnvelope>('/linear-swap-api/v1/swap_funding_rate', { contract_code: contractCode }),
      htxGet<HtxOpenInterestEnvelope>('/linear-swap-api/v1/swap_open_interest', { contract_code: contractCode }),
    ]);

    if (!merged?.tick || !funding?.data) {
      throw new Error(`HTX: empty ticker/funding payload for ${coin} (contract_code=${contractCode}) merged.status=${merged?.status} funding.status=${funding?.status}`);
    }

    // HTX funding cadence is 8h (settlement_period verified live); annualized
    // = rate × 1095 (8h periods per year). Same as all other CEXes.
    const fundingRaw = parseFloat(funding.data.funding_rate || '0');
    const oiUsdt = oi?.data?.[0]?.value ?? 0;
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: oiUsdt,
      prevDayPx: parseFloat(merged.tick.open || '0'),    // 24h open
      volume24h: parseFloat(merged.tick.trade_turnover || '0'),    // USDT 24h vol
      oraclePx: parseFloat(merged.tick.close || '0'),    // HTX merged endpoint doesn't expose explicit index price; use close as proxy
      markPx: parseFloat(merged.tick.close || '0'),      // HTX `close` is last trade price; treated as mark for shadow venue
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // HTX shadow venue returns [] per PILOT-ADAPTERS-W3A Plan-Mode Q-4:
    // cross-venue funding fanout fires only for promoted venues. Follow-up
    // wave wires per-canonical-universe funding fetch via parallel
    // `/linear-swap-api/v1/swap_funding_rate` calls (HTX 800req/s rate-limit
    // accommodates this).
    return [];
  }

  async getFundingHistory(_coin: string, _startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    // HTX's historical funding endpoint requires authenticated requests.
    // Shadow venue adapter returns []; promotion-ready implementation can
    // route via `/linear-swap-api/v3/swap_historical_funding_rate` with HMAC.
    return [];
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const contractCode = toHtxSymbol(coin);
      const env = await htxGet<HtxMergedTickerEnvelope>('/linear-swap-ex/market/detail/merged', { contract_code: contractCode });
      if (!env?.tick) return null;
      const px = parseFloat(env.tick.close);
      return Number.isFinite(px) ? px : null;
    } catch {
      return null;
    }
  }
}

// Quiet TS6133 — HtxContractInfoEnvelope is reserved for future getInstruments
// helper (e.g. when HTX clears promotion gate + getPredictedFundings expands).
export type { HtxContractInfoEnvelope };
