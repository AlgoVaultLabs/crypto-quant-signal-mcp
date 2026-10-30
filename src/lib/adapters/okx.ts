/**
 * OKX adapter — implements ExchangeAdapter for OKX USDT-M Swaps.
 * Base URL: https://www.okx.com
 * All requests are public GET, no auth needed.
 * Rate limit: 10 req/sec — throttle enforced at 100ms between requests.
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

const BASE_URL = 'https://www.okx.com';
const MAX_RETRIES = 1;

// ── Symbol mapping ──

// AlgoVault-canonical → OKX-native base symbol for TradFi assets where OKX's
// listing uses a different ticker (e.g. GOLD trades as XAU-USDT-SWAP on OKX,
// COPPER as XCU-USDT-SWAP). Derived from live OKX instruments probe
// (TRADFI-SYMBOL-ALIAS-W1, 2026-05-15). Symmetric reverse-map in fromOKXInstId.
const TRADFI_ALIASES: Record<string, string> = {
  GOLD: 'XAU',
  SILVER: 'XAG',
  COPPER: 'XCU',
  NATGAS: 'NG',
  PLATINUM: 'XPT',
  PALLADIUM: 'XPD',
};

export function toOKXInstId(coin: string): string {
  const mapped = TRADFI_ALIASES[coin] || coin;
  return `${mapped}-USDT-SWAP`;
}

export function fromOKXInstId(instId: string): string {
  const base = instId.replace(/-USDT-SWAP$/, '');
  for (const [canon, native] of Object.entries(TRADFI_ALIASES)) {
    if (native === base) return canon;
  }
  return base;
}

// ── Interval mapping ──

// No 8h: OKX offers no 8H bar and answers code 51000 'Parameter bar error' on /market/candles and
// /market/history-candles (tests/fixtures/adapter-history R/D captures; declared UNSERVABLE until
// OPS-SERVED-CANDLE-TRUTH-W1 CH2), so getCandles refuses it (resolveVenueInterval) before any request.
const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m',
  '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H',
  '12h': '12H', '1d': '1D',
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms OKX fetches for `tf` (1H/1D notation; fully native). */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP);

/** Page caps, named once: the request AND the contract/canary read these (never a third literal). */
export const RECENT_PAGE_CAP = 100;
export const HISTORY_PAGE_CAP = 100;

/**
 * OPS-SERVED-CANDLE-TRUTH-W1 CH1 (Q2): the `limit` a SERVING read (no `endTime`) asks of `/market/candles`, the
 * endpoint's maximum. OKX answers with the newest ≤ limit bars newer than `before` (measured R0 I4: 168 1H bars in one
 * request), so every serving window up to 300 bars is ONE head-complete request. A history read keeps
 * RECENT_PAGE_CAP: 272 of the R0 P9 differential's `endTime` reads route R, so that request is part of the frozen
 * history path.
 */
export const SERVING_PAGE_LIMIT = 300;

/** The most served bars ONE serving request can hold on `tf` (null: OKX does not map it). Suite S, the differential
 *  and the SERVING_MAX_PAGES derivation read this, never a literal. */
export function servingReachBars(tf: string): number | null {
  return servedIntervalMs(tf) == null ? null : SERVING_PAGE_LIMIT;
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
function mapOkxCandle(c: string[]): Candle | null {
  const open = safeUpstreamNum(c[1]);
  const high = safeUpstreamNum(c[2]);
  const low = safeUpstreamNum(c[3]);
  const close = safeUpstreamNum(c[4]);
  if (open === null || high === null || low === null || close === null) return null;
  return {
    time: parseInt(c[0], 10),
    open, high, low, close,
    volume: parseFloat(c[5]),
  };
}

// ── Rate-limited HTTP client ──

let lastRequestTime = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < 100) {
    await new Promise(r => setTimeout(r, 100 - elapsed));
  }
  lastRequestTime = Date.now();
}

// ── Funding-history paging (OPS-BDIR-V3-PANEL-READINESS-W1 CH1) ──

/** The `funding-rate-history` endpoint's maximum page size. */
const OKX_FUNDING_HISTORY_PAGE_LIMIT = 100;

/**
 * Upper bound on pages per `getFundingHistory` call. OKX retained 96 days of prints when measured
 * (2026-09-26); at the densest funding interval (1h) that is 2,304 records = 24 pages, so 30
 * covers it with margin while stopping an endpoint that keeps returning full pages from looping.
 */
export const OKX_FUNDING_HISTORY_MAX_PAGES = 30;

/**
 * Pause between pages of ONE instrument's walk. OKX limits this endpoint to 10 requests / 2 s per
 * IP + instrument; 1,000 ms is 1 req/s (20 %) and keeps a full backfill at ≤ 60 req/min against
 * the OKX interactive reserve (architect ruling Q-B, 2026-09-26). Only a window holding more than
 * one page ever pays it — the steady-state checkpoint fetch is a single request.
 */
let okxFundingPageDelayMs = 1_000;

/** Test seam (`_set…ForTest` convention): hermetic tests page without real sleeps. */
export function _setOkxFundingPageDelayForTest(ms: number): void {
  okxFundingPageDelayMs = ms;
}

interface OKXResponse<T> {
  code: string;
  msg: string;
  data: T;
}

async function okxGet<T>(path: string, params?: Record<string, string | number>, retries = MAX_RETRIES): Promise<OKXResponse<T>> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: intra-process throttle() (complementary to the
  // cross-process budget, D2) + URL-build + code-envelope check unchanged;
  // fetch/retry/ban via upstreamFetch.
  await throttle();
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  const body = await upstreamFetch<OKXResponse<T>>({ ...VENUE_FETCH_CONFIGS.OKX, transientRetries: retries }, { url: url.toString() });
  if (body.code !== '0') {
    throw new Error(`OKX API error code ${body.code}: ${body.msg}`);
  }
  return body;
}

// ── Response types from OKX ──

interface OKXTicker {
  instId: string;
  last: string;
  askPx: string;
  bidPx: string;
  open24h: string;
  high24h: string;
  low24h: string;
  vol24h: string;
  volCcy24h: string;
  ts: string;
}

interface OKXFundingRate {
  instId: string;
  fundingRate: string;
  nextFundingRate: string;
  fundingTime: string;
  nextFundingTime: string;
}

/**
 * SEC-06: funding period in hours, derived from the two stamps OKX returns. Returns undefined on
 * anything implausible so the consumer falls back to the declared cadence instead of trusting a
 * garbage value; a 0/negative gap would otherwise divide-by-zero into an infinite annualization.
 */
function okxIntervalHours(fundingTime?: string, nextFundingTime?: string): number | undefined {
  const a = parseInt(fundingTime || '0', 10);
  const b = parseInt(nextFundingTime || '0', 10);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= a) return undefined;
  const hours = (b - a) / 3_600_000;
  return hours > 0 && hours <= 24 ? hours : undefined;
}

interface OKXFundingHistory {
  instId: string;
  fundingRate: string;
  realizedRate: string;
  fundingTime: string;
}

interface OKXOpenInterest {
  instId: string;
  oi: string;
  oiCcy: string;
  ts: string;
}

interface OKXMarkPrice {
  instId: string;
  markPx: string;
  ts: string;
}

export class OKXAdapter implements ExchangeAdapter {
  getName(): string {
    return 'OKX';
  }

  /**
   * OPS-ADAPTER-HISTORY-ANCHOR-W1 CH2. Two branches, chosen by the data:
   *   R — the recent page (`/market/candles`, `before` = strictly newer than the ts; the venue answers with its
   *       NEWEST page), accepted by the routing guard below. Request, guard and bars are BYTE-IDENTICAL to the
   *       pre-wave code; only `meta` is added.
   *   F — the history fallback (`/market/history-candles`, `after` = strictly older than the ts). The page is
   *       anchored on the SERVED step (OKX serves every mapped tf natively, so the anchor is numerically
   *       unchanged; the derivation is the one that cannot drift).
   * Every return carries a non-enumerable `meta` (`historyMetaOf(page)`, src/lib/adapters/_history-plan.ts),
   * including `substitutedNewest` when the history page held nothing and the recent page is returned instead
   * (OAH-Q5: reported, bars unchanged). `endTime` bounds the accounting window only.
   *
   * OPS-SERVED-CANDLE-TRUTH-W1 CH1, SERVING reads only (no `endTime`): the recent request asks SERVING_PAGE_LIMIT,
   * and a page the routing guard rejects goes to the serving assembler (`branch: 'A'`), never to the history
   * fallback. The `endTime` path is byte-identical (R0 P9 differential).
   */
  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType, endTime?: number): Promise<Candle[]> {
    const instId = toOKXInstId(coin);
    const bar = resolveVenueInterval(INTERVAL_MAP, interval, 'OKX');
    // REQUESTED step: the routing guard's unit only (kept byte-identical — it decides which branch serving reads).
    const barMs = BAR_MS[interval]; // every mapped timeframe is a key (an unmapped one was refused above)
    // SERVED step: the module-local leaf (never tf-support — see _history-plan.ts). Every page span uses it.
    const servedStepMs = servedIntervalMs(interval) ?? barMs;
    // headClosedOnly: false on every branch. Both OKX endpoints carry the forming bar; `/market/history-candles` was
    // measured holding it on young-listing serving reads (OPS-SERVED-CANDLE-TRUTH-W1 CH3a census, 2026-10-23).
    const meta = (branch: HistoryBranch, substitutedNewest: boolean) =>
      ({ servedStepMs, from: startTime, to: endTime, nowMs: Date.now(), branch, substitutedNewest, headClosedOnly: false });
    const serving = endTime === undefined;

    // Recent path (live/indicator use): `/market/candles` `before` = records NEWER than startTime. OKX returns
    // DESCENDING (newest first) → reverse to ascending.
    const resp = await okxGet<string[][]>('/api/v5/market/candles', {
      instId,
      bar,
      before: startTime,
      limit: serving ? SERVING_PAGE_LIMIT : RECENT_PAGE_CAP,
    });
    const recentRows = resp.data || [];
    const candles = recentRows.reverse().flatMap(c => mapOkxCandle(c) ?? []);

    // `/market/candles` answers with the venue's NEWEST page (measured 2026-09-29, two vantages), so a
    // startTime older than that page yields bars far newer than startTime. Detect the gap — the oldest
    // returned bar should sit at ~startTime — and fall back to the history endpoint.
    // Recent requests satisfy the guard here and return the live path verbatim.
    if (candles.length > 0 && candles[0].time <= startTime + 5 * barMs) {
      return withHistoryMeta(candles, meta('R', false));
    }

    // A SERVING page the guard rejected holds the newest bars, so its gap is at the FRONT, for one of two reasons.
    //   - The window is longer than one page (the page is full): page backward on `/market/history-candles` from the
    //     oldest held bar (`after` = strictly older) through the serving assembler.
    //   - The coin is younger than the window (the page is not full, so OKX has already returned every bar newer than
    //     startTime). Whenever the history fallback's single page reaches the newest bar that page holds, it is head-
    //     complete and is kept below: byte-identical, pre-wave cost. Where it would end earlier (a window longer than
    //     HISTORY_PAGE_CAP bars: OKX 1h@168 served a window ending ~68 h back), the recent page itself is the answer.
    //     Judged against the venue's own newest bar, never the local clock, so it cannot flip on a millisecond.
    if (serving && candles.length > 0) {
      const full = recentRows.length >= SERVING_PAGE_LIMIT;
      if (full || historyPageEnd({ servedStepMs, from: startTime, pageCap: HISTORY_PAGE_CAP }) < candles[candles.length - 1].time) {
        const { bars } = await assembleServingWindow({
          first: candles,
          servedStepMs,
          from: startTime,
          nowMs: Date.now(),
          maxPages: SERVING_MAX_PAGES,
          backward: full
            ? async (oldestOpenMs) => {
              const page = await okxGet<string[][]>('/api/v5/market/history-candles', { instId, bar, after: oldestOpenMs, limit: HISTORY_PAGE_CAP });
              const rows = page.data || [];
              return { bars: rows.flatMap(c => mapOkxCandle(c) ?? []).filter(c => c.time >= startTime), exhausted: rows.length < HISTORY_PAGE_CAP };
            }
            : undefined,
        });
        return withHistoryMeta(bars, meta('A', false));
      }
    }

    // Historical fallback: `/market/history-candles` `after` = records EARLIER than the ts (desc).
    // Anchor the page on the served grid so it lands on [startTime, startTime + HISTORY_PAGE_CAP served bars).
    const after = historyPageEnd({ servedStepMs, from: startTime, pageCap: HISTORY_PAGE_CAP });
    const hist = await okxGet<string[][]>('/api/v5/market/history-candles', {
      instId,
      bar,
      after,
      limit: HISTORY_PAGE_CAP,
    });
    const histAsc = (hist.data || []).reverse().flatMap(c => mapOkxCandle(c) ?? []).filter(c => c.time >= startTime);
    return histAsc.length > 0
      ? withHistoryMeta(histAsc, meta('F', false))
      : withHistoryMeta(candles, meta('F', candles.length > 0));
  }

  /**
   * SEC-35: a single-entity read off a LIST endpoint must prove the row it got back is the row
   * it asked for. Returns the row when it matches; throws otherwise, so the caller default-denies
   * instead of emitting a confident number about the wrong asset. A missing row is NOT an
   * identity failure (the venue may simply not list the instrument) and is passed through
   * unchanged, preserving the existing `funding?.fundingRate || '0'` handling below.
   */
  private assertRow<T extends { instId?: string }>(row: T | undefined, instId: string, endpoint: string): T | undefined {
    if (row && row.instId && row.instId !== instId) {
      throw new Error(
        `OKX ${endpoint} identity mismatch: requested instId=${instId} but the row returned instId=${row.instId}. ` +
        `Refusing a wrong-but-plausible row (SEC-35).`,
      );
    }
    return row;
  }

  async getAssetContext(coin: string, _dex?: DexType): Promise<AssetContext> {
    const instId = toOKXInstId(coin);
    const assertOkxRow = this.assertRow.bind(this);

    // Parallel fetch: ticker + funding-rate + open-interest + mark-price
    const [tickerResp, fundingResp, oiResp, markResp] = await Promise.all([
      okxGet<OKXTicker[]>('/api/v5/market/ticker', { instId }),
      okxGet<OKXFundingRate[]>('/api/v5/public/funding-rate', { instId }),
      okxGet<OKXOpenInterest[]>('/api/v5/public/open-interest', { instType: 'SWAP', instId }),
      okxGet<OKXMarkPrice[]>('/api/v5/public/mark-price', { instType: 'SWAP', instId }),
    ]);

    // SEC-35 (OPS-AUDIT-REMEDIATION-LOW-W1): assert the returned row IS the row we asked for.
    // These are LIST endpoints being used as single-entity reads (`?instId=` + `[0]`). A
    // filtered-list endpoint that ignores its filter — on a bad param, an upstream regression,
    // or a cache serving a neighbouring key — returns a wrong-but-PLAUSIBLE row, and every
    // downstream number is then silently about the wrong asset. There is no natural detector
    // for that: the shape is valid and the values look reasonable. Assert identity at the seam.
    const ticker = assertOkxRow(tickerResp.data[0], instId, 'ticker');
    const funding = assertOkxRow(fundingResp.data[0], instId, 'funding-rate');
    const oi = assertOkxRow(oiResp.data[0], instId, 'open-interest');
    const mark = assertOkxRow(markResp.data[0], instId, 'mark-price');

    // R2: OKX funding is per-8h period → annualized = raw × 1095 (8h periods/year)
    // SV-04: default-deny — an invalid markPx throws (the 3-tier fallback fires)
    // rather than scoring a wrong-but-finite price; non-price fields fall back to a
    // safe neutral 0. Same contract as the aster adapter.
    const fundingRaw = safeUpstreamNum(funding?.fundingRate) ?? 0;
    const markPx = safeUpstreamNum(mark?.markPx);
    if (markPx === null) throw new Error('OKX getAssetContext: invalid markPx');
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: safeUpstreamNum(oi?.oi) ?? 0,
      prevDayPx: safeUpstreamNum(ticker?.open24h) ?? 0,
      volume24h: parseFloat(ticker?.volCcy24h || '0'),
      oraclePx: markPx,
      markPx,
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // DECISION-CALL-V1-W1 R3: ONE whole-book call (`instId=ANY`, measured 2026-10-27) replaces the
    // top-30-by-volume loop of per-instrument calls (9% of OKX's top 100, BTC/ETH/SOL absent).
    // OKX's `fundingTime` IS the next settlement; its `nextFundingTime` is the one after — the old
    // mapping read the latter and so quoted every OKX leg one period late. The contract's interval
    // is the gap between the two stamps (`okxIntervalHours`). An unreadable rate drops the row.
    const fundingResp = await okxGet<OKXFundingRate[]>('/api/v5/public/funding-rate', { instId: 'ANY' });

    const results: FundingData[] = [];
    for (const fr of fundingResp.data || []) {
      if (!fr.instId.endsWith('-USDT-SWAP')) continue;
      const rate = safeUpstreamNum(fr.fundingRate);
      if (rate === null) continue;
      results.push({
        coin: fromOKXInstId(fr.instId),
        venues: [{
          venue: 'OKXPerp',
          fundingRate: rate,
          nextFundingTime: parseInt(fr.fundingTime || '0', 10),
          // SEC-06: OKX publishes no interval field, but the period is the gap between the
          // current and next funding stamps — derived, not assumed.
          intervalHours: okxIntervalHours(fr.fundingTime, fr.nextFundingTime),
        }],
      });
    }
    return results;
  }

  /**
   * Every retained funding print with `fundingTime > startTime`, ascending.
   *
   * OPS-BDIR-V3-PANEL-READINESS-W1 CH1. OKX answers `before=C` with up to `limit` records newer
   * than C — the ones CLOSEST to C, i.e. the OLDEST page after the cursor (measured 2026-09-26:
   * before=now−400d returned 06-22..07-25 while the newest print was 09-26). The single request
   * this method used to send therefore returned only the first 100 records of any longer window,
   * and every OKX row in `funding_rates_hist` trailed real time by ~60 days from the 2026-07-05
   * seed onward. It now walks FORWARD, re-using `before` with the newest time seen as the cursor,
   * so what it returns is always a contiguous run starting at `startTime` — a truncated walk
   * (page bound, transport failure) leaves no hole for the next checkpoint run to skip over.
   *
   * The first request is byte-identical to the old one, so any window of ≤ 100 records (the
   * steady-state checkpoint fetch; `scan_funding_arb` never calls OKX here) behaves exactly as
   * before. Best-effort as before: never throws; a first-page failure returns [].
   */
  async getFundingHistory(coin: string, startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    const instId = toOKXInstId(coin);
    const byTime = new Map<number, number>();
    let cursor = startTime;
    for (let page = 0; page < OKX_FUNDING_HISTORY_MAX_PAGES; page++) {
      let rows: OKXFundingHistory[];
      try {
        const resp = await okxGet<OKXFundingHistory[]>('/api/v5/public/funding-rate-history', {
          instId,
          before: cursor,
          limit: OKX_FUNDING_HISTORY_PAGE_LIMIT,
        });
        rows = resp.data || [];
      } catch {
        break; // keep the contiguous prefix already collected
      }
      let newest = cursor;
      for (const r of rows) {
        const time = parseInt(r.fundingTime, 10);
        if (!Number.isFinite(time)) continue;
        if (time > newest) newest = time;
        const fundingRate = safeUpstreamNum(r.fundingRate);
        if (fundingRate !== null) byTime.set(time, fundingRate);
      }
      // A short page is the newest page. A full page that did not move the cursor would repeat.
      if (rows.length < OKX_FUNDING_HISTORY_PAGE_LIMIT || newest <= cursor) break;
      cursor = newest;
      if (okxFundingPageDelayMs > 0) await new Promise((r) => setTimeout(r, okxFundingPageDelayMs));
    }
    return [...byTime.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([time, fundingRate]) => ({ time, fundingRate }));
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const instId = toOKXInstId(coin);
      const resp = await okxGet<OKXMarkPrice[]>('/api/v5/public/mark-price', {
        instType: 'SWAP',
        instId,
      });
      const mark = resp.data[0];
      return mark ? safeUpstreamNum(mark.markPx) : null;
    } catch {
      return null;
    }
  }
}
