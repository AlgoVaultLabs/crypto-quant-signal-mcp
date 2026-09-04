/**
 * Stripe subscription billing integration.
 *
 * Validates API keys by searching Stripe Customer metadata, checking
 * active subscriptions, and caching results for 5 minutes.
 *
 * Graceful degradation: if STRIPE_SECRET_KEY is not set, all
 * validation returns { valid: false } and falls through to free tier.
 */
import crypto from 'node:crypto';
import DefaultStripe from 'stripe';
import { sendWelcomeEmail, maskEmail } from './email.js';
import { sendAlert } from './telegram.js';
import { recordIndeterminate } from './indeterminate-counter.js';
import type { PaidPlanId, BillingInterval } from './plans.js';
// PAY-UNIONPAY-ATTRIBUTION-W1: the ONE derivation of the payment-method dimension. Imported
// here rather than re-implemented so the webhook write path and the admin read path can never
// disagree about which brand a charge was (single-derivation rule).
import { resolvePaymentMethodAttribution, type PaymentMethodAttribution } from './payment-method-attribution.js';
// The RECORD vocabulary, which is wider than the billing one: it retains 'year' for rows
// sold before R-C retired annual, plus 'unknown'. Type-only, so no import cycle.
import type { StoredBillingInterval } from './subscriber-attribution.js';

// Stripe v22 exports the class as both named and default.
// Node16 moduleResolution resolves the default export reliably.
const StripeClient = DefaultStripe as unknown as typeof DefaultStripe & { new(key: string): InstanceType<typeof DefaultStripe> };

// ── Configuration ──

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
// PRICING-ANNUAL-AND-HOLD-PROMISE-W1: the five STRIPE_*_PRICE_ID vars (three monthly + two
// annual) are no longer read into module constants — they are declared as rows in
// `currentPriceBindings()` below, which is the ONE place that knows a price id at all.

let stripe: InstanceType<typeof DefaultStripe> | null = null;

if (STRIPE_SECRET_KEY) {
  stripe = new StripeClient(STRIPE_SECRET_KEY);
}

// ── Price → tier registry (PRICING-ANNUAL-AND-HOLD-PROMISE-W1) ──
//
// WHY THIS EXISTS. Before this wave, four sites re-derived "which tier is this subscription?"
// from a chain of `priceId === X_PRICE_ID` comparisons: validateApiKey, getCustomerApiKey,
// handleSubscriptionCreated and subscriptionTier. Two consequences, both live:
//
//   1. Adding ANY new price id — which is exactly what annual prepay is — silently resolved to
//      NO tier at validateApiKey, so a customer who had just prepaid a year would get
//      `{valid:false}` and an API key that does not work. handleSubscriptionCreated would
//      meanwhile mint them a 'starter' key regardless of what they bought.
//   2. The four copies had already DRIFTED: handleSubscriptionCreated never compared
//      STARTER_PRICE_ID at all and defaulted to 'starter', a different rule from its siblings.
//
// Per CLAUDE.md (`≥3 parallel hardcoded dispatch blocks keyed by an enum/ID → exhaustive
// registry iterated from the SoT`): the mapping is declared ONCE here and every consumer
// projects from it. Adding an interval or a tier is a row, not a code change.
//
// The tier vocabulary is imported from `plans.ts` (the plan SoT) rather than re-declared, so a
// tier cannot exist in billing that the plan ladder does not know about.
//
// OPS-STRIPE-SUBSCRIPTION-TRUTH-W1: `BillingInterval` moved to `plans.ts` for the SAME reason,
// now that the plan ladder is what prices an interval (`planMonthlyRateUsd`). Re-exported here
// so every existing import site is untouched — it had no external importers at the time of the
// move, so this is compatibility surface, not a second declaration.
export type { BillingInterval };

/** One configured Stripe Price and what entitlement it confers. */
export interface PriceBinding {
  readonly priceId: string;
  readonly tier: PaidPlanId;
  readonly interval: BillingInterval;
  /** Env var this came from — named in operator-facing logs so a misconfig is actionable. */
  readonly envVar: string;
}

/**
 * Precedence when ONE subscription carries several priced items. Higher rank wins.
 *
 * This is a RANK, not an ordered scan: `highestTier` takes the max, so the result is a function
 * of this table and never of the order Stripe happens to return `sub.items.data` in. The old
 * code's `for … if (x) break` shape rented that guarantee from upstream iteration order — the
 * exact pattern CLAUDE.md forbids. Pinned by the order-independence test.
 */
const TIER_RANK: Readonly<Record<PaidPlanId, number>> = { starter: 1, pro: 2, enterprise: 3 };

/**
 * Tie-break when two items resolve to the SAME highest tier on DIFFERENT intervals.
 *
 * 🛑 This table exists because `resolveSubscription` returns an interval, and without it the
 * answer would be rented from the order Stripe happens to return `sub.items.data` in — the
 * precise pattern CLAUDE.md forbids and that `TIER_RANK` above already exists to prevent. The
 * old `highestTier` did not need it: on a same-tier tie both branches gave the same TIER, so
 * iteration order was unobservable. Adding a second dimension made it observable.
 *
 * `year` wins, and the two independent reasons agree. It is DECLARED (that is the point), and
 * it is the conservative direction for a revenue figure: an annual rate is the LOWER monthly
 * number, so an ambiguous subscription understates MRR rather than over-claiming it — which is
 * the whole disposition of this arc. A subscription carrying both a monthly and an annual item
 * of one tier is a misconfiguration either way; this only fixes which way we read it.
 *
 * Pinned by the order-independence test beside `TIER_RANK`'s.
 */
const INTERVAL_RANK: Readonly<Record<BillingInterval, number>> = { month: 1, '6month': 2 };

/**
 * The declared bindings, in env-var order. Order here is presentational only — `buildPriceTierMap`
 * resolves collisions by TIER_RANK, so shuffling this array cannot change any resolution.
 *
 * Read from `process.env` on each call rather than closed over module-load constants, so the
 * `_rebuildPriceTierMapForTest` seam below can re-derive the map after a test mutates the env
 * (CLAUDE.md: a module-level cache needs a reset seam and a read-only inspector).
 */
export function currentPriceBindings(): readonly PriceBinding[] {
  return [
    { priceId: process.env.STRIPE_STARTER_PRICE_ID || '', tier: 'starter', interval: 'month', envVar: 'STRIPE_STARTER_PRICE_ID' },
    { priceId: process.env.STRIPE_PRO_PRICE_ID || '', tier: 'pro', interval: 'month', envVar: 'STRIPE_PRO_PRICE_ID' },
    { priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID || '', tier: 'enterprise', interval: 'month', envVar: 'STRIPE_ENTERPRISE_PRICE_ID' },
    // PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (R-C): 6-month prepay REPLACES annual. The two
    // STRIPE_*_ANNUAL_PRICE_ID bindings are gone, so an annual Price can no longer be resolved
    // to a tier — which is correct, because nothing may be sold on it any more. Existing annual
    // SUBSCRIPTIONS are unaffected: their tier resolves from the subscription's own price via
    // `validateApiKey`, and CH1 re-confirmed there are ZERO of them.
    { priceId: process.env.STRIPE_STARTER_6MONTH_PRICE_ID || '', tier: 'starter', interval: '6month', envVar: 'STRIPE_STARTER_6MONTH_PRICE_ID' },
    { priceId: process.env.STRIPE_PRO_6MONTH_PRICE_ID || '', tier: 'pro', interval: '6month', envVar: 'STRIPE_PRO_6MONTH_PRICE_ID' },
  ];
}

/**
 * Index the bindings by price id.
 *
 * Two rules that make the result independent of input order:
 *   - An EMPTY price id is skipped. Unconfigured env vars all collapse to `''`, and an `''` key
 *     would be a landmine: the pre-registry code compared `item.price.id === ENTERPRISE_PRICE_ID`
 *     with both sides `''` when that var was unset.
 *   - A DUPLICATE price id (the same Stripe Price wired to two env vars — a real misconfiguration)
 *     resolves to the HIGHEST-ranked tier and logs loudly, rather than letting whichever row came
 *     last silently win.
 */
export function buildPriceTierMap(bindings: readonly PriceBinding[] = currentPriceBindings()): ReadonlyMap<string, PriceBinding> {
  const map = new Map<string, PriceBinding>();
  for (const b of bindings) {
    if (!b.priceId) continue; // unconfigured — not offered
    const existing = map.get(b.priceId);
    if (!existing) {
      map.set(b.priceId, b);
      continue;
    }
    if (existing.tier === b.tier && existing.interval === b.interval) continue; // harmless exact dupe
    const winner = TIER_RANK[b.tier] > TIER_RANK[existing.tier] ? b : existing;
    console.error(
      `[stripe] CRITICAL price-id collision: ${b.priceId} is bound by both ${existing.envVar} ` +
      `(${existing.tier}/${existing.interval}) and ${b.envVar} (${b.tier}/${b.interval}). ` +
      `Resolving to the higher tier '${winner.tier}' by TIER_RANK. Fix the env configuration.`,
    );
    map.set(b.priceId, winner);
  }
  return map;
}

let priceTierMap: ReadonlyMap<string, PriceBinding> = buildPriceTierMap();

/**
 * Test seam — re-derive the map from the CURRENT env. Production never calls this; the map is
 * built once at module load because the env cannot change under a running process.
 */
export function _rebuildPriceTierMapForTest(): void {
  priceTierMap = buildPriceTierMap();
}

/** Read-only inspector — the configured (priceId → binding) pairs, for tests and diagnostics. */
export function _inspectPriceTierMap(): ReadonlyMap<string, PriceBinding> {
  return priceTierMap;
}

/** The binding for a Stripe Price id, or null when it is not one of ours. */
export function bindingForPriceId(priceId: string): PriceBinding | null {
  return priceTierMap.get(priceId) ?? null;
}

/** The tier a Stripe Price id confers, or null when unrecognised. */
export function tierForPriceId(priceId: string): PaidPlanId | null {
  return priceTierMap.get(priceId)?.tier ?? null;
}

/**
 * The highest tier a subscription confers, or null when none of its items is a Price we know.
 *
 * THE single implementation of the enterprise > pro > starter precedence. Returning null (rather
 * than a default) is deliberate: "we do not recognise what this customer bought" is a distinct
 * fact from "this customer is on starter", and each caller needs to handle it differently — the
 * validation path must refuse, while the mint path falls back least-privilege and shouts.
 */
export function highestTier(sub: { items: { data: Array<{ price: { id: string } }> } }): PaidPlanId | null {
  return resolveSubscription(sub)?.tier ?? null;
}

/** What a subscription resolves to: the tier it confers and the cadence it is billed on. */
export interface ResolvedSubscription {
  readonly tier: PaidPlanId;
  readonly interval: BillingInterval;
}

/**
 * THE single implementation of "what did this customer buy" — tier AND interval, resolved from
 * the price registry. `highestTier` is now a projection of it, so the enterprise > pro > starter
 * precedence still has exactly one implementation and cannot drift from the interval's.
 *
 * OPS-STRIPE-SUBSCRIPTION-TRUTH-W1: the interval was already sitting on every `PriceBinding` and
 * simply had no reader — which is why `countActiveSubscriptionsByTier` could not answer "how
 * many of the 3 starters are annual", and why `subscriber_profiles` had no cadence to store.
 *
 * Both dimensions are resolved from OUR ranking tables, never from `sub.items.data` order.
 * Returns null (rather than a default) on an unrecognised Price, preserving `highestTier`'s
 * contract: "we do not recognise what this customer bought" is a distinct fact from "starter".
 */
export function resolveSubscription(
  sub: { items: { data: Array<{ price: { id: string } }> } },
): ResolvedSubscription | null {
  let best: PriceBinding | null = null;
  for (const item of sub.items?.data ?? []) {
    const b = bindingForPriceId(item?.price?.id ?? '');
    if (!b) continue;
    if (
      best === null ||
      TIER_RANK[b.tier] > TIER_RANK[best.tier] ||
      (TIER_RANK[b.tier] === TIER_RANK[best.tier] && INTERVAL_RANK[b.interval] > INTERVAL_RANK[best.interval])
    ) {
      best = b;
    }
  }
  return best ? { tier: best.tier, interval: best.interval } : null;
}

/**
 * Resolve the Price id to bill for a (plan, interval) pair. Returns null when that combination is
 * not configured — e.g. Enterprise has no annual price, and annual is absent until the env is set.
 */
export function priceIdFor(plan: PaidPlanId, interval: BillingInterval = 'month'): string | null {
  for (const [priceId, b] of priceTierMap) {
    if (b.tier === plan && b.interval === interval) return priceId;
  }
  return null;
}

// ── Types ──

/**
 * OPS-VALIDATE-KEY-INDETERMINATE-W1 CH1 — the FOUR states a key can be in.
 *
 * `valid: boolean` could only ever express two, so four distinct facts were folded into
 * `{valid:false}`: "no such customer", "their card is failing and Stripe is still dunning them",
 * "their subscription ended", and "we could not ask Stripe". MEASURED 2026-09-04: a `past_due`
 * customer (`sub_…Tylz9REY`, dunning since 2026-08-26) was indistinguishable from a deleted one
 * at every consumer, which is what let the Telegram bot serve them 2,025 alerts across nine days
 * with 1,987 debits terminally 404'd — unmetered, unwalled, and invisible.
 *
 * ENTITLED       an `active`/`trialing` subscription on a recognised Price. Grants the tier.
 * DUNNING        `past_due`. Stripe is still collecting. Grants NOTHING here — see below — but is
 *                a fact each consumer may act on with its own predicate.
 * NOT_ENTITLED   a DETERMINED negative: no customer, no subscription, or one that has ended.
 * INDETERMINATE  we could not ask, or Stripe answered with a status this build cannot classify.
 *                Never a fact about the subscriber; always a fact about us.
 */
export type EntitlementState = 'ENTITLED' | 'DUNNING' | 'NOT_ENTITLED' | 'INDETERMINATE';

/** WHY a determined negative. Fixed vocabulary — never caller input, never free text. */
export type NotEntitledReason =
  | 'malformed_key'
  | 'no_customer'
  | 'customer_deleted'
  | 'no_subscription'
  | 'subscription_ended'
  | 'unrecognised_price';

/**
 * Stripe subscription status → entitlement class. THE one mapping; every consumer projects.
 *
 * 🛑 AN UNLISTED STATUS IS `INDETERMINATE`, NOT A DEFAULT EITHER WAY. Stripe may add a status;
 * defaulting it to NOT_ENTITLED would cut paying customers off on a vendor release, and
 * defaulting it to ENTITLED would give service away. "We cannot classify this" is the only true
 * answer, and it is the one answer that neither grants nor revokes.
 *
 * `incomplete` is NOT_ENTITLED deliberately: the FIRST payment has not succeeded, so nothing was
 * ever bought. That is a different fact from `past_due`, where an established subscription's
 * renewal failed — which is why the two do not share a class.
 */
export const SUBSCRIPTION_STATUS_CLASS: Readonly<Record<string, 'ENTITLED' | 'DUNNING' | 'NOT_ENTITLED'>> =
  Object.freeze({
    active: 'ENTITLED',
    trialing: 'ENTITLED',
    past_due: 'DUNNING',
    unpaid: 'NOT_ENTITLED',
    canceled: 'NOT_ENTITLED',
    incomplete: 'NOT_ENTITLED',
    incomplete_expired: 'NOT_ENTITLED',
    paused: 'NOT_ENTITLED',
  });

/** Which class wins when a customer holds several subscriptions. Best entitlement wins. */
const STATE_RANK: Readonly<Record<'ENTITLED' | 'DUNNING' | 'NOT_ENTITLED', number>> = Object.freeze({
  ENTITLED: 3,
  DUNNING: 2,
  NOT_ENTITLED: 1,
});

export interface StripeValidation {
  /**
   * 🛑 UNCHANGED CONTRACT, AND DELIBERATELY SO: `valid` is true IFF `entitlementState` is
   * ENTITLED, and `tier` is set IFF `valid`. Every incumbent consumer — above all
   * `license.ts:582`'s `if (stripeResult.valid && stripeResult.tier)` — keeps byte-identical
   * behaviour, and the ratified estate policy that API entitlement is ACTIVE-ONLY
   * (see `resolveCustomerByApiKey`'s docstring) is preserved rather than quietly reversed.
   *
   * The new fields below are PURELY ADDITIVE. They carry the distinction beside the verdict so a
   * consumer that needs it can read it, which is the same fix `KeyCheck.reason` and
   * `resolveCustomerByApiKey` already applied to their own sentinel collapses.
   */
  valid: boolean;
  tier?: 'starter' | 'pro' | 'enterprise';
  customerId?: string;
  /**
   * OPS-ZERO-VS-UNKNOWN-W1: `valid:false` meant BOTH "Stripe says this key is not valid" and
   * "we could not reach Stripe to ask". The caller (license.ts) turns `valid:false` into
   * `{tier:'free', key:null}`, so a transient Stripe fault SILENTLY DEMOTED A PAYING CUSTOMER:
   * a $49/mo Pro caller was metered into `free:<ipHash>`, burned a 100-call ceiling they do not
   * have, and was then refused — having paid. That is customer harm, not a metrics defect.
   *
   * `indeterminate: true` means "could not determine", never "determined invalid". A caller MUST
   * NOT treat it as a tier decision.
   *
   * CH1: still present, still exactly this meaning — now PROJECTED from `entitlementState`
   * rather than decided a second time, so the two can never disagree.
   */
  indeterminate?: true;
  /** CH1 — the single derivation every other field on this object projects from. */
  entitlementState?: EntitlementState;
  /** Set IFF `entitlementState === 'NOT_ENTITLED'`. */
  reason?: NotEntitledReason;
  /** The raw Stripe status we classified, when we got one. Diagnostics only — never a predicate. */
  subscriptionStatus?: string | null;
  /**
   * Set IFF `entitlementState === 'DUNNING'`.
   *
   * A SEPARATE FIELD, not `tier`, and that is the whole point: `tier` means "granted" to nine
   * existing call sites and four production consumers. Overloading it to also mean "would be
   * granted if they paid" is precisely the collapse this chapter exists to undo, one field over.
   */
  dunning?: { tier: 'starter' | 'pro' | 'enterprise'; since: string | null; subscriptionId: string };
}

// ── API Key Generation ──

export function generateApiKey(): string {
  const hex = crypto.randomBytes(12).toString('hex'); // 24 hex chars
  return `av_live_${hex}`;
}

// REFERRAL-LIGHT-W1 (C3): expose the configured Stripe client for referral
// commission credits + webhook-event config (referral-accrual.ts). Null when Stripe
// is unconfigured; callers null-check. Keeps the singleton encapsulated otherwise.
export function getStripeClient(): InstanceType<typeof DefaultStripe> | null {
  return stripe;
}

// ── Cache (5-minute TTL) ──

interface CacheEntry {
  result: StripeValidation;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function invalidateCacheForCustomer(customerId: string): void {
  for (const [key, entry] of cache) {
    if (entry.result.customerId === customerId) {
      cache.delete(key);
    }
  }
}

// ── Validation ──

/**
 * OPS-VALIDATE-KEY-INDETERMINATE-W1 CH1 — resolve a key to ONE entitlement state.
 *
 * ── WHAT CHANGED, AND WHAT DELIBERATELY DID NOT ────────────────────────────────────────────
 * The list call is now `status: 'all'` rather than `status: 'active'`. It costs the SAME ONE
 * request and returns both facts, so neither has to be inferred from the other's absence — the
 * identical correction `resolveCustomerByApiKey` already made on 2026-08-25 for the identical
 * customer (`cus_UuBrP1otU51OBm`, a failed Mastercard). That fix landed on one call site; this
 * is the same defect on the entitlement hot path, which is why it is being fixed at the
 * GENERATOR and pinned by `scripts/check-subscription-status-sot.mjs` rather than patched again.
 *
 * ENTITLEMENT IS STILL ACTIVE-ONLY. `valid` is true IFF the resolved state is ENTITLED, so
 * `license.ts`, `/mcp`, `referral-accrual` and every other incumbent behave byte-identically.
 * `resolveCustomerByApiKey`'s docstring RATIFIED that policy ("may this key call the API?
 * entitlement — active-only is CORRECT") and this chapter does not reverse it. What it does is
 * stop DESTROYING the reason, so the Telegram bot — whose predicate is legitimately different —
 * can stop guessing from a bare 404.
 *
 * SINGLE DERIVATION. `valid`, `tier`, `indeterminate` and `dunning` are all PROJECTED from
 * `entitlementState` at the one return below. Two independent derivations of one classification
 * drift to contradiction, and here the contradiction would be a customer who is `valid:false`
 * and `entitlementState:'ENTITLED'` at the same time.
 */
export async function validateApiKey(apiKey: string): Promise<StripeValidation> {
  // Not configured is "cannot determine", NOT "invalid" — the distinction the caller needs.
  if (!stripe) return project({ state: 'INDETERMINATE' });

  // Validate key format to prevent query injection. Shape is knowable WITHOUT Stripe, so this
  // stays a DETERMINED negative even during an outage.
  if (!/^[a-zA-Z0-9_]+$/.test(apiKey)) return project({ state: 'NOT_ENTITLED', reason: 'malformed_key' });

  // Check cache first
  const cached = cache.get(apiKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result;
  }

  try {
    // Search customers by api_key metadata
    const customers = await stripe.customers.search({
      query: `metadata['api_key']:'${apiKey}'`,
      limit: 1,
    });

    if (customers.data.length === 0) {
      const result = project({ state: 'NOT_ENTITLED', reason: 'no_customer' });
      cache.set(apiKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    }

    const customer = customers.data[0];
    if ('deleted' in customer && customer.deleted) {
      const result = project({ state: 'NOT_ENTITLED', reason: 'customer_deleted', customerId: customer.id });
      cache.set(apiKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    }

    // ONE list call, `status: 'all'` — see the docblock. STATUS-SOT-OWNER.
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 10,
    });

    const result = classifyCustomerSubscriptions(customer.id, subscriptions.data);
    cache.set(apiKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err) {
    // OPS-ZERO-VS-UNKNOWN-W1: an unreachable Stripe is INDETERMINATE, never "invalid".
    console.error('Stripe validateApiKey error:', err instanceof Error ? err.message : err);
    recordIndeterminate('stripe_validate_api_key');
    return project({ state: 'INDETERMINATE' });
  }
}

/** Best-effort period start for a dunning subscription. NEVER throws, NEVER invents a date. */
function dunningSince(sub: any): string | null {
  const raw =
    sub?.items?.data?.[0]?.current_period_start ??
    sub?.current_period_start ??
    null;
  return typeof raw === 'number' && Number.isFinite(raw) ? new Date(raw * 1000).toISOString() : null;
}

/**
 * A customer's subscriptions → ONE state. Exported for the unit test, which drives every Stripe
 * status through it WITHOUT a network call — the branch matrix is the whole contract here and a
 * live-Stripe-only test could never cover `unpaid` or `incomplete_expired`.
 *
 * PRECEDENCE: best entitlement wins (ENTITLED > DUNNING > NOT_ENTITLED), and within ENTITLED the
 * highest tier by `TIER_RANK`. That is byte-identical to the previous behaviour for any customer
 * holding an active subscription — which is every customer the old code could see at all.
 */
export function classifyCustomerSubscriptions(customerId: string, subs: any[]): StripeValidation {
  // PRICING-ANNUAL-AND-HOLD-PROMISE-W1: projects from the ONE price→tier registry, so a newly
  // added Price (annual, or any future interval) entitles its buyer the moment its env var is
  // set. The prior inline comparison chain knew only the three monthly ids, so an annual
  // subscriber resolved to no tier at all and was handed `{valid:false}` — having paid.
  let best: { rank: number; state: 'ENTITLED' | 'DUNNING' | 'NOT_ENTITLED'; sub: any; tier: PaidPlanId | null } | null = null;
  let sawUnclassifiable = false;
  let sawSubWithUnknownPrice = false;

  for (const sub of subs) {
    const status = typeof sub?.status === 'string' ? sub.status : '';
    const cls = SUBSCRIPTION_STATUS_CLASS[status];
    if (!cls) {
      // A status this build has never heard of. We cannot say — and saying either way is worse
      // than admitting it. Recorded and surfaced as INDETERMINATE below.
      sawUnclassifiable = true;
      continue;
    }
    const tier = highestTier(sub);
    if (cls !== 'NOT_ENTITLED' && !tier) sawSubWithUnknownPrice = true;
    // A grant needs a recognised Price; without one the subscription cannot confer a tier, so it
    // can never out-rank a subscription that can.
    const effective: 'ENTITLED' | 'DUNNING' | 'NOT_ENTITLED' = tier ? cls : 'NOT_ENTITLED';
    const rank = STATE_RANK[effective] * 10 + (tier ? TIER_RANK[tier] : 0);
    if (!best || rank > best.rank) best = { rank, state: effective, sub, tier };
  }

  if (sawUnclassifiable && (!best || best.state === 'NOT_ENTITLED')) {
    // Only INDETERMINATE when the unclassifiable subscription could actually have changed the
    // answer. A customer with a live `active` subscription plus some future status we do not know
    // is ENTITLED regardless, and must not be degraded into an outage.
    recordIndeterminate('stripe_subscription_status_unclassified');
    return project({ state: 'INDETERMINATE', customerId });
  }

  if (!best || best.state === 'NOT_ENTITLED') {
    const reason: NotEntitledReason = subs.length === 0
      ? 'no_subscription'
      : sawSubWithUnknownPrice
        ? 'unrecognised_price'
        : 'subscription_ended';
    return project({
      state: 'NOT_ENTITLED',
      reason,
      customerId,
      subscriptionStatus: typeof best?.sub?.status === 'string' ? best.sub.status : null,
    });
  }

  if (best.state === 'DUNNING') {
    return project({
      state: 'DUNNING',
      customerId,
      subscriptionStatus: 'past_due',
      dunning: { tier: best.tier as PaidPlanId, since: dunningSince(best.sub), subscriptionId: String(best.sub?.id ?? '') },
    });
  }

  return project({
    state: 'ENTITLED',
    customerId,
    tier: best.tier as PaidPlanId,
    subscriptionStatus: typeof best.sub?.status === 'string' ? best.sub.status : null,
  });
}

/**
 * THE projection. Every `StripeValidation` in this module is built here and nowhere else, so the
 * legacy booleans cannot drift from the state they are supposed to summarise.
 *
 * 🛑 `valid` is ENTITLED-only and `indeterminate` is INDETERMINATE-only, BY CONSTRUCTION. If a
 * future state needs to grant, it changes this one line — not five return sites.
 */
function project(d: {
  state: EntitlementState;
  reason?: NotEntitledReason;
  customerId?: string;
  tier?: PaidPlanId;
  subscriptionStatus?: string | null;
  dunning?: { tier: PaidPlanId; since: string | null; subscriptionId: string };
}): StripeValidation {
  const out: StripeValidation = { valid: d.state === 'ENTITLED', entitlementState: d.state };
  if (d.state === 'ENTITLED' && d.tier) out.tier = d.tier;
  if (d.state === 'INDETERMINATE') out.indeterminate = true;
  if (d.reason) out.reason = d.reason;
  if (d.customerId) out.customerId = d.customerId;
  if (d.subscriptionStatus !== undefined) out.subscriptionStatus = d.subscriptionStatus;
  if (d.dunning) out.dunning = d.dunning;
  return out;
}

// ── Checkout Session Creation ──

export interface CheckoutSessionOptions {
  /** Forwarded to `client_reference_id`; used by webhook to attribute the conversion. */
  clientReferenceId?: string;
  /** Optional UTM tags — persisted in `metadata.utm_source` / `metadata.utm_campaign`. */
  utmSource?: string;
  utmCampaign?: string;
  /**
   * REFERRAL-LIGHT-W1 (C3): referral code. Stamped on BOTH session
   * `metadata.ref_code` (for checkout.session.completed) AND
   * `subscription_data.metadata.ref_code` so handleSubscriptionCreated reads it in
   * the same event it mints the api key (no cross-event race).
   */
  refCode?: string;
  /**
   * PRICING-ANNUAL-AND-HOLD-PROMISE-W1: billing interval. Added as an OPTIONAL FIELD on the
   * existing options object rather than a new positional param, so every current call site is
   * untouched and no caller can pass it in the wrong slot. Defaults to 'month'.
   */
  interval?: BillingInterval;
}

export async function createCheckoutSession(
  plan: PaidPlanId,
  baseUrl: string,
  opts: CheckoutSessionOptions = {},
): Promise<string | null> {
  if (!stripe) return null;
  const interval: BillingInterval = opts.interval === '6month' ? '6month' : 'month';

  // PRICING-ANNUAL-AND-HOLD-PROMISE-W1: `interval` is an OPTIONAL TRAILING param defaulting to
  // 'month', so every existing call site keeps its exact behaviour (CLAUDE.md enum-widening rule —
  // never insert a required/mid-signature param). null = that (plan, interval) is not configured,
  // e.g. Enterprise annual, which we deliberately do not sell.
  const priceId = priceIdFor(plan, interval);
  if (!priceId) return null;

  // ACTIVATION-PAYWALL-W1: optional UTM round-trip — Stripe persists metadata
  // on the Checkout Session, retrievable in checkout.session.completed event
  // for attribution-aware request_log write.
  const metadata: Record<string, string> = { tier: plan, billing_interval: interval };
  if (opts.utmSource) metadata.utm_source = opts.utmSource.slice(0, 64);
  if (opts.utmCampaign) metadata.utm_campaign = opts.utmCampaign.slice(0, 64);
  // REFERRAL-LIGHT-W1 (C3): ref_code on the session (read in checkout.session.completed).
  if (opts.refCode) metadata.ref_code = opts.refCode.slice(0, 16);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/signup?cancelled=true`,
    metadata,
    // REFERRAL-LIGHT-W1 (C3): also stamp ref_code on the SUBSCRIPTION object so
    // handleSubscriptionCreated (where the api key is minted) reads it in one event.
    ...(opts.refCode ? { subscription_data: { metadata: { ref_code: opts.refCode.slice(0, 16) } } } : {}),
    // client_reference_id is bounded to 200 chars per Stripe; we cap at 128
    // to leave headroom + sanitize down to safe URL-ish chars.
    ...(opts.clientReferenceId
      ? { client_reference_id: opts.clientReferenceId.replace(/[^a-zA-Z0-9_:\-.]/g, '_').slice(0, 128) }
      : {}),
  });

  return session.url;
}

// ── Customer API Key Retrieval ──

export async function getCustomerApiKey(sessionId: string): Promise<{ apiKey: string | null; tier: string | null; email: string | null }> {
  if (!stripe) return { apiKey: null, tier: null, email: null };

  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['customer', 'subscription'],
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const customer = session.customer as any;
  if (!customer || typeof customer === 'string') return { apiKey: null, tier: null, email: null };

  const apiKey = customer.metadata?.api_key || null;
  const email = customer.email || null;

  // Determine tier from subscription — PRICING-ANNUAL-AND-HOLD-PROMISE-W1: via the shared registry.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sub = session.subscription as any;
  const tier: string | null = sub?.items?.data ? highestTier(sub) : null;

  return { apiKey, tier, email };
}

// ── Webhook Handling ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function constructWebhookEvent(body: Buffer, signature: string): any {
  if (!stripe) return null;
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return null;

  return stripe.webhooks.constructEvent(body, signature, secret);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleSubscriptionCreated(
  event: any,
): Promise<{ customerId: string; apiKey: string; tier: string; refCode: string | null; email: string | null } | null> {
  if (!stripe) return null;

  const subscription = event.data.object;
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id;

  // Determine tier — PRICING-ANNUAL-AND-HOLD-PROMISE-W1.
  //
  // This site had DRIFTED from its three siblings: it never compared STARTER_PRICE_ID and fell
  // through to a bare `tier = 'starter'`, so an unrecognised price silently minted a Starter key.
  // Now it projects from the shared registry, and the unrecognised case is LOUD rather than mute.
  //
  // The fallback stays least-privilege ('starter', the cheapest paid tier) rather than throwing:
  // this runs inside the webhook that mints the customer's API key, and refusing here would leave
  // someone who has already been charged with no key at all. But an operator MUST see it — an
  // unrecognised price id here means a Price exists in Stripe that no env var binds, which is
  // exactly the misconfiguration that would under-entitle a paying customer.
  const resolvedTier = highestTier(subscription);
  const tier: string = resolvedTier ?? 'starter';
  if (!resolvedTier) {
    const seen = (subscription.items?.data ?? [])
      .map((i: { price?: { id?: string } }) => i?.price?.id ?? '?').join(', ');
    console.error(
      `[stripe] CRITICAL unrecognised price id(s) on subscription for customer ${customerId}: ` +
      `[${seen}]. No env var binds them, so the tier could not be derived; minting least-privilege ` +
      `'starter'. Bind the price in STRIPE_*_PRICE_ID and re-check this customer's entitlement.`,
    );
  }

  // Generate API key and store on customer metadata.
  // customer.update returns the full updated Customer including email — capture it
  // for the welcome email send below (no extra retrieve round-trip).
  const apiKey = generateApiKey();
  const updatedCustomer = await stripe.customers.update(customerId, {
    metadata: { api_key: apiKey, tier },
  });

  console.log(`Stripe: New ${tier} subscriber ${customerId} — API key provisioned`);

  // Fire welcome email. Try/catch so a Resend outage never 500s the webhook.
  // Per CLAUDE.md, every load-bearing side-effect inside try/except needs a
  // companion success-path log so silent success vs silent-catch are distinguishable.
  const email = updatedCustomer.email;
  if (email) {
    try {
      await sendWelcomeEmail({ to: email, apiKey, tier });
      console.log(`Stripe: welcome email sent to ${maskEmail(email)} for ${tier}`);
    } catch (err) {
      console.error('Stripe: welcome email send failed:', err instanceof Error ? err.message : err);
      // Don't rethrow — webhook returns 200 to Stripe regardless.
    }
  } else {
    console.warn(`Stripe: customer ${customerId} has no email — welcome email skipped`);
  }

  // REFERRAL-LIGHT-W1 (C3): surface the conversion + any ref_code (carried on the
  // subscription metadata by createCheckoutSession) so the webhook case can attribute
  // the paid conversion + grant the referee bonus with the freshly-minted key.
  const refCode = (subscription.metadata?.ref_code as string | undefined) || null;
  return { customerId, apiKey, tier, refCode, email: email ?? null };
}

// ── Account Portal Helpers ──

/**
 * Look up an active-subscription Stripe customer by api_key metadata.
 * Returns null if Stripe is not configured, key fails format check,
 * key isn't found, or the customer has no active subscription.
 *
 * OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 CH4 (Q4, architect-ratified): `email` is
 * ADDITIVE. This function already fetches the full customer object, which carries
 * `.email` — it was simply being discarded, so returning it costs ZERO extra
 * round-trips. Doing this rather than writing a second owner_key→email resolver
 * keeps single-derivation: there is exactly one api-key→customer lookup in the
 * codebase, and every caller projects from it. `email` is null when Stripe has no
 * email on the customer; callers MUST treat that as unreachable, never as an error.
 */
/**
 * A customer resolved from their API key, WITHOUT any entitlement judgement.
 *
 * `hasActiveSubscription` is the entitlement fact; `subscriptionStatus` is the billing fact.
 * They are reported SEPARATELY because callers ask genuinely different questions of them, and
 * collapsing the two is what caused the incident documented on `resolveCustomerByApiKey`.
 */
export interface ResolvedCustomer {
  customerId: string;
  tier: string;
  email: string | null;
  /** Stripe status of the most relevant subscription, or null when there is none at all. */
  subscriptionStatus: string | null;
  hasActiveSubscription: boolean;
}

/**
 * Owner API key → the customer, with NO entitlement filter applied.
 *
 * ── 🛑 WHY THIS EXISTS, MEASURED ────────────────────────────────────────────────────────────
 * `getCustomerByApiKey` searched Stripe, FOUND the customer, read their email — and then threw
 * the whole record away if `subscriptions.list({status:'active'})` came back empty. One boolean
 * was answering three different questions:
 *
 *   "may this key call the API?"        entitlement  — active-only is CORRECT
 *   "can we email this person?"         reachability — active-only is WRONG
 *   "may they open their own billing portal?"        — active-only is BACKWARDS
 *
 * Measured 2026-08-25 on `cus_UuBrP1otU51OBm` (owner `av_live_25cb…`, tier starter): customer
 * present, NOT deleted, email present, name present — and 0 subscriptions `active`, 1
 * `past_due`. Their card had failed (the same `insufficient_funds` Mastercard behind
 * PAYMENT_DECLINE_DRIFT), so the subscription went `past_due`, and that single status change
 * silently severed EVERY channel to them at once:
 *
 *   1. their webhook hit terminal-disable on 2026-08-24 and the notice was dropped with no
 *      trace — `resolveOwnerEmail` could not even reach its `subscriber_profiles` fallback,
 *      because that fallback is keyed on the `customerId` of the record just discarded;
 *   2. `/account/portal` answered their VALID key with `401 Invalid API key` — locking them out
 *      of the one page that fixes a failed card. A past_due customer is precisely who the
 *      billing portal exists for.
 *
 * So: this function reports what it found, and each caller applies its OWN predicate.
 * `getCustomerByApiKey` below is that predicate for entitlement and is byte-identical to what
 * it always was — no existing caller's behaviour moves.
 */
export async function resolveCustomerByApiKey(apiKey: string): Promise<ResolvedCustomer | null> {
  if (!stripe) return null;
  if (!/^[a-zA-Z0-9_]+$/.test(apiKey)) return null;

  try {
    const customers = await stripe.customers.search({
      query: `metadata['api_key']:'${apiKey}'`,
      limit: 1,
    });
    if (customers.data.length === 0) return null;
    const customer = customers.data[0];
    // A DELETED customer is genuinely unresolvable — no email, no portal, nothing to manage.
    if ('deleted' in customer && customer.deleted) return null;

    // ONE list call, `status: 'all'`. The previous code listed `status: 'active'` and could
    // therefore only ever learn "active or nothing"; this costs the same request and returns
    // both facts, so neither has to be inferred from the other's absence.
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 10 });
    const active = subs.data.find((s) => s.status === 'active') ?? null;
    // Newest-first is Stripe's documented list order, so [0] is the most recent subscription —
    // the one whose status a human would recognise as "their current billing state".
    const relevant = active ?? subs.data[0] ?? null;

    const tier = (customer.metadata?.tier as string) || 'starter';
    // `customer` is a Customer | DeletedCustomer union in the SDK types; a deleted
    // customer carries no email. Guard rather than cast so a deleted-but-searchable
    // record degrades to "unreachable" instead of throwing.
    const email = 'email' in customer && typeof customer.email === 'string' ? customer.email : null;
    return {
      customerId: customer.id,
      tier,
      email,
      subscriptionStatus: relevant?.status ?? null,
      hasActiveSubscription: active !== null,
    };
  } catch (err) {
    console.error('Stripe resolveCustomerByApiKey error:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * ENTITLEMENT. Owner API key → customer, but ONLY while they hold an ACTIVE subscription.
 *
 * Unchanged contract, deliberately: this is the predicate every incumbent caller already
 * depends on (`referral-accrual` credits a Stripe balance off it), and widening it here would
 * silently change who gets paid. Reachability and billing self-service use
 * `resolveCustomerByApiKey` instead — see its docstring for why the two must not be one call.
 */
export async function getCustomerByApiKey(apiKey: string): Promise<{ customerId: string; tier: string; email: string | null } | null> {
  const c = await resolveCustomerByApiKey(apiKey);
  if (!c || !c.hasActiveSubscription) return null;
  return { customerId: c.customerId, tier: c.tier, email: c.email };
}

// Exported for cross-module reuse (POWER-USER-OUTREACH-W1-V2 /api/signup-email).
export const EMAIL_RE = /^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/;

/**
 * Look up an active-subscription customer by billing email.
 * Returns the apiKey + tier so the recovery handler can fire the email.
 * Returns null on no-match, no-active-sub, missing-api-key-metadata, or invalid email format.
 */
export async function getCustomerByEmail(email: string): Promise<{ apiKey: string; tier: string } | null> {
  if (!stripe) return null;
  if (!EMAIL_RE.test(email)) return null;

  try {
    // Stripe's search query uses single quotes around the value — already format-validated above.
    const customers = await stripe.customers.search({
      query: `email:'${email}'`,
      limit: 1,
    });
    if (customers.data.length === 0) return null;
    const customer = customers.data[0];
    const apiKey = customer.metadata?.api_key;
    if (!apiKey) return null;

    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 10,
    });
    if (subs.data.length === 0) return null;

    const tier = (customer.metadata?.tier as string) || 'starter';
    return { apiKey, tier };
  } catch (err) {
    console.error('Stripe getCustomerByEmail error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Active-subscription tier census (H0-C4-MEASURE-CLOSE) ──
//
// The CANONICAL "paying subscribers" headline for the funnel scoreboard: a
// read-only census of ALL active Stripe subscriptions grouped by price → tier,
// reusing the SAME STARTER/PRO/ENTERPRISE_PRICE_ID map as validateApiKey (single
// derivation — the price→tier logic lives in exactly one place). Read-only; no
// tool-surface / envelope / mutation. Cached 5 min (operator-ratified) so an
// admin dashboard reload does not re-page the Stripe API. Returns null when
// Stripe is unconfigured → the caller falls back to the subscriber_profiles cache.

/** One observed (tier, interval) cell of the active-subscription census. */
export interface TierIntervalCount {
  readonly tier: PaidPlanId;
  readonly interval: BillingInterval;
  readonly count: number;
}

export interface ActiveSubscriberTierCensus {
  starter: number;
  pro: number;
  enterprise: number;
  total: number;
  /**
   * ADDITIVE (OPS-STRIPE-SUBSCRIPTION-TRUTH-W1): the same census split by billing interval.
   *
   * The flat `starter`/`pro`/`enterprise`/`total` fields above are now PROJECTIONS of this
   * array, not a parallel count — so the headline and the composition cannot disagree. Every
   * pre-existing consumer keeps reading the flat fields unchanged.
   *
   * Only OBSERVED cells appear; an absent (tier, interval) means zero. Nothing emits a row for
   * a pair that cannot be sold — there is no (enterprise, year) Price — so a reader must treat
   * absent as 0 rather than expecting a full grid. Order is deterministic (tier rank, then
   * interval rank), never Stripe's page order.
   *
   * This is what makes "how many of the 3 starters are annual" answerable at all. Before it,
   * the live Stripe census collapsed both intervals into one tier and could not say.
   */
  composition: readonly TierIntervalCount[];
  source: 'stripe_live' | 'stripe_cache';
  as_of: number; // epoch ms the underlying Stripe read completed
}

let tierCensusCache: { value: ActiveSubscriberTierCensus; expiresAt: number } | null = null;

/**
 * Total active subscriptions on a tier, across every interval. Pure; exported so the
 * reconciliation and the funnel project the same way instead of re-summing independently.
 */
export function censusTierTotal(composition: readonly TierIntervalCount[], tier: PaidPlanId): number {
  return composition.reduce((n, c) => (c.tier === tier ? n + c.count : n), 0);
}

/**
 * Fold resolved subscriptions into a deterministically-ordered composition.
 *
 * Pure + exported for test. The sort is by OUR rank tables, so the emitted order is a function
 * of the declared precedence and never of the order Stripe returned the subscriptions in.
 */
export function buildCensusComposition(
  resolved: ReadonlyArray<ResolvedSubscription>,
): readonly TierIntervalCount[] {
  const counts = new Map<string, TierIntervalCount>();
  for (const r of resolved) {
    const key = `${r.tier}:${r.interval}`;
    const prev = counts.get(key);
    counts.set(key, { tier: r.tier, interval: r.interval, count: (prev?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort(
    (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || INTERVAL_RANK[a.interval] - INTERVAL_RANK[b.interval],
  );
}

/**
 * Count active Stripe subscriptions by tier. null when Stripe is unconfigured.
 * Auto-pages the full active set (limit 100/page). Fail-open: on a Stripe error
 * with a warm cache, returns the cached value (marked stripe_cache); with no
 * cache, returns null so the caller degrades to subscriber_profiles.
 */
export async function countActiveSubscriptionsByTier(now: number = Date.now()): Promise<ActiveSubscriberTierCensus | null> {
  if (!stripe) return null;
  if (tierCensusCache && now < tierCensusCache.expiresAt) {
    return { ...tierCensusCache.value, source: 'stripe_cache' };
  }
  try {
    const resolved: ResolvedSubscription[] = [];
    // Stripe SDK async iterator auto-pages through every active subscription.
    for await (const sub of stripe.subscriptions.list({ status: 'active', limit: 100 })) {
      // ONE resolver for tier AND interval (PRICING-ANNUAL-AND-HOLD-PROMISE-W1 collapsed the
      // 4 copies of the tier precedence; OPS-STRIPE-SUBSCRIPTION-TRUTH-W1 added the cadence to
      // the same one). A sub on no recognized price resolves null and is not counted, which
      // avoids inflating the headline — unchanged behaviour.
      const r = resolveSubscription(sub);
      if (r) resolved.push(r);
    }
    const composition = buildCensusComposition(resolved);
    // The flat headline fields PROJECT from the composition — never counted a second time.
    const starter = censusTierTotal(composition, 'starter');
    const pro = censusTierTotal(composition, 'pro');
    const enterprise = censusTierTotal(composition, 'enterprise');
    const value: ActiveSubscriberTierCensus = {
      starter, pro, enterprise, total: starter + pro + enterprise,
      composition,
      source: 'stripe_live', as_of: now,
    };
    tierCensusCache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
  } catch (err) {
    console.error('Stripe countActiveSubscriptionsByTier error:', err instanceof Error ? err.message : err);
    if (tierCensusCache) return { ...tierCensusCache.value, source: 'stripe_cache' };
    return null;
  }
}

/**
 * Create a Stripe Billing Portal session and return the URL.
 * Trust+Sentinel: if Stripe ever returns "No configuration provided" (operator
 * deleted the portal config), fire a CRITICAL Telegram alert and return null
 * so the route can surface a 503 to the user.
 */
export async function createBillingPortalSession(args: { customerId: string; returnUrl: string }): Promise<string | null> {
  if (!stripe) return null;
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: args.customerId,
      return_url: args.returnUrl,
    });
    return session.url;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Stripe createBillingPortalSession error:', msg);
    if (/no configuration provided/i.test(msg) || /no.+default.+configuration/i.test(msg)) {
      // Sentinel: operator dropped the portal config. Page on-call.
      sendAlert(`🚨 Stripe Billing Portal config missing — /account/portal returning 503. Restore config at dashboard.stripe.com/settings/billing/portal`, 'critical')
        .catch(() => {});
    }
    return null;
  }
}

/**
 * Webhook handler for `checkout.session.completed` (ACTIVATION-PAYWALL-W1).
 *
 * Returns a structured payload that the index.ts switch case writes to
 * `request_log` (license_tier promotion + UTM attribution). Idempotency is
 * enforced UPSTREAM in index.ts via `tryClaimEvent(event.id)` — this function
 * runs only when the event is the first observed delivery.
 *
 * The promotion writes a NEW `request_log` row with `tool_name='stripe_checkout_completed'`
 * + `license_tier=<new tier>` + `session_id=<stripe session id>` to anchor
 * the conversion event for future AC4-organic measurement. UTM tags are
 * recovered from `event.data.object.metadata.utm_*` (set in `createCheckoutSession`).
 */
export interface CheckoutCompletedSummary {
  sessionId: string;
  tier: 'starter' | 'pro' | 'enterprise';
  customerEmail: string | null;
  amountTotal: number | null;
  utmSource: string | null;
  utmCampaign: string | null;
  clientReferenceId: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function summarizeCheckoutCompleted(event: any): CheckoutCompletedSummary | null {
  const session = event?.data?.object;
  if (!session || typeof session !== 'object') return null;
  const sessionId = typeof session.id === 'string' ? session.id : null;
  if (!sessionId) return null;

  // Tier resolution: prefer the explicit metadata field set in
  // createCheckoutSession; fall back to amount_total inspection for
  // safety on legacy Checkout Sessions that pre-date this wave.
  const metaTier = session.metadata?.tier;
  let tier: 'starter' | 'pro' | 'enterprise';
  if (metaTier === 'starter' || metaTier === 'pro' || metaTier === 'enterprise') {
    tier = metaTier;
  } else {
    const amount = typeof session.amount_total === 'number' ? session.amount_total : 0;
    if (amount >= 29900) tier = 'enterprise';
    else if (amount >= 4900) tier = 'pro';
    else tier = 'starter';
  }

  return {
    sessionId,
    tier,
    customerEmail: session.customer_email ?? session.customer_details?.email ?? null,
    amountTotal: typeof session.amount_total === 'number' ? session.amount_total : null,
    utmSource: session.metadata?.utm_source ?? null,
    utmCampaign: session.metadata?.utm_campaign ?? null,
    clientReferenceId: session.client_reference_id ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleSubscriptionDeleted(event: any): Promise<void> {
  const subscription = event.data.object;
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id;

  // Invalidate cache
  invalidateCacheForCustomer(customerId);
  console.log(`Stripe: Subscription cancelled for ${customerId}`);

  // OPS-STRIPE-SUBSCRIPTION-TRUTH-W2 CH2 — propagate the cancellation to the RECORD.
  //
  // Until now this handler invalidated a cache and logged, and nothing ever moved
  // `subscriber_profiles.status` off the literal `'active'` written at conversion. A cancelled
  // subscriber therefore read `active` forever, which makes MRR and every active-count
  // OVER-report — the mirror of the under-report `.updated` causes.
  //
  // The value is READ FROM THE EVENT (`canceled`), never a literal invented here: Stripe owns
  // that vocabulary and it is the only party that knows the terminal state.
  //
  // FORWARD GUARD, NO BACKFILL: zero cancelled subscriptions exist today, so this changes no
  // existing row. It is armed for the first cancellation, not a repair of a past one.
  await propagateSubscriptionToRecord(customerId, {
    status: asSubscriptionStatus(subscription?.status) ?? 'canceled',
  }, 'customer.subscription.deleted');
}

/** The subscription status as Stripe reports it, or null when the payload carries none. */
function asSubscriptionStatus(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Push resolved subscription facts into `subscriber_profiles`.
 *
 * ⚠️ **The import is DYNAMIC, and that is load-bearing, not stylistic.** `subscriber-attribution`
 * imports `license.ts`, which imports `validateApiKey` from THIS module (`license.ts:12`), so a
 * static import would close a require cycle straight through the license hot path. `index.ts`
 * already lazy-imports the profiler for the same reason.
 *
 * FAIL-OPEN. This is a reporting write on a Stripe webhook path: it must never throw, never
 * block the ACK, and never touch entitlement. An error here costs a stale row, which the
 * reconciliation is there to catch; a throw here would cost the webhook.
 */
async function propagateSubscriptionToRecord(
  customerId: string,
  fields: { tier?: string | null; billingInterval?: StoredBillingInterval; status?: string | null; subscriptionId?: string | null },
  source: string,
): Promise<void> {
  try {
    const { applySubscriptionRecordUpdate } = await import('./subscriber-attribution.js');
    const outcome = await applySubscriptionRecordUpdate({ customerId, ...fields });
    // Both branches log (CLAUDE.md: a load-bearing side-effect inside try/catch needs a
    // success-path log). `absent` is a FACT, not an error — a lifecycle event carries none of
    // the attribution signals a profile needs, so it must never mint one.
    console.log(`[${source}] record update for ${customerId}: ${outcome}`);
  } catch (err) {
    console.error(`[${source}] record update failed (fail-open):`, err instanceof Error ? err.message : err);
  }
}

/**
 * `customer.subscription.updated` — the event that has never reached the record.
 * OPS-STRIPE-SUBSCRIPTION-TRUTH-W2 CH2.
 *
 * Resolves tier AND interval from the subscription's PRICE ID through the one registry
 * (`resolveSubscription`), never from event prose — the same resolver `validateApiKey` and the
 * census project from, so the record cannot disagree with entitlement about what was bought.
 *
 * ⚠️ This event fires for many reasons that do not move money: trial changes, payment-method
 * updates, metadata edits, cancel-at-period-end. The no-op decision lives in
 * `applySubscriptionRecordUpdate`, which compares BOTH dimensions plus status against the stored
 * row — so noise does not churn the profile, while a monthly→annual switch (real money, on sale
 * since 2026-08-05) is correctly NOT a no-op.
 *
 * Entitlement is untouched. `validateApiKey` reads the live subscription on every call and was
 * always correct; this fixes the RECORD. Do not "unify" them — they answer different questions
 * at different times, and the record is allowed to lag by a webhook.
 */
export async function handleSubscriptionUpdated(event: any): Promise<void> {
  const subscription = event?.data?.object;
  const rawCustomer = subscription?.customer;
  const customerId = typeof rawCustomer === 'string' ? rawCustomer : rawCustomer?.id;
  if (!customerId) {
    console.warn('Stripe: customer.subscription.updated with no customer id — skipping (fail-open)');
    return;
  }

  // Entitlement cache: what the customer is entitled to may have just changed.
  invalidateCacheForCustomer(customerId);

  const resolved = resolveSubscription(subscription ?? { items: { data: [] } });
  if (!resolved) {
    // "We do not recognise what this customer bought" is a distinct fact from any tier, and must
    // not be written as one. Status still propagates — it is knowable regardless of the price.
    console.warn(`Stripe: customer.subscription.updated for ${customerId} on an unrecognised price — tier/interval left unchanged`);
    await propagateSubscriptionToRecord(customerId, {
      status: asSubscriptionStatus(subscription?.status),
    }, 'customer.subscription.updated');
    return;
  }

  await propagateSubscriptionToRecord(customerId, {
    tier: resolved.tier,
    billingInterval: resolved.interval,
    status: asSubscriptionStatus(subscription?.status),
    subscriptionId: typeof subscription?.id === 'string' ? subscription.id : null,
  }, 'customer.subscription.updated');
}

// ── Payment-method attribution (PAY-UNIONPAY-ATTRIBUTION-W1 / R3) ──

/**
 * Fetch the payment-method dimension for a completed Checkout Session or a Subscription.
 *
 * ⚠️ **The obvious path does not exist for our flow.** Every Checkout Session this repo
 * creates is `mode: 'subscription'` (`stripe.ts` line ~401, the only `checkout.sessions.create`
 * in the tree), and on a subscription session `payment_intent` is **null** — Stripe bills
 * through an Invoice instead. So `session.payment_intent → latest_charge` silently resolves to
 * nothing for 100% of real traffic. The card data hangs off the INVOICE. Three ordered
 * attempts, most-informative first:
 *
 *   1. `session.payment_intent`  → PI → `latest_charge.payment_method_details`  (one-off mode)
 *   2. `session.invoice`         → Invoice → PI → `latest_charge…`              (OUR flow)
 *   3. `session.subscription`    → Subscription → `default_payment_method`      (last resort)
 *
 * A CHARGE is preferred over a PaymentMethod because only the charge carries
 * `payment_method_details.card.country` and `.funding` — the issuer-country field that makes
 * the mainland-China cohort visible at all. A bare PaymentMethod would give us brand and
 * nothing else, which is why it is the fallback rather than the first try.
 *
 * Fail-open by contract: returns `null` on any error. This runs inside the fire-and-forget
 * profiler, and an enrichment miss must never cost the profile row.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchPaymentMethodForSession(sessionOrSubscription: any): Promise<PaymentMethodAttribution | null> {
  const client = getStripeClient();
  if (!client) return null;
  const src = sessionOrSubscription;
  if (!src || typeof src !== 'object') return null;

  const idOf = (v: unknown): string | null =>
    typeof v === 'string' ? v : (typeof (v as { id?: unknown })?.id === 'string' ? (v as { id: string }).id : null);

  try {
    // (1) direct PaymentIntent — non-subscription sessions only.
    const piId = idOf(src.payment_intent);
    if (piId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pi: any = await client.paymentIntents.retrieve(piId, { expand: ['latest_charge'] });
      if (pi?.latest_charge) return resolvePaymentMethodAttribution(pi.latest_charge);
    }

    // (2) via the Invoice — THE path for `mode: 'subscription'`.
    const invoiceId = idOf(src.invoice) ?? idOf(src.latest_invoice);
    if (invoiceId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inv: any = await client.invoices.retrieve(invoiceId, { expand: ['payment_intent.latest_charge'] });
      const charge = inv?.payment_intent?.latest_charge;
      if (charge) return resolvePaymentMethodAttribution(charge);
    }

    // (3) the subscription's default payment method — brand only, no issuer country.
    const subId = idOf(src.subscription) ?? (typeof src.object === 'string' && src.object === 'subscription' ? idOf(src) : null);
    if (subId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sub: any = await client.subscriptions.retrieve(subId, { expand: ['default_payment_method'] });
      if (sub?.default_payment_method) return resolvePaymentMethodAttribution(sub.default_payment_method);
    }
  } catch (err) {
    console.warn('[fetchPaymentMethodForSession] fail-open:', err instanceof Error ? err.message : err);
    return null;
  }
  return null;
}

// ── Helpers ──

export function isStripeConfigured(): boolean {
  return STRIPE_SECRET_KEY.length > 0;
}
