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
import type { AlgoVaultMeta, TierWarning, LicenseTier } from '../types.js';
import { recordFunnelEvent } from './performance-db.js';
import { getRequestSessionId } from './license.js';

export const SOFT_THRESHOLD = 0.75;
export const HARD_THRESHOLD = 0.90;

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
   * When `true`, the caller is a bot-internal request (BOT-W1 D1-C bypass).
   * Bot has its own per-user quota tracker in SQLite; no human to warn.
   */
  isBotInternal?: boolean;
  /**
   * Override the upgrade URL — used by tests and by per-tool-context UTM
   * variations. Defaults to `DEFAULT_UPGRADE_URL` if omitted.
   */
  upgradeUrl?: string;
}

/**
 * Compute the tier-warning structure for a given context. Returns `undefined`
 * when no warning should be emitted (paid tier, bot-internal, below soft
 * threshold, or invalid monthly limit).
 *
 * Exposed for unit testing; production callers should prefer `withTierWarning`.
 */
export function computeTierWarning(ctx: TierWarningContext): TierWarning | undefined {
  // Skip paid tiers (starter/pro/enterprise/x402) and internal bot bypass.
  if (ctx.tier !== 'free') return undefined;
  // Skip bot-internal traffic — no human to display a CTA to.
  if (ctx.isBotInternal === true) return undefined;
  // Defensive: monthlyLimit must be a positive finite number.
  if (!Number.isFinite(ctx.monthlyLimit) || ctx.monthlyLimit <= 0) return undefined;
  // Defensive: currentUsage must be a non-negative number.
  if (!Number.isFinite(ctx.currentUsage) || ctx.currentUsage < 0) return undefined;

  const ratio = ctx.currentUsage / ctx.monthlyLimit;

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

  return {
    level,
    current_usage: ctx.currentUsage,
    monthly_limit: ctx.monthlyLimit,
    tier: ctx.tier,
    suggested_upgrade_url: ctx.upgradeUrl ?? DEFAULT_UPGRADE_URL,
  };
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
  recordFunnelEvent({
    eventType,
    sessionId: getRequestSessionId() ?? null,
    licenseTier: ctx.tier,
    meta: {
      current_usage: ctx.currentUsage,
      monthly_limit: ctx.monthlyLimit,
      ratio: ctx.currentUsage / ctx.monthlyLimit,
    },
  });
  return { ...meta, tier_warning: warning };
}
