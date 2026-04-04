export interface HLCandle {
    t: number;
    T: number;
    s: string;
    i: string;
    o: string;
    c: string;
    h: string;
    l: string;
    v: string;
    n: number;
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
    meta: {
        universe: HLAssetMeta[];
    };
    assetCtxs: HLAssetCtx[];
}
export type HLPredictedFunding = [
    string,
    [
        string,
        {
            fundingRate: string;
            nextFundingTime: number;
        }
    ][]
];
export interface Candle {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    time: number;
}
export type SignalVerdict = 'BUY' | 'SELL' | 'HOLD';
export type EmaCrossDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type RegimeType = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE';
export type TrendStrength = 'STRONG' | 'MODERATE' | 'WEAK';
export type PriceStructure = 'HIGHER_HIGHS' | 'LOWER_LOWS' | 'MIXED';
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
    };
    suggestion: string;
    timestamp: number;
    coin: string;
    timeframe: string;
}
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
    period: {
        from: string;
        to: string;
    };
    overall: {
        winRate: number | null;
        avgReturnPct: number | null;
        sharpeRatio: number | null;
        maxDrawdownPct: number | null;
        profitFactor: number | null;
    };
    bySignalType: Record<string, {
        count: number;
        winRate: number | null;
        avgReturnPct: number | null;
    }>;
    byAsset: Record<string, {
        count: number;
        winRate: number | null;
        avgReturnPct: number | null;
    }>;
    recentSignals: SignalRecord[];
}
export type LicenseTier = 'free' | 'pro';
export interface LicenseInfo {
    tier: LicenseTier;
    key: string | null;
}
//# sourceMappingURL=types.d.ts.map