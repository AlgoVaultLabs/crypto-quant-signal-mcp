/**
 * Stripe event-id idempotency store (ACTIVATION-PAYWALL-W1 / R5).
 *
 * Stripe retries webhook deliveries up to 3 days with exponential backoff
 * on any non-2xx response. To guarantee that `checkout.session.completed`
 * (and any future event type) is processed exactly once, we INSERT the
 * event-id BEFORE running the side-effect (tier promotion, request_log
 * row). `ON CONFLICT (event_id) DO NOTHING` returns rowCount=0 when the
 * id is already present, signaling the duplicate path.
 *
 * Per CLAUDE.md "Postgres DDL bundling" rule (`dbexec-fire-and-forget-needs-
 * single-multistatement-call-for-ddl-bundle` from GEO-MEASUREMENT-W1 / CHAT-
 * USAGE-ANALYTICS-W1 hotfix lessons), the `ensureProcessedStripeEventsSchema`
 * function issues a SINGLE multi-statement `dbExec(...)` — never N sequential
 * calls. `pool.query()` processes the statements in order within ONE backend
 * session, eliminating the race window that bit GEO-MEASUREMENT-W1's first
 * deploy (5 indexes failed because they hit before the CREATE TABLE committed).
 *
 * Schema:
 *   event_id        TEXT PRIMARY KEY    — Stripe's idempotency anchor (e.g. evt_1234)
 *   event_type      TEXT NOT NULL       — for analytics / cohort grouping
 *   processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()  — when we wrote the row
 *   session_id      TEXT                — `cs_<live|test>_*` for checkout sessions
 *   customer_email  TEXT                — for join to request_log + operator filter
 *   amount_total    INTEGER             — cents
 *   metadata        TEXT (JSON-encoded) — UTM tags + tier from createCheckoutSession
 *
 * Index `idx_pse_processed_at` supports future cleanup cron (`VACUUM (ANALYZE)`
 * candidate per CLAUDE.md "Postgres provisioning" rules; append-only table).
 */
// NB: `dbRun` is deliberately NOT imported. It is the fire-and-forget writer, and an
// idempotency claim made through it is neither atomic nor durable (SEC-20). Claims in
// this module go through the awaited `dbQuery` only.
import { dbExec, dbQuery } from './performance-db.js';

const CREATE_PROCESSED_STRIPE_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS processed_stripe_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    processed_at ${process.env.DATABASE_URL ? 'TIMESTAMPTZ' : 'TIMESTAMP'} NOT NULL DEFAULT ${process.env.DATABASE_URL ? 'NOW()' : "(datetime('now'))"},
    session_id TEXT,
    customer_email TEXT,
    amount_total INTEGER,
    metadata TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pse_processed_at ON processed_stripe_events (processed_at);
  CREATE INDEX IF NOT EXISTS idx_pse_event_type ON processed_stripe_events (event_type);
`;

let _initialized = false;

export function ensureProcessedStripeEventsSchema(): void {
  if (_initialized) return;
  dbExec(CREATE_PROCESSED_STRIPE_EVENTS_SQL);
  _initialized = true;
}

export interface ProcessedStripeEventRow {
  event_id: string;
  event_type: string;
  session_id?: string | null;
  customer_email?: string | null;
  amount_total?: number | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Attempt to insert the event-id row. Returns `true` if this is a NEW event
 * (insert succeeded; caller should run the side-effect), `false` if the id
 * already exists (caller should return HTTP 200 + skip the side-effect).
 *
 * The `ON CONFLICT (event_id) DO NOTHING` clause keeps the call idempotent
 * across Stripe's retry-on-non-2xx behavior (up to 3 days exponential backoff).
 */
export async function tryClaimEvent(row: ProcessedStripeEventRow): Promise<boolean> {
  ensureProcessedStripeEventsSchema();
  // ONE awaited round-trip: the database picks the winner, and `true` is returned only
  // once the row is DURABLE.
  //
  // OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch2 (SEC-20) replaced a SELECT-then-`dbRun` claim
  // that was neither atomic nor durable:
  //   • `dbRun` is FIRE-AND-FORGET (performance-db `run` → `trackedWrite`). On Postgres
  //     the UNIQUE-violation rejection resolves inside trackedWrite's own tracked
  //     promise, so the `catch` meant to detect a lost race could never run — it was
  //     dead code, and two concurrent deliveries could BOTH claim.
  //   • `true` was returned BEFORE the row was durable. If that INSERT was later LOST
  //     (the `[pg-write] WRITE LOST` path — SEC-14), the claim never persisted and
  //     Stripe's retry re-ran the side-effect anyway.
  //
  // `ON CONFLICT (event_id) DO NOTHING RETURNING event_id` returns exactly one row to
  // the winner and zero rows to every duplicate. Verified on BOTH backends: Postgres
  // natively, and better-sqlite3 11.10.0 / SQLite 3.49.2, where `.all()` on an
  // INSERT…RETURNING is a reader statement (first call [{event_id}], second []).
  const claimed = await dbQuery<{ event_id: string }>(
    `INSERT INTO processed_stripe_events (event_id, event_type, session_id, customer_email, amount_total, metadata)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [
      row.event_id,
      row.event_type,
      row.session_id ?? null,
      row.customer_email ?? null,
      row.amount_total ?? null,
      row.metadata ? JSON.stringify(row.metadata) : null,
    ],
  );
  return claimed.length > 0;
}

export async function getEventCount(): Promise<number> {
  ensureProcessedStripeEventsSchema();
  const rows = await dbQuery<{ count: string }>(
    'SELECT COUNT(*) as count FROM processed_stripe_events',
    [],
  );
  return rows.length > 0 ? Number(rows[0].count) : 0;
}
