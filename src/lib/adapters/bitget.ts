/**
 * Bitget adapter — implements ExchangeAdapter for Bitget USDT-M Futures.
 * Base URL: https://api.bitget.com
 * All requests are public GET, no auth needed.
 * Rate limit: 20-50 req/sec.
 */
import type {
  ExchangeAdapter,
  Candle,
  AssetContext,
  FundingData,
  DexType,
} from '../../types.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS, safeUpstreamNum } from './_upstream-fetch.js';
import { makeServedIntervalMs } from '../served-interval.js';
import { assembleServingWindow, historyPageEnd, withHistoryMeta, type HistoryBranch } from './_history-plan.js';
import { SERVING_MAX_PAGES } from '../serving-windows.js';
import { resolveVenueInterval } from './_interval.js';

const BASE_URL = 'https://api.bitget.com';
const MAX_RETRIES = 1;

// AlgoVault-canonical → Bitget-native base symbol for TradFi assets where Bitget's
// listing uses a different ticker (e.g. GOLD trades as XAUUSDT on Bitget, not GOLDUSDT).
// Derived from live Bitget contracts probe (TRADFI-SYMBOL-ALIAS-W1, 2026-05-15).
// Symmetric reverse-map applied in fromBitgetSymbol.
const TRADFI_ALIASES: Record<string, string> = {
  GOLD: 'XAU',
  SILVER: 'XAG',
  PLATINUM: 'XPT',
  PALLADIUM: 'XPD',
};

export function toBitgetSymbol(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return mapped + 'USDT';
}

export function fromBitgetSymbol(symbol: string): string {
  const base = symbol.replace(/USDT$/, '');
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native === base) return canon;
  }
  return base;
}

// Map our intervals to Bitget granularity values
// Bitget uses: 1m,3m,5m,15m,30m,1H,4H,6H,12H,1D,1W,1M
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m',
  '30m': '30m', '1h': '1H', '2h': '1H', '4h': '4H',
  '8h': '6H', '12h': '12H', '1d': '1D',
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms Bitget fetches for `tf`. 2h→1H/8h→6H are FINER (faithful). */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP);

/** Page caps, named once: the request AND the contract/canary read these (never a third literal). The history
 *  endpoint refuses limit > 200 (code 40053, measured from two vantages 2026-09-29). */
export const RECENT_PAGE_CAP = 200;
export const HISTORY_PAGE_CAP = 200;

/**
 * OPS-SERVED-CANDLE-TRUTH-W1 CH1: `/market/candles` returns bars that open in [slot(startTime), startTime + 90 d) and
 * no later, measured from two vantages (fixtures MODEL-PROBES.json; R0 I4: `startTime = now − 100 d` 1D → 90 bars,
 * the newest 10.76 d old). A serving window longer than this ends early, so its head is completed by forward pages.
 */
export const RECENT_WINDOW_MS = 90 * 86_400_000;

/** The most served bars ONE serving request can hold on `tf` (null: Bitget does not map it). Suite S, the differential
 *  and the SERVING_MAX_PAGES derivation read this, never a literal. */
export function servingReachBars(tf: string): number | null {
  const s = servedIntervalMs(tf);
  return s == null ? null : Math.min(RECENT_PAGE_CAP, Math.floor(RECENT_WINDOW_MS / s));
}

// REQUESTED bar duration in ms — the recent-branch ROUTING guard's unit only (byte-identical to the pre-wave
// guard). History page spans use the SERVED step (servedIntervalMs), never this table.
const BAR_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
};

// SV-04: returns null for a candle whose OHLC does not parse strictly, so callers
// drop it rather than emit a NaN/wrong-but-finite price into the signal engine.
function mapBitgetCandle(c: string[]): Candle | null {
  const open = safeUpstreamNum(c[1]);
  const high = safeUpstreamNum(c[2]);
  const low = safeUpstreamNum(c[3]);
  const close = safeUpstreamNum(c[4]);
  if (open === null || high === null || low === null || close === null) return null;
  return {
    time: parseInt(c[0]),
    open, high, low, close,
    volume: parseFloat(c[5]),
  };
}

// ── Bitget response wrapper ──

interface BitgetResponse<T> {
  code: string;
  msg: string;
  data: T;
}

// ── Bitget response types ──

interface BitgetTicker {
  symbol: string;
  lastPr: string;
  markPrice: string;
  open24h: string;
  high24h: string;
  low24h: string;
  baseVolume: string;
  quoteVolume: string;
  fundingRate: string;
  nextFundingTime: string;
}

interface BitgetOpenInterest {
  openInterestList: Array<{ symbol: string; size: string }>;
  ts: string;
}

interface BitgetFundingRate {
  symbol: string;
  fundingRate: string;
}

interface BitgetFundingHistoryEntry {
  symbol: string;
  fundingRate: string;
  fundingTime: string;
}



async function bitgetGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: URL-build + '00000' code-envelope check unchanged;
  // fetch/retry/ban via upstreamFetch — incl. Bitget body-code throttles
  // 45001/40725/40808 (banBodyCodes), now typed + no-retry (were generic + retried).
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  const body = await upstreamFetch<BitgetResponse<T>>({ ...VENUE_FETCH_CONFIGS.BITGET, transientRetries: retries }, { url: url.toString() });
  if (body.code !== '00000') {
    throw new Error(`Bitget API error ${body.code}: ${body.msg}`);
  }
  return body.data;
}

export class BitgetAdapter implements ExchangeAdapter {
  getName(): string {
    return 'Bitget';
  }

  /**
   * OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2. Two branches, chosen by the data:
   *   R — the recent page (`/market/candles`), accepted by the routing guard below. Its request, its guard and
   *       its bars are BYTE-IDENTICAL to the pre-wave code (serving reads this branch); only `meta` is added.
   *   F — the history fallback (`/market/history-candles`). Its page is now anchored on the SERVED step: a page of
   *       HISTORY_PAGE_CAP served candles ends at `startTime + HISTORY_PAGE_CAP × servedStepMs`. The pre-wave code
   *       used the REQUESTED step, so on 2h (served 1H) and 8h (served 6H) the page ended past the window and
   *       left a 200-slot / 400-hour front gap (C1).
   * Every return carries a non-enumerable `meta` (`historyMetaOf(page)`, src/lib/adapters/_history-plan.ts):
   * front gap, holes, head gap, out-of-range bars against [startTime, endTime ?? now], and `substitutedNewest`
   * when the history page held nothing and the recent page is returned instead (OAH-Q5: reported, bars unchanged).
   * `endTime` only bounds the accounting window; it never changes the request or the bars.
   *
   * OPS-SERVED-CANDLE-TRUTH-W1 CH1, SERVING reads only (no `endTime`): a window the recent page cannot hold goes to the
   * serving assembler (`branch: 'A'`). Past the endpoint's 90-day reach (RECENT_WINDOW_MS) it gets forward pages on the
   * same endpoint; past one full page it gets backward pages on the history endpoint. A window inside the reach makes
   * no extra request and returns the R page unchanged. The `endTime` path is byte-identical (R0 P9 differential).
   */
  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType, endTime?: number): Promise<Candle[]> {
    const symbol = toBitgetSymbol(coin);
    const granularity = resolveVenueInterval(INTERVAL_MAP, interval, 'BITGET');
    // REQUESTED step: the routing guard's unit only (kept byte-identical — it decides which branch serving reads).
    const barMs = BAR_MS[interval]; // every mapped timeframe is a key (an unmapped one was refused above)
    // SERVED step: the module-local leaf (never tf-support — see _history-plan.ts). Every page span uses it.
    const servedStepMs = servedIntervalMs(interval) ?? barMs;
    const meta = (branch: HistoryBranch, substitutedNewest: boolean) =>
      ({ servedStepMs, from: startTime, to: endTime, nowMs: Date.now(), branch, substitutedNewest });

    // Recent path (live/indicator use): `/market/candles` returns ASCENDING
    // [ts, open, high, low, close, baseVol, quoteVol]; no reverse needed.
    const data = await bitgetGet<string[][]>('/api/v2/mix/market/candles', {
      productType: 'USDT-FUTURES',
      symbol,
      granularity,
      startTime,
      limit: RECENT_PAGE_CAP,
    });
    const recentRows = data || [];
    const candles = recentRows.flatMap(c => mapBitgetCandle(c) ?? []);
    const routedRecent = candles.length > 0 && candles[0].time <= startTime + 5 * barMs;

    // A SERVING read the recent page does not cover goes to the serving assembler:
    //   - head: a window running past the endpoint's 90-day reach got bars up to startTime + 90 d only (BITGET 1d@100
    //     ended ~10 days before now), so page FORWARD from the newest held bar (`startTime = newest + step`; measured
    //     R0 I4: the remaining 10 bars, the forming one included);
    //   - front: a FULL page the routing guard rejected means a window longer than one page, so page BACKWARD on
    //     `/market/history-candles` from the oldest held bar (`endTime` = its open: strictly older closed bars).
    // A young listing's page is not full. Whenever the history fallback's single page reaches the newest bar that page
    // holds (judged against the venue's own bar, never the local clock), it is head-complete and answers that read
    // below, byte-identical; a window inside the reach makes no extra request and keeps its R page unchanged.
    if (endTime === undefined && candles.length > 0) {
      const clipped = startTime + RECENT_WINDOW_MS <= Date.now();
      const full = recentRows.length >= (servingReachBars(interval) ?? RECENT_PAGE_CAP);
      const fallbackHoldsHead = historyPageEnd({ servedStepMs, from: startTime, pageCap: HISTORY_PAGE_CAP }) >= candles[candles.length - 1].time;
      if (routedRecent ? clipped : full || !fallbackHoldsHead) {
        const { bars, pages } = await assembleServingWindow({
          first: candles,
          servedStepMs,
          from: startTime,
          nowMs: Date.now(),
          maxPages: SERVING_MAX_PAGES,
          forward: clipped
            ? async (newestOpenMs) => {
              const rows = (await bitgetGet<string[][]>('/api/v2/mix/market/candles', {
                productType: 'USDT-FUTURES',
                symbol,
                granularity,
                startTime: newestOpenMs + servedStepMs,
                limit: RECENT_PAGE_CAP,
              })) || [];
              return { bars: rows.flatMap(c => mapBitgetCandle(c) ?? []), exhausted: rows.length === 0 };
            }
            : undefined,
          backward: !routedRecent && full
            ? async (oldestOpenMs) => {
              const rows = (await bitgetGet<string[][]>('/api/v2/mix/market/history-candles', {
                productType: 'USDT-FUTURES',
                symbol,
                granularity,
                endTime: oldestOpenMs,
                limit: HISTORY_PAGE_CAP,
              })) || [];
              return { bars: rows.flatMap(c => mapBitgetCandle(c) ?? []).filter(c => c.time >= startTime), exhausted: rows.length < HISTORY_PAGE_CAP };
            }
            : undefined,
        });
        if (pages > 1 || !routedRecent) return withHistoryMeta(bars, meta('A', false));
      }
    }

    // `/market/candles` only holds the recent window, so a HISTORICAL startTime yields the newest
    // bars instead of bars AT startTime (the labeler then filters them all → noKlines). Detect the
    // gap — the oldest returned bar should sit at ~startTime — and fall back to history-candles.
    // Recent requests satisfy the guard here and return the live path verbatim.
    if (routedRecent) {
      return withHistoryMeta(candles, meta('R', false));
    }

    // Historical fallback: `/market/history-candles` returns bars whose candle CLOSES at or before `endTime`,
    // ascending. Anchor the page on the served grid so it starts at `startTime` (C1).
    const pageEnd = historyPageEnd({ servedStepMs, from: startTime, pageCap: HISTORY_PAGE_CAP });
    const hist = await bitgetGet<string[][]>('/api/v2/mix/market/history-candles', {
      productType: 'USDT-FUTURES',
      symbol,
      granularity,
      endTime: pageEnd,
      limit: HISTORY_PAGE_CAP,
    });
    const histAsc = (hist || []).flatMap(c => mapBitgetCandle(c) ?? []).filter(c => c.time >= startTime);
    return histAsc.length > 0
      ? withHistoryMeta(histAsc, meta('F', false))
      : withHistoryMeta(candles, meta('F', candles.length > 0));
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const symbol = toBitgetSymbol(coin);

    // Parallel fetch: ticker + open interest + current funding rate.
    // OPS-BITGET-TICKER-SYMBOL-FILTER-W1 (2026-06-04): use the SINGULAR
    // /api/v2/mix/market/ticker — the PLURAL /tickers IGNORES `symbol` and
    // returns all ~595 contracts, so `[0]` was YGGUSDT for every coin (wrong
    // price/volume/prevDayPx). The singular endpoint honors `symbol`.
    const [tickersData, oiData, fundingData] = await Promise.all([
      bitgetGet<BitgetTicker[]>('/api/v2/mix/market/ticker', {
        productType: 'USDT-FUTURES',
        symbol,
      }),
      // Note: open-interest returns an OBJECT, not an array
      bitgetGet<BitgetOpenInterest>('/api/v2/mix/market/open-interest', {
        productType: 'USDT-FUTURES',
        symbol,
      }),
      bitgetGet<BitgetFundingRate[]>('/api/v2/mix/market/current-fund-rate', {
        productType: 'USDT-FUTURES',
        symbol,
      }),
    ]);

    const ticker = tickersData[0];
    // Default-deny on drift: never silently use a mismatched row (guards against
    // the endpoint changing behavior again).
    if (!ticker || ticker.symbol !== symbol) {
      throw new Error(`BITGET_TICKER_SYMBOL_MISMATCH: requested ${symbol}, got ${ticker?.symbol ?? 'none'} from /api/v2/mix/market/ticker`);
    }
    const fundingRate = fundingData[0]?.fundingRate || '0';
    const oiEntry = oiData.openInterestList?.[0];

    // R2: Bitget funding is per-8h period → annualized = raw × 1095 (8h periods/year)
    // SV-04: default-deny — an invalid markPrice throws (the 3-tier fallback fires)
    // rather than scoring a wrong-but-finite price; non-price fields fall back to a
    // safe neutral 0. Same contract as the aster adapter.
    const fundingRaw = safeUpstreamNum(fundingRate) ?? 0;
    const markPx = safeUpstreamNum(ticker.markPrice);
    if (markPx === null) throw new Error('Bitget getAssetContext: invalid markPrice');
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: safeUpstreamNum(oiEntry?.size) ?? 0,
      prevDayPx: safeUpstreamNum(ticker.open24h) ?? 0,
      volume24h: parseFloat(ticker.quoteVolume || '0'),
      oraclePx: markPx,
      markPx,
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // Fetch ALL tickers for USDT-FUTURES
    const data = await bitgetGet<BitgetTicker[]>('/api/v2/mix/market/tickers', {
      productType: 'USDT-FUTURES',
    });

    return (data || [])
      .filter(entry => entry.symbol.endsWith('USDT'))
      .map(entry => ({
        coin: fromBitgetSymbol(entry.symbol),
        venues: [{
          venue: 'BitgetPerp',
          fundingRate: safeUpstreamNum(entry.fundingRate) ?? 0,
          nextFundingTime: parseInt(entry.nextFundingTime || '0'),
        }],
      }));
  }

  async getFundingHistory(coin: string, _startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const symbol = toBitgetSymbol(coin);
      const data = await bitgetGet<BitgetFundingHistoryEntry[]>('/api/v2/mix/market/history-fund-rate', {
        productType: 'USDT-FUTURES',
        symbol,
        pageSize: 100,
      });

      return (data || [])
        .map(r => ({ time: parseInt(r.fundingTime), fundingRate: safeUpstreamNum(r.fundingRate) }))
        .filter((r): r is { time: number; fundingRate: number } => r.fundingRate !== null);
    } catch {
      return [];
    }
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const symbol = toBitgetSymbol(coin);
      // OPS-BITGET-TICKER-SYMBOL-FILTER-W1: singular /ticker (the plural ignores
      // `symbol` → `[0]`=YGGUSDT). Default-deny on a mismatched row.
      const data = await bitgetGet<BitgetTicker[]>('/api/v2/mix/market/ticker', {
        productType: 'USDT-FUTURES',
        symbol,
      });
      const ticker = data[0];
      if (!ticker || ticker.symbol !== symbol) {
        throw new Error(`BITGET_TICKER_SYMBOL_MISMATCH: requested ${symbol}, got ${ticker?.symbol ?? 'none'}`);
      }
      return safeUpstreamNum(ticker.markPrice);
    } catch {
      return null;
    }
  }
}
