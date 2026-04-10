import { getAdapter } from '../lib/exchange-adapter.js';
import { rsi, emaLast, ema, hurstExponent, detectSqueeze } from '../lib/indicators.js';
import { canAccessCoin, canAccessTimeframe, freeGateMessage } from '../lib/license.js';
import { recordSignal, recordFunding, getFundingZScore } from '../lib/performance-db.js';
import { getDexForCoin, classifyAsset, isMemeCoinLiquid } from '../lib/asset-tiers.js';
import type { TradeSignalResult, SignalVerdict, EmaCrossDirection, RegimeType, LicenseInfo } from '../types.js';

interface TradeSignalInput {
  coin: string;
  timeframe?: string;
  includeReasoning?: boolean;
  license?: LicenseInfo;
}

// ── Indicator weights (v1.5) ──
// Rebalanced from PFE/MAE analysis: EMA was too dominant (death cross = -20 pts),
// causing 97% SELL bias. Halved EMA, redistributed to funding (cross-venue edge) and OI.
// - RSI 30% (best mean-reversion signal — unchanged)
// - EMA 10% (halved — was too persistent, single death cross dominated scoring)
// - Funding 25% (increased — cross-venue edge, Moat Layer 4)
// - OI 15% (increased — real-time directional confirmation)
// - Volume 20% (conviction filter — unchanged)
const WEIGHTS = {
  rsi: 0.30,
  ema: 0.10,
  funding: 0.25,
  oi: 0.15,
  volume: 0.20,
};

// v1.5: Symmetric signal thresholds — both directions require equal conviction
const BUY_BASE_THRESHOLD = 40;
const SELL_BASE_THRESHOLD = 40;

// Regime-aware gates: require higher conviction when trading against the regime
const BUY_THRESHOLD_GATED = 55;   // BUY in TRENDING_DOWN
const SELL_THRESHOLD_GATED = 55;   // SELL in TRENDING_UP or RANGING

// Theoretical max |rawScore| for proper confidence scaling
// RSI(80)*0.30 + EMA(100)*0.10 + Funding(60)*0.25 + OI(60)*0.15 + Vol(80)*0.20 = 24+10+15+9+16 = 74
const MAX_RAW_SCORE = 74;

// Minimum confidence to record in track record (filters noise)
const MIN_TRACKABLE_CONFIDENCE = 60;

export async function getTradeSignal(input: TradeSignalInput): Promise<TradeSignalResult> {
  const coin = input.coin.toUpperCase();
  const timeframe = input.timeframe || '1h';
  const includeReasoning = input.includeReasoning !== false;

  // License gate
  if (!canAccessCoin(coin, input.license) || !canAccessTimeframe(timeframe, input.license)) {
    const msg = freeGateMessage(coin, timeframe);
    throw new Error(msg);
  }

  // Determine which HL dex this coin trades on (standard vs xyz/TradFi)
  const dex = getDexForCoin(coin);

  // Meme coin liquidity gate — reject illiquid micro-caps before wasting API calls
  const tier = classifyAsset(coin, null);
  if (tier === 4) {
    const liquid = await isMemeCoinLiquid(coin);
    if (!liquid) {
      throw new Error(
        `Signal generation unavailable for ${coin}: insufficient liquidity (not in top 50 by OI and <$10M 24h volume). ` +
        `TA signals are unreliable for illiquid micro-caps.`
      );
    }
  }

  const adapter = getAdapter();

  // Fetch candles (100 candles back)
  const intervalMs = getIntervalMs(timeframe);
  const startTime = Date.now() - 100 * intervalMs;
  const [candles, assetCtx] = await Promise.all([
    adapter.getCandles(coin, timeframe, startTime, dex),
    adapter.getAssetContext(coin, dex),
  ]);

  if (candles.length < 30) {
    throw new Error(`Insufficient candle data for ${coin} (got ${candles.length}, need >= 30)`);
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
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

  // ── v1.4 indicators ──
  const hurstVal = hurstExponent(closes);
  const squeezeActive = detectSqueeze(highs, lows, closes);

  // Record funding for Z-Score history (fire-and-forget)
  try { recordFunding(coin, fundingRate); } catch { /* ignore */ }
  // Fetch Z-Score (async — may return null if < 20 data points)
  let fundingZScore: number | null = null;
  try { fundingZScore = await getFundingZScore(coin, fundingRate); } catch { /* ignore */ }

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

  // EMA cross (10% weight): trend confirmation
  let emaScore = 0;
  if (emaCross === 'BULLISH') emaScore = 100;
  else if (emaCross === 'BEARISH') emaScore = -100;

  // Funding rate (25% weight): contrarian signal
  // Negative funding = shorts paying = contrarian bullish
  // High positive funding = crowded longs = bearish
  let fundingScore = 0;
  if (fundingRate < -0.0005) fundingScore = 80;
  else if (fundingRate < 0) fundingScore = 40;
  else if (fundingRate > 0.001) fundingScore = -80;
  else if (fundingRate > 0.0005) fundingScore = -40;

  // OI + price direction (15% weight): momentum confirmation
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
  let rawScore =
    rsiScore * WEIGHTS.rsi +
    emaScore * WEIGHTS.ema +
    fundingScore * WEIGHTS.funding +
    oiScore * WEIGHTS.oi +
    volumeScore * WEIGHTS.volume;

  // ── Funding Z-Score gate (v1.4 — replaces raw funding confirmation gate) ──
  const scoreAdjustments: string[] = [];
  if (fundingZScore !== null) {
    // Z-Score available: use statistical extremity for crowd-positioning gate
    if (rawScore > 0 && fundingZScore > 2.0) {
      rawScore -= 20;
      scoreAdjustments.push(`Funding Z-Score ${fundingZScore.toFixed(2)} (>+2.0) — extreme crowded longs. BUY penalized 20 pts.`);
    }
    if (rawScore < 0 && fundingZScore < -2.5) {
      rawScore += 20;
      scoreAdjustments.push(`Funding Z-Score ${fundingZScore.toFixed(2)} (<-2.5) — extreme short crowding. SELL softened 20 pts.`);
    }
    if (rawScore > 0 && fundingZScore < -1.5) {
      rawScore += 10;
      scoreAdjustments.push(`Funding Z-Score ${fundingZScore.toFixed(2)} (<-1.5) — contrarian bullish. BUY bonus +10 pts.`);
    }
  } else {
    // Fallback: raw funding gate (pre-Z-Score history)
    if (rawScore > 0 && fundingRate > 0) {
      rawScore -= 15;
      scoreAdjustments.push(`Funding rate positive (${(fundingRate * 100).toFixed(4)}%) — longs crowded. BUY penalized 15 pts (raw fallback).`);
    }
    if (rawScore > 0 && fundingRate < -0.0005) {
      rawScore += 10;
      scoreAdjustments.push(`Funding strongly negative (${(fundingRate * 100).toFixed(4)}%) — contrarian BUY bonus +10 pts (raw fallback).`);
    }
  }

  // ── Hurst filter (v1.4 — penalize choppy markets, reward trending) ──
  if (hurstVal !== null) {
    if (hurstVal < 0.45) {
      rawScore = rawScore > 0 ? rawScore - 25 : rawScore + 25;
      scoreAdjustments.push(`Hurst ${hurstVal.toFixed(3)} (<0.45) — mean-reverting/choppy regime. Directional signal penalized 25 pts.`);
    } else if (hurstVal > 0.55) {
      rawScore = rawScore > 0 ? rawScore + 10 : rawScore - 10;
      scoreAdjustments.push(`Hurst ${hurstVal.toFixed(3)} (>0.55) — trending/persistent. Directional signal boosted 10 pts.`);
    }
  }

  // ── Squeeze detection (v1.4 — boost conviction when volatility is compressed) ──
  if (squeezeActive && Math.abs(rawScore) > 10) {
    rawScore = rawScore > 0 ? rawScore + 12 : rawScore - 12;
    scoreAdjustments.push(`Volatility squeeze detected (BB inside KC). Breakout setup — directional signal boosted 12 pts.`);
  }

  // ── Regime-aware signal determination (v1.5: symmetric thresholds + symmetric regime gates) ──
  let signal: SignalVerdict;
  const absScore = Math.abs(rawScore);

  if (rawScore > 0) {
    // Potential BUY — gated in TRENDING_DOWN (requires stronger conviction)
    const threshold = regime === 'TRENDING_DOWN' ? BUY_THRESHOLD_GATED : BUY_BASE_THRESHOLD;
    signal = rawScore > threshold ? 'BUY' : 'HOLD';
  } else {
    // Potential SELL — gated in TRENDING_UP and RANGING (requires stronger conviction)
    const threshold = (regime === 'TRENDING_UP' || regime === 'RANGING') ? SELL_THRESHOLD_GATED : SELL_BASE_THRESHOLD;
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
    // v1.4 scoring adjustments (Z-Score gate, Hurst filter, squeeze)
    parts.push(...scoreAdjustments);
    if (hurstVal !== null) {
      parts.push(`Hurst exponent: ${hurstVal.toFixed(3)} (${hurstVal > 0.55 ? 'trending' : hurstVal < 0.45 ? 'mean-reverting' : 'random walk'}).`);
    }
    if (squeezeActive) {
      parts.push('Bollinger/Keltner squeeze active — volatility compressed, breakout imminent.');
    }
    if (fundingZScore !== null) {
      parts.push(`Funding Z-Score: ${fundingZScore.toFixed(2)} (${Math.abs(fundingZScore) > 2 ? 'extreme' : Math.abs(fundingZScore) > 1 ? 'elevated' : 'normal'}).`);
    }
    if (regime === 'TRENDING_DOWN' && signal === 'HOLD' && rawScore > BUY_BASE_THRESHOLD) {
      parts.push(`Regime filter: potential BUY suppressed — market is trending down (requires ${BUY_THRESHOLD_GATED}+ score, got ${absScore.toFixed(0)}).`);
    }
    if ((regime === 'TRENDING_UP' || regime === 'RANGING') && signal === 'HOLD' && rawScore < -SELL_BASE_THRESHOLD) {
      parts.push(`Regime filter: potential SELL suppressed — market is ${regime === 'TRENDING_UP' ? 'trending up' : 'ranging'} (requires ${SELL_THRESHOLD_GATED}+ score, got ${absScore.toFixed(0)}).`);
    }
    // v1.3: noise warning for ultra-low timeframes
    if (['1m', '3m'].includes(timeframe)) {
      parts.push(`Ultra-low timeframe warning: RSI/EMA indicators have minimal lookback on ${timeframe} candles. Signals may be noisier than longer timeframes. Consider 5m+ for higher reliability.`);
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
      hurst: hurstVal !== null ? parseFloat(hurstVal.toFixed(4)) : null,
      funding_z_score: fundingZScore !== null ? parseFloat(fundingZScore.toFixed(2)) : null,
      squeeze_active: squeezeActive,
    },
    regime,
    reasoning,
    timestamp: Math.floor(Date.now() / 1000),
    coin,
    timeframe,
    _algovault: {
      version: '1.6.0',
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
