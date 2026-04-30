// ── Cross-asset / cross-timeframe signal grid (v1.9.0 L2/L4 activation patch) ──
//
// Pre-computes a 6×7 grid of trade signals (GRID_ASSETS × GRID_TIMEFRAMES) and
// exposes lazy, TTL-cached read APIs. Used by `get_trade_signal` to surface:
//   • L2 (HOLD Rescue):   `closest_tradeable` — the highest-confidence non-HOLD
//                         cell, excluding the requested (coin, timeframe).
//   • L4 (Next-Calls Hints): `try_next` — top-N highest-confidence non-HOLD
//                         cells, excluding the requested (coin, timeframe).
//
// SHADOW-SEED-W1 (2026-04-30): GRID_TIMEFRAMES re-sized from the v1.9.0
// logarithmic ladder ['5m','15m','1h','4h'] to ['1m','3m','5m','15m','30m','1h','2h']
// based on EMPIRICAL CALL DISTRIBUTION (byAsset.count rankings show users
// concentrate on intraday/scalping horizons; 4h is rank #6 with 2,124 calls
// while 30m is rank #4 with 6,429 and 2h is rank #5 with 5,748). Net delta:
// +1m, +3m, +30m, +2h, -4h.
//
// Refresh strategy:
//   • Lazy: refresh on read when the snapshot is stale (>60s) or empty.
//   • Promise-coalesced: concurrent callers during a refresh share the same
//     in-flight promise instead of triggering parallel scorer fan-outs.
//   • Cell-isolated: a single scorer throw cannot crash the entire refresh —
//     failed cells are logged at debug level and skipped.
//   • Slow-grid circuit breaker (SHADOW-SEED-W1): if 3 consecutive refreshes
//     each exceed 30s, fall back to FALLBACK_TIMEFRAMES (the v1.9.0 set) for
//     1 hour, then retry full grid. Telegram WARNING on every fallback.

import { AsyncLocalStorage } from 'node:async_hooks';
import pLimit from 'p-limit';
import type { GridCell } from '../types.js';
import { getTradeSignal } from '../tools/get-trade-call.js';
import { UpstreamRateLimitError } from './errors.js';
import { sendAlert } from './telegram.js';

export const GRID_ASSETS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'] as const;

/**
 * SHADOW-SEED-W1: full grid (42 cells = 6 assets × 7 timeframes). Used when
 * the slow-grid circuit breaker is closed (default). When tripped, the grid
 * temporarily collapses to FALLBACK_TIMEFRAMES (24 cells, the v1.9.0 set).
 */
export const GRID_TIMEFRAMES_FULL = ['1m', '3m', '5m', '15m', '30m', '1h', '2h'] as const;

/** v1.9.0 set — used as the slow-grid fallback when 3 consecutive refreshes >30s. */
export const FALLBACK_TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const;

/**
 * Live grid timeframes. Resolved at refresh time from the circuit breaker
 * state — `GRID_TIMEFRAMES_FULL` when closed (default), `FALLBACK_TIMEFRAMES`
 * when open. Exported as a function for runtime resolution; tests can read
 * the current set via `getActiveGridTimeframes()`.
 */
export function getActiveGridTimeframes(): readonly string[] {
  return circuitOpenUntil > Date.now() ? FALLBACK_TIMEFRAMES : GRID_TIMEFRAMES_FULL;
}

/**
 * Back-compat re-export: existing consumers (tests, observability) read
 * GRID_TIMEFRAMES as the canonical full set. The runtime active set is
 * resolved via `getActiveGridTimeframes()` at refresh time.
 */
export const GRID_TIMEFRAMES = GRID_TIMEFRAMES_FULL;
const GRID_TTL_MS = 60_000;

// LATENCY-W1 C2 (updated SHADOW-SEED-W1 for 42-cell fan-out):
// Concurrency = 6 → peak ~12 simultaneous HL roundtrips (each cell = candles +
// assetCtx parallel). HL rate limit is 50 req/s, so 12 leaves ~76% headroom.
// 42 cells / 6 concurrency × ~1s/cell = ~7s projected refresh time (vs ~4s
// for the prior 24-cell grid). The slow-grid circuit breaker catches the
// case where this projection is too optimistic (e.g. 1m candle endpoints
// turn out slower than 5m+).
const GRID_CONCURRENCY = 6;

// SHADOW-SEED-W1 slow-grid circuit breaker.
// If the last 3 refresh durations all exceeded SLOW_REFRESH_THRESHOLD_MS,
// the breaker opens for CIRCUIT_OPEN_DURATION_MS — during which the grid
// uses FALLBACK_TIMEFRAMES (24 cells) instead of the full 42. Resets after
// the open duration; one full-grid retry attempt; tripping again re-opens.
const SLOW_REFRESH_THRESHOLD_MS = 30_000;       // 30s per refresh
const CIRCUIT_OPEN_DURATION_MS = 60 * 60_000;   // 1 hour
const REFRESH_HISTORY_SIZE = 3;
let refreshDurations: number[] = [];            // FIFO, max length REFRESH_HISTORY_SIZE
let circuitOpenUntil: number = 0;

// ── Module-private state ──
let cachedSnapshot: GridCell[] | null = null;
let cachedAt: number = 0;
let inflight: Promise<void> | null = null;

// v1.10.2: HL-429 self-DoS guard.
// Every grid cell scores via HL (`exchange: 'HL'` is hardcoded at line ~95).
// When HL upstream rate-limits us, the warmer's 50s tick keeps hammering 24
// cells per cycle, prolonging the rate-limit window. Backoff: when ≥50% of a
// refresh cycle's cells fail with UpstreamRateLimitError, pause the warmer
// for an exponentially-growing window (5min → 10 → 20 → 40 → cap 60min).
// First successful refresh resets the backoff counter to 0.
const RATE_LIMIT_BACKOFF_BASE_MS = 5 * 60 * 1000;   // 5 min
const RATE_LIMIT_BACKOFF_MAX_MS  = 60 * 60 * 1000;  // 60 min cap
const RATE_LIMIT_FAILURE_THRESHOLD = 0.5;           // ≥50% of cells 429-ing → trip
let rateLimitPausedUntil: number = 0;
let rateLimitConsecutiveTrips: number = 0;

/** Test seam — reset the backoff state. Used by unit tests + scheduled-task warmups. */
export function _resetRateLimitBackoff(): void {
  rateLimitPausedUntil = 0;
  rateLimitConsecutiveTrips = 0;
}

/**
 * SHADOW-SEED-W1 test seam — reset the slow-grid circuit breaker state. Used
 * by unit tests + diagnostics to deterministically open/close the circuit.
 */
export function _resetCircuitBreaker(): void {
  refreshDurations = [];
  circuitOpenUntil = 0;
}

/** SHADOW-SEED-W1 test seam — push synthetic refresh durations to drive the breaker. */
export function _pushRefreshDurationForTest(ms: number): void {
  refreshDurations.push(ms);
  if (refreshDurations.length > REFRESH_HISTORY_SIZE) refreshDurations.shift();
}

/** SHADOW-SEED-W1 test seam — directly trip the breaker without 3 slow refreshes. */
export function _tripCircuitBreakerForTest(): void {
  circuitOpenUntil = Date.now() + CIRCUIT_OPEN_DURATION_MS;
}

/** Read-only inspector for the module-level cache + backoff state — used by tests + diagnostics. */
export function _getCacheSnapshotMeta(): {
  hasSnapshot: boolean;
  cellCount: number;
  cachedAt: number;
  rateLimitPausedUntil: number;
  rateLimitConsecutiveTrips: number;
  refreshDurations: number[];
  circuitOpenUntil: number;
  activeTimeframes: readonly string[];
} {
  return {
    hasSnapshot: cachedSnapshot !== null,
    cellCount: cachedSnapshot?.length ?? 0,
    cachedAt,
    rateLimitPausedUntil,
    rateLimitConsecutiveTrips,
    refreshDurations: [...refreshDurations],
    circuitOpenUntil,
    activeTimeframes: getActiveGridTimeframes(),
  };
}

/**
 * Re-entry guard tied to the async causal chain via `AsyncLocalStorage`.
 *
 * `get_trade_signal` now calls `getGridSnapshot()` to surface try_next /
 * closest_tradeable, and the grid refresh itself calls `getTradeSignal` per
 * cell to reuse the exact R1–R6 scorer path. That creates a cycle:
 *   refreshGrid → getTradeSignal → getGridSnapshot → refreshGrid → …
 *
 * A simple module-level boolean would incorrectly short-circuit *parallel*
 * callers that arrive during an in-flight refresh (they'd see `true` and
 * return an empty snapshot instead of awaiting the inflight promise). Using
 * `AsyncLocalStorage` scopes the flag to the async causal chain spawned by
 * `refreshGrid`, so only calls truly originating from inside a refresh
 * short-circuit; unrelated parallel callers on separate async chains
 * continue to wait on the inflight promise as intended.
 */
const refreshContext = new AsyncLocalStorage<true>();

// Test seam: when set, refresh consults this synthetic scorer instead of the
// real `getTradeSignal`. Lets tests run deterministically offline.
type ScorerFn = (coin: string, timeframe: string) => Promise<GridCell | null>;
let _scorerOverride: ScorerFn | null = null;

async function refreshGrid(): Promise<void> {
  return refreshContext.run(true, async () => {
    // LATENCY-W1 C2 (updated SHADOW-SEED-W1): parallelize 42 cells (or 24 in
    // fallback mode) inside the SAME refreshContext.run scope. The
    // AsyncLocalStorage flag propagates through every p-limit task because
    // pLimit just calls the wrapped fn (Node carries the ALS context across
    // `.then()` continuations). This means each cell's
    // `getTradeSignal({ internal: true })` call to its enrichment path will
    // see refreshContext.getStore() === true and return cached snapshot
    // (possibly empty) instead of recursing into refreshGrid.
    const refreshStartAt = Date.now();
    const activeTimeframes = getActiveGridTimeframes();
    const limit = pLimit(GRID_CONCURRENCY);
    let rateLimitFailures = 0;  // v1.10.2: per-refresh 429 tally
    const tasks = GRID_ASSETS.flatMap((coin) =>
      activeTimeframes.map((timeframe) =>
        limit(async (): Promise<GridCell | null> => {
          try {
            const override = _scorerOverride;
            if (override) {
              return await override(coin, timeframe);
            }
            // `internal: true` bypasses the free-tier license gate (so the
            // grid can score SOL/BNB/XRP/DOGE and 5m/4h regardless of the
            // ambient request's tier), and skips trackCall/recordSignal/
            // recordHoldCount persistence (so 24 cells/minute don't pollute
            // the per-agent quota counters or the performance-db track
            // record with duplicate synthetic signals).
            const result = await getTradeSignal({ coin, timeframe, internal: true });
            return {
              coin,
              timeframe,
              // GridCell carries `signal` (internal cross-asset score field, NOT the
              // public-facing `call`); same value, kept for back-compat with the
              // existing scoring/filtering helpers in this module.
              signal: result.call,
              confidence: result.confidence,
              exchange: 'HL' as const,
              regime: result.regime,
            };
          } catch (err) {
            // Cell failure isolation — log at debug level, skip the cell, do NOT
            // propagate so one scorer throw can't crash the entire grid.
            // v1.10.2: count 429s separately so we can trip the warmer's
            // exponential backoff and stop self-DoS-ing the upstream API.
            if (err instanceof UpstreamRateLimitError) {
              rateLimitFailures++;
            }
            console.debug(
              `[cross-asset-grid] cell skipped: ${coin}/${timeframe}:`,
              err instanceof Error ? err.message : err
            );
            return null;
          }
        })
      )
    );
    const results = await Promise.all(tasks);
    cachedSnapshot = results.filter((c): c is GridCell => c !== null);
    cachedAt = Date.now();

    // SHADOW-SEED-W1: record this refresh's duration; trip the slow-grid
    // circuit breaker if 3 consecutive refreshes all exceed the threshold.
    const refreshDurationMs = cachedAt - refreshStartAt;
    refreshDurations.push(refreshDurationMs);
    if (refreshDurations.length > REFRESH_HISTORY_SIZE) refreshDurations.shift();
    const allSlow = refreshDurations.length === REFRESH_HISTORY_SIZE &&
      refreshDurations.every((d) => d > SLOW_REFRESH_THRESHOLD_MS);
    if (allSlow && circuitOpenUntil <= Date.now()) {
      circuitOpenUntil = Date.now() + CIRCUIT_OPEN_DURATION_MS;
      const measured = refreshDurations.map((d) => `${(d / 1000).toFixed(1)}s`).join(', ');
      console.warn(
        `[cross-asset-grid] slow-grid circuit breaker TRIPPED — ` +
        `last ${REFRESH_HISTORY_SIZE} refreshes [${measured}] all > ${SLOW_REFRESH_THRESHOLD_MS / 1000}s. ` +
        `Falling back to ${FALLBACK_TIMEFRAMES.length}-timeframe grid (${FALLBACK_TIMEFRAMES.join(',')}) for ${CIRCUIT_OPEN_DURATION_MS / 60_000}min.`
      );
      sendAlert(
        `Cross-asset grid slow-grid circuit breaker TRIPPED.\n` +
        `Last ${REFRESH_HISTORY_SIZE} refreshes: ${measured}\n` +
        `Falling back to ${FALLBACK_TIMEFRAMES.join(',')} for ${CIRCUIT_OPEN_DURATION_MS / 60_000}min.`,
        'warning',
      ).catch(() => { /* swallow */ });
      // Reset history so post-fallback re-evaluation starts fresh.
      refreshDurations = [];
    }

    // v1.10.2: trip / reset the warmer-pause backoff based on this cycle's
    // 429 ratio. Runs AFTER cell results land so a partial grid is still
    // usable for the rest of the deprecation window even when we trip.
    const totalCells = GRID_ASSETS.length * activeTimeframes.length;
    const failureRatio = rateLimitFailures / totalCells;
    if (failureRatio >= RATE_LIMIT_FAILURE_THRESHOLD) {
      rateLimitConsecutiveTrips++;
      // Exponential: 5 → 10 → 20 → 40 → 60 (capped). 2^(n-1) × base.
      const exp = Math.min(rateLimitConsecutiveTrips - 1, 5);
      const backoffMs = Math.min(RATE_LIMIT_BACKOFF_BASE_MS * (1 << exp), RATE_LIMIT_BACKOFF_MAX_MS);
      rateLimitPausedUntil = Date.now() + backoffMs;
      console.warn(
        `[cross-asset-grid] HL upstream rate-limited (${rateLimitFailures}/${totalCells} cells 429). ` +
        `Pausing warmer for ${Math.round(backoffMs / 60_000)}min ` +
        `(consecutive-trip #${rateLimitConsecutiveTrips}). Use a different exchange via direct calls in the meantime.`
      );
    } else if (rateLimitFailures === 0 && rateLimitConsecutiveTrips > 0) {
      // Clean refresh after a backoff — reset.
      console.log(`[cross-asset-grid] HL rate-limit cleared after ${rateLimitConsecutiveTrips} trip(s); warmer resumes normal cadence.`);
      rateLimitConsecutiveTrips = 0;
      rateLimitPausedUntil = 0;
    }
  });
}

/**
 * LATENCY-W1 C3: thin wrapper used by the background warmer in src/index.ts.
 * Returns immediately if cache is fresh; otherwise triggers refresh (with the
 * same in-flight coalescing as `getGridSnapshot`). Idempotent under concurrent
 * calls — N concurrent invocations share one refresh, not N.
 */
export async function refreshGridIfStale(): Promise<void> {
  const now = Date.now();
  if (cachedSnapshot !== null && now - cachedAt <= GRID_TTL_MS) return;
  // v1.10.2: respect the rate-limit-backoff pause. If we're inside the
  // backoff window, return immediately (existing stale snapshot stays
  // visible to consumers; better than running 24 cells we KNOW will 429).
  if (rateLimitPausedUntil > now) return;
  if (inflight === null) {
    inflight = refreshGrid().finally(() => {
      inflight = null;
    });
  }
  await inflight;
}

/**
 * Returns the full pre-computed grid snapshot. Refreshes lazily when stale
 * (>60s) or when no snapshot has ever been computed. Concurrent callers
 * share a single in-flight refresh via promise coalescing.
 *
 * Re-entrancy: when called recursively from within a grid refresh (i.e.
 * `getTradeSignal` → enrichment → `getGridSnapshot`), returns the current
 * snapshot (possibly empty) immediately without re-triggering the refresh.
 * Detection is via `AsyncLocalStorage` so parallel non-re-entrant callers
 * during an in-flight refresh fall through to the inflight-wait path.
 */
export async function getGridSnapshot(): Promise<GridCell[]> {
  if (refreshContext.getStore() === true) {
    return cachedSnapshot ?? [];
  }
  const now = Date.now();
  if (cachedSnapshot !== null && now - cachedAt <= GRID_TTL_MS) {
    return cachedSnapshot;
  }
  if (inflight === null) {
    inflight = refreshGrid().finally(() => {
      inflight = null;
    });
  }
  await inflight;
  return cachedSnapshot ?? [];
}

/**
 * Returns the single highest-confidence non-HOLD cell from the grid,
 * excluding the given (coin, timeframe) key. Returns `null` when no
 * non-HOLD cell is available.
 */
export async function getClosestTradeable(
  exclude: { coin: string; timeframe: string }
): Promise<GridCell | null> {
  const snapshot = await getGridSnapshot();
  const candidates = snapshot.filter(
    (cell) =>
      cell.signal !== 'HOLD' &&
      !(cell.coin === exclude.coin && cell.timeframe === exclude.timeframe)
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, cell) =>
    cell.confidence > best.confidence ? cell : best
  );
}

/**
 * Returns the top-N highest-confidence non-HOLD cells from the grid (sorted
 * descending by confidence), excluding the given (coin, timeframe) key.
 */
export async function getTryNext(
  exclude: { coin: string; timeframe: string },
  n: number = 3
): Promise<GridCell[]> {
  const snapshot = await getGridSnapshot();
  return snapshot
    .filter(
      (cell) =>
        cell.signal !== 'HOLD' &&
        !(cell.coin === exclude.coin && cell.timeframe === exclude.timeframe)
    )
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, n);
}

// ── Test seams ──
// These are exported but underscore-prefixed to mark them as non-public.
// They exist so tests can inject deterministic state without going through
// the real scorer (which hits live exchange APIs).

export function _setSnapshotForTest(cells: GridCell[] | null, nowMs?: number): void {
  cachedSnapshot = cells;
  cachedAt = nowMs ?? Date.now();
}

export function _clearCache(): void {
  cachedSnapshot = null;
  cachedAt = 0;
  inflight = null;
  // refreshContext is AsyncLocalStorage-scoped — no manual reset needed.
}

export function _getScorerOverride(): ScorerFn | null {
  return _scorerOverride;
}

export function _setScorerOverride(fn: ScorerFn | null): void {
  _scorerOverride = fn;
}
