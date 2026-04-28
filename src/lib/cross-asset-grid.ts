// ── Cross-asset / cross-timeframe signal grid (v1.9.0 L2/L4 activation patch) ──
//
// Pre-computes a 6×4 grid of trade signals (GRID_ASSETS × GRID_TIMEFRAMES) and
// exposes lazy, TTL-cached read APIs. Used by `get_trade_signal` to surface:
//   • L2 (HOLD Rescue):   `closest_tradeable` — the highest-confidence non-HOLD
//                         cell, excluding the requested (coin, timeframe).
//   • L4 (Next-Calls Hints): `try_next` — top-N highest-confidence non-HOLD
//                         cells, excluding the requested (coin, timeframe).
//
// Refresh strategy:
//   • Lazy: refresh on read when the snapshot is stale (>60s) or empty.
//   • Promise-coalesced: concurrent callers during a refresh share the same
//     in-flight promise instead of triggering parallel scorer fan-outs.
//   • Cell-isolated: a single scorer throw cannot crash the entire refresh —
//     failed cells are logged at debug level and skipped.

import { AsyncLocalStorage } from 'node:async_hooks';
import pLimit from 'p-limit';
import type { GridCell } from '../types.js';
import { getTradeSignal } from '../tools/get-trade-call.js';

export const GRID_ASSETS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'] as const;
export const GRID_TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const;
const GRID_TTL_MS = 60_000;

// LATENCY-W1 C2: parallelize the 24-cell refresh fan-out.
// Concurrency = 6 → peak ~12 simultaneous HL roundtrips (each cell = candles +
// assetCtx parallel). HL rate limit is 50 req/s, so 12 leaves ~76% headroom.
// Higher would shorten refresh further but risks tripping HL throttle, which
// the previous SKILLS-W1 smoke runs proved is real (HTTP 200 + isError=true
// 'HL API 429: Too Many Requests' shape).
const GRID_CONCURRENCY = 6;

// ── Module-private state ──
let cachedSnapshot: GridCell[] | null = null;
let cachedAt: number = 0;
let inflight: Promise<void> | null = null;

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
    // LATENCY-W1 C2: parallelize 24 cells inside the SAME refreshContext.run
    // scope. The AsyncLocalStorage flag at line 46 propagates through every
    // p-limit task because pLimit just calls the wrapped fn (Node carries the
    // ALS context across `.then()` continuations). This means each cell's
    // `getTradeSignal({ internal: true })` call to its enrichment path will
    // see refreshContext.getStore() === true and return cached snapshot
    // (possibly empty) instead of recursing into refreshGrid.
    const limit = pLimit(GRID_CONCURRENCY);
    const tasks = GRID_ASSETS.flatMap((coin) =>
      GRID_TIMEFRAMES.map((timeframe) =>
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
              signal: result.signal,
              confidence: result.confidence,
              exchange: 'HL' as const,
              regime: result.regime,
            };
          } catch (err) {
            // Cell failure isolation — log at debug level, skip the cell, do NOT
            // propagate so one scorer throw can't crash the entire grid.
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
