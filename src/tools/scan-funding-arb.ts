import { getAdapter } from '../lib/exchange-adapter.js';
import { getFundingArbLimit } from '../lib/license.js';
import type { FundingArbResult, FundingArbOpportunity, LicenseInfo } from '../types.js';

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
        version: '1.4.0',
        tool: 'scan_funding_arb',
        compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-execution-mcp'],
      },
    };
  }

  const opportunities: FundingArbOpportunity[] = [];

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
    _algovault: {
      version: '1.4.0',
      tool: 'scan_funding_arb',
      compatible_with: ['crypto-quant-risk-mcp', 'crypto-quant-execution-mcp'],
    },
  };
}
