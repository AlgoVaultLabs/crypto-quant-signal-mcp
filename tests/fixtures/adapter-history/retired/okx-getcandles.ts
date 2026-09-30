/**
 * RETIRED OKX getCandles, pinned VERBATIM from origin/main c450d51a (the CH1 landing; adapter bytes unchanged since 4a23c1a6) for the CH2 differential
 * (tests/unit/adapter-history-differential.test.ts) — the LRW-Q9(b) shape: the retired body is pasted, never
 * imported from git. Only the class wrapper is removed; the module-level helpers it reads are copied as they
 * were. It calls the SAME transport module (`upstreamFetch`), so a test's mocked venue answers both bodies.
 * Never edit: a change here changes what "retired" means.
 */
/* eslint-disable */
import type { Candle, DexType } from '../../../../src/types.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS, safeUpstreamNum } from '../../../../src/lib/adapters/_upstream-fetch.js';
import { makeServedIntervalMs } from '../../../../src/lib/served-interval.js';

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

const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m',
  '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H',
  '8h': '8H', '12h': '12H', '1d': '1D',
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms OKX fetches for `tf` (1H/1D notation; fully native). */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MAP);

// Bar duration in ms — used to detect the historical-coverage gap and page the history endpoint.
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


export async function retiredGetCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
    const instId = toOKXInstId(coin);
    const bar = INTERVAL_MAP[interval] || '1H';
    const barMs = BAR_MS[interval] || 3_600_000;

    // Recent path (live/indicator use — UNCHANGED): `/market/candles` `before` = records NEWER
    // than startTime. OKX returns DESCENDING (newest first) → reverse to ascending.
    const resp = await okxGet<string[][]>('/api/v5/market/candles', {
      instId,
      bar,
      before: startTime,
      limit: 100,
    });
    const candles = (resp.data || []).reverse().flatMap(c => mapOkxCandle(c) ?? []);

    // `/market/candles` only holds the recent window (~1440 bars), so a HISTORICAL startTime
    // yields the newest bars instead of bars AT startTime (the labeler then filters them all out
    // → noKlines). Detect the gap — the oldest returned bar should sit at ~startTime; if it's far
    // newer, the recent endpoint couldn't reach startTime — and fall back to the history endpoint.
    // Recent requests satisfy the guard here and return the live path verbatim.
    if (candles.length > 0 && candles[0].time <= startTime + 5 * barMs) {
      return candles;
    }

    // Historical fallback: `/market/history-candles` `after` = records EARLIER than the ts (desc).
    // Anchor just past the wanted window so the page lands on [startTime, startTime + ~100 bars].
    const after = startTime + 100 * barMs;
    const hist = await okxGet<string[][]>('/api/v5/market/history-candles', {
      instId,
      bar,
      after,
      limit: 100,
    });
    const histAsc = (hist.data || []).reverse().flatMap(c => mapOkxCandle(c) ?? []).filter(c => c.time >= startTime);
    return histAsc.length > 0 ? histAsc : candles;
  }
