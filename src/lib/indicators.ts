/**
 * Pure indicator functions — no side effects, no API calls.
 * All operate on arrays of numbers. Return null if insufficient data.
 */

/**
 * Exponential Moving Average.
 * Returns the full EMA series (same length as input, first values use SMA seed).
 */
export function ema(closes: number[], period: number): number[] | null {
  if (closes.length < period) return null;

  const k = 2 / (period + 1);
  const result: number[] = [];

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
export function emaLast(closes: number[], period: number): number | null {
  const series = ema(closes, period);
  if (!series) return null;
  return series[series.length - 1];
}

/**
 * RSI (Wilder's smoothing method).
 * Returns the final RSI value (0–100), or null if insufficient data.
 */
export function rsi(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average gain/loss over first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
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

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Average True Range (ATR).
 * Returns the final ATR value, or null if insufficient data.
 */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): number | null {
  const len = highs.length;
  if (len < period + 1) return null;

  // Compute true ranges
  const trs: number[] = [];
  for (let i = 1; i < len; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
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
export function adx(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): { adx: number; plusDI: number; minusDI: number } | null {
  const len = highs.length;
  // Need period + 1 for TR, then period for smoothing +DM/-DM, then period for DX smoothing
  if (len < 2 * period + 1) return null;

  // Step 1: compute +DM, -DM, TR arrays (from index 1)
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  const trs: number[] = [];

  for (let i = 1; i < len; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
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

  const dxValues: number[] = [];

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
  if (dxValues.length < period) return null;

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
 * Rescaled Range (R/S) Hurst Exponent estimation.
 * Returns a value between 0 and 1:
 *   H > 0.55 = trending/persistent (good for directional signals)
 *   H ≈ 0.50 = random walk (no edge)
 *   H < 0.45 = mean-reverting/choppy (whipsaw territory)
 */
export function hurstExponent(closes: number[], window: number = 100): number | null {
  if (closes.length < window) return null;

  const data = closes.slice(-window);

  // Compute log returns
  const logReturns: number[] = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i - 1] <= 0) return null;
    logReturns.push(Math.log(data[i] / data[i - 1]));
  }

  // R/S analysis across multiple sub-period sizes
  const sizes = [8, 16, 32, 64].filter(s => s <= logReturns.length / 2);
  if (sizes.length < 2) return null;

  const logN: number[] = [];
  const logRS: number[] = [];

  for (const n of sizes) {
    const numBlocks = Math.floor(logReturns.length / n);
    let rsSum = 0;
    let validBlocks = 0;

    for (let b = 0; b < numBlocks; b++) {
      const block = logReturns.slice(b * n, (b + 1) * n);
      const mean = block.reduce((a, v) => a + v, 0) / n;
      const stdDev = Math.sqrt(block.reduce((a, v) => a + (v - mean) ** 2, 0) / n);

      if (stdDev === 0) continue;

      let cumDev = 0;
      let maxCum = -Infinity;
      let minCum = Infinity;
      for (const val of block) {
        cumDev += val - mean;
        if (cumDev > maxCum) maxCum = cumDev;
        if (cumDev < minCum) minCum = cumDev;
      }

      rsSum += (maxCum - minCum) / stdDev;
      validBlocks++;
    }

    if (validBlocks > 0) {
      logN.push(Math.log(n));
      logRS.push(Math.log(rsSum / validBlocks));
    }
  }

  if (logN.length < 2) return null;

  // Linear regression: slope = Hurst exponent
  const cnt = logN.length;
  const sumX = logN.reduce((a, v) => a + v, 0);
  const sumY = logRS.reduce((a, v) => a + v, 0);
  const sumXY = logN.reduce((a, v, i) => a + v * logRS[i], 0);
  const sumX2 = logN.reduce((a, v) => a + v * v, 0);
  const denom = cnt * sumX2 - sumX * sumX;
  if (denom === 0) return null;

  const slope = (cnt * sumXY - sumX * sumY) / denom;
  return Math.max(0, Math.min(1, slope));
}

/**
 * Bollinger Bands. Returns { upper, lower, middle, width } or null.
 */
export function bollingerBands(
  closes: number[],
  period: number = 20,
  stdDevMultiplier: number = 2
): { upper: number; lower: number; middle: number; width: number } | null {
  if (closes.length < period) return null;

  const recent = closes.slice(-period);
  const middle = recent.reduce((a, v) => a + v, 0) / period;
  const variance = recent.reduce((a, v) => a + (v - middle) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = middle + stdDevMultiplier * stdDev;
  const lower = middle - stdDevMultiplier * stdDev;
  const width = middle > 0 ? (upper - lower) / middle : 0;

  return { upper, lower, middle, width };
}

/**
 * Keltner Channel. Middle = EMA(period), bands = middle +/- multiplier * ATR.
 */
export function keltnerChannel(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 20,
  atrMultiplier: number = 1.5
): { upper: number; lower: number; middle: number; width: number } | null {
  const emaVal = emaLast(closes, period);
  const atrVal = atr(highs, lows, closes, period);
  if (emaVal === null || atrVal === null) return null;

  const upper = emaVal + atrMultiplier * atrVal;
  const lower = emaVal - atrMultiplier * atrVal;
  const width = emaVal > 0 ? (upper - lower) / emaVal : 0;

  return { upper, lower, middle: emaVal, width };
}

/**
 * Squeeze detection: BB width < Keltner width = volatility compressed.
 * Returns true if squeeze is active (Bollinger Bands inside Keltner Channel).
 */
export function detectSqueeze(
  highs: number[],
  lows: number[],
  closes: number[],
  bbPeriod: number = 20,
  bbStdDev: number = 2,
  kcPeriod: number = 20,
  kcMultiplier: number = 1.5
): boolean {
  const bb = bollingerBands(closes, bbPeriod, bbStdDev);
  const kc = keltnerChannel(highs, lows, closes, kcPeriod, kcMultiplier);
  if (!bb || !kc) return false;
  return bb.width < kc.width;
}

/**
 * Detect price structure from candle data.
 * Looks at swing highs and lows over the last N candles.
 */
export function detectPriceStructure(
  highs: number[],
  lows: number[],
  lookback: number = 5
): 'HIGHER_HIGHS' | 'LOWER_LOWS' | 'MIXED' {
  if (highs.length < lookback * 2) return 'MIXED';

  // Find swing highs and lows using a simple 3-bar pivot
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = 1; i < highs.length - 1; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i + 1]) {
      swingHighs.push(highs[i]);
    }
    if (lows[i] < lows[i - 1] && lows[i] < lows[i + 1]) {
      swingLows.push(lows[i]);
    }
  }

  if (swingHighs.length < 2 || swingLows.length < 2) return 'MIXED';

  // Compare last few swings
  const recentHighs = swingHighs.slice(-lookback);
  const recentLows = swingLows.slice(-lookback);

  let higherHighCount = 0;
  let lowerLowCount = 0;

  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i] > recentHighs[i - 1]) higherHighCount++;
  }
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i] < recentLows[i - 1]) lowerLowCount++;
  }

  const hhRatio = recentHighs.length > 1 ? higherHighCount / (recentHighs.length - 1) : 0;
  const llRatio = recentLows.length > 1 ? lowerLowCount / (recentLows.length - 1) : 0;

  if (hhRatio > 0.5) return 'HIGHER_HIGHS';
  if (llRatio > 0.5) return 'LOWER_LOWS';
  return 'MIXED';
}
