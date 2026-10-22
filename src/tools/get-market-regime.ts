import { getAdapter } from '../lib/exchange-adapter.js';
import { assertVenueNotRetired } from '../lib/venue-store.js';
import { isKnownTradFi } from '../lib/asset-tiers.js';
import { getVenuesSupporting, COVERAGE_PROBED_AT } from '../lib/venue-coverage.js';
import { TradFiSymbolUnsupportedOnVenueError, TierLimitReachedError, UpstreamRateLimitError } from '../lib/errors.js';
import { referralCodeForKey } from '../lib/referral-store.js'; // REFERRAL-INPRODUCT-NUDGE-W1: keyed→code, keyless→null
import { resolveAssetClass } from '../lib/underlying-type.js';
import { classifyUnderlyingSession, isClosedState } from '../lib/market-sessions.js';
import { fetchTradFiFundingByVenue, normalizeTo8h, computeTradFiFundingSentiment, buildFundingByVenue } from '../lib/tradfi-funding.js';
import { computeMarketRegimeCore, regimeFetchWindow } from '../lib/market-regime-core.js';
import { getCandleBasis } from '../lib/candle-basis-flag.js';
import { getVenueStatus } from '../lib/venue-shadow.js';
import { checkQuota, trackCall, getUpgradeHint, getRequestSessionId, getMonthlyQuota, monthResetAtMs, periodStartMs, utcDayResetAtMs, setRequestRegimeFundingDegraded } from '../lib/license.js';
import { withTierWarning, withQuotaState, withAuthState, DEFAULT_UPGRADE_URL } from '../lib/tier-warning.js';
import { PKG_VERSION } from '../lib/pkg-version.js';
import type { MarketRegimeResult, RegimeType, TrendStrength, CrossVenueFundingSentiment, AdxSlopeCategory, LicenseInfo, ExchangeId } from '../types.js';
import { compatibleWith } from '../lib/primitive-projection.js';

interface MarketRegimeInput {
  coin: string;
  timeframe?: string;
  exchange?: ExchangeId;
  license?: LicenseInfo;
}

// SCAN-MARKET-REGIMES-W1-V2 CH1: the pure regime derivation — the window constants, the indicator
// derivation, the classifier and its projection — moved VERBATIM to src/lib/market-regime-core.ts,
// which the regime snapshot sampler shares (single derivation). Re-exported so every existing
// importer of this module is unchanged.
export {
  CANDLE_COUNTS,
  ADX_SLOPE_FLOOR,
  computeRegimeIndicators,
  classifyRegime,
  projectRegime,
} from '../lib/market-regime-core.js';
export type { RegimeIndicators, RegimeClassification, RegimeClassifierInputs } from '../lib/market-regime-core.js';

export async function getMarketRegime(input: MarketRegimeInput): Promise<MarketRegimeResult> {
  const coin = input.coin.toUpperCase();
  const timeframe = input.timeframe || '4h';
  const license = input.license || { tier: 'free' as const, key: null, outcome: 'ABSENT' as const };

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
    // OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1 CH2 (instance 9): ONE discriminator for both the
    // `wall` noun and the horizon under it. See the fuller note at the same site in
    // get-trade-call.ts; the shape is scan-trade-calls.ts's, reused verbatim.
    const isDailyWall = gate.limit === 'daily';
    throw new TierLimitReachedError({
      currentUsage: gate.used,
      monthlyLimit: gate.total,
      tier: license.tier,
      suggestedUpgradeUrl: 'https://api.algovault.com/signup?plan=starter&utm_source=mcp_tool&utm_campaign=tier_limit_reached',
      resetAtMs: isDailyWall ? utcDayResetAtMs() : monthResetAtMs(license),
      periodStartMs: periodStartMs(license),
      referralCode: referralCodeForKey(license.key),
      tool: 'get_market_regime', // FUNNEL-FIX-AGENT-X402-NUDGE-W1: enables the suggested_x402 branch
      // CH1: the wall discriminator + the DAILY pair travel WITH the refusal. Passing
      // `limit` alone would let a daily wall render the monthly numbers again, which is the
      // defect this closes — so the three move together, from the ONE `checkQuota` result.
      wall: isDailyWall ? 'daily' : 'monthly',
      dailyUsed: gate.daily_used,
      dailyLimit: gate.daily_total,
    });
  }
  const quota = trackCall(license);

  // The fetch window (lookback bars × interval, the serving-window registry's market_regime row) is
  // the core's: the sampler asks for exactly the same window, so a snapshot row and this response
  // are computed from the same bars. A window the venue serves stale is refused inside getCandles
  // below (StaleUpstreamWindowError, the getAdapter seam) and reaches the caller as its structured
  // payload through the pipeline's toolErrorContent.
  const { intervalMs, startTime } = regimeFetchWindow(timeframe, Date.now());

  const exchange = input.exchange || 'HL';

  // Retired-venue gate (OPS-BITMART-RETIRE-W1 Q3): decline a wound-down venue by name before its
  // dead adapter is touched. get_market_regime has no internal grid path, so this always enforces.
  await assertVenueNotRetired(exchange);

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

  // Fetch candles from selected exchange + cross-venue fundings from HL (best-effort)
  const hlAdapter = getAdapter('HL');
  const [candles, allFundings] = await Promise.all([
    adapter.getCandles(coin, timeframe, startTime),
    // OPS-HL-INTERACTIVE-STARVATION-W1: this `.catch` is BEST-EFFORT BY DESIGN and stays that way —
    // a cross-venue funding outage must not fail a regime call. What changes is that the swallow is
    // no longer SILENT. An `UpstreamRateLimitError` here is HL refusing us (weight-budget
    // `BUDGET_CEILING` on the interactive reserve, `upstream-weight-budget.ts:233`), and it
    // degrades the response to `cross_venue_funding_sentiment: 'NEUTRAL'` +
    // `'Insufficient cross-venue data'` — byte-identical to a coin that genuinely has no HL
    // funding. Stamping the ALS separates those two, which is the only reason a call-level failure
    // rate is computable at all. The RESPONSE is deliberately unchanged (CH2 asserts identity);
    // only `request_log.verdict` learns the difference.
    //
    // Non-rate-limit failures are left unstamped rather than lumped in: a parse error and a budget
    // refusal are different events, and one column that means "something went wrong" would rebuild
    // the very conflation this wave exists to remove.
    hlAdapter.getPredictedFundings().catch((e: unknown) => {
      if (e instanceof UpstreamRateLimitError) setRequestRegimeFundingDegraded();
      return [] as Awaited<ReturnType<typeof adapter.getPredictedFundings>>;
    }),
  ]);
  // SCAN-MARKET-REGIMES-W1-V2 CH1: sort → closed-basis split → the REQUIRED_CANDLES refusal →
  // the FETCH_WINDOW_UNDERFED report → both-basis indicators → currentPrice / volatilityRatio →
  // classifyRegime → the nine non-funding metric fields. Lifted verbatim into the pure
  // `computeMarketRegimeCore`; byte-identity is pinned by tests/unit/regime-core-parity.test.ts.
  const core = computeMarketRegimeCore({
    coin,
    exchange,
    timeframe,
    candles,
    intervalMs,
    startTime,
    nowMs: Date.now(),
    candleBasis: getCandleBasis(),
  });
  const { regime, confidence, trendStrength, slopeCategory, volatilityRatio } = core;

  // ── Underlying-market session awareness (TRADIFI-SIGNAL-HARDENING-W1) ──
  // Best-effort; resolveAssetClass never throws and fails open to UNKNOWN.
  const assetClass = await resolveAssetClass(coin, exchange);
  const session = assetClass === 'UNKNOWN'
    ? { state: 'UNKNOWN' as const, note: '' }
    : classifyUnderlyingSession({ assetClass, at: new Date() });

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

  let suggestion = generateSuggestion(regime, trendStrength, volatilityRatio, slopeCategory);
  // When the underlying cash market is closed, the candles reflect a capped
  // synthetic index — flag the regime as provisional (label + caveat only; no
  // signal suppression in v1).
  if (isClosedState(session.state)) {
    suggestion += ' Underlying market closed — candles reflect capped synthetic pricing; treat regime as provisional until reopen.';
  }

  // OPS-CANDLE-BASIS-SHADOW-DECOM-W1 removed the SIGNAL-CLOSEDBAR-SHADOW-W1 CH3 divergence
  // write that sat here — the CH2 analogue in get-trade-call.ts went with it. See that file
  // for the reasoning; in short, the candle-basis shadow TABLE had become write-only and was
  // dropped, so the write that fed it went with it.
  // The block derived `liveProjection` + `closedProjection` PURELY to populate the row, so it
  // went whole; the closed-basis INDICATORS derivation above stays, because it is the emitted
  // regime under CANDLE_BASIS=closed.

  // Upgrade hint: only for free tier
  // CH2: the daily pair travels with the monthly one — the hint fires on whichever binds.
  const upgradeHint = getUpgradeHint(license, {
    used: quota.used,
    total: quota.total,
    dailyUsed: quota.daily_used,
    dailyTotal: quota.daily_total,
  });

  // EXCHANGE-SHADOW-PROMOTE-W1 / C2: venue lifecycle status surfaced in every
  // tool response envelope. See parallel comment in get-trade-call.ts.
  const venueStatus = await getVenueStatus(exchange);

  let meta: MarketRegimeResult['_algovault'] = {
    version: PKG_VERSION,
    tool: 'get_market_regime',
    compatible_with: compatibleWith(),
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
    // CH2: the DAILY pair + BOTH horizons, so the warning names the wall it is actually about.
    dailyUsage: quota.daily_used,
    dailyLimit: quota.daily_total,
    monthlyResetAtMs: monthResetAtMs(license),
    dailyResetAtMs: utcDayResetAtMs(),
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
    dailyUsed: quota.daily_used,
    dailyTotal: quota.daily_total,
    dailyResetAtMs: utcDayResetAtMs(),
    isBotInternal: license.tier === 'internal',
  });

  return {
    regime,
    confidence,
    metrics: {
      // The nine non-funding fields, in envelope key order, from the shared core.
      ...core.metrics,
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
    // AUTH-THREE-STATE-W1 CH2 — see the note at get-trade-call.ts's return site.
    _algovault: withAuthState(meta, license),
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

// getIntervalMs DELETED (SIGNAL-TREND-BLINDNESS-FIX-W1 CH1) — it was the last surviving duplicate
// of the tf->ms table and the second one retired from this tree. `intervalMsFor` in
// src/lib/candle-guard.ts is the single owner; callers supply their own fallback. Two tables -> one.
