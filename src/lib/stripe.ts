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
}

// ── API Key Generation ──

export function generateApiKey(): string {
  const hex = crypto.randomBytes(12).toString('hex'); // 24 hex chars
  return `av_live_${hex}`;
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
  if (!stripe) return { valid: false };

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
    console.error('Stripe validateApiKey error:', err instanceof Error ? err.message : err);
    return { valid: false };
  }
}

// ── Checkout Session Creation ──

export async function createCheckoutSession(plan: 'starter' | 'pro' | 'enterprise', baseUrl: string): Promise<string | null> {
  if (!stripe) return null;

  const priceId = plan === 'enterprise' ? ENTERPRISE_PRICE_ID : plan === 'starter' ? STARTER_PRICE_ID : PRO_PRICE_ID;
  if (!priceId) return null;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/signup?cancelled=true`,
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
export async function handleSubscriptionCreated(event: any): Promise<void> {
  if (!stripe) return;

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

  // Generate API key and store on customer metadata
  const apiKey = generateApiKey();
  await stripe.customers.update(customerId, {
    metadata: { api_key: apiKey, tier },
  });

  console.log(`Stripe: New ${tier} subscriber ${customerId} — API key provisioned`);
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
