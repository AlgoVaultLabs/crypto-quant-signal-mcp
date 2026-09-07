/**
 * subscriber-status.ts — THE ONE OWNER of what `subscriber_profiles.status` MEANS.
 * OPS-SUBSCRIBER-STATUS-SOT-W1.
 *
 * ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────────────────────
 * `OPS-PAYMENT-DECLINE-RECOVERY-PREDICATE-W1` made this column a LOAD-BEARING SAFETY PROPERTY:
 * the `PAYMENT_DECLINE_DRIFT` absolute floor counts payers whose money is stuck by reading it.
 * At that moment the column had FOUR independent derivations and NO owner:
 *
 *   1. `funnel-scoreboard.ts`   `(p.status ?? '').toLowerCase() === 'active'` — its own case-fold
 *                               and its own NULL convention, feeding three published numbers.
 *   2. `payment-decline-canary.py` — a full 4-bucket partition of Stripe's enum (Python, host).
 *   3. `applySubscriptionRecordUpdate`'s no-op gate — raw-string identity.
 *   4. `assembleProfile`        `status: 'active'` — a literal INVENTED from the event type.
 *
 * Four answers to one question, and CLAUDE.md's single-derivation rule says a write-side and a
 * read-side that both derive a classification must become ONE shared pure fn plus a canary.
 * This is that function. Every TypeScript consumer projects from here.
 *
 * 🛑 IT IS DELIBERATELY *NOT* `SUBSCRIPTION_STATUS_CLASS`, AND MERGING THEM IS A DEFECT.
 * That map (stripe.ts) answers **"may this caller use the API"** over a LIVE Stripe object, and
 * folds BEST-entitlement-wins across a customer's subscriptions. This module answers **"is this
 * payer's money stuck"** over a STORED string, and folds WORST-wins. The two disagree on
 * `unpaid` — NOT_ENTITLED there, MONEY_STUCK here — because Stripe has stopped retrying while the
 * debt stands, which is maximally stuck rather than resolved. `payment-decline-canary.py`'s
 * self-test asserts that divergence so a future "de-duplication" cannot quietly erase it.
 *
 * 🛑 THE PYTHON CANARY IS THE SECOND IMPLEMENTATION AND CANNOT IMPORT THIS FILE.
 * A cross-language pair is exactly where two derivations drift to contradiction, so the buckets
 * below are pinned against the canary's own `--status-vocabulary` output by
 * `tests/unit/subscriber-status-parity.test.ts`, feeding ONE fixture corpus to both. That is the
 * estate's established pattern for a JS gate that cannot import a Python module.
 */

/** Stripe's documented Subscription.status enum, verbatim and EXHAUSTIVE.
 *  https://docs.stripe.com/api/subscriptions/object — "Possible values are `incomplete`,
 *  `incomplete_expired`, `trialing`, `active`, `past_due`, `canceled`, `unpaid`, or `paused`." */
export const STRIPE_SUBSCRIPTION_STATUSES = Object.freeze([
  'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused',
] as const);

export type StripeSubscriptionStatus = (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];

/**
 * What a STORED status token means for the revenue question. No default branch: a string outside
 * Stripe's enum is `UNKNOWN`, and a missing one is `ABSENT` — two different facts that must not
 * collapse, because "we have never heard" and "we heard something we cannot read" call for
 * different operator action.
 */
export type StoredStatusClass =
  | 'HEALTHY'       // paying, or will be — active / trialing
  | 'MONEY_STUCK'   // past_due / unpaid: an established subscription is not paying
  | 'NOT_STARTED'   // incomplete / incomplete_expired: nothing was ever bought
  | 'ENDED'         // canceled / paused: churn, a different alarm's business
  | 'UNKNOWN'       // a string outside Stripe's enum
  | 'ABSENT';       // NULL, empty, or whitespace

export const STORED_STATUS_CLASS: Readonly<Record<StripeSubscriptionStatus, StoredStatusClass>> =
  Object.freeze({
    active: 'HEALTHY',
    trialing: 'HEALTHY',
    // `unpaid` is MONEY_STUCK here and NOT_ENTITLED in SUBSCRIPTION_STATUS_CLASS. Deliberate.
    past_due: 'MONEY_STUCK',
    unpaid: 'MONEY_STUCK',
    // `incomplete` is the state a normal signup occupies for up to 23h while its first payment
    // confirms. Bucketing it as stuck would make every declined-then-succeeded checkout page us —
    // measured 2026-09-06: six declines in three minutes, then a successful conversion.
    incomplete: 'NOT_STARTED',
    incomplete_expired: 'NOT_STARTED',
    canceled: 'ENDED',
    paused: 'ENDED',
  });

/** Classify a STORED token. Total over every input, including null/undefined/garbage. */
export function classifyStoredStatus(raw: string | null | undefined): StoredStatusClass {
  if (raw === null || raw === undefined) return 'ABSENT';
  const t = raw.trim().toLowerCase();
  if (t === '') return 'ABSENT';
  return (STORED_STATUS_CLASS as Record<string, StoredStatusClass>)[t] ?? 'UNKNOWN';
}

/**
 * WORST-WINS precedence, used when one customer_id must carry ONE status.
 *
 * 🛑 THE OPPOSITE FOLD TO `classifyCustomerSubscriptions`, ON PURPOSE. That one asks "may I serve
 * this caller" and takes the BEST state, so a customer holding one healthy and one delinquent
 * subscription is served. This one asks "is any money stuck" and takes the WORST, so that same
 * customer is not silently reported as healthy. Both are correct for their own question, and the
 * live book already carries that exact shape: one physical card, two customer records, one
 * `active` and one `past_due`.
 *
 * UNKNOWN outranks MONEY_STUCK: a token we cannot read must never be resolved in favour of
 * silence. ABSENT ranks lowest so any real observation replaces "we have never heard".
 */
export const STORED_STATUS_RANK: Readonly<Record<StoredStatusClass, number>> = Object.freeze({
  UNKNOWN: 5,
  MONEY_STUCK: 4,
  NOT_STARTED: 3,
  ENDED: 2,
  HEALTHY: 1,
  ABSENT: 0,
});

/**
 * Does this row count in the ACTIVE census?
 *
 * 🛑 EXACTLY `active`, NEVER the HEALTHY bucket. The funnel scoreboard compares this count
 * against a Stripe census built from `subscriptions.list({ status: 'active' })`, and CLAUDE.md
 * forbids comparing a delta across two instruments. Widening this to include `trialing` would
 * move a PUBLISHED number by counting a population the other side of the comparison cannot see.
 * It is named rather than inlined so that the narrowness is a declaration, not an accident.
 */
export function countsInActiveCensus(raw: string | null | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'active';
}

export type StatusWriteDecision = 'accept' | 'reject-stale' | 'reject-foreign-weaker' | 'reject-downgrade';

export interface StatusWriteInput {
  storedStatus: string | null | undefined;
  storedSubscriptionId: string | null | undefined;
  storedStatusAt: number | null | undefined;
  incomingStatus: string | null | undefined;
  incomingSubscriptionId: string | null | undefined;
  incomingAt: number | null | undefined;
  /** True for a status this code INFERRED from an event type rather than read from Stripe. */
  inferred?: boolean;
}

/**
 * The ONE precedence rule for writing this column. Pure, total, and ORDER-INDEPENDENT: replaying
 * the same two events in either order converges on the same row, which is the specific property
 * CLAUDE.md demands be pinned rather than rented.
 *
 * Rules, in order:
 *  1. An INFERRED status may never overwrite a stored MONEY_STUCK. `assembleProfile` invents
 *     `active` from the event type alone, so a `past_due` customer completing any checkout was
 *     silently rewritten to healthy — and the revenue floor stopped seeing them.
 *  2. A status for a DIFFERENT subscription is adopted only if it is WORSE. The row is
 *     single-valued and names the subscription it describes; a second subscription must not
 *     silently take the row over, but neither may it hide stuck money.
 *  3. For the SAME subscription, an OLDER event never overwrites a newer one. Stripe delivery is
 *     not ordered, and without this a replay leaves the row permanently on the stale value.
 */
export function decideStatusWrite(i: StatusWriteInput): { decision: StatusWriteDecision; status: string | null } {
  const stored = classifyStoredStatus(i.storedStatus);
  const incoming = classifyStoredStatus(i.incomingStatus);
  const keep = { decision: 'accept' as StatusWriteDecision, status: i.storedStatus ?? null };

  if (incoming === 'ABSENT') return { decision: 'reject-stale', status: i.storedStatus ?? null };

  if (i.inferred && stored === 'MONEY_STUCK') {
    return { decision: 'reject-downgrade', status: i.storedStatus ?? null };
  }

  const sameSubscription =
    !i.storedSubscriptionId || !i.incomingSubscriptionId ||
    i.storedSubscriptionId === i.incomingSubscriptionId;

  if (!sameSubscription) {
    if (STORED_STATUS_RANK[incoming] > STORED_STATUS_RANK[stored]) {
      return { decision: 'accept', status: i.incomingStatus ?? null };
    }
    return { decision: 'reject-foreign-weaker', status: i.storedStatus ?? null };
  }

  if (i.storedStatusAt != null && i.incomingAt != null && i.incomingAt < i.storedStatusAt) {
    return { decision: 'reject-stale', status: i.storedStatus ?? null };
  }

  void keep;
  return { decision: 'accept', status: i.incomingStatus ?? null };
}

/** The status a completed checkout IMPLIES. An inference from the event type, never a Stripe read
 *  — which is why every write of it must pass `decideStatusWrite` with `inferred: true`. */
export const CHECKOUT_IMPLIED_STATUS: StripeSubscriptionStatus = 'active';

// 🛑 NO `statusVocabulary()` HELPER AND NO `isMoneyStuck()` HELPER LIVE HERE.
// Both were written, and the dark-artifact gate caught them: nothing in production called
// either, and a test importing a symbol is not a consumer. The parity test now derives the
// vocabulary from `STORED_STATUS_CLASS` itself — which production genuinely reads, since
// `subscriber-attribution.ts` generates the upsert's MONEY-STUCK literal list from it — so the
// cross-language comparison is against the map the code actually uses rather than a projection
// that exists only to be compared.
