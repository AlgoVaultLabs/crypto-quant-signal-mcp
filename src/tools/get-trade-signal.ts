import { fetchCandles, fetchMetaAndAssetCtxs } from '../lib/hyperliquid.js';
import { rsi, emaLast, ema } from '../lib/indicators.js';
import { canAccessCoin, canAccessTimeframe, freeGateMessage } from '../lib/license.js';
import { recordSignal } from '../lib/performance-db.js';
import type { TradeSignalResult, SignalVerdict, EmaCrossDirection, RegimeType } from '../types.js';

interface TradeSignalInput {
  coin: string;
  timeframe?: string;
  includeReasoning?: boolean;
}

export async function getTradeSignal(input: TradeSignalInput): Promise<TradeSignalResult> {
  const coin = input.coin.toUpperCase();
  const timeframe = input.timeframe || '1h';
  const includeReasoning = input.includeReasoning !== false;

  // License gate
  if (!canAccessCoin(coin) || !canAccessTimeframe(timeframe)) {
    const msg = freeGateMessage(coin, timeframe);
    throw new Error(msg);
  }

  // Fetch candles (100 candles back)
  const intervalMs = getIntervalMs(timeframe);
  const startTime = Date.now() - 100 * intervalMs;
  const [candles, metaCtx] = await Promise.all([
    fetchCandles(coin, timeframe, startTime),
    fetchMetaAndAssetCtxs(),
  ]);

  if (candles.length < 30) {
    throw new Error(`Insufficient candle data for ${coin} (got ${candles.length}, need >= 30)`);
  }

  // Find asset context
  const assetIdx = metaCtx.meta.universe.findIndex(a => a.name === coin);
  if (assetIdx === -1) {
    throw new Error(`${coin} not found on Hyperliquid`);
  }
  const assetCtx = metaCtx.assetCtxs[assetIdx];

  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];

  // ── Compute indicators ──
  const rsiVal = rsi(closes, 14);
  const ema9Val = emaLast(closes, 9);
  const ema21Val = emaLast(closes, 21);

  // EMA crossover detection
  const ema9Series = ema(closes, 9);
  const ema21Series = ema(closes, 21);
  let emaCross: EmaCrossDirection = 'NEUTRAL';
  if (ema9Series && ema21Series && ema9Series.length >= 2) {
    const len = ema9Series.length;
    const curr9 = ema9Series[len - 1];
    const prev9 = ema9Series[len - 2];
    const curr21 = ema21Series[len - 1];
    const prev21 = ema21Series[len - 2];
    if (!isNaN(curr9) && !isNaN(prev9) && !isNaN(curr21) && !isNaN(prev21)) {
      if (curr9 > curr21 && prev9 <= prev21) emaCross = 'BULLISH'; // golden cross
      else if (curr9 < curr21 && prev9 >= prev21) emaCross = 'BEARISH'; // death cross
      else if (curr9 > curr21) emaCross = 'BULLISH';
      else if (curr9 < curr21) emaCross = 'BEARISH';
    }
  }

  // Funding data
  const fundingRate = parseFloat(assetCtx.funding || '0');
  // Use the rate as-is for now; 24h avg would require historical, approximate with current
  const funding24hAvg = fundingRate; // simplified — same as current for MVP

  // OI change (approximate with prevDayPx for direction)
  const openInterest = parseFloat(assetCtx.openInterest || '0');
  const prevDayPx = parseFloat(assetCtx.prevDayPx || '0');
  const priceChange = prevDayPx > 0 ? (currentPrice - prevDayPx) / prevDayPx : 0;

  // Volume
  const volume24h = parseFloat(assetCtx.dayNtlVlm || '0');
  // Average candle volume from the data
  const avgCandleVol = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  const lastCandleVol = candles[candles.length - 1].volume;

  // ── Score each indicator (-100 to +100) ──

  // RSI score (25% weight)
  let rsiScore = 0;
  if (rsiVal !== null) {
    if (rsiVal < 30) rsiScore = 80;
    else if (rsiVal < 40) rsiScore = 40;
    else if (rsiVal <= 60) rsiScore = 0;
    else if (rsiVal <= 70) rsiScore = -40;
    else rsiScore = -80;
  }

  // EMA cross score (30% weight)
  let emaScore = 0;
  if (emaCross === 'BULLISH') emaScore = 100;
  else if (emaCross === 'BEARISH') emaScore = -100;

  // Funding rate score (20% weight)
  let fundingScore = 0;
  if (fundingRate < 0) fundingScore = 60; // shorts paying longs = bullish
  else if (fundingRate > 0.0005) fundingScore = -60; // high positive = bearish

  // OI score (15% weight)
  let oiScore = 0;
  if (openInterest > 0) {
    if (priceChange > 0) oiScore = 60; // OI + price up = confirmation
    else if (priceChange < 0) oiScore = -40; // OI + price down = divergence
  }

  // Volume multiplier (10% weight but applied as multiplier)
  let volumeMultiplier = 1.0;
  if (avgCandleVol > 0 && lastCandleVol > 1.5 * avgCandleVol) {
    volumeMultiplier = 1.1;
  }

  // Weighted sum
  const rawScore = (rsiScore * 0.25 + emaScore * 0.30 + fundingScore * 0.20 + oiScore * 0.15) * volumeMultiplier;

  // Map to signal
  let signal: SignalVerdict;
  if (rawScore > 25) signal = 'BUY';
  else if (rawScore < -25) signal = 'SELL';
  else signal = 'HOLD';

  const confidence = Math.min(Math.round(Math.abs(rawScore)), 100);

  // Quick regime estimate (simplified — full version in get-market-regime)
  let regime: RegimeType = 'RANGING';
  if (emaCross === 'BULLISH' && rsiVal !== null && rsiVal < 70) regime = 'TRENDING_UP';
  else if (emaCross === 'BEARISH' && rsiVal !== null && rsiVal > 30) regime = 'TRENDING_DOWN';

  // Reasoning
  let reasoning = '';
  if (includeReasoning) {
    const parts: string[] = [];
    if (rsiVal !== null) {
      if (rsiVal < 30) parts.push(`RSI at ${rsiVal.toFixed(1)} suggests oversold conditions.`);
      else if (rsiVal > 70) parts.push(`RSI at ${rsiVal.toFixed(1)} suggests overbought conditions.`);
      else parts.push(`RSI at ${rsiVal.toFixed(1)} is neutral.`);
    }
    if (emaCross === 'BULLISH') parts.push('EMA 9 crossing above EMA 21 confirms bullish momentum.');
    else if (emaCross === 'BEARISH') parts.push('EMA 9 crossing below EMA 21 confirms bearish momentum.');
    if (fundingRate < 0) parts.push('Negative funding rate means shorts are paying longs.');
    else if (fundingRate > 0.0005) parts.push('High positive funding suggests crowded longs.');
    parts.push(`Combined confidence: ${confidence}%.`);
    reasoning = parts.join(' ');
  }

  const result: TradeSignalResult = {
    signal,
    confidence,
    price: currentPrice,
    indicators: {
      rsi: rsiVal !== null ? parseFloat(rsiVal.toFixed(1)) : null,
      ema_cross: emaCross,
      ema_9: ema9Val ?? 0,
      ema_21: ema21Val ?? 0,
      funding_rate: fundingRate,
      funding_24h_avg: funding24hAvg,
      oi_change_pct: parseFloat((priceChange * 100).toFixed(1)),
      volume_24h: volume24h,
    },
    regime,
    reasoning,
    timestamp: Math.floor(Date.now() / 1000),
    coin,
    timeframe,
  };

  // Record for performance tracking
  try {
    recordSignal(coin, signal, confidence, timeframe, currentPrice);
  } catch {
    // Don't fail the tool if db write fails
  }

  return result;
}

function getIntervalMs(tf: string): number {
  const map: Record<string, number> = {
    '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
    '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
    '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
  };
  return map[tf] || 3_600_000;
}
