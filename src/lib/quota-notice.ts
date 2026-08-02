/**
 * quota-notice.ts — the ONE free-tier exhaustion notice (OPS-QUOTA-EXHAUSTION-NOTICE-W1, 2026-08-02).
 *
 * The wall is the highest-intent moment the product has, and the caller who hits it is often
 * unreachable: an agent with no account and no email, identified only by an `ip_hash`. The
 * response body IS the entire customer relationship at that instant. Before this wave each
 * surface invented its own — four different shapes, two different `code` casings, no reset
 * DATE anywhere, and a `suggested_action` that advertised the x402 rail even when no rail was
 * live. This module is the generator-level fix: ONE contract, so a NEW free-tier surface
 * inherits the notice instead of writing a fifth failure message.
 *
 * What the notice must always carry (R2):
 *   1. what happened  — the meter and the usage, `N/limit`;
 *   2. when it returns — a reset DATE, computed live from the meter's own reset instant;
 *   3. what to do     — both paths, RANKED by the caller's measured volume, each a live link;
 *   4. a stable `code` plus the `suggested_<action>` field the structured-error law requires.
 *
 * What it must NEVER carry: a teaser, a partial result, or any hint that an actionable verdict
 * existed (operator-FROZEN — at exhaustion all calls stop, trade calls and HOLDs alike), and no
 * internal metric (`outcome_return_pct` / outcome WR). It is an allow-list, not a deny-list.
 *
 * TWO METERS, TWO RESET SEMANTICS — this is the trap the module exists to absorb:
 *   - `calls` (100/mo) is a ROLLING 30-day window anchored on the caller's first call
 *     (`license.ts` `periodStart + MONTH_MS`), so its reset lands on an arbitrary date;
 *   - `chat`  (10/mo)  resets at the START OF THE NEXT UTC CALENDAR MONTH.
 * Both callers pass an explicit `resetAtMs`; nothing here assumes "today + 30".
 *
 * LEAF-SAFE: imports only pure modules (`plans`, `nudge-copy`, `referral-constants`) and
 * type-only `SuggestedX402`. It must NEVER import `license.ts` — `license.ts` imports
 * `nudge-copy.ts` and consumes this module, so an import here would close a cycle.
 */
import { PLANS, DEFAULT_UPGRADE_PLAN, planCallsLabel, subscriptionBreakEvenCalls } from './plans.js';
import { nudgeSignupUrl, referralSignupUrl } from './nudge-copy.js';
import { shareLink, bonusCallsLabel } from './referral-constants.js';
import type { SuggestedX402 } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which meter the caller exhausted. They are independent — exhausting one leaves the other intact. */
export type QuotaMeter = 'calls' | 'chat';

/** The path the notice leads with, chosen from the caller's measured burn rate. */
export type RecommendedPath = 'subscription' | 'x402';

export interface QuotaNoticeContext {
  meter: QuotaMeter;
  /** Calls consumed this period. */
  used: number;
  /** The period cap (free `calls` = 100, free `chat` = 10). */
  limit: number;
  /** Epoch ms at which access returns. Rolling for `calls`, calendar-month for `chat`. */
  resetAtMs: number;
  /** Injectable clock (tests). Defaults to `Date.now()`. */
  nowMs?: number;
  /** Caller's referral code (keyed) or null (keyless) — drives the free-path arm. */
  referralCode?: string | null;
  /**
   * The LIVE in-protocol pay-per-call rail for the tool that hit the wall, or undefined when
   * no public rail is live. Passed in (never derived here) so this stays a leaf, and so the
   * notice can never advertise a dark rail — the pre-wave `scan_trade_calls` copy promised
   * "or pay per call via x402" unconditionally.
   */
  x402?: SuggestedX402;
  /**
   * Epoch ms the period began. Enables the burn-rate projection that RANKS the two paths.
   * Absent ⇒ no projection ⇒ the subscription leads (acquisition North Star).
   */
  periodStartMs?: number;
}

/** The machine-readable facts every surface embeds. Allow-listed; no internal metric. */
export interface QuotaNoticeFacts {
  /** `"100/100"` — the figure the human message and the operator alert both project from. */
  usage_display: string;
  current_usage: number;
  monthly_limit: number;
  /** Full ISO-8601 instant access returns. Machines branch on this. */
  resets_at: string;
  /** `YYYY-MM-DD` (UTC) — the date the human message prints. */
  resets_at_date: string;
  /** Whole days until `resets_at`, ceiling, floored at 0. Matches `daysUntilMonthReset`. */
  retry_after_days: number;
  /** Which path the notice leads with. */
  recommended_path: RecommendedPath;
}

/** Per-meter nouns. Keeping them in one place is why a new surface cannot invent a fifth phrasing. */
const METER_COPY: Record<QuotaMeter, { noun: string; upgradeFrom: string }> = {
  calls: { noun: 'Free monthly quota', upgradeFrom: 'limit' },
  chat: { noun: 'Free monthly chat quota', upgradeFrom: 'limit_chat' },
};

/** `YYYY-MM-DD` in UTC. Never the host's local date — the reset instant is UTC. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Rank the two paths from the caller's own burn rate.
 *
 * Projected monthly volume = `used / elapsedDays * 30`, with `elapsedDays` floored at 1 so a
 * caller who burned the whole allowance in an hour is not extrapolated to a fictional 72,000
 * calls/month — the floor caps the projection at `limit * 30`, which is conservative in the
 * only direction that matters (it can under-sell the subscription, never over-sell it).
 *
 * Above the break-even (plan price ÷ per-call price, both read live from their SoT) the
 * subscription is genuinely cheaper and leads; below it, pay-per-call leads. With no live
 * rail there is nothing to compare, so the subscription leads by default.
 */
export function recommendPath(ctx: QuotaNoticeContext): RecommendedPath {
  const perCall = ctx.x402?.primary?.price_usd;
  const breakEven = subscriptionBreakEvenCalls(perCall);
  if (breakEven === null) return 'subscription';
  if (typeof ctx.periodStartMs !== 'number' || !Number.isFinite(ctx.periodStartMs)) return 'subscription';
  const now = ctx.nowMs ?? Date.now();
  const elapsedDays = Math.max(1, (now - ctx.periodStartMs) / DAY_MS);
  const projectedMonthly = (ctx.used / elapsedDays) * 30;
  return projectedMonthly >= breakEven ? 'subscription' : 'x402';
}

/**
 * A full rolling window, in ms. Matches `license.MONTH_MS`; duplicated as a private constant
 * ONLY because importing `license.ts` here would close an import cycle (see the module note).
 * It is a fallback bound, not a second source of the reset instant — production callers always
 * pass a real `resetAtMs`.
 */
const FALLBACK_WINDOW_MS = 30 * DAY_MS;

/** Compute the notice's machine-readable facts. Pure. */
export function quotaNoticeFacts(ctx: QuotaNoticeContext): QuotaNoticeFacts {
  const now = ctx.nowMs ?? Date.now();
  // A guard on a LIVE SERVING PATH degrades; it does not throw. A non-finite `resetAtMs` would
  // make `new Date(x).toISOString()` raise `RangeError: Invalid time value` and turn a notice —
  // the one response a walled caller receives — into a 500. Every production caller passes
  // `monthResetAtMs()`, which is always finite, so this only catches a JS caller or a bug; it
  // falls back to a full window from now, the same conservative default `daysUntilMonthReset`
  // already uses when a caller has no tracker.
  const resetAtMs = Number.isFinite(ctx.resetAtMs) ? ctx.resetAtMs : now + FALLBACK_WINDOW_MS;
  const msUntil = resetAtMs - now;
  return {
    usage_display: `${ctx.used}/${ctx.limit}`,
    current_usage: ctx.used,
    monthly_limit: ctx.limit,
    resets_at: new Date(resetAtMs).toISOString(),
    resets_at_date: utcDate(resetAtMs),
    retry_after_days: msUntil <= 0 ? 0 : Math.ceil(msUntil / DAY_MS),
    recommended_path: recommendPath(ctx),
  };
}

/** The subscription arm. Links; never inlines a dollar figure (a link cannot go stale). */
function subscriptionLine(meter: QuotaMeter, lead: boolean): string {
  const plan = PLANS[DEFAULT_UPGRADE_PLAN];
  const url = nudgeSignupUrl(METER_COPY[meter].upgradeFrom as Parameters<typeof nudgeSignupUrl>[0]);
  if (meter === 'chat') {
    return `Upgrade for a higher chat allowance — ${plan.label}, card required: ${url}`;
  }
  const prefix = lead ? 'Recommended for sustained volume' : 'For sustained volume';
  return `${prefix}: ${plan.label} — ${planCallsLabel(DEFAULT_UPGRADE_PLAN)} calls/month, card required: ${url}`;
}

/** The pay-per-call arm. Rendered ONLY when a live rail was actually derived. */
function x402Line(x402: SuggestedX402, lead: boolean): string {
  const prefix = lead ? 'Recommended at your volume' : 'No signup';
  return `${prefix}: pay per call from your own wallet at $${x402.primary.price_usd} via x402: ${x402.primary.url}`;
}

/**
 * The free arm — state-adaptive; a keyless caller is never shown a fake link.
 *
 * Both branches open on the SAME clause ("refer a friend — you both get N bonus calls") so the
 * offer reads identically whoever hits the wall; only the link differs. A keyless caller must
 * be told what the link is FOR before being asked to sign up for one.
 */
function referralLine(referralCode: string | null | undefined): string {
  const bonus = bonusCallsLabel();
  const offer = `Keep going free: refer a friend — you both get ${bonus} bonus calls.`;
  if (referralCode) {
    return `${offer} Your link: ${shareLink(referralCode, 'algovault.com')}`;
  }
  return `${offer} Create your free account for a referral link → ${referralSignupUrl('limit')}`;
}

/**
 * The human-readable notice. ONE renderer for every surface.
 *
 * Public-copy LAW: professional and concise, ≤20 words per sentence, no filler, closing on an
 * action-verb CTA plus the outcome. Line breaks are intentional — an agent relays this verbatim
 * into a chat window, and four short labelled lines survive that better than a paragraph.
 *
 * The chat meter deliberately drops the referral arm: referral bonuses credit the CALL meter
 * (`bonusRemaining`), so offering them on a chat wall would promise relief that never arrives.
 * It gains instead the one fact a caller most needs — the trading tools are still available.
 */
export function buildQuotaNoticeMessage(ctx: QuotaNoticeContext): string {
  const f = quotaNoticeFacts(ctx);
  const lines: string[] = [
    `${METER_COPY[ctx.meter].noun} used: ${f.usage_display}. Access returns ${f.resets_at_date} (${f.retry_after_days} days).`,
  ];

  if (ctx.meter === 'chat') {
    lines.push(subscriptionLine('chat', true));
    lines.push('Trading tools draw on a separate quota and are unaffected.');
    return lines.join('\n');
  }

  if (ctx.x402 && f.recommended_path === 'x402') {
    lines.push(x402Line(ctx.x402, true));
    lines.push(subscriptionLine('calls', false));
  } else {
    lines.push(subscriptionLine('calls', true));
    if (ctx.x402) lines.push(x402Line(ctx.x402, false));
  }
  lines.push(referralLine(ctx.referralCode));
  return lines.join('\n');
}

/**
 * The `suggested_<action>` field the structured-error law requires: ONE imperative sentence an
 * agent can act on without parsing the prose, always closing on the do-nothing fallback (wait
 * for the reset) so the caller is never left without a next step.
 */
export function buildQuotaSuggestedAction(ctx: QuotaNoticeContext): string {
  const f = quotaNoticeFacts(ctx);
  const wait = `or wait until ${f.resets_at_date} for the free quota to reset`;
  if (ctx.meter === 'chat') {
    return `Upgrade to ${PLANS[DEFAULT_UPGRADE_PLAN].label} at ${nudgeSignupUrl('limit_chat' as Parameters<typeof nudgeSignupUrl>[0])} for a higher chat allowance, ${wait}.`;
  }
  if (ctx.x402 && f.recommended_path === 'x402') {
    return `Pay per call via x402 at ${ctx.x402.primary.url} ($${ctx.x402.primary.price_usd}, no signup), ${wait}.`;
  }
  const plan = PLANS[DEFAULT_UPGRADE_PLAN];
  const subscribe = `Subscribe to ${plan.label} (${planCallsLabel(DEFAULT_UPGRADE_PLAN)} calls/month) at ${nudgeSignupUrl('limit')}`;
  if (ctx.x402) {
    return `${subscribe}, pay per call via x402 at ${ctx.x402.primary.url}, ${wait}.`;
  }
  return `${subscribe}, ${wait}.`;
}

/**
 * Back-compat entry point for the 100% limit message.
 *
 * `buildLimitMessage` (ACTIVATION-NUDGE-W1 → REFERRAL-INPRODUCT-NUDGE-W1) lived in `nudge-copy.ts`
 * and rendered only the referral + upgrade arms — no usage figure and, critically, no reset date.
 * It now delegates here so there is exactly ONE limit message in the codebase. Callers that cannot
 * supply the reset instant are a bug, not a supported mode: every one of them has a meter.
 */
export function buildLimitMessage(ctx: {
  used: number;
  total: number;
  referralCode: string | null;
  resetAtMs: number;
  nowMs?: number;
  periodStartMs?: number;
  x402?: SuggestedX402;
}): string {
  return buildQuotaNoticeMessage({
    meter: 'calls',
    used: ctx.used,
    limit: ctx.total,
    resetAtMs: ctx.resetAtMs,
    nowMs: ctx.nowMs,
    periodStartMs: ctx.periodStartMs,
    referralCode: ctx.referralCode,
    x402: ctx.x402,
  });
}
