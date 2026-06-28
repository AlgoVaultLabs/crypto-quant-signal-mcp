/**
 * SCAN-RANKBY-W1 — `getRankedUniverse`: the metric-keyed universe selector.
 *
 * GENERALIZES the one universe-selection path (`exchange-universe.ts`'s FETCHERS
 * registry) into a `rankBy`-keyed selector. The composite-verdict engine then runs
 * UNCHANGED on whichever top-N set a lens picks — a new lens is a new metric key,
 * not a new code path. (NB: `oi-ranking.ts` is Hyperliquid-only and unrelated to
 * the scanner — the wave deliberately does not touch it; ratified 2026-06-27.)
 *
 * Cost model (per Q2(A) "uniform shortlist", ratified):
 *   • oi / volume / gainers / losers / movers — FULL universe (every venue's bulk
 *     ticker carries OI + volume + a prior-price for 24h-%), one bulk call.
 *   • funding_positive / funding_negative — rank funding WITHIN the top-by-OI
 *     candidate pool (the most-liquid perps), identical on all 5 venues. Pool
 *     funding is free for Bybit/Bitget/HL (same bulk call), one extra bulk call
 *     for Binance (`premiumIndex`), and per-instId for OKX (no bulk endpoint —
 *     served from a background-warmed cache so the request path never fans out).
 */

import pLimit from 'p-limit';
import type { ExchangeId } from '../types.js';
import { fetchVenueUniverse, type ExchangeAsset } from './exchange-universe.js';
import { getPremiumIndexBulkCoalesced } from './adapters/binance.js';
import { toOKXInstId } from './adapters/okx.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS } from './adapters/_upstream-fetch.js';
import { coalescedCache } from './coalesced-cache.js';
import { isShortLivedScript } from './runtime.js';
import { annualizeFunding, isFundingRank, type RankBy } from './rank-constants.js';
import { computeATRP } from './rank-atr.js';
import { getAdapter } from './exchange-adapter.js';
import { intervalMsFor } from './candle-guard.js';
import {
  computeOiDeltaForPool,
  DEFAULT_OI_WINDOW_MS,
  OI_WINDOWS,
  DEFAULT_OI_WINDOW,
  type OiDelta,
  type OiWindow,
} from './oi-snapshots.js';
import { getOkxFullFundingIfWarm } from './okx-funding-poller.js';

/**
 * The per-coin rank metric carried alongside the selected universe. `rank_value`
 * is the value the universe was sorted by; the typed field(s) echo the human
 * metric. `oi` carries only `rank_value` (the scanner suppresses the echo for the
 * default lens → byte-identical output).
 */
export interface RankedAsset {
  coin: string;
  rankBy: RankBy;
  /** The metric value the universe was ranked by (OI USD / volume USD / 24h % / funding fraction). */
  rank_value: number;
  /** gainers / losers / movers — signed 24h change percent. */
  change_24h_pct?: number;
  /** volume — 24h USD volume. */
  volume_24h?: number;
  /** funding_* — per-interval funding fraction. */
  funding_rate?: number;
  /** funding_* — annualized APR, or null when the interval is unknown (never guessed). */
  funding_apr?: number | null;
  /** volatility — ATRP (ATR(14) ÷ price × 100) on the scan timeframe. */
  atrp?: number;
  /** oi_change — REAL OI % delta over the window (computeOiDelta over oi_snapshots). */
  oi_change_pct?: number;
  /** oi_change — the OI-delta window label, e.g. "24h". */
  oi_change_window?: string;
}

/**
 * SCAN-RANKBY-REFINEMENTS-W1: optional per-call modifiers for the `oi_change` lens.
 * Both default to the SCAN-RANKBY-W3 behaviour (24h / notional) ⇒ byte-identical
 * when omitted. Passed as a TRAILING optional arg to `getRankedUniverse` (the
 * enum-widening LAW — narrower callers stay assignable, no N-file cascade).
 */
export interface RankOptions {
  /** CH1: OI-delta window for the oi_change lens (1h/4h/24h). Default '24h'. */
  oiChangeWindow?: OiWindow;
}

/**
 * Top-K-by-OI candidate pool size for the funding lenses (Q2(A) uniform shortlist).
 * Bounds OKX's per-instId funding fan-out; broad enough that the most/least-funded
 * liquid perps surface. Internal constant (no user-facing knob) — env-overridable.
 */
const FUNDING_POOL_SIZE = (() => {
  const raw = process.env.RANK_FUNDING_POOL_SIZE;
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 150;
})();

const OKX_FUNDING_TTL_MS = 3 * 60 * 1000; // funding is hourly → a 3-min cache is plenty
const OKX_FUNDING_CONCURRENCY = 8;

/**
 * OKX has NO bulk funding endpoint (live: `funding-rate?instType=SWAP` → 50014).
 * This cache fetches funding per-instId for the top-`FUNDING_POOL_SIZE`-by-OI pool
 * via the shared OKX budget, single-flighted + stale-served + load-timeout-bounded
 * so a cold request serves the (empty) fallback immediately and the load self-warms
 * the cache for the next caller — the request path NEVER blocks on the fan-out.
 * Returns `coin → funding fraction`.
 */
const okxFundingCache = coalescedCache<Map<string, number>>({
  load: async () => {
    const universe = await fetchVenueUniverse('OKX');
    const pool = universe.slice(0, FUNDING_POOL_SIZE);
    const limiter = pLimit(OKX_FUNDING_CONCURRENCY);
    const out = new Map<string, number>();
    await Promise.all(
      pool.map((a) =>
        limiter(async () => {
          try {
            const instId = toOKXInstId(a.coin);
            const json = await upstreamFetch<{ data?: Array<{ fundingRate?: string }> }>(
              VENUE_FETCH_CONFIGS.OKX,
              { url: `https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}` },
            );
            const r = parseFloat(json.data?.[0]?.fundingRate ?? '');
            if (Number.isFinite(r)) out.set(a.coin, r);
          } catch {
            /* skip — coin omitted from this round's OKX funding rank */
          }
        }),
      ),
    );
    return out;
  },
  ttlMs: OKX_FUNDING_TTL_MS,
  staleOk: true,
  loadTimeoutMs: 900, // cold: serve empty fallback < 1s, leave load running to self-warm
  fallback: () => new Map<string, number>(),
  negativeTtlMs: 30_000,
  processGate: () => isShortLivedScript(process.argv[1]),
});

let okxFundingWarmer: ReturnType<typeof setInterval> | null = null;
/** Lazily start the OKX funding background warmer (long-lived server only). */
function ensureOkxFundingWarmer(): void {
  if (okxFundingWarmer) return;
  if (isShortLivedScript(process.argv[1])) return; // crons/CLI serve cache-or-fallback, never warm
  okxFundingCache.get('okx').catch(() => {}); // warm now (fire-and-forget)
  okxFundingWarmer = setInterval(() => {
    okxFundingCache.get('okx').catch(() => {});
  }, Math.floor(OKX_FUNDING_TTL_MS * 0.83));
  okxFundingWarmer.unref?.();
}

/** Fill `fundingRate` on the pool for venues that don't carry it on the bulk call. */
async function augmentFunding(exchange: ExchangeId, pool: ExchangeAsset[]): Promise<void> {
  if (exchange === 'BINANCE') {
    // One coalesced bulk call (60s cache). Key by the SAME transform the fetcher uses
    // (strip USDT, upper) so 1000-prefixed symbols line up.
    const premium = await getPremiumIndexBulkCoalesced();
    const map = new Map<string, number>();
    for (const p of premium) {
      const r = parseFloat(p.lastFundingRate ?? '');
      if (Number.isFinite(r)) map.set(p.symbol.replace(/USDT$/, '').toUpperCase(), r);
    }
    for (const a of pool) {
      const r = map.get(a.coin);
      if (r !== undefined) a.fundingRate = r;
    }
  } else if (exchange === 'OKX') {
    ensureOkxFundingWarmer();
    const fundingMap = await okxFundingCache.get('okx');
    for (const a of pool) {
      const r = fundingMap.get(a.coin);
      if (r !== undefined) a.fundingRate = r;
    }
  }
  // BYBIT / BITGET / HL: fundingRate already populated by the venue fetcher (same bulk call).
}

function rankFunding(pool: ExchangeAsset[], rankBy: RankBy, topN: number): RankedAsset[] {
  const withFunding = pool.filter((a) => a.fundingRate !== undefined && Number.isFinite(a.fundingRate));
  // funding_negative → most-negative first (asc); funding_positive → most-positive first (desc).
  const asc = rankBy === 'funding_negative';
  const sorted = [...withFunding].sort((a, b) =>
    asc ? a.fundingRate! - b.fundingRate! : b.fundingRate! - a.fundingRate!,
  );
  return sorted.slice(0, topN).map((a) => ({
    coin: a.coin,
    rankBy,
    rank_value: a.fundingRate!,
    funding_rate: a.fundingRate!,
    funding_apr: annualizeFunding(a.fundingRate!, a.fundingIntervalHours),
  }));
}

// ── SCAN-RANKBY-W2: volatility (ATRP) — the heaviest lens (per-symbol klines) ──
// Computed on the top-RANK_ATRP_POOL_SIZE-by-OI pool ONLY (sort-then-slice), via a
// coalesced cache keyed `${exchange}:${timeframe}` with the SAME request-path-<1s
// guarantees as the OKX funding cache (loadTimeoutMs cold-serves an empty fallback;
// the load self-warms). No background warmer — the key space is exchange×timeframe
// (too many combos to pre-warm); the load self-warms on first request + the TTL holds.
const ATRP_POOL_SIZE = (() => {
  const raw = process.env.RANK_ATRP_POOL_SIZE;
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 50; // tighter than funding's 150 — klines are heavy
})();
const ATRP_TTL_MS = 2 * 60 * 1000; // candle-derived; ATRP barely moves intra-candle
const ATRP_CONCURRENCY = 6;
const ATRP_CANDLE_COUNT = 50; // ATR(14) needs 15; 50 → a well-converged Wilder ATR + venue-count buffer

/**
 * `coin → ATRP` for the top-by-OI pool on `${exchange}:${timeframe}`. Per pool coin:
 * `getAdapter(exchange).getCandles(coin, timeframe, …)` (the verdict-engine-proven
 * accessor — no new per-venue kline mapping) → `computeATRP`. Coalesced + bounded.
 */
const atrpCache = coalescedCache<Map<string, number>>({
  load: async (key) => {
    const [exchange, timeframe] = key.split(':') as [ExchangeId, string];
    const universe = await fetchVenueUniverse(exchange);
    const pool = universe.slice(0, ATRP_POOL_SIZE);
    const intervalMs = intervalMsFor(timeframe) ?? 900_000;
    const startTime = Date.now() - ATRP_CANDLE_COUNT * intervalMs;
    const adapter = getAdapter(exchange);
    const limiter = pLimit(ATRP_CONCURRENCY);
    const out = new Map<string, number>();
    await Promise.all(
      pool.map((a) =>
        limiter(async () => {
          try {
            const candles = await adapter.getCandles(a.coin, timeframe, startTime);
            const oldestFirst = [...candles].sort((c1, c2) => c1.time - c2.time);
            const atrp = computeATRP(oldestFirst);
            if (atrp !== null && Number.isFinite(atrp)) out.set(a.coin, atrp);
          } catch {
            /* skip — coin omitted from this round's ATRP rank */
          }
        }),
      ),
    );
    return out;
  },
  ttlMs: ATRP_TTL_MS,
  staleOk: true,
  loadTimeoutMs: 900, // cold: serve empty fallback < 1s, load self-warms the cache
  fallback: () => new Map<string, number>(),
  negativeTtlMs: 30_000,
  processGate: () => isShortLivedScript(process.argv[1]),
});

function getAtrpForPool(exchange: ExchangeId, timeframe: string): Promise<Map<string, number>> {
  return atrpCache.get(`${exchange}:${timeframe}`);
}

// ── SCAN-RANKBY-W3: oi_change — REAL OI delta over the self-maintained oi_snapshots store ──
// The hourly sampler (oi-snapshot-sampler.ts) is the warmer; this cache only memoizes the
// per-venue delta read (ONE DB query → computeOiDeltaForPool) for ~60s so a scan burst doesn't
// re-query. NO background warmer (the cron warms the store, not this). Request-path-<1s via
// loadTimeoutMs (cold-serves an empty map; the store is the source so the load is just a query).
const OI_CHANGE_TTL_MS = 60 * 1000;
const oiChangeCache = coalescedCache<Map<string, OiDelta>>({
  // SCAN-RANKBY-REFINEMENTS-W1 CH1: keyed `${exchange}:${window}` so 1h/4h/24h each
  // memoize independently (mirrors atrpCache's `${exchange}:${timeframe}` key).
  load: async (key) => {
    const [exchange, window] = key.split(':') as [ExchangeId, OiWindow];
    return computeOiDeltaForPool(exchange, OI_WINDOWS[window] ?? DEFAULT_OI_WINDOW_MS);
  },
  ttlMs: OI_CHANGE_TTL_MS,
  staleOk: true,
  loadTimeoutMs: 900,
  fallback: () => new Map<string, OiDelta>(),
  negativeTtlMs: 30_000,
  processGate: () => isShortLivedScript(process.argv[1]),
});

function getOiChangeForPool(
  exchange: ExchangeId,
  window: OiWindow = DEFAULT_OI_WINDOW,
): Promise<Map<string, OiDelta>> {
  return oiChangeCache.get(`${exchange}:${window}`);
}

/**
 * Select the top-`topN` perps on `exchange` by the `rankBy` lens. Returns the
 * ordered universe with each coin's rank metric. The scanner scores `coin`s in
 * this order and echoes the metric per call (except for the default `oi` lens).
 * Throws (via `fetchVenueUniverse`) on a non-promoted exchange.
 */
/** Test/canary seam: override the live universe fetch with a fixture (CH2 parity canary). */
let _universeFetcherOverride: ((exchange: ExchangeId) => Promise<ExchangeAsset[]>) | null = null;
export function _setUniverseFetcherForTest(fn: ((exchange: ExchangeId) => Promise<ExchangeAsset[]>) | null): void {
  _universeFetcherOverride = fn;
}

export async function getRankedUniverse(
  exchange: ExchangeId,
  rankBy: RankBy,
  topN: number,
  timeframe = '15m',
  opts: RankOptions = {},
): Promise<RankedAsset[]> {
  // SCAN-RANKBY-W2: volatility ranks the top-by-OI pool by ATRP on the scan timeframe,
  // served from the coalesced ATRP cache (which owns the pool + candle fetch — no `all`
  // fetch here). Echoed as `atrp` at output (never cached into the verdict cell).
  if (rankBy === 'volatility') {
    const atrpMap = await getAtrpForPool(exchange, timeframe);
    const sorted = [...atrpMap.entries()].sort((a, b) => b[1] - a[1]); // ATRP desc
    return sorted.slice(0, topN).map(([coin, atrp]) => ({ coin, rankBy, rank_value: atrp, atrp }));
  }

  // SCAN-RANKBY-W3: oi_change ranks the sampled pool by REAL OI delta from the oi_snapshots
  // store (computeOiDelta — the SAME source the get_trade_call factor reads, single-derivation).
  // Symbols still "warming" (< 2 snapshots spanning the window) are omitted. Echoed at output
  // (never cached into the verdict cell). The store IS the universe → no `all` fetch here.
  if (rankBy === 'oi_change') {
    const deltaMap = await getOiChangeForPool(exchange, opts.oiChangeWindow ?? DEFAULT_OI_WINDOW);
    const sorted = [...deltaMap.entries()].sort((a, b) => b[1].oi_change_pct - a[1].oi_change_pct); // OI %Δ desc
    return sorted.slice(0, topN).map(([coin, d]) => ({
      coin,
      rankBy,
      rank_value: d.oi_change_pct,
      oi_change_pct: d.oi_change_pct,
      oi_change_window: d.oi_change_window,
    }));
  }

  const all = await (_universeFetcherOverride ?? fetchVenueUniverse)(exchange);

  if (rankBy === 'oi') {
    // Already OI-desc from the fetcher — byte-identical to the historical default.
    return all.slice(0, topN).map((a) => ({ coin: a.coin, rankBy, rank_value: a.notionalOI_usd }));
  }

  if (rankBy === 'volume') {
    const sorted = [...all].sort((a, b) => b.volume24h_usd - a.volume24h_usd);
    return sorted
      .slice(0, topN)
      .map((a) => ({ coin: a.coin, rankBy, rank_value: a.volume24h_usd, volume_24h: a.volume24h_usd }));
  }

  if (rankBy === 'gainers' || rankBy === 'losers' || rankBy === 'movers') {
    const withChg = all.filter((a) => a.changePct24h !== undefined && Number.isFinite(a.changePct24h));
    const cmp =
      rankBy === 'losers'
        ? (a: ExchangeAsset, b: ExchangeAsset) => a.changePct24h! - b.changePct24h! // ascending (worst first)
        : rankBy === 'gainers'
          ? (a: ExchangeAsset, b: ExchangeAsset) => b.changePct24h! - a.changePct24h! // descending (best first)
          : (a: ExchangeAsset, b: ExchangeAsset) => Math.abs(b.changePct24h!) - Math.abs(a.changePct24h!); // |%| desc
    const sorted = [...withChg].sort(cmp);
    return sorted
      .slice(0, topN)
      .map((a) => ({ coin: a.coin, rankBy, rank_value: a.changePct24h!, change_24h_pct: a.changePct24h! }));
  }

  if (isFundingRank(rankBy)) {
    // SCAN-RANKBY-REFINEMENTS-W1 CH2: OKX ranks funding over the FULL universe when the
    // background-warmed full-universe funding cache is ready (lifts pfr/nfr beyond the
    // liquid pool). The other 4 venues keep the Q2-A uniform top-pool shortlist, and OKX
    // FAILS SOFT to that same shortlist when the full cache is cold/stale (no request-path
    // fan-out → the <1s request path is preserved).
    if (exchange === 'OKX') {
      const full = await getOkxFullFundingIfWarm();
      if (full) {
        for (const a of all) {
          const r = full.get(a.coin);
          if (r !== undefined) a.fundingRate = r;
        }
        return rankFunding(all, rankBy, topN); // FULL OKX universe, not the shortlist
      }
      // cold/stale → fall through to the shortlist path below (fail-soft)
    }
    const pool = all.slice(0, FUNDING_POOL_SIZE); // top-by-OI candidate pool (uniform shortlist)
    await augmentFunding(exchange, pool);
    return rankFunding(pool, rankBy, topN);
  }

  // Unreachable for a resolved RankBy; default to OI for total-function safety.
  return all.slice(0, topN).map((a) => ({ coin: a.coin, rankBy, rank_value: a.notionalOI_usd }));
}

/** Test seam: stop the OKX funding warmer + clear its cache + override between cases. */
export function _resetRankMetricsForTest(): void {
  if (okxFundingWarmer) {
    clearInterval(okxFundingWarmer);
    okxFundingWarmer = null;
  }
  okxFundingCache._clear();
  atrpCache._clear();
  oiChangeCache._clear();
  _universeFetcherOverride = null;
}
