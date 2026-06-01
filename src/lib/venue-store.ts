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
    notes                 TEXT
  );
`;

const CREATE_VENUES_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_venues_status ON venues(status);
`;

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
