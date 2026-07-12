import { getAdapter } from '../lib/exchange-adapter.js';
import { adx, atr, detectPriceStructure } from '../lib/indicators.js';
import { getDexForCoin, isKnownTradFi } from '../lib/asset-tiers.js';
import { getVenuesSupporting, COVERAGE_PROBED_AT } from '../lib/venue-coverage.js';
import { TradFiSymbolUnsupportedOnVenueError, TierLimitReachedError, InsufficientCandlesError } from '../lib/errors.js';
import { referralCodeForKey } from '../lib/referral-store.js'; // REFERRAL-INPRODUCT-NUDGE-W1: keyed→code, keyless→null
import { resolveAssetClass } from '../lib/underlying-type.js';
import { classifyUnderlyingSession, isClosedState } from '../lib/market-sessions.js';
import { fetchTradFiFundingByVenue, normalizeTo8h, computeTradFiFundingSentiment, buildFundingByVenue } from '../lib/tradfi-funding.js';
import { computeSuggestedTimeframes, suggestedActionFor } from '../lib/candle-guard.js';
import { getVenueStatus } from '../lib/venue-shadow.js';
import { trackCall, getUpgradeHint, getQuotaExhaustedMessage, getRequestSessionId, daysUntilMonthReset, getMonthlyQuota } from '../lib/license.js';
import { withTierWarning, DEFAULT_UPGRADE_URL } from '../lib/tier-warning.js';
import { PKG_VERSION } from '../lib/pkg-version.js';
import type { MarketRegimeResult, RegimeType, TrendStrength, CrossVenueFundingSentiment, AdxSlopeCategory, LicenseInfo, ExchangeId } from '../types.js';

interface MarketRegimeInput {
  coin: string;
  timeframe?: string;
  exchange?: ExchangeId;
  license?: LicenseInfo;
}

// How many candles to fetch per timeframe for 7 days of data
const CANDLE_COUNTS: Record<string, number> = {
  '1h': 168,  // 7 * 24
  '4h': 42,   // 7 * 6
  '1d': 30,   // ~30 days for daily
};

// ADX slope thresholds (linear regression slope per bar)
const ADX_SLOPE_RISING = 0.5;
const ADX_SLOPE_FALLING = -0.5;

export async function getMarketRegime(input: MarketRegimeInput): Promise<MarketRegimeResult> {
  const coin = input.coin.toUpperCase();
  const timeframe = input.timeframe || '4h';
  const license = input.license || { tier: 'free' as const, key: null };

  // Quota tracking (all tiers)
  const quota = trackCall(license);
  if (!quota.allowed) {
    throw new TierLimitReachedError({
      currentUsage: quota.used,
      monthlyLimit: quota.total,
      tier: license.tier,
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter&utm_source=mcp_tool&utm_campaign=tier_limit_reached',
      retryAfterDays: daysUntilMonthReset(license),
      referralCode: referralCodeForKey(license.key),
      tool: 'get_market_regime', // FUNNEL-FIX-AGENT-X402-NUDGE-W1: enables the suggested_x402 branch
    });
  }

  const candleCount = CANDLE_COUNTS[timeframe] || 168;
  const intervalMs = getIntervalMs(timeframe);
  const startTime = Date.now() - candleCount * intervalMs;

  const exchange = input.exchange || 'HL';

  // Venue-coverage gate (TRADFI-SYMBOL-ALIAS-W1 / v1.11.1): see same gate in
  // get_trade_call — block known TradFi symbols on unsupported CEX so callers
  // get `TRADFI_SYMBOL_UNSUPPORTED_ON_VENUE` with `suggested_venues` instead
  // of a raw upstream `400`.
  if (isKnownTradFi(coin)) {
    const supported = getVenuesSupporting(coin);
    if (!supported.includes(exchange)) {
      throw new TradFiSymbolUnsupportedOnVenueError(coin, exchange, supported, COVERAGE_PROBED_AT);
    }
  }

  const adapter = getAdapter(exchange);
  const dex = exchange === 'HL' ? getDexForCoin(coin) : undefined;

  // Fetch candles from selected exchange + cross-venue fundings from HL (best-effort)
  const hlAdapter = getAdapter('HL');
  const [candles, allFundings] = await Promise.all([
    adapter.getCandles(coin, timeframe, startTime, dex),
    hlAdapter.getPredictedFundings().catch(() => [] as Awaited<ReturnType<typeof adapter.getPredictedFundings>>),
  ]);
  // Everything below assumes oldest-first candles (closes[length-1] = current
  // price, structure/EMA walk forward); a newest-first venue payload would
  // invert the regime. No-op for ascending venues.
  candles.sort((a, b) => a.time - b.time);

  const REQUIRED_CANDLES = 30;
  if (candles.length < REQUIRED_CANDLES) {
    // Structured recovery hint: which finer timeframes already have enough
    // candles for this (usually newly-listed) symbol. `candles[0].time` is the
    // oldest candle in the fetched window ≈ the listing's first candle when the
    // listing is younger than the window.
    const firstCandleTimeMs = candles.length > 0 ? candles[0].time : Date.now();
    const suggestedTimeframes = computeSuggestedTimeframes({
      firstCandleTimeMs,
      nowMs: Date.now(),
      requiredCandles: REQUIRED_CANDLES,
      requestedTimeframe: timeframe,
    });
    throw new InsufficientCandlesError({
      coin,
      exchange,
      timeframe,
      candlesAvailable: candles.length,
      candlesRequired: REQUIRED_CANDLES,
      suggestedTimeframes,
      suggestedAction: suggestedActionFor(suggestedTimeframes),
    });
  }

  // ── Underlying-market session awareness (TRADIFI-SIGNAL-HARDENING-W1) ──
  // Best-effort; resolveAssetClass never throws and fails open to UNKNOWN.
  const assetClass = await resolveAssetClass(coin, exchange);
  const session = assetClass === 'UNKNOWN'
    ? { state: 'UNKNOWN' as const, note: '' }
    : classifyUnderlyingSession({ assetClass, at: new Date() });

  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const currentPrice = closes[closes.length - 1];

  // Compute indicators (now with ADX slope and volume-weighted structure)
  const adxResult = adx(highs, lows, closes, 14, 5);
  const atrVal = atr(highs, lows, closes, 14);
  const structureResult = detectPriceStructure(highs, lows, closes, volumes);

  const adxVal = adxResult?.adx ?? null;
  const adxSlope = adxResult?.adxSlope ?? null;
  const priceStructure = structureResult.structure;
  const pivotQuality = structureResult.avgPivotScore;
  const volatilityRatio = atrVal !== null && currentPrice > 0 ? atrVal / currentPrice : 0;

  // Categorize ADX slope
  const slopeCategory: AdxSlopeCategory = adxSlope !== null
    ? (adxSlope > ADX_SLOPE_RISING ? 'RISING' : adxSlope < ADX_SLOPE_FALLING ? 'FALLING' : 'FLAT')
    : 'FLAT';

  // ── Cross-venue funding sentiment (OPS-TRADFI-XVENUE-FUNDING-W1) ──
  // TradFi (EQUITY/KR_EQUITY/COMMODITY, or a known-TradFi symbol the resolver
  // couldn't class) → 5-venue per-venue aggregation via tradfi-funding.ts.
  // PREMARKET → excluded (fixed funding). Crypto → the existing HL-vs-CEX path.
  const isTradFiAggregate =
    assetClass === 'EQUITY' || assetClass === 'KR_EQUITY' || assetClass === 'COMMODITY' ||
    (assetClass === 'UNKNOWN' && isKnownTradFi(coin));

  let sentiment: CrossVenueFundingSentiment;
  let divergenceNote: string;
  let fundingByVenue: Record<string, { rate: number; interval_min: number; rate_8h_equiv: number }> | undefined;

  if (assetClass === 'PREMARKET') {
    sentiment = 'NEUTRAL';
    divergenceNote = 'Pre-IPO funding is fixed — cross-venue sentiment not applicable.';
    // no funding_by_venue for pre-IPO (R4)
  } else if (isTradFiAggregate) {
    const venueFunding = await fetchTradFiFundingByVenue(coin);
    const r = computeTradFiFundingSentiment(coin, venueFunding, isClosedState(session.state));
    sentiment = r.sentiment;
    divergenceNote = r.divergenceNote;
    fundingByVenue = buildFundingByVenue(venueFunding);
  } else {
    const r = computeCrossVenueFundingSentiment(coin, allFundings, volatilityRatio);
    sentiment = r.sentiment;
    divergenceNote = r.divergenceNote;
    fundingByVenue = buildFundingByVenueFromAllFundings(coin, allFundings);
  }

  // ── Classify regime with ADX slope awareness (Item 6) ──
  let regime: RegimeType;
  let confidence: number;
  let trendStrength: TrendStrength;

  if (adxVal !== null && adxVal > 25) {
    // ADX above trending threshold — but check slope for exhaustion
    if (adxVal < 30 && slopeCategory === 'FALLING' && adxSlope !== null && adxSlope < -1.0) {
      // ADX 25-30 and falling fast → trend is dying, reclassify as RANGING
      regime = 'RANGING';
      trendStrength = 'WEAK';
      confidence = Math.round((25 - adxVal) * 4 + 30); // fade toward ranging confidence
      confidence = Math.max(30, Math.min(confidence, 60));
    } else {
      // Normal trending classification
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

      // Confidence from ADX value
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

      // ADX slope adjustment: boost rising, penalize falling (asymmetric: -15 to +10)
      if (adxSlope !== null) {
        const slopeAdjustment = Math.max(-15, Math.min(10, Math.round(adxSlope * 5)));
        confidence = Math.max(20, Math.min(95, confidence + slopeAdjustment));
      }

      // Downgrade trend strength if slope is falling
      if (slopeCategory === 'FALLING') {
        if (trendStrength === 'STRONG') trendStrength = 'MODERATE';
        else if (trendStrength === 'MODERATE') trendStrength = 'WEAK';
      }
    }
  } else if (adxVal !== null && adxVal > 18 && slopeCategory === 'RISING' && adxSlope !== null && adxSlope > 0.8) {
    // Early trend detection: ADX 18-25 but rising fast → emerging trend
    if (adxResult!.plusDI > adxResult!.minusDI) {
      regime = 'TRENDING_UP';
    } else {
      regime = 'TRENDING_DOWN';
    }
    trendStrength = 'WEAK';
    confidence = Math.max(40, Math.min(60, Math.round(adxVal * 2)));
  } else {
    // Non-trending: RANGING or VOLATILE
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

  // ── Interpretations ──
  let adxInterpretation = 'No data';
  if (adxVal !== null) {
    if (adxVal > 40) adxInterpretation = 'Very strong trend';
    else if (adxVal > 25) adxInterpretation = 'Strong trend';
    else if (adxVal > 20) adxInterpretation = 'Weak trend';
    else adxInterpretation = 'No trend';
  }

  let adxSlopeInterpretation = 'No data';
  if (adxSlope !== null) {
    if (slopeCategory === 'RISING') {
      adxSlopeInterpretation = adxVal !== null && adxVal < 25
        ? 'Trend emerging — momentum building'
        : 'Trend strengthening';
    } else if (slopeCategory === 'FALLING') {
      adxSlopeInterpretation = adxVal !== null && adxVal > 25
        ? 'Trend exhausting — possible regime change'
        : 'Momentum fading';
    } else {
      adxSlopeInterpretation = 'Steady — no momentum change';
    }
  }

  let volInterpretation = 'Normal';
  if (volatilityRatio > 0.05) volInterpretation = 'Very high';
  else if (volatilityRatio > 0.03) volInterpretation = 'High';
  else if (volatilityRatio < 0.01) volInterpretation = 'Low';

  let suggestion = generateSuggestion(regime, trendStrength, volatilityRatio, slopeCategory);
  // When the underlying cash market is closed, the candles reflect a capped
  // synthetic index — flag the regime as provisional (label + caveat only; no
  // signal suppression in v1).
  if (isClosedState(session.state)) {
    suggestion += ' Underlying market closed — candles reflect capped synthetic pricing; treat regime as provisional until reopen.';
  }

  // Upgrade hint: only for free tier
  const upgradeHint = getUpgradeHint(license, { used: quota.used, total: quota.total });

  // EXCHANGE-SHADOW-PROMOTE-W1 / C2: venue lifecycle status surfaced in every
  // tool response envelope. See parallel comment in get-trade-call.ts.
  const venueStatus = await getVenueStatus(exchange);

  let meta: MarketRegimeResult['_algovault'] = {
    version: PKG_VERSION,
    tool: 'get_market_regime',
    compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-backtest-mcp'],
    session_id: getRequestSessionId() ?? null,
    exchange,
    venue_status: venueStatus,
  };
  if (upgradeHint) meta.upgrade_hint = upgradeHint;
  // ACTIVATION-PAYWALL-W1: structured tier_warning at 75%+ / 90%+ thresholds.
  meta = withTierWarning(meta, {
    tier: license.tier,
    currentUsage: quota.used,
    monthlyLimit: quota.total || getMonthlyQuota(license.tier),
    isBotInternal: license.tier === 'internal',
    upgradeUrl: DEFAULT_UPGRADE_URL,
    tool: 'get_market_regime', // FUNNEL-FIX-AGENT-X402-NUDGE-W1: hard-warning suggested_x402 branch
  });

  return {
    regime,
    confidence,
    metrics: {
      adx: adxVal !== null ? parseFloat(adxVal.toFixed(1)) : null,
      adx_interpretation: adxInterpretation,
      adx_slope: adxSlope !== null ? parseFloat(adxSlope.toFixed(2)) : null,
      adx_slope_interpretation: adxSlopeInterpretation,
      volatility_ratio: parseFloat(volatilityRatio.toFixed(4)),
      volatility_interpretation: volInterpretation,
      price_structure: priceStructure,
      pivot_quality: pivotQuality,
      trend_strength: trendStrength,
      cross_venue_funding_sentiment: sentiment,
      funding_divergence_note: divergenceNote,
      underlying_session: session.state,
      ...(session.note !== '' ? { session_note: session.note } : {}),
      ...(fundingByVenue ? { funding_by_venue: fundingByVenue } : {}),
    },
    suggestion,
    timestamp: Math.floor(Date.now() / 1000),
    coin,
    timeframe,
    _algovault: meta,
  };
}

/**
 * Cross-venue funding sentiment with ATR-adaptive threshold (Item 9).
 *
 * Instead of a fixed 1 bps threshold, scales by current volatility:
 *   - High vol (ATR/price > 0.03): need bigger divergence (2 bps) to be meaningful
 *   - Low vol (ATR/price < 0.01): even small divergence (0.5 bps) is meaningful
 *   - Normal vol: standard 1 bps threshold
 *
 * Also modulates confidence by venue count (3 venues = full confidence, 2 = 70%).
 */
function computeCrossVenueFundingSentiment(
  coin: string,
  allFundings: { coin: string; venues: { venue: string; fundingRate: number; nextFundingTime: number }[] }[],
  volatilityRatio: number
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
  const cexNames: string[] = [];
  if (binVenue && !isNaN(binVenue.fundingRate)) {
    cexRates.push(binVenue.fundingRate / 8);
    cexNames.push('Binance');
  }
  if (bybitVenue && !isNaN(bybitVenue.fundingRate)) {
    cexRates.push(bybitVenue.fundingRate / 8);
    cexNames.push('Bybit');
  }

  if (cexRates.length === 0) {
    return { sentiment: 'NEUTRAL', divergenceNote: 'No CEX funding data for comparison' };
  }

  const avgCexHourly = cexRates.reduce((a, b) => a + b, 0) / cexRates.length;
  const diff = hlHourly - avgCexHourly;

  // ATR-adaptive threshold: scale 1 bps base by volatility ratio / normal (0.02)
  const BASE_THRESHOLD = 0.0001; // 1 bps hourly
  const volScale = Math.max(volatilityRatio / 0.02, 0.5); // floor at 0.5x (never below 0.5 bps)
  const threshold = BASE_THRESHOLD * volScale;

  // Concordance check: do both CEX venues agree on direction vs HL?
  const venueStr = cexNames.join('/');
  let concordanceNote = '';
  if (cexRates.length === 2) {
    const bothAboveHL = cexRates[0] > hlHourly && cexRates[1] > hlHourly;
    const bothBelowHL = cexRates[0] < hlHourly && cexRates[1] < hlHourly;
    if (!bothAboveHL && !bothBelowHL) {
      concordanceNote = ' (CEX venues disagree — lower conviction)';
    }
  }

  // Compute divergence magnitude for note
  const diffBps = Math.abs(diff) * 10000;
  const diffNote = `${diffBps.toFixed(1)} bps/hr`;

  if (diff < -threshold) {
    return {
      sentiment: 'BEARISH_BIAS',
      divergenceNote: `HL funding ${diffNote} below ${venueStr} avg — shorts concentrated on HL${concordanceNote}`,
    };
  }

  if (diff > threshold) {
    return {
      sentiment: 'BULLISH_BIAS',
      divergenceNote: `HL funding ${diffNote} above ${venueStr} avg — longs concentrated on HL${concordanceNote}`,
    };
  }

  return { sentiment: 'NEUTRAL', divergenceNote: `Funding aligned across venues (divergence: ${diffNote})` };
}

/**
 * Build `funding_by_venue` for the CRYPTO path from HL's predicted-fundings
 * (HlPerp/BinPerp/BybitPerp), so the field is uniform across TradFi + crypto (R4).
 */
function buildFundingByVenueFromAllFundings(
  coin: string,
  allFundings: { coin: string; venues: { venue: string; fundingRate: number; nextFundingTime: number }[] }[],
): Record<string, { rate: number; interval_min: number; rate_8h_equiv: number }> | undefined {
  const coinFunding = allFundings.find(f => f.coin === coin);
  if (!coinFunding || coinFunding.venues.length === 0) return undefined;
  const VENUE_MAP: Record<string, { venue: string; interval: number }> = {
    HlPerp: { venue: 'HL', interval: 60 },
    BinPerp: { venue: 'BINANCE', interval: 480 },
    BybitPerp: { venue: 'BYBIT', interval: 480 },
  };
  const out: Record<string, { rate: number; interval_min: number; rate_8h_equiv: number }> = {};
  for (const v of coinFunding.venues) {
    const m = VENUE_MAP[v.venue];
    if (!m || isNaN(v.fundingRate)) continue;
    out[m.venue] = { rate: v.fundingRate, interval_min: m.interval, rate_8h_equiv: normalizeTo8h(v.fundingRate, m.interval) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function generateSuggestion(
  regime: RegimeType,
  strength: TrendStrength,
  volRatio: number,
  slopeCategory: AdxSlopeCategory
): string {
  const slopeNote = slopeCategory === 'FALLING'
    ? ' Trend momentum is fading — consider tightening stops.'
    : slopeCategory === 'RISING'
    ? ' Trend momentum is building — favorable for entries.'
    : '';

  switch (regime) {
    case 'TRENDING_UP':
      return `Market is in a ${strength.toLowerCase()} uptrend. Favor trend-following strategies. Position sizing: ${
        strength === 'STRONG' ? 'normal to aggressive' : 'conservative to normal'
      }. Avoid mean-reversion entries.${slopeNote}`;
    case 'TRENDING_DOWN':
      return `Market is in a ${strength.toLowerCase()} downtrend. Favor short-side trend-following or stay flat. Position sizing: ${
        strength === 'STRONG' ? 'normal to aggressive (short)' : 'conservative'
      }. Avoid catching falling knives.${slopeNote}`;
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
