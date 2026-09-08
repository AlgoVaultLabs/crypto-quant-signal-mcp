/**
 * IDENTITY-LIFECYCLE-W3 CH1 — the suppression list. Absolute, permanent, and consulted before
 * every send.
 *
 * `step_scope` is the only nuance:
 *   'all'    unsubscribe / bounce / complaint — nothing lifecycle, ever again
 *   'usage'  the /account preference toggle (CH3) — the four usage steps only, leaving the
 *            product-updates digest the recipient explicitly opted in to untouched
 *
 * An 'all' row therefore dominates a 'usage' one, and re-enabling the preference deletes ONLY
 * the `preference`/`usage` row — never a bounce, complaint or unsubscribe. That asymmetry is
 * load-bearing: a toggle that could clear a spam complaint would let a UI click undo a
 * deliverability signal we are obliged to honour.
 */
import { dbQuery, dbRun } from '../performance-db.js';
import { ensureLifecycleSchema } from './schema.js';
import type { LifecycleStep } from '../lifecycle-copy.js';

export type SuppressionReason = 'unsubscribe' | 'bounce' | 'complaint' | 'preference';
export type SuppressionScope = 'all' | 'usage';

/** The steps a `usage`-scoped suppression covers. `product_updates` is deliberately absent. */
export const USAGE_STEPS: ReadonlySet<LifecycleStep> = new Set<LifecycleStep>([
  'activation_nudge',
  'quota_80',
  'quota_wall',
  'reset_return',
]);

export interface SuppressionRow {
  email_hash: string;
  reason: SuppressionReason;
  step_scope: SuppressionScope;
}

/**
 * Record a suppression. Idempotent on (hash, reason, scope) — a bounce webhook replays, and
 * Resend retries a non-2xx, so a second identical delivery must be a no-op rather than a
 * duplicate row.
 */
export async function addSuppression(args: {
  emailHash: string;
  reason: SuppressionReason;
  scope?: SuppressionScope;
  source?: string | null;
}): Promise<void> {
  ensureLifecycleSchema();
  const scope: SuppressionScope = args.scope ?? 'all';
  dbRun(
    `INSERT INTO lifecycle_suppressions (email_hash, reason, step_scope, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (email_hash, reason, step_scope) DO NOTHING`,
    args.emailHash,
    args.reason,
    scope,
    args.source ?? null,
  );
}

/**
 * Remove the /account preference suppression for one recipient — and ONLY that.
 *
 * The `reason = 'preference'` predicate is not decoration. Without it, toggling "email me at
 * 80%" back ON would delete a bounce, a complaint or an unsubscribe row sitting at the same
 * hash, silently re-subscribing somebody who never asked to be. A UI click must not be able to
 * clear a deliverability signal we are obliged to honour.
 */
export async function clearPreferenceSuppression(emailHash: string): Promise<void> {
  ensureLifecycleSchema();
  dbRun(
    `DELETE FROM lifecycle_suppressions
      WHERE email_hash = ? AND reason = 'preference' AND step_scope = 'usage'`,
    emailHash,
  );
}

export async function listSuppressions(emailHash: string): Promise<SuppressionRow[]> {
  ensureLifecycleSchema();
  return dbQuery<SuppressionRow>(
    'SELECT email_hash, reason, step_scope FROM lifecycle_suppressions WHERE email_hash = ?',
    [emailHash],
  );
}

/**
 * Is this address suppressed for this step?
 *
 * FAIL-CLOSED. An unreadable suppression table means we cannot tell whether this person opted
 * out, and the honest answer to "may I email them?" under that uncertainty is NO. The
 * alternative — treat a DB error as "not suppressed" — mails the exact set of people who asked
 * us to stop, on the exact day our database is unhealthy.
 */
export async function isSuppressed(emailHash: string, step: LifecycleStep): Promise<boolean> {
  let rows: SuppressionRow[];
  try {
    rows = await listSuppressions(emailHash);
  } catch (err) {
    console.error('[lifecycle] suppression read failed — refusing the send (fail-closed):',
      err instanceof Error ? err.message : err);
    return true;
  }
  for (const r of rows) {
    if (r.step_scope === 'all') return true;
    if (r.step_scope === 'usage' && USAGE_STEPS.has(step)) return true;
  }
  return false;
}
