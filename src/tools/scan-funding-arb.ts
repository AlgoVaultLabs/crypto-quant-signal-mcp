import { fetchPredictedFundings } from '../lib/hyperliquid.js';
import { getFundingArbLimit } from '../lib/license.js';
import type { FundingArbResult, FundingArbOpportunity } from '../types.js';

interface ScanFundingArbInput {
  minSpreadBps?: number;
  limit?: number;
}

// Venue funding period in hours
const VENUE_PERIOD_HOURS: Record<string, number> = {
  HlPerp: 1,       // HL pays hourly
  BinPerp: 8,      // Binance pays every 8h
  BybitPerp: 8,    // Bybit pays every 8h
};

const HOURS_PER_YEAR = 8760;

export async function scanFundingArb(input: ScanFundingArbInput): Promise<FundingArbResult> {
  const minSpreadBps = input.minSpreadBps ?? 5;
  const requestedLimit = input.limit ?? 10;
  const limit = getFundingArbLimit(requestedLimit);

  const fundings = await fetchPredictedFundings();

  const opportunities: FundingArbOpportunity[] = [];

  for (const entry of fundings) {
    const coin = entry[0];
    const venueEntries = entry[1];

    if (!venueEntries || venueEntries.length < 2) continue;

    // Parse rates and normalize to hourly
    const rates: Record<string, number> = {};
    const hourlyRates: Record<string, number> = {};
    const nextFundingTimes: Record<string, number> = {};

    for (const [venue, data] of venueEntries) {
      const rate = parseFloat(data.fundingRate);
      if (isNaN(rate)) continue;
      rates[venue] = rate;
      // Normalize to hourly rate
      const period = VENUE_PERIOD_HOURS[venue] || 8;
      hourlyRates[venue] = rate / period;
      nextFundingTimes[venue] = data.nextFundingTime;
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
        // Long where funding is most negative (you get paid), short where most positive
        // Arb profit = short venue rate - long venue rate (when you long the low-rate venue and short the high-rate)
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

    const annualizedPct = bestSpread * HOURS_PER_YEAR * 100;

    const venueName = (v: string) => v.replace('Perp', '').replace('Hl', 'HL').replace('Bin', 'Binance').replace('Bybit', 'Bybit');

    opportunities.push({
      coin,
      rates,
      bestArb: {
        longVenue: bestLong,
        shortVenue: bestShort,
        spreadBps: parseFloat(spreadBps.toFixed(2)),
        annualizedPct: parseFloat(annualizedPct.toFixed(2)),
        direction: `Long ${venueName(bestLong)} / Short ${venueName(bestShort)}`,
      },
      nextFundingTimes,
    });
  }

  // Sort by annualized spread descending
  opportunities.sort((a, b) => b.bestArb.annualizedPct - a.bestArb.annualizedPct);

  return {
    opportunities: opportunities.slice(0, limit),
    scannedPairs: fundings.length,
    timestamp: Math.floor(Date.now() / 1000),
  };
}
