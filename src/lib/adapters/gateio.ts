/**
 * Gate.io adapter — implements ExchangeAdapter for Gate.io USDT-M Futures.
 *
 * Gate.io (`api.gateio.ws/api/v4/futures/usdt/*`) uses a custom REST envelope
 * (not Binance-clone). Per PILOT-ADAPTERS-W2 Plan-Mode probe 2026-05-19:
 *   - 719 USDT perps (including 26 TradFi symbols).
 *   - Funding cadence 8h (×1095 annualization, matches Binance/Bybit/Bitget).
 *   - Symbol convention: `<COIN>_USDT` (underscore separator).
 *   - All-in-one ticker endpoint `/api/v4/futures/usdt/tickers?contract=<sym>`
 *     bundles funding + mark + index + OI (`total_size`) + 24h ticker —
 *     single REST call for `getAssetContext`.
 *   - Candle response is row-wise with field names `o/h/l/c/v/sum/t` (NOT
 *     Binance-style array-of-arrays).
 *
 * Status: shadow (PILOT-ADAPTERS-W2 / C1, 2026-05-19).
 *
 * TradFi alias map (6 entries) — gold/silver/platinum/palladium/copper/natgas
 * route through `TRADFI_ALIASES` to Gate.io's native symbol names. Stocks +
 * ETFs + VIX route direct. SPX intentionally NOT aliased — `SPX_USDT` on
 * Gate.io is the SPX6900 memecoin ($0.37), NOT S&P 500 ($7000+). Verified
 * via semantic-fingerprint price-probe per TRADFI-SYMBOL-ALIAS-W1 skill.
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

const BASE_URL = 'https://api.gateio.ws';
const MAX_RETRIES = 1;

// Gate.io kline intervals: '10s', '1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d', '7d', '30d'
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '4h': '4h', '8h': '8h', '1d': '1d',
  // Gate.io does NOT support 3m, 2h, 12h — fall back to nearest available
  '3m': '5m', '2h': '1h', '12h': '8h',
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms Gate fetches for `tf`. 3m→5m (1.67×), 2h→1h/12h→8h finer. */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP);

// AlgoVault-canonical → Gate.io-native base symbol for TradFi assets
// (per PILOT-ADAPTERS-W2 Plan-Mode semantic-fingerprint probe 2026-05-19).
// IMPORTANT: SPX intentionally NOT included — `SPX_USDT` on Gate.io is the
// SPX6900 memecoin ($0.37 mark), NOT the S&P 500 index. Same trap as
// TRADFI-SYMBOL-ALIAS-W1 caught for Binance.
export const TRADFI_ALIASES: Record<string, string> = {
  GOLD: 'XAU',         // Gate has both XAU + XAUT; prefer XAU spot (matches Binance canonical)
  SILVER: 'XAG',
  PLATINUM: 'XPT',
  PALLADIUM: 'XPD',
  COPPER: 'XCU',
  NATGAS: 'NG',
  // CL → CL (direct; Gate uses canonical CL_USDT for WTI crude)
  // Stocks (AMD/BABA/COST/CRWV/HIMS/INTC/LITE/LLY/MSFT/MU/NFLX/SNDK/TSM/USAR) + ETFs (EWJ/EWY) + VIX route direct
};

export function toGateSymbol(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return mapped + '_USDT';
}

export function fromGateSymbol(symbol: string): string {
  const base = symbol.replace(/_USDT$/, '');
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native === base) return canon;
  }
  return base;
}

async function gateGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build unchanged; fetch/retry/ban via upstreamFetch.
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  return upstreamFetch<T>({ ...VENUE_FETCH_CONFIGS.GATE, transientRetries: retries }, { url: url.toString() });
}

// ── Response shapes ──────────────────────────────────────────────────────

interface GateKline {
  o: string; h: string; l: string; c: string; v: number; sum: string; t: number;
}

interface GateTicker {
  contract: string;
  last: string;
  low_24h: string;
  high_24h: string;
  volume_24h: string;
  volume_24h_quote: string;
  volume_24h_base: string;
  change_percentage: string;
  funding_rate: string;
  funding_rate_indicative?: string;
  mark_price: string;
  index_price: string;
  total_size: string;       // OI in contracts
}

interface GateContract {
  name: string;
  type: string;
  mark_price: string;
  funding_rate: string;
  funding_interval: number;
  funding_next_apply: number;
}

// ── Adapter ──────────────────────────────────────────────────────────────

export class GateAdapter implements ExchangeAdapter {
  getName(): string {
    return 'Gate';
  }

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const contract = toGateSymbol(coin);
    const gateInterval = INTERVAL_MAP[interval] || '1h';

    const raw = await gateGet<GateKline[]>('/api/v4/futures/usdt/candlesticks', {
      contract,
      interval: gateInterval,
      from: Math.floor(startTime / 1000),    // Gate uses seconds, NOT milliseconds
      limit: 200,
    });

    return (raw || []).map(c => ({
      time: c.t * 1000,    // Gate returns seconds; AlgoVault canonical is ms
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: typeof c.v === 'number' ? c.v : parseFloat(String(c.v)),
    }));
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const contract = toGateSymbol(coin);

    // Single all-in-one ticker call bundles funding + mark + index + OI + 24h ticker
    const tickers = await gateGet<GateTicker[]>('/api/v4/futures/usdt/tickers', { contract });
    const t = tickers?.[0];
    // OPS-MCP-DEFENSE-IN-DEPTH-W1 R3 — row-identity assert (List-endpoint
    // single-entity-read rule; Bitget precedent). Gate's identity field is
    // `contract` (per-venue field divergence), NOT `symbol`. Subsumes the prior
    // empty-payload check (empty → `got none`).
    if (!t || t.contract !== contract) {
      throw new Error(`GATE_TICKER_CONTRACT_MISMATCH: requested ${contract}, got ${t?.contract ?? 'none'} from /api/v4/futures/usdt/tickers`);
    }

    // Gate funding is per-8h period (verified via Plan-Mode probe: funding_interval=28800s);
    // annualized = rate × 1095 (8h periods per year). Same as Binance/Bybit/Bitget.
    const fundingRaw = parseFloat(t.funding_rate || '0');
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: parseFloat(t.total_size || '0'),
      prevDayPx: parseFloat(t.last || '0') - parseFloat(t.last || '0') * (parseFloat(t.change_percentage || '0') / 100),
      volume24h: parseFloat(t.volume_24h_quote || '0'),
      oraclePx: parseFloat(t.index_price || t.mark_price || '0'),
      markPx: parseFloat(t.mark_price || '0'),
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // Gate.io contract list embeds funding_rate + funding_next_apply per contract.
    try {
      const contracts = await gateGet<GateContract[]>('/api/v4/futures/usdt/contracts');
      return (contracts || [])
        .filter(c => c.name && c.name.endsWith('_USDT'))
        .map(c => ({
          coin: fromGateSymbol(c.name),
          venues: [{
            venue: 'GatePerp',
            fundingRate: parseFloat(c.funding_rate || '0'),
            nextFundingTime: (c.funding_next_apply || 0) * 1000, // seconds → ms
          }],
        }));
    } catch {
      return [];
    }
  }

  async getFundingHistory(coin: string, startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const contract = toGateSymbol(coin);
      const raw = await gateGet<Array<{ t: number; r: string }>>('/api/v4/futures/usdt/funding_rate', {
        contract,
        limit: 1000,
      });
      return (raw || [])
        .filter(r => r.r != null && !isNaN(parseFloat(r.r)))
        .map(r => ({
          time: r.t * 1000,
          fundingRate: parseFloat(r.r),
        }))
        .filter(r => r.time >= startTime);
    } catch {
      return [];
    }
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const contract = toGateSymbol(coin);
      const tickers = await gateGet<GateTicker[]>('/api/v4/futures/usdt/tickers', { contract });
      const t = tickers?.[0];
      // OPS-MCP-DEFENSE-IN-DEPTH-W1 R3 — same contract-identity assert; the throw
      // is caught below → null (fail-soft preserved, wrong-contract price can't leak).
      if (!t || t.contract !== contract) {
        throw new Error(`GATE_TICKER_CONTRACT_MISMATCH: requested ${contract}, got ${t?.contract ?? 'none'} from /api/v4/futures/usdt/tickers`);
      }
      return parseFloat(t.mark_price);
    } catch {
      return null;
    }
  }
}
