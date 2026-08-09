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
import { splitCandleWindow } from '../lib/candle-window.js';
import { getCandleBasis, isCandleBasisShadowEnabled } from '../lib/candle-basis-flag.js';
import { recordCandleBasisShadow } from '../lib/candle-basis-shadow.js';
import { getVenueStatus } from '../lib/venue-shadow.js';
import { checkQuota, trackCall, getUpgradeHint, getRequestSessionId, getMonthlyQuota, monthResetAtMs, periodStartMs } from '../lib/license.js';
import { withTierWarning, withQuotaState, DEFAULT_UPGRADE_URL } from '../lib/tier-warning.js';
import { PKG_VERSION } from '../lib/pkg-version.js';
import type { MarketRegimeResult, RegimeType, TrendStrength, CrossVenueFundingSentiment, AdxSlopeCategory, LicenseInfo, ExchangeId, Candle } from '../types.js';
import type { PriceStructureResult } from '../lib/indicators.js';

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

/** Everything `getMarketRegime` derives from candles alone. */
export interface RegimeIndicators {
  adxVal: number | null;
  adxSlope: number | null;
  plusDI: number | null;
  minusDI: number | null;
  atrVal: number | null;
  structure: PriceStructureResult;
}

/**
 * SIGNAL-CLOSEDBAR-SHADOW-W1 CH3 — the whole candle→indicator derivation, extracted
 * PURE so the live and closed bases can be computed from the same code with different
 * inputs. The CH2 analogue is `computeIndicatorScores` in get-trade-call.ts.
 *
 * Deliberately does NOT return `currentPrice`. Per CH2 §7's level-vs-integral rule, a
 * price is a LEVEL — valid at every instant, including mid-bar — while ADX/ATR/pivots
 * are INTEGRALS over a bar and are only complete at close. `currentPrice` therefore
 * stays on the LIVE candles under BOTH bases, and keeping it out of this function is
 * what makes that structural rather than a comment someone can drift away from.
 */
export function computeRegimeIndicators(candles: Candle[]): RegimeIndicators {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const adxResult = adx(highs, lows, closes, 14, 5);
  return {
    adxVal: adxResult?.adx ?? null,
    adxSlope: adxResult?.adxSlope ?? null,
    plusDI: adxResult?.plusDI ?? null,
    minusDI: adxResult?.minusDI ?? null,
    atrVal: atr(highs, lows, closes, 14),
    structure: detectPriceStructure(highs, lows, closes, volumes),
  };
}

/** The regime verdict — what `classifyRegime` decides from the indicators alone. */
export interface RegimeClassification {
  regime: RegimeType;
  confidence: number;
  trendStrength: TrendStrength;
}

export interface RegimeClassifierInputs {
  adxVal: number | null;
  adxSlope: number | null;
  plusDI: number | null;
  minusDI: number | null;
  slopeCategory: AdxSlopeCategory;
  priceStructure: PriceStructureResult['structure'];
  volatilityRatio: number;
}

/**
 * SIGNAL-CLOSEDBAR-SHADOW-W1 CH3 — the regime classification, lifted VERBATIM out of
 * `getMarketRegime` and made pure. Behaviour is unchanged; the extraction exists so the
 * shadow row's closed-basis verdict comes from THIS code rather than a second
 * hand-written derivation in the CH4 harness, which would drift (single-derivation rule).
 */
export function classifyRegime(i: RegimeClassifierInputs): RegimeClassification {
  const { adxVal, adxSlope, plusDI, minusDI, slopeCategory, priceStructure, volatilityRatio } = i;
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
        if (plusDI! > minusDI!) {
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
    if (plusDI! > minusDI!) {
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

  return { regime, confidence, trendStrength };
}

/**
 * Indicators → everything downstream of them, for ONE basis. Both the emitted response
 * and the shadow row project from this, so they can never disagree about what a given
 * candle set means. `currentPrice` is a caller-supplied LEVEL: it is the LIVE last close
 * under both bases (CH2 §7), which is exactly why it is a parameter and not derived here.
 */
export function projectRegime(ind: RegimeIndicators, currentPrice: number) {
  const slopeCategory: AdxSlopeCategory = ind.adxSlope !== null
    ? (ind.adxSlope > ADX_SLOPE_RISING ? 'RISING' : ind.adxSlope < ADX_SLOPE_FALLING ? 'FALLING' : 'FLAT')
    : 'FLAT';
  const volatilityRatio = ind.atrVal !== null && currentPrice > 0 ? ind.atrVal / currentPrice : 0;
  const priceStructure = ind.structure.structure;
  return {
    slopeCategory,
    volatilityRatio,
    priceStructure,
    pivotQuality: ind.structure.avgPivotScore,
    ...classifyRegime({
      adxVal: ind.adxVal,
      adxSlope: ind.adxSlope,
      plusDI: ind.plusDI,
      minusDI: ind.minusDI,
      slopeCategory,
      priceStructure,
      volatilityRatio,
    }),
  };
}

export async function getMarketRegime(input: MarketRegimeInput): Promise<MarketRegimeResult> {
  const coin = input.coin.toUpperCase();
  const timeframe = input.timeframe || '4h';
  const license = input.license || { tier: 'free' as const, key: null };

  // Quota tracking (all tiers).
  //
  // OPS-QUOTA-EXHAUSTION-NOTICE-W1: READ-ONLY gate first, charge second — the same shape as
  // `get_trade_call`'s (operator-frozen) entry gate. This tool previously gated on the
  // INCREMENTING `trackCall`, so every refused call still charged the meter: the Step-0 probe
  // watched `current_usage` read 101/100 then 102/100 on successive blocked calls, and it climbs
  // without bound for as long as a caller keeps hitting the wall. A notice cannot honestly say
  // "N/100" while N drifts past 100. The refusal itself is UNCHANGED — both gates refuse at the
  // cap, HOLD and non-HOLD alike (regression-locked in tests/unit/quota-exhaustion-notice.test.ts).
  // Charging only allowed calls also routes blocks through `checkQuota`, which is what emits the
  // `quota_hit_block` funnel event — this tool never emitted it before.
  const gate = checkQuota(license);
  if (!gate.allowed) {
    throw new TierLimitReachedError({
      currentUsage: gate.used,
      monthlyLimit: gate.total,
      tier: license.tier,
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter&utm_source=mcp_tool&utm_campaign=tier_limit_reached',
      resetAtMs: monthResetAtMs(license),
      periodStartMs: periodStartMs(license),
      referralCode: referralCodeForKey(license.key),
      tool: 'get_market_regime', // FUNNEL-FIX-AGENT-X402-NUDGE-W1: enables the suggested_x402 branch
      // CH1: the wall discriminator + the DAILY pair travel WITH the refusal. Passing
      // `limit` alone would let a daily wall render the monthly numbers again, which is the
      // defect this closes — so the three move together, from the ONE `checkQuota` result.
      wall: gate.limit === 'daily' ? 'daily' : 'monthly',
      dailyUsed: gate.daily_used,
      dailyLimit: gate.daily_total,
    });
  }
  const quota = trackCall(license);

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

  // ── SIGNAL-CLOSEDBAR-SHADOW-W1 CH3: the confirmed-bar basis, mirroring CH2. The
  //    sort immediately above is what guarantees ascending order, which is
  //    `splitCandleWindow`'s documented precondition. Named `candleWindow`, never
  //    `window`, which would shadow the DOM global.
  //    `intervalMs` is the SAME value used for `startTime` above — one interval per
  //    call, so the fetch window and the bar split can never disagree.
  const candleBasis = getCandleBasis();
  const candleShadowEnabled = isCandleBasisShadowEnabled();
  const candleWindow = splitCandleWindow(candles, intervalMs, Date.now());
  //    CANDLE_BASIS unset ⇒ 'live' ⇒ this IS `candles` ⇒ byte-identical to pre-wave.
  const emittedCandles = candleBasis === 'closed' ? candleWindow.closed : candles;

  const REQUIRED_CANDLES = 30;
  if (emittedCandles.length < REQUIRED_CANDLES) {
    // Structured recovery hint: which finer timeframes already have enough
    // candles for this (usually newly-listed) symbol. `candles[0].time` is the
    // oldest candle in the fetched window ≈ the listing's first candle when the
    // listing is younger than the window.
    const firstCandleTimeMs = emittedCandles.length > 0 ? emittedCandles[0].time : Date.now();
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
      candlesAvailable: emittedCandles.length,
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

  // ── SIGNAL-CLOSEDBAR-SHADOW-W1 CH3: derive BOTH bases, select ONE. There is
  //    deliberately no single mutable "which candles" binding — that is precisely how
  //    a later edit silently moves the LIVE path; two named derivations and one
  //    selection cannot do that by accident. (Same shape as CH2.)
  const liveBasisIndicators = computeRegimeIndicators(candles);

  //    The closed pass is SHADOW work, so it is skipped unless the shadow is on or the
  //    closed basis is actually selected — it doubles the indicator pipeline.
  let closedBasisIndicators: RegimeIndicators | null = null;
  let closedBasisErrorClass: string | null = null;
  if (candleShadowEnabled || candleBasis === 'closed') {
    try {
      //  Dropping the in-progress bar reduces the count by ONE, so an asset sitting at
      //  exactly REQUIRED_CANDLES legitimately fails here. That must never reach the
      //  live path — which is why the whole DERIVATION is isolated, not just the write.
      if (candleWindow.closed.length < REQUIRED_CANDLES) {
        throw new InsufficientCandlesError({
          coin,
          exchange,
          timeframe,
          candlesAvailable: candleWindow.closed.length,
          candlesRequired: REQUIRED_CANDLES,
          suggestedTimeframes: [],
          suggestedAction: '',
        });
      }
      closedBasisIndicators = computeRegimeIndicators(candleWindow.closed);
    } catch (e) {
      closedBasisErrorClass = e instanceof Error ? e.constructor.name : 'Error';
    }
  }

  const emittedIndicators = candleBasis === 'closed' && closedBasisIndicators
    ? closedBasisIndicators
    : liveBasisIndicators;

  //    LEVEL, not INTEGRAL (CH2 §7): the newest price is valid at every instant, so it
  //    is read from the LIVE candles under BOTH bases. `computeRegimeIndicators` cannot
  //    return it, which is what keeps this structural rather than conventional.
  const currentPrice = candles[candles.length - 1].close;

  const { adxVal, adxSlope, plusDI, minusDI } = emittedIndicators;
  const atrVal = emittedIndicators.atrVal;
  const priceStructure = emittedIndicators.structure.structure;
  const pivotQuality = emittedIndicators.structure.avgPivotScore;
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
  //    Body lifted verbatim into the pure `classifyRegime` above; behaviour unchanged.
  const { regime, confidence, trendStrength } = classifyRegime({
    adxVal, adxSlope, plusDI, minusDI, slopeCategory, priceStructure, volatilityRatio,
  });

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

  // ── SIGNAL-CLOSEDBAR-SHADOW-W1 CH3: persist the basis divergence. Fire-and-forget and
  //    doubly isolated (the store swallows, and this `void`s + `.catch()`es) so a shadow
  //    write can NEVER affect the emitted regime. Skipped for internal callers, which are
  //    seed/backfill traffic and would swamp the measurement.
  if (license.tier !== 'internal' && (candleShadowEnabled || candleBasis === 'closed')) {
    // Both sides project through the SAME `projectRegime`, so the recorded live verdict
    // is the emitted one by construction rather than by a parallel re-derivation.
    const liveProjection = candleBasis === 'closed'
      ? projectRegime(liveBasisIndicators, currentPrice)
      : { regime, confidence, pivotQuality, priceStructure };
    const closedProjection = closedBasisIndicators
      ? projectRegime(closedBasisIndicators, currentPrice)
      : null;

    void recordCandleBasisShadow({
      tool: 'get_market_regime',
      coin,
      exchange,
      timeframe,
      callLive: liveProjection.regime,
      callClosed: closedProjection?.regime ?? null,
      errorClass: closedBasisErrorClass,
      confLive: liveProjection.confidence,
      confClosed: closedProjection?.confidence ?? null,
      structureLive: liveProjection.priceStructure,
      structureClosed: closedProjection?.priceStructure ?? null,
      pivotQualityLive: liveProjection.pivotQuality,
      pivotQualityClosed: closedProjection?.pivotQuality ?? null,
      elapsedFraction: candleWindow.elapsedFraction,
      nClosed: candleWindow.closed.length,
      nTotal: candles.length,
    }).catch(() => {});
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
  // OPS-QUOTA-EXHAUSTION-NOTICE-W1 (R3): always-on quota state (additive).
  meta = withQuotaState(meta, {
    tier: license.tier,
    used: quota.used,
    total: quota.total || getMonthlyQuota(license.tier),
    resetAtMs: monthResetAtMs(license),
    isBotInternal: license.tier === 'internal',
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
