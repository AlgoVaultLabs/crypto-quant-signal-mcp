/**
 * contact_leads store — CONTACT-FORM-AND-SUPPORT-CLAIM-SWEEP-W1.
 *
 * ORDERING IS THE WHOLE DESIGN: persist first, notify second. A lead is the scarcest thing this
 * product captures, and an email send is a network call that fails. If the send came first — or
 * if the write were not durable before the send — a Resend outage would silently destroy the
 * lead and the user would still see a success page.
 *
 * WHY `dbQuery(... RETURNING id)` AND NOT `dbRun`. `dbRun` is FIRE-AND-FORGET (performance-db
 * `run` → `trackedWrite`): it returns before the row is durable, and on Postgres a rejection
 * resolves inside trackedWrite's own tracked promise where the caller's `catch` can never see
 * it. `OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch2 (SEC-20)` found exactly that in the Stripe webhook
 * claim — a write reported as succeeded could later hit the `[pg-write] WRITE LOST` path. Using
 * it here would mean "lead stored" was a claim we could not actually make, which is precisely
 * what AC2 exists to check. `INSERT … RETURNING id` is ONE awaited round-trip: the id comes back
 * only once the row is durable, and zero rows means the insert genuinely did not happen.
 *
 * Verified on BOTH backends by the same prior wave: Postgres natively, and better-sqlite3
 * 11.10.0 / SQLite 3.49.2 where `.all()` on an `INSERT … RETURNING` is a reader statement.
 */
import { dbQuery, dbRun } from './performance-db.js';

export interface ContactLeadInput {
  readonly name: string;
  readonly email: string;
  readonly company: string | null;
  readonly monthlyVolume: string | null;
  readonly message: string;
  /** Free-form so a future non-enterprise form variant needs no migration. */
  readonly intent: string;
  /** `?src=` channel, resolved through the shared `classifySource`. */
  readonly src: string | null;
  readonly ipHash: string | null;
}

/**
 * Insert the lead and return its id — or `null` if the row did NOT become durable.
 *
 * `null` is a real outcome the caller must handle, never a shrug: it is the one case where we
 * have not captured the lead and therefore must not tell the user we have.
 */
export async function insertContactLead(row: ContactLeadInput): Promise<number | null> {
  const rows = await dbQuery<{ id: number | string }>(
    `INSERT INTO contact_leads (name, email, company, monthly_volume, message, intent, src, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    [row.name, row.email, row.company, row.monthlyVolume, row.message, row.intent, row.src, row.ipHash],
  );
  const id = rows[0]?.id;
  if (id === undefined || id === null) return null;
  const n = typeof id === 'number' ? id : Number(id);
  return Number.isFinite(n) ? n : null;
}

/**
 * Record the NOTIFY outcome against an already-captured lead.
 *
 * Fire-and-forget is correct HERE and only here: the lead is already durable, so losing this
 * bookkeeping write costs a status column, not a customer. It must never be able to throw into
 * the request path — the user's submission has already succeeded by this point.
 */
export function markContactLeadNotified(id: number, error: string | null): void {
  try {
    if (error === null) {
      dbRun(
        process.env.DATABASE_URL
          ? 'UPDATE contact_leads SET email_sent_at = NOW(), email_error = NULL WHERE id = ?'
          : "UPDATE contact_leads SET email_sent_at = datetime('now'), email_error = NULL WHERE id = ?",
        id,
      );
    } else {
      dbRun('UPDATE contact_leads SET email_error = ? WHERE id = ?', error.slice(0, 500), id);
    }
  } catch (err) {
    console.error(`[contact-leads] bookkeeping update failed for lead ${id} (lead IS stored):`, err);
  }
}
