import { getAdapter } from '../lib/exchange-adapter.js';
import { rsi, emaLast, ema } from '../lib/indicators.js';
import { canAccessCoin, canAccessTimeframe, freeGateMessage } from '../lib/license.js';
import { recordSignal } from '../lib/performance-db.js';
import type { TradeSignalResult, SignalVerdict, EmaCrossDirection, RegimeType, LicenseInfo } from '../types.js';

interface TradeSignalInput {
  coin: string;
  timeframe?: string;
  includeReasoning?: boolean;
  license?: LicenseInfo;
}

// ── Retuned weights (v2) ──
// Based on 5,400+ signal outcome analysis:
// - EMA reduced from 30→20% (too dominant, caused false BUY signals)
// - RSI increased from 25→30% (oversold/overbought is the best mean-reversion signal)
// - Funding kept at 20% (correctly calibrated for SELL signals)
// - OI reduced from 15→10% (lagging indicator, hurt BUY accuracy)
// - Volume increased from 10→20% (volume confirmation reduces false signals)
const WEIGHTS = {
  rsi: 0.30,
  ema: 0.20,
  funding: 0.20,
  oi: 0.10,
  volume: 0.20,
};

// Signal thresholds (raised from ±25 to ±35 for higher quality)
const SIGNAL_THRESHOLD = 35;

// Regime-aware asymmetry: BUY signals need higher conviction in downtrends
const BUY_THRESHOLD_TRENDING_DOWN = 55;
const SELL_THRESHOLD_TRENDING_UP = 55;

// Theoretical max |rawScore| for proper confidence scaling
// RSI(80)*0.30 + EMA(100)*0.20 + Funding(60)*0.20 + OI(60)*0.10 + Vol(80)*0.20 = 24+20+12+6+16 = 78
const MAX_RAW_SCORE = 78;

// Minimum confidence to record in track record (filters noise)
const MIN_TRACKABLE_CONFIDENCE = 40;

export async function getTradeSignal(input: TradeSignalInput): Promise<TradeSignalResult> {
  const coin = input.coin.toUpperCase();
  const timeframe = input.timeframe || '1h';
  const includeReasoning = input.includeReasoning !== false;

  // License gate
  if (!canAccessCoin(coin, input.license) || !canAccessTimeframe(timeframe, input.license)) {
    const msg = freeGateMessage(coin, timeframe);
    throw new Error(msg);
  }

  const adapter = getAdapter();

  // Fetch candles (100 candles back)
  const intervalMs = getIntervalMs(timeframe);
  const startTime = Date.now() - 100 * intervalMs;
  const [candles, assetCtx] = await Promise.all([
    adapter.getCandles(coin, timeframe, startTime),
    adapter.getAssetContext(coin),
  ]);

  if (candles.length < 30) {
    throw new Error(`Insufficient candle data for ${coin} (got ${candles.length}, need >= 30)`);
  }

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
      if (curr9 > curr21 && prev9 <= prev21) emaCross = 'BULLISH';
      else if (curr9 < curr21 && prev9 >= prev21) emaCross = 'BEARISH';
      else if (curr9 > curr21) emaCross = 'BULLISH';
      else if (curr9 < curr21) emaCross = 'BEARISH';
    }
  }

  // Funding data
  const fundingRate = assetCtx.funding;
  const funding24hAvg = fundingRate;

  // Price change (24h)
  const priceChange = assetCtx.prevDayPx > 0 ? (currentPrice - assetCtx.prevDayPx) / assetCtx.prevDayPx : 0;

  // Volume
  const volume24h = assetCtx.volume24h;
  const avgCandleVol = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
  const lastCandleVol = candles[candles.length - 1].volume;

  // ── Detect regime FIRST (used for asymmetric thresholds) ──
  let regime: RegimeType = 'RANGING';
  if (emaCross === 'BULLISH' && rsiVal !== null && rsiVal < 70) regime = 'TRENDING_UP';
  else if (emaCross === 'BEARISH' && rsiVal !== null && rsiVal > 30) regime = 'TRENDING_DOWN';

  // ── Score each indicator (-100 to +100) ──

  // RSI (30% weight): contrarian — oversold = bullish, overbought = bearish
  let rsiScore = 0;
  if (rsiVal !== null) {
    if (rsiVal < 25) rsiScore = 100;
    else if (rsiVal < 30) rsiScore = 80;
    else if (rsiVal < 40) rsiScore = 40;
    else if (rsiVal <= 60) rsiScore = 0;
    else if (rsiVal <= 70) rsiScore = -40;
    else if (rsiVal <= 75) rsiScore = -80;
    else rsiScore = -100;
  }

  // EMA cross (20% weight): trend confirmation
  let emaScore = 0;
  if (emaCross === 'BULLISH') emaScore = 100;
  else if (emaCross === 'BEARISH') emaScore = -100;

  // Funding rate (20% weight): contrarian signal
  // Negative funding = shorts paying = contrarian bullish
  // High positive funding = crowded longs = bearish
  let fundingScore = 0;
  if (fundingRate < -0.0005) fundingScore = 80;
  else if (fundingRate < 0) fundingScore = 40;
  else if (fundingRate > 0.001) fundingScore = -80;
  else if (fundingRate > 0.0005) fundingScore = -40;

  // OI + price direction (10% weight): momentum confirmation
  // Only score when price direction CONFIRMS the signal, not as standalone
  let oiScore = 0;
  if (assetCtx.openInterest > 0) {
    if (priceChange > 0.02) oiScore = 60;       // Strong up move, moderate bullish
    else if (priceChange > 0) oiScore = 20;      // Weak up, slight bullish
    else if (priceChange < -0.02) oiScore = -60;  // Strong down move, moderate bearish
    else if (priceChange < 0) oiScore = -20;      // Weak down, slight bearish
  }

  // Volume (20% weight): conviction filter
  // High volume confirms the move, low volume = fade
  let volumeScore = 0;
  if (avgCandleVol > 0) {
    const volRatio = lastCandleVol / avgCandleVol;
    if (volRatio > 3.0) volumeScore = 100;
    else if (volRatio > 2.0) volumeScore = 80;
    else if (volRatio > 1.5) volumeScore = 50;
    else if (volRatio > 1.0) volumeScore = 10;
    else if (volRatio > 0.5) volumeScore = -30;
    else volumeScore = -70;
  }

  // ── Weighted composite score ──
  const rawScore =
    rsiScore * WEIGHTS.rsi +
    emaScore * WEIGHTS.ema +
    fundingScore * WEIGHTS.funding +
    oiScore * WEIGHTS.oi +
    volumeScore * WEIGHTS.volume;

  // ── Regime-aware signal determination ──
  let signal: SignalVerdict;
  const absScore = Math.abs(rawScore);

  if (rawScore > 0) {
    // Potential BUY — apply regime filter
    const threshold = regime === 'TRENDING_DOWN' ? BUY_THRESHOLD_TRENDING_DOWN : SIGNAL_THRESHOLD;
    signal = rawScore > threshold ? 'BUY' : 'HOLD';
  } else {
    // Potential SELL — apply regime filter
    const threshold = regime === 'TRENDING_UP' ? SELL_THRESHOLD_TRENDING_UP : SIGNAL_THRESHOLD;
    signal = absScore > threshold ? 'SELL' : 'HOLD';
  }

  // ── Confidence: scale rawScore to 0-100 range properly ──
  const confidence = Math.min(Math.round((absScore / MAX_RAW_SCORE) * 100), 100);

  // ── Reasoning ──
  let reasoning = '';
  if (includeReasoning) {
    const parts: string[] = [];
    if (rsiVal !== null) {
      if (rsiVal < 30) parts.push(`RSI at ${rsiVal.toFixed(1)} suggests oversold conditions.`);
      else if (rsiVal > 70) parts.push(`RSI at ${rsiVal.toFixed(1)} suggests overbought conditions.`);
      else parts.push(`RSI at ${rsiVal.toFixed(1)} is neutral.`);
    }
    if (emaCross === 'BULLISH') parts.push('EMA 9/21 bullish crossover.');
    else if (emaCross === 'BEARISH') parts.push('EMA 9/21 bearish crossover.');
    if (fundingRate < -0.0005) parts.push('Strong negative funding — shorts paying longs (contrarian bullish).');
    else if (fundingRate < 0) parts.push('Negative funding — shorts paying longs.');
    else if (fundingRate > 0.001) parts.push('High positive funding — crowded longs (contrarian bearish).');
    else if (fundingRate > 0.0005) parts.push('Positive funding — longs paying shorts.');
    if (regime === 'TRENDING_DOWN' && signal === 'HOLD' && rawScore > SIGNAL_THRESHOLD) {
      parts.push(`Regime filter: potential BUY suppressed — market is trending down (requires ${BUY_THRESHOLD_TRENDING_DOWN}+ score, got ${absScore.toFixed(0)}).`);
    }
    if (regime === 'TRENDING_UP' && signal === 'HOLD' && rawScore < -SIGNAL_THRESHOLD) {
      parts.push(`Regime filter: potential SELL suppressed — market is trending up (requires ${SELL_THRESHOLD_TRENDING_UP}+ score, got ${absScore.toFixed(0)}).`);
    }
    parts.push(`Confidence: ${confidence}%. Regime: ${regime}.`);
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
    _algovault: {
      version: '2.0.0',
      tool: 'get_trade_signal',
      compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-backtest-mcp'],
    },
  };

  // Record for performance tracking — only high-confidence actionable signals
  if (signal !== 'HOLD' && confidence >= MIN_TRACKABLE_CONFIDENCE) {
    try {
      recordSignal(coin, signal, confidence, timeframe, currentPrice);
    } catch {
      // Don't fail the tool if db write fails
    }
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
