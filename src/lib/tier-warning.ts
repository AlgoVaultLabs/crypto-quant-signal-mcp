/**
 * Tier-warning helper (ACTIVATION-PAYWALL-W1).
 *
 * Pure formatter that augments an existing `_algovault` metadata block with
 * a structured `tier_warning` field when a free-tier caller approaches the
 * monthly quota. Wired at MCP tool response sites (get_trade_call,
 * get_trade_signal, scan_funding_arb, get_market_regime).
 *
 * Allow-list discipline (per CLAUDE.md "Allow-list not deny-list for
 * public-API response shaping"): the helper RETURNS a new meta object with
 * the additional field; callers replace their meta with the returned value.
 *
 * Thresholds are sourced from `getMonthlyQuota(tier)` in license.ts (single
 * SoT for the quota) so changes to quota tiers propagate automatically.
 */
import type { AlgoVaultMeta, TierWarning, LicenseTier, MeterReading, QuotaWall } from '../types.js';
import { recordFunnelEvent } from './performance-db.js';
import { getRequestSessionId } from './license.js';
import { SOFT_THRESHOLD, HARD_THRESHOLD } from './activation-thresholds.js';
// OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1 CH2: the ONE derivation of "which meter is closest to
// refusing". LEAF (type-only imports), so this consumer edge closes no cycle.
import { bindingMeter } from './binding-meter.js';
// FUNNEL-FIX-AGENT-X402-NUDGE-W1: the hard warning also offers the additive in-protocol x402
// branch. x402-nudge is a LEAF (imports only pure/SDK modules, never a tool handler / this
// module) so tier-warning → x402-nudge adds no consumer init cycle. Dark behind X402_NUDGE_ENABLED.
import { buildSuggestedX402, isX402NudgeEnabled } from './x402-nudge.js';

// ACTIVATION-NUDGE-W1 (2026-06-18): thresholds now live in the pure
// `activation-thresholds` module (single source shared with license.ts
// `getUpgradeHint`). Re-exported here for back-compat with existing importers
// (tests + any tool referencing `tier-warning`'s constants). SOFT retuned
// 0.75→0.80 in that module (A1); HARD unchanged at 0.90.
export { SOFT_THRESHOLD, HARD_THRESHOLD };

/**
 * Default upgrade-target URL with UTM attribution. Free-tier users who click
 * land on `/signup?plan=starter` which forwards to Stripe Checkout with
 * `client_reference_id` + `metadata.utm_*` set so the post-payment webhook
 * can attribute the conversion back to the originating channel.
 */
// ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28): `upgrade_from=quota` lets the /signup
// handler capture `upgrade_cta_clicked` (stage 7) funnel event. Existing UTM
// params preserved for prior attribution chain.
export const DEFAULT_UPGRADE_URL =
  'https://api.algovault.com/signup?plan=starter&utm_source=mcp_tool&utm_campaign=tier_warning&upgrade_from=quota';

export interface TierWarningContext {
  tier: LicenseTier;
  currentUsage: number;
  monthlyLimit: number;
  /**
   * OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1 CH2 — the DAILY pair and the two reset horizons.
   *
   * ALL OPTIONAL, and their absence is the pre-wave contract: with no daily pair the binding meter
   * is the monthly one, the ratio is `currentUsage / monthlyLimit` exactly as before, and the
   * emitted warning is byte-identical. Every free/paid tier DOES have a daily cap today, so in
   * production these are populated; the absent case is chat, an uncapped tier, and every existing
   * test written before this wave.
   *
   * `monthlyResetAtMs` / `dailyResetAtMs` are what let the warning state the RIGHT horizon. A
   * warning that names the wrong one is the defect `quota-notice.ts` records running in production
   * for a day and a half — this wave must not re-create it one field over.
   */
  dailyUsage?: number;
  dailyLimit?: number;
  monthlyResetAtMs?: number;
  dailyResetAtMs?: number;
  /**
   * When `true`, the caller is a bot-internal request (BOT-W1 D1-C bypass).
   * Bot has its own per-user quota tracker in SQLite; no human to warn.
   */
  isBotInternal?: boolean;
  /**
   * Override the upgrade URL — used by tests and by per-tool-context UTM
   * variations. Defaults to `DEFAULT_UPGRADE_URL` if omitted.
   */
  upgradeUrl?: string;
  /**
   * FUNNEL-FIX-AGENT-X402-NUDGE-W1: the canonical tool that was called — enables the additive
   * `suggested_x402` in-protocol pay-per-call branch on the HARD warning. Unset ⇒ no x402 branch.
   */
  tool?: string;
  /** Env override (tests inject the rail flags); defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Compute the tier-warning structure for a given context. Returns `undefined`
 * when no warning should be emitted (paid tier, bot-internal, below soft
 * threshold, or invalid monthly limit).
 *
 * Exposed for unit testing; production callers should prefer `withTierWarning`.
 */
/**
 * The binding meter for a warning context — the ONE derivation, from `binding-meter.ts`.
 *
 * PURE, so the two call sites below (the warning itself, and the funnel event that records it)
 * cannot disagree: same inputs, same function, same answer. That matters because before this wave
 * the funnel's `ratio` was re-computed inline from the monthly pair, and a warning that fired on
 * one meter would have been recorded against another.
 *
 * A context with no daily pair yields a monthly-only binding, whose ratio is exactly
 * `currentUsage / monthlyLimit` — the pre-wave expression, so nothing moves for those callers.
 */
function contextBinding(ctx: TierWarningContext) {
  const monthly: MeterReading = {
    used: ctx.currentUsage,
    limit: ctx.monthlyLimit,
    // NaN when the caller passed no monthly horizon. `bindingMeter` does not gate on `resetAtMs`
    // (a meter is metered by its LIMIT), so this stays a valid monthly meter and only the
    // rendered `resets_at` is withheld below.
    resetAtMs: ctx.monthlyResetAtMs ?? NaN,
  };
  const daily: MeterReading | null =
    typeof ctx.dailyLimit === 'number' && typeof ctx.dailyUsage === 'number'
      ? { used: ctx.dailyUsage, limit: ctx.dailyLimit, resetAtMs: ctx.dailyResetAtMs ?? NaN }
      : null;
  return bindingMeter(monthly, daily);
}

export function computeTierWarning(ctx: TierWarningContext): TierWarning | undefined {
  // Skip paid tiers (starter/pro/enterprise/x402) and internal bot bypass.
  if (ctx.tier !== 'free') return undefined;
  // Skip bot-internal traffic — no human to display a CTA to.
  if (ctx.isBotInternal === true) return undefined;
  // Defensive: monthlyLimit must be a positive finite number.
  if (!Number.isFinite(ctx.monthlyLimit) || ctx.monthlyLimit <= 0) return undefined;
  // Defensive: currentUsage must be a non-negative number.
  if (!Number.isFinite(ctx.currentUsage) || ctx.currentUsage < 0) return undefined;

  // OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1 CH2: the ratio is the BINDING meter's, not the
  // monthly one's. Thresholds are untouched at 0.80 / 0.90 — only the quantity they are applied
  // to changed. That single substitution is what makes a 100/day caller reachable: their monthly
  // ratio at the daily wall is 0.50, which no threshold in this file was ever going to catch.
  const binding = contextBinding(ctx);
  if (!binding) return undefined;
  const ratio = binding.ratio;

  // Above the hard threshold but below 100% → hard warning. At/above 100%
  // the request hits the TIER_LIMIT_REACHED error envelope at the checkQuota
  // block path; no tier_warning field on that error path.
  if (ratio >= 1.0) return undefined;

  let level: 'soft' | 'hard';
  if (ratio >= HARD_THRESHOLD) {
    level = 'hard';
  } else if (ratio >= SOFT_THRESHOLD) {
    level = 'soft';
  } else {
    return undefined;
  }

  const warning: TierWarning = {
    level,
    current_usage: ctx.currentUsage,
    monthly_limit: ctx.monthlyLimit,
    tier: ctx.tier,
    suggested_upgrade_url: ctx.upgradeUrl ?? DEFAULT_UPGRADE_URL,
  };
  // CH2: name the wall and its own reset horizon — spread-on-presence, so a caller with no daily
  // meter gets the byte-identical pre-wave object. `current_usage` / `monthly_limit` above keep
  // meaning the MONTHLY pair; every existing consumer reads them that way and this wave does not
  // move them under those consumers' feet.
  if (binding.daily) {
    warning.meter = binding.binding;
    if (Number.isFinite(binding.resetAtMs)) {
      warning.resets_at = new Date(binding.resetAtMs).toISOString();
    }
  }
  // FUNNEL-FIX-AGENT-X402-NUDGE-W1: on the HARD warning only, attach the additive in-protocol
  // x402 branch (dark behind X402_NUDGE_ENABLED). buildSuggestedX402 returns undefined for a
  // HELD tool / no live public rail, so this stays default-deny + byte-identical when off.
  if (level === 'hard' && ctx.tool && isX402NudgeEnabled(ctx.env)) {
    // OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH2 (instance 11), the ONLY line this wave changes in
    // this file: pass the binding meter this function has ALREADY derived. A hard warning fires at
    // >=0.90 of whichever meter BINDS, so a caller at 92/100 DAILY was handed a nudge reading
    // "Free monthly quota reached". `binding.binding`, NOT `warning.meter`: the latter is populated
    // only when a daily meter exists and is `undefined` for a monthly-only caller, whereas
    // `bindingMeter()` always names a wall. Passing the optional field would have re-introduced an
    // implicit default — the exact shape a REQUIRED parameter exists to forbid.
    const sx = buildSuggestedX402(ctx.tool, binding.binding, ctx.env);
    if (sx) warning.suggested_x402 = sx;
  }
  return warning;
}

/**
 * Augment an `_algovault` metadata block with a `tier_warning` field when
 * appropriate. Returns a NEW object (immutable; callers replace their meta).
 *
 * Below the soft threshold OR paid tier OR bot-internal: returns the input
 * meta unchanged (no shape mutation).
 */
export function withTierWarning(meta: AlgoVaultMeta, ctx: TierWarningContext): AlgoVaultMeta {
  const warning = computeTierWarning(ctx);
  if (!warning) return meta;
  // ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28): capture quota_hit_soft (stage 4)
  // and quota_hit_hard (stage 5) funnel events. Dedup happens at snapshot
  // query time via `COUNT(DISTINCT session_id)` — fire-and-forget on every
  // call after threshold; the funnel-snapshot reader's DISTINCT semantics
  // collapses these to one session per stage. Fail-open per recordFunnelEvent
  // contract.
  const eventType = warning.level === 'soft' ? 'quota_hit_soft' : 'quota_hit_hard';
  // CH2: the recorded ratio is the one that FIRED (the binding meter's), not a second inline
  // re-derivation from the monthly pair — those two disagree for exactly the callers this wave
  // exists to make visible. Same pure function as `computeTierWarning` used above.
  const binding = contextBinding(ctx);
  recordFunnelEvent({
    eventType,
    sessionId: getRequestSessionId() ?? null,
    licenseTier: ctx.tier,
    meta: {
      current_usage: ctx.currentUsage,
      monthly_limit: ctx.monthlyLimit,
      ratio: binding ? binding.ratio : ctx.currentUsage / ctx.monthlyLimit,
      // WHICH wall this warning is about. Spelled IDENTICALLY to `quota_hit_block.meta.limit`
      // (license.ts, both refusal branches) because CH5 joins across all three stages — a second
      // spelling would silently split the funnel rather than fail loudly.
      limit: (binding?.binding ?? 'monthly') as QuotaWall,
    },
  });
  return { ...meta, tier_warning: warning };
}

/**
 * Attach live quota state to an `_algovault` block on a SUCCESSFUL response
 * (OPS-QUOTA-EXHAUSTION-NOTICE-W1, 2026-08-02).
 *
 * `tier_warning` only appears from 80% — so below that a caller had no quota signal at all and
 * the wall arrived without warning. This is the always-on counterpart: usage, remaining, and
 * the reset instant, visible from call one, so a developer debugging an agent can see the
 * boundary coming instead of discovering it as a hard failure.
 *
 * It does NOT alter the cutoff and does not weaken it — it is telemetry on the healthy path.
 *
 * Default-deny, mirroring `computeTierWarning`'s gate: bot-internal traffic is skipped (no human
 * to inform, and the bot meters its own users), and a non-finite or non-positive limit is skipped
 * — which is what excludes the unmetered `x402` / `internal` tiers, whose quota is `Infinity` and
 * has no honest JSON form. Paid tiers DO get it: `412/3000` is as useful to them as to free.
 *
 * Returns a NEW object; callers replace their meta. Skipped ⇒ the input is returned untouched, so
 * the shape is byte-identical to before this wave.
 */
export function withQuotaState(
  meta: AlgoVaultMeta,
  ctx: {
    tier: LicenseTier;
    used: number;
    total: number;
    resetAtMs: number;
    /**
     * OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1 CH2 — the DAILY pair. All optional; absent ⇒ the
     * emitted block is byte-identical to pre-wave, which is the case the test suite pins.
     *
     * This is the field that was actually lying. `_algovault.quota` was always-on from call one,
     * and for a caller pacing at the daily cap it reported the MONTHLY remainder — so the envelope
     * that refused them at call 100 had just told them 100 calls were left.
     */
    dailyUsed?: number;
    dailyTotal?: number;
    dailyResetAtMs?: number;
    isBotInternal?: boolean;
  },
): AlgoVaultMeta {
  if (ctx.isBotInternal === true) return meta;
  if (!Number.isFinite(ctx.total) || ctx.total <= 0) return meta;
  if (!Number.isFinite(ctx.used) || ctx.used < 0) return meta;
  if (!Number.isFinite(ctx.resetAtMs)) return meta;

  // The daily pair is emitted only when it is BOTH present and honestly metered AND carries its
  // own horizon — a `resets_at` we cannot compute is worse than one we omit, since `new Date(NaN)`
  // throws and a wrong instant is the very defect this chapter names.
  const binding = bindingMeter(
    { used: ctx.used, limit: ctx.total, resetAtMs: ctx.resetAtMs },
    typeof ctx.dailyTotal === 'number' && typeof ctx.dailyUsed === 'number'
      ? { used: ctx.dailyUsed, limit: ctx.dailyTotal, resetAtMs: ctx.dailyResetAtMs ?? NaN }
      : null,
  );
  const daily = binding?.daily;
  const emitDaily = !!daily && Number.isFinite(daily.resetAtMs);

  return {
    ...meta,
    quota: {
      used: ctx.used,
      total: ctx.total,
      remaining: Math.max(0, ctx.total - ctx.used),
      resets_at: new Date(ctx.resetAtMs).toISOString(),
      // Spread-on-presence — the same allow-list discipline `suggested_x402` uses in
      // `buildTierLimitPayload`, and what keeps the no-daily key SET byte-identical.
      ...(emitDaily
        ? {
            daily: {
              used: daily.used,
              total: daily.limit,
              remaining: Math.max(0, daily.limit - daily.used),
              resets_at: new Date(daily.resetAtMs).toISOString(),
            },
            binding: binding.binding,
          }
        : {}),
    },
  };
}
