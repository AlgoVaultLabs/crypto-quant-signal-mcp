/**
 * IDENTITY-LIFECYCLE-W3 CH1 — `sendLifecycle`, the ONE seam every lifecycle email passes through.
 *
 * Order of decisions, and none of them is reorderable:
 *   1. identity-bound?   an address we hold on an identity table, or nothing happens at all
 *   2. already handled?  a recorded outcome for this slot outranks every gate below it
 *   3. suppressed?       fail-closed; a DB error means "do not send"
 *   4. frequency-capped? <= 1/day and <= 3/7d per recipient; product_updates <= 1/calendar month
 *   5. claim the slot    UNIQUE(recipient, step, period) — the race-safety primitive
 *   6. shadow or live?   PER STEP (architect Q1(A)), never one wave-level flag
 *   7. canary batch      the first live tick of a step reaches <= 5 recipients
 *
 * 🛑 NOTHING HERE RUNS INSIDE A TOOL CALL OR A CHECKOUT. Eligibility is computed by the
 * every-15-minute dispatcher cron from the meters; a Resend outage, a full ledger or an unreachable
 * database can never touch quota, signup or a paying caller's request. §Build Rule 11.
 *
 * WHY MODE IS PER-STEP. `LIFECYCLE_MODE` remains the global master (`off` | `shadow` |
 * `live-permitted`) and is the real production default at `shadow` because it is absent from the
 * signal-1 `.env` entirely. But a step going live is decided by `lifecycle_step_state`, not by
 * that flag: MEASURED 2026-09-08, `activation_nudge` has 28 eligible recipients while
 * `quota_80`, `quota_wall` and `reset_return` have ZERO, so a wave-level flip would have lit
 * three steps that had never rendered once. See migrations/040_lifecycle.sql for the numbers.
 */
import { hashEmail } from './identity.js';
import { isSuppressed } from './suppression.js';
import {
  claimSlot, findSlot, markSent, markFailed, countDeliveredSince, countDeliveredStepSince,
  getStepState, stampFirstWouldSend, type SendStatus,
} from './ledger.js';
import { renderLifecycleEmail } from './render.js';
import { unsubscribeUrl as buildUnsubUrl } from './identity.js';
import { API_BASE, type LifecycleStep, type StepCopyContext } from '../lifecycle-copy.js';
import { sendLifecycleMessage } from '../email.js';

export type LifecycleMode = 'off' | 'shadow' | 'live-permitted';

/** Caps (§Build Rule 7). Constants, not magic numbers at a call site. */
export const CAP_PER_UTC_DAY = 1;
export const CAP_PER_7_DAYS = 3;
export const DIGEST_CAP_PER_MONTH = 1;
/** A step's first live tick reaches at most this many recipients (architect Q1(A)). */
export const CANARY_BATCH_SIZE = 5;
/** A step's own shadow clock must run this long before it may go live. */
export const SHADOW_CLOCK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The global master switch. UNSET ⇒ `shadow` — asserted by test, because that is the real
 * production default: `LIFECYCLE_MODE` is absent from all 97 vars in the signal-1 `.env`.
 */
export function resolveMode(env: NodeJS.ProcessEnv = process.env): LifecycleMode {
  const raw = (env.LIFECYCLE_MODE ?? '').trim().toLowerCase();
  if (raw === 'off') return 'off';
  if (raw === 'live-permitted' || raw === 'live') return 'live-permitted';
  return 'shadow';
}

export interface LifecycleRecipient {
  /** Opaque internal handle — a masked-key id or an opt-in row id. NEVER an address. */
  recipientId: string;
  email: string;
  /** True only when an identity table already holds this address. Gate 1. */
  identityBound: boolean;
}

export interface SendLifecycleResult {
  status: SendStatus | 'skipped';
  reason?: string;
  ledgerId?: number;
  subject?: string;
}

function utcDayStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}
function daysAgoIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
function monthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * The seam. Never throws — a lifecycle failure is logged and recorded, never propagated.
 *
 * `liveBudget` is the number of live sends this step may still make on this tick; the dispatcher
 * computes it from the canary rule and decrements it. In shadow it is ignored.
 */
export async function sendLifecycle(
  step: LifecycleStep,
  recipient: LifecycleRecipient,
  ctx: StepCopyContext & { periodKey: string },
  opts: { now?: Date; liveBudget?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<SendLifecycleResult> {
  const now = opts.now ?? new Date();
  const mode = resolveMode(opts.env);
  if (mode === 'off') return { status: 'skipped', reason: 'mode_off' };

  // ── 1. Identity-bound. §Build Rule 5 — "Zero new emails to anyone who never gave us an
  // address." This is the gate that makes that literally true, so it is first and absolute.
  if (!recipient.identityBound || !recipient.email) {
    return { status: 'skipped', reason: 'not_identity_bound' };
  }

  let emailHash: string;
  try {
    emailHash = hashEmail(recipient.email);
  } catch (err) {
    // An unusable hash key means we cannot check the suppression list. Refuse.
    console.error('[lifecycle] hashEmail failed — refusing:', err instanceof Error ? err.message : err);
    return { status: 'skipped', reason: 'hash_key_unusable' };
  }

  // ── 2. Idempotency FIRST. A slot with an outcome already recorded is finished, and no later
  // gate may overwrite that verdict. Ordering matters: evaluated after the caps, a re-run over
  // an already-sent slot matches its OWN earlier send in the daily window and reports `capped`.
  const existing = await findSlot(recipient.recipientId, step, ctx.periodKey);
  if (existing) {
    return { status: 'skipped', reason: 'already_handled', ledgerId: existing.id };
  }

  // ── 3. Suppression (fail-closed inside isSuppressed).
  if (await isSuppressed(emailHash, step)) {
    const { row } = await claimSlot({
      recipientId: recipient.recipientId, emailHash, recipientEmail: null,
      step, periodKey: ctx.periodKey, status: 'suppressed', now,
    });
    return { status: 'suppressed', ledgerId: row?.id };
  }

  // ── 4. Frequency caps.
  const capReason = await capReasonFor(step, emailHash, now);
  if (capReason) {
    const { row } = await claimSlot({
      recipientId: recipient.recipientId, emailHash, recipientEmail: null,
      step, periodKey: ctx.periodKey, status: 'capped', now,
    });
    return { status: 'capped', reason: capReason, ledgerId: row?.id };
  }

  // ── 5. Render. Done BEFORE the mode branch on purpose: shadow mode's whole value is that the
  // exact bytes are in the ledger for a human to read before anyone receives them.
  const unsubUrl = buildUnsubUrl(recipient.recipientId, API_BASE);
  let rendered;
  try {
    rendered = renderLifecycleEmail(step, ctx, unsubUrl);
  } catch (err) {
    console.error(`[lifecycle] render failed for ${step}:`, err instanceof Error ? err.message : err);
    return { status: 'skipped', reason: 'render_failed' };
  }

  // ── 6. Claim the slot. The read above is not the safety mechanism — this is: two ticks
  // overlapping both pass the read, and only ON CONFLICT decides which one owns the slot.
  const state = await getStepState(step);
  const stepIsLive = mode === 'live-permitted' && !!state.live_since;
  const initialStatus: SendStatus = stepIsLive ? 'failed' : 'would_send';
  const { row } = await claimSlot({
    recipientId: recipient.recipientId, emailHash,
    // Plaintext ONLY where an identity table already holds it — which `identityBound` asserts.
    recipientEmail: recipient.email,
    step, periodKey: ctx.periodKey,
    // In live mode the row starts as `failed` and is promoted on Resend's acceptance. Starting
    // it as `sent` and demoting on error would record a send that never happened if the process
    // died between the INSERT and the API call.
    status: initialStatus, now,
    subject: rendered.subject, html: rendered.html, text: rendered.text,
  });
  if (!row) return { status: 'skipped', reason: 'ledger_unavailable' };
  if (row.status !== initialStatus || Number(row.attempts) > 0) {
    return { status: 'skipped', reason: 'already_handled', ledgerId: row.id };
  }

  if (!stepIsLive) {
    // Start THIS step's own 7-day clock on its first would_send. Write-once.
    await stampFirstWouldSend(step, now.toISOString());
    return { status: 'would_send', ledgerId: row.id, subject: rendered.subject };
  }

  // ── 7. Live. Canary budget is enforced by the dispatcher; a budget of 0 here means the step
  // has already spent its canary allowance this tick.
  if (typeof opts.liveBudget === 'number' && opts.liveBudget <= 0) {
    await markFailed(row.id, 'canary_budget_exhausted_this_tick');
    return { status: 'failed', reason: 'canary_budget', ledgerId: row.id };
  }

  try {
    const resendId = await sendLifecycleMessage({
      to: recipient.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      unsubscribeUrl: unsubUrl,
      step,
      idempotencyKey: `${recipient.recipientId}|${step}|${ctx.periodKey}`,
    });
    await markSent(row.id, resendId);
    return { status: 'sent', ledgerId: row.id, subject: rendered.subject };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(row.id, msg);
    return { status: 'failed', reason: msg, ledgerId: row.id };
  }
}

/** Which cap, if any, refuses this send right now. Null ⇒ no cap applies. */
export async function capReasonFor(
  step: LifecycleStep, emailHash: string, now: Date,
): Promise<string | null> {
  if (step === 'product_updates') {
    // Calendar month, not a rolling 30 days — the opt-in checkbox promises "~1/mo", and the
    // digest batches every unsent README block into one message, so a calendar cadence is what
    // was actually consented to.
    const thisMonth = await countDeliveredStepSince(emailHash, step, monthStartIso(now));
    if (thisMonth >= DIGEST_CAP_PER_MONTH) return 'digest_monthly_cap';
  }
  const today = await countDeliveredSince(emailHash, utcDayStartIso(now));
  if (today >= CAP_PER_UTC_DAY) return 'daily_cap';
  const week = await countDeliveredSince(emailHash, daysAgoIso(now, 7));
  if (week >= CAP_PER_7_DAYS) return 'weekly_cap';
  return null;
}

/**
 * May this step go live now? Returns the reason it may NOT, or null when every condition holds.
 *
 * Deliberately a pure-ish predicate the CH2 readout calls — the flip itself is that cron's act,
 * never a human's and never this module's.
 */
export async function stepGoLiveBlocker(
  step: LifecycleStep,
  facts: { duplicates: number; wouldSendCount: number; healthPass: boolean; unsubSelfTestPass: boolean },
  now: Date = new Date(),
): Promise<string | null> {
  const state = await getStepState(step);
  if (state.live_since) return null;
  if (state.rolled_back_at) return 'rolled_back';
  if (facts.wouldSendCount < 1) return 'no_would_send';
  if (!state.first_would_send_at) return 'clock_not_started';
  const started = Date.parse(state.first_would_send_at.replace(' ', 'T'));
  if (!Number.isFinite(started)) return 'clock_unparseable';
  if (now.getTime() - started < SHADOW_CLOCK_MS) return 'shadow_clock_not_elapsed';
  if (facts.duplicates !== 0) return 'duplicates_present';
  if (!facts.healthPass) return 'health_not_pass';
  if (!facts.unsubSelfTestPass) return 'unsub_selftest_not_pass';
  return null;
}
