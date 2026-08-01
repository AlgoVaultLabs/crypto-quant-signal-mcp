/**
 * OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 CH4 — the subscriber-notification channel.
 *
 * THE GENERATOR FIX. D1 (a paying customer's webhook died permanently and nobody
 * told them) and D4 (deliveries paused silently on quota exhaustion) are not two
 * bugs — they are one absence: *there was no channel by which a subscriber learns
 * that a resource they own changed state.* This module is that channel. Adding a
 * future case (referral-payout failure, Stripe dunning, free-key quota exhaustion,
 * scan_digest cadence pause) is ONE registry row plus one template — not a new
 * integration.
 *
 * DESIGN INVARIANTS
 *
 *  1. NOTHING HERE MAY THROW INTO A CALLER. Every path returns a NotifyResult.
 *     `notifySubscriber` is called fire-and-forget from the delivery worker and the
 *     health-probe sweep; a notification failure must never change a DeliveryResult
 *     or abort a sweep. Pinned by a forced-throw test.
 *  2. ONE resolver. Owner→email goes through `getCustomerByApiKey` (widened in this
 *     wave to return the email it already fetched), with the `subscriber_profiles`
 *     cache as the degradation path. There is no second implementation.
 *  3. IDEMPOTENCY BEFORE SEND. `tryClaimNotification` mirrors `tryClaimEvent`: the
 *     claim is durable before an email goes out, so a retried tick cannot mail twice.
 *  4. A SILENT EVENT IS A ROW, NOT AN OMISSION. `webhook_resumed` has
 *     `sendsEmail: false` because recovery alerts are noise (CLAUDE.md) — but it is
 *     REGISTERED, so the next reader sees a decision rather than a gap.
 *  5. `owner_unreachable` for a `free:<ipHash>` owner NEVER pages. No email exists
 *     and none can; a by-design skip has no meaningful threshold.
 */

import { dbQuery } from './performance-db.js';
import { getCustomerByApiKey } from './stripe.js';
import {
  sendWebhookQuarantinedEmail,
  sendWebhookDisabledEmail,
  sendWebhookQuotaPausedEmail,
  maskEmail,
} from './email.js';

export type SubscriberNotifyEvent =
  | 'webhook_quarantined'   // day-1 warning; endpoint failing, we are retrying
  | 'webhook_disabled'      // terminal; re-registration required
  | 'webhook_quota_paused'  // D4 — deliveries paused on owner quota; upgrade CTA
  | 'webhook_resumed';      // SILENT by policy — the row records the decision

export type NotifyOutcome =
  | 'sent'
  | 'suppressed_silent'      // registry says this event sends no email, by design
  | 'suppressed_duplicate'   // idempotency claim already held
  | 'owner_unreachable'      // free: owner, or no email on the customer — never pages
  | 'resolution_failed'      // Stripe/DB lookup failed — THIS one escalates
  | 'send_failed'            // Resend rejected/threw — escalates
  | 'disabled'               // kill switch off
  | 'dry_run';               // rendered + logged, nothing sent, NO row written

export interface NotifySpec {
  event: SubscriberNotifyEvent;
  sendsEmail: boolean;
  cooldownSec: number;
  template: string;
}

/**
 * Exhaustive `Record` — tsc makes "forgot to add the new one" a compile error, so a
 * new SubscriberNotifyEvent cannot ship without an explicit send/silent decision.
 */
export const NOTIFY_REGISTRY: Record<SubscriberNotifyEvent, NotifySpec> = {
  webhook_quarantined: {
    event: 'webhook_quarantined',
    sendsEmail: true,
    cooldownSec: 24 * 3600,
    template: 'sendWebhookQuarantinedEmail',
  },
  webhook_disabled: {
    event: 'webhook_disabled',
    sendsEmail: true,
    cooldownSec: 0, // terminal + idempotency-keyed; a cooldown would risk swallowing it
    template: 'sendWebhookDisabledEmail',
  },
  webhook_quota_paused: {
    event: 'webhook_quota_paused',
    // One per owner per BILLING MONTH. The drain tick hits this branch on every
    // delivery attempt while exhausted, so a per-delivery notice would mail hundreds
    // of times. The month bucket in the idempotency key is what enforces it.
    sendsEmail: true,
    cooldownSec: 0,
    template: 'sendWebhookQuotaPausedEmail',
  },
  webhook_resumed: {
    event: 'webhook_resumed',
    sendsEmail: false, // recovery alerts are noise — CLAUDE.md. A decision, not a gap.
    cooldownSec: 0,
    template: '',
  },
};

export interface NotifyResult {
  sent: boolean;
  outcome: NotifyOutcome;
  reason?: string;
  resendId?: string | null;
}

export interface NotifyContext {
  subscriptionId?: number | null;
  /** Stable per-occurrence discriminator (e.g. quarantined_at, or a month bucket). */
  stateEpochBucket?: number | null;
  expiresAt?: number | null;
  lastSuccessAt?: number | null;
  retriedForSec?: number | null;
  quotaUsed?: number | null;
  quotaTotal?: number | null;
}

export interface NotifyArgs {
  ownerKey: string;
  event: SubscriberNotifyEvent;
  context?: NotifyContext;
}

/** Two-flag firewall (R4.7). Default ON under WEBHOOK_DELIVERY_ENABLED. */
export function isSubscriberNotifyEnabled(): boolean {
  const raw = process.env.WEBHOOK_SUBSCRIBER_NOTIFY_ENABLED;
  if (raw === undefined) return true; // default-on; the outer WEBHOOK_DELIVERY_ENABLED gates reachability
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

/**
 * First-fire gate. Renders + resolves + logs but does NOT POST and writes NO row —
 * deliberately unlike DRY_RUN_TG, whose marker write makes a second dry run
 * cooldown-suppressed rather than healthy (CLAUDE.md). Repeated dry runs here
 * cannot false-green.
 */
export function isSubscriberNotifyDryRun(): boolean {
  const raw = process.env.SUBSCRIBER_NOTIFY_DRY_RUN;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** A `free:<ipHash>` owner structurally has no email and never can. */
export function isStructurallyUnreachable(ownerKey: string): boolean {
  return ownerKey.startsWith('free:');
}

export function notificationKey(
  event: SubscriberNotifyEvent,
  ownerKey: string,
  subscriptionId: number | null | undefined,
  stateEpochBucket: number | null | undefined,
): string {
  return `${event}:${ownerKey}:${subscriptionId ?? 0}:${stateEpochBucket ?? 0}`;
}

/**
 * Log-safe rendering of a notification key. The key EMBEDS the owner key, which for a
 * paid subscriber IS their live `av_live_…` API key — logging it verbatim would put a
 * working credential in the container logs. Caught by the fail-closed
 * `check-secret-log-redaction` gate on first deploy; never log a raw key.
 */
export function redactNotificationKey(key: string): string {
  const parts = key.split(':');
  // A malformed key must NOT be echoed even in part — `parts[0]` of a bare
  // `av_live_…` string IS the credential. Emit an opaque marker instead.
  if (parts.length < 4) return '<malformed-key-redacted>';
  // Only the first segment is a known-safe literal (the event name); everything
  // between it and the trailing (subId, bucket) is owner-derived.
  const event = NOTIFY_REGISTRY[parts[0] as SubscriberNotifyEvent] ? parts[0] : '<event-redacted>';
  return `${event}:<owner-redacted>:${parts[parts.length - 2]}:${parts[parts.length - 1]}`;
}

/**
 * Durable claim BEFORE the send (mirrors stripe-events-store.tryClaimEvent).
 * `ON CONFLICT DO NOTHING RETURNING` gives exactly one row to the winner and zero to
 * every duplicate, on BOTH backends. Returns false when the claim is already held.
 */
export async function tryClaimNotification(params: {
  key: string;
  ownerKey: string;
  event: SubscriberNotifyEvent;
  subscriptionId: number | null;
  outcome: NotifyOutcome;
}): Promise<boolean> {
  const rows = await dbQuery<{ notification_key: string }>(
    `INSERT INTO subscriber_notifications (notification_key, owner_key, event, subscription_id, sent_at, resend_id, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (notification_key) DO NOTHING
     RETURNING notification_key`,
    [params.key, params.ownerKey, params.event, params.subscriptionId, Math.floor(Date.now() / 1000), null, params.outcome],
  );
  return rows.length > 0;
}

async function finalizeOutcome(key: string, outcome: NotifyOutcome, resendId: string | null): Promise<void> {
  try {
    await dbQuery(
      `UPDATE subscriber_notifications SET outcome = ?, resend_id = ? WHERE notification_key = ?`,
      [outcome, resendId, key],
    );
  } catch (err) {
    // Never propagate: the email already went out; a bookkeeping miss must not
    // surface as a delivery failure. Logged so Detect still sees it.
    console.error('[subscriber-notify] outcome write failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Owner→email. ONE resolver (R4.2). Returns:
 *   { email }                       — resolved
 *   { unreachable: true }           — no email exists / none can (never pages)
 *   { failed: true }                — lookup errored (escalates if it persists)
 */
export async function resolveOwnerEmail(
  ownerKey: string,
): Promise<{ email?: string; unreachable?: boolean; failed?: boolean }> {
  if (isStructurallyUnreachable(ownerKey)) return { unreachable: true };
  try {
    const customer = await getCustomerByApiKey(ownerKey);
    if (customer?.email) return { email: customer.email };
    // Degradation path: Stripe unconfigured / no active sub / no email on the
    // customer → the local subscriber_profiles cache, keyed by the customer id we
    // just learned. Same shape stripe.ts already documents for the tier census.
    if (customer?.customerId) {
      const rows = await dbQuery<{ email: string | null }>(
        `SELECT email FROM subscriber_profiles WHERE customer_id = ? LIMIT 1`,
        [customer.customerId],
      );
      const cached = rows[0]?.email;
      if (cached) return { email: cached };
    }
    // A resolvable-but-emailless owner is unreachable, not a failure: retrying
    // cannot help, and paging on it would be noise.
    return { unreachable: true };
  } catch (err) {
    console.error('[subscriber-notify] owner email resolution failed:', err instanceof Error ? err.message : err);
    return { failed: true };
  }
}

async function dispatchTemplate(
  event: SubscriberNotifyEvent,
  to: string,
  ctx: NotifyContext,
): Promise<{ id: string } | null> {
  switch (event) {
    case 'webhook_quarantined':
      return sendWebhookQuarantinedEmail({
        to,
        subscriptionId: ctx.subscriptionId ?? 0,
        expiresAt: ctx.expiresAt ?? 0,
        lastSuccessAt: ctx.lastSuccessAt ?? null,
      });
    case 'webhook_disabled':
      return sendWebhookDisabledEmail({
        to,
        subscriptionId: ctx.subscriptionId ?? 0,
        retriedForSec: ctx.retriedForSec ?? 0,
      });
    case 'webhook_quota_paused':
      return sendWebhookQuotaPausedEmail({
        to,
        subscriptionId: ctx.subscriptionId ?? 0,
        used: ctx.quotaUsed ?? 0,
        total: ctx.quotaTotal ?? 0,
      });
    case 'webhook_resumed':
      return null; // unreachable: sendsEmail === false is checked before dispatch
  }
}

/**
 * The ONE entry point. Never throws — every failure mode is an outcome.
 * Callers invoke it fire-and-forget and ignore the result.
 */
export async function notifySubscriber(args: NotifyArgs): Promise<NotifyResult> {
  const { ownerKey, event } = args;
  const ctx = args.context ?? {};
  try {
    if (!isSubscriberNotifyEnabled()) {
      return { sent: false, outcome: 'disabled', reason: 'WEBHOOK_SUBSCRIBER_NOTIFY_ENABLED=0' };
    }

    const spec = NOTIFY_REGISTRY[event];
    if (!spec) return { sent: false, outcome: 'disabled', reason: `unregistered event ${event}` };
    if (!spec.sendsEmail) {
      // Registered-and-silent. Deliberate, so it is not an omission.
      console.log(`[subscriber-notify] ${event} is silent by policy (no email)`);
      return { sent: false, outcome: 'suppressed_silent' };
    }

    const resolved = await resolveOwnerEmail(ownerKey);
    if (resolved.unreachable) {
      // By design for a free: owner. NEVER pages — a by-design skip has no threshold.
      console.log(`[subscriber-notify] owner unreachable (${isStructurallyUnreachable(ownerKey) ? 'free-tier' : 'no email on file'}) for ${event}`);
      return { sent: false, outcome: 'owner_unreachable' };
    }
    if (resolved.failed || !resolved.email) {
      console.error(`[subscriber-notify] resolution_failed for ${event} — escalation counter incremented`);
      return { sent: false, outcome: 'resolution_failed' };
    }
    const to = resolved.email;

    const key = notificationKey(event, ownerKey, ctx.subscriptionId ?? null, ctx.stateEpochBucket ?? null);

    if (isSubscriberNotifyDryRun()) {
      // Render for real so the gate proves the body, then stop. NO row is written,
      // so repeated dry runs cannot false-green via a cooldown marker.
      console.log(`[subscriber-notify] DRY_RUN ${event} → ${maskEmail(to)} ${redactNotificationKey(key)} ctx=${JSON.stringify(ctx)}`);
      return { sent: false, outcome: 'dry_run', reason: `would send ${event} to ${maskEmail(to)}` };
    }

    const claimed = await tryClaimNotification({
      key,
      ownerKey,
      event,
      subscriptionId: ctx.subscriptionId ?? null,
      outcome: 'sent',
    });
    if (!claimed) {
      console.log(`[subscriber-notify] duplicate suppressed ${redactNotificationKey(key)}`);
      return { sent: false, outcome: 'suppressed_duplicate' };
    }

    let resendId: string | null = null;
    try {
      const sent = await dispatchTemplate(event, to, ctx);
      resendId = sent?.id ?? null;
    } catch (err) {
      console.error(`[subscriber-notify] send_failed ${event}:`, err instanceof Error ? err.message : err);
      await finalizeOutcome(key, 'send_failed', null);
      return { sent: false, outcome: 'send_failed' };
    }

    if (!resendId) {
      // Resend unconfigured (getResendClient() → null) or no id returned.
      await finalizeOutcome(key, 'send_failed', null);
      console.error(`[subscriber-notify] send_failed ${event} — no provider id returned`);
      return { sent: false, outcome: 'send_failed' };
    }

    await finalizeOutcome(key, 'sent', resendId);
    console.log(`[subscriber-notify] sent ${event} to ${maskEmail(to)} resend_id=${resendId}`);
    return { sent: true, outcome: 'sent', resendId };
  } catch (err) {
    // Belt and braces: this function is awaited inside .catch()-guarded call sites,
    // but it must be safe even if a caller forgets. NEVER rethrow.
    console.error('[subscriber-notify] unexpected error (swallowed):', err instanceof Error ? err.message : err);
    return { sent: false, outcome: 'resolution_failed', reason: 'unexpected' };
  }
}

/** Fire-and-forget wrapper for call sites that must never await or throw. */
export function notifySubscriberDetached(args: NotifyArgs): void {
  void notifySubscriber(args).catch((err) => {
    console.error('[subscriber-notify] detached failure (swallowed):', err instanceof Error ? err.message : err);
  });
}
