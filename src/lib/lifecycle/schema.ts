/**
 * IDENTITY-LIFECYCLE-W3 CH1 — boot-path DDL, the other half of `migrations/040_lifecycle.sql`.
 *
 * THE PAIR IS DELIBERATE, NOT A DUPLICATE. The migrations directory is applied by hand on
 * signal-1 and never reaches a fresh database or the SQLite test/dev backend; this runs lazily
 * on first use and never reaches a production DB that the migration already prepared (every
 * statement is `IF NOT EXISTS`). `tests/unit/lifecycle-ddl-parity.test.ts` asserts the two name
 * the same columns, so they cannot drift — the shape `signup_attribution` already proves.
 */
import { dbExec } from '../performance-db.js';

const IS_PG = !!process.env.DATABASE_URL;

const TS = IS_PG ? 'TIMESTAMPTZ' : 'TEXT';
const TS_NOW = IS_PG ? 'TIMESTAMPTZ NOT NULL DEFAULT NOW()' : "TEXT NOT NULL DEFAULT (datetime('now'))";
const PK = IS_PG ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const BOOL_FALSE = IS_PG ? 'BOOLEAN NOT NULL DEFAULT FALSE' : 'INTEGER NOT NULL DEFAULT 0';

let ensured = false;

/** Idempotent, cheap after the first call. Safe to call on every entry point. */
export function ensureLifecycleSchema(): void {
  if (ensured) return;
  dbExec(`
    CREATE TABLE IF NOT EXISTS lifecycle_sends (
      id               ${PK},
      recipient_id     TEXT NOT NULL,
      email_hash       TEXT NOT NULL,
      recipient_email  TEXT NULL,
      step             TEXT NOT NULL,
      period_key       TEXT NOT NULL,
      status           TEXT NOT NULL,
      rendered_subject TEXT NULL,
      rendered_html    TEXT NULL,
      rendered_text    TEXT NULL,
      resend_id        TEXT NULL,
      error            TEXT NULL,
      attempts         INTEGER NOT NULL DEFAULT 0,
      created_at       ${TS_NOW},
      updated_at       ${TS_NOW},
      CONSTRAINT lifecycle_sends_unique UNIQUE (recipient_id, step, period_key)
    );
  `);
  dbExec('CREATE INDEX IF NOT EXISTS idx_lifecycle_sends_step_created ON lifecycle_sends (step, created_at);');
  dbExec('CREATE INDEX IF NOT EXISTS idx_lifecycle_sends_hash_created ON lifecycle_sends (email_hash, created_at);');
  dbExec('CREATE INDEX IF NOT EXISTS idx_lifecycle_sends_status ON lifecycle_sends (status);');
  dbExec(`
    CREATE TABLE IF NOT EXISTS lifecycle_suppressions (
      email_hash  TEXT NOT NULL,
      reason      TEXT NOT NULL,
      step_scope  TEXT NOT NULL DEFAULT 'all',
      source      TEXT NULL,
      created_at  ${TS_NOW},
      CONSTRAINT lifecycle_suppressions_unique UNIQUE (email_hash, reason, step_scope)
    );
  `);
  dbExec('CREATE INDEX IF NOT EXISTS idx_lifecycle_suppressions_hash ON lifecycle_suppressions (email_hash);');
  dbExec(`
    CREATE TABLE IF NOT EXISTS lifecycle_step_state (
      step                TEXT PRIMARY KEY,
      first_would_send_at ${TS} NULL,
      live_since          ${TS} NULL,
      canary_batch_done   ${BOOL_FALSE},
      rolled_back_at      ${TS} NULL,
      rollback_reason     TEXT NULL,
      updated_at          ${TS_NOW}
    );
  `);
  dbExec(`
    CREATE TABLE IF NOT EXISTS lifecycle_heartbeats (
      job            TEXT PRIMARY KEY,
      last_run_at    ${TS} NOT NULL,
      last_verdict   TEXT NOT NULL,
      eligible_count INTEGER NOT NULL DEFAULT 0,
      note           TEXT NULL
    );
  `);
  ensured = true;
}

/** Test seam — lets a suite re-create the tables against a fresh in-memory database. */
export function _resetLifecycleSchemaCacheForTest(): void {
  ensured = false;
}
