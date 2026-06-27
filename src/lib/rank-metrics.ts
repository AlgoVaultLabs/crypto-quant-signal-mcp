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

/**
 * Select the top-`topN` perps on `exchange` by the `rankBy` lens. Returns the
 * ordered universe with each coin's rank metric. The scanner scores `coin`s in
 * this order and echoes the metric per call (except for the default `oi` lens).
 * Throws (via `fetchVenueUniverse`) on a non-promoted exchange.
 */
export async function getRankedUniverse(
  exchange: ExchangeId,
  rankBy: RankBy,
  topN: number,
): Promise<RankedAsset[]> {
  const all = await fetchVenueUniverse(exchange);

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
    const pool = all.slice(0, FUNDING_POOL_SIZE); // top-by-OI candidate pool (uniform shortlist)
    await augmentFunding(exchange, pool);
    return rankFunding(pool, rankBy, topN);
  }

  // Unreachable for a resolved RankBy; default to OI for total-function safety.
  return all.slice(0, topN).map((a) => ({ coin: a.coin, rankBy, rank_value: a.notionalOI_usd }));
}

/** Test seam: stop the OKX funding warmer + clear its cache between cases. */
export function _resetRankMetricsForTest(): void {
  if (okxFundingWarmer) {
    clearInterval(okxFundingWarmer);
    okxFundingWarmer = null;
  }
  okxFundingCache._clear();
}
