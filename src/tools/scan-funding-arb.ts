import { getAdapter, type ExchangeAdapter } from '../lib/exchange-adapter.js';
import { getFundingArbLimit, isFreeTier, trackCall, getUpgradeHint, getQuotaExhaustedMessage, getRequestSessionId, daysUntilMonthReset, getMonthlyQuota } from '../lib/license.js';
import { TierLimitReachedError } from '../lib/errors.js';
import { referralCodeForKey } from '../lib/referral-store.js'; // REFERRAL-INPRODUCT-NUDGE-W1: keyed→code, keyless→null
import { withTierWarning, DEFAULT_UPGRADE_URL } from '../lib/tier-warning.js';
import { PKG_VERSION } from '../lib/pkg-version.js';
import type {
  FundingArbResult,
  FundingArbOpportunity,
  FundingConviction,
  FundingUrgency,
  LicenseInfo,
  FundingData,
  ExchangeId,
} from '../types.js';
import { annualizeFunding } from '../lib/rank-constants.js';
import { FUNDING_VENUE_META, FUNDING_ARB_FETCH_ADAPTERS } from '../lib/funding-venues.js';
import { fetchVenueUniverse } from '../lib/exchange-universe.js';

// ── LATENCY-W1 C5: TTL caches for adapter calls (LRU-capped) ──
//
// Why: cron monitor + dashboards call scan_funding_arb every 1-2 min. Without
// caching, every call re-fetches identical predicted-funding data (HL updates
// these on the minute) and per-coin funding history (24h-window data that's
// largely static within a few minutes). With caching: warm-path p50 drops
// from ~1093ms → ~500ms (cuts the two adapter roundtrips that dominate the
// hot path).
//
// CPX22 RAM cap proof:
//   - predictedFundingsCache: 1 entry, ~50KB max
//   - fundingHistoryCache:    200 entries × ~20KB = 4MB max
//   Total: <5MB worst case. Well inside CPX22 budget.

const PREDICTED_FUNDINGS_TTL_MS = 30_000; // HL updates funding on the minute; 30s safe
const FUNDING_HISTORY_TTL_MS = 60_000;    // 24h-window data; 60s + 1-min bucket = stable
const FUNDING_HISTORY_CACHE_MAX = 200;    // LRU cap

interface PredictedFundingsCacheEntry {
  at: number;
  data: FundingData[];
}
interface FundingHistoryCacheEntry {
  at: number;
  data: { time: number; fundingRate: number }[];
}

// Module-level singletons (process-lifetime). Reset via _resetScanFundingArbCaches().
// OPS-FUNDING-ARB-EXPAND-W1: predicted-funding cache is now PER-ExchangeId (was a single HL entry) —
// the expanded arb fetches multiple adapters' feeds per scan.
const predictedFundingsCache = new Map<string, PredictedFundingsCacheEntry>();
const fundingHistoryCache = new Map<string, FundingHistoryCacheEntry>();
// Per-venue coin→USD-liquidity map (from the scan SoT getVenueUniverse), 60s TTL — powers the per-leg
// liquidity gate.
const LIQUIDITY_TTL_MS = 60_000;
const liquidityCache = new Map<string, { at: number; byCoin: Map<string, number> }>();
// (Q-B) per-leg liquidity floor — a spread surfaces only if the coin clears this on BOTH legs (notional
// OI for real-OI venues; 24h volume for the ASTER volume-proxy). CALIBRATED to $5M (from the $1M start)
// against the LIVE OI distribution (C3 probe 2026-07-01): $1M surfaced a tail of $1–3M/leg thin coins
// (BTW/STABLE/SLX) whose 100–290% annualized spreads are only marginally executable; $5M drops those and
// keeps the $5M+/leg opportunities (LAB/SKHYNIX). Liquid majors (BTC/ETH) never surface at meaningful
// thresholds regardless — their cross-venue funding is a few % — so this floor only trims the thin tail.
// TODO(revisit by 2026-07-15): re-tune against more data — raise for fewer thin coins, lower for reach.
const MIN_LIQUIDITY_USD = 5_000_000;

async function getCachedPredictedFundings(exchangeId: ExchangeId): Promise<FundingData[]> {
  const now = Date.now();
  const hit = predictedFundingsCache.get(exchangeId);
  if (hit && now - hit.at <= PREDICTED_FUNDINGS_TTL_MS) return hit.data;
  const data = await getAdapter(exchangeId).getPredictedFundings();
  predictedFundingsCache.set(exchangeId, { at: now, data });
  return data;
}

/** Per-leg USD liquidity for `exchangeId` (coin → notionalOI_usd, or volume24h_usd for proxy venues).
 *  Fail-soft: a fetch error → empty map (that venue's coins are gated out this cycle, never a crash). */
async function getVenueLiquidity(exchangeId: ExchangeId): Promise<Map<string, number>> {
  const now = Date.now();
  const hit = liquidityCache.get(exchangeId);
  if (hit && now - hit.at <= LIQUIDITY_TTL_MS) return hit.byCoin;
  const byCoin = new Map<string, number>();
  try {
    for (const a of await fetchVenueUniverse(exchangeId)) {
      byCoin.set(a.coin, a.oiIsProxy ? a.volume24h_usd : a.notionalOI_usd);
    }
  } catch { /* fail-soft per venue */ }
  liquidityCache.set(exchangeId, { at: now, byCoin });
  return byCoin;
}

// Test seam (matches _setScanScorerForTest et al.): when set, the per-leg liquidity gate reads this
// instead of the live SoT — and the live prefetch is SKIPPED — so unit tests never hit the network.
// Return Infinity to make every leg liquid (0-regression tests), or specific USD values (gate tests).
let _liquidityOverride: ((exchangeId: ExchangeId, coin: string) => number) | null = null;
export function _setLiquidityOverrideForTest(fn: ((exchangeId: ExchangeId, coin: string) => number) | null): void {
  _liquidityOverride = fn;
}

async function getCachedFundingHistory(
  adapter: ExchangeAdapter,
  coin: string,
  startTime: number,
): Promise<{ time: number; fundingRate: number }[]> {
  // 1-minute bucket so that small clock drift between concurrent calls collapses
  // to the same cache key. startTime is `Date.now() - 24h` upstream → both
  // calls 30s apart will round to the same bucket, sharing one fetch.
  const bucket = Math.floor(startTime / 60_000);
  const key = `${coin}:${bucket}`;
  const now = Date.now();
  const hit = fundingHistoryCache.get(key);
  if (hit && now - hit.at <= FUNDING_HISTORY_TTL_MS) {
    return hit.data;
  }
  const data = await adapter.getFundingHistory(coin, startTime);
  fundingHistoryCache.set(key, { at: now, data });
  // LRU eviction: when over cap, delete oldest by `at`.
  // Map iteration is insertion order in JS, so the first key is the oldest
  // INSERTED. Since we only set on miss, insertion order ≈ recency-of-fetch
  // order — close enough to LRU for a 200-entry cap. (Strict LRU would re-set
  // on hit; not worth the extra Map churn for this size.)
  if (fundingHistoryCache.size > FUNDING_HISTORY_CACHE_MAX) {
    const oldestKey = fundingHistoryCache.keys().next().value;
    if (oldestKey !== undefined) fundingHistoryCache.delete(oldestKey);
  }
  return data;
}

/**
 * Test-only reset hooks. Underscore-prefixed per project convention for
 * test seams (matches _setSnapshotForTest / _setScorerOverride in
 * cross-asset-grid.ts). Vitest must call _resetScanFundingArbCaches() in
 * beforeEach to ensure test isolation — otherwise test N's cache pollutes
 * test N+1. The granular _resetPredictedFundingsCache() is for tests that
 * need to vary fundings per scan while observing fundingHistory growth.
 */
export function _resetScanFundingArbCaches(): void {
  predictedFundingsCache.clear();
  fundingHistoryCache.clear();
  liquidityCache.clear();
}
export function _resetPredictedFundingsCache(): void {
  predictedFundingsCache.clear();
}

/**
 * Test-only inspector. Returns current funding-history cache size for
 * direct LRU-cap assertion. Not intended for production use.
 */
export function _getScanFundingArbCacheSizes(): {
  predictedFundingsCached: boolean;
  fundingHistorySize: number;
  fundingHistoryCap: number;
} {
  return {
    predictedFundingsCached: predictedFundingsCache.size > 0,
    fundingHistorySize: fundingHistoryCache.size,
    fundingHistoryCap: FUNDING_HISTORY_CACHE_MAX,
  };
}

interface ScanFundingArbInput {
  minSpreadBps?: number;
  limit?: number;
  license?: LicenseInfo;
}

// OPS-FUNDING-ARB-EXPAND-W1: the local VENUE_PERIOD_HOURS 3-map is RETIRED — funding intervals now come
// from the shared FUNDING_VENUE_META SoT (funding-venues.ts) and normalization runs through the shared
// annualizeFunding primitive. A new qualifying venue joins the arb via a META row, not a hand-edit here.
const HOURS_PER_YEAR = 8760;

// Composite ranking weights (research-backed: spread is primary, urgency second, conviction third)
const WEIGHT_SPREAD = 0.50;
const WEIGHT_URGENCY = 0.30;
const WEIGHT_CONVICTION = 0.20;

// Urgency decay constant — exp(-0.5 * hours):  6min→95, 30min→78, 1h→61, 4h→14
const URGENCY_DECAY = 0.5;

export async function scanFundingArb(input: ScanFundingArbInput): Promise<FundingArbResult> {
  const minSpreadBps = input.minSpreadBps ?? 5;
  const requestedLimit = input.limit ?? 10;
  const license = input.license || { tier: 'free' as const, key: null };
  const limit = getFundingArbLimit(requestedLimit, license);

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
    });
  }

  // OPS-FUNDING-ARB-EXPAND-W1: fetch every qualifying adapter's predicted-funding feed (fail-soft PER
  // adapter — a down venue is skipped, never crashes the scan) and MERGE by coin. HL's feed is the
  // Bin/HL/Bybit aggregate; GATE/KUCOIN/ASTER/OKX each add their own venue. Dedup by venue-string keeps
  // HL the sole source for Bin/Bybit → 0-regression on the pre-expansion 3. Prefetch the per-venue
  // liquidity maps (scan SoT) for the gate in the same round-trip. Both cached (30s / 60s TTL).
  const [feeds, liquidityByExchange] = await Promise.all([
    Promise.all(FUNDING_ARB_FETCH_ADAPTERS.map(v => getCachedPredictedFundings(v).catch(() => [] as FundingData[]))),
    _liquidityOverride
      ? Promise.resolve(new Map<ExchangeId, Map<string, number>>())
      : (async () => {
          const ids = [...new Set(Object.values(FUNDING_VENUE_META).map(m => m.exchangeId))];
          const pairs = await Promise.all(ids.map(async id => [id, await getVenueLiquidity(id)] as const));
          return new Map<ExchangeId, Map<string, number>>(pairs);
        })(),
  ]);

  const mergedByCoin = new Map<string, FundingData['venues']>();
  for (const feed of feeds) {
    for (const entry of feed) {
      const merged = mergedByCoin.get(entry.coin) ?? [];
      for (const ve of entry.venues) {
        if (!merged.some(m => m.venue === ve.venue)) merged.push(ve);
      }
      mergedByCoin.set(entry.coin, merged);
    }
  }
  const fundings: FundingData[] = [...mergedByCoin.entries()].map(([coin, venues]) => ({ coin, venues }));
  if (fundings.length === 0) {
    // Every qualifying feed errored/empty this cycle — fail-soft, not a crash.
    return {
      opportunities: [],
      scannedPairs: 0,
      timestamp: Math.floor(Date.now() / 1000),
      _algovault: {
        version: PKG_VERSION,
        tool: 'scan_funding_arb',
        compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-execution-mcp'],
        session_id: getRequestSessionId() ?? null,
      },
    };
  }

  // Phase 1: Find all qualifying spreads
  interface RawOpportunity {
    coin: string;
    rates: Record<string, number>;
    hourlyRates: Record<string, number>;
    bestLong: string;
    bestShort: string;
    bestSpread: number;
    spreadBps: number;
    annualizedPct: number;
    nextFundingTimes: Record<string, number>;
  }

  const rawOpps: RawOpportunity[] = [];

  for (const entry of fundings) {
    const coin = entry.coin;
    const venueEntries = entry.venues;

    if (!venueEntries || venueEntries.length < 2) continue;

    // Parse rates and normalize to hourly
    const rates: Record<string, number> = {};
    const hourlyRates: Record<string, number> = {};
    const nextFundingTimes: Record<string, number> = {};

    for (const v of venueEntries) {
      if (isNaN(v.fundingRate)) continue;
      // OPS-FUNDING-ARB-EXPAND-W1: interval-correct annualization via the shared annualizeFunding
      // primitive + the FUNDING_VENUE_META interval SoT. `annualized / HOURS_PER_YEAR` === `rate /
      // intervalHours` (byte-identical hourly rate → 0-regression on the pre-expansion HL/Bin/Bybit),
      // but a venue NOT in the qualifying set — or with an unknown/invalid interval — self-skips
      // rather than silently using a wrong period, so NO false cross-interval spread ever surfaces on
      // this public, Merkle-anchored tool.
      const meta = FUNDING_VENUE_META[v.venue];
      if (!meta) continue;
      // OPS-FUNDING-ARB-EXPAND-W1 (Q-B): per-leg liquidity gate — a venue is a valid arb LEG for this
      // coin only if the coin clears MIN_LIQUIDITY_USD there (notional OI, or 24h volume for proxy
      // venues). An illiquid leg = a non-executable / false spread → excluded (quality > breadth). A
      // coin left with <2 liquid venues yields no spread (the `venues.length < 2` guard below).
      const legLiquidity = _liquidityOverride
        ? _liquidityOverride(meta.exchangeId, coin)
        : (liquidityByExchange.get(meta.exchangeId)?.get(coin) ?? 0);
      if (legLiquidity < MIN_LIQUIDITY_USD) continue;
      const annualized = annualizeFunding(v.fundingRate, meta.intervalHours);
      if (annualized === null) continue;
      rates[v.venue] = v.fundingRate;
      hourlyRates[v.venue] = annualized / HOURS_PER_YEAR;
      nextFundingTimes[v.venue] = v.nextFundingTime;
    }

    const venues = Object.keys(hourlyRates);
    if (venues.length < 2) continue;

    // Find best long/short combo (max spread)
    let bestSpread = 0;
    let bestLong = '';
    let bestShort = '';

    for (const longV of venues) {
      for (const shortV of venues) {
        if (longV === shortV) continue;
        const spread = hourlyRates[shortV] - hourlyRates[longV];
        if (spread > bestSpread) {
          bestSpread = spread;
          bestLong = longV;
          bestShort = shortV;
        }
      }
    }

    if (bestSpread === 0) continue;

    const spreadBps = bestSpread * 10000;
    if (spreadBps < minSpreadBps) continue;

    rawOpps.push({
      coin, rates, hourlyRates,
      bestLong, bestShort, bestSpread,
      spreadBps: parseFloat(spreadBps.toFixed(2)),
      annualizedPct: parseFloat((bestSpread * HOURS_PER_YEAR * 100).toFixed(2)),
      nextFundingTimes,
    });
  }

  // Phase 2: Fetch conviction data (HL funding history) for qualifying coins in parallel
  // Only fetch for coins that passed the spread filter to minimize API calls.
  //
  // LATENCY-W1 C4: sort-then-slice — historically we fetched history for ALL
  // rawOpps (often 40-80 coins) only to slice to `limit` (default 10) at the
  // end. Now: sort by spreadBps DESC, slice to `limit * 2` BEFORE fetch. The
  // 2× cushion covers the case where a top-spread coin has NaN/stale history
  // and drops out of final ranking, so we still fill `limit`. Saves ~50-80%
  // of per-coin getFundingHistory roundtrips when totalFound > limit.
  const SLICE_CUSHION = 2;
  rawOpps.sort((a, b) => b.spreadBps - a.spreadBps);
  // PRESERVE the true qualifying count BEFORE slicing — used downstream by
  // `totalFound`/`cappedResults` hint so users see accurate "N qualifying,
  // showing top M" framing. The slice only reduces fetch cost; it MUST NOT
  // cause the response to underreport totalResults.
  const totalQualifying = rawOpps.length;
  const candidates = rawOpps.slice(0, Math.min(rawOpps.length, limit * SLICE_CUSHION));

  const nowMs = Date.now();
  const historyStartTime = nowMs - 24 * 3600 * 1000; // 24 hours ago

  // C5 (LATENCY-W1): cached, 60s TTL keyed by ${coin}:${minute-bucket}, LRU(200).
  // Same .catch(() => []) error swallow as before.
  // Conviction uses HL's 24h funding history for the coin (the aggregate feed's stability proxy) —
  // getAdapter('HL') since the single `adapter` var is gone (multi-adapter merge above).
  const historyPromises = candidates.map(opp =>
    getCachedFundingHistory(getAdapter('HL'), opp.coin, historyStartTime).catch(() => [])
  );
  const histories = await Promise.all(historyPromises);

  // Phase 3: Score each opportunity with conviction + urgency, compute composite rank
  // (Now ranking only `candidates`, not all rawOpps — final composite-rank order
  // may differ slightly from the previous behavior of ranking all-then-slicing,
  // but for high-spread coins the spread weight (0.50) dominates so the top-N
  // outputs converge. Trade-off is documented; smoke verifies response shape.)
  const maxSpreadBps = Math.max(...candidates.map(o => o.spreadBps), 1); // for normalization

  const opportunities: FundingArbOpportunity[] = candidates.map((opp, idx) => {
    const history = histories[idx];

    // ── Conviction score ──
    const conviction = computeConviction(history, opp.hourlyRates[opp.bestLong], minSpreadBps);

    // ── Urgency score ──
    const urgency = computeUrgency(opp.nextFundingTimes, opp.bestLong, opp.bestShort, nowMs);

    // ── Composite rank score ──
    const normalizedSpread = Math.min((opp.spreadBps / maxSpreadBps) * 100, 100);
    const rankScore = parseFloat((
      WEIGHT_SPREAD * normalizedSpread +
      WEIGHT_URGENCY * urgency.score +
      WEIGHT_CONVICTION * conviction.score
    ).toFixed(1));

    const venueName = (v: string) => v.replace('Perp', '').replace('Hl', 'HL').replace('Bin', 'Binance').replace('Bybit', 'Bybit');

    return {
      coin: opp.coin,
      rates: opp.rates,
      bestArb: {
        longVenue: opp.bestLong,
        shortVenue: opp.bestShort,
        spreadBps: opp.spreadBps,
        annualizedPct: opp.annualizedPct,
        direction: `Long ${venueName(opp.bestLong)} / Short ${venueName(opp.bestShort)}`,
        urgency,
        rankScore,
      },
      conviction,
      nextFundingTimes: opp.nextFundingTimes,
    };
  });

  // Sort by composite rank score descending (not just annualized spread)
  opportunities.sort((a, b) => b.bestArb.rankScore - a.bestArb.rankScore);

  // C4 (LATENCY-W1): use the pre-slice qualifying count, NOT opportunities.length.
  // `opportunities` was built from `candidates` (sliced to limit*2 before history
  // fetch), so its length now reflects the candidate window, not the true total.
  // `totalFound` MUST stay truthful so the cappedResults hint + response shape
  // match user-visible reality. Spec: response shape is frozen.
  const totalFound = totalQualifying;
  const capped = opportunities.slice(0, limit);

  // Upgrade hint: capped results take priority, then quota usage
  const upgradeHint = getUpgradeHint(license, {
    cappedResults: capped.length < totalFound ? limit : undefined,
    totalResults: totalFound,
    used: quota.used,
    total: quota.total,
  });

  let meta: FundingArbResult['_algovault'] = {
    version: PKG_VERSION,
    tool: 'scan_funding_arb',
    compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-execution-mcp'],
    session_id: getRequestSessionId() ?? null,
  };
  if (upgradeHint) meta.upgrade_hint = upgradeHint;
  // ACTIVATION-PAYWALL-W1: structured tier_warning at 75%+ / 90%+ thresholds.
  meta = withTierWarning(meta, {
    tier: license.tier,
    currentUsage: quota.used,
    monthlyLimit: quota.total || getMonthlyQuota(license.tier),
    isBotInternal: license.tier === 'internal',
    upgradeUrl: DEFAULT_UPGRADE_URL,
  });

  return {
    opportunities: capped,
    scannedPairs: fundings.length,
    timestamp: Math.floor(Date.now() / 1000),
    _algovault: meta,
  };
}

/**
 * Conviction score from HL funding history (24h).
 * Three components:
 *   40% direction_consistency — fraction of periods with same sign as current
 *   30% magnitude_stability — 1 - coefficient of variation (stable rates score high)
 *   30% spread_persistence — fraction of periods where rate would produce qualifying spread
 */
function computeConviction(
  history: { time: number; fundingRate: number }[],
  currentLongHourly: number,
  minSpreadBps: number
): FundingConviction {
  // Fallback if no history available
  if (!history || history.length < 3) {
    return {
      score: 50,
      label: 'MEDIUM',
      direction_consistency: 50,
      magnitude_stability: 50,
      spread_persistence: 50,
      sample_hours: 0,
    };
  }

  const rates = history.map(h => h.fundingRate);
  const currentSign = rates[rates.length - 1] >= 0 ? 1 : -1;
  const sampleHours = rates.length;

  // Component 1: Direction consistency — what fraction had same sign as current?
  const sameSignCount = rates.filter(r => (r >= 0 ? 1 : -1) === currentSign).length;
  const directionConsistency = (sameSignCount / rates.length) * 100;

  // Component 2: Magnitude stability — inverse of coefficient of variation
  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  const variance = rates.reduce((s, r) => s + (r - mean) ** 2, 0) / rates.length;
  const stdDev = Math.sqrt(variance);
  const cv = Math.abs(mean) > 0 ? stdDev / Math.abs(mean) : 1;
  const magnitudeStability = Math.max(0, Math.min(100, (1 - Math.min(cv, 1)) * 100));

  // Component 3: Spread persistence — how often was the rate actionable?
  // HL rates are already hourly; check if they exceed minSpreadBps threshold
  const thresholdRate = minSpreadBps / 10000; // convert bps to rate
  const aboveThresholdCount = rates.filter(r => Math.abs(r) > thresholdRate).length;
  const spreadPersistence = (aboveThresholdCount / rates.length) * 100;

  // Weighted composite
  const score = Math.round(
    directionConsistency * 0.4 +
    magnitudeStability * 0.3 +
    spreadPersistence * 0.3
  );

  const clampedScore = Math.max(0, Math.min(100, score));

  return {
    score: clampedScore,
    label: clampedScore >= 70 ? 'HIGH' : clampedScore >= 40 ? 'MEDIUM' : 'LOW',
    direction_consistency: parseFloat(directionConsistency.toFixed(1)),
    magnitude_stability: parseFloat(magnitudeStability.toFixed(1)),
    spread_persistence: parseFloat(spreadPersistence.toFixed(1)),
    sample_hours: sampleHours,
  };
}

/**
 * Urgency score based on time to next funding settlement.
 * Uses exponential decay: score = 100 * exp(-0.5 * hours_remaining)
 *   6 min → 95,  30 min → 78,  1h → 61,  2h → 37,  4h → 14,  8h → 2
 */
function computeUrgency(
  nextFundingTimes: Record<string, number>,
  longVenue: string,
  shortVenue: string,
  nowMs: number
): FundingUrgency {
  const longTime = nextFundingTimes[longVenue] || 0;
  const shortTime = nextFundingTimes[shortVenue] || 0;

  // Effective time = sooner of the two venues (need to be positioned before either settles)
  let effectiveTimeMs: number;
  let effectiveVenue: string;

  if (longTime > 0 && shortTime > 0) {
    if (longTime <= shortTime) {
      effectiveTimeMs = longTime;
      effectiveVenue = longVenue;
    } else {
      effectiveTimeMs = shortTime;
      effectiveVenue = shortVenue;
    }
  } else if (longTime > 0) {
    effectiveTimeMs = longTime;
    effectiveVenue = longVenue;
  } else if (shortTime > 0) {
    effectiveTimeMs = shortTime;
    effectiveVenue = shortVenue;
  } else {
    // No timing data — neutral score
    return { score: 50, label: 'MEDIUM', nextCollectionMin: 0, effectiveVenue: 'unknown' };
  }

  // Hours remaining (floor at 5 minutes = 0.083h to prevent extreme scores)
  const hoursRemaining = Math.max((effectiveTimeMs - nowMs) / 3_600_000, 0.083);
  const nextCollectionMin = Math.max(Math.round(hoursRemaining * 60), 1);

  // Exponential decay
  const score = Math.round(100 * Math.exp(-URGENCY_DECAY * hoursRemaining));
  const clampedScore = Math.max(0, Math.min(100, score));

  return {
    score: clampedScore,
    label: clampedScore >= 60 ? 'HIGH' : clampedScore >= 30 ? 'MEDIUM' : 'LOW',
    nextCollectionMin,
    effectiveVenue,
  };
}
