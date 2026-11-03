/**
 * key-reveal.ts — OPS-AUDIT-REMEDIATION-HIGH-W2-R2 CH2 (SECR-03): the ONE rule for showing an API key
 * from a Stripe Checkout Session. `/welcome?session_id=` is its first consumer.
 *
 * WHY. `/welcome` used to render the customer's CURRENT key for any Checkout Session that had a customer,
 * with no status, payment, age or single-use check. A completed session id never expires and can sit in a
 * browser history or a server log, so one leaked id was a permanent bearer of the key, and rotating the key
 * alone would only have re-exposed the new one.
 *
 * THE RULE. A key is revealed only when ALL of these hold, judged in this order:
 *   1. the id is shaped like a Checkout Session id — BEFORE any Stripe call, so junk costs nothing;
 *   2. the session is `complete` and its `payment_status` is `paid` or `no_payment_required`;
 *   3. it was created at most 24 h ago — Stripe's maximum session lifetime, so the Checkout `success_url`
 *      redirect (the only producer of this link) always lands inside it;
 *   4. it is the FIRST reveal: an atomic claim in `key_reveal_claims` on sha256('key-reveal-v1:' + id) — a
 *      sibling hash domain, never the raw id — through the shared `tryClaimOnce`. Its INDETERMINATE (the
 *      database errored) reveals nothing.
 * Every refusal is decided before the claim, so a refused view consumes nothing. A key not minted yet (the
 * webhook has not run) is `pending` and claims nothing either, so the reload the pending arm asks for still
 * gets the key. The page renders every refusal as ONE arm, so it is no oracle for which check failed.
 *
 * INHERITORS (not wired here): `/api/signup-email`'s existing-key return (AUTH-01) and the OAuth callback page.
 */
import { createHash } from 'node:crypto';
import { getCustomerApiKey } from './stripe.js';
import { tryClaimOnce } from './idempotency.js';
import { dbExec, dbQuery, isPgBackend } from './performance-db.js';
import { recordIndeterminate } from './indeterminate-counter.js';

const CHECKOUT_SESSION_ID = /^cs_(live|test)_[A-Za-z0-9]+$/;
const MAX_SESSION_AGE_S = 24 * 60 * 60;
const REVEALABLE_PAYMENT_STATUSES: ReadonlySet<string> = new Set(['paid', 'no_payment_required']);
const CLAIM_HASH_DOMAIN = 'key-reveal-v1:';
const CLAIM_REASON_TAG = 'key_reveal_claim';

// The table's ONLY DDL source, with the key declared inline: the ON CONFLICT target `tryClaimOnce` builds
// from CLAIMABLE_TABLES can never diverge from it (check-on-conflict-parity.mjs's absence precondition).
const CREATE_KEY_REVEAL_CLAIMS_SQL = `CREATE TABLE IF NOT EXISTS key_reveal_claims (
  claim_hash TEXT PRIMARY KEY,
  claimed_at TEXT NOT NULL
)`;

export type KeyRevealOutcome =
  | { kind: 'reveal'; apiKey: string; tier: string | null; email: string | null }
  | { kind: 'pending'; tier: string | null; email: string | null }
  | {
      kind: 'refused';
      reason: 'malformed_id' | 'not_complete' | 'not_paid' | 'stale' | 'already_shown' | 'indeterminate';
    };

let ensuring: Promise<void> | null = null;

/**
 * Create the claim table once per process, and AWAIT it on both backends. On Postgres `dbExec` is
 * fire-and-forget, so its caller could never see a failure; on SQLite `dbQuery` cannot run DDL at all
 * (better-sqlite3's `all()` refuses a statement that returns no rows). Concurrent first views share one
 * in-flight CREATE, and a failed one is dropped so the next view retries it.
 */
function ensureKeyRevealClaims(): Promise<void> {
  if (!ensuring) {
    const attempt = (async () => {
      if (isPgBackend()) await dbQuery(CREATE_KEY_REVEAL_CLAIMS_SQL);
      else dbExec(CREATE_KEY_REVEAL_CLAIMS_SQL);
    })();
    ensuring = attempt;
    attempt.catch(() => {
      if (ensuring === attempt) ensuring = null;
    });
  }
  return ensuring;
}

/**
 * Judge one view of a Checkout Session's welcome page. Stripe errors propagate: an unknown or unreachable
 * session is not a refusal decision, and the caller keeps its own error arm for it.
 */
export async function revealKeyOnce(sessionId: unknown): Promise<KeyRevealOutcome> {
  if (typeof sessionId !== 'string' || !CHECKOUT_SESSION_ID.test(sessionId)) {
    return { kind: 'refused', reason: 'malformed_id' };
  }

  const session = await getCustomerApiKey(sessionId);
  if (session.status !== 'complete') return { kind: 'refused', reason: 'not_complete' };
  if (session.paymentStatus === null || !REVEALABLE_PAYMENT_STATUSES.has(session.paymentStatus)) {
    return { kind: 'refused', reason: 'not_paid' };
  }
  const ageS = Math.floor(Date.now() / 1000) - (session.created ?? Number.NaN);
  if (!Number.isFinite(ageS) || ageS > MAX_SESSION_AGE_S) return { kind: 'refused', reason: 'stale' };
  if (!session.apiKey) return { kind: 'pending', tier: session.tier, email: session.email };

  try {
    await ensureKeyRevealClaims();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[key-reveal] claim table ensure failed — INDETERMINATE, nothing revealed: ${msg}`);
    recordIndeterminate(CLAIM_REASON_TAG, msg);
    return { kind: 'refused', reason: 'indeterminate' };
  }

  const claim = await tryClaimOnce(
    'key_reveal_claims',
    ['claim_hash'],
    {
      claim_hash: createHash('sha256').update(CLAIM_HASH_DOMAIN + sessionId).digest('hex'),
      claimed_at: new Date().toISOString(),
    },
    CLAIM_REASON_TAG,
  );
  if (claim === 'CLAIMED') return { kind: 'reveal', apiKey: session.apiKey, tier: session.tier, email: session.email };
  return { kind: 'refused', reason: claim === 'ALREADY_CLAIMED' ? 'already_shown' : 'indeterminate' };
}
