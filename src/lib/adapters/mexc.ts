/**
 * MEXC adapter — implements ExchangeAdapter for MEXC USDT-M Futures.
 *
 * MEXC (`contract.mexc.com/api/v1/contract/*`) uses MEXC's custom response
 * shapes. Per PILOT-ADAPTERS-W2 Plan-Mode probe 2026-05-19:
 *   - 881 USDT perps (15 TradFi symbols).
 *   - Funding cadence 8h (×1095 annualization, matches Binance/Bybit/Bitget).
 *   - Symbol convention: `<COIN>_USDT` (underscore separator — same as Gate).
 *   - All-in-one ticker endpoint `/api/v1/contract/ticker?symbol=<sym>`
 *     bundles `lastPrice + indexPrice + fairPrice (mark) + holdVol (OI) +
 *     fundingRate + volume24 + amount24 + high24Price + lower24Price`.
 *   - **Candle response is COLUMN-WISE** (unique among the 3 CEXes in this
 *     wave): `{success, code:0, data:{time:[], open:[], high:[], low:[],
 *     close:[], vol:[], amount:[]}}` — adapter zips into row-wise Candle[].
 *   - OI lives in ticker as `holdVol`. The dedicated
 *     `/api/v1/contract/open_interest/<sym>` endpoint returns Akamai 403.
 *   - Kline interval strings: `Min1`, `Min5`, `Min15`, `Min30`, `Min60`,
 *     `Hour4`, `Hour8`, `Day1`, `Week1`, `Month1`.
 *
 * Status: shadow (PILOT-ADAPTERS-W2 / C2, 2026-05-19).
 *
 * TRADFI_ALIASES map (4 entries) — GOLD→XAUT (MEXC has only XAUT, not XAU;
 * price-probe confirmed gold-tracking at $4546 vs Gate's XAU $4555 → 0.20%
 * Tether redemption spread within tolerance per `semantic-fingerprint-probe-
 * before-alias-commit` skill). CL→USOIL + BRENTOIL→UKOIL for MEXC's
 * descriptive oil names. PLATINUM→XPT + PALLADIUM→XPD for canonical CEX
 * metal symbols. SILVER/COPPER/EUR/GBP/JPY/JP225/EWJ/EWY/XLE route DIRECT
 * (MEXC uses literal canonical names for these). SPX intentionally NOT
 * aliased — price probe inconclusive on MEXC; safer to skip.
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

const BASE_URL = 'https://contract.mexc.com';
const MAX_RETRIES = 1;

// MEXC kline intervals: Min1, Min5, Min15, Min30, Min60, Hour4, Hour8, Day1, Week1, Month1
const INTERVAL_MAP: Record<string, string> = {
  '1m':  'Min1',
  '5m':  'Min5',
  '15m': 'Min15',
  '30m': 'Min30',
  '1h':  'Min60',
  '4h':  'Hour4',
  '8h':  'Hour8',
  '1d':  'Day1',
  // MEXC does NOT support 3m, 2h, 12h — fall back to nearest available
  '3m':  'Min5',
  '2h':  'Min60',
  '12h': 'Hour8',
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms MEXC fetches for `tf` (MinN/HourN/DayN). 3m→5m (1.67×), 2h/12h finer. */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP);

// AlgoVault-canonical → MEXC-native base symbol for TradFi assets
// (per PILOT-ADAPTERS-W2 Plan-Mode semantic-fingerprint probe 2026-05-19).
// MEXC uses descriptive English names for some TradFi (SILVER, COPPER,
// USOIL, UKOIL) instead of CEX-standard XAG/XCU/CL/BRENT.
export const TRADFI_ALIASES: Record<string, string> = {
  GOLD: 'XAUT',         // MEXC has ONLY XAUT (Tether Gold); price-probe $4546 ≈ gold spot $4555
  CL: 'USOIL',          // canonical CL (WTI crude) → MEXC's USOIL_USDT
  BRENTOIL: 'UKOIL',    // canonical BRENTOIL → MEXC's UKOIL_USDT
  PLATINUM: 'XPT',
  PALLADIUM: 'XPD',
  // SILVER → SILVER (direct; MEXC uses literal canonical name)
  // COPPER → COPPER (direct; MEXC uses literal canonical name)
  // FX: EUR, GBP, JPY direct
  // JP225, EWJ, EWY, XLE direct
  // SPX intentionally NOT mapped — price probe inconclusive (MEXC may have memecoin or delisted)
};

export function toMexcSymbol(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return mapped + '_USDT';
}

export function fromMexcSymbol(symbol: string): string {
  const base = symbol.replace(/_USDT$/, '');
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native === base) return canon;
  }
  return base;
}

async function mexcGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build unchanged; fetch/retry/ban via upstreamFetch.
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>({ ...VENUE_FETCH_CONFIGS.MEXC, transientRetries: retries }, { url: url.toString() });
}

// ── Response shapes ──────────────────────────────────────────────────────

interface MexcKlineColumnar {
  success: boolean;
  code: number;
  data: {
    time: number[];
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    vol: number[];
    amount: number[];
  };
}

interface MexcTicker {
  success: boolean;
  code: number;
  data: {
    symbol: string;
    lastPrice: number;
    indexPrice: number;
    fairPrice: number;       // == mark price on MEXC
    holdVol: number;         // open interest (in quote)
    fundingRate: number;
    volume24: number;        // base volume
    amount24: number;        // quote volume
    high24Price: number;
    lower24Price: number;
    riseFallRate?: number;   // 24h change as a FRACTION (-0.0074 = -0.74%); present live, absent from prior interface
  };
}

interface MexcContract {
  symbol: string;
  settleCoin: string;
  contractSize: number;
  fundingRate: number | null;
  nextFundingRateTime: number | null;
}

interface MexcFundingRate {
  success: boolean;
  code: number;
  data: {
    symbol: string;
    fundingRate: number;
    nextSettleTime: number;
    collectCycle: number;
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class MEXCAdapter implements ExchangeAdapter {
  getName(): string {
    return 'MEXC';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const symbol = toMexcSymbol(coin);
    const mexcInterval = INTERVAL_MAP[interval] || 'Min60';
    // MEXC uses seconds-since-epoch for start/end query params (not ms).
    const startSec = Math.floor(startTime / 1000);
    const endSec = Math.floor(Date.now() / 1000);

    const raw = await mexcGet<MexcKlineColumnar>(`/api/v1/contract/kline/${symbol}`, {
      interval: mexcInterval,
      start: startSec,
      end: endSec,
    });

    // Column-wise → row-wise transpose.
    const data = raw?.data;
    if (!data || !data.time || data.time.length === 0) return [];
    const candles: Candle[] = [];
    for (let i = 0; i < data.time.length; i++) {
      candles.push({
        time: data.time[i] * 1000,    // MEXC returns seconds; convert to ms
        open: data.open[i],
        high: data.high[i],
        low: data.low[i],
        close: data.close[i],
        volume: data.vol[i],
      });
    }
    return candles;
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const symbol = toMexcSymbol(coin);
    const raw = await mexcGet<MexcTicker>('/api/v1/contract/ticker', { symbol });
    const t = raw?.data;
    if (!t) {
      throw new Error(`MEXC: empty ticker payload for ${coin} (symbol=${symbol})`);
    }

    // MEXC funding is per-8h period (verified via Plan-Mode probe:
    // collectCycle=8); annualized = rate × 1095 (8h periods per year).
    const fundingRaw = Number(t.fundingRate) || 0;
    // MEXC's live /contract/ticker includes riseFallRate (24h change as a FRACTION,
    // -0.0074 = -0.74%; verified live 2026-06-11) — reconstruct the 24h-open from it
    // instead of lower24Price, which biased priceChange almost-always positive.
    const prevDayPx = reconstructPrevDayOpen(
      Number(t.lastPrice),
      t.riseFallRate ?? NaN,
      Number(t.high24Price),
      Number(t.lower24Price),
    );
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: Number(t.holdVol) || 0,
      prevDayPx,
      volume24h: Number(t.amount24) || 0,
      oraclePx: Number(t.indexPrice) || Number(t.fairPrice) || 0,
      markPx: Number(t.fairPrice) || 0,
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    try {
      const raw = await mexcGet<{ success: boolean; code: number; data: MexcContract[] }>('/api/v1/contract/detail');
      const contracts = raw?.data || [];
      return contracts
        .filter(c => c.symbol && c.symbol.endsWith('_USDT') && c.fundingRate != null)
        .map(c => ({
          coin: fromMexcSymbol(c.symbol),
          venues: [{
            venue: 'MEXCPerp',
            fundingRate: Number(c.fundingRate) || 0,
            nextFundingTime: c.nextFundingRateTime || 0,
          }],
        }));
    } catch {
      return [];
    }
  }

  async getFundingHistory(coin: string, startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const symbol = toMexcSymbol(coin);
      // MEXC funding rate endpoint returns CURRENT only (no history endpoint
      // surfaced in public docs). Return single-record sequence.
      const raw = await mexcGet<MexcFundingRate>(`/api/v1/contract/funding_rate/${symbol}`);
      const r = raw?.data;
      if (!r) return [];
      const time = r.nextSettleTime || Date.now();
      if (time < startTime) return [];
      return [{ time, fundingRate: Number(r.fundingRate) || 0 }];
    } catch {
      return [];
    }
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const symbol = toMexcSymbol(coin);
      const raw = await mexcGet<MexcTicker>('/api/v1/contract/ticker', { symbol });
      const t = raw?.data;
      if (!t) return null;
      return Number(t.fairPrice) || null;
    } catch {
      return null;
    }
  }
}
