/**
 * Typed error classes for upstream-API failures (v1.10.2).
 *
 * Why typed: the previous generic `Error("HL API 429: Too Many Requests")` shape
 * surfaced to MCP clients as `{error: "HL API 429: ..."}` with no machine-
 * readable classification. Clients couldn't distinguish "AlgoVault MCP is down"
 * from "Hyperliquid is rate-limiting us; try Binance" — both looked like
 * generic `isError: true` tool responses. Typed errors let the MCP envelope
 * (src/index.ts tool handler) emit a structured fault payload with
 * `error_code`, `exchange`, `retry_after_seconds`, and a `suggestion`
 * (alternative exchanges to fall back to).
 *
 * The error-code namespace is open: add new classes here when a new failure
 * mode needs first-class client-side handling.
 */
// ACTIVATION-NUDGE-W1 (2026-06-18): the 100% TIER_LIMIT_REACHED message renders
// the approved CTA copy with LIVE track-record values (replacing the legacy
// over-promising wording that violated the bounded-tier copy rule). Both imports
// are pure / side-effect-free; no import cycle. REFERRAL-INPRODUCT-NUDGE-W1: the
// referral arm + structured hint also come from the (pure) nudge-copy SoT.
import { buildReferralHint, type ReferralHint } from './nudge-copy.js';
// OPS-QUOTA-EXHAUSTION-NOTICE-W1 (2026-08-02): the exhaustion notice is now ONE contract shared
// by every free-tier surface (message + facts + suggested_action). `quota-notice` is a pure leaf
// (plans / nudge-copy / referral-constants only), so importing it here closes no cycle.
import { buildQuotaNoticeMessage, buildQuotaSuggestedAction, quotaNoticeFacts, type QuotaNoticeContext } from './quota-notice.js';
// FUNNEL-FIX-AGENT-X402-NUDGE-W1: type-only import (no runtime edge) so this light module never
// imports the x402-nudge leaf — the additive `suggested_x402` is COMPUTED by the caller (index.ts)
// and passed in; this formatter only serializes it.
import type { SuggestedX402 } from '../types.js';

/**
 * Thrown by an exchange adapter when the upstream API returns HTTP 429
 * (or its semantic equivalent). The MCP tool handler catches this specifically
 * and emits a structured response that lets agents auto-fallback to a different
 * exchange instead of giving up.
 */
export class UpstreamRateLimitError extends Error {
  /** Stable machine-readable code. Pin this — clients pattern-match on it. */
  readonly code = 'UPSTREAM_RATE_LIMIT' as const;
  /** Exchange display name (Hyperliquid, Binance, Bybit, OKX, Bitget). */
  readonly exchange: string;
  /** Wall-clock seconds the upstream told us to wait (`Retry-After` header), or null if absent. */
  readonly retryAfterSeconds: number | null;

  constructor(exchange: string, retryAfterSeconds: number | null = null) {
    super(`${exchange} API rate-limited (429); upstream is temporarily refusing requests`);
    this.exchange = exchange;
    this.retryAfterSeconds = retryAfterSeconds;
    // Restore prototype chain for `instanceof` to work after transpile (Node CJS).
    Object.setPrototypeOf(this, UpstreamRateLimitError.prototype);
  }
}

/**
 * Thrown by `getTradeSignal` / `getMarketRegime` when the AlgoVault-canonical
 * TradFi symbol is not listed on the requested CEX. The MCP tool handler
 * emits a structured response with `suggested_venues` so an LLM agent can
 * pattern-match on `error_code === "TRADFI_SYMBOL_UNSUPPORTED_ON_VENUE"`
 * and self-retry against one of the supported venues. Added in
 * TRADFI-SYMBOL-ALIAS-W1 (v1.11.1) after CHANGE-DEFAULT-EXCHANGE-W1's probe
 * surfaced `GOLD/BINANCE → 400 Bad Request` as a confusing raw upstream
 * error.
 */
export class TradFiSymbolUnsupportedOnVenueError extends Error {
  readonly code = 'TRADFI_SYMBOL_UNSUPPORTED_ON_VENUE' as const;
  readonly coin: string;
  readonly requestedExchange: string;
  readonly suggestedVenues: string[];
  readonly probedAt: string;

  constructor(coin: string, requestedExchange: string, suggestedVenues: string[], probedAt: string) {
    super(`${coin} is not listed on ${requestedExchange} as of ${probedAt}. Supported venues for ${coin}: ${suggestedVenues.join(', ')}.`);
    this.coin = coin;
    this.requestedExchange = requestedExchange;
    this.suggestedVenues = suggestedVenues;
    this.probedAt = probedAt;
    Object.setPrototypeOf(this, TradFiSymbolUnsupportedOnVenueError.prototype);
  }
}

/**
 * Thrown by MCP tools when a free-tier caller's `trackCall()` returns
 * `allowed: false` (the in-process monthly counter exceeded `getMonthlyQuota('free') = 100`).
 *
 * Replaces the legacy `throw new Error(getQuotaExhaustedMessage(...))` pattern
 * which surfaced as `{error: 'Free tier limit reached...'}` — an unparseable
 * string. The structured envelope lets clients pattern-match on
 * `error_code === "TIER_LIMIT_REACHED"` and direct the user to the upgrade
 * URL programmatically (badges in IDE plugins, in-chat upgrade buttons, etc).
 *
 * Added in ACTIVATION-PAYWALL-W1 (2026-05-20) as the structural counterpart
 * to `_algovault.tier_warning` (soft + hard quota warnings below 100%).
 *
 * The `suggested_upgrade_url` carries UTM tags (`utm_source=mcp_tool` +
 * `utm_campaign=tier_limit_reached`) so post-Stripe-checkout attribution
 * flows back through `client_reference_id` + `metadata.utm_*` to the
 * `request_log` row written by the `checkout.session.completed` webhook.
 *
 * `retry_after_days` reports the days until calendar-month reset, derived
 * from the in-process `callTrackers.periodStart` in license.ts.
 */
export class TierLimitReachedError extends Error {
  readonly code = 'TIER_LIMIT_REACHED' as const;
  readonly current_usage: number;
  readonly monthly_limit: number;
  readonly tier: string;
  readonly suggested_upgrade_url: string;
  readonly retry_after_days: number;
  /** REFERRAL-INPRODUCT-NUDGE-W1: additive, allow-listed referral hint surfaced in
   *  the tool envelope (agent-relayable). `from: 'limit'`; keyed → own link, keyless
   *  → get-your-link path. NO outcome_*. */
  readonly referral_hint: ReferralHint;
  /** FUNNEL-FIX-AGENT-X402-NUDGE-W1: the canonical tool that hit the wall — lets the envelope
   *  projection derive the tool's `suggested_x402` in-protocol pay-per-call rail. Optional so
   *  every existing throw site stays valid; unset ⇒ no x402 branch. */
  readonly tool?: string;
  /**
   * OPS-QUOTA-EXHAUSTION-NOTICE-W1: the ISO instant access returns. Before this wave the
   * envelope carried only `retry_after_days` — a bare integer, absent from the human message
   * entirely — so a caller learned roughly how long but never WHEN. `retry_after_days` is now
   * COMPUTED from this instant instead of being passed alongside it, so the two cannot disagree.
   */
  readonly resets_at: string;
  /** Structured-error law: one imperative next step, always incl. the wait-for-reset fallback. */
  readonly suggested_action: string;
  /** Epoch ms the meter's period began. camelCase ⇒ NOT a wire field; feeds `noticeContext()`. */
  readonly periodStartMs?: number;
  /** Epoch ms the meter resets. camelCase ⇒ NOT a wire field; `resets_at` is the wire form. */
  readonly resetAtMs: number;
  /** Caller's referral code (keyed) or null. camelCase ⇒ NOT a wire field. */
  readonly referralCode: string | null;
  /**
   * The clock this error was raised against. camelCase ⇒ NOT a wire field.
   *
   * SINGLE-DERIVATION (OPS-AUDIT-REMEDIATION-LOW-W2): the constructor computes
   * `retry_after_days` / `resets_at` from `args.nowMs`, and `buildTierLimitPayload` recomputes
   * them from `noticeContext()`. Until this field existed, `noticeContext()` dropped `nowMs`, so
   * the SECOND derivation silently fell back to `Date.now()` — the error object and its own wire
   * payload could report different values for the same fact, and any injected clock was honoured
   * by one and ignored by the other. Retaining it makes both projections read ONE clock.
   */
  readonly nowMs?: number;

  constructor(args: {
    currentUsage: number;
    monthlyLimit: number;
    tier: string;
    suggestedUpgradeUrl: string;
    /**
     * Epoch ms at which the caller's meter resets — `license.monthResetAtMs()` for the rolling
     * 30-day call meter. REQUIRED: a notice that cannot say when access returns is precisely the
     * defect this wave exists to close, so there is no "omit it" mode.
     */
    resetAtMs: number;
    /** Epoch ms the period began — enables the burn-rate ranking of subscription vs x402. */
    periodStartMs?: number;
    /** Caller's derived referral code (keyed) or null (keyless) — drives the
     *  referral-prominent copy + the structured referral_hint. */
    referralCode?: string | null;
    /** Canonical tool name that hit the quota edge (for `suggested_x402`). */
    tool?: string;
    /** Injectable clock (tests only). */
    nowMs?: number;
  }) {
    // OPS-QUOTA-EXHAUSTION-NOTICE-W1 (was REFERRAL-INPRODUCT-NUDGE-W1 / ACTIVATION-NUDGE-W1):
    // the shared builder is now `quota-notice`, the ONE notice every free-tier surface renders
    // (generator-level — all throw sites inherit it). State-adaptive on `referralCode` (keyed →
    // own link; keyless → get-your-link path). The human MESSAGE carries the BARE
    // upgrade_from=limit URL; the structured `suggested_upgrade_url` keeps the caller's utm_*
    // chain + adds upgrade_from=limit (A2); `referral_hint` is the additive structured field.
    //
    // The x402 arm is NOT known here — `index.ts` derives the live rail at serialization time —
    // so the constructor renders the base notice and `buildTierLimitPayload` re-renders it from
    // the SAME function with the rail attached. One derivation, two call sites.
    const noticeCtx: QuotaNoticeContext = {
      meter: 'calls',
      used: args.currentUsage,
      limit: args.monthlyLimit,
      resetAtMs: args.resetAtMs,
      periodStartMs: args.periodStartMs,
      referralCode: args.referralCode ?? null,
      nowMs: args.nowMs,
    };
    super(buildQuotaNoticeMessage(noticeCtx));
    this.periodStartMs = args.periodStartMs;
    this.resetAtMs = args.resetAtMs;
    this.referralCode = args.referralCode ?? null;
    this.nowMs = args.nowMs;
    this.referral_hint = buildReferralHint({ from: 'limit', code: args.referralCode ?? null });
    this.current_usage = args.currentUsage;
    this.monthly_limit = args.monthlyLimit;
    this.tier = args.tier;
    this.suggested_upgrade_url = args.suggestedUpgradeUrl.includes('upgrade_from=')
      ? args.suggestedUpgradeUrl
      : `${args.suggestedUpgradeUrl}${args.suggestedUpgradeUrl.includes('?') ? '&' : '?'}upgrade_from=limit`;
    const facts = quotaNoticeFacts(noticeCtx);
    this.retry_after_days = facts.retry_after_days;
    this.resets_at = facts.resets_at;
    this.suggested_action = buildQuotaSuggestedAction(noticeCtx);
    this.tool = args.tool;
    Object.setPrototypeOf(this, TierLimitReachedError.prototype);
  }

  /**
   * Rebuild this error's notice context, optionally with the LIVE x402 rail attached.
   *
   * The rail is derived by `index.ts` at serialization time (behind `X402_NUDGE_ENABLED` +
   * the live-rail predicates), which is downstream of the throw. Rather than keeping a second
   * copy of the message, the wire projection re-renders from the SAME builder with the rail —
   * so the prose and the `suggested_x402` field can never disagree about whether a rail exists.
   * That mismatch is exactly what the pre-wave `scan_trade_calls` copy shipped: a hardcoded
   * "or pay per call via x402" that stayed in the text even when no rail was live.
   */
  noticeContext(x402?: SuggestedX402): QuotaNoticeContext {
    return {
      meter: 'calls',
      used: this.current_usage,
      limit: this.monthly_limit,
      resetAtMs: this.resetAtMs,
      periodStartMs: this.periodStartMs,
      referralCode: this.referralCode,
      // SINGLE-DERIVATION: without this, buildTierLimitPayload() re-derives retry_after_days /
      // resets_at from Date.now() instead of the clock the error was raised against.
      nowMs: this.nowMs,
      x402,
    };
  }
}

/** Wire payload for a `TierLimitReachedError` (allow-listed; `suggested_x402` is additive). */
export interface TierLimitPayload {
  code: 'TIER_LIMIT_REACHED';
  error_code: 'TIER_LIMIT_REACHED';
  message: string;
  current_usage: number;
  monthly_limit: number;
  tier: string;
  suggested_upgrade_url: string;
  retry_after_days: number;
  /** OPS-QUOTA-EXHAUSTION-NOTICE-W1: ISO-8601 instant access returns. Additive. */
  resets_at: string;
  /** OPS-QUOTA-EXHAUSTION-NOTICE-W1: `usage/limit` display form, e.g. `"100/100"`. Additive. */
  usage_display: string;
  /** OPS-QUOTA-EXHAUSTION-NOTICE-W1: which path the notice leads with. Additive. */
  recommended_path: 'subscription' | 'x402';
  /** OPS-QUOTA-EXHAUSTION-NOTICE-W1: the structured-error law's `suggested_<action>`. Additive. */
  suggested_action: string;
  referral_hint: ReferralHint;
  /** FUNNEL-FIX-AGENT-X402-NUDGE-W1: additive in-protocol x402 pay-per-call branch. */
  suggested_x402?: SuggestedX402;
}

/**
 * Serialize a `TierLimitReachedError` to its MCP tool-content payload — the EXPORTED allow-list
 * formatter (extracted from the inline index.ts handler per the CLAUDE.md public-shape rule +
 * AC3). `suggested_x402` (FUNNEL-FIX-AGENT-X402-NUDGE-W1) is an ADDITIVE, allow-listed sibling to
 * the intact Stripe (`suggested_upgrade_url`) + `referral_hint` fields — the caller (index.ts)
 * computes it via the x402-nudge leaf behind `X402_NUDGE_ENABLED` and passes it in. Omitted
 * entirely when not provided ⇒ the key set + order is BYTE-IDENTICAL to today (AC3). No internal
 * fields ever leak (allow-list, not deny-list); `outcome_return_pct` is never referenced.
 */
export function buildTierLimitPayload(
  err: TierLimitReachedError,
  opts?: { suggestedX402?: SuggestedX402 },
): TierLimitPayload {
  // OPS-QUOTA-EXHAUSTION-NOTICE-W1: re-render the notice from the SAME builder with the live
  // rail attached, so the prose ranks the two paths using the price the `suggested_x402` field
  // actually advertises. With no rail the context is identical to the constructor's, so the
  // message is byte-identical to `err.message`.
  const ctx = err.noticeContext(opts?.suggestedX402);
  const facts = quotaNoticeFacts(ctx);
  return {
    code: err.code,
    error_code: err.code,
    message: buildQuotaNoticeMessage(ctx),
    current_usage: err.current_usage,
    monthly_limit: err.monthly_limit,
    tier: err.tier,
    suggested_upgrade_url: err.suggested_upgrade_url,
    retry_after_days: facts.retry_after_days,
    resets_at: facts.resets_at,
    usage_display: facts.usage_display,
    recommended_path: facts.recommended_path,
    suggested_action: buildQuotaSuggestedAction(ctx),
    referral_hint: err.referral_hint,
    ...(opts?.suggestedX402 ? { suggested_x402: opts.suggestedX402 } : {}),
  };
}

/**
 * Thrown by `getTradeSignal` / `getMarketRegime` when a (usually newly-listed)
 * symbol has fewer candles at the requested timeframe than the analysis guard
 * requires (e.g. `get_market_regime ANTHROPIC BINANCE 4h` two days post-launch:
 * 12 candles, 30 required). Replaces the legacy
 * `throw new Error("Insufficient candle data ... (got 12, need >= 30)")` —
 * a string agents could not self-recover from — with a structured envelope
 * carrying `suggested_timeframes` (the FINER timeframes that already have
 * enough candles) so an agent can immediately retry. Added in
 * TRADIFI-SIGNAL-HARDENING-W1 (2026-06-04), mirroring the
 * `TRADFI_SYMBOL_UNSUPPORTED_ON_VENUE` structured-error precedent.
 */
export class InsufficientCandlesError extends Error {
  readonly code = 'INSUFFICIENT_CANDLES' as const;
  readonly coin: string;
  readonly exchange: string;
  readonly timeframe: string;
  readonly candlesAvailable: number;
  readonly candlesRequired: number;
  readonly suggestedTimeframes: string[];
  readonly suggestedAction: string;

  constructor(args: {
    coin: string;
    exchange: string;
    timeframe: string;
    candlesAvailable: number;
    candlesRequired: number;
    suggestedTimeframes: string[];
    suggestedAction: string;
  }) {
    super(`${args.coin} on ${args.exchange} ${args.timeframe} has ${args.candlesAvailable} candles; ${args.candlesRequired} required.`);
    this.coin = args.coin;
    this.exchange = args.exchange;
    this.timeframe = args.timeframe;
    this.candlesAvailable = args.candlesAvailable;
    this.candlesRequired = args.candlesRequired;
    this.suggestedTimeframes = args.suggestedTimeframes;
    this.suggestedAction = args.suggestedAction;
    Object.setPrototypeOf(this, InsufficientCandlesError.prototype);
  }
}

/**
 * Serialize an `InsufficientCandlesError` to its MCP tool-content payload.
 * Exported (rather than inlined in the index.ts handler) so the wire shape is
 * unit-testable without booting the MCP server.
 */
export function buildInsufficientCandlesPayload(err: InsufficientCandlesError): {
  error: 'INSUFFICIENT_CANDLES';
  error_code: 'INSUFFICIENT_CANDLES';
  message: string;
  candles_available: number;
  candles_required: number;
  suggested_timeframes: string[];
  suggested_action: string;
} {
  return {
    error: err.code,
    error_code: err.code,
    message: err.message,
    candles_available: err.candlesAvailable,
    candles_required: err.candlesRequired,
    suggested_timeframes: err.suggestedTimeframes,
    suggested_action: err.suggestedAction,
  };
}

/**
 * Map of which exchanges to suggest as fallbacks when one is rate-limited.
 * Used by the MCP tool handler to populate the `suggestion` field of the
 * structured error response.
 */
export const EXCHANGE_FALLBACKS: Record<string, string[]> = {
  Hyperliquid: ['BINANCE', 'BYBIT', 'OKX', 'BITGET'],
  Binance:     ['HL', 'BYBIT', 'OKX', 'BITGET'],
  Bybit:       ['HL', 'BINANCE', 'OKX', 'BITGET'],
  OKX:         ['HL', 'BINANCE', 'BYBIT', 'BITGET'],
  Bitget:      ['HL', 'BINANCE', 'BYBIT', 'OKX'],
};
