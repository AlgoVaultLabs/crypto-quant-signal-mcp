"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMarketRegime = getMarketRegime;
const hyperliquid_js_1 = require("../lib/hyperliquid.js");
const indicators_js_1 = require("../lib/indicators.js");
// How many candles to fetch per timeframe for 7 days of data
const CANDLE_COUNTS = {
    '1h': 168, // 7 * 24
    '4h': 42, // 7 * 6
    '1d': 30, // ~30 days for daily
};
async function getMarketRegime(input) {
    const coin = input.coin.toUpperCase();
    const timeframe = input.timeframe || '4h';
    const candleCount = CANDLE_COUNTS[timeframe] || 168;
    const intervalMs = getIntervalMs(timeframe);
    const startTime = Date.now() - candleCount * intervalMs;
    const candles = await (0, hyperliquid_js_1.fetchCandles)(coin, timeframe, startTime);
    if (candles.length < 30) {
        throw new Error(`Insufficient candle data for ${coin} regime analysis (got ${candles.length}, need >= 30)`);
    }
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const currentPrice = closes[closes.length - 1];
    // Compute indicators
    const adxResult = (0, indicators_js_1.adx)(highs, lows, closes, 14);
    const atrVal = (0, indicators_js_1.atr)(highs, lows, closes, 14);
    const priceStructure = (0, indicators_js_1.detectPriceStructure)(highs, lows);
    const adxVal = adxResult?.adx ?? null;
    const volatilityRatio = atrVal !== null && currentPrice > 0 ? atrVal / currentPrice : 0;
    // Classify regime
    let regime;
    let confidence;
    let trendStrength;
    if (adxVal !== null && adxVal > 25) {
        // Trending market
        if (priceStructure === 'HIGHER_HIGHS') {
            regime = 'TRENDING_UP';
        }
        else if (priceStructure === 'LOWER_LOWS') {
            regime = 'TRENDING_DOWN';
        }
        else {
            // ADX says trending but structure is mixed — use +DI vs -DI
            if (adxResult.plusDI > adxResult.minusDI) {
                regime = 'TRENDING_UP';
            }
            else {
                regime = 'TRENDING_DOWN';
            }
        }
        if (adxVal > 40) {
            trendStrength = 'STRONG';
            confidence = Math.min(90, Math.round(adxVal * 2));
        }
        else if (adxVal > 30) {
            trendStrength = 'MODERATE';
            confidence = Math.round(adxVal * 2);
        }
        else {
            trendStrength = 'WEAK';
            confidence = Math.round(adxVal * 1.5);
        }
    }
    else {
        // Non-trending market
        trendStrength = 'WEAK';
        if (volatilityRatio > 0.03) {
            regime = 'VOLATILE';
            confidence = Math.min(85, Math.round(volatilityRatio * 2000));
        }
        else {
            regime = 'RANGING';
            confidence = adxVal !== null ? Math.round((25 - adxVal) * 4) : 50;
        }
        confidence = Math.max(30, Math.min(confidence, 85));
    }
    // Interpretations
    let adxInterpretation = 'No data';
    if (adxVal !== null) {
        if (adxVal > 40)
            adxInterpretation = 'Very strong trend';
        else if (adxVal > 25)
            adxInterpretation = 'Strong trend';
        else if (adxVal > 20)
            adxInterpretation = 'Weak trend';
        else
            adxInterpretation = 'No trend';
    }
    let volInterpretation = 'Normal';
    if (volatilityRatio > 0.05)
        volInterpretation = 'Very high';
    else if (volatilityRatio > 0.03)
        volInterpretation = 'High';
    else if (volatilityRatio < 0.01)
        volInterpretation = 'Low';
    // Generate suggestion
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
        },
        suggestion,
        timestamp: Math.floor(Date.now() / 1000),
        coin,
        timeframe,
    };
}
function generateSuggestion(regime, strength, volRatio) {
    switch (regime) {
        case 'TRENDING_UP':
            return `Market is in a ${strength.toLowerCase()} uptrend. Favor trend-following strategies. Position sizing: ${strength === 'STRONG' ? 'normal to aggressive' : 'conservative to normal'}. Avoid mean-reversion entries.`;
        case 'TRENDING_DOWN':
            return `Market is in a ${strength.toLowerCase()} downtrend. Favor short-side trend-following or stay flat. Position sizing: ${strength === 'STRONG' ? 'normal to aggressive (short)' : 'conservative'}. Avoid catching falling knives.`;
        case 'RANGING':
            return `Market is range-bound with low directional momentum. Favor mean-reversion strategies — buy support, sell resistance. Position sizing: conservative. Use tight stops.`;
        case 'VOLATILE':
            return `Market is volatile with no clear direction. Reduce position sizes. Favor volatility strategies (straddles, wide stops). Avoid tight stops — they will get hunted. Volatility ratio: ${(volRatio * 100).toFixed(1)}%.`;
    }
}
function getIntervalMs(tf) {
    const map = {
        '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
    };
    return map[tf] || 14_400_000;
}
//# sourceMappingURL=get-market-regime.js.map