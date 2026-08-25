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
// CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1. One-way dependency: contact-spam.ts is pure and imports
// nothing, so this cannot cycle. The window length lives THERE because it is a property of the
// rules, not of the storage — a store that owned its own copy would let the two disagree.
import { LOOKBACK_HOURS, EMPTY_LOOKBACK, type LeadLookback } from './contact-spam.js';

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

// ── Quarantine lane (CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1) ──

/**
 * Measure the lookback window for one submission.
 *
 * FAIL-OPEN BY CONSTRUCTION. Every error path returns {@link EMPTY_LOOKBACK}, which contributes
 * ZERO to the score. A database hiccup must never be able to quarantine a real enterprise lead —
 * the failure mode of this function is "the lead gets notified", which is exactly today's
 * behaviour and therefore the honest floor.
 *
 * COUNTS ARE COMPUTED IN SQL, NOT IN JS. The `LIMIT` below bounds the WORK, not the ANSWER: it
 * caps a pathological scan, while `count(DISTINCT …)` and `count(*)` are evaluated over the full
 * window inside the subquery. Counting rows from a capped fetch would under-report precisely when
 * a campaign is at its worst — CLAUDE.md's never-aggregate-over-a-LIMIT-capped-collection rule.
 *
 * The window is expressed relative to `asOf` rather than `NOW()` so the same function serves live
 * scoring AND the CH3 historical backfill. Scoring a 2026-08-10 row against 2026-08-25 traffic
 * would be a different measurement wearing the same name.
 */
export async function readContactLeadLookback(args: {
  readonly name: string;
  readonly company: string | null;
  readonly ipHash: string | null;
  /** Window end. Omit for "now" — the live path. */
  readonly asOf?: Date;
}): Promise<LeadLookback> {
  const pg = Boolean(process.env.DATABASE_URL);
  // Bounds the scan. Far above any plausible legitimate volume in a 24h window, and far above the
  // 61-row peak the 2026-08 campaign reached, so it never truncates a real answer.
  const SCAN_CAP = 5000;

  try {
    // ONE round-trip, and every placeholder is `?` on BOTH dialects — PgBackend.query rewrites
    // `?` to `$1, $2, …` POSITIONALLY, so a hand-written `$1` used twice would be renumbered into
    // nonsense. That is also why the timestamp is passed four times rather than referenced once.
    //
    // Both legs are scalar subqueries over the SAME bounded window; the caller receives numbers,
    // never rows, so there is nothing here for a later wave to aggregate a second time.
    const sql = pg
      ? `SELECT
           (SELECT count(DISTINCT email) FROM (
              SELECT email FROM contact_leads
               WHERE created_at <= ?::timestamptz
                 AND created_at > ?::timestamptz - interval '${LOOKBACK_HOURS} hours'
                 AND lower(coalesce(name, '')) = lower(coalesce(?::text, ''))
                 AND lower(coalesce(company, '')) = lower(coalesce(?::text, ''))
               LIMIT ${SCAN_CAP}) s) AS identity_emails,
           (SELECT count(*) FROM (
              SELECT 1 FROM contact_leads
               WHERE created_at <= ?::timestamptz
                 AND created_at > ?::timestamptz - interval '${LOOKBACK_HOURS} hours'
                 AND ip_hash IS NOT NULL AND ip_hash = ?::text
               LIMIT ${SCAN_CAP}) t) AS ip_leads`
      : `SELECT
           (SELECT count(DISTINCT email) FROM (
              SELECT email FROM contact_leads
               WHERE created_at <= ?
                 AND created_at > datetime(?, '-${LOOKBACK_HOURS} hours')
                 AND lower(coalesce(name, '')) = lower(coalesce(?, ''))
                 AND lower(coalesce(company, '')) = lower(coalesce(?, ''))
               LIMIT ${SCAN_CAP}) s) AS identity_emails,
           (SELECT count(*) FROM (
              SELECT 1 FROM contact_leads
               WHERE created_at <= ?
                 AND created_at > datetime(?, '-${LOOKBACK_HOURS} hours')
                 AND ip_hash IS NOT NULL AND ip_hash = ?
               LIMIT ${SCAN_CAP}) t) AS ip_leads`;

    const at = args.asOf ?? new Date();
    // SQLite stores these as TEXT `datetime('now')` — 'YYYY-MM-DD HH:MM:SS', UTC, no zone suffix.
    // Postgres takes the ISO string directly. Same seven-parameter ORDER either way.
    const t = pg ? at.toISOString() : at.toISOString().replace('T', ' ').slice(0, 19);
    const params = [t, t, args.name, args.company, t, t, args.ipHash];

    const rows = await dbQuery<{ identity_emails: number | string; ip_leads: number | string }>(
      sql,
      params,
    );
    const row = rows[0];
    if (!row) return EMPTY_LOOKBACK;
    const toNum = (v: number | string | null | undefined): number => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    return {
      distinctEmailsForIdentity: toNum(row.identity_emails),
      leadsFromIpHash: toNum(row.ip_leads),
    };
  } catch (err) {
    // Loud in the log, silent in the verdict. A success-path log lives at the call site.
    console.error(
      '[contact-leads] lookback FAILED — scoring with an empty window (fail-open):',
      err instanceof Error ? err.message : err,
    );
    return EMPTY_LOOKBACK;
  }
}

/**
 * Record the spam verdict against an already-durable lead.
 *
 * `quarantined` decides whether `quarantined_at` is stamped, and that is a SEPARATE fact from the
 * score: `spam_score` records what we THOUGHT, `quarantined_at` records what we DID. Deriving the
 * second from the first at read time would let a later threshold retune silently restate history.
 *
 * Awaited `dbQuery`, not `dbRun`. `dbRun` is fire-and-forget — on Postgres a rejection resolves
 * inside trackedWrite's own promise where this `catch` could never see it, and a scoring write
 * that silently vanished would leave a quarantined lead looking un-scored forever. Same reasoning
 * as `insertContactLead` directly above.
 *
 * Returns whether the write landed. Never throws: the lead is already durable and the request has
 * effectively already succeeded by the time this runs.
 */
export async function markContactLeadScored(
  id: number,
  score: number,
  reasons: string | null,
  quarantined: boolean,
): Promise<boolean> {
  try {
    const sql = quarantined
      ? (process.env.DATABASE_URL
          ? 'UPDATE contact_leads SET spam_score = ?, spam_reasons = ?, quarantined_at = NOW() WHERE id = ? RETURNING id'
          : "UPDATE contact_leads SET spam_score = ?, spam_reasons = ?, quarantined_at = datetime('now') WHERE id = ? RETURNING id")
      : 'UPDATE contact_leads SET spam_score = ?, spam_reasons = ? WHERE id = ? RETURNING id';
    const rows = await dbQuery<{ id: number | string }>(sql, [score, reasons, id]);
    return rows.length > 0;
  } catch (err) {
    console.error(
      `[contact-leads] score write FAILED for lead ${id} (lead IS stored):`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * How many leads were quarantined inside the lookback window, EXCLUDING one id.
 *
 * This is the campaign alert's cooldown, and it is derived from `quarantined_at` itself rather
 * than from a marker file or a module-level timestamp. Two reasons, both paid for elsewhere in
 * this repo: in-memory state resets on every deploy (so a redeploy mid-campaign would re-page),
 * and a second store of "when did we last alert" is a second thing that can drift from the thing
 * it describes. The data already answers the question.
 *
 * `excludeId` is the lead being processed right now — its own `quarantined_at` was stamped
 * moments ago, so counting it would make every quarantine look like a repeat and suppress the
 * FIRST alert, which is the only one this design intends to send.
 *
 * Fail-open returns `null`, meaning "unknown". The caller treats unknown as DO NOT ALERT: a
 * missing count must not manufacture a page, and the alert is a convenience over a lane that is
 * already working silently.
 */
export async function countRecentQuarantines(excludeId: number): Promise<number | null> {
  try {
    const sql = process.env.DATABASE_URL
      ? `SELECT count(*) AS n FROM contact_leads
          WHERE quarantined_at IS NOT NULL
            AND quarantined_at > NOW() - interval '${LOOKBACK_HOURS} hours'
            AND id <> ?`
      : `SELECT count(*) AS n FROM contact_leads
          WHERE quarantined_at IS NOT NULL
            AND quarantined_at > datetime('now', '-${LOOKBACK_HOURS} hours')
            AND id <> ?`;
    const rows = await dbQuery<{ n: number | string }>(sql, [excludeId]);
    const n = rows[0]?.n;
    if (n === undefined || n === null) return null;
    const num = typeof n === 'number' ? n : Number(n);
    return Number.isFinite(num) ? num : null;
  } catch (err) {
    console.error(
      '[contact-leads] quarantine-window count FAILED — suppressing the campaign alert:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
