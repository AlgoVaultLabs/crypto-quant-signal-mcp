/**
 * IDENTITY-LIFECYCLE-W3 — the ONE module every user-facing lifecycle string lives in.
 *
 * Nothing in `src/lib/lifecycle/**` may contain a user-visible literal. Strings come from here;
 * numbers come from `plans.ts` / `referral-constants.ts` and are interpolated at render time,
 * never typed. The audit file `audits/IDENTITY-LIFECYCLE-W3-copy-locked-source.txt` carries the
 * architect-signed source, and `tests/unit/lifecycle-copy-locked.test.ts` asserts the RENDERED
 * output against it — over the rendered bytes, not these constants, because a test that compares
 * a constant to itself is the vacuous shape this estate has now met six times.
 *
 * WHY THE SUBJECTS CARRY NO LITERAL NUMBERS. `quota_80`'s subject was signed off as
 * `160 of 200 free calls used`. 160 is `0.8 × FREE_MONTHLY_CALLS` and 200 is
 * `FREE_MONTHLY_CALLS`; typing either one means a future quota change silently falsifies a
 * subject line, which is the numerical-citation rule's exact prohibition. Architect ratified the
 * template form (Q5, 2026-09-08).
 *
 * WHY THERE IS NO "THIS MONTH" ANYWHERE. The free allowance is a ROLLING 30-DAY WINDOW anchored
 * at each caller's first call (`MONTH_MS` in `src/lib/license.ts`; `src/lib/plans.ts` records
 * that the rolling window is not statable in copy). Measured 2026-09-08 on signal-1, two of the
 * three metered email-bound buckets carried a `period_start` whose 30-day window had already
 * expired — so "this month" is not merely imprecise, it is false. Architect ruling Q5(A) removed
 * it from E2–E4. `Starter is 10,000 calls a month` stays: that is the plan ladder's own
 * canonical phrase and Starter's allowance genuinely is a monthly one.
 */
import { freeCallsLabel, freeDailyCallsLabel, planCallsLabel, planDailyCallsLabel, planPriceLabel } from './plans.js';
import { bonusCallsLabel } from './referral-constants.js';
import { TIMEFRAME_COUNT } from './capabilities.js';

/** The five lifecycle steps. Order is the frequency-cap PRIORITY order — see `STEP_PRIORITY`. */
export const LIFECYCLE_STEPS = [
  'quota_wall',
  'quota_80',
  'reset_return',
  'activation_nudge',
  'product_updates',
] as const;
export type LifecycleStep = (typeof LIFECYCLE_STEPS)[number];

/**
 * Priority when a frequency cap forces a choice between two eligible steps on one day
 * (architect-ratified 2026-09-08). Lower index wins.
 *
 * The ordering is not taste. `quota_wall` is the only step describing a condition the recipient
 * is experiencing RIGHT NOW — their agent is being refused — so it outranks everything. The
 * digest yields to all four usage steps and is deferred to the next eligible day, because a
 * product update is never time-critical and MEASURED 2026-09-08 all six `signup_emails` opt-ins
 * also hold a free key, so the collision is not hypothetical: it is the default case.
 */
export const STEP_PRIORITY: readonly LifecycleStep[] = LIFECYCLE_STEPS;

export const API_BASE = 'https://api.algovault.com';
export const LANDING_BASE = 'https://algovault.com';

/** `?utm_*` for a link inside a lifecycle email. The ONE derivation — never hand-built. */
export function lifecycleUtm(step: LifecycleStep): string {
  return `utm_source=lifecycle&utm_medium=email&utm_campaign=${step}`;
}

// ── §Footer — verbatim on every message ────────────────────────────────────────────────────
export const FOOTER_BRAND = 'AlgoVault Labs';
export const FOOTER_UNSUBSCRIBE_LABEL = 'Unsubscribe';
export const FOOTER_MANAGE_LABEL = 'Manage email preferences';

export function footerText(unsubscribeUrl: string): string {
  return `${FOOTER_BRAND} · ${FOOTER_UNSUBSCRIBE_LABEL}: ${unsubscribeUrl} · ${FOOTER_MANAGE_LABEL}: ${API_BASE}/account`;
}

// ── Unsubscribe confirmation page (CH1 R3) ─────────────────────────────────────────────────
export const UNSUB_CONFIRMED_LINE = "You're unsubscribed from AlgoVault emails. Your key and account are unchanged.";
export const UNSUB_CONFIRM_BUTTON = 'Unsubscribe me';
export const UNSUB_PROMPT_LINE = 'Confirm you want to stop receiving AlgoVault lifecycle emails.';
export const UNSUB_INVALID_LINE = 'That unsubscribe link is not valid. Email admin@algovault.com and we will remove you by hand.';

// ── C1 / C2 / C3 — DELIBERATELY NOT HERE IN CH1 ───────────────────────────────────────────
// The /welcome benefit line, the envelope claim strings and the /account usage block are CH3's
// scope. CH1's scope for this file is the §Footer and the shared partials only, and shipping
// CH3's constants early would have put user-facing strings in the tree a chapter before anything
// rendered them — which is what the dark-artifact gate flagged, correctly. CH3 adds them.

/**
 * The MCP-client config snippet E1 renders.
 *
 * ONE builder. The same JSON currently appears by hand in three places — `email.ts` twice (the
 * welcome and key-recovery shells) and `welcome-page.ts` once — and a fourth hand-copy is how a
 * config snippet starts telling different users different things. CH3 owns `welcome-page.ts` and
 * converges it onto this function; the two in `email.ts` are named as a follow-up rather than
 * edited here, because CH2's Scope does not include the transactional templates.
 *
 * `chan-email` is the track token, and it ALREADY SHIPS at `email.ts:552`/`:593` — this reuses
 * the live value rather than declaring a new one.
 */
export const EMAIL_TRACK_TOKEN = 'chan-email';

export function mcpConfigSnippet(apiKey: string): string {
  return `{
  "mcpServers": {
    "algovault": {
      "url": "${API_BASE}/mcp",
      "headers": { "Authorization": "Bearer ${apiKey}", "X-AlgoVault-Track-Token": "${EMAIL_TRACK_TOKEN}" }
    }
  }
}`;
}

// ── E1–E5 · the emails ─────────────────────────────────────────────────────────────────────

export interface StepCopyContext {
  /** Masked key, e.g. `av_free_…a1b2`. NEVER the full secret. */
  keyMasked: string;
  /** Monthly meter, from the SAME derivation the envelope uses. */
  used: number;
  total: number;
  /** `resets_at` rendered as `14 September 2026`. */
  resetDate: string;
  /** The `/welcome` MCP config snippet, carrying `X-AlgoVault-Track-Token: chan-email`. */
  mcpConfigSnippet: string;
  /** README `## What's new` blocks, already converted to HTML. `product_updates` only. */
  digestHtml?: string;
  digestText?: string;
  /** `September 2026`. `product_updates` only. */
  digestPeriodLabel?: string;
}

export interface RenderedCopy {
  subject: string;
  /** Body paragraphs as plain text; the renderer wraps them in the HTML shell. */
  paragraphs: string[];
  /** Call-to-action links, in order. */
  ctas: { label: string; url: string }[];
  /** Raw HTML appended after the paragraphs (digest only). */
  rawHtml?: string;
  rawText?: string;
}

/** E1 · activation_nudge */
function activationNudge(ctx: StepCopyContext): RenderedCopy {
  return {
    subject: 'Your AlgoVault key is ready — first call in 30 seconds',
    paragraphs: [
      `Your key ${ctx.keyMasked} hasn't made a call yet. Paste this into Claude Desktop, Cursor or any MCP client:`,
      ctx.mcpConfigSnippet,
      'Then ask: "Get me a trade call for SOL on the 5-minute timeframe."',
      // 🛑 `freeDailyCallsLabel()`, never `FREE_MONTHLY_CALLS / 2`. The daily cap is a SECOND
      // meter that refuses independently (plans.ts), not a slice of the monthly one — it equals
      // half today by coincidence, and deriving it would silently lie the moment either moves.
      `Free tier: all assets, all ${TIMEFRAME_COUNT} timeframes, ${freeCallsLabel()} calls/month (up to ${freeDailyCallsLabel()}/day).`,
    ],
    ctas: [{ label: 'Open the quickstart', url: `${LANDING_BASE}/#quickstart?${lifecycleUtm('activation_nudge')}` }],
  };
}

/** E2 · quota_80 — subject templated per Q5(A); never a literal 160/200. */
function quota80(ctx: StepCopyContext): RenderedCopy {
  return {
    subject: `${ctx.used} of ${ctx.total} free calls used`,
    paragraphs: [
      `Your agent has used ${ctx.used} of its ${ctx.total} free calls. The count resets on ${ctx.resetDate}.`,
      `Need more? Starter is ${planCallsLabel('starter')} calls a month (up to ${planDailyCallsLabel('starter')} a day) for ${planPriceLabel('starter')}.`,
    ],
    ctas: [
      { label: 'Upgrade to Starter', url: `${API_BASE}/signup?plan=starter&${lifecycleUtm('quota_80')}` },
      { label: 'Your referral link', url: `${API_BASE}/account?${lifecycleUtm('quota_80')}` },
    ],
  };
}

/** E3 · quota_wall */
function quotaWall(ctx: StepCopyContext): RenderedCopy {
  return {
    subject: `Free calls used up — they reset on ${ctx.resetDate}`,
    paragraphs: [
      `Your agent hit its ${ctx.total}-call limit. Calls resume on ${ctx.resetDate}.`,
      `Starter removes the wait: ${planCallsLabel('starter')} calls a month for ${planPriceLabel('starter')}.`,
    ],
    ctas: [{ label: 'Upgrade to Starter', url: `${API_BASE}/signup?plan=starter&${lifecycleUtm('quota_wall')}` }],
  };
}

/** E4 · reset_return */
function resetReturn(ctx: StepCopyContext): RenderedCopy {
  return {
    subject: 'Your free calls are back',
    paragraphs: [
      'Your free calls reset today. Your key still works — nothing to do.',
      `If ${ctx.total} a month is getting tight, Starter is ${planCallsLabel('starter')} for ${planPriceLabel('starter')}.`,
    ],
    ctas: [{ label: 'See plans', url: `${API_BASE}/signup?${lifecycleUtm('reset_return')}` }],
  };
}

/** E5 · product_updates — body is the README block, converted verbatim. No new prose. */
function productUpdates(ctx: StepCopyContext): RenderedCopy {
  return {
    subject: `What's new in AlgoVault — ${ctx.digestPeriodLabel ?? ''}`.trim(),
    paragraphs: [],
    ctas: [],
    rawHtml: ctx.digestHtml,
    rawText: ctx.digestText,
  };
}

/** The one closing line the digest carries, restating the consent the checkbox took. */
export const DIGEST_CONSENT_LINE = 'You asked for product updates when you signed up (about one a month).';

/** The referral sentence in E2 — the existing referral SoT string, not new copy. */
export function referralSentence(): string {
  return `Or keep going free: refer a friend and they get ${bonusCallsLabel()} bonus calls.`;
}

const RENDERERS: Record<LifecycleStep, (ctx: StepCopyContext) => RenderedCopy> = {
  activation_nudge: activationNudge,
  quota_80: quota80,
  quota_wall: quotaWall,
  reset_return: resetReturn,
  product_updates: productUpdates,
};

export function copyForStep(step: LifecycleStep, ctx: StepCopyContext): RenderedCopy {
  const fn = RENDERERS[step];
  if (!fn) throw new Error(`lifecycle-copy: no renderer for step '${step}'`);
  return fn(ctx);
}
