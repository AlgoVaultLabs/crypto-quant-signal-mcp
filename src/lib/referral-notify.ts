/**
 * REFERRAL-PARITY-NOTIFS-W1 / C1 — the reusable referrer-notification primitive.
 *
 * `notifyReferrer` queues a notification on every channel the referrer is reachable
 * on (email if an email is on file; tg if the code is a `tg:` identity), honoring the
 * default-ON `notify_opt_out` preference, then drains the email channel inline. The tg
 * channel is drained by the BOT (it owns chat_ids; the engine only has `tg:<hash>`).
 * Idempotent on `source_id` (attr:<id> | led:<id>) → webhook/replay safe.
 *
 * Allow-list discipline: payloads carry ONLY the referrer's own commission $/counts —
 * never trading-outcome data, never the friend's identity. Fail-soft: a notification
 * failure NEVER propagates into the accrual/attribution caller.
 */
import { createHmac } from 'node:crypto';
import {
  resolveCode,
  getNotifyOptOut,
  queueNotification,
  listPendingNotifications,
  markNotificationDelivered,
  type NotifyEvent,
} from './referral-store.js';
import { sendReferralFriendJoined, sendReferralEarned } from './email.js';
import { REFERRAL_TERMS } from './referral-constants.js';

// SoT display numbers embedded in every notification payload so the BOT renders with
// ZERO literal numbers (grep-gated) + no second fetch. Sourced from REFERRAL_TERMS here.
function sotTerms(): { commission_pct: number; commission_months: number; usdc_min_payout_usd: number } {
  return {
    commission_pct: Math.round(REFERRAL_TERMS.COMMISSION_RATE * 100),
    commission_months: REFERRAL_TERMS.COMMISSION_MONTHS,
    usdc_min_payout_usd: REFERRAL_TERMS.USDC_MIN_PAYOUT_USD,
  };
}

const ACCOUNT_BASE = 'https://api.algovault.com';
// Low-stakes one-click email-unsubscribe signature. Worst-case forgery only flips a
// referrer's own notify preference (reversible via /notifications) AND requires knowing
// their semi-private code — so a fixed salt is adequate. NOT an auth secret.
const NOTIFY_UNSUB_SALT = 'algovault-referral-notify-unsub-v1';

export function notifyUnsubSig(code: string): string {
  return createHmac('sha256', NOTIFY_UNSUB_SALT).update(code).digest('base64url').slice(0, 16);
}
export function notifyUnsubLink(code: string): string {
  return `${ACCOUNT_BASE}/referral/notify/unsubscribe?c=${encodeURIComponent(code)}&t=${notifyUnsubSig(code)}`;
}

export interface CommissionEarnedPayload {
  amount_usd_e2: number;
  pending_usd_e2: number;
}

/**
 * Queue a referrer notification on each reachable channel (respecting opt-out), then
 * drain pending email rows inline. Never throws — accrual/attribution must not be
 * blocked by a notification failure.
 */
export async function notifyReferrer(params: {
  code: string;
  event: NotifyEvent;
  sourceId: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    const row = await resolveCode(params.code);
    if (!row) return;
    if (await getNotifyOptOut(params.code)) return; // default-ON; suppressed only on explicit opt-out
    const payloadJson = params.payload ? JSON.stringify(params.payload) : null;
    const hasEmail = !!row.owner_email;
    const isTg = typeof row.owner_key === 'string' && row.owner_key.startsWith('tg:');
    if (hasEmail) {
      await queueNotification({ referrer_code: params.code, event: params.event, channel: 'email', payload_json: payloadJson, source_id: params.sourceId });
    }
    if (isTg) {
      await queueNotification({ referrer_code: params.code, event: params.event, channel: 'tg', payload_json: payloadJson, source_id: params.sourceId });
    }
    if (hasEmail) await drainEmailNotifications();
  } catch (err) {
    console.error('[referral-notify] notifyReferrer failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

/** friend_joined trigger (one shared sink for the 3 attribution paths). Dedup on attribution id. */
export async function notifyFriendJoined(code: string, attributionId: number): Promise<void> {
  await notifyReferrer({ code, event: 'friend_joined', sourceId: `attr:${attributionId}`, payload: { ...sotTerms() } });
}

/** commission_earned trigger (from processInvoicePaid, on a NEW ledger row). Dedup on ledger id. */
export async function notifyCommissionEarned(code: string, ledgerId: number, payload: CommissionEarnedPayload): Promise<void> {
  await notifyReferrer({
    code,
    event: 'commission_earned',
    sourceId: `led:${ledgerId}`,
    payload: { amount_usd_e2: payload.amount_usd_e2, pending_usd_e2: payload.pending_usd_e2, ...sotTerms() },
  });
}

/** Send pending email-channel notifications, then mark delivered. Fail-soft per row. */
export async function drainEmailNotifications(limit = 50): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const rows = await listPendingNotifications('email', limit);
  for (const r of rows) {
    const codeRow = await resolveCode(r.referrer_code);
    const to = codeRow?.owner_email;
    if (!to) continue; // no address on an email row (shouldn't happen) — leave pending
    const manageLink = notifyUnsubLink(r.referrer_code);
    try {
      if (r.event === 'friend_joined') {
        await sendReferralFriendJoined(to, manageLink);
      } else {
        const p = r.payload_json ? (JSON.parse(r.payload_json) as CommissionEarnedPayload) : { amount_usd_e2: 0, pending_usd_e2: 0 };
        await sendReferralEarned(to, manageLink, p);
      }
      // A send returning null = Resend not configured (dev/test) — still mark delivered
      // (no retry storm). A real transport failure throws → row stays pending for retry.
      markNotificationDelivered(r.id);
      sent++;
    } catch (err) {
      failed++;
      console.error(`[referral-notify] email drain failed for notif ${r.id} (left pending):`, err instanceof Error ? err.message : err);
    }
  }
  return { sent, failed };
}
