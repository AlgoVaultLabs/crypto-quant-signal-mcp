import { getAdapter } from '../lib/exchange-adapter.js';
import { rsi, emaLast, ema, hurstExponent, detectSqueeze } from '../lib/indicators.js';
import { canAccessCoin, canAccessTimeframe, freeGateMessage, isFreeTier, checkQuota, trackCall, getUpgradeHint, getQuotaExhaustedMessage, getRequestSessionId, daysUntilMonthReset, getMonthlyQuota } from '../lib/license.js';
import { recordSignal, recordFunding, getFundingZScore, recordHoldCount } from '../lib/performance-db.js';
import { hashSignal } from '../lib/merkle.js';
import { getDexForCoin, classifyAsset, isMemeCoinLiquid, isKnownTradFi, getTop20ByOI } from '../lib/asset-tiers.js';
import { getVenuesSupporting, COVERAGE_PROBED_AT } from '../lib/venue-coverage.js';
import { TradFiSymbolUnsupportedOnVenueError, TierLimitReachedError, InsufficientCandlesError } from '../lib/errors.js';
import { referralCodeForKey } from '../lib/referral-store.js'; // REFERRAL-INPRODUCT-NUDGE-W1: keyed→code, keyless→null
import { resolveAssetClass } from '../lib/underlying-type.js';
import { classifyUnderlyingSession, isClosedState } from '../lib/market-sessions.js';
import { tradfiFundingAnnotation } from '../lib/tradfi-funding.js';
import { computeSuggestedTimeframes, suggestedActionFor } from '../lib/candle-guard.js';
import { withTierWarning, DEFAULT_UPGRADE_URL } from '../lib/tier-warning.js';
import { computeOiDelta, DEFAULT_OI_WINDOW_MS } from '../lib/oi-snapshots.js';
import { getVenueStatus } from '../lib/venue-shadow.js';
import { PKG_VERSION } from '../lib/pkg-version.js';
import { getClosestTradeable, getTryNext } from '../lib/cross-asset-grid.js';
import { trimToLeaderboardCell } from '../lib/leaderboard-cell.js';
import { formatReceipts } from '../lib/receipts.js';
import { getReceiptTrackRecord } from '../lib/receipts-track-record.js';
import type { TradeCallResult, SignalVerdict, EmaCrossDirection, RegimeType, LicenseInfo, ExchangeId } from '../types.js';
import {
  bucketTrendPersistence, bucketFundingState, bucketBreakoutPending,
  regimeProse, fundingProse, breakoutProse, trendProse, convictionProse,
} from '../lib/indicator-buckets.js';
import { getThresholdForTF } from '../lib/pertf-thresholds.js';
import { getR4Thresholds } from '../lib/r4-relax-flag.js';

interface TradeSignalInput {
  coin: string;
  timeframe?: string;
  includeReasoning?: boolean;
  exchange?: ExchangeId;
  license?: LicenseInfo;
  /**
   * Internal mode: bypass license gates (so the cross-asset grid can score
   * cells outside the caller's tier), skip quota tracking, performance-db
   * `recordSignal` / `recordHoldCount` persistence, and the upgrade-hint
   * envelope fields. Used exclusively by `src/lib/cross-asset-grid.ts` when
   * refreshing the 24-cell grid — those cells are server-side-computed and
   * must not pollute the per-agent quota counters or the track-record DB.
   * External callers never set this.
   */
  internal?: boolean;
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
// RSI(100)*0.30 + EMA(100)*0.10 + Funding(80)*0.25 + OI(60)*0.15 + Vol(100)*0.20 = 30+10+20+9+20 = 89
// (R1 from generator audit 2026-04-14: prior value 74 was computed from the wrong per-feature maxes,
//  which inflated every confidence output by ~1.20× and clipped the high tail to 100)
const MAX_RAW_SCORE = 89;

// Minimum confidence to record in track record (filters noise)
// R6 (2026-04-15): lowered 60 → 52 after R1 MAX_RAW_SCORE fix to preserve pre-R1
// effective rawScore floor (~44.4). Pre-R1 raw floor = 60/1.351 = 44.4; post-R1 under
// new denominator 89, same rawScore 44.4 → confidence 50, so setting gate to 52 keeps
// a thin noise margin while recovering ~95% of pre-fix persistence volume. See
// experiments/quant-trading-server/phase-c-results.md.
const MIN_TRACKABLE_CONFIDENCE = 52;


export async function getTradeSignal(input: TradeSignalInput): Promise<TradeCallResult> {
  const coin = input.coin.toUpperCase();
  const timeframe = input.timeframe || '1h';
  const includeReasoning = input.includeReasoning !== false;

  // License gate — bypassed for internal grid-refresh calls so the 24-cell
  // grid can score cells across all assets and timeframes regardless of the
  // ambient request's tier.
  if (!input.internal) {
    if (!canAccessCoin(coin, input.license) || !canAccessTimeframe(timeframe, input.license)) {
      const msg = freeGateMessage(coin, timeframe);
      throw new Error(msg);
    }
  }

  // Quota gate (read-only check — actual increment happens after we know the verdict,
  // because HOLD signals are free and shouldn't count against quota).
  // Internal grid-refresh calls skip quota entirely — they are server-side
  // pre-computation, not per-agent usage.
  const quota = input.internal
    ? { allowed: true, used: 0, total: 0 }
    : checkQuota(input.license || { tier: 'free', key: null });
  if (!quota.allowed) {
    const licenseForReset = input.license || { tier: 'free' as const, key: null };
    throw new TierLimitReachedError({
      currentUsage: quota.used,
      monthlyLimit: quota.total,
      tier: licenseForReset.tier,
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter&utm_source=mcp_tool&utm_campaign=tier_limit_reached',
      retryAfterDays: daysUntilMonthReset(licenseForReset),
      referralCode: referralCodeForKey(licenseForReset.key),
    });
  }

  const exchange = input.exchange || 'BINANCE';

  // Venue-coverage gate (TRADFI-SYMBOL-ALIAS-W1 / v1.11.1): if the coin is a
  // known TradFi symbol AND the requested venue does NOT carry it (per the
  // static coverage matrix derived from live CEX exchangeInfo probes), throw
  // a structured `TRADFI_SYMBOL_UNSUPPORTED_ON_VENUE` error with
  // `suggested_venues` so LLM agents can self-retry instead of seeing a raw
  // `400 Bad Request` from the upstream API. Crypto majors / alts / memes
  // fall through unchanged — adapter-level errors still bubble up generically.
  if (isKnownTradFi(coin)) {
    const supported = getVenuesSupporting(coin);
    if (!supported.includes(exchange)) {
      throw new TradFiSymbolUnsupportedOnVenueError(coin, exchange, supported, COVERAGE_PROBED_AT);
    }
  }

  // Determine which HL dex this coin trades on (standard vs xyz/TradFi)
  // Only applicable for Hyperliquid — Binance doesn't have dex types
  const dex = exchange === 'HL' ? getDexForCoin(coin) : undefined;

  // Meme coin liquidity gate — reject illiquid micro-caps before wasting API calls.
  // OPS-3M-EXPAND-W1 (2026-05-22): outer `if (exchange === 'HL')` guard REMOVED;
  // gate now runs for ALL 17 ExchangeId values uniformly via per-exchange-AND
  // semantics in isMemeCoinLiquid. Shadow venues (12 of 17) short-circuit TRUE
  // at the gate level pending per-venue promotion to PUBLIC tier.
  //
  // OPS-TIER4-CLASSIFY-W1 (2026-05-22): pass the actual top-20-by-HL-OI set
  // (1h-cached via getTop20ByOI) instead of the hardcoded `null` that
  // short-circuited the Tier-2 branch inside classifyAsset. Without this,
  // every major-alt coin (anything not TIER_1/TradFi/MEME_KNOWN) defaulted
  // to Tier 4 + routed through isMemeCoinLiquid — incorrectly rejecting
  // top-20-by-OI coins (e.g. AVAX rank 16, LINK rank 17) as "illiquid
  // micro-caps". Steady-state cost: 1h cache hit ≈ free. Cold-start path
  // has static FALLBACK_TOP20 inside getTop20ByOI so this never blocks.
  const top20 = await getTop20ByOI();
  const tier = classifyAsset(coin, top20, exchange); // venue-aware: a CEX tokenized stock won't be wrongly meme-gated (OPS-TIER-CLASSIFIER-XVENUE-W1)
  if (tier === 4) {
    const liquid = await isMemeCoinLiquid(coin, exchange);
    if (!liquid) {
      throw new Error(
        `Signal generation unavailable for ${coin} on ${exchange}: not in ${exchange}'s top-50 by OI ` +
        `or <$10M 24h volume on ${exchange}. TA signals are unreliable for illiquid micro-caps.`
      );
    }
  }

  const adapter = getAdapter(exchange);

  // Fetch candles (100 candles back)
  const intervalMs = getIntervalMs(timeframe);
  const startTime = Date.now() - 100 * intervalMs;
  const [candles, assetCtx] = await Promise.all([
    adapter.getCandles(coin, timeframe, startTime, dex),
    adapter.getAssetContext(coin, dex),
  ]);
  // Everything below assumes oldest-first candles (closes[length-1] = current
  // price, indicators walk forward); a newest-first venue payload would price
  // the signal at the stalest close. No-op for ascending venues.
  candles.sort((a, b) => a.time - b.time);

  const REQUIRED_CANDLES = 30;
  if (candles.length < REQUIRED_CANDLES) {
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

  // ── Underlying-market session + TradFi funding interpretation
  //    (TRADIFI-SIGNAL-HARDENING-W1). Best-effort; resolveAssetClass never
  //    throws and fails open to UNKNOWN (renders no caveat / no note). ──
  const assetClass = await resolveAssetClass(coin, exchange);
  const session = assetClass === 'UNKNOWN'
    ? { state: 'UNKNOWN' as const, note: '' }
    : classifyUnderlyingSession({ assetClass, at: new Date() });
  const fundingAnnotation = tradfiFundingAnnotation(assetClass);

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
  // R2: raw rate is kept for display/API compat and for scale-invariant per-coin Z-score history.
  //     Annualized rate is used by the scorer so HL (1h) and CEX (8h) feeds are comparable.
  const fundingRate = assetCtx.funding;
  const fundingRateAnnualized = assetCtx.fundingAnnualized;
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
  try { recordFunding(coin, fundingRate); } catch (e) { console.debug('recordFunding failed:', e instanceof Error ? e.message : e); }
  // Fetch Z-Score (async — may return null if < 20 data points)
  let fundingZScore: number | null = null;
  try { fundingZScore = await getFundingZScore(coin, fundingRate); } catch (e) { console.debug('getFundingZScore failed:', e instanceof Error ? e.message : e); }

  // R4: pre-IPO funding is administratively FIXED, not a z-score-bucketed
  // sentiment read — override the bucket for PREMARKET. EQUITY/COMMODITY keep
  // their (structurally-small) z-score bucket but gain an interpretation note.
  const fundingState = fundingAnnotation.fundingStateOverride ?? bucketFundingState(fundingZScore);

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
  // R2: thresholds are in ANNUALIZED rate (cost of carry as % per year).
  //     Old HL-calibrated raw thresholds { -0.0005, 0, 0.0005, 0.001 } × 8760 = { -4.38, 0, 4.38, 8.76 }.
  //     This preserves HL behavior exactly while making CEX 8h funding directly comparable.
  let fundingScore = 0;
  if (fundingRateAnnualized < -4.38) fundingScore = 80;
  else if (fundingRateAnnualized < 0) fundingScore = 40;
  else if (fundingRateAnnualized > 8.76) fundingScore = -80;
  else if (fundingRateAnnualized > 4.38) fundingScore = -40;

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
  // OPS-TRADE-CALL-CLUSTER-W1 CH2 — R4 RELAX 2-flag firewall (ENABLE_R4_RELAX + R4_RELAX_DIRECTION).
  // Both unset → fallback to current R4-on thresholds {buyPenaltyZ: 2.5, sellSofteningZ: -2.0}.
  // Architect flips via follow-up OPS-TRADE-CALL-R4-ROLLOUT-W<N> wave.
  const r4Thresholds = getR4Thresholds();
  const scoreAdjustments: string[] = [];
  if (fundingZScore !== null) {
    // Z-Score available: use statistical extremity for crowd-positioning gate
    // R4: inverted per audit — BUY edge +10-14pp WR. BUY penalty threshold made stricter
    // (2.0 → 2.5) so BUY is penalized less often, while SELL softening threshold is made
    // looser (-2.5 → -2.0) so SELL is softened more often. Net: favors BUY direction.
    if (rawScore > 0 && fundingZScore > r4Thresholds.buyPenaltyZ) {  // R4 firewall: penalty threshold from getR4Thresholds()
      rawScore -= 20;
      scoreAdjustments.push(`Funding Z-Score ${fundingZScore.toFixed(2)} (>+${r4Thresholds.buyPenaltyZ}) — extreme crowded longs. BUY penalized 20 pts.`);
    }
    if (rawScore < 0 && fundingZScore < r4Thresholds.sellSofteningZ) {  // R4 firewall: softening threshold from getR4Thresholds()
      rawScore += 20;
      scoreAdjustments.push(`Funding Z-Score ${fundingZScore.toFixed(2)} (<${r4Thresholds.sellSofteningZ}) — extreme short crowding. SELL softened 20 pts.`);
    }
    if (rawScore > 0 && fundingZScore < -1.5) {
      rawScore += 10;
      scoreAdjustments.push(`Funding Z-Score ${fundingZScore.toFixed(2)} (<-1.5) — contrarian bullish. BUY bonus +10 pts.`);
    }
  } else {
    // Fallback: raw funding gate (pre-Z-Score history)
    // R4: inverted per audit — BUY edge +10-14pp WR. Original rule penalized BUY at
    // crowded-long funding (no symmetric SELL rule = compounding SELL bias). Flipped:
    // crowded longs now soften SELL (squeeze risk), and the BUY contrarian bonus stays.
    if (rawScore < 0 && fundingRateAnnualized > 4.38) {  // R4: inverted per audit — BUY edge +10-14pp WR
      rawScore += 15;
      scoreAdjustments.push(`Funding annualized +${fundingRateAnnualized.toFixed(2)} — longs crowded, squeeze risk. SELL softened 15 pts (raw fallback, R4 inverted).`);
    }
    if (rawScore > 0 && fundingRateAnnualized < -4.38) {
      rawScore += 10;
      scoreAdjustments.push(`Funding annualized ${fundingRateAnnualized.toFixed(2)} (<-4.38) — contrarian BUY bonus +10 pts (raw fallback).`);
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

  // ── R4: inverted per audit — BUY edge +10-14pp WR ──
  // v1.5 had BUY gated in {TRENDING_DOWN} and SELL gated in {TRENDING_UP, RANGING}.
  // Audit showed the BUY edge is real market structure (short squeezes), so we lean in:
  //   BUY always uses BUY_BASE_THRESHOLD (never gated, any regime)
  //   SELL always uses SELL_THRESHOLD_GATED (always gated, any regime)
  // This gives BUY a consistent 15-point structural advantage (40 vs 55).
  let signal: SignalVerdict;
  const absScore = Math.abs(rawScore);

  // OPS-TRADE-CALL-CLUSTER-W1 CH1 — per-TF threshold lookup behind 2-flag firewall.
  // Outer ENABLE_PERTF_THRESHOLDS + per-TF inner ENABLE_PERTF_<TF>. Both unset →
  // fallback to BUY_BASE_THRESHOLD=40 / SELL_THRESHOLD_GATED=55 (zero behavioral change).
  // Architect flips per-TF via follow-up OPS-TRADE-CALL-PERTF-ROLLOUT-W<N> wave.
  const buyThreshold = getThresholdForTF(timeframe, 'buy', BUY_BASE_THRESHOLD);
  const sellThreshold = getThresholdForTF(timeframe, 'sell', SELL_THRESHOLD_GATED);

  if (rawScore > 0) {
    // R4: inverted per audit — BUY edge +10-14pp WR. BUY never gated.
    signal = rawScore > buyThreshold ? 'BUY' : 'HOLD';
  } else {
    // R4: inverted per audit — BUY edge +10-14pp WR. SELL always gated (stricter).
    signal = absScore > sellThreshold ? 'SELL' : 'HOLD';
  }

  // ── Confidence: scale rawScore to 0-100 range properly ──
  const confidence = Math.min(Math.round((absScore / MAX_RAW_SCORE) * 100), 100);

  // OPS-TRADE-CALL-CLUSTER-W1 CH5 (2026-05-28) — OPS-TRADE-CALL-CALIBRATION-AUDIT-W1
  // R3 confidence-bucket logger RETIRED. Code-side strip lands today; Hetzner-side
  // env-strip + logrotate-strip + container force-recreate scheduled for
  // 2026-06-04T06:00:00Z (7d capture window honored per Plan-Mode #6 Path B
  // ratification). Captured logs preserved at /var/log/algovault-seed-confidence
  // /*.log.gz via logrotate weekly rotation.

  // ── v1.10.0 Sanitized Reasoning ──
  // Closes moat-1 (composite-verdict quant-weighting) leakage. The previous
  // builder echoed raw indicators ("RSI at 34.7", "Hurst 0.612 (>0.55)",
  // "Funding Z-Score: -1.82", "Confidence: 73%", "Regime: TRENDING_UP",
  // "boosted 10 pts") — every one of those is now blocklisted by the C3
  // forbidden-regex test and would let an attacker reverse-engineer the
  // weighting function. New template: bucket-name + direction prose only.
  // Pure deterministic given inputs; no LLM, no randomness.
  let reasoning = '';
  if (includeReasoning) {
    const tp = bucketTrendPersistence(hurstVal);
    const fs = fundingState;
    const bp = bucketBreakoutPending(squeezeActive);
    reasoning = [
      regimeProse(regime),
      fundingProse(fs),
      breakoutProse(bp),
      trendProse(tp),
      convictionProse(signal, confidence),
    ].join(' ').replace(/\s+/g, ' ').trim();
    // R3: when the underlying cash market is closed, candles reflect a capped
    // synthetic index — append a provisional-regime caveat (no number, so it
    // stays clean against the forbidden-regex reasoning blocklist).
    if (isClosedState(session.state)) {
      reasoning += ' Underlying market closed — candles reflect capped synthetic pricing; treat directional reads as provisional until reopen.';
    }
  }

  // Increment quota counter only for non-HOLD (HOLDs are free).
  // Internal grid-refresh calls skip the counter entirely.
  const license = input.license || { tier: 'free' as const, key: null };
  if (!input.internal && signal !== 'HOLD') {
    trackCall(license);
  }

  // Upgrade hint: only for free tier, never for HOLD signals, never for
  // internal grid-refresh calls (their meta block is discarded anyway).
  const upgradeHint = !input.internal && signal !== 'HOLD'
    ? getUpgradeHint(license, { used: quota.used, total: quota.total })
    : undefined;

  // EXCHANGE-SHADOW-PROMOTE-W1 / C2: venue lifecycle status surfaced in every
  // tool response envelope. `'promoted'` for the 5 production venues; `'shadow'`
  // for experimental venues onboarded under the SHADOW-PROMOTE state machine.
  // Defaults to `'promoted'` for unknown venues (backward-compat).
  const venueStatus = await getVenueStatus(exchange);

  let meta: TradeCallResult['_algovault'] = {
    version: PKG_VERSION,
    tool: 'get_trade_call',
    compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-backtest-mcp'],
    session_id: getRequestSessionId() ?? null,
    exchange,
    venue_status: venueStatus,
  };
  if (upgradeHint) meta.upgrade_hint = upgradeHint;
  // ACTIVATION-PAYWALL-W1: structured tier_warning at 75%+ / 90%+ thresholds for
  // free-tier (paid + bot-internal + internal-grid-refresh paths are no-op via
  // withTierWarning's internal gate).
  if (!input.internal) {
    meta = withTierWarning(meta, {
      tier: license.tier,
      currentUsage: quota.used,
      monthlyLimit: quota.total || getMonthlyQuota(license.tier),
      isBotInternal: license.tier === 'internal',
      upgradeUrl: DEFAULT_UPGRADE_URL,
    });
  }

  // v1.10.0: `call` is the canonical verdict field. The legacy `signal` field
  // and all 7 raw indicators (rsi/ema_cross/ema_9/ema_21/hurst/funding_z_score/
  // squeeze_active) are stripped in this chapter — agents reading the response
  // see only the bucketed surface (closes moat-1 quant-weighting leakage).
  // SCAN-RANKBY-W3: oi_change_pct now reads the REAL OI delta from the oi_snapshots
  // store (computeOiDelta — the SAME source the oi_change lens reads → single-derivation),
  // NOT the old priceChange×100 proxy (CH1: that was a 24h PRICE change mislabeled as OI;
  // BTC live showed "OI +1.4% bullish" while real OI fell −1.0%). OMITTED while the store
  // is warming (< 2 snapshots spanning 24h) — omission beats a wrong sign. Fail-soft: a
  // store error never breaks the verdict. The internal verdict scoring (oiScore, ~L307,
  // also priceChange-derived) is UNCHANGED → call/confidence byte-identical.
  let oiDelta: Awaited<ReturnType<typeof computeOiDelta>> = null;
  try {
    oiDelta = await computeOiDelta(coin, exchange, DEFAULT_OI_WINDOW_MS);
  } catch {
    /* oi_snapshots unavailable → omit the OI factor; never break the verdict */
  }
  // Indicators key-order: funding_rate, funding_24h_avg, funding_state,
  // oi_change_pct (+ oi_change_window) [omitted while warming], volume_24h, trend_persistence, breakout_pending.
  const result: TradeCallResult = {
    call: signal,
    confidence,
    price: currentPrice,
    indicators: {
      funding_rate: fundingRate,
      funding_24h_avg: funding24hAvg,
      funding_state: fundingState,
      ...(oiDelta ? { oi_change_pct: oiDelta.oi_change_pct, oi_change_window: oiDelta.oi_change_window } : {}),
      volume_24h: volume24h,
      trend_persistence: bucketTrendPersistence(hurstVal),
      breakout_pending: bucketBreakoutPending(squeezeActive),
      underlying_session: session.state,
      ...(fundingAnnotation.fundingNote ? { funding_note: fundingAnnotation.fundingNote } : {}),
    },
    regime,
    reasoning,
    timestamp: Math.floor(Date.now() / 1000),
    coin,
    timeframe,
    _algovault: meta,
  };

  // P0 VERDICT-WITH-RECEIPTS-W1: attach the inline-proof block. Single-derivation —
  // `formatReceipts` projects from the verdict JUST computed (never re-derives the
  // call) and reads the cached in-process track record (omitted fail-open when the
  // source is momentarily unavailable). Skipped for internal grid-refresh cells,
  // which are trimmed to leaderboard cells downstream and never user-facing.
  if (!input.internal) {
    result._receipts = formatReceipts(result, { trackRecord: getReceiptTrackRecord() });
  }

  // v1.9.0 L2 + L4: HOLD rescue + next-calls hints.
  // Both features read from the same lazy, TTL-cached cross-asset grid. The
  // grid self-refreshes via a promise-coalesced single-flight and silently
  // absorbs per-cell scorer failures, so failures here never degrade the
  // primary response. Fields are OMITTED (not null/[]) when the grid has no
  // matching cell — matches the AlgoVault positioning rule: these are signal
  // surfaces, not trade recommendations.
  //
  // Skipped for internal grid-refresh calls — the AsyncLocalStorage re-entry
  // guard in getGridSnapshot would short-circuit anyway, but guarding at the
  // call site avoids the unnecessary indirection and keeps cell computation
  // leaner.
  if (!input.internal) {
    try {
      const tryNext = await getTryNext({ coin, timeframe }, 3);
      // v1.10.0: `also_see` is the only cross-asset-leaderboard surface;
      // legacy `try_next` field stripped per spec OUTPUT-SANITIZE-W1 C5.
      if (tryNext.length > 0) {
        result.also_see = tryNext.map(trimToLeaderboardCell);
      }
      if (signal === 'HOLD') {
        const closest = await getClosestTradeable({ coin, timeframe });
        if (closest) result.closest_tradeable = trimToLeaderboardCell(closest);
      }
    } catch (e) {
      console.debug('cross-asset-grid enrichment failed:', e instanceof Error ? e.message : e);
    }
  }

  // Record for performance tracking — only high-confidence actionable signals.
  // Internal grid-refresh calls skip persistence entirely so the 24-cell-per-
  // minute grid doesn't pollute the signals / hold_counts tables with
  // duplicate synthetic records.
  if (!input.internal) {
    if (signal !== 'HOLD' && confidence >= MIN_TRACKABLE_CONFIDENCE) {
      try {
        const sigHash = hashSignal({
          coin, signal: signal as 'BUY' | 'SELL', confidence, timeframe,
          timestamp: Math.floor(Date.now() / 1000), price: currentPrice,
        });
        recordSignal(coin, signal, confidence, timeframe, currentPrice, sigHash, exchange, regime);
      } catch (e) {
        console.debug('recordSignal failed:', e instanceof Error ? e.message : e);
      }
    } else if (signal === 'HOLD') {
      try {
        recordHoldCount(coin, timeframe);
      } catch (e) {
        console.debug('recordHoldCount failed:', e instanceof Error ? e.message : e);
      }
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
