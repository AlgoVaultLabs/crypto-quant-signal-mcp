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
  claimSlot, findSlot, markFailed, countDeliveredSince, countDeliveredStepSince,
  getStepState, stampFirstWouldSend, parseDbTimestamp, isShadowClaim, consumeClaim, closeClaim,
  recordSent, type SendStatus, type LedgerRow, type StepState,
} from './ledger.js';
import { renderLifecycleEmail, scanOutboundCredentials } from './render.js';
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

/**
 * THE one predicate behind "live" (LIFECYCLE-GOLIVE-SEMANTICS-W1 R3).
 *
 * A step is live only when the global master permits AND the step's own evidence stamp exists —
 * "per-step live requires both" (W3 rev-2 ruling). MEASURED 2026-09-28: six call sites derived
 * "live" from `live_since` alone, so for 12 days the deciding cron printed `LIVE lit=1`, the
 * dispatcher heartbeat said `live_steps=1`, and the dashboard said `live` while the send path —
 * the only one that read the master — sent nothing. Every consumer now projects from this.
 *
 *   live            master `live-permitted` AND `live_since` set — the send path mails
 *   blocked-master  `live_since` set, master NOT `live-permitted` — evidence passed, nothing sends
 *   rolled-back     a breach returned the step to shadow; a human clears it
 *   shadow          no stamp yet
 */
export type StepLiveState = 'live' | 'blocked-master' | 'shadow' | 'rolled-back';

export function stepLiveState(
  mode: LifecycleMode, state: { live_since: unknown; rolled_back_at: unknown },
): StepLiveState {
  if (state.live_since) return mode === 'live-permitted' ? 'live' : 'blocked-master';
  if (state.rolled_back_at) return 'rolled-back';
  return 'shadow';
}

export function isStepLive(mode: LifecycleMode, state: { live_since: unknown; rolled_back_at: unknown }): boolean {
  return stepLiveState(mode, state) === 'live';
}

/** The auto-rollback guard's length, from the step's FIRST REAL SEND (R1). */
export const ROLLBACK_WINDOW_H = 72;

export type RollbackWindow =
  | { status: 'not_opened' }
  | { status: 'armed' | 'closed'; opensAt: string; closesAt: string; hoursOpen: number };

/**
 * The rollback window, keyed on `first_sent_at` — never on `live_since`.
 *
 * A window that opens at the go-live STAMP can expire before anything is sent: measured on
 * `activation_nudge`, stamped 2026-09-16, master blocked, window "72 h" already 291 h old on
 * 2026-09-28 — its debut would have run with no auto-rollback. Before the first send the window is
 * `not_opened`; it is never read as expired.
 */
export function rollbackWindow(state: { first_sent_at: unknown }, now: Date): RollbackWindow {
  const opened = parseDbTimestamp(state.first_sent_at);
  if (!Number.isFinite(opened)) return { status: 'not_opened' };
  const closes = opened + ROLLBACK_WINDOW_H * 3600_000;
  return {
    status: now.getTime() <= closes ? 'armed' : 'closed',
    opensAt: new Date(opened).toISOString(),
    closesAt: new Date(closes).toISOString(),
    hoursOpen: Math.floor((now.getTime() - opened) / 3600_000),
  };
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

  // The step's liveness, ONCE, from the one predicate. Gate 2 needs it: a shadow claim is only
  // consumable while its step is live.
  const state = await getStepState(step);
  const live = isStepLive(mode, state);

  // ── 2. Idempotency FIRST. A slot with an outcome already recorded is finished, and no later
  // gate may overwrite that verdict. Ordering matters: evaluated after the caps, a re-run over
  // an already-sent slot matches its OWN earlier send in the daily window and reports `capped`.
  //
  // A `would_send` row is the one exception (R2): it is a SHADOW CLAIM, and once the step is live
  // the claim is CONSUMED — the same row carries the real send, so there is still exactly one
  // message per (recipient, step, period). In shadow the claim stays final.
  const existing = await findSlot(recipient.recipientId, step, ctx.periodKey);
  let claim: LedgerRow | null = null;
  if (existing) {
    if (!(live && isShadowClaim(existing))) {
      return { status: 'skipped', reason: 'already_handled', ledgerId: existing.id };
    }
    claim = existing;
  }

  // ── 3. Suppression (fail-closed inside isSuppressed).
  if (await isSuppressed(emailHash, step)) {
    if (claim) {
      await closeClaim(claim.id, 'suppressed');
      return { status: 'suppressed', ledgerId: claim.id };
    }
    const { row } = await claimSlot({
      recipientId: recipient.recipientId, emailHash, recipientEmail: null,
      step, periodKey: ctx.periodKey, status: 'suppressed', now,
    });
    return { status: 'suppressed', ledgerId: row?.id };
  }

  // ── 4. Frequency caps. A consumed claim is excluded from its own count — it IS this message.
  const capReason = await capReasonFor(step, emailHash, now, claim?.id);
  if (capReason) {
    if (claim) {
      await closeClaim(claim.id, 'capped');
      return { status: 'capped', reason: capReason, ledgerId: claim.id };
    }
    const { row } = await claimSlot({
      recipientId: recipient.recipientId, emailHash, recipientEmail: null,
      step, periodKey: ctx.periodKey, status: 'capped', now,
    });
    return { status: 'capped', reason: capReason, ledgerId: row?.id };
  }

  // ── 4b. Canary budget — BEFORE any write. An over-budget candidate leaves NO trace: a claim
  // stays `would_send`, a new candidate stays unclaimed, and both are simply eligible next tick.
  // MEASURED defect this replaces: over-budget candidates used to be claimed as `failed`
  // ("canary_budget_exhausted_this_tick", attempts 1), and the SAME tick's retry drain then resent
  // every one of them — 7 eligible on a first live tick sent 7, not the approved <= 5.
  if (live && typeof opts.liveBudget === 'number' && opts.liveBudget <= 0) {
    return { status: 'skipped', reason: 'canary_budget' };
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

  // ── 5b. OUTBOUND CREDENTIAL GUARD (ruling Q7). Runs BEFORE the ledger claim, so a body
  // carrying a paid secret is never even stored at rest — shadow mode persists the rendered
  // bytes, so a guard placed after the claim would still have written the thing it refuses.
  const scan = scanOutboundCredentials(rendered.subject, rendered.text, rendered.html);
  if (!scan.ok) {
    console.error(
      `[lifecycle] REFUSED ${step} for ${recipient.recipientId}: rendered body carries a ` +
      `non-free credential (${scan.offending.join(', ')}). Build Rule 9 as amended permits a ` +
      `free-tier key in the activation snippet and nothing else.`);
    return { status: 'skipped', reason: 'non_free_credential_in_body' };
  }

  // ── 6. Claim the slot. The read above is not the safety mechanism — this is: two ticks
  // overlapping both pass the read, and only ON CONFLICT (a fresh slot) or the compare-and-set
  // (a consumed claim) decides which one owns it.
  let row: LedgerRow | null;
  if (claim) {
    row = await consumeClaim(claim.id, {
      emailHash, recipientEmail: recipient.email,
      subject: rendered.subject, html: rendered.html, text: rendered.text,
    });
    if (!row) return { status: 'skipped', reason: 'already_handled', ledgerId: claim.id };
  } else {
    const initialStatus: SendStatus = live ? 'failed' : 'would_send';
    const claimed = await claimSlot({
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
    row = claimed.row;
    if (!row) return { status: 'skipped', reason: 'ledger_unavailable' };
    if (row.status !== initialStatus || Number(row.attempts) > 0) {
      return { status: 'skipped', reason: 'already_handled', ledgerId: row.id };
    }
    if (!live) {
      // Start THIS step's own 7-day clock on its first would_send. Write-once.
      await stampFirstWouldSend(step, now.toISOString());
      return { status: 'would_send', ledgerId: row.id, subject: rendered.subject };
    }
  }

  // ── 7. Live. The canary budget was enforced at 4b, before anything was written.
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
    // Records the send AND opens the step's rollback window on its first real send (R1).
    await recordSent(row.id, step, resendId, now.toISOString());
    return { status: 'sent', ledgerId: row.id, subject: rendered.subject };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(row.id, msg);
    return { status: 'failed', reason: msg, ledgerId: row.id };
  }
}

/** Which cap, if any, refuses this send right now. Null ⇒ no cap applies. */
export async function capReasonFor(
  step: LifecycleStep, emailHash: string, now: Date, excludeId?: number,
): Promise<string | null> {
  if (step === 'product_updates') {
    // Calendar month, not a rolling 30 days — the opt-in checkbox promises "~1/mo", and the
    // digest batches every unsent README block into one message, so a calendar cadence is what
    // was actually consented to.
    const thisMonth = await countDeliveredStepSince(emailHash, step, monthStartIso(now), excludeId);
    if (thisMonth >= DIGEST_CAP_PER_MONTH) return 'digest_monthly_cap';
  }
  const today = await countDeliveredSince(emailHash, utcDayStartIso(now), excludeId);
  if (today >= CAP_PER_UTC_DAY) return 'daily_cap';
  const week = await countDeliveredSince(emailHash, daysAgoIso(now, 7), excludeId);
  if (week >= CAP_PER_7_DAYS) return 'weekly_cap';
  return null;
}

/** The master leg's refusal. FIRST in `stepGoLiveBlocker`, so a held step can never read "go". */
export const MASTER_BLOCKER = 'master_not_live_permitted';

/**
 * The facts the deciding cron measures before deciding. `null` = NOT MEASURED in this run (the
 * read-only `--report` twin measures neither), which is reported as such — never as a pass.
 */
export interface GoLiveFacts {
  duplicates: number;
  wouldSendCount: number;
  healthPass: boolean | null;
  unsubSelfTestPass: boolean | null;
}

export interface GoLiveLegs {
  /** The global master permits live sends. */
  master: boolean;
  /** The first failing EVIDENCE leg, or null when every one passes (always null once stamped). */
  evidence: string | null;
  state: StepState;
}

function evidenceBlocker(state: StepState, facts: GoLiveFacts, now: Date): string | null {
  if (state.live_since) return null;
  if (state.rolled_back_at) return 'rolled_back';
  if (facts.wouldSendCount < 1) return 'no_would_send';
  if (!state.first_would_send_at) return 'clock_not_started';
  const started = parseDbTimestamp(state.first_would_send_at);
  if (!Number.isFinite(started)) return 'clock_unparseable';
  if (now.getTime() - started < SHADOW_CLOCK_MS) return 'shadow_clock_not_elapsed';
  if (facts.duplicates !== 0) return 'duplicates_present';
  if (facts.healthPass === null) return 'health_unmeasured';
  if (!facts.healthPass) return 'health_not_pass';
  if (facts.unsubSelfTestPass === null) return 'unsub_unmeasured';
  if (!facts.unsubSelfTestPass) return 'unsub_selftest_not_pass';
  return null;
}

/**
 * Every go-live leg, evaluated — the master AND the evidence — so a report can say "evidence
 * passed, master blocks" rather than stopping at the first refusal. ONE derivation feeds both the
 * cron's decision (`stepGoLiveBlocker`) and its published verdict.
 */
export async function stepGoLiveLegs(
  step: LifecycleStep, facts: GoLiveFacts, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env,
): Promise<GoLiveLegs> {
  const state = await getStepState(step);
  return { master: resolveMode(env) === 'live-permitted', evidence: evidenceBlocker(state, facts, now), state };
}

/**
 * May this step go live now? Returns the reason it may NOT, or null when every condition holds.
 *
 * THE MASTER IS THE FIRST LEG (R3). Before this wave the function returned null for any stamped
 * step without reading the master, and the cron printed `LIVE` for a step that could not send.
 * The cron may still record evidence while the master blocks; it can never report `LIVE`.
 */
export async function stepGoLiveBlocker(
  step: LifecycleStep, facts: GoLiveFacts, now: Date = new Date(), env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const legs = await stepGoLiveLegs(step, facts, now, env);
  if (!legs.master) return MASTER_BLOCKER;
  return legs.evidence;
}
