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

// Stripe v22 exports the class as both named and default.
// Node16 moduleResolution resolves the default export reliably.
const StripeClient = DefaultStripe as unknown as typeof DefaultStripe & { new(key: string): InstanceType<typeof DefaultStripe> };

// ── Configuration ──

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STARTER_PRICE_ID = process.env.STRIPE_STARTER_PRICE_ID || '';
const PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID || '';
const ENTERPRISE_PRICE_ID = process.env.STRIPE_ENTERPRISE_PRICE_ID || '';

let stripe: InstanceType<typeof DefaultStripe> | null = null;

if (STRIPE_SECRET_KEY) {
  stripe = new StripeClient(STRIPE_SECRET_KEY);
}

// ── Types ──

export interface StripeValidation {
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
   */
  indeterminate?: true;
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

export async function validateApiKey(apiKey: string): Promise<StripeValidation> {
  // Not configured is "cannot determine", NOT "invalid" — the distinction the caller needs.
  if (!stripe) return { valid: false, indeterminate: true };

  // Validate key format to prevent query injection
  if (!/^[a-zA-Z0-9_]+$/.test(apiKey)) return { valid: false };

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
      const result: StripeValidation = { valid: false };
      cache.set(apiKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    }

    const customer = customers.data[0];

    // Check for active subscriptions
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 10,
    });

    let tier: 'starter' | 'pro' | 'enterprise' | undefined;

    for (const sub of subscriptions.data) {
      for (const item of sub.items.data) {
        const priceId = item.price.id;
        if (priceId === ENTERPRISE_PRICE_ID) {
          tier = 'enterprise';
          break;
        }
        if (priceId === PRO_PRICE_ID) {
          tier = 'pro';
        }
        if (priceId === STARTER_PRICE_ID && !tier) {
          tier = 'starter';
        }
      }
      if (tier === 'enterprise') break; // enterprise wins
    }

    const result: StripeValidation = tier
      ? { valid: true, tier, customerId: customer.id }
      : { valid: false, customerId: customer.id };

    cache.set(apiKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err) {
    // OPS-ZERO-VS-UNKNOWN-W1: an unreachable Stripe is INDETERMINATE, never "invalid".
    console.error('Stripe validateApiKey error:', err instanceof Error ? err.message : err);
    recordIndeterminate('stripe_validate_api_key');
    return { valid: false, indeterminate: true };
  }
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
}

export async function createCheckoutSession(
  plan: 'starter' | 'pro' | 'enterprise',
  baseUrl: string,
  opts: CheckoutSessionOptions = {},
): Promise<string | null> {
  if (!stripe) return null;

  const priceId = plan === 'enterprise' ? ENTERPRISE_PRICE_ID : plan === 'starter' ? STARTER_PRICE_ID : PRO_PRICE_ID;
  if (!priceId) return null;

  // ACTIVATION-PAYWALL-W1: optional UTM round-trip — Stripe persists metadata
  // on the Checkout Session, retrievable in checkout.session.completed event
  // for attribution-aware request_log write.
  const metadata: Record<string, string> = { tier: plan };
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

  // Determine tier from subscription
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sub = session.subscription as any;
  let tier: string | null = null;
  if (sub && sub.items?.data) {
    for (const item of sub.items.data) {
      if (item.price.id === ENTERPRISE_PRICE_ID) { tier = 'enterprise'; break; }
      if (item.price.id === PRO_PRICE_ID) { tier = 'pro'; }
      if (item.price.id === STARTER_PRICE_ID && !tier) { tier = 'starter'; }
    }
  }

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

  // Determine tier
  let tier = 'starter';
  for (const item of subscription.items.data) {
    if (item.price.id === ENTERPRISE_PRICE_ID) { tier = 'enterprise'; break; }
    if (item.price.id === PRO_PRICE_ID) { tier = 'pro'; }
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
export async function getCustomerByApiKey(apiKey: string): Promise<{ customerId: string; tier: string; email: string | null } | null> {
  if (!stripe) return null;
  if (!/^[a-zA-Z0-9_]+$/.test(apiKey)) return null;

  try {
    const customers = await stripe.customers.search({
      query: `metadata['api_key']:'${apiKey}'`,
      limit: 1,
    });
    if (customers.data.length === 0) return null;
    const customer = customers.data[0];

    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'active',
      limit: 10,
    });
    if (subs.data.length === 0) return null;

    const tier = (customer.metadata?.tier as string) || 'starter';
    // `customer` is a Customer | DeletedCustomer union in the SDK types; a deleted
    // customer carries no email. Guard rather than cast so a deleted-but-searchable
    // record degrades to "unreachable" instead of throwing.
    const email = 'email' in customer && typeof customer.email === 'string' ? customer.email : null;
    return { customerId: customer.id, tier, email };
  } catch (err) {
    console.error('Stripe getCustomerByApiKey error:', err instanceof Error ? err.message : err);
    return null;
  }
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

export interface ActiveSubscriberTierCensus {
  starter: number;
  pro: number;
  enterprise: number;
  total: number;
  source: 'stripe_live' | 'stripe_cache';
  as_of: number; // epoch ms the underlying Stripe read completed
}

let tierCensusCache: { value: ActiveSubscriberTierCensus; expiresAt: number } | null = null;

/** Map ONE subscription to its highest tier via the price-id map (enterprise > pro > starter). */
function subscriptionTier(sub: { items: { data: Array<{ price: { id: string } }> } }): 'starter' | 'pro' | 'enterprise' | null {
  let tier: 'starter' | 'pro' | 'enterprise' | null = null;
  for (const item of sub.items.data) {
    const priceId = item.price.id;
    if (priceId === ENTERPRISE_PRICE_ID) return 'enterprise'; // enterprise wins outright
    if (priceId === PRO_PRICE_ID) tier = 'pro';
    else if (priceId === STARTER_PRICE_ID && tier !== 'pro') tier = 'starter';
  }
  return tier;
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
    let starter = 0, pro = 0, enterprise = 0;
    // Stripe SDK async iterator auto-pages through every active subscription.
    for await (const sub of stripe.subscriptions.list({ status: 'active', limit: 100 })) {
      const tier = subscriptionTier(sub);
      if (tier === 'enterprise') enterprise++;
      else if (tier === 'pro') pro++;
      else if (tier === 'starter') starter++;
      // A sub on no recognized price is not counted (avoids inflating the headline).
    }
    const value: ActiveSubscriberTierCensus = {
      starter, pro, enterprise, total: starter + pro + enterprise,
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
}

// ── Helpers ──

export function isStripeConfigured(): boolean {
  return STRIPE_SECRET_KEY.length > 0;
}
