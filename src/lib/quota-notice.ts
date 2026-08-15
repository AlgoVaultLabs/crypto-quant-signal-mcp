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
// LEAF, not `license.ts` — see the module note above on why that import would cycle. This is the
// SAME derivation the daily meter enforces against, which is the point of extracting it.
import { hoursUntilUtcDayReset } from './utc-day.js';
import { nudgeSignupUrl, referralSignupUrl } from './nudge-copy.js';
import { shareLink, bonusCallsLabel } from './referral-constants.js';
import type { SuggestedX402 } from '../types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which meter the caller exhausted. They are independent — exhausting one leaves the other intact. */
export type QuotaMeter = 'calls' | 'chat';

/**
 * WHICH wall refused — orthogonal to `QuotaMeter`, which names the SURFACE (calls vs chat).
 *
 * R-B gave the `calls` surface two independent meters, and they retry on horizons an order of
 * magnitude apart: hours to the next 00:00 UTC vs days to the caller's own rolling reset. A
 * notice that does not know which one fired cannot state either correctly — and the one it
 * guessed was the monthly one, which told a caller walled for a few hours to come back in 30
 * days. `chat` has no daily meter, so `'monthly'` is the only reachable value there.
 */
export type QuotaWall = 'daily' | 'monthly';

/** The path the notice leads with, chosen from the caller's measured burn rate. */
export type RecommendedPath = 'subscription' | 'x402';

export interface QuotaNoticeContext {
  meter: QuotaMeter;
  /** Calls consumed this period. */
  used: number;
  /** The period cap (free `calls` = 200/mo, free `chat` = 10). */
  limit: number;
  /**
   * Which meter refused. DEFAULTS to `'monthly'`, which is what every pre-R-B caller meant and
   * is why adding this field moved zero rendered bytes on the monthly path.
   *
   * When `'daily'`, `used`/`limit` MUST be the DAILY pair — the whole defect this closes was a
   * daily refusal rendering the monthly pair, so the two travel together or not at all.
   */
  wall?: QuotaWall;
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
  /**
   * Whole hours to the next 00:00 UTC — present ONLY on a daily wall, absent on a monthly one.
   *
   * Two fields rather than one polymorphic "retry_after", because a machine reading this has to
   * branch on the unit anyway and a single field would make the unit implicit. Absence is the
   * signal that days is the right horizon.
   */
  retry_after_hours?: number;
  /** Which wall refused — the discriminator the shape snapshot has promised since CH7. */
  limit: QuotaWall;
  /** Which path the notice leads with. */
  recommended_path: RecommendedPath;
}

/**
 * Per-(meter, wall) nouns. Keeping them in one place is why a new surface cannot invent a fifth
 * phrasing — and why the noun cannot drift from the usage pair printed beside it: both are
 * projected from `ctx.wall` in `buildQuotaNoticeMessage`, in one expression.
 */
const METER_COPY: Record<QuotaMeter, { noun: string; dailyNoun?: string; upgradeFrom: string }> = {
  calls: { noun: 'Free monthly quota', dailyNoun: 'Free daily quota', upgradeFrom: 'limit' },
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
 *
 * 🛑 THE NUMERATOR AND THE DENOMINATOR MUST COME FROM THE SAME METER
 * (OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1-R2 CH3).
 *
 * This module's contract is that on a daily wall `used`/`limit` are the DAILY pair — but
 * `periodStartMs` is, and always was, the MONTHLY period anchor, passed unconditionally by
 * `errors.ts`. So the daily arm divided a ONE-DAY numerator by a MULTI-DAY denominator, and the
 * error grew with how deep into the monthly period the daily wall happened to fire.
 *
 * Measured consequence: a 100/day caller walled on day 20 of their rolling month projected
 * `100 / 20 * 30 = 150`, under the break-even, so the notice led with **x402 — the more expensive
 * path — for the caller most worth converting**. The honest projection is 3,000/mo, which clears
 * the break-even by ~6x and is genuinely cheaper as a subscription.
 *
 * The daily arm needs no anchor at all: `used` IS the count spent inside one UTC day, so the
 * window is one day by construction and the projection is `used * 30`. That keeps this module the
 * documented LEAF it must stay — no `license.ts` import, no second reset instant threaded in — and
 * it is a conservative LOWER bound, since a caller who spent `used` in six hours is not
 * extrapolated upward. The monthly arm below is untouched, byte-for-byte.
 */
export function recommendPath(ctx: QuotaNoticeContext): RecommendedPath {
  const perCall = ctx.x402?.primary?.price_usd;
  const breakEven = subscriptionBreakEvenCalls(perCall);
  if (breakEven === null) return 'subscription';
  // DAILY wall — same meter on both sides, and deliberately ahead of the `periodStartMs` guard:
  // that anchor is the monthly one and has no business in this arm even when it is present.
  if (ctx.wall === 'daily') {
    return ctx.used * 30 >= breakEven ? 'subscription' : 'x402';
  }
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
  const wall: QuotaWall = ctx.wall ?? 'monthly';
  return {
    usage_display: `${ctx.used}/${ctx.limit}`,
    current_usage: ctx.used,
    monthly_limit: ctx.limit,
    resets_at: new Date(resetAtMs).toISOString(),
    resets_at_date: utcDate(resetAtMs),
    retry_after_days: msUntil <= 0 ? 0 : Math.ceil(msUntil / DAY_MS),
    // Hours are the DAILY wall's unit and are absent on a monthly one, so a reader branches on
    // presence rather than on a magnitude. Derived from `hoursUntilUtcDayReset` — the same
    // function the meter's own boundary uses — rather than a second ceil-over-duration here.
    ...(wall === 'daily' ? { retry_after_hours: hoursUntilUtcDayReset(now) } : {}),
    limit: wall,
    recommended_path: recommendPath(ctx),
  };
}

/**
 * The refusal headline — ONE projection of `f.limit`, which is why the noun, the usage pair and
 * the retry horizon cannot disagree with each other.
 *
 * They disagreed in production for a day and a half: a daily wall rendered the MONTHLY noun
 * ("Free monthly quota"), the MONTHLY pair (`100/200`) and the MONTHLY horizon ("30 days") for a
 * caller whose access returned within hours. Three wrong facts, one root cause — the sentence was
 * assembled from parts that each independently assumed the monthly meter. Assembling it from the
 * discriminator instead makes that class unwritable: there is no expression here that mentions a
 * meter without going through `wall`.
 *
 * `chat` has no daily meter, so its branch is the monthly one by construction.
 */
function headline(ctx: QuotaNoticeContext, f: QuotaNoticeFacts): string {
  const copy = METER_COPY[ctx.meter];
  if (f.limit === 'daily') {
    // `retry_after_hours` is present exactly when `limit === 'daily'` (see quotaNoticeFacts), but
    // read defensively: a hand-built facts object from a JS caller must degrade to a sentence,
    // never to `undefined hours` on the one response a walled caller receives.
    const hrs = f.retry_after_hours ?? hoursUntilUtcDayReset(ctx.nowMs ?? Date.now());
    return `${copy.dailyNoun ?? copy.noun} used: ${f.usage_display}. `
      + `Access returns at 00:00 UTC (${hrs} ${hrs === 1 ? 'hour' : 'hours'}).`;
  }
  return `${copy.noun} used: ${f.usage_display}. Access returns ${f.resets_at_date} (${f.retry_after_days} days).`;
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
  const lines: string[] = [headline(ctx, f)];

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
  // The do-nothing fallback is a SECOND rendering of the same fact the headline states, so it
  // projects from the same discriminator. Left keyed on the monthly reset date it would tell a
  // daily-walled caller to wait weeks — the identical defect, one field over.
  const wait = f.limit === 'daily'
    ? 'or wait until 00:00 UTC for the daily allowance to reset'
    : `or wait until ${f.resets_at_date} for the free quota to reset`;
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
