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
  getCandles(coin: string, interval: string, startTime: number): Promise<Candle[]>;
  getAssetContext(coin: string): Promise<AssetContext>;
  getPredictedFundings(): Promise<FundingData[]>;
  getCurrentPrice(coin: string): Promise<number | null>;
  getName(): string;
}

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
  };
  regime: RegimeType;
  reasoning: string;
  timestamp: number;
  coin: string;
  timeframe: string;
  _algovault: AlgoVaultMeta;
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
  };
  nextFundingTimes: Record<string, number>;
}

export interface FundingArbResult {
  opportunities: FundingArbOpportunity[];
  scannedPairs: number;
  timestamp: number;
  _algovault: AlgoVaultMeta;
}

export interface MarketRegimeResult {
  regime: RegimeType;
  confidence: number;
  metrics: {
    adx: number | null;
    adx_interpretation: string;
    volatility_ratio: number;
    volatility_interpretation: string;
    price_structure: PriceStructure;
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
  price_after_1h: number | null;
  price_after_4h: number | null;
  price_after_24h: number | null;
  return_pct_1h: number | null;
  return_pct_4h: number | null;
  return_pct_24h: number | null;
  created_at: number;
}

export interface PerformanceStats {
  totalSignals: number;
  period: { from: string; to: string };
  overall: {
    winRate: number | null;
    avgReturnPct: number | null;
    sharpeRatio: number | null;
    maxDrawdownPct: number | null;
    profitFactor: number | null;
  };
  bySignalType: Record<string, { count: number; winRate: number | null; avgReturnPct: number | null }>;
  byAsset: Record<string, { count: number; winRate: number | null; avgReturnPct: number | null }>;
  recentSignals: SignalRecord[];
}

// ── License Types ──

export type LicenseTier = 'free' | 'pro' | 'enterprise' | 'x402';

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
