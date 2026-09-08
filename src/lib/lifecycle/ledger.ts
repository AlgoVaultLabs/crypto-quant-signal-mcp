/**
 * IDENTITY-LIFECYCLE-W3 CH1 — the send ledger and the per-step go-live state.
 *
 * The ledger is the wave's memory. Idempotency, the frequency caps, CH2's readout, CH2's
 * per-step go-live clock and CH4's scoreboard rows all read this one table, so a row is written
 * for every OUTCOME — including the ones where nothing was sent (`suppressed`, `capped`). A
 * ledger that recorded only successes could not answer "who did we decline to mail, and why",
 * which is the question shadow mode exists to answer.
 */
import { dbQuery, dbRun } from '../performance-db.js';
import { ensureLifecycleSchema } from './schema.js';
import { LIFECYCLE_STEPS, type LifecycleStep } from '../lifecycle-copy.js';

export type SendStatus = 'would_send' | 'sent' | 'failed' | 'suppressed' | 'capped';

export interface LedgerRow {
  id: number;
  recipient_id: string;
  email_hash: string;
  recipient_email: string | null;
  step: LifecycleStep;
  period_key: string;
  status: SendStatus;
  rendered_subject: string | null;
  rendered_html: string | null;
  rendered_text: string | null;
  resend_id: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
}

const NOW_SQL = process.env.DATABASE_URL ? 'NOW()' : "datetime('now')";

/**
 * `created_at` IS WRITTEN EXPLICITLY AS AN ISO-8601 UTC STRING, NEVER LEFT TO THE DB DEFAULT.
 *
 * Two reasons, and the second is a real defect this suite caught before it shipped:
 *
 * 1. The frequency caps compare `created_at >= ?` against a window boundary this process
 *    computes. On Postgres a TIMESTAMPTZ column and an ISO parameter compare correctly. On
 *    SQLite the column is TEXT and the comparison is LEXICOGRAPHIC — and `datetime('now')`
 *    renders `2026-09-08 20:07:39` while our boundary is `2026-09-08T20:07:39.000Z`. Those
 *    differ at index 10 (`' '` vs `'T'`), and `' ' < 'T'`, so EVERY stored row sorted below
 *    EVERY boundary and the daily and 7-day caps both matched unconditionally. Measured: three
 *    cap assertions failed on the first run, reporting `capped` where a send was due.
 * 2. It makes the caps testable with an injected clock. A cap whose window can only be exercised
 *    by waiting a real day is a cap nobody proves, and this file's rule is that every gate is
 *    proven able to fail.
 *
 * One format, written by us, on both dialects.
 */
/**
 * Parse a timestamp back out of the database, on EITHER dialect. ONE derivation.
 *
 * `new Date(s.replace(' ', 'T'))` is the obvious version and it is WRONG on Postgres.
 * MEASURED on signal-1 2026-09-08: `node-postgres` returns `2026-09-08 13:46:46.246+00`, and
 * `Date.parse('2026-09-08T13:46:46.246+00')` is NaN — an ISO offset must be `+00:00` or `Z`,
 * never a bare `+00`. The live dispatcher printed `min_since_last_tick=NaN` on its second tick.
 *
 * That was not a cosmetic log defect. The SAME parse decides go-live: `stepGoLiveBlocker` reads
 * `first_would_send_at` to test whether a step's 7-day shadow clock has elapsed, and a NaN there
 * lands on `clock_unparseable` — fail-safe, but permanently. Every step would have sat in shadow
 * for ever on Postgres while every hermetic SQLite test said the clock worked.
 *
 * Returns NaN only for input that is genuinely unparseable, which callers still treat as a
 * refusal — the fix narrows what counts as unparseable, it does not make anything optimistic.
 */
export function toIso8601(s: string): string {
  // Emits a STRICT ISO-8601 string. `Date.parse` in Node happens to accept the space-separated
  // form too, so dropping this normalisation passes every behavioural test — which is exactly
  // why the shape is asserted directly rather than inferred from a parse result. ECMA-262 leaves
  // non-ISO date strings implementation-defined, and a load-bearing property must never be
  // RENTED from a dependency's tolerance: the day some runtime tightens, the caps and the go-live
  // clock would start returning NaN and every step would freeze in shadow, fail-safe and silent.
  let t = s.replace(' ', 'T');
  if (/[+-]\d{2}$/.test(t)) t = `${t}:00`;                 // Postgres `+00` -> `+00:00`
  else if (!/(Z|[+-]\d{2}:\d{2})$/.test(t)) t = `${t}Z`;  // offset-less means UTC here
  return t;
}

export function parseDbTimestamp(value: string | null | undefined): number {
  if (!value) return NaN;
  const s = String(value).trim();
  if (!s) return NaN;

  // NORMALISE FIRST, THEN PARSE — never `Date.parse` first and normalise on failure.
  //
  // A "try Date.parse, fall back" version passes the Postgres case and is WRONG on SQLite, which
  // is worse than the bug it fixes: `Date.parse('2026-09-08 13:46:46')` SUCCEEDS in Node and
  // interprets the value as LOCAL time. SQLite's `datetime('now')` is UTC, so on this machine
  // (UTC+8) that is an eight-hour error — silently shifting every frequency-cap window and the
  // 7-day go-live clock, with no parse failure anywhere to notice. Caught by the test below,
  // which is why the SQLite case is asserted against an exact ISO string and not just finiteness.
  return Date.parse(toIso8601(s));
}

function isoNow(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

/**
 * Claim the (recipient, step, period) slot. Returns true when THIS call created the row.
 *
 * This is the idempotency primitive and the reason the UNIQUE constraint exists. `ON CONFLICT
 * DO NOTHING` plus a follow-up read is deliberately used instead of a check-then-insert: two
 * dispatcher ticks overlapping (a slow run and its 15-minutes-later successor) would both pass a
 * check-then-insert's read and both send.
 */
export async function claimSlot(args: {
  recipientId: string;
  emailHash: string;
  recipientEmail: string | null;
  step: LifecycleStep;
  periodKey: string;
  status: SendStatus;
  subject?: string | null;
  html?: string | null;
  text?: string | null;
  /** Injected clock. Defaults to real now; the caps are only provable with this seam. */
  now?: Date;
}): Promise<{ created: boolean; row: LedgerRow | null }> {
  ensureLifecycleSchema();
  const at = isoNow(args.now);
  dbRun(
    `INSERT INTO lifecycle_sends
       (recipient_id, email_hash, recipient_email, step, period_key, status,
        rendered_subject, rendered_html, rendered_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (recipient_id, step, period_key) DO NOTHING`,
    args.recipientId, args.emailHash, args.recipientEmail, args.step, args.periodKey,
    args.status, args.subject ?? null, args.html ?? null, args.text ?? null, at, at,
  );
  const rows = await dbQuery<LedgerRow>(
    `SELECT * FROM lifecycle_sends WHERE recipient_id = ? AND step = ? AND period_key = ?`,
    [args.recipientId, args.step, args.periodKey],
  );
  const row = rows[0] ?? null;
  // `created` is inferred from the row's own status matching what we asked for AND zero
  // attempts — the honest signal available without a RETURNING clause the SQLite wrapper does
  // not surface. A caller that needs certainty checks `row.status`, never this flag alone.
  return { created: !!row && row.status === args.status && Number(row.attempts) === 0, row };
}

/**
 * Read-only existence check for a (recipient, step, period) slot.
 *
 * This is an ORDERING fix, not an optimisation. `claimSlot`'s `ON CONFLICT DO NOTHING` is still
 * the race-safety mechanism and nothing here replaces it — but without a read first, a re-run
 * over an ALREADY-HANDLED slot was evaluated against the frequency caps, matched the daily cap
 * (its own earlier send is in the window, by construction), and returned `capped` carrying the
 * id of the pre-existing `would_send` row. Two lies in one return value: a status the slot does
 * not have, and an id that belongs to a different outcome. Idempotency is strictly more
 * authoritative than any cap — if we already handled this slot, no other gate has an opinion.
 */
export async function findSlot(
  recipientId: string, step: LifecycleStep, periodKey: string,
): Promise<LedgerRow | null> {
  ensureLifecycleSchema();
  const rows = await dbQuery<LedgerRow>(
    'SELECT * FROM lifecycle_sends WHERE recipient_id = ? AND step = ? AND period_key = ?',
    [recipientId, step, periodKey],
  );
  return rows[0] ?? null;
}

export async function markSent(id: number, resendId: string | null): Promise<void> {
  ensureLifecycleSchema();
  dbRun(
    `UPDATE lifecycle_sends
        SET status = 'sent', resend_id = ?, error = NULL, attempts = attempts + 1, updated_at = ${NOW_SQL}
      WHERE id = ?`,
    resendId, id,
  );
}

export async function markFailed(id: number, error: string): Promise<void> {
  ensureLifecycleSchema();
  dbRun(
    `UPDATE lifecycle_sends
        SET status = 'failed', error = ?, attempts = attempts + 1, updated_at = ${NOW_SQL}
      WHERE id = ?`,
    error.slice(0, 500), id,
  );
}

/** Rows a retry tick should pick up: failed, and not yet at the attempt ceiling. */
export async function listRetryable(maxAttempts: number, limit: number): Promise<LedgerRow[]> {
  ensureLifecycleSchema();
  return dbQuery<LedgerRow>(
    `SELECT * FROM lifecycle_sends
      WHERE status = 'failed' AND attempts < ?
      ORDER BY updated_at ASC
      LIMIT ?`,
    [maxAttempts, limit],
  );
}

// ── Frequency caps (§Build Rule 7) ─────────────────────────────────────────────────────────
//
// Counted over rows that actually REACHED the recipient — `sent`, plus `would_send` in shadow
// so the shadow ledger models the live cadence rather than an unconstrained one. `suppressed`
// and `capped` are excluded by construction: neither put anything in an inbox, and counting
// them would let a suppression consume the person's daily budget.

const DELIVERED_STATUSES = "('sent','would_send')";

export async function countDeliveredSince(emailHash: string, sinceIso: string): Promise<number> {
  ensureLifecycleSchema();
  const rows = await dbQuery<{ c: number | string }>(
    `SELECT COUNT(*) AS c FROM lifecycle_sends
      WHERE email_hash = ? AND status IN ${DELIVERED_STATUSES} AND created_at >= ?`,
    [emailHash, sinceIso],
  );
  return Number(rows[0]?.c ?? 0);
}

export async function countDeliveredStepSince(
  emailHash: string, step: LifecycleStep, sinceIso: string,
): Promise<number> {
  ensureLifecycleSchema();
  const rows = await dbQuery<{ c: number | string }>(
    `SELECT COUNT(*) AS c FROM lifecycle_sends
      WHERE email_hash = ? AND step = ? AND status IN ${DELIVERED_STATUSES} AND created_at >= ?`,
    [emailHash, step, sinceIso],
  );
  return Number(rows[0]?.c ?? 0);
}

// ── Per-step go-live state (architect ruling Q1(A)) ────────────────────────────────────────

export interface StepState {
  step: LifecycleStep;
  first_would_send_at: string | null;
  live_since: string | null;
  canary_batch_done: boolean;
  rolled_back_at: string | null;
  rollback_reason: string | null;
}

export async function getStepState(step: LifecycleStep): Promise<StepState> {
  ensureLifecycleSchema();
  const rows = await dbQuery<Record<string, unknown>>(
    'SELECT * FROM lifecycle_step_state WHERE step = ?', [step],
  );
  const r = rows[0];
  if (!r) {
    return { step, first_would_send_at: null, live_since: null, canary_batch_done: false, rolled_back_at: null, rollback_reason: null };
  }
  return {
    step,
    first_would_send_at: (r.first_would_send_at as string) ?? null,
    live_since: (r.live_since as string) ?? null,
    // SQLite stores booleans as 0/1; PG returns a real boolean. One coercion, here.
    canary_batch_done: r.canary_batch_done === true || r.canary_batch_done === 1 || r.canary_batch_done === '1',
    rolled_back_at: (r.rolled_back_at as string) ?? null,
    rollback_reason: (r.rollback_reason as string) ?? null,
  };
}

export async function listStepStates(): Promise<StepState[]> {
  return Promise.all(LIFECYCLE_STEPS.map((s) => getStepState(s)));
}

/**
 * Start a step's own 7-day shadow clock, once, on its first `would_send`.
 *
 * `WHERE first_would_send_at IS NULL` makes this write-once: a later tick must never restart the
 * clock, or a step with a steady trickle of eligible recipients would never reach day 7.
 */
export async function stampFirstWouldSend(step: LifecycleStep, atIso: string): Promise<void> {
  ensureLifecycleSchema();
  dbRun(
    `INSERT INTO lifecycle_step_state (step, first_would_send_at) VALUES (?, ?)
     ON CONFLICT (step) DO UPDATE SET first_would_send_at = ?, updated_at = ${NOW_SQL}
      WHERE lifecycle_step_state.first_would_send_at IS NULL`,
    step, atIso, atIso,
  );
}

export async function setStepLive(step: LifecycleStep, atIso: string): Promise<void> {
  ensureLifecycleSchema();
  dbRun(
    `INSERT INTO lifecycle_step_state (step, live_since, canary_batch_done, rolled_back_at, rollback_reason)
     VALUES (?, ?, ${process.env.DATABASE_URL ? 'FALSE' : '0'}, NULL, NULL)
     ON CONFLICT (step) DO UPDATE SET live_since = ?, rolled_back_at = NULL, rollback_reason = NULL, updated_at = ${NOW_SQL}`,
    step, atIso, atIso,
  );
}

export async function markCanaryBatchDone(step: LifecycleStep): Promise<void> {
  ensureLifecycleSchema();
  dbRun(
    `UPDATE lifecycle_step_state SET canary_batch_done = ${process.env.DATABASE_URL ? 'TRUE' : '1'}, updated_at = ${NOW_SQL} WHERE step = ?`,
    step,
  );
}

/** Roll ONE step back to shadow. Never touches its siblings — per-step rollback is the point. */
export async function rollbackStep(step: LifecycleStep, atIso: string, reason: string): Promise<void> {
  ensureLifecycleSchema();
  dbRun(
    `INSERT INTO lifecycle_step_state (step, live_since, rolled_back_at, rollback_reason)
     VALUES (?, NULL, ?, ?)
     ON CONFLICT (step) DO UPDATE SET live_since = NULL, rolled_back_at = ?, rollback_reason = ?, updated_at = ${NOW_SQL}`,
    step, atIso, reason.slice(0, 300), atIso, reason.slice(0, 300),
  );
}

// ── Producer heartbeat (freshness law: measure the PRODUCER, never the artifact) ───────────

export interface Heartbeat {
  job: string;
  last_run_at: string;
  last_verdict: string;
  eligible_count: number;
}

/**
 * Stamped on EVERY dispatcher tick, including a tick that found nothing to do.
 *
 * That "including" is the whole point. With zero eligible recipients — the MEASURED state for
 * three of the four steps — a stalled dispatcher and a healthy one leave byte-identical ledgers,
 * so a freshness check reading the ledger would be structurally blind to a dead cron. The
 * producer stamps itself; the canary reads the stamp.
 */
export async function stampHeartbeat(
  job: string, verdict: string, eligibleCount: number, now?: Date, note?: string,
): Promise<void> {
  ensureLifecycleSchema();
  const at = isoNow(now);
  dbRun(
    `INSERT INTO lifecycle_heartbeats (job, last_run_at, last_verdict, eligible_count, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (job) DO UPDATE SET last_run_at = ?, last_verdict = ?, eligible_count = ?, note = ?`,
    job, at, verdict, eligibleCount, note ?? null, at, verdict, eligibleCount, note ?? null,
  );
}

export async function readHeartbeat(job: string): Promise<Heartbeat | null> {
  ensureLifecycleSchema();
  const rows = await dbQuery<Heartbeat>('SELECT * FROM lifecycle_heartbeats WHERE job = ?', [job]);
  return rows[0] ?? null;
}
