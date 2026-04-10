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
 * Average Directional Index (ADX) with slope analysis.
 * Returns { adx, plusDI, minusDI, adxSlope } or null if insufficient data.
 *
 * adxSlope is the linear regression slope over the last `slopeLen` ADX values.
 *   slope > +0.5  → trend strengthening (RISING)
 *   slope between -0.5 and +0.5 → steady (FLAT)
 *   slope < -0.5  → trend exhausting (FALLING)
 */
export function adx(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14,
  slopeLen: number = 5
): { adx: number; plusDI: number; minusDI: number; adxSlope: number } | null {
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

  // Step 3: Smooth DX to get ADX (Wilder's smoothing), storing recent values for slope
  if (dxValues.length < period) return null;

  let adxVal = 0;
  for (let i = 0; i < period; i++) {
    adxVal += dxValues[i];
  }
  adxVal /= period;

  // Store ADX history for slope computation (keep last slopeLen + 1 values)
  const adxHistory: number[] = [adxVal];

  for (let i = period; i < dxValues.length; i++) {
    adxVal = (adxVal * (period - 1) + dxValues[i]) / period;
    adxHistory.push(adxVal);
    // Only keep what we need for slope
    if (adxHistory.length > slopeLen + 1) adxHistory.shift();
  }

  // Step 4: Compute ADX slope via linear regression over recent values
  const adxSlope = linearRegressionSlope(adxHistory);

  return { adx: adxVal, plusDI, minusDI, adxSlope };
}

/**
 * Linear regression slope over an array of values.
 * x = 0, 1, 2, ... n-1;  y = values.
 * Returns the slope (change per bar).
 */
function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  // Precomputed sums for x = 0..n-1
  const sumX = (n * (n - 1)) / 2;
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  let sumY = 0;
  let sumXY = 0;

  for (let i = 0; i < n; i++) {
    sumY += values[i];
    sumXY += i * values[i];
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;

  return (n * sumXY - sumX * sumY) / denom;
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

export interface PriceStructureResult {
  structure: 'HIGHER_HIGHS' | 'LOWER_LOWS' | 'MIXED';
  pivotCount: number;      // how many qualified pivots were found
  avgPivotScore: number;   // average significance score of accepted pivots (0-1)
}

/**
 * Volume-weighted price structure detection.
 * Uses 3-bar pivots filtered by volume confirmation, close proximity, and swing magnitude.
 *
 * Each pivot gets a significance score:
 *   40% relative volume (bar volume / 20-SMA volume)
 *   30% close proximity (how close the close is to the swing extreme)
 *   30% swing magnitude (% move from surrounding closes, normalized by ATR)
 *
 * Pivots with score < 0.4 are filtered out (likely wick noise).
 * Falls back to close-based pivots if too few qualify (thin alts).
 */
export function detectPriceStructure(
  highs: number[],
  lows: number[],
  closes?: number[],
  volumes?: number[],
  lookback: number = 5
): PriceStructureResult {
  const mixed: PriceStructureResult = { structure: 'MIXED', pivotCount: 0, avgPivotScore: 0 };
  if (highs.length < lookback * 2) return mixed;

  const hasVolume = volumes && volumes.length === highs.length && closes && closes.length === highs.length;

  if (!hasVolume) {
    // Legacy path: no volume data, use original simple detection
    return detectPriceStructureSimple(highs, lows, lookback);
  }

  // Compute 20-period volume SMA at each bar (rolling)
  const volSma = rollingMean(volumes!, 20);

  // Compute ATR-based minimum magnitude threshold (adaptive per-asset)
  const atrProxy = computeSimpleAtr(highs, lows, closes!, 14);

  // Score and collect pivots
  interface ScoredPivot { price: number; score: number; }
  const swingHighs: ScoredPivot[] = [];
  const swingLows: ScoredPivot[] = [];

  for (let i = 1; i < highs.length - 1; i++) {
    const barRange = highs[i] - lows[i];
    if (barRange <= 0) continue;

    // Check 3-bar pivot geometry
    const isSwingHigh = highs[i] > highs[i - 1] && highs[i] > highs[i + 1];
    const isSwingLow = lows[i] < lows[i - 1] && lows[i] < lows[i + 1];
    if (!isSwingHigh && !isSwingLow) continue;

    // Factor 1: Relative volume (0-1 capped at 2x)
    const avgVol = volSma[i] || 1;
    const relVol = Math.min(volumes![i] / avgVol, 2.0) / 2.0; // normalize 0-1

    if (isSwingHigh) {
      // Factor 2: Close proximity to high (1.0 = close at high, 0.0 = close at low)
      const closeProx = (closes![i] - lows[i]) / barRange;
      // Factor 3: Magnitude — how far the high extends above surrounding closes
      const refPrice = Math.max(closes![i - 1], closes![i + 1]);
      const magnitude = atrProxy > 0
        ? Math.min((highs[i] - refPrice) / atrProxy, 1.5) / 1.5 // normalize 0-1
        : 0.5;

      const score = relVol * 0.4 + closeProx * 0.3 + magnitude * 0.3;
      if (score >= 0.4) swingHighs.push({ price: highs[i], score });
    }

    if (isSwingLow) {
      // Factor 2: Close proximity to low (1.0 = close at low, 0.0 = close at high)
      const closeProx = (highs[i] - closes![i]) / barRange;
      // Factor 3: Magnitude — how far the low extends below surrounding closes
      const refPrice = Math.min(closes![i - 1], closes![i + 1]);
      const magnitude = atrProxy > 0
        ? Math.min((refPrice - lows[i]) / atrProxy, 1.5) / 1.5
        : 0.5;

      const score = relVol * 0.4 + closeProx * 0.3 + magnitude * 0.3;
      if (score >= 0.4) swingLows.push({ price: lows[i], score });
    }
  }

  // Fallback: if volume filtering was too aggressive, use close-based pivots
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return detectPriceStructureSimple(highs, lows, lookback);
  }

  // Compare last few swings (weighted by score is implicit — low-score pivots already filtered)
  const recentHighs = swingHighs.slice(-lookback);
  const recentLows = swingLows.slice(-lookback);

  let higherHighCount = 0;
  let lowerLowCount = 0;

  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i].price > recentHighs[i - 1].price) higherHighCount++;
  }
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i].price < recentLows[i - 1].price) lowerLowCount++;
  }

  const hhRatio = recentHighs.length > 1 ? higherHighCount / (recentHighs.length - 1) : 0;
  const llRatio = recentLows.length > 1 ? lowerLowCount / (recentLows.length - 1) : 0;

  const allPivots = [...swingHighs, ...swingLows];
  const avgScore = allPivots.reduce((s, p) => s + p.score, 0) / allPivots.length;

  let structure: 'HIGHER_HIGHS' | 'LOWER_LOWS' | 'MIXED' = 'MIXED';
  if (hhRatio > 0.5) structure = 'HIGHER_HIGHS';
  else if (llRatio > 0.5) structure = 'LOWER_LOWS';

  return { structure, pivotCount: allPivots.length, avgPivotScore: parseFloat(avgScore.toFixed(3)) };
}

/** Original simple structure detection — fallback when no volume data */
function detectPriceStructureSimple(
  highs: number[],
  lows: number[],
  lookback: number
): PriceStructureResult {
  const swingHighs: number[] = [];
  const swingLows: number[] = [];

  for (let i = 1; i < highs.length - 1; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i + 1]) swingHighs.push(highs[i]);
    if (lows[i] < lows[i - 1] && lows[i] < lows[i + 1]) swingLows.push(lows[i]);
  }

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { structure: 'MIXED', pivotCount: 0, avgPivotScore: 0 };
  }

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
  const pivotCount = swingHighs.length + swingLows.length;

  let structure: 'HIGHER_HIGHS' | 'LOWER_LOWS' | 'MIXED' = 'MIXED';
  if (hhRatio > 0.5) structure = 'HIGHER_HIGHS';
  else if (llRatio > 0.5) structure = 'LOWER_LOWS';

  return { structure, pivotCount, avgPivotScore: 0 };
}

/** Rolling mean (SMA) at each index. Returns array same length as input. */
function rollingMean(values: number[], window: number): number[] {
  const result: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    const count = Math.min(i + 1, window);
    result.push(sum / count);
  }
  return result;
}

/** Simple ATR proxy (average true range) for magnitude normalization */
function computeSimpleAtr(highs: number[], lows: number[], closes: number[], period: number): number {
  if (highs.length < period + 1) return 0;
  let sum = 0;
  const start = highs.length - period;
  for (let i = start; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      i > 0 ? Math.abs(highs[i] - closes[i - 1]) : 0,
      i > 0 ? Math.abs(lows[i] - closes[i - 1]) : 0
    );
    sum += tr;
  }
  return sum / period;
}
