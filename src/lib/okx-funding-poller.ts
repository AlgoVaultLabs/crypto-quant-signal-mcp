/**
 * okx-funding-poller.ts — SCAN-RANKBY-REFINEMENTS-W1 CH2
 *
 * OKX has NO bulk funding endpoint (`funding-rate?instType=SWAP` → 50014), so the
 * W1 Q2-A `okxFundingCache` (rank-metrics.ts) fetches funding per-instId for ONLY
 * the top-`FUNDING_POOL_SIZE`-by-OI shortlist. CH2 lifts the OKX funding lenses
 * (pfr/nfr) to the FULL OKX SWAP universe via a SEPARATE in-process coalesced cache
 * + background warmer (architect Q1=A, 2026-06-28):
 *
 *   • The long-lived MCP server warms the full-universe `coin → funding` map in the
 *     BACKGROUND (a setInterval warmer, off the request path) — never a cron, never
 *     a new table. Mirrors `okxFundingCache`'s coalesced/stale contract; the only
 *     difference is the universe is the FULL `fetchVenueUniverse('OKX')`, not a slice.
 *   • The request path reads via `getOkxFullFundingIfWarm()`, which returns the map
 *     ONLY when a freshness heartbeat says it's warm — it NEVER triggers the
 *     per-instId fan-out on the request path. Cold/stale ⇒ `null` ⇒ the caller
 *     FAILS SOFT to the existing top-pool shortlist (the <1s request path preserved).
 *   • Short-lived crons/CLI (`isShortLivedScript`) never warm → they always get the
 *     shortlist fallback (acceptable: scan-showcase/seed reach the lens through the
 *     long-lived server in production).
 *
 * Reuses the shared OKX budget (`VENUE_FETCH_CONFIGS.OKX`, ~20 req/2s per-IP — live
 * 2026-06-28) + a bounded `pLimit` so the ~401-instId sweep respects the rate limit.
 * Instant rollback: `RANK_OKX_FULL_FUNDING=0` ⇒ always the shortlist.
 */

import pLimit from 'p-limit';
import { fetchVenueUniverse } from './exchange-universe.js';
import { toOKXInstId } from './adapters/okx.js';
import { upstreamFetch, VENUE_FETCH_CONFIGS } from './adapters/_upstream-fetch.js';
import { coalescedCache } from './coalesced-cache.js';
import { isShortLivedScript } from './runtime.js';

/** Full sweep is heavier than the 150-shortlist → a 5-min cache (funding is hourly). */
const OKX_FULL_FUNDING_TTL_MS = 5 * 60 * 1000;
/** Bounded by the shared OKX budget (20 req/2s per-IP); conservative for the ~401 sweep. */
const OKX_FULL_FUNDING_CONCURRENCY = 6;
/** Instant rollback lever — `=0` disables the full-universe path (→ shortlist everywhere). */
const OKX_FULL_FUNDING_ENABLED = process.env.RANK_OKX_FULL_FUNDING !== '0';

let _lastWarmAt = 0; // epoch ms of the last successful warm (0 = never)
let _lastSize = 0; // coins in the last warm

/**
 * `coin → per-interval funding fraction` for the FULL OKX SWAP universe. Loaded
 * per-instId via the shared OKX budget, single-flighted + stale-served. The warmer
 * (not the request path) drives the fan-out; `loadTimeoutMs` bounds any direct get.
 */
const okxFullFundingCache = coalescedCache<Map<string, number>>({
  load: async () => {
    const universe = await fetchVenueUniverse('OKX'); // FULL universe — no slice
    const limiter = pLimit(OKX_FULL_FUNDING_CONCURRENCY);
    const out = new Map<string, number>();
    await Promise.all(
      universe.map((a) =>
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
    _lastWarmAt = Date.now();
    _lastSize = out.size;
    return out;
  },
  ttlMs: OKX_FULL_FUNDING_TTL_MS,
  staleOk: true,
  loadTimeoutMs: 900, // any direct cold get serves the empty fallback < 1s
  fallback: () => new Map<string, number>(),
  negativeTtlMs: 60_000,
  processGate: () => isShortLivedScript(process.argv[1]),
});

let okxFullFundingWarmer: ReturnType<typeof setInterval> | null = null;

/** Lazily start the full-universe OKX funding background warmer (long-lived server only). */
export function ensureOkxFullFundingWarmer(): void {
  if (!OKX_FULL_FUNDING_ENABLED) return;
  if (okxFullFundingWarmer) return;
  if (isShortLivedScript(process.argv[1])) return; // crons/CLI serve the shortlist, never warm
  okxFullFundingCache.get('okx').catch(() => {}); // warm now (fire-and-forget)
  okxFullFundingWarmer = setInterval(() => {
    okxFullFundingCache.get('okx').catch(() => {});
  }, Math.floor(OKX_FULL_FUNDING_TTL_MS * 0.83));
  okxFullFundingWarmer.unref?.();
}

/**
 * The full-universe OKX funding map IF the bg warmer has it warm; else `null` so the
 * caller falls back to the top-pool shortlist. NEVER fans out on the request path:
 * a cold/stale heartbeat returns `null` immediately (kicking the bg warmer), so the
 * <1s request path is preserved.
 */
export async function getOkxFullFundingIfWarm(): Promise<Map<string, number> | null> {
  if (!OKX_FULL_FUNDING_ENABLED) return null;
  ensureOkxFullFundingWarmer(); // idempotent; starts the bg warm if not running
  const fresh = _lastWarmAt > 0 && Date.now() - _lastWarmAt < OKX_FULL_FUNDING_TTL_MS && _lastSize > 0;
  if (!fresh) return null; // cold/stale → shortlist fallback (no request-path fan-out)
  return okxFullFundingCache.get('okx'); // warm → cached map, returned instantly (no load)
}

/** Freshness heartbeat (the sampler-freshness pattern): last warm + size + age. */
export function okxFullFundingFreshness(): { lastWarmAt: number; size: number; ageMs: number; enabled: boolean } {
  return {
    lastWarmAt: _lastWarmAt,
    size: _lastSize,
    ageMs: _lastWarmAt ? Date.now() - _lastWarmAt : Infinity,
    enabled: OKX_FULL_FUNDING_ENABLED,
  };
}

/** Test seam: stop the warmer + clear the cache + reset the heartbeat. */
export function _resetOkxFullFundingForTest(): void {
  if (okxFullFundingWarmer) {
    clearInterval(okxFullFundingWarmer);
    okxFullFundingWarmer = null;
  }
  okxFullFundingCache._clear();
  _lastWarmAt = 0;
  _lastSize = 0;
}

/** Test seam: drive one warm synchronously (await the load) + report the size. */
export async function _warmOkxFullFundingForTest(): Promise<number> {
  await okxFullFundingCache.get('okx');
  return _lastSize;
}
