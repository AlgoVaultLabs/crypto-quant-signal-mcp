"use strict";
/**
 * Pure indicator functions — no side effects, no API calls.
 * All operate on arrays of numbers. Return null if insufficient data.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ema = ema;
exports.emaLast = emaLast;
exports.rsi = rsi;
exports.atr = atr;
exports.adx = adx;
exports.detectPriceStructure = detectPriceStructure;
/**
 * Exponential Moving Average.
 * Returns the full EMA series (same length as input, first values use SMA seed).
 */
function ema(closes, period) {
    if (closes.length < period)
        return null;
    const k = 2 / (period + 1);
    const result = [];
    // SMA seed for the first `period` values
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += closes[i];
        result.push(NaN); // pad until seed is ready
    }
    result[period - 1] = sum / period;
    for (let i = period; i < closes.length; i++) {
        const prev = result[i - 1];
        result.push(closes[i] * k + prev * (1 - k));
    }
    return result;
}
/**
 * Get the last valid EMA value.
 */
function emaLast(closes, period) {
    const series = ema(closes, period);
    if (!series)
        return null;
    return series[series.length - 1];
}
/**
 * RSI (Wilder's smoothing method).
 * Returns the final RSI value (0–100), or null if insufficient data.
 */
function rsi(closes, period = 14) {
    if (closes.length < period + 1)
        return null;
    let avgGain = 0;
    let avgLoss = 0;
    // Initial average gain/loss over first `period` changes
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0)
            avgGain += change;
        else
            avgLoss += Math.abs(change);
    }
    avgGain /= period;
    avgLoss /= period;
    // Wilder's smoothing for remaining data
    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? Math.abs(change) : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0)
        return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}
/**
 * Average True Range (ATR).
 * Returns the final ATR value, or null if insufficient data.
 */
function atr(highs, lows, closes, period = 14) {
    const len = highs.length;
    if (len < period + 1)
        return null;
    // Compute true ranges
    const trs = [];
    for (let i = 1; i < len; i++) {
        const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
        trs.push(tr);
    }
    // Simple average of first `period` TRs
    let atrVal = 0;
    for (let i = 0; i < period; i++) {
        atrVal += trs[i];
    }
    atrVal /= period;
    // Wilder's smoothing for the rest
    for (let i = period; i < trs.length; i++) {
        atrVal = (atrVal * (period - 1) + trs[i]) / period;
    }
    return atrVal;
}
/**
 * Average Directional Index (ADX).
 * Returns { adx, plusDI, minusDI } or null if insufficient data.
 */
function adx(highs, lows, closes, period = 14) {
    const len = highs.length;
    // Need period + 1 for TR, then period for smoothing +DM/-DM, then period for DX smoothing
    if (len < 2 * period + 1)
        return null;
    // Step 1: compute +DM, -DM, TR arrays (from index 1)
    const plusDMs = [];
    const minusDMs = [];
    const trs = [];
    for (let i = 1; i < len; i++) {
        const upMove = highs[i] - highs[i - 1];
        const downMove = lows[i - 1] - lows[i];
        plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
        const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
        trs.push(tr);
    }
    // Step 2: Wilder's smoothing for +DM, -DM, TR (initial sum then smooth)
    let smoothPlusDM = 0;
    let smoothMinusDM = 0;
    let smoothTR = 0;
    for (let i = 0; i < period; i++) {
        smoothPlusDM += plusDMs[i];
        smoothMinusDM += minusDMs[i];
        smoothTR += trs[i];
    }
    const dxValues = [];
    // First DI values
    let plusDI = smoothTR !== 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    let minusDI = smoothTR !== 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    let diSum = plusDI + minusDI;
    dxValues.push(diSum !== 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
    for (let i = period; i < trs.length; i++) {
        smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMs[i];
        smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMs[i];
        smoothTR = smoothTR - smoothTR / period + trs[i];
        plusDI = smoothTR !== 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
        minusDI = smoothTR !== 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
        diSum = plusDI + minusDI;
        dxValues.push(diSum !== 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
    }
    // Step 3: Smooth DX to get ADX (Wilder's smoothing)
    if (dxValues.length < period)
        return null;
    let adxVal = 0;
    for (let i = 0; i < period; i++) {
        adxVal += dxValues[i];
    }
    adxVal /= period;
    for (let i = period; i < dxValues.length; i++) {
        adxVal = (adxVal * (period - 1) + dxValues[i]) / period;
    }
    return { adx: adxVal, plusDI, minusDI };
}
/**
 * Detect price structure from candle data.
 * Looks at swing highs and lows over the last N candles.
 */
function detectPriceStructure(highs, lows, lookback = 5) {
    if (highs.length < lookback * 2)
        return 'MIXED';
    // Find swing highs and lows using a simple 3-bar pivot
    const swingHighs = [];
    const swingLows = [];
    for (let i = 1; i < highs.length - 1; i++) {
        if (highs[i] > highs[i - 1] && highs[i] > highs[i + 1]) {
            swingHighs.push(highs[i]);
        }
        if (lows[i] < lows[i - 1] && lows[i] < lows[i + 1]) {
            swingLows.push(lows[i]);
        }
    }
    if (swingHighs.length < 2 || swingLows.length < 2)
        return 'MIXED';
    // Compare last few swings
    const recentHighs = swingHighs.slice(-lookback);
    const recentLows = swingLows.slice(-lookback);
    let higherHighCount = 0;
    let lowerLowCount = 0;
    for (let i = 1; i < recentHighs.length; i++) {
        if (recentHighs[i] > recentHighs[i - 1])
            higherHighCount++;
    }
    for (let i = 1; i < recentLows.length; i++) {
        if (recentLows[i] < recentLows[i - 1])
            lowerLowCount++;
    }
    const hhRatio = recentHighs.length > 1 ? higherHighCount / (recentHighs.length - 1) : 0;
    const llRatio = recentLows.length > 1 ? lowerLowCount / (recentLows.length - 1) : 0;
    if (hhRatio > 0.5)
        return 'HIGHER_HIGHS';
    if (llRatio > 0.5)
        return 'LOWER_LOWS';
    return 'MIXED';
}
//# sourceMappingURL=indicators.js.map