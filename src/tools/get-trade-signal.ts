import { getAdapter } from '../lib/exchange-adapter.js';
import { rsi, emaLast, ema, hurstExponent, detectSqueeze } from '../lib/indicators.js';
import { canAccessCoin, canAccessTimeframe, freeGateMessage, isFreeTier, checkQuota, trackCall, getUpgradeHint, getQuotaExhaustedMessage, getRequestSessionId } from '../lib/license.js';
import { recordSignal, recordFunding, getFundingZScore, recordHoldCount } from '../lib/performance-db.js';
import { hashSignal } from '../lib/merkle.js';
import { getDexForCoin, classifyAsset, isMemeCoinLiquid } from '../lib/asset-tiers.js';
import { PKG_VERSION } from '../lib/pkg-version.js';
import { getClosestTradeable, getTryNext } from '../lib/cross-asset-grid.js';
import type { TradeSignalResult, TrackRecord, SignalVerdict, EmaCrossDirection, RegimeType, LicenseInfo, ExchangeId } from '../types.js';

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

// ── Phase E validated track record (L1 activation, 2026-04-17) ──
// Static snapshot from the Phase E gate re-run. All numbers from
// experiments/quant-trading-server/phase-e-results.md §e.
// Embedded at module scope (allocated once, not per-call) so every
// get_trade_signal response includes the scorer's proven accuracy.
const TRACK_RECORD: TrackRecord = {
  measurement_window: {
    start: '2026-04-15T02:21:53Z',
    end: '2026-04-17T11:01:17Z',
    elapsed_hours: 56.65,
    total_signals: 3380,
    resolved_signals: 3013,
  },
  overall: {
    win_rate_pct: 55.8,
    wins: 1681,
    losses: 1332,
    avg_return_pct: null,  // per-exchange only; no aggregate avg return in Phase E
  },
  by_confidence_band: [
    { band: '[52,55]', resolved: 1317, wins: 735, losses: 582, win_rate_pct: 55.8 },
    { band: '[56,59]', resolved: 454,  wins: 259, losses: 195, win_rate_pct: 57.0 },
    { band: '[60+]',   resolved: 1242, wins: 687, losses: 555, win_rate_pct: 55.3 },
  ],
  by_exchange: [
    { exchange: 'BINANCE', resolved: 342,  wins: 192, win_rate_pct: 56.1, avg_return_pct: 1.074 },
    { exchange: 'BITGET',  resolved: 282,  wins: 156, win_rate_pct: 55.3, avg_return_pct: 0.340 },
    { exchange: 'BYBIT',   resolved: 1035, wins: 569, win_rate_pct: 55.0, avg_return_pct: 0.225 },
    { exchange: 'HL',      resolved: 175,  wins: 95,  win_rate_pct: 54.3, avg_return_pct: 0.228 },
    { exchange: 'OKX',     resolved: 1179, wins: 669, win_rate_pct: 56.7, avg_return_pct: 0.624 },
  ],
  note: 'Full stats available via signal-performance resource. Phase E validated 2026-04-17.',
};

export async function getTradeSignal(input: TradeSignalInput): Promise<TradeSignalResult> {
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
    throw new Error(getQuotaExhaustedMessage(quota.used, quota.total));
  }

  const exchange = input.exchange || 'HL';

  // Determine which HL dex this coin trades on (standard vs xyz/TradFi)
  // Only applicable for Hyperliquid — Binance doesn't have dex types
  const dex = exchange === 'HL' ? getDexForCoin(coin) : undefined;

  // Meme coin liquidity gate — reject illiquid micro-caps before wasting API calls
  // Only applicable for HL where we have tier data
  if (exchange === 'HL') {
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
  }

  const adapter = getAdapter(exchange);

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
  const scoreAdjustments: string[] = [];
  if (fundingZScore !== null) {
    // Z-Score available: use statistical extremity for crowd-positioning gate
    // R4: inverted per audit — BUY edge +10-14pp WR. BUY penalty threshold made stricter
    // (2.0 → 2.5) so BUY is penalized less often, while SELL softening threshold is made
    // looser (-2.5 → -2.0) so SELL is softened more often. Net: favors BUY direction.
    if (rawScore > 0 && fundingZScore > 2.5) {  // R4: inverted per audit — BUY edge +10-14pp WR
      rawScore -= 20;
      scoreAdjustments.push(`Funding Z-Score ${fundingZScore.toFixed(2)} (>+2.5) — extreme crowded longs. BUY penalized 20 pts.`);
    }
    if (rawScore < 0 && fundingZScore < -2.0) {  // R4: inverted per audit — BUY edge +10-14pp WR
      rawScore += 20;
      scoreAdjustments.push(`Funding Z-Score ${fundingZScore.toFixed(2)} (<-2.0) — extreme short crowding. SELL softened 20 pts.`);
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

  if (rawScore > 0) {
    // R4: inverted per audit — BUY edge +10-14pp WR. BUY never gated.
    signal = rawScore > BUY_BASE_THRESHOLD ? 'BUY' : 'HOLD';
  } else {
    // R4: inverted per audit — BUY edge +10-14pp WR. SELL always gated (stricter).
    signal = absScore > SELL_THRESHOLD_GATED ? 'SELL' : 'HOLD';
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
    if (fundingRateAnnualized < -4.38) parts.push('Strong negative funding — shorts paying longs (contrarian bullish).');
    else if (fundingRateAnnualized < 0) parts.push('Negative funding — shorts paying longs.');
    else if (fundingRateAnnualized > 8.76) parts.push('High positive funding — crowded longs (contrarian bearish).');
    else if (fundingRateAnnualized > 4.38) parts.push('Positive funding — longs paying shorts.');
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
    // R4: SELL always gated, so a sub-gate SELL is suppressed in any regime
    if (signal === 'HOLD' && rawScore < -BUY_BASE_THRESHOLD && rawScore > -SELL_THRESHOLD_GATED) {
      parts.push(`Direction gate: potential SELL suppressed — SELL requires ${SELL_THRESHOLD_GATED}+ score (got ${absScore.toFixed(0)}). BUY edge asymmetry (R4).`);
    }
    // v1.3: noise warning for ultra-low timeframes
    if (['1m', '3m'].includes(timeframe)) {
      parts.push(`Ultra-low timeframe warning: RSI/EMA indicators have minimal lookback on ${timeframe} candles. Signals may be noisier than longer timeframes. Consider 5m+ for higher reliability.`);
    }
    parts.push(`Confidence: ${confidence}%. Regime: ${regime}.`);
    reasoning = parts.join(' ');
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

  const meta: TradeSignalResult['_algovault'] = {
    version: PKG_VERSION,
    tool: 'get_trade_signal',
    compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-backtest-mcp'],
    session_id: getRequestSessionId() ?? null,
  };
  if (upgradeHint) meta.upgrade_hint = upgradeHint;

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
    _algovault: meta,
  };

  // L1 activation: attach Phase E validated track record to every response.
  result.track_record = TRACK_RECORD;

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
      if (tryNext.length > 0) result.try_next = tryNext;

      if (signal === 'HOLD') {
        const closest = await getClosestTradeable({ coin, timeframe });
        if (closest) result.closest_tradeable = closest;
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
