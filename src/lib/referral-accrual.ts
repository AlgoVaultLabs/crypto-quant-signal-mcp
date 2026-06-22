/**
 * REFERRAL-LIGHT-W1 / C3 — the money path: attribution capture, commission
 * accrual, auto Stripe-credit / USDC-pending ledger, and refund clawback.
 *
 * Every side-effect is idempotent + fail-open (a referral error MUST NEVER block
 * the revenue path: signup, checkout, or the webhook ACK). Accrual idempotency is
 * the `referral_ledger.stripe_event_id UNIQUE` claim taken BEFORE the credit, so a
 * Stripe webhook retry never double-credits.
 *
 * Boundaries: this module owns the Stripe balance-credit + webhook-config calls
 * (via getStripeClient); persistence is the frozen referral-store (C1); the bonus
 * meter sync is license.grantReferralBonus (C2). NO email/page imports (C4).
 */
import { getStripeClient, getCustomerByApiKey } from './stripe.js';
import { recordFunnelEvent, dbQuery } from './performance-db.js';
import {
  resolveCode,
  recordAttribution,
  getAttributionByCustomer,
  appendLedger,
  markLedger,
  deriveUserCode,
  referrerStats,
  type ReferralCodeRow,
} from './referral-store.js';
import { grantReferralBonus } from './license.js';
import { mintFreeKey } from './free-keys-store.js';
import { REFERRAL_TERMS } from './referral-constants.js';
import { notifyFriendJoined, notifyCommissionEarned } from './referral-notify.js';

const ENDPOINT_URL = 'https://api.algovault.com/webhooks/stripe';
const REQUIRED_EVENTS = ['invoice.paid', 'charge.refunded'];

/**
 * Self-referral guard: the referee may not be the code owner (by email or key),
 * and may not redeem their own derived user-code. Capture still 200s elsewhere;
 * this only refuses the attribution + bonus.
 */
function isSelfReferral(code: ReferralCodeRow, refereeEmail: string | null, refereeKey: string | null): boolean {
  if (code.owner_email && refereeEmail && code.owner_email.toLowerCase() === refereeEmail.toLowerCase()) return true;
  if (code.owner_key && refereeKey && code.owner_key === refereeKey) return true;
  if (refereeKey && code.kind === 'user' && deriveUserCode(refereeKey) === code.code) return true;
  return false;
}

/** Commission window end = now + COMMISSION_MONTHS (calendar months). */
function commissionWindowEnd(): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + REFERRAL_TERMS.COMMISSION_MONTHS);
  return d.toISOString();
}

export interface FreeReferralResult {
  applied: boolean;
  freeKey: string | null;
  bonusCalls: number;
  reason?: 'no_ref' | 'invalid_ref' | 'self_referral' | 'already_attributed';
}

/**
 * Free-signup path (called by /api/signup-email on a fresh opt-in). A valid,
 * non-self ref mints an av_free_ key, records the attribution (one grant per
 * human — referee_email UNIQUE), and grants the +500 referee bonus. Invalid /
 * absent / self ref → plain signup (no key, no bonus). Never throws.
 */
export async function processFreeReferralSignup(email: string, refCode: string | null | undefined): Promise<FreeReferralResult> {
  if (!refCode) return { applied: false, freeKey: null, bonusCalls: 0, reason: 'no_ref' };
  try {
    const code = await resolveCode(refCode);
    if (!code) return { applied: false, freeKey: null, bonusCalls: 0, reason: 'invalid_ref' };
    if (isSelfReferral(code, email, null)) return { applied: false, freeKey: null, bonusCalls: 0, reason: 'self_referral' };

    const freeKey = await mintFreeKey(email, code.code);
    const attr = await recordAttribution({
      code: code.code,
      referee_email: email,
      referee_key: freeKey,
      channel: 'free_signup',
    });
    if (!attr.recorded) {
      // referee_email already attributed — one grant per human; key still returned.
      return { applied: false, freeKey, bonusCalls: 0, reason: 'already_attributed' };
    }
    await grantReferralBonus(freeKey, REFERRAL_TERMS.BONUS_CALLS, code.code);
    recordFunnelEvent({ eventType: 'referral_signup', sessionId: null, licenseTier: 'free', meta: { code: code.code, channel: 'free_signup' } });
    if (attr.id != null) await notifyFriendJoined(code.code, attr.id); // fail-soft inside
    return { applied: true, freeKey, bonusCalls: REFERRAL_TERMS.BONUS_CALLS };
  } catch (err) {
    console.error('[referral] processFreeReferralSignup failed (fail-open):', err instanceof Error ? err.message : err);
    return { applied: false, freeKey: null, bonusCalls: 0 };
  }
}

/**
 * Paid-conversion path (called from the customer.subscription.created webhook
 * case with the minted key + the ref_code carried on subscription metadata).
 * Records the paid attribution (with the 12-month commission window) + grants the
 * referee bonus. Never throws.
 */
export async function onPaidConversion(params: {
  customerId: string;
  apiKey: string;
  refCode: string | null;
  email: string | null;
}): Promise<void> {
  if (!params.refCode) return;
  try {
    const code = await resolveCode(params.refCode);
    if (!code) return;
    if (isSelfReferral(code, params.email, params.apiKey)) return;
    const attr = await recordAttribution({
      code: code.code,
      referee_email: params.email,
      referee_key: params.apiKey,
      channel: 'paid_checkout',
      stripe_customer_id: params.customerId,
      window_ends_at: commissionWindowEnd(),
    });
    if (attr.recorded) {
      await grantReferralBonus(params.apiKey, REFERRAL_TERMS.BONUS_CALLS, code.code);
      recordFunnelEvent({ eventType: 'referral_signup', sessionId: params.customerId, licenseTier: 'pro', meta: { code: code.code, channel: 'paid_checkout' } });
      if (attr.id != null) await notifyFriendJoined(code.code, attr.id); // fail-soft inside
    }
  } catch (err) {
    console.error('[referral] onPaidConversion failed (fail-open):', err instanceof Error ? err.message : err);
  }
}

/**
 * invoice.paid → accrue 30% commission to the referrer for 12 months. Idempotent
 * on the Stripe event id (the ledger claim is taken BEFORE the credit, so a retry
 * never double-credits). Referrer with a Stripe customer → auto balance-credit
 * (status credited); otherwise the row parks usdc_pending (manual ≥$50 payout).
 */
export async function processInvoicePaid(event: { id: string; data?: { object?: Record<string, unknown> } }): Promise<void> {
  try {
    const invoice = event?.data?.object;
    if (!invoice) return;
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer as { id?: string } | null)?.id;
    const amountPaid = Number(invoice.amount_paid ?? 0); // cents (e2)
    if (!customerId || amountPaid <= 0) return;

    const attr = await getAttributionByCustomer(customerId);
    if (!attr || attr.channel !== 'paid_checkout') return;
    if (attr.window_ends_at && Date.now() >= new Date(attr.window_ends_at).getTime()) return; // window expired

    const commission = Math.round(amountPaid * REFERRAL_TERMS.COMMISSION_RATE); // cents (e2)
    if (commission <= 0) return;

    // Claim the event id BEFORE the credit (idempotency). Park as usdc_pending;
    // flip to credited only after a successful Stripe balance transaction.
    const led = await appendLedger({
      code: attr.code,
      attribution_id: attr.id,
      stripe_event_id: event.id,
      invoice_id: (invoice.id as string) ?? null,
      gross_usd_e2: amountPaid,
      commission_usd_e2: commission,
      status: 'usdc_pending',
    });
    if (!led.appended || led.id == null) {
      console.log(`[referral] invoice.paid ${event.id} already accrued — skipping (idempotent)`);
      return;
    }

    let credited = false;
    const code = await resolveCode(attr.code);
    const ownerKey = code?.owner_key ?? null;
    if (ownerKey) {
      const cust = await getCustomerByApiKey(ownerKey);
      const stripe = getStripeClient();
      if (cust && stripe) {
        try {
          const txn = await stripe.customers.createBalanceTransaction(cust.customerId, {
            amount: -commission, // negative = credit toward the referrer's next invoice
            currency: 'usd',
            description: `AlgoVault referral commission — code ${attr.code}, invoice ${invoice.id}`,
          });
          markLedger(led.id, 'credited', txn.id);
          credited = true;
          console.log(`[referral] credited ${commission}c to referrer ${cust.customerId} (code ${attr.code})`);
        } catch (err) {
          console.error('[referral] createBalanceTransaction failed → parking usdc_pending:', err instanceof Error ? err.message : err);
        }
      }
    }
    if (!credited) {
      console.log(`[referral] commission ${commission}c parked usdc_pending (code ${attr.code} — no Stripe customer or credit failed)`);
    }
    recordFunnelEvent({ eventType: 'referral_conversion', sessionId: customerId, licenseTier: 'pro', meta: { code: attr.code, commission_usd_e2: commission, credited } });
    // commission_earned notification (fail-soft inside; idempotent on the ledger id).
    const rstats = await referrerStats(attr.code);
    await notifyCommissionEarned(attr.code, led.id, { amount_usd_e2: commission, pending_usd_e2: rstats.usdc_pending_usd_e2 });
  } catch (err) {
    console.error('[referral] processInvoicePaid failed (fail-open):', err instanceof Error ? err.message : err);
  }
}

/**
 * charge.refunded → claw back any commission accrued on the refunded invoice.
 * A credited row's Stripe balance credit is reversed (debit); a usdc_pending row
 * is simply voided. Idempotent: only credited/usdc_pending rows are clawed (a
 * replay finds none). Never throws.
 */
export async function processChargeRefunded(event: { data?: { object?: Record<string, unknown> } }): Promise<void> {
  try {
    const charge = event?.data?.object;
    const invoiceId = charge?.invoice;
    if (!invoiceId || typeof invoiceId !== 'string') return;
    const rows = await dbQuery<{ id: number | string; code: string; commission_usd_e2: number | string; status: string }>(
      `SELECT id, code, commission_usd_e2, status FROM referral_ledger WHERE invoice_id = ? AND status IN ('credited','usdc_pending')`,
      [invoiceId],
    );
    for (const row of rows) {
      const id = Number(row.id);
      const commission = Number(row.commission_usd_e2);
      if (row.status === 'credited') {
        const code = await resolveCode(row.code);
        const stripe = getStripeClient();
        if (code?.owner_key && stripe) {
          const cust = await getCustomerByApiKey(code.owner_key);
          if (cust) {
            try {
              await stripe.customers.createBalanceTransaction(cust.customerId, {
                amount: commission, // positive = debit, reverses the earlier credit
                currency: 'usd',
                description: `AlgoVault referral clawback — code ${row.code}, invoice ${invoiceId}`,
              });
            } catch (err) {
              console.error('[referral] clawback balance reversal failed:', err instanceof Error ? err.message : err);
            }
          }
        }
      }
      markLedger(id, 'clawed_back');
      console.log(`[referral] clawed back ${commission}c (code ${row.code}, invoice ${invoiceId}, was ${row.status})`);
    }
  } catch (err) {
    console.error('[referral] processChargeRefunded failed (fail-open):', err instanceof Error ? err.message : err);
  }
}

/**
 * Startup config (read → union → write → verify → rollback). Ensures the live
 * Stripe webhook endpoint is subscribed to invoice.paid + charge.refunded WITHOUT
 * dropping its existing events (Stripe's update REPLACES the whole array). `*` is a
 * no-op. Fail-open + a MANUAL_PENDING runbook log on any failure. Idempotent.
 */
export async function ensureReferralWebhookEvents(): Promise<void> {
  const stripe = getStripeClient();
  if (!stripe) return; // Stripe not configured — nothing to do
  try {
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    const ep = endpoints.data.find((e) => e.url === ENDPOINT_URL);
    if (!ep) return logRunbook('webhook endpoint not found by URL');
    const current = (ep.enabled_events ?? []) as string[];
    if (current.includes('*')) return; // wildcard covers everything
    const missing = REQUIRED_EVENTS.filter((e) => !current.includes(e));
    if (missing.length === 0) return; // already subscribed — no-op
    const union = Array.from(new Set([...current, ...REQUIRED_EVENTS]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime values are
    // valid Stripe event strings (existing ∪ {invoice.paid, charge.refunded}); the SDK
    // param type is a closed literal union we satisfy at runtime, like the `event: any`
    // shapes elsewhere in this codebase.
    const updated = await stripe.webhookEndpoints.update(ep.id, { enabled_events: union as any });
    const after = (updated.enabled_events ?? []) as string[];
    const ok = REQUIRED_EVENTS.every((e) => after.includes(e)) && current.every((e) => after.includes(e));
    if (!ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await stripe.webhookEndpoints.update(ep.id, { enabled_events: current as any }); // rollback
      return logRunbook('post-update verification failed — rolled back to the original events');
    }
    console.log(`[referral] webhook enabled_events updated: +${missing.join(', ')} (pre-existing retained)`);
  } catch (err) {
    logRunbook(err instanceof Error ? err.message : String(err));
  }
}

function logRunbook(reason: string): void {
  console.warn(`[referral] webhook events config incomplete (${reason}) — MANUAL_PENDING: see docs/SUBMIT_STRIPE_WEBHOOK_EVENTS.md`);
}
