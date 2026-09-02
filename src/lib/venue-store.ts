/**
 * venue-store.ts — postgres-backed CRUD for the `venues` lifecycle table.
 *
 * EXCHANGE-SHADOW-PROMOTE-W1 / C1. The `venues` table is the canonical
 * registry of every exchange integration and its lifecycle state
 * (shadow → promoted → retired). This module owns ALL reads/writes against
 * that table; downstream consumers (`evaluate-venues` cron in C3, the
 * `/api/performance-shadow` handler in C4, the MCP `_algovault.venue_status`
 * envelope field in C2) MUST go through these helpers, never raw SQL.
 *
 * Idempotency: `initVenuesTable()` is safe to call multiple times — runs the
 * same `CREATE TABLE IF NOT EXISTS` + backfill-INSERT-ON-CONFLICT-DO-NOTHING
 * SQL as `migrations/002_venues_table.sql` + `migrations/003_seed_venues_promoted.sql`.
 * Wired into a single per-process init flag so any consumer that calls
 * `getVenue` / `listVenues` / `setStatus` triggers a one-shot bootstrap on
 * first call. The standalone `.sql` files in `migrations/` remain the
 * canonical operator/audit reference (run via PUBLISH.md / docs/RUNBOOK-*
 * for explicit one-off ops).
 */

import { dbExec, dbQuery, dbRun } from './performance-db.js';
import { PROMOTED_VENUE_IDS, type PromotedVenueId } from './capabilities.js';
import type { VenueRecord, VenueStatus } from '../types.js';

// ── Idempotent schema bootstrap ──────────────────────────────────────────

const CREATE_VENUES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS venues (
    exchange_id           TEXT PRIMARY KEY,
    status                TEXT NOT NULL CHECK (status IN ('shadow', 'promoted', 'retired')),
    asset_count           INTEGER NOT NULL CHECK (asset_count > 0),
    min_buy_sell_sample   INTEGER NOT NULL CHECK (min_buy_sell_sample > 0),
    integrated_at         TIMESTAMPTZ NOT NULL,
    promoted_at           TIMESTAMPTZ,
    retired_at            TIMESTAMPTZ,
    extension_count       INTEGER NOT NULL DEFAULT 0 CHECK (extension_count >= 0 AND extension_count <= 2),
    last_eval_at          TIMESTAMPTZ,
    last_eval_pfe_wr      REAL,
    last_eval_buy_sell_count INTEGER,
    -- OPS-SHADOW-ALERT-HYGIENE-W1 (2026-06-01): nullable clock anchor. When a
    -- venue's seed pipeline actually starts producing signals, OPS-SHADOW-
    -- PIPELINE-W1 (C3) stamps this with the first-signal timestamp; the
    -- promotion clock then derives from COALESCE(seeding_started_at,
    -- integrated_at). NULL until then → clock harmlessly falls back to
    -- integrated_at. Pre-applied to prod via
    -- migrations/004_add_seeding_started_at.sql (ADD COLUMN IF NOT EXISTS).
    seeding_started_at    TIMESTAMPTZ,
    -- OPS-VENUE-DAY30-DECISION-W1 (2026-08-03): the DECISION DEADLINE, kept
    -- deliberately separate from the MEASUREMENT FLOOR above. seeding_started_at
    -- answers "where does measurement start" and an extension must NEVER touch it;
    -- this answers "when is a human decision next due" and is the ONE field gating
    -- the day-30 manual_required alert. Two writers (the evaluate-venues cron's
    -- auto-deferral throttle, and an explicit operator extension via
    -- extend-venue.ts), one field, one meaning — NOT a second last_alert_at
    -- column, because two predicates on one question is how they drift.
    -- (No backticks in this comment: it lives inside a JS template literal.)
    -- NULL = a decision is due now. Pre-applied to prod via
    -- migrations/025_add_review_deadline_at.sql (ADD COLUMN IF NOT EXISTS).
    review_deadline_at    TIMESTAMPTZ,
    notes                 TEXT
  );
`;

const CREATE_VENUES_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_venues_status ON venues(status);
`;

// OPS-VENUE-DAY30-DECISION-W1: idempotent ALTER for deployments whose `venues`
// table predates `review_deadline_at`. `CREATE TABLE IF NOT EXISTS` above does
// NOT add a column to an existing table, so a live DB needs this separately.
//
// Split per backend, mirroring the established pattern in analytics.ts /
// geo-gap-list.ts / candle-basis-shadow.ts (NOT an information_schema pre-check
// — that would be a third serialization of an idiom this repo already has, and
// an awaited read here could race the fire-and-forget dbExec(CREATE) above on a
// fresh DB). PG: IF NOT EXISTS → idempotent no-op. SQLite: bare, because SQLite
// has NO `ADD COLUMN IF NOT EXISTS` (verified 3.49 in DASH-EXTERNAL-ONLY-W1-
// PATCH-A) and throws "duplicate column" on re-run — caught by the dedicated
// try/catch in initVenuesTable().
const ALTER_REVIEW_DEADLINE_SQL = process.env.DATABASE_URL
  ? `ALTER TABLE venues ADD COLUMN IF NOT EXISTS review_deadline_at TIMESTAMPTZ;`
  : `ALTER TABLE venues ADD COLUMN review_deadline_at TIMESTAMPTZ;`;

// Mirrors migrations/003_seed_venues_promoted.sql verbatim — see that file's
// header for the `asset_count` semantics note (cosmetic for already-promoted
// venues; binding gate-target for shadow venues added in C5+).
const SEED_PROMOTED_VENUES_SQL = `
  INSERT INTO venues (
    exchange_id,
    status,
    asset_count,
    min_buy_sell_sample,
    integrated_at,
    promoted_at,
    extension_count,
    notes
  )
  SELECT
    exchange_id,
    'promoted'::TEXT AS status,
    asset_count,
    asset_count * 10 AS min_buy_sell_sample,
    to_timestamp(integrated_at_unix) AS integrated_at,
    NOW() AS promoted_at,
    0 AS extension_count,
    'Backfilled by venue-store.initVenuesTable; asset_count = COUNT(DISTINCT coin) seeded historically (cosmetic; promoted-state machine never re-gates these)' AS notes
  FROM (
    SELECT exchange AS exchange_id,
           COUNT(DISTINCT coin) AS asset_count,
           MIN(created_at) AS integrated_at_unix
    FROM signals
    WHERE exchange IN ('HL', 'BINANCE', 'BYBIT', 'OKX', 'BITGET')
    GROUP BY exchange
  ) AS seed
  ON CONFLICT (exchange_id) DO NOTHING;
`;

let initialized = false;

/**
 * Idempotent one-shot bootstrap. First call creates the table + index +
 * backfills the 5 existing promoted venues. Subsequent calls are cheap
 * no-ops via the `initialized` flag (re-running CREATE/INSERT on each call
 * would also be safe per IF-NOT-EXISTS + ON-CONFLICT, but skipping avoids
 * burning postgres round-trips).
 */
export async function initVenuesTable(): Promise<void> {
  if (initialized) return;
  dbExec(CREATE_VENUES_TABLE_SQL);
  // OPS-VENUE-DAY30-DECISION-W1: own try/catch, deliberately — a SQLite
  // "duplicate column" throw here must not skip the index creation below.
  // Ordered AFTER the CREATE and issued through the same dbExec queue, so it
  // cannot race the table's existence on a fresh DB.
  try {
    dbExec(ALTER_REVIEW_DEADLINE_SQL);
  } catch {
    // Column already present (SQLite re-run). PG's IF NOT EXISTS never throws.
  }
  dbExec(CREATE_VENUES_INDEX_SQL);
  // SEED_PROMOTED_VENUES_SQL depends on the `signals` table being non-empty
  // (production case). Wrapped in try/catch so fresh-dev-DB / empty-signals
  // scenarios don't blow up consumers — they'll just see 0 rows.
  try {
    await dbQuery(SEED_PROMOTED_VENUES_SQL);
  } catch (err) {
    // Non-fatal: log + continue. The table exists; consumers querying it
    // will see 0 rows until the seed eventually succeeds (or a manual ops
    // run via migrations/003_seed_venues_promoted.sql).
    console.error('[venue-store] seed-backfill failed (non-fatal):', err instanceof Error ? err.message : err);
  }
  initialized = true;
}

/** Reset module-local init state (test-only seam — DO NOT call from production code). */
export function _resetInitForTest(): void {
  initialized = false;
}

// ── Row shape mapping ────────────────────────────────────────────────────

function rowToRecord(row: Record<string, unknown>): VenueRecord {
  return {
    exchange_id: String(row.exchange_id),
    status: row.status as VenueStatus,
    asset_count: Number(row.asset_count),
    min_buy_sell_sample: Number(row.min_buy_sell_sample),
    integrated_at: row.integrated_at instanceof Date
      ? row.integrated_at.toISOString()
      : String(row.integrated_at),
    promoted_at: row.promoted_at
      ? (row.promoted_at instanceof Date ? row.promoted_at.toISOString() : String(row.promoted_at))
      : null,
    retired_at: row.retired_at
      ? (row.retired_at instanceof Date ? row.retired_at.toISOString() : String(row.retired_at))
      : null,
    extension_count: Number(row.extension_count),
    last_eval_at: row.last_eval_at
      ? (row.last_eval_at instanceof Date ? row.last_eval_at.toISOString() : String(row.last_eval_at))
      : null,
    last_eval_pfe_wr: row.last_eval_pfe_wr === null || row.last_eval_pfe_wr === undefined
      ? null
      : Number(row.last_eval_pfe_wr),
    last_eval_buy_sell_count: row.last_eval_buy_sell_count === null || row.last_eval_buy_sell_count === undefined
      ? null
      : Number(row.last_eval_buy_sell_count),
    // OPS-SHADOW-ALERT-HYGIENE-W1: nullable clock anchor (mirrors promoted_at
    // serialization). NULL until OPS-SHADOW-PIPELINE-W1 C3 stamps first signal.
    seeding_started_at: row.seeding_started_at
      ? (row.seeding_started_at instanceof Date ? row.seeding_started_at.toISOString() : String(row.seeding_started_at))
      : null,
    // OPS-VENUE-DAY30-DECISION-W1: identical null-safe Date-or-string shape to
    // promoted_at / seeding_started_at above. Always populated (never left
    // undefined) even though the type is optional, so every consumer reading a
    // record that came from the DB sees a concrete `string | null`.
    review_deadline_at: row.review_deadline_at
      ? (row.review_deadline_at instanceof Date ? row.review_deadline_at.toISOString() : String(row.review_deadline_at))
      : null,
    notes: row.notes === null || row.notes === undefined ? null : String(row.notes),
  };
}

// ── Read helpers ─────────────────────────────────────────────────────────

/**
 * Fetch a single venue by exchange_id. Returns `null` (NOT throws) when the
 * venue is not registered — preserves the spec contract that lets the
 * envelope/tool layer fall back gracefully (default `'promoted'` for unknown
 * venues per C2 backward-compat rule).
 */
export async function getVenue(exchangeId: string): Promise<VenueRecord | null> {
  await initVenuesTable();
  const rows = await dbQuery<Record<string, unknown>>(
    `SELECT * FROM venues WHERE exchange_id = ?`,
    [exchangeId]
  );
  if (!rows || rows.length === 0) return null;
  return rowToRecord(rows[0]);
}

/**
 * Fetch all venues. Optionally filter by status.
 *   listVenues()           → all venues
 *   listVenues('promoted') → only promoted
 *   listVenues('shadow')   → only shadow
 */
export async function listVenues(status?: VenueStatus): Promise<VenueRecord[]> {
  await initVenuesTable();
  const rows = status
    ? await dbQuery<Record<string, unknown>>(
        `SELECT * FROM venues WHERE status = ? ORDER BY exchange_id`,
        [status]
      )
    : await dbQuery<Record<string, unknown>>(
        `SELECT * FROM venues ORDER BY exchange_id`,
        []
      );
  return (rows || []).map(rowToRecord);
}

// ── OPS-BITMART-RETIRE-W1 (Q3) — cached retired-venue set for the hot request path ──
//
// A user request naming a RETIRED venue must be declined cleanly (naming the retirement), never left to
// hit the dead adapter and time out (BitMart's kline API went dead at its 2026-08-26 halt). The trade-call
// / market-regime / scan tools check this before touching an adapter. TTL-cached so it costs ~1 DB read per
// minute, not one per request. FAIL-OPEN: a cold or failed read yields the empty set → nothing is refused,
// because the venues table is the real gate and a false refusal of a live venue is worse than a slow one.
let _retiredCache: { set: Set<string>; loadedAt: number } | null = null;
const RETIRED_CACHE_TTL_MS = 60_000;

export async function getRetiredVenueSet(nowMs: number = Date.now()): Promise<Set<string>> {
  if (_retiredCache && nowMs - _retiredCache.loadedAt < RETIRED_CACHE_TTL_MS) return _retiredCache.set;
  try {
    const rows = await listVenues('retired');
    _retiredCache = { set: new Set(rows.map((r) => r.exchange_id)), loadedAt: nowMs };
  } catch {
    if (!_retiredCache) _retiredCache = { set: new Set(), loadedAt: nowMs }; // fail-open: never refuse on a read error
  }
  return _retiredCache.set;
}

/** Test seam — reset the module-level retired-set cache. */
export function _resetRetiredCacheForTest(): void { _retiredCache = null; }

/**
 * OPS-VENUE-STATUS-DERIVED-REGISTRIES-W1 (R1) — the ACTIVE promoted-venue ids: the static
 * `PROMOTED_VENUE_IDS` MINUS anything currently `retired` in the `venues` table. This is the SINGLE
 * derivation any registry that DRIVES LIVE API CALLS must iterate (the OI sampler, funding-arb), so a
 * venue retirement drops out of every operational path with ZERO code change — no venue is named here.
 * It reuses {@link getRetiredVenueSet} (OPS-BITMART-RETIRE-W1), so "which venues are retired" is derived
 * in exactly one place.
 *
 * FAIL-SAFE DIRECTION (asserted by a test, not merely this comment): a DB read failure makes
 * `getRetiredVenueSet` an EMPTY set, so this returns the FULL static `PROMOTED_VENUE_IDS`. Wrongly
 * SAMPLING a retired venue costs a few wasted API calls; wrongly DROPPING a live one costs DATA — so on
 * any uncertainty we KEEP the venue. This function never returns a silently-shrunk set on error.
 */
export async function getActivePromotedVenueIds(nowMs: number = Date.now()): Promise<PromotedVenueId[]> {
  const retired = await getRetiredVenueSet(nowMs);
  return PROMOTED_VENUE_IDS.filter((v) => !retired.has(v));
}

/**
 * OPS-BITMART-ENUM-RECONCILE-W1 — REACHABILITY CHANGED, function DELIBERATELY KEPT.
 * BITMART left the public enum on 2026-09-03, so a caller naming it is now rejected upstream by Zod
 * with a generic `-32602 invalid_enum_value` and never reaches this guard — the same treatment EDGEX
 * already had. That is the ratified outcome (architect Q5, 2026-09-02): CHANGELOG [1.28.0] publishes
 * that the enum lists only publicly served venues, so a special-cased BitMart message would
 * contradict shipped public docs.
 *
 * This is NOT dead code. It is the guard for the window between a venue being retired in the
 * `venues` table and its enum removal landing — exactly the 7-day window BitMart just lived through,
 * during which it was the ONLY thing giving callers a named reason instead of an adapter timeout.
 * The next retirement re-enters that window on day one. Do not delete it.
 *
 * Throw a clean, explicit refusal if `exchange` names a RETIRED venue — so a user request to a
 * wound-down venue is declined BY NAME rather than left to time out on the dead adapter. No-op for
 * internal (grid-refresh) calls and for every live venue. OPS-BITMART-RETIRE-W1 (Q3).
 */
export async function assertVenueNotRetired(exchange: string | undefined | null, internal = false): Promise<void> {
  if (internal || !exchange) return;
  if ((await getRetiredVenueSet()).has(exchange)) {
    throw new Error(
      `Venue ${exchange} is retired and no longer serves live market data (the exchange wound down). `
      + `Its historical track record is unchanged and remains verifiable; query a live venue instead.`,
    );
  }
}

// ── Write helpers ────────────────────────────────────────────────────────

export interface SetStatusOptions {
  promoted_at?: Date;  // populated when transitioning to 'promoted'
  retired_at?: Date;   // populated when transitioning to 'retired'
  notes?: string;
}

/**
 * Transition a venue to a new status. Updates the corresponding lifecycle
 * timestamp (`promoted_at` or `retired_at`) atomically with the status flip.
 */
export async function setStatus(
  exchangeId: string,
  status: VenueStatus,
  opts: SetStatusOptions = {}
): Promise<void> {
  await initVenuesTable();
  const promotedAt = status === 'promoted' ? (opts.promoted_at ?? new Date()) : null;
  const retiredAt = status === 'retired' ? (opts.retired_at ?? new Date()) : null;
  if (status === 'promoted') {
    dbRun(
      `UPDATE venues SET status = ?, promoted_at = ?, notes = COALESCE(?, notes) WHERE exchange_id = ?`,
      status, promotedAt, opts.notes ?? null, exchangeId
    );
  } else if (status === 'retired') {
    dbRun(
      `UPDATE venues SET status = ?, retired_at = ?, notes = COALESCE(?, notes) WHERE exchange_id = ?`,
      status, retiredAt, opts.notes ?? null, exchangeId
    );
  } else {
    // 'shadow' — usually only set at venue creation; allow regression for
    // operator-driven undo flows.
    dbRun(
      `UPDATE venues SET status = ?, notes = COALESCE(?, notes) WHERE exchange_id = ?`,
      status, opts.notes ?? null, exchangeId
    );
  }
}

/**
 * Record an evaluation pass (run by the daily evaluate-venues cron in C3).
 * Updates `last_eval_at` + `last_eval_pfe_wr` + `last_eval_buy_sell_count`.
 * Does NOT change `status` — that's a separate `setStatus` call from the
 * decision-tree branch in the cron.
 */
export async function recordEval(
  exchangeId: string,
  pfeWr: number | null,
  buySellCount: number,
  evalAt: Date = new Date()
): Promise<void> {
  await initVenuesTable();
  dbRun(
    `UPDATE venues
     SET last_eval_at = ?, last_eval_pfe_wr = ?, last_eval_buy_sell_count = ?
     WHERE exchange_id = ?`,
    evalAt, pfeWr, buySellCount, exchangeId
  );
}

/**
 * Bump `extension_count` by 1. Used by C3 cron's `day-15 miss → auto-extend`
 * branch. The CHECK constraint on the schema bounds at 2 (after that, the
 * day-30 manual_required path fires — no further auto-extend).
 */
export async function incrementExtension(exchangeId: string): Promise<void> {
  await initVenuesTable();
  dbRun(
    `UPDATE venues SET extension_count = extension_count + 1 WHERE exchange_id = ?`,
    exchangeId
  );
}

/** Schema CHECK: `extension_count >= 0 AND extension_count <= 2`. Mirrored in code. */
export const MAX_EXTENSION_COUNT = 2;

export interface SetReviewDeadlineOptions {
  /** Appended to `notes` (never overwrites). Skipped when absent/empty. */
  note?: string;
  /**
   * When supplied, `extension_count` is written in the SAME statement, clamped
   * to [0, MAX_EXTENSION_COUNT]. Omit to move the deadline without spending
   * budget — which is what the cron's auto-deferral does, and what `--force`
   * does once the budget is already spent.
   */
  extensionCount?: number;
}

/**
 * OPS-VENUE-DAY30-DECISION-W1 — set the DECISION DEADLINE for a shadow venue.
 *
 * `review_deadline_at` is the ONE field gating the day-30 `manual_required`
 * alert. Two writers, deliberately the same field: the evaluate-venues cron
 * (auto-deferral throttle) and extend-venue.ts (explicit operator extension).
 * A second `last_alert_at` column would be two predicates on one question,
 * which is how they drift.
 *
 * `seeding_started_at` is NEVER touched here. That is the entire point of the
 * wave: before it, the only way to buy a venue more time was
 * `resetSeedingStarted()`, which restarts the measurement floor and discards
 * the accrued BUY/SELL sample and PFE WR along with the clock.
 *
 * ONE awaited `dbQuery` statement, not two calls. `incrementExtension` uses
 * fire-and-forget `dbRun`, so pairing it with a post-write read would race
 * (PgBackend.run tracks the promise in `pending` and only drains at close(),
 * and PG_POOL_MAX > 1 means a following read can land on another client).
 * Folding the optional bump in here makes the deadline + the budget spend
 * atomic and makes a post-flip verification read meaningful.
 *
 * Guarded `status = 'shadow'`: a promoted or retired venue has no pending
 * decision, so this is a silent no-op for them — matching `stampSeedingStarted`
 * and `resetSeedingStarted`, which carry the same guard.
 *
 * `extensionCount` is clamped to [0, MAX_EXTENSION_COUNT] BEFORE the write, so
 * this helper cannot violate the schema CHECK regardless of what a caller asks
 * for.
 */
export async function setReviewDeadline(
  exchangeId: string,
  deadline: Date | null,
  opts: SetReviewDeadlineOptions = {}
): Promise<void> {
  await initVenuesTable();

  const sets: string[] = ['review_deadline_at = ?'];
  const params: unknown[] = [deadline];

  if (opts.extensionCount !== undefined) {
    const clamped = Math.max(0, Math.min(MAX_EXTENSION_COUNT, Math.floor(opts.extensionCount)));
    sets.push('extension_count = ?');
    params.push(clamped);
  }

  if (opts.note) {
    sets.push(`notes = COALESCE(notes, '') || ?`);
    params.push(opts.note);
  }

  params.push(exchangeId);

  await dbQuery(
    `UPDATE venues
     SET ${sets.join(', ')}
     WHERE exchange_id = ? AND status = 'shadow'`,
    params
  );
}

/**
 * OPS-SHADOW-PIPELINE-W1 / C3 — stamp `seeding_started_at` the first time a
 * shadow venue's seed run produces signals. Idempotent + shadow-only:
 *   - `seeding_started_at IS NULL` → sets exactly once (re-runs are no-ops),
 *   - `status = 'shadow'` → promoted venues are NEVER stamped (their
 *     COALESCE(seeding_started_at, integrated_at) clock stays on integrated_at).
 * Anchors the day-15/30 promotion clock (evaluate-venues) + the daily report's
 * "days since seeding" to when data ACTUALLY started flowing — not table-insert.
 * A venue whose endpoint is broken (0 signals) is never stamped, so its clock
 * doesn't start on empty data. Uses awaited dbQuery (not fire-and-forget dbRun)
 * so the stamp is guaranteed to persist before the seed process exits.
 */
export async function stampSeedingStarted(exchangeId: string, when: Date = new Date()): Promise<void> {
  await initVenuesTable();
  await dbQuery(
    `UPDATE venues
     SET seeding_started_at = ?
     WHERE exchange_id = ? AND seeding_started_at IS NULL AND status = 'shadow'`,
    [when, exchangeId]
  );
}

/**
 * OPS-SHADOW-WINDOW-RESET-AND-WR-DISPLAY-W1 — OVERWRITE `seeding_started_at`
 * for a shadow venue, restarting its 15/30-day promotion window AND the
 * sample/WR measurement floor (evaluate-venues derives clock, BUY+SELL count
 * and PFE WR from the ONE `COALESCE(seeding_started_at, integrated_at)` floor).
 * Quarantines bug-contaminated pre-fix signals behind the floor WITHOUT
 * deleting or mutating any signal row (Data Integrity LAW). Unlike
 * `stampSeedingStarted` there is deliberately NO `IS NULL` clause (a reset
 * overwrites an existing stamp), but the `status = 'shadow'` guard stays —
 * a promoted/retired venue can never be window-reset. Awaited dbQuery (not
 * fire-and-forget dbRun) so the write persists before the operator script
 * (reset-venue-window.ts) exits.
 */
export async function resetSeedingStarted(exchangeId: string, when: Date): Promise<void> {
  await initVenuesTable();
  await dbQuery(
    `UPDATE venues
     SET seeding_started_at = ?
     WHERE exchange_id = ? AND status = 'shadow'`,
    [when, exchangeId]
  );
}

/**
 * Insert a NEW venue (typically called from C5 pilot-onboarding flow).
 * `assetCount` is the venue's listed-perp count probed from the venue's
 * exchangeInfo at integration time (NOT the COUNT(DISTINCT coin) seeded
 * cosmetic value — see migrations/003_seed_venues_promoted.sql header).
 */
export async function insertVenue(opts: {
  exchangeId: string;
  status: VenueStatus;
  assetCount: number;
  minBuySellSample?: number; // defaults to assetCount × 10
  integratedAt?: Date;
  notes?: string;
}): Promise<void> {
  await initVenuesTable();
  const sample = opts.minBuySellSample ?? opts.assetCount * 10;
  const integrated = opts.integratedAt ?? new Date();
  dbRun(
    `INSERT INTO venues (exchange_id, status, asset_count, min_buy_sell_sample, integrated_at, notes)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (exchange_id) DO NOTHING`,
    opts.exchangeId,
    opts.status,
    opts.assetCount,
    sample,
    integrated,
    opts.notes ?? null
  );
}

/**
 * Refresh-on-demand asset_count for an already-registered venue. Used when a
 * venue adds N new listings post-promotion AND Mr.1 explicitly opts to re-bump
 * `min_buy_sell_sample`. NOT auto-called — operator-only.
 */
export async function refreshAssetCount(exchangeId: string, newAssetCount: number): Promise<void> {
  await initVenuesTable();
  dbRun(
    `UPDATE venues
     SET asset_count = ?, min_buy_sell_sample = ?
     WHERE exchange_id = ?`,
    newAssetCount, newAssetCount * 10, exchangeId
  );
}
