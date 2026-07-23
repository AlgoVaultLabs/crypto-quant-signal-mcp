/**
 * KuCoin Futures adapter — implements ExchangeAdapter for KuCoin USDT-M perp.
 *
 * KuCoin (`api-futures.kucoin.com/api/v1/*`) is the most divergent of the 3
 * W2 CEXes. Per PILOT-ADAPTERS-W2 Plan-Mode probe 2026-05-19:
 *   - 594 active USDT-margined perps (36 TradFi symbols).
 *   - Funding cadence 8h (×1095 annualization, matches Binance/Gate/MEXC).
 *   - **Symbol convention: `<COIN>USDTM`** (M-suffix for USDT-margined) with
 *     **`BTC → XBT` override** (X-prefix replaces B per KuCoin tradition).
 *   - **`contracts/active` IS the all-in-one ticker** — instrument list AND
 *     per-contract live data (markPrice, openInterest, fundingFeeRate,
 *     nextFundingRateTime, daily ticker) all in ONE endpoint.
 *   - Kline `granularity` is INTEGER minutes (60 for 1h, 15 for 15m,
 *     1440 for 1d). NOT a string.
 *   - Candle response is row-wise array-of-arrays `[t, o, h, l, c, v]`.
 *
 * Status: shadow (PILOT-ADAPTERS-W2 / C3, 2026-05-19).
 *
 * TRADFI_ALIASES map (4 entries) — GOLD→XAUT (KuCoin has only XAUT, not XAU;
 * price-probe $4548 ≈ gold spot). SILVER→XAG, PLATINUM→XPT, PALLADIUM→XPD.
 * COPPER/CL/NATGAS + 26 stocks + EWJ/EWY/CRCL route DIRECT (KuCoin uses
 * literal canonical names). SPX intentionally OMITTED — SPXUSDTM is the
 * SPX6900 memecoin ($0.37) per semantic-fingerprint price-probe.
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

const BASE_URL = 'https://api-futures.kucoin.com';
const MAX_RETRIES = 1;

// KuCoin granularity is INTEGER minutes (60 = 1h, 1440 = 1d).
const INTERVAL_MAP: Record<string, number> = {
  '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30,
  '1h': 60, '2h': 120, '4h': 240, '8h': 480, '12h': 720, '1d': 1440,
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms KuCoin fetches for `tf` (INTERVAL_MAP is MINUTES; fully native). */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP, 'minutes');

// AlgoVault-canonical → KuCoin-native base symbol for TradFi assets.
// Per Plan-Mode probe rev 2 + semantic-fingerprint price-probe 2026-05-19.
export const TRADFI_ALIASES: Record<string, string> = {
  GOLD: 'XAUT',         // KuCoin has only XAUT (Tether Gold); $4548 ≈ gold spot
  SILVER: 'XAG',
  PLATINUM: 'XPT',
  PALLADIUM: 'XPD',
  // COPPER → COPPER (direct)
  // CL → CL (direct)
  // NATGAS → NATGAS (direct)
  // Stocks: AAPL/AMD/AMZN/BABA/COIN/COST/CRCL/CRWV/GOOGL/HIMS/HOOD/INTC/LITE/
  //         LLY/META/MSFT/MSTR/MU/NFLX/NVDA/ORCL/PLTR/SNDK/TSLA/TSM/USAR
  //         all direct
  // ETFs EWJ/EWY direct
  // SPX intentionally OMITTED — SPXUSDTM is SPX6900 memecoin ($0.37)
};

// KuCoin BTC uses X-prefix tradition (legacy from XBT spot convention)
const KUCOIN_SYMBOL_OVERRIDES: Record<string, string> = {
  BTC: 'XBT',
};

export function toKucoinSymbol(coin: string): string {
  // Resolution order: TRADFI alias > BTC X-prefix override > as-is, then add USDTM
  const base = TRADFI_ALIASES[coin] || KUCOIN_SYMBOL_OVERRIDES[coin] || coin;
  return base + 'USDTM';
}

export function fromKucoinSymbol(symbol: string): string {
  const base = symbol.replace(/USDTM$/, '');
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native === base) return canon;
  }
  for (const [canon, native] of Object.entries(KUCOIN_SYMBOL_OVERRIDES)) {
    if (native === base) return canon;
  }
  return base;
}

async function kucoinGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES, weightHint?: number): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build unchanged; fetch/retry/ban via upstreamFetch.
  // EDGE-CARRY-BACKFILL-W1: optional weightHint (the batch funding-history endpoint is weight 5).
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>(
    { ...VENUE_FETCH_CONFIGS.KUCOIN, transientRetries: retries },
    { url: url.toString(), ...(weightHint != null ? { weightHint } : {}) },
  );
}

// EDGE-CARRY-BACKFILL-W1 CH1 — public batch funding-history endpoint (verified DEEP from prod to ~2020-08).
interface KucoinFundingRateHistEntry {
  symbol: string;
  fundingRate: number; // already a numeric fraction (e.g. 5.1e-05)
  timepoint: number;   // ms epoch
}
interface KucoinFundingRatesEnvelope {
  code: string;
  data: KucoinFundingRateHistEntry[];
}

// ── Response shapes ──────────────────────────────────────────────────────

interface KucoinContract {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  settleCurrency: string;
  type: string;
  fundingFeeRate: number | null;
  predictedFundingFeeRate: number | null;
  nextFundingRateTime: number | null;
  openInterest: string;
  markPrice: number | null;
  indexPrice?: number;
  lastTradePrice?: number;
  multiplier: number;
  turnoverOf24h?: number;
  volumeOf24h?: number;
  highPrice?: number;
  lowPrice?: number;
  priceChgPct?: number | null;   // 24h change as a FRACTION (0.0055 = 0.55%); present live, absent from older docs
}

interface KucoinKlineEnvelope {
  code: string;
  data: Array<[number, number, number, number, number, number]>;
}

interface KucoinContractsListEnvelope {
  code: string;
  data: KucoinContract[];
}

interface KucoinSingleContractEnvelope {
  code: string;
  data: KucoinContract;
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class KuCoinAdapter implements ExchangeAdapter {
  getName(): string {
    return 'KuCoin';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = toKucoinSymbol(coin);
    const granularity = INTERVAL_MAP[interval] || 60;
    // KuCoin from/to in milliseconds.
    const from = startTime;
    const to = Date.now();

    const raw = await kucoinGet<KucoinKlineEnvelope>('/api/v1/kline/query', {
      symbol,
      granularity,
      from,
      to,
    });

    return (raw?.data || []).map(row => ({
      time: row[0],         // already ms
      open: row[1],
      high: row[2],
      low: row[3],
      close: row[4],
      volume: row[5],
    }));
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const symbol = toKucoinSymbol(coin);
    const raw = await kucoinGet<KucoinSingleContractEnvelope>(`/api/v1/contracts/${symbol}`);
    const c = raw?.data;
    if (!c) {
      throw new Error(`KuCoin: empty contract payload for ${coin} (symbol=${symbol})`);
    }

    // KuCoin funding cadence: 8h per Plan-Mode probe (granularity:28800000ms);
    // annualized = rate × 1095. openInterest in contracts × multiplier = base-asset OI.
    const fundingRaw = Number(c.fundingFeeRate) || 0;
    const oiContracts = parseFloat(c.openInterest || '0');
    const oiBase = oiContracts * (c.multiplier || 1);

    // KuCoin's live /contracts/{symbol} payload includes priceChgPct (24h change as
    // a FRACTION, 0.0055 = 0.55%; verified live 2026-06-11) — reconstruct the 24h-open
    // from it instead of lowPrice, which biased priceChange almost-always positive.
    const prevDayPx = reconstructPrevDayOpen(
      Number(c.lastTradePrice),
      c.priceChgPct ?? NaN,
      Number(c.highPrice),
      Number(c.lowPrice),
    );
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: oiBase,
      prevDayPx,
      volume24h: Number(c.turnoverOf24h) || 0,
      oraclePx: Number(c.indexPrice) || Number(c.markPrice) || 0,
      markPx: Number(c.markPrice) || 0,
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    try {
      const raw = await kucoinGet<KucoinContractsListEnvelope>('/api/v1/contracts/active');
      const contracts = raw?.data || [];
      return contracts
        .filter(c => c.symbol && c.symbol.endsWith('USDTM') && c.fundingFeeRate != null)
        .map(c => ({
          coin: fromKucoinSymbol(c.symbol),
          venues: [{
            venue: 'KuCoinPerp',
            fundingRate: Number(c.fundingFeeRate) || 0,
            // nextFundingRateTime on KuCoin is "ms until next funding" (relative);
            // convert to absolute timestamp at read time.
            nextFundingTime: c.nextFundingRateTime ? Date.now() + c.nextFundingRateTime : 0,
          }],
        }));
    } catch {
      return [];
    }
  }

  /**
   * Funding-rate HISTORY via the public batch endpoint `/api/v1/contract/funding-rates`
   * (EDGE-CARRY-BACKFILL-W1 CH1 prod-probe: DEEP to ~2020-08; ≤100 rows/call ≈ 33d, returns the
   * most-recent window within [from,to] → page BACKWARD via `to`; public weight 5). Replaces the
   * prior current-only impl — zero live consumers (the arb reads only HL's history), so the
   * behavior change is serving-safe. Returns [startTime, now] ASCENDING; best-effort (returns the
   * partial series on transport failure/ban — the shared transport NEVER retries a 418).
   */
  async getFundingHistory(coin: string, startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    const symbol = toKucoinSymbol(coin);
    const out: { time: number; fundingRate: number }[] = [];
    const seen = new Set<number>();
    let to = Date.now();
    const MAX_PAGES = 400; // safety cap (~36y at 33d/page) — real listings are < 7y
    for (let page = 0; page < MAX_PAGES; page++) {
      let data: KucoinFundingRateHistEntry[];
      try {
        const raw = await kucoinGet<KucoinFundingRatesEnvelope>(
          '/api/v1/contract/funding-rates',
          { symbol, from: startTime, to },
          MAX_RETRIES,
          5, // public weight 5
        );
        data = raw?.data ?? [];
      } catch {
        break; // best-effort — return what we already collected
      }
      if (data.length === 0) break;
      let minTs = Number.POSITIVE_INFINITY;
      for (const r of data) {
        const t = Number(r.timepoint);
        const rate = Number(r.fundingRate);
        if (!Number.isFinite(t) || !Number.isFinite(rate)) continue;
        if (t < minTs) minTs = t;
        if (t >= startTime && !seen.has(t)) {
          seen.add(t);
          out.push({ time: t, fundingRate: rate });
        }
      }
      if (!Number.isFinite(minTs) || minTs < startTime) break; // window covered
      if (minTs >= to) break; // no backward progress — guard against a stuck cursor
      to = minTs - 1; // page older
    }
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const symbol = toKucoinSymbol(coin);
      const raw = await kucoinGet<KucoinSingleContractEnvelope>(`/api/v1/contracts/${symbol}`);
      const c = raw?.data;
      if (!c) return null;
      return Number(c.markPrice) || null;
    } catch {
      return null;
    }
  }
}
