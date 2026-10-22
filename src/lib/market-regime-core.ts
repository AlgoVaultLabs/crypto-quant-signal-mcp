/**
 * market-regime-core.ts — the PURE regime derivation (SCAN-MARKET-REGIMES-W1-V2 CH1).
 *
 * One derivation, two consumers:
 *   - `get_market_regime` (src/tools/get-market-regime.ts): gate → quota → fetch → THIS core →
 *     funding / session / suggestion / envelope.
 *   - the regime snapshot sampler (src/scripts/regime-snapshot-sampler.ts): fetch → THIS core →
 *     one `regime_snapshots` row per coin per closed bar.
 *
 * A sampler row and a tool response can therefore never disagree about what one candle window
 * means — the single-derivation rule. The parity oracle is tests/unit/regime-core-parity.test.ts,
 * recorded from the unmodified tool before this module existed.
 *
 * PURE: no network, no quota, no HL, no clock. Every instant it needs is a parameter. The body is
 * lifted VERBATIM from `getMarketRegime` (21db1c1e); the comments that explain each step moved
 * with it.
 *
 * Wrong-classifier trap: this is the 4-label `classifyRegime` (+ confidence). It is NOT
 * `classifyRegimeLabel` (3 labels, `REGIME_RULE_VERSION`) that `scan_trade_calls` rows carry, and
 * it versions separately as `MARKET_REGIME_RULE_VERSION`.
 */
import { adx, atr, detectPriceStructure } from './indicators.js';
import type { PriceStructureResult } from './indicators.js';
import { InsufficientCandlesError } from './errors.js';
import { computeSuggestedTimeframes, suggestedActionFor, intervalMsFor } from './candle-guard.js';
import { splitCandleWindow } from './candle-window.js';
import { CANDLE_COUNTS, servingWindowBars } from './serving-windows.js';
import type { CandleBasis } from './candle-basis-flag.js';
import type { RegimeType, TrendStrength, AdxSlopeCategory, ExchangeId, Candle } from '../types.js';

/**
 * The rule version stamped on every `regime_snapshots` row. Bump it whenever a change here can move
 * `regime` / `confidence` for the same candles, so history from two rules is never read as one
 * series (`regime_since` only carries forward within one version). NEVER reuse
 * `REGIME_RULE_VERSION` — that versions the OTHER classifier.
 */
export const MARKET_REGIME_RULE_VERSION = 1;

// How many candles to fetch per timeframe (a LOOKBACK WINDOW in bars, never a row limit). OPS-SERVED-CANDLE-TRUTH-W1
// CH1 moved it, values unchanged, into the serving-window registry (src/lib/serving-windows.ts), whose suite S tests it
// on every venue. Its history — the 1d 30 -> 100 move, and the 4h Wilder-seed decision left open — moved with it.
// Re-exported so every existing importer of this module is unchanged.
export { CANDLE_COUNTS };

/**
 * Bars needed for a FULL ADX-slope regression, and the reason it is not `REQUIRED_CANDLES`.
 *
 * `adx()` returns non-null from 29 bars (`indicators.ts:131`, `len < 2 * period + 1`), but it
 * accumulates at most `slopeLen + 1 = 6` ADX values for the slope fit and reaches that only at
 * 33 bars. Between 30 and 32 the "slope(5)" is a regression through as few as 3 points.
 *
 * This is a CONSTRUCTION-side floor: it asserts that OUR fetch window is big enough. It is
 * deliberately NOT a serving threshold — `REQUIRED_CANDLES` stays the only refusal, because a
 * symbol with 30-32 bars is a three-day-old listing, not a defect, and refusing it would be a
 * coverage regression on exactly the newly-listed path.
 */
export const ADX_SLOPE_FLOOR = 33;

/** The only refusal: fewer emitted bars than this → `InsufficientCandlesError`. */
export const REQUIRED_CANDLES = 30;

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

/** ADX slope → its category. The ONE definition the projection and the core both use. */
function categorizeSlope(adxSlope: number | null): AdxSlopeCategory {
  return adxSlope !== null
    ? (adxSlope > ADX_SLOPE_RISING ? 'RISING' : adxSlope < ADX_SLOPE_FALLING ? 'FALLING' : 'FLAT')
    : 'FLAT';
}

/**
 * Indicators → everything downstream of them, for ONE basis. Both the emitted response
 * and the shadow row project from this, so they can never disagree about what a given
 * candle set means. `currentPrice` is a caller-supplied LEVEL: it is the LIVE last close
 * under both bases (CH2 §7), which is exactly why it is a parameter and not derived here.
 */
export function projectRegime(ind: RegimeIndicators, currentPrice: number) {
  const slopeCategory: AdxSlopeCategory = categorizeSlope(ind.adxSlope);
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

/** The fetch window for one timeframe. `get_market_regime` and the sampler both ask for exactly this. */
export interface RegimeFetchWindow {
  candleCount: number;
  intervalMs: number;
  startTime: number;
}

/**
 * SIGNAL-TREND-BLINDNESS-FIX-W1 CH1: the private 3-entry tf->ms table is retired; `intervalMsFor`
 * (11 entries, src/lib/candle-guard.ts) is the ONE owner of the step.
 *
 * OPS-SERVED-CANDLE-TRUTH-W1 CH1: the window is the registry's `market_regime` row, and an UNDECLARED
 * timeframe is refused rather than defaulted. The retired `CANDLE_COUNTS[tf] || 168` / `?? 3_600_000`
 * fallback existed because `x402-http-routes.ts` once forwarded `timeframe` unvalidated. Every channel
 * now dispatches through `callTool`, which refuses a timeframe outside the tool's REGIME_TIMEFRAMES
 * before dispatch (Q-PIPE-2 row 12), and the sampler asks only REGIME_SNAPSHOT_TIMEFRAMES. So no caller
 * reaches the default, and it was the one window the product could serve that no test covered.
 */
export function regimeFetchWindow(timeframe: string, nowMs: number): RegimeFetchWindow {
  const candleCount = servingWindowBars('market_regime', timeframe);
  const intervalMs = intervalMsFor(timeframe);
  if (candleCount === undefined || intervalMs === null) {
    throw new Error(`regimeFetchWindow: timeframe '${timeframe}' has no declared market_regime serving window (src/lib/serving-windows.ts)`);
  }
  return { candleCount, intervalMs, startTime: nowMs - candleCount * intervalMs };
}

export interface MarketRegimeCoreInput {
  coin: string;
  exchange: ExchangeId;
  timeframe: string;
  /** As fetched. Sorted IN PLACE (oldest-first), exactly as the tool always has. */
  candles: Candle[];
  /** The interval used for `startTime` — one interval per call, so window and split never disagree. */
  intervalMs: number;
  startTime: number;
  /** The instant the closed/partial split is judged at. */
  nowMs: number;
  candleBasis: CandleBasis;
}

/** The nine non-funding metric fields, in the tool's envelope key order. */
export interface MarketRegimeCoreMetrics {
  adx: number | null;
  adx_interpretation: string;
  adx_slope: number | null;
  adx_slope_interpretation: string;
  volatility_ratio: number;
  volatility_interpretation: string;
  price_structure: PriceStructureResult['structure'];
  pivot_quality: number;
  trend_strength: TrendStrength;
}

export interface MarketRegimeCore {
  regime: RegimeType;
  confidence: number;
  trendStrength: TrendStrength;
  slopeCategory: AdxSlopeCategory;
  /** Unrounded — the funding-sentiment threshold and the suggestion read it at full precision. */
  volatilityRatio: number;
  metrics: MarketRegimeCoreMetrics;
  /** Bars the classifier actually ran on (the closed window under CANDLE_BASIS=closed). */
  emittedCount: number;
  /**
   * Close time (ms) of the newest EMITTED bar = its open `time` + `intervalMs`, or null when no bar
   * was emitted. The sampler's per-coin window-truth backstop compares this with the venue's own
   * reference bar: a row is written only when the two agree.
   */
  lastEmittedBarCloseMs: number | null;
}

/**
 * Candles → the regime verdict and every non-funding metric field. Throws
 * `InsufficientCandlesError` (the tool's only refusal) when fewer than `REQUIRED_CANDLES` bars are
 * emitted; logs `FETCH_WINDOW_UNDERFED` when the venue reached back and the window is still short.
 */
export function computeMarketRegimeCore(input: MarketRegimeCoreInput): MarketRegimeCore {
  const { coin, exchange, timeframe, candles, intervalMs, startTime, nowMs, candleBasis } = input;

  // Everything below assumes oldest-first candles (closes[length-1] = current
  // price, structure/EMA walk forward); a newest-first venue payload would
  // invert the regime. No-op for ascending venues.
  candles.sort((a, b) => a.time - b.time);

  // ── SIGNAL-CLOSEDBAR-SHADOW-W1 CH3: the confirmed-bar basis, mirroring CH2. The
  //    sort immediately above is what guarantees ascending order, which is
  //    `splitCandleWindow`'s documented precondition. Named `candleWindow`, never
  //    `window`, which would shadow the DOM global.
  //    `intervalMs` is the SAME value used for `startTime` — one interval per
  //    call, so the fetch window and the bar split can never disagree.
  const candleWindow = splitCandleWindow(candles, intervalMs, nowMs);
  //    CANDLE_BASIS unset ⇒ 'live' ⇒ this IS `candles` ⇒ byte-identical to pre-wave.
  const emittedCandles = candleBasis === 'closed' ? candleWindow.closed : candles;

  if (emittedCandles.length < REQUIRED_CANDLES) {
    // Structured recovery hint: which finer timeframes already have enough
    // candles for this (usually newly-listed) symbol. `candles[0].time` is the
    // oldest candle in the fetched window ≈ the listing's first candle when the
    // listing is younger than the window.
    const firstCandleTimeMs = emittedCandles.length > 0 ? emittedCandles[0].time : nowMs;
    const suggestedTimeframes = computeSuggestedTimeframes({
      firstCandleTimeMs,
      nowMs,
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

  // ── SIGNAL-TREND-BLINDNESS-FIX-W1 CH1: the CONSTRUCTION-side floor ──
  //
  // A guard belongs where the corpus is CONSTRUCTED, not where it is OBSERVED. Two different
  // failures land in the 30-32 band and must never be conflated:
  //
  //   OUR fetch window is too small for this timeframe   -> a defect we own    -> REPORT it
  //   the SYMBOL is younger than the window we asked for -> not our defect     -> serve, and say so
  //
  // The discriminator is whether the venue actually reached back to `startTime`. A symbol with
  // sufficient history returns its oldest bar at ~`startTime`; a young listing's oldest bar is far
  // newer. Keyed on the EMITTED window per venue semantic — never on `CANDLE_COUNTS`, which is
  // blind to BOTH the boundary-bar skew and the closed-basis -1, i.e. blind to exactly the two
  // things that produced the 1d outage.
  //
  // This REPORTS and never refuses. `REQUIRED_CANDLES` above is the only refusal, and it is
  // unchanged: turning a served 30-32-bar listing into an error would be a coverage regression,
  // which is the inverse of a bugfix. The 2-interval slack absorbs one boundary bar plus one
  // exchange gap without calling a healthy window misconfigured.
  const oldestCandleMs = candles.length > 0 ? candles[0].time : nowMs;
  const windowReachedBack = oldestCandleMs <= startTime + 2 * intervalMs;
  const slopeUnderfed = emittedCandles.length < ADX_SLOPE_FLOOR;
  if (slopeUnderfed && windowReachedBack) {
    console.error(
      `[regime] FETCH_WINDOW_UNDERFED ${coin}/${exchange}/${timeframe}: ${emittedCandles.length} ` +
      `bars emitted after the closed-basis split, ADX-slope floor is ${ADX_SLOPE_FLOOR}. The venue ` +
      `reached startTime, so the fetch window is misconfigured — this is ours, not a young listing.`,
    );
  }

  // ── SIGNAL-CLOSEDBAR-SHADOW-W1 CH3: derive BOTH bases, select ONE. There is
  //    deliberately no single mutable "which candles" binding — that is precisely how
  //    a later edit silently moves the LIVE path; two named derivations and one
  //    selection cannot do that by accident. (Same shape as CH2.)
  const liveBasisIndicators = computeRegimeIndicators(candles);

  //    The closed pass runs ONLY when the closed basis is actually selected. It used to also
  //    run for the shadow (`candleShadowEnabled || …`); OPS-CANDLE-BASIS-SHADOW-DECOM-W1
  //    removed the shadow, so the disjunct went with it. This derivation is NOT shadow work
  //    and must never be deleted alongside one: under `CANDLE_BASIS=closed` — the live
  //    production setting since SIGNAL-CLOSEDBAR-FLIP-W1 — `closedBasisIndicators` IS the
  //    emitted regime, selected immediately below.
  let closedBasisIndicators: RegimeIndicators | null = null;
  if (candleBasis === 'closed') {
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
    } catch {
      //  Swallowed deliberately: `closedBasisIndicators` stays null and `emittedIndicators`
      //  below falls back to the live basis. The error CLASS used to be captured here for the
      //  shadow row's `error_class` column; with the shadow gone it had no reader, and a
      //  write-only variable is the residue OPS-CANDLE-BASIS-SHADOW-DECOM-W1 exists to remove.
      //
      //  Precise scope, because the obvious reading is wrong: the InsufficientCandles branch
      //  just above is UNREACHABLE under `CANDLE_BASIS=closed`, since the REQUIRED_CANDLES
      //  guard higher up reads `emittedCandles` — which IS the closed window — and throws
      //  first. It stays as a belt-and-braces isolation of the derivation; what this catch
      //  actually still absorbs is a genuine `computeRegimeIndicators` fault.
      //  Pinned by candle-basis-regime-wiring.test.ts "the guard follows the basis".
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
  const slopeCategory = categorizeSlope(adxSlope);

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
  // CH1 serve-side: a slope fitted to fewer than the full slopeLen+1 window is REPORTED as such,
  // never silently trusted and never withheld. Marking rides the existing interpretation string,
  // so no response field is added (`src/types.ts` is out of scope this wave) and no public value
  // is removed — `adx_slope` itself keeps its number, which Data Integrity requires.
  if (slopeUnderfed && adxSlope !== null) {
    adxSlopeInterpretation +=
      ` (reduced confidence — ${emittedCandles.length} bars available, ${ADX_SLOPE_FLOOR} needed for a full slope window)`;
  }

  let volInterpretation = 'Normal';
  if (volatilityRatio > 0.05) volInterpretation = 'Very high';
  else if (volatilityRatio > 0.03) volInterpretation = 'High';
  else if (volatilityRatio < 0.01) volInterpretation = 'Low';

  const lastEmitted = emittedCandles[emittedCandles.length - 1];

  return {
    regime,
    confidence,
    trendStrength,
    slopeCategory,
    volatilityRatio,
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
    },
    emittedCount: emittedCandles.length,
    lastEmittedBarCloseMs: lastEmitted ? lastEmitted.time + intervalMs : null,
  };
}
