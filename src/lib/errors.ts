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

  constructor(args: {
    currentUsage: number;
    monthlyLimit: number;
    tier: string;
    suggestedUpgradeUrl: string;
    retryAfterDays: number;
  }) {
    super(`Free-tier monthly limit reached (${args.currentUsage}/${args.monthlyLimit} calls). Upgrade for unlimited access: ${args.suggestedUpgradeUrl}`);
    this.current_usage = args.currentUsage;
    this.monthly_limit = args.monthlyLimit;
    this.tier = args.tier;
    this.suggested_upgrade_url = args.suggestedUpgradeUrl;
    this.retry_after_days = args.retryAfterDays;
    Object.setPrototypeOf(this, TierLimitReachedError.prototype);
  }
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
