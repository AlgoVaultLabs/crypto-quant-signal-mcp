/**
 * forum-post-failures — persistence layer for the forum-post hardening
 * sprint (Reqs 4 + 6).
 *
 * Two tables, both created lazily on first import via the same PG/SQLite
 * backend as `performance-db.ts`:
 *
 *   forum_post_failures    — one row per verification or drift failure.
 *   forum_post_audit_log   — one row per publish attempt (used by
 *                            --self-audit mode to re-verify posts over
 *                            time).
 *
 * The PG migration file is authoritative for production
 * (schema/migrations/2026-04-15-forum-post-failures.sql). SQLite's CREATE
 * TABLE dialect is inlined below so local dev runs without PG — this is
 * the same pattern the existing performance-db module uses.
 *
 * Phase E freeze covers only performance-db.ts itself; importing from it
 * is explicitly allowed. This module never edits performance-db.ts.
 */

import { dbExec, dbQuery, dbRun } from './performance-db.js';

const IS_PG = Boolean(process.env.DATABASE_URL);

// ── Schema init (idempotent) ────────────────────────────────────────────

// PG dialect — matches schema/migrations/2026-04-15-forum-post-failures.sql.
const CREATE_FAILURES_PG = `
  CREATE TABLE IF NOT EXISTS forum_post_failures (
    id SERIAL PRIMARY KEY,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    platform TEXT NOT NULL,
    post_type TEXT NOT NULL,
    post_id TEXT,
    post_url TEXT,
    failure_reason TEXT NOT NULL,
    recovered BOOLEAN NOT NULL DEFAULT FALSE,
    recovered_at TIMESTAMPTZ
  );
`;

const CREATE_FAILURES_INDEX_PG = `
  CREATE INDEX IF NOT EXISTS idx_forum_post_failures_platform_detected
    ON forum_post_failures (platform, detected_at DESC);
`;

const CREATE_FAILURES_UNRECOVERED_INDEX_PG = `
  CREATE INDEX IF NOT EXISTS idx_forum_post_failures_unrecovered
    ON forum_post_failures (platform) WHERE recovered = FALSE;
`;

const CREATE_AUDIT_LOG_PG = `
  CREATE TABLE IF NOT EXISTS forum_post_audit_log (
    id SERIAL PRIMARY KEY,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    platform TEXT NOT NULL,
    post_type TEXT NOT NULL,
    post_id TEXT NOT NULL,
    post_url TEXT,
    verified_at_publish BOOLEAN NOT NULL,
    verify_failure_reason TEXT
  );
`;

const CREATE_AUDIT_LOG_INDEX_PG = `
  CREATE INDEX IF NOT EXISTS idx_forum_post_audit_log_platform_published
    ON forum_post_audit_log (platform, published_at DESC);
`;

// SQLite dialect — for local dev / tests. ISO 8601 timestamps stored as
// TEXT; SQLite's `datetime('now')` default + lexicographic comparison
// works for our windowed queries.
const CREATE_FAILURES_SQLITE = `
  CREATE TABLE IF NOT EXISTS forum_post_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    platform TEXT NOT NULL,
    post_type TEXT NOT NULL,
    post_id TEXT,
    post_url TEXT,
    failure_reason TEXT NOT NULL,
    recovered INTEGER NOT NULL DEFAULT 0,
    recovered_at TEXT
  );
`;

const CREATE_FAILURES_INDEX_SQLITE = `
  CREATE INDEX IF NOT EXISTS idx_forum_post_failures_platform_detected
    ON forum_post_failures (platform, detected_at DESC);
`;

const CREATE_AUDIT_LOG_SQLITE = `
  CREATE TABLE IF NOT EXISTS forum_post_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    published_at TEXT NOT NULL DEFAULT (datetime('now')),
    platform TEXT NOT NULL,
    post_type TEXT NOT NULL,
    post_id TEXT NOT NULL,
    post_url TEXT,
    verified_at_publish INTEGER NOT NULL,
    verify_failure_reason TEXT
  );
`;

const CREATE_AUDIT_LOG_INDEX_SQLITE = `
  CREATE INDEX IF NOT EXISTS idx_forum_post_audit_log_platform_published
    ON forum_post_audit_log (platform, published_at DESC);
`;

let initialized = false;

function ensureSchema(): void {
  if (initialized) return;
  initialized = true;
  try {
    if (IS_PG) {
      dbExec(CREATE_FAILURES_PG);
      dbExec(CREATE_FAILURES_INDEX_PG);
      dbExec(CREATE_FAILURES_UNRECOVERED_INDEX_PG);
      dbExec(CREATE_AUDIT_LOG_PG);
      dbExec(CREATE_AUDIT_LOG_INDEX_PG);
    } else {
      dbExec(CREATE_FAILURES_SQLITE);
      dbExec(CREATE_FAILURES_INDEX_SQLITE);
      dbExec(CREATE_AUDIT_LOG_SQLITE);
      dbExec(CREATE_AUDIT_LOG_INDEX_SQLITE);
    }
  } catch (err) {
    // Match performance-db.ts pattern: log and continue. If the backend
    // is broken the caller will see errors in the next query anyway.
    console.error(
      '[forum-post-failures] schema init error:',
      (err as Error).message
    );
  }
}

// ── Failures table ──────────────────────────────────────────────────────

export async function recordFailure(
  platform: string,
  postType: string,
  reason: string,
  postId?: string | null,
  postUrl?: string | null
): Promise<void> {
  ensureSchema();
  try {
    dbRun(
      `INSERT INTO forum_post_failures (platform, post_type, post_id, post_url, failure_reason)
       VALUES (?, ?, ?, ?, ?)`,
      platform,
      postType,
      postId ?? null,
      postUrl ?? null,
      reason
    );
  } catch (err) {
    console.error(
      `[forum-post-failures] recordFailure(${platform}) error:`,
      (err as Error).message
    );
  }
}

/**
 * Check if a specific post already has an unrecovered failure recorded.
 * Used by the self-audit to avoid re-recording the same drift failure
 * every day for known-broken posts (e.g. Moltbook is_spam=true legacy
 * posts, Hashnode anti-spam deletions). Without this, the drift count
 * inflates by N every day for N known-broken posts, drowning real signals.
 */
export async function hasUnrecoveredFailure(
  platform: string,
  postId: string,
): Promise<boolean> {
  ensureSchema();
  try {
    const rows = await dbQuery<{ n: number | string }>(
      `SELECT COUNT(*) AS n FROM forum_post_failures
       WHERE platform = ? AND post_id = ? AND recovered = false`,
      [platform, postId]
    );
    return Number(rows[0]?.n ?? 0) > 0;
  } catch {
    return false; // Err on the side of re-recording if query fails
  }
}

export async function countRecentFailures(
  platform: string,
  hours: number
): Promise<number> {
  ensureSchema();
  try {
    if (IS_PG) {
      const rows = await dbQuery<{ n: string | number }>(
        `SELECT COUNT(*)::int AS n FROM forum_post_failures
         WHERE platform = ? AND detected_at >= NOW() - (? || ' hours')::interval`,
        [platform, String(hours)]
      );
      return Number(rows[0]?.n ?? 0);
    }
    // SQLite: datetime() + hours math.
    const rows = await dbQuery<{ n: number }>(
      `SELECT COUNT(*) AS n FROM forum_post_failures
       WHERE platform = ? AND detected_at >= datetime('now', ?)`,
      [platform, `-${hours} hours`]
    );
    return Number(rows[0]?.n ?? 0);
  } catch (err) {
    console.error(
      `[forum-post-failures] countRecentFailures(${platform}) error:`,
      (err as Error).message
    );
    return 0;
  }
}

export async function markRecovered(
  platform: string,
  postId: string
): Promise<void> {
  ensureSchema();
  try {
    if (IS_PG) {
      dbRun(
        `UPDATE forum_post_failures
           SET recovered = TRUE, recovered_at = NOW()
         WHERE platform = ? AND post_id = ? AND recovered = FALSE`,
        platform,
        postId
      );
    } else {
      dbRun(
        `UPDATE forum_post_failures
           SET recovered = 1, recovered_at = datetime('now')
         WHERE platform = ? AND post_id = ? AND recovered = 0`,
        platform,
        postId
      );
    }
  } catch (err) {
    console.error(
      `[forum-post-failures] markRecovered(${platform}, ${postId}) error:`,
      (err as Error).message
    );
  }
}

// ── Audit-log table (used by --self-audit) ──────────────────────────────

export async function recordPublished(
  platform: string,
  postType: string,
  postId: string,
  postUrl: string,
  verified: boolean,
  failureReason?: string
): Promise<void> {
  ensureSchema();
  try {
    dbRun(
      `INSERT INTO forum_post_audit_log
         (platform, post_type, post_id, post_url, verified_at_publish, verify_failure_reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      platform,
      postType,
      postId,
      postUrl,
      IS_PG ? verified : verified ? 1 : 0,
      failureReason ?? null
    );
  } catch (err) {
    console.error(
      `[forum-post-failures] recordPublished(${platform}) error:`,
      (err as Error).message
    );
  }
}

export interface PublishedRow {
  post_id: string;
  post_url: string | null;
  published_at: string;
  post_type: string;
}

export async function getRecentPublished(
  platform: string,
  days: number,
  limit: number
): Promise<PublishedRow[]> {
  ensureSchema();
  try {
    if (IS_PG) {
      const rows = await dbQuery<PublishedRow>(
        `SELECT post_id, post_url, published_at::text AS published_at, post_type
           FROM forum_post_audit_log
          WHERE platform = ? AND published_at >= NOW() - (? || ' days')::interval
          ORDER BY published_at DESC
          LIMIT ?`,
        [platform, String(days), limit]
      );
      return rows;
    }
    const rows = await dbQuery<PublishedRow>(
      `SELECT post_id, post_url, published_at, post_type
         FROM forum_post_audit_log
        WHERE platform = ? AND published_at >= datetime('now', ?)
        ORDER BY published_at DESC
        LIMIT ?`,
      [platform, `-${days} days`, limit]
    );
    return rows;
  } catch (err) {
    console.error(
      `[forum-post-failures] getRecentPublished(${platform}) error:`,
      (err as Error).message
    );
    return [];
  }
}

/** Test-only: reset the module-level init flag. Not exported from the index. */
export function __resetInitForTests(): void {
  initialized = false;
}
