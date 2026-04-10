import { getAdapter } from '../lib/exchange-adapter.js';
import { adx, atr, detectPriceStructure } from '../lib/indicators.js';
import type { MarketRegimeResult, RegimeType, TrendStrength, CrossVenueFundingSentiment } from '../types.js';

interface MarketRegimeInput {
  coin: string;
  timeframe?: string;
}

// How many candles to fetch per timeframe for 7 days of data
const CANDLE_COUNTS: Record<string, number> = {
  '1h': 168,  // 7 * 24
  '4h': 42,   // 7 * 6
  '1d': 30,   // ~30 days for daily
};

export async function getMarketRegime(input: MarketRegimeInput): Promise<MarketRegimeResult> {
  const coin = input.coin.toUpperCase();
  const timeframe = input.timeframe || '4h';

  const candleCount = CANDLE_COUNTS[timeframe] || 168;
  const intervalMs = getIntervalMs(timeframe);
  const startTime = Date.now() - candleCount * intervalMs;

  const adapter = getAdapter();

  // Fetch candles + predicted fundings in parallel (fundings are best-effort)
  const [candles, allFundings] = await Promise.all([
    adapter.getCandles(coin, timeframe, startTime),
    adapter.getPredictedFundings().catch(() => [] as Awaited<ReturnType<typeof adapter.getPredictedFundings>>),
  ]);

  if (candles.length < 30) {
    throw new Error(`Insufficient candle data for ${coin} regime analysis (got ${candles.length}, need >= 30)`);
  }

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];

  // Compute indicators
  const adxResult = adx(highs, lows, closes, 14);
  const atrVal = atr(highs, lows, closes, 14);
  const priceStructure = detectPriceStructure(highs, lows);

  const adxVal = adxResult?.adx ?? null;
  const volatilityRatio = atrVal !== null && currentPrice > 0 ? atrVal / currentPrice : 0;

  // ── Cross-venue funding sentiment (Moat Layer 4) ──
  const { sentiment, divergenceNote } = computeCrossVenueFundingSentiment(coin, allFundings);

  // Classify regime
  let regime: RegimeType;
  let confidence: number;
  let trendStrength: TrendStrength;

  if (adxVal !== null && adxVal > 25) {
    if (priceStructure === 'HIGHER_HIGHS') {
      regime = 'TRENDING_UP';
    } else if (priceStructure === 'LOWER_LOWS') {
      regime = 'TRENDING_DOWN';
    } else {
      if (adxResult!.plusDI > adxResult!.minusDI) {
        regime = 'TRENDING_UP';
      } else {
        regime = 'TRENDING_DOWN';
      }
    }

    if (adxVal > 40) {
      trendStrength = 'STRONG';
      confidence = Math.min(90, Math.round(adxVal * 2));
    } else if (adxVal > 30) {
      trendStrength = 'MODERATE';
      confidence = Math.round(adxVal * 2);
    } else {
      trendStrength = 'WEAK';
      confidence = Math.round(adxVal * 1.5);
    }
  } else {
    trendStrength = 'WEAK';
    if (volatilityRatio > 0.03) {
      regime = 'VOLATILE';
      confidence = Math.min(85, Math.round(volatilityRatio * 2000));
    } else {
      regime = 'RANGING';
      confidence = adxVal !== null ? Math.round((25 - adxVal) * 4) : 50;
    }
    confidence = Math.max(30, Math.min(confidence, 85));
  }

  // Interpretations
  let adxInterpretation = 'No data';
  if (adxVal !== null) {
    if (adxVal > 40) adxInterpretation = 'Very strong trend';
    else if (adxVal > 25) adxInterpretation = 'Strong trend';
    else if (adxVal > 20) adxInterpretation = 'Weak trend';
    else adxInterpretation = 'No trend';
  }

  let volInterpretation = 'Normal';
  if (volatilityRatio > 0.05) volInterpretation = 'Very high';
  else if (volatilityRatio > 0.03) volInterpretation = 'High';
  else if (volatilityRatio < 0.01) volInterpretation = 'Low';

  const suggestion = generateSuggestion(regime, trendStrength, volatilityRatio);

  return {
    regime,
    confidence,
    metrics: {
      adx: adxVal !== null ? parseFloat(adxVal.toFixed(1)) : null,
      adx_interpretation: adxInterpretation,
      volatility_ratio: parseFloat(volatilityRatio.toFixed(4)),
      volatility_interpretation: volInterpretation,
      price_structure: priceStructure,
      trend_strength: trendStrength,
      cross_venue_funding_sentiment: sentiment,
      funding_divergence_note: divergenceNote,
    },
    suggestion,
    timestamp: Math.floor(Date.now() / 1000),
    coin,
    timeframe,
    _algovault: {
      version: '1.5.0',
      tool: 'get_market_regime',
      compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-backtest-mcp'],
    },
  };
}

/**
 * Compute cross-venue funding sentiment by comparing HL vs Binance/Bybit rates.
 * - HL funding significantly below Binance/Bybit → shorts concentrated on HL → BEARISH_BIAS
 * - HL funding significantly above → longs concentrated on HL → BULLISH_BIAS
 * - Otherwise → NEUTRAL
 */
function computeCrossVenueFundingSentiment(
  coin: string,
  allFundings: { coin: string; venues: { venue: string; fundingRate: number; nextFundingTime: number }[] }[]
): { sentiment: CrossVenueFundingSentiment; divergenceNote: string } {
  const coinFunding = allFundings.find(f => f.coin === coin);
  if (!coinFunding || coinFunding.venues.length < 2) {
    return { sentiment: 'NEUTRAL', divergenceNote: 'Insufficient cross-venue data' };
  }

  const hlVenue = coinFunding.venues.find(v => v.venue === 'HlPerp');
  const binVenue = coinFunding.venues.find(v => v.venue === 'BinPerp');
  const bybitVenue = coinFunding.venues.find(v => v.venue === 'BybitPerp');

  if (!hlVenue || isNaN(hlVenue.fundingRate)) {
    return { sentiment: 'NEUTRAL', divergenceNote: 'HL funding data not available' };
  }

  // Normalize to hourly rates for comparison
  const hlHourly = hlVenue.fundingRate; // HL is already hourly
  const cexRates: number[] = [];
  if (binVenue && !isNaN(binVenue.fundingRate)) cexRates.push(binVenue.fundingRate / 8); // Binance is 8h rate
  if (bybitVenue && !isNaN(bybitVenue.fundingRate)) cexRates.push(bybitVenue.fundingRate / 8); // Bybit is 8h rate

  if (cexRates.length === 0) {
    return { sentiment: 'NEUTRAL', divergenceNote: 'No CEX funding data for comparison' };
  }

  const avgCexHourly = cexRates.reduce((a, b) => a + b, 0) / cexRates.length;
  const diff = hlHourly - avgCexHourly;

  // Threshold: 0.0001 (1 bps hourly) is a significant divergence
  const THRESHOLD = 0.0001;

  if (diff < -THRESHOLD) {
    const venues = [binVenue && 'Binance', bybitVenue && 'Bybit'].filter(Boolean).join('/');
    return {
      sentiment: 'BEARISH_BIAS',
      divergenceNote: `HL funding significantly below ${venues} — shorts concentrated on HL`,
    };
  }

  if (diff > THRESHOLD) {
    const venues = [binVenue && 'Binance', bybitVenue && 'Bybit'].filter(Boolean).join('/');
    return {
      sentiment: 'BULLISH_BIAS',
      divergenceNote: `HL funding significantly above ${venues} — longs concentrated on HL`,
    };
  }

  return { sentiment: 'NEUTRAL', divergenceNote: 'Funding rates aligned across venues' };
}

function generateSuggestion(regime: RegimeType, strength: TrendStrength, volRatio: number): string {
  switch (regime) {
    case 'TRENDING_UP':
      return `Market is in a ${strength.toLowerCase()} uptrend. Favor trend-following strategies. Position sizing: ${
        strength === 'STRONG' ? 'normal to aggressive' : 'conservative to normal'
      }. Avoid mean-reversion entries.`;
    case 'TRENDING_DOWN':
      return `Market is in a ${strength.toLowerCase()} downtrend. Favor short-side trend-following or stay flat. Position sizing: ${
        strength === 'STRONG' ? 'normal to aggressive (short)' : 'conservative'
      }. Avoid catching falling knives.`;
    case 'RANGING':
      return `Market is range-bound with low directional momentum. Favor mean-reversion strategies — buy support, sell resistance. Position sizing: conservative. Use tight stops.`;
    case 'VOLATILE':
      return `Market is volatile with no clear direction. Reduce position sizes. Favor volatility strategies (straddles, wide stops). Avoid tight stops — they will get hunted. Volatility ratio: ${(volRatio * 100).toFixed(1)}%.`;
  }
}

function getIntervalMs(tf: string): number {
  const map: Record<string, number> = {
    '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
  };
  return map[tf] || 14_400_000;
}
