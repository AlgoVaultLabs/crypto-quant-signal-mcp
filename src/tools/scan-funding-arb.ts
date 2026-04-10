import { getAdapter } from '../lib/exchange-adapter.js';
import { getFundingArbLimit } from '../lib/license.js';
import type {
  FundingArbResult,
  FundingArbOpportunity,
  FundingConviction,
  FundingUrgency,
  LicenseInfo,
} from '../types.js';

interface ScanFundingArbInput {
  minSpreadBps?: number;
  limit?: number;
  license?: LicenseInfo;
}

// Venue funding period in hours
const VENUE_PERIOD_HOURS: Record<string, number> = {
  HlPerp: 1,       // HL pays hourly
  BinPerp: 8,      // Binance pays every 8h
  BybitPerp: 8,    // Bybit pays every 8h
};

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
  const limit = getFundingArbLimit(requestedLimit, input.license);

  const adapter = getAdapter();
  let fundings;
  try {
    fundings = await adapter.getPredictedFundings();
  } catch {
    return {
      opportunities: [],
      scannedPairs: 0,
      timestamp: Math.floor(Date.now() / 1000),
      _algovault: {
        version: '1.7.0',
        tool: 'scan_funding_arb',
        compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-execution-mcp'],
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
      rates[v.venue] = v.fundingRate;
      const period = VENUE_PERIOD_HOURS[v.venue] || 8;
      hourlyRates[v.venue] = v.fundingRate / period;
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
  // Only fetch for coins that passed the spread filter to minimize API calls
  const nowMs = Date.now();
  const historyStartTime = nowMs - 24 * 3600 * 1000; // 24 hours ago

  const historyPromises = rawOpps.map(opp =>
    adapter.getFundingHistory(opp.coin, historyStartTime).catch(() => [])
  );
  const histories = await Promise.all(historyPromises);

  // Phase 3: Score each opportunity with conviction + urgency, compute composite rank
  const maxSpreadBps = Math.max(...rawOpps.map(o => o.spreadBps), 1); // for normalization

  const opportunities: FundingArbOpportunity[] = rawOpps.map((opp, idx) => {
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

  return {
    opportunities: opportunities.slice(0, limit),
    scannedPairs: fundings.length,
    timestamp: Math.floor(Date.now() / 1000),
    _algovault: {
      version: '1.7.0',
      tool: 'scan_funding_arb',
      compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-execution-mcp'],
    },
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
