// ── Hyperliquid API Types ──

export interface HLCandle {
  t: number;   // open time (ms)
  T: number;   // close time (ms)
  s: string;   // symbol
  i: string;   // interval
  o: string;   // open
  c: string;   // close
  h: string;   // high
  l: string;   // low
  v: string;   // volume (base)
  n: number;   // number of trades
}

export interface HLAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx?: string;
  impactPxs?: string[];
}

export interface HLAssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
}

export interface HLMetaAndAssetCtxs {
  meta: { universe: HLAssetMeta[] };
  assetCtxs: HLAssetCtx[];
}

export type HLPredictedFunding = [
  string, // coin name
  [string, { fundingRate: string; nextFundingTime: number }][] // venue entries
];

// ── Indicator Types ──

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time: number;
}

// ── Exchange Adapter Types ──

export type DexType = 'standard' | 'xyz';

export interface AssetContext {
  coin: string;
  /** Raw per-period funding rate as returned by the exchange (HL = 1h, CEX = 8h). Used for display/API output. */
  funding: number;
  /**
   * Annualized funding rate (raw × periods_per_year). Used by the scorer's funding threshold logic so
   * HL 1h and CEX 8h rates are directly comparable as "annualized % cost of carry".
   * HL: funding × 8760 (1h periods per year)
   * Binance/Bybit/OKX/Bitget: funding × 1095 (8h periods per year)
   * (R2 from generator audit 2026-04-14)
   */
  fundingAnnualized: number;
  openInterest: number;
  prevDayPx: number;
  volume24h: number;
  oraclePx: number;
  markPx: number;
}

export interface FundingData {
  coin: string;
  venues: { venue: string; fundingRate: number; nextFundingTime: number }[];
}

export interface ExchangeAdapter {
  getCandles(coin: string, interval: string, startTime: number, dex?: DexType): Promise<Candle[]>;
  getAssetContext(coin: string, dex?: DexType): Promise<AssetContext>;
  getPredictedFundings(): Promise<FundingData[]>;
  getFundingHistory(coin: string, startTime: number): Promise<{ time: number; fundingRate: number }[]>;
  getCurrentPrice(coin: string, dex?: DexType): Promise<number | null>;
  getName(): string;
}

// ── Exchange Types ──

export type ExchangeId = 'HL' | 'BINANCE' | 'BYBIT' | 'OKX' | 'BITGET' | 'ASTER' | 'EDGEX' | 'GATE' | 'MEXC' | 'KUCOIN' | 'PHEMEX' | 'BINGX' | 'HTX' | 'WEEX' | 'BITMART' | 'XT' | 'WHITEBIT';

// ── Venue lifecycle state machine (EXCHANGE-SHADOW-PROMOTE-W1 / C1) ──
// New exchange integrations default to 'shadow', auto-promote via daily cron
// when PFE WR ≥ 0.80 over `asset_count × 10` BUY/SELL signals (HOLDs excluded).
// 'retired' is terminal — used by Mr.1 manual_required Telegram alert path
// (day-30 second-miss). Source of truth: `venues` postgres table.
export type VenueStatus = 'shadow' | 'promoted' | 'retired';

export interface VenueRecord {
  exchange_id: string;
  status: VenueStatus;
  asset_count: number;
  min_buy_sell_sample: number;
  integrated_at: string;          // ISO 8601 (Postgres TIMESTAMPTZ serialized)
  promoted_at: string | null;
  retired_at: string | null;
  extension_count: number;        // 0, 1, or 2 (CHECK constraint on schema)
  last_eval_at: string | null;
  last_eval_pfe_wr: number | null;
  last_eval_buy_sell_count: number | null;
  // OPS-SHADOW-ALERT-HYGIENE-W1 (2026-06-01): nullable clock anchor. The
  // promotion clock derives from COALESCE(seeding_started_at, integrated_at).
  // NULL until OPS-SHADOW-PIPELINE-W1 (C3) stamps the first-signal timestamp.
  seeding_started_at: string | null;  // ISO 8601 | null (Postgres TIMESTAMPTZ)
  notes: string | null;
}

// ── Signal Types ──

export type SignalVerdict = 'BUY' | 'SELL' | 'HOLD';
export type EmaCrossDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type RegimeType = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE';
export type TrendStrength = 'STRONG' | 'MODERATE' | 'WEAK';
export type PriceStructure = 'HIGHER_HIGHS' | 'LOWER_LOWS' | 'MIXED';
export type CrossVenueFundingSentiment = 'BEARISH_BIAS' | 'NEUTRAL' | 'BULLISH_BIAS';

// ── v1.10.0 Output-sanitize bucket enums (re-exported from indicator-buckets.ts for centralization) ──
// Source-of-truth definitions live in src/lib/indicator-buckets.ts where the
// bucketing logic also lives. Re-exported here so consumers importing from
// './types.js' get a one-stop shop for the public response shape.
export type { TrendPersistence, FundingState, BreakoutPending } from './lib/indicator-buckets.js';

// ── _algovault Metadata ──

/**
 * Structured tier-warning surface populated by `withTierWarning()` when a
 * free-tier caller approaches the monthly quota. Added ACTIVATION-PAYWALL-W1.
 *
 * Semantics:
 *  - `level: 'soft'` fires at currentUsage / monthlyLimit >= 0.75 (default).
 *  - `level: 'hard'` fires at >= 0.90 (default). Hard ALWAYS displaces soft.
 *  - Field is OMITTED entirely when below the soft threshold, when tier is
 *    paid (starter/pro/enterprise/x402/internal), or when the caller is
 *    `is_bot_internal=true` (bot service has its own per-user quota).
 *  - At >=1.00 the request hits the `TIER_LIMIT_REACHED` structured error
 *    envelope at the checkQuota block path; this field is NOT present in
 *    that error path (the envelope itself carries the upgrade context).
 *
 * `suggested_upgrade_url` carries UTM tags so post-payment attribution flows
 * through Stripe `client_reference_id` + `metadata.utm_*` back to
 * `request_log` rows for per-channel conversion measurement.
 */
export interface TierWarning {
  level: 'soft' | 'hard';
  current_usage: number;
  monthly_limit: number;
  tier: LicenseTier;
  suggested_upgrade_url: string;
}

export interface AlgoVaultMeta {
  version: string;
  tool: string;
  compatible_with: string[];
  upgrade_hint?: string;
  /**
   * The MCP `mcp-session-id` header extracted at request time, or `null` under
   * stdio transport (stdio has no per-request session). Surfaced in every tool
   * response envelope (v1.9.0, L3 activation patch) so clients can correlate
   * calls to the `agent_sessions` cohort table.
   */
  session_id?: string | null;
  /**
   * The CEX/DEX the request routed to. Added EXCHANGE-SHADOW-PROMOTE-W1 / C2
   * (2026-05-16) to close the CHANGE-DEFAULT-EXCHANGE-W1 AC3 spec drift —
   * agents need to know explicitly which venue served the call when the
   * default-routing layer auto-picks.
   */
  exchange?: ExchangeId;
  /**
   * Lifecycle status of the venue at request time. `'promoted'` for the
   * 5 production-grade venues (HL/BINANCE/BYBIT/OKX/BITGET); `'shadow'` for
   * new venues integrated under the SHADOW-PROMOTE state machine that have
   * not yet met the 80% PFE WR × asset_count×10 BUY/SELL gate. LLM agents
   * SHOULD pattern-match on `venue_status === 'shadow'` to surface
   * "experimental — not yet on public dashboard" caveats to the end-user.
   * Added EXCHANGE-SHADOW-PROMOTE-W1 / C2.
   */
  venue_status?: VenueStatus;
  /**
   * Structured tier-warning surface (ACTIVATION-PAYWALL-W1). See `TierWarning`.
   * Populated by `withTierWarning()` on free-tier callers approaching quota.
   * OMITTED entirely below the soft threshold or for paid/bot-internal tiers.
   */
  tier_warning?: TierWarning;
}

// ── Cross-asset grid (v1.9.0 L2/L4 activation patch) ──

/**
 * A single cell in the pre-computed cross-asset / cross-timeframe signal grid,
 * exposed via `src/lib/cross-asset-grid.ts`. Used by `get_trade_signal` to
 * surface `closest_tradeable` (HOLD rescue, L2) and `try_next` (next-calls
 * hints, L4) as strictly-optional exploration surfaces — NOT recommendations.
 */
export interface GridCell {
  coin: string;
  timeframe: string;
  signal: SignalVerdict;
  confidence: number;
  exchange: ExchangeId;
  regime: RegimeType;
}

/**
 * Trimmed cross-asset leaderboard cell.
 *
 * v1.10.0: introduced as `{coin, timeframe, confidence}` — strips
 * `signal` / `exchange` / `regime` so agents reading `also_see` had to issue
 * a fresh `get_trade_call` to act on the lead.
 *
 * v1.10.8 (BOT-ALERT-IMAGE-W1, 2026-05-08): re-added `exchange` to support
 * the bot's "See Also" surface, where end users want suggestions on the
 * SAME exchange they're already trading on (otherwise the suggestion is
 * unactionable for their account). Direction (`signal` BUY/SELL) is still
 * stripped — that's the actionability seam that drives the second
 * `get_trade_call`.
 */
export interface LeaderboardCell {
  coin: string;
  timeframe: string;
  confidence: number;
  exchange: ExchangeId;
}

export interface TradeCallResult {
  /** v1.10.0 trade-call verdict (BUY/SELL/HOLD). Replaces legacy `signal` field. */
  call: SignalVerdict;
  confidence: number;
  price: number;
  indicators: {
    /** Funding rate (per-period rate, not annualized). */
    funding_rate: number;
    /** 24-hour rolling average funding rate. */
    funding_24h_avg: number;
    /** v1.10.0 bucket: |funding-Z| → NORMAL / ELEVATED / EXTREME. */
    funding_state: import('./lib/indicator-buckets.js').FundingState;
    /** Day-over-day open-interest change percentage. */
    oi_change_pct: number;
    /** 24-hour spot volume in quote currency. */
    volume_24h: number;
    /** v1.10.0 bucket: Hurst exponent → LOW / MEDIUM / HIGH. */
    trend_persistence: import('./lib/indicator-buckets.js').TrendPersistence;
    /** v1.10.0 bucket: BB/Keltner squeeze → INACTIVE / IMMINENT (replaces boolean squeeze_active). */
    breakout_pending: import('./lib/indicator-buckets.js').BreakoutPending;
    /**
     * TRADIFI-SIGNAL-HARDENING-W1: underlying-market session state for the
     * coin's asset class (ALWAYS_OPEN for crypto). Lets agents discount regime
     * reads taken while the underlying cash market is closed.
     */
    underlying_session: import('./lib/market-sessions.js').UnderlyingSessionState;
    /**
     * TRADIFI-SIGNAL-HARDENING-W1: TradFi funding interpretation note. OMITTED
     * for CRYPTO / UNKNOWN (no annotation). Present for EQUITY / KR_EQUITY /
     * COMMODITY / PREMARKET.
     */
    funding_note?: string;
  };
  regime: RegimeType;
  reasoning: string;
  timestamp: number;
  coin: string;
  timeframe: string;
  /**
   * HOLD rescue (v1.9.0 L2; trimmed shape v1.10.0). On a HOLD verdict, the
   * single highest-confidence non-HOLD cell from the cross-asset grid,
   * excluding the requested (coin, timeframe). v1.10.0 SHAPE CHANGE: trimmed
   * from GridCell → LeaderboardCell (`{coin, timeframe, confidence}` only;
   * direction requires another get_trade_call invocation). Omitted entirely
   * when the grid has no non-HOLD cell or when the current verdict is BUY/SELL.
   */
  closest_tradeable?: LeaderboardCell;
  /**
   * Cross-asset high-confidence leads (v1.10.0). Top-3 highest-confidence
   * non-HOLD cells from the cross-asset grid, trimmed to
   * `{coin, timeframe, confidence}` only. The trimmed shape is intentional:
   * agents reading `also_see` see "go look here" pointers; the direction
   * (BUY/SELL) requires another `get_trade_call` invocation. This drives
   * call volume per moat #3 (data flywheel).
   */
  also_see?: LeaderboardCell[];
  _algovault: AlgoVaultMeta;
}

/**
 * @deprecated since v1.10.0 — use `TradeCallResult`. Re-exported as a type
 * alias so existing imports (`import type { TradeSignalResult }`) continue to
 * resolve. Will be removed in v1.11.0 alongside the legacy `signal` / `try_next`
 * fields. The shape is identical.
 */
export type TradeSignalResult = TradeCallResult;

export interface FundingConviction {
  score: number;               // 0-100 composite
  label: 'LOW' | 'MEDIUM' | 'HIGH';
  direction_consistency: number; // % of last 24h with same sign
  magnitude_stability: number;   // inverse of coefficient of variation
  spread_persistence: number;    // % of last 24h where spread > threshold
  sample_hours: number;
}

export interface FundingUrgency {
  score: number;               // 0-100 exponential decay
  label: 'LOW' | 'MEDIUM' | 'HIGH';
  nextCollectionMin: number;   // minutes to nearest funding settlement
  effectiveVenue: string;      // which venue settles first
}

export interface FundingArbOpportunity {
  coin: string;
  rates: Record<string, number>;
  bestArb: {
    longVenue: string;
    shortVenue: string;
    spreadBps: number;
    annualizedPct: number;
    direction: string;
    urgency: FundingUrgency;
    rankScore: number;         // composite: spread + urgency + conviction
  };
  conviction: FundingConviction;
  nextFundingTimes: Record<string, number>;
}

export interface FundingArbResult {
  opportunities: FundingArbOpportunity[];
  scannedPairs: number;
  timestamp: number;
  _algovault: AlgoVaultMeta;
}

export type AdxSlopeCategory = 'RISING' | 'FLAT' | 'FALLING';

export interface MarketRegimeResult {
  regime: RegimeType;
  confidence: number;
  metrics: {
    adx: number | null;
    adx_interpretation: string;
    adx_slope: number | null;
    adx_slope_interpretation: string;
    volatility_ratio: number;
    volatility_interpretation: string;
    price_structure: PriceStructure;
    pivot_quality: number;       // avg significance score of volume-weighted pivots (0-1)
    trend_strength: TrendStrength;
    cross_venue_funding_sentiment: CrossVenueFundingSentiment;
    funding_divergence_note: string;
    /**
     * TRADIFI-SIGNAL-HARDENING-W1: underlying-market session state for the
     * coin's asset class (ALWAYS_OPEN for crypto).
     */
    underlying_session: import('./lib/market-sessions.js').UnderlyingSessionState;
    /**
     * TRADIFI-SIGNAL-HARDENING-W1: session context. OMITTED for ALWAYS_OPEN /
     * OPEN_REGULAR / UNKNOWN; present when the underlying is in extended hours,
     * closed (weekend/holiday), or pre-IPO.
     */
    session_note?: string;
  };
  suggestion: string;
  timestamp: number;
  coin: string;
  timeframe: string;
  _algovault: AlgoVaultMeta;
}

// ── Performance Types ──

export interface SignalRecord {
  id?: number;
  coin: string;
  signal: SignalVerdict;
  confidence: number;
  timeframe: string;
  price_at_signal: number;
  // Legacy per-horizon columns (kept for backward compat, no longer written)
  price_after_15m: number | null;
  price_after_1h: number | null;
  price_after_4h: number | null;
  price_after_24h: number | null;
  return_pct_15m: number | null;
  return_pct_1h: number | null;
  return_pct_4h: number | null;
  return_pct_24h: number | null;
  // v1.3: unified outcome — evaluated at signal's own timeframe only
  outcome_price: number | null;
  outcome_return_pct: number | null;
  // v1.4: Peak Favorable / Maximum Adverse Excursion
  pfe_return_pct: number | null;
  mae_return_pct: number | null;
  pfe_price: number | null;
  mae_price: number | null;
  pfe_candles: number | null;
  // v1.4.1: 1-candle confirmation return
  return_1candle: number | null;
  created_at: number;
  // v1.6: exchange source for multi-venue backfill
  exchange?: string;
}

export interface PerformanceStats {
  /** v1.10.0 canonical key. Was `totalSignals` pre-1.10. */
  totalCalls: number;
  period: { from: string; to: string };
  overall: {
    /** v1.10.0 canonical key. Was `overall.totalSignals` pre-1.10. */
    totalCalls: number;
    totalEvaluated: number;
    pfeWinRate: number | null;
  };
  /** v1.10.0 canonical breakdown by trade-call type (BUY/SELL/HOLD). Was `bySignalType` pre-1.10. */
  byCallType: Record<string, { count: number; evaluated: number; pfeWinRate: number | null }>;
  byTimeframe: Record<string, { count: number; evaluated: number; pfeWinRate: number | null }>;
  byAsset: Record<string, {
    count: number;
    tier: number;
    pfeWinRate: number | null;
  }>;
  /** Per-exchange aggregates for dashboard filtering without client-side recomputation. */
  byExchange: Record<string, {
    exchange: string;
    count: number;
    evaluated: number;
    pfeWinRate: number | null;
    byTimeframe: Record<string, { count: number; evaluated: number; pfeWinRate: number | null }>;
    byTier: Record<string, { count: number; evaluated: number; pfeWinRate: number | null }>;
    byCallType: Record<string, { count: number; evaluated: number; pfeWinRate: number | null }>;
    byAsset: Record<string, { count: number; tier: number; pfeWinRate: number | null }>;
  }>;
  byTier: Record<string, {
    tier: number;
    name: string;
    label: string;
    color: string;
    count: number;
    evaluated: number;
    pfeWinRate: number | null;
    assets: string[];
  }>;
  /**
   * PERFORMANCE-PUBLIC-SANITIZE-W1 (2026-05-15): public-shape contract per
   * `audits/performance-public-shape-snapshot-2026-05-14.json`. `.call`
   * (BUY/SELL/HOLD direction) and `.confidence` (0-100 score) DROPPED — they
   * are the paywalled MCP value. Sanitization happens at the data layer via
   * `formatPublicRecentSignal()` in src/lib/performance-db.ts; this interface
   * pins the output shape so consumers cannot rely on the legacy leakage.
   * For verifying a specific signal's direction + confidence, use the paid
   * /api/verify-signal endpoint (requires API key).
   */
  recentSignals: Array<{
    id: number;
    coin: string;
    timeframe: string;
    tier: number;
    created_at: number;
    exchange: string;
  }>;
  methodology: Record<string, unknown>;
}

// ── License Types ──

// 'internal' added 2026-05-08 (BOT-W1 / D1-C). Used by the AlgoVault Telegram
// bot (algovault-bot) for server-internal calls — bypasses quota counters via
// the X-AlgoVault-Internal-Key header (gated on BOT_INTERNAL_BYPASS_ENABLED).
// Bot-side enforces user-level quota in its own SQLite; signal-MCP only sees
// the bypass and tags request_log.is_bot_internal so attribution is preserved.
export type LicenseTier = 'free' | 'starter' | 'pro' | 'enterprise' | 'x402' | 'internal';

export interface LicenseInfo {
  tier: LicenseTier;
  key: string | null;
}

// ── x402 Types ──

export interface X402ToolPricing {
  get_trade_signal: number;
  scan_funding_arb: number;
  get_market_regime: number;
}
