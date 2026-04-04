/**
 * Pure indicator functions — no side effects, no API calls.
 * All operate on arrays of numbers. Return null if insufficient data.
 */
/**
 * Exponential Moving Average.
 * Returns the full EMA series (same length as input, first values use SMA seed).
 */
export declare function ema(closes: number[], period: number): number[] | null;
/**
 * Get the last valid EMA value.
 */
export declare function emaLast(closes: number[], period: number): number | null;
/**
 * RSI (Wilder's smoothing method).
 * Returns the final RSI value (0–100), or null if insufficient data.
 */
export declare function rsi(closes: number[], period?: number): number | null;
/**
 * Average True Range (ATR).
 * Returns the final ATR value, or null if insufficient data.
 */
export declare function atr(highs: number[], lows: number[], closes: number[], period?: number): number | null;
/**
 * Average Directional Index (ADX).
 * Returns { adx, plusDI, minusDI } or null if insufficient data.
 */
export declare function adx(highs: number[], lows: number[], closes: number[], period?: number): {
    adx: number;
    plusDI: number;
    minusDI: number;
} | null;
/**
 * Detect price structure from candle data.
 * Looks at swing highs and lows over the last N candles.
 */
export declare function detectPriceStructure(highs: number[], lows: number[], lookback?: number): 'HIGHER_HIGHS' | 'LOWER_LOWS' | 'MIXED';
//# sourceMappingURL=indicators.d.ts.map