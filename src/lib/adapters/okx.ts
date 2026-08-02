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
import { upstreamFetch, VENUE_FETCH_CONFIGS } from './_upstream-fetch.js';
import { makeServedIntervalMs } from '../served-interval.js';

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

function mapOkxCandle(c: string[]): Candle {
  return {
    time: parseInt(c[0], 10),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
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

  async getCandles(coin: string, interval: string, startTime: number, _dex?: DexType): Promise<Candle[]> {
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
    const candles = (resp.data || []).reverse().map(mapOkxCandle);

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
    const histAsc = (hist.data || []).reverse().map(mapOkxCandle).filter(c => c.time >= startTime);
    return histAsc.length > 0 ? histAsc : candles;
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
    const fundingRaw = parseFloat(funding?.fundingRate || '0');
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 1095,
      openInterest: parseFloat(oi?.oi || '0'),
      prevDayPx: parseFloat(ticker?.open24h || '0'),
      volume24h: parseFloat(ticker?.volCcy24h || '0'),
      oraclePx: parseFloat(mark?.markPx || '0'),
      markPx: parseFloat(mark?.markPx || '0'),
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // Step 1: Fetch all swap tickers to find top coins by volume
    const tickersResp = await okxGet<OKXTicker[]>('/api/v5/market/tickers', {
      instType: 'SWAP',
    });

    // Filter to USDT-SWAP pairs and sort by volume descending
    const usdtTickers = (tickersResp.data || [])
      .filter(t => t.instId.endsWith('-USDT-SWAP'))
      .sort((a, b) => parseFloat(b.volCcy24h || '0') - parseFloat(a.volCcy24h || '0'))
      .slice(0, 30); // Top 30 by volume to stay under rate limits

    // Step 2: Fetch funding rate for each, throttled at 100ms apart
    const results: FundingData[] = [];

    for (const ticker of usdtTickers) {
      try {
        const fundingResp = await okxGet<OKXFundingRate[]>('/api/v5/public/funding-rate', {
          instId: ticker.instId,
        });

        const fr = fundingResp.data[0];
        if (!fr) continue;

        const rate = parseFloat(fr.fundingRate);
        if (isNaN(rate)) continue;

        results.push({
          coin: fromOKXInstId(ticker.instId),
          venues: [{
            venue: 'OKXPerp',
            fundingRate: rate,
            nextFundingTime: parseInt(fr.nextFundingTime || '0', 10),
            // SEC-06: OKX publishes no interval field, but the period is the gap between the
            // current and next funding stamps — derived, not assumed. Live-probed 2026-07-29:
            // BTC-USDT-SWAP yields exactly 8h this way.
            intervalHours: okxIntervalHours(fr.fundingTime, fr.nextFundingTime),
          }],
        });
      } catch {
        // Skip coins whose funding rate fetch fails
        continue;
      }
    }

    return results;
  }

  async getFundingHistory(coin: string, startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const instId = toOKXInstId(coin);
      const resp = await okxGet<OKXFundingHistory[]>('/api/v5/public/funding-rate-history', {
        instId,
        before: startTime,
        limit: 100,
      });

      // OKX returns descending — reverse to ascending
      const records = (resp.data || []).reverse();

      return records
        .filter(r => r.fundingRate != null && !isNaN(parseFloat(r.fundingRate)))
        .map(r => ({
          time: parseInt(r.fundingTime, 10),
          fundingRate: parseFloat(r.fundingRate),
        }));
    } catch {
      return [];
    }
  }

  async getCurrentPrice(coin: string, _dex?: DexType): Promise<number | null> {
    try {
      const instId = toOKXInstId(coin);
      const resp = await okxGet<OKXMarkPrice[]>('/api/v5/public/mark-price', {
        instType: 'SWAP',
        instId,
      });
      const mark = resp.data[0];
      return mark ? parseFloat(mark.markPx) : null;
    } catch {
      return null;
    }
  }
}
