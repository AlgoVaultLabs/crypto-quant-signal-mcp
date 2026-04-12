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
  funding: number;
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

export type ExchangeId = 'HL' | 'BINANCE' | 'BYBIT' | 'OKX' | 'BITGET';

// ── Signal Types ──

export type SignalVerdict = 'BUY' | 'SELL' | 'HOLD';
export type EmaCrossDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type RegimeType = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE';
export type TrendStrength = 'STRONG' | 'MODERATE' | 'WEAK';
export type PriceStructure = 'HIGHER_HIGHS' | 'LOWER_LOWS' | 'MIXED';
export type CrossVenueFundingSentiment = 'BEARISH_BIAS' | 'NEUTRAL' | 'BULLISH_BIAS';

// ── _algovault Metadata ──

export interface AlgoVaultMeta {
  version: string;
  tool: string;
  compatible_with: string[];
  upgrade_hint?: string;
}

export interface TradeSignalResult {
  signal: SignalVerdict;
  confidence: number;
  price: number;
  indicators: {
    rsi: number | null;
    ema_cross: EmaCrossDirection;
    ema_9: number;
    ema_21: number;
    funding_rate: number;
    funding_24h_avg: number;
    oi_change_pct: number;
    volume_24h: number;
    hurst: number | null;
    funding_z_score: number | null;
    squeeze_active: boolean;
  };
  regime: RegimeType;
  reasoning: string;
  timestamp: number;
  coin: string;
  timeframe: string;
  _algovault: AlgoVaultMeta;
}

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
}

export interface PerformanceStats {
  totalSignals: number;
  period: { from: string; to: string };
  overall: {
    totalSignals: number;
    totalEvaluated: number;
    pfeWinRate: number | null;
  };
  bySignalType: Record<string, { count: number; pfeWinRate: number | null }>;
  byTimeframe: Record<string, { count: number; pfeWinRate: number | null }>;
  byAsset: Record<string, {
    count: number;
    tier: number;
    pfeWinRate: number | null;
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
  recentSignals: Array<{
    coin: string; signal: string; confidence: number;
    timeframe: string; tier: number;
    pfe_return_pct: number | null;
    created_at: number;
  }>;
  methodology: Record<string, unknown>;
}

// ── License Types ──

export type LicenseTier = 'free' | 'starter' | 'pro' | 'enterprise' | 'x402';

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
