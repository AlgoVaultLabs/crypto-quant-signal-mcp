/**
 * Hyperliquid adapter — implements ExchangeAdapter for the HL public API.
 * Base URL: https://api.hyperliquid.xyz/info
 * All requests are POST, no auth needed for read endpoints.
 */
import type {
  ExchangeAdapter,
  Candle,
  AssetContext,
  FundingData,
  HLCandle,
  HLMetaAndAssetCtxs,
  HLPredictedFunding,
  DexType,
} from '../../types.js';
import { UpstreamRateLimitError } from '../errors.js';
import { type WeightClass } from '../upstream-weight-budget.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS, safeUpstreamNum } from './_upstream-fetch.js';
import { coalescedCache } from '../coalesced-cache.js';
import { makeServedIntervalMs } from '../served-interval.js';

const BASE_URL = 'https://api.hyperliquid.xyz/info';
const MAX_RETRIES = 1;

// ── OPS-HL-RATELIMITER-W2: HL `/info` request → rate-limit weight ──
// Source (re-verified 2026-06-04): HL docs "rate-limits-and-user-limits":
//   • "All other documented info requests have weight 20."
//   • candleSnapshot: additional +1 weight per 60 items returned.
//   • fundingHistory class: additional +1 weight per 20 items returned.
//   • weight 2: l2Book, allMids, clearinghouseState, orderStatus,
//     spotClearinghouseState, exchangeStatus.
// `weightHint` is the expected item count (passed by getCandles /
// getFundingHistory). Unknown types default to 20 — never under-count.
const WEIGHT_2_TYPES = new Set([
  'l2Book',
  'allMids',
  'clearinghouseState',
  'orderStatus',
  'spotClearinghouseState',
  'exchangeStatus',
]);
// Conservative fallback when a caller omits weightHint. Real candle/funding
// callers always pass one; this only guards a future caller that forgets.
const DEFAULT_ITEM_HINT = 500;

export function weightFor(body: Record<string, unknown>, weightHint?: number): number {
  const type = typeof body?.type === 'string' ? (body.type as string) : '';
  if (WEIGHT_2_TYPES.has(type)) return 2;
  if (type === 'candleSnapshot') {
    return 20 + Math.ceil((weightHint ?? DEFAULT_ITEM_HINT) / 60);
  }
  if (type === 'fundingHistory') {
    return 20 + Math.ceil((weightHint ?? DEFAULT_ITEM_HINT) / 20);
  }
  return 20; // metaAndAssetCtxs, predictedFundings, and unknown → never under-count
}

// HL candle intervals → ms, for deriving the candleSnapshot weightHint from the
// requested [startTime, now] window (HL returns ~one item per interval bucket).
const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000,
};

/** OPS-SEED-UNSUPPORTED-TF-SKIP-W1: finest base-candle ms HL fetches for `tf` (INTERVAL_MS is already ms). Fully native. */
export const servedIntervalMs = makeServedIntervalMs(INTERVAL_MS, 'ms');

export function expectedCandleItems(
  interval: string,
  startTime: number,
  endTime?: number,
): number | undefined {
  const ms = INTERVAL_MS[interval];
  if (!ms) return undefined; // unknown interval → weightFor falls back to its conservative default
  // OPS-HL-SEED-LOAD-W1: bound by endTime when given (outcome backfill window),
  // else assume to-now. Matches HL's "+1 weight per 60 items RETURNED".
  const upper = endTime ?? Date.now();
  return Math.max(1, Math.ceil((upper - startTime) / ms));
}

/**
 * Budgeted entry point for EVERY HL `/info` POST — the single chokepoint
 * (OPS-HL-RATELIMITER-W2). Reserves the request's weight against the shared
 * cross-process HL weight ledger BEFORE hitting the network, then delegates to
 * the raw fetch. `cls` defaults to the AsyncLocalStorage weight class
 * (`interactive` unless inside `runAsBatch`). Exported so the non-adapter HL
 * callers (seed universe discovery, oi-ranking, exchange-universe, monitor)
 * route through the SAME budget — making "every HL caller is throttled" structural.
 *   - interactive: throws `UpstreamRateLimitError` if over ceiling (→ structured 429).
 *   - batch: waits for the window to roll, else throws `WeightBudgetSkipError`
 *     (caller logs a skip and the next idempotent fire retries).
 */
export async function hlInfoPost<T>(
  body: Record<string, unknown>,
  opts?: { cls?: WeightClass; weightHint?: number },
): Promise<T> {
  // OPS-ADAPTER-RATELIMIT-UNIFY-W1: HL weight (weightFor) + class resolution unchanged;
  // budget acquire (via the registry, passed as weightHint) + 429→typed-no-retry move
  // into the shared upstreamFetch. The in-process metaAndAssetCtxs coalescing (above)
  // is unchanged — it still collapses concurrent callers to one hlInfoPost.
  return upstreamFetch<T>(VENUE_FETCH_CONFIGS.HL, {
    url: BASE_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    weightHint: weightFor(body, opts?.weightHint),
    cls: opts?.cls,
  });
}

// OPS-HL-RATELIMIT-W1 (2026-05-22): per-coin getAssetContext used to issue
// N redundant `metaAndAssetCtxs` fetches per seed fire — each returning the
// same ~230-perp universe payload. At ~weight 20 per call, a 20-coin top-20
// 3m fire burned ~400 weight on identical responses; the 15m HL top-100 fire
// (~230 coins with TradFi) burned ~4600 weight on identical responses. Burst
// stacking across overlapping 1m/3m/5m/15m HL crons pushed peak load to
// ~10x the documented 1200 weight/min/IP budget, triggering intermittent 429
// storms (worst observed fire: 0 seeded, 20 errors at 2026-05-22T06:24 UTC).
// This in-process coalescing cache (60s TTL, dex-keyed) collapses N concurrent
// or near-sequential `metaAndAssetCtxs` callers within ONE node process to a
// single backend fetch. Cross-process coalescing (separate cron-fire node
// processes) is out of scope and deferred to OPS-HL-RATELIMITER-W2.
const META_TTL_MS = 60_000;

function metaCacheKey(dex: DexType): string {
  return dex === 'xyz' ? 'xyz' : 'standard';
}

// OPS-HL-CACHE-STAMPEDE-GENERATOR-W1 C2: the single-flight + 60s-TTL coalescing that
// lived in the metaCache/metaInflight maps now routes through the shared
// `coalescedCache` primitive. BYTE-EQUIVALENT: single-flight per dex key, 60s TTL,
// throw-on-error (staleOk=false, negativeTtlMs=0 → no stale-serve, no negative memo —
// meta already can't stampede thanks to its single-flight), budget `acquire` called
// exactly once per real fetch (inside hlInfoPost, unchanged).
const metaCacheImpl = coalescedCache<unknown>({
  load: (key) => {
    const body: Record<string, unknown> = { type: 'metaAndAssetCtxs' };
    if (key === 'xyz') body.dex = 'xyz';
    return hlInfoPost<unknown>(body);
  },
  ttlMs: META_TTL_MS,
  staleOk: false,
  negativeTtlMs: 0,
});

function getMetaAndAssetCtxsCoalesced<T>(dex: DexType): Promise<T> {
  return metaCacheImpl.get(metaCacheKey(dex)) as Promise<T>;
}

/**
 * Test-only reset of the adapter's metaAndAssetCtxs coalescing cache.
 * Production code MUST NOT call this — used by unit tests to isolate cases.
 */
export function _resetHyperliquidMetaCache(): void {
  metaCacheImpl._clear();
}

// ── OPS-HL-INTERACTIVE-STARVATION-W1 CH2: the same treatment for `predictedFundings` ──
//
// WHY THIS IS THE LEVER, measured rather than preferred. `get_market_regime` calls
// `getPredictedFundings()` on EVERY invocation at EVERY venue (`get-market-regime.ts:311-313`),
// and it was the ONE HL call in that path still going direct to `hlInfoPost` while its neighbour
// `metaAndAssetCtxs` had been coalesced since OPS-HL-RATELIMIT-W1. At weight 20 (`weightFor`:
// "metaAndAssetCtxs, predictedFundings, and unknown → never under-count") that is 20 of the ~41
// weight a default 4h/HL regime call spends — roughly HALF, on a payload identical for every
// caller.
//
// THE ALTERNATIVE WAS MEASURED AND REJECTED. Raising the interactive reserve cannot fix this:
// HL_WEIGHT_CEILING is 1150 against HL's documented 1200/min/IP, so only 50 wt/min is
// unallocated — reserve 450→500 is +11%, taking ~10.9 calls/min to ~12, against bursts measured
// at up to 106 throws in a SINGLE minute (2026-08-16). Taking the rest from batch is forbidden:
// batch is compliant, 0 breaches in 222 closed windows. Coalescing REDUCES DEMAND rather than
// reallocating a fixed budget, which is why it wins even where a reserve bump would fit.
//
// OUTPUT IDENTITY IS STRUCTURAL, NOT MERELY ASSERTED. `predictedFundings` takes NO parameters and
// returns the whole perp universe, so every caller already receives the same payload — there is no
// per-caller dimension that could be baked into a cached cell (the hazard the "value varying along
// a dimension absent from the cache key" rule names). Funding also moves far slower than the mark
// prices the 60 s meta TTL already covers, so this TTL is strictly safer than one already ratified
// in this same file.
//
// The RAW payload is cached and mapped per caller, deliberately: caching the mapped array would
// hand ONE array object to N callers, and a shared mutable result buys nothing here. Mapping ~230
// entries in-process is free next to a 20-weight network call.
//
// Same knobs as meta, for the same reasons. `staleOk: false` + `negativeTtlMs: 0` mean a refusal is
// NOT memoised, so the next call retries instead of inheriting a 60 s-old failure. Serving a stale
// funding payload through an upstream refusal would serve the customer better, but it CHANGES the
// response in the degraded case — out of scope for a chapter whose gate is output identity.
// Recorded as a follow-on candidate rather than silently taken.
const PREDICTED_FUNDINGS_TTL_MS = 60_000;

// `predictedFundings` accepts no arguments, so there is exactly ONE cell. The key is a constant
// rather than a dex or coin — inventing a dimension the endpoint does not have would fragment the
// cache and quietly restore the per-caller fetch this exists to remove.
const PREDICTED_FUNDINGS_KEY = 'all';

const predictedFundingsCacheImpl = coalescedCache<HLPredictedFunding[]>({
  load: () => hlInfoPost<HLPredictedFunding[]>({ type: 'predictedFundings' }),
  ttlMs: PREDICTED_FUNDINGS_TTL_MS,
  staleOk: false,
  negativeTtlMs: 0,
});

/**
 * Test-only reset of the adapter's predictedFundings coalescing cache.
 * Production code MUST NOT call this — used by unit tests to isolate cases.
 */
export function _resetHyperliquidPredictedFundingsCache(): void {
  predictedFundingsCacheImpl._clear();
}

// OPS-ADAPTER-RATELIMIT-UNIFY-W1: the raw `hlPost` POST/retry/429 loop was retired —
// hlInfoPost now routes through the shared `upstreamFetch` (VENUE_FETCH_CONFIGS.HL).

export class HyperliquidAdapter implements ExchangeAdapter {
  getName(): string {
    return 'Hyperliquid';
  }

  async getCandles(coin: string, interval: string, startTime: number, dex: DexType = 'standard', endTime?: number): Promise<Candle[]> {
    // xyz perps require the xyz: prefix for candle fetches
    const apiCoin = dex === 'xyz' ? `xyz:${coin}` : coin;
    // OPS-HL-SEED-LOAD-W1: bound the fetch with endTime when given. Outcome
    // backfill needs only [signalTime, signalTime+(evalCount+buffer)·candleMs];
    // without endTime HL returns [startTime, now] (~5000 candles → weight ~104).
    // HL candleSnapshot honors req.endTime (live-verified: 11 candles bounded vs 101 to-now).
    const req: Record<string, unknown> = { coin: apiCoin, interval, startTime };
    if (endTime !== undefined) req.endTime = endTime;
    const raw = await hlInfoPost<HLCandle[]>(
      { type: 'candleSnapshot', req },
      { weightHint: expectedCandleItems(interval, startTime, endTime) },
    );
    // SV-04: drop a candle whose OHLC does not parse strictly rather than emit a
    // NaN/wrong-but-finite price into the signal engine.
    return (raw || []).flatMap(c => {
      const open = safeUpstreamNum(c.o);
      const high = safeUpstreamNum(c.h);
      const low = safeUpstreamNum(c.l);
      const close = safeUpstreamNum(c.c);
      if (open === null || high === null || low === null || close === null) return [];
      return [{
        open, high, low, close,
        volume: parseFloat(c.v),
        time: c.t,
      }];
    });
  }

  async getAssetContext(coin: string, dex: DexType = 'standard'): Promise<AssetContext> {
    // OPS-HL-RATELIMIT-W1: route through the in-process coalescing cache so
    // N per-coin callers within a seed fire share one backend fetch (60s TTL).
    const raw = await getMetaAndAssetCtxsCoalesced<
      [HLMetaAndAssetCtxs['meta'], HLMetaAndAssetCtxs['assetCtxs']]
    >(dex);
    const meta = raw[0];
    const ctxs = raw[1];
    // xyz universe names include 'xyz:' prefix (e.g. 'xyz:GOLD'), so match both formats
    const lookupName = dex === 'xyz' ? `xyz:${coin}` : coin;
    const idx = meta.universe.findIndex(a => a.name === lookupName);
    if (idx === -1) {
      throw new Error(`${coin} not found on Hyperliquid${dex === 'xyz' ? ' (xyz dex)' : ''}`);
    }
    const ctx = ctxs[idx];
    // R2: HL funding is per-1h period → annualized = raw × 8760 (1h periods/year)
    // SV-04: default-deny — an invalid markPx throws (the 3-tier fallback fires)
    // rather than scoring a wrong-but-finite price; non-price fields fall back to a
    // safe neutral 0. Same contract as the aster adapter.
    const fundingRaw = safeUpstreamNum(ctx.funding) ?? 0;
    const markPx = safeUpstreamNum(ctx.markPx);
    if (markPx === null) throw new Error('Hyperliquid getAssetContext: invalid markPx');
    return {
      coin,
      funding: fundingRaw,
      fundingAnnualized: fundingRaw * 8760,
      openInterest: safeUpstreamNum(ctx.openInterest) ?? 0,
      prevDayPx: safeUpstreamNum(ctx.prevDayPx) ?? 0,
      volume24h: parseFloat(ctx.dayNtlVlm || '0'),
      oraclePx: safeUpstreamNum(ctx.oraclePx) ?? markPx,
      markPx,
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    // OPS-HL-INTERACTIVE-STARVATION-W1 CH2: route through the in-process coalescing cache so a
    // burst of concurrent `get_market_regime` callers shares ONE backend fetch (60s TTL) instead
    // of spending 20 weight each on the identical universe payload. The mapping below is unchanged
    // and runs per caller, so each receives its own array. See the block beside the cache for why
    // this is the lever and why a larger reserve is not.
    const raw = await predictedFundingsCacheImpl.get(PREDICTED_FUNDINGS_KEY);
    return raw.map(entry => ({
      coin: entry[0],
      venues: (entry[1] || [])
        .filter(([, data]) => data != null && data.fundingRate != null)
        // Item 5: reject an unparseable rate instead of silently converting to 0.
        .map(([venue, data]) => ({
          venue,
          fundingRate: safeUpstreamNum(data.fundingRate),
          nextFundingTime: data.nextFundingTime ?? 0,
        }))
        .filter((v): v is { venue: string; fundingRate: number; nextFundingTime: number } => v.fundingRate !== null),
    }));
  }

  /**
   * Fetch historical HL funding rates for conviction scoring.
   * Returns hourly funding records for the given coin.
   * HL endpoint: { type: 'fundingHistory', coin, startTime }
   */
  async getFundingHistory(coin: string, startTime: number): Promise<{ time: number; fundingRate: number }[]> {
    try {
      const raw = await hlInfoPost<{ time: number; coin: string; fundingRate: string; premium: string }[]>(
        { type: 'fundingHistory', coin, startTime },
        { weightHint: Math.max(1, Math.ceil((Date.now() - startTime) / 3_600_000)) },
      );
      return (raw || [])
        .map(r => ({ time: r.time, fundingRate: safeUpstreamNum(r.fundingRate) }))
        .filter((r): r is { time: number; fundingRate: number } => r.fundingRate !== null);
    } catch {
      return []; // Best-effort: return empty on failure
    }
  }

  async getCurrentPrice(coin: string, dex: DexType = 'standard'): Promise<number | null> {
    try {
      const ctx = await this.getAssetContext(coin, dex);
      return ctx.oraclePx || ctx.markPx;
    } catch {
      return null;
    }
  }
}
