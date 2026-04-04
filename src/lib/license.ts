import type { LicenseInfo, LicenseTier } from '../types.js';

const FREE_COINS = new Set(['BTC', 'ETH']);
const FREE_TIMEFRAMES = new Set(['1h']);
const FREE_FUNDING_LIMIT = 5;

let cachedLicense: LicenseInfo | null = null;

export function getLicense(): LicenseInfo {
  if (cachedLicense) return cachedLicense;

  const key = process.env.CQS_API_KEY || null;
  // MVP: any non-empty key = pro tier (Stripe validation in Phase 2)
  const tier: LicenseTier = key && key.trim().length > 0 ? 'pro' : 'free';
  cachedLicense = { tier, key };
  return cachedLicense;
}

export function resetLicenseCache(): void {
  cachedLicense = null;
}

export function isFreeTier(): boolean {
  return getLicense().tier === 'free';
}

export function canAccessCoin(coin: string): boolean {
  if (!isFreeTier()) return true;
  return FREE_COINS.has(coin.toUpperCase());
}

export function canAccessTimeframe(timeframe: string): boolean {
  if (!isFreeTier()) return true;
  return FREE_TIMEFRAMES.has(timeframe);
}

export function getFundingArbLimit(requestedLimit: number): number {
  if (!isFreeTier()) return requestedLimit;
  return Math.min(requestedLimit, FREE_FUNDING_LIMIT);
}

export function freeGateMessage(coin: string, timeframe: string): string {
  const parts: string[] = [];
  if (!FREE_COINS.has(coin.toUpperCase())) {
    parts.push(`${coin} is a Pro asset (free tier: BTC and ETH only)`);
  }
  if (!FREE_TIMEFRAMES.has(timeframe)) {
    parts.push(`${timeframe} is a Pro timeframe (free tier: 1h only)`);
  }
  if (parts.length === 0) return '';
  return `${parts.join('. ')}. Set CQS_API_KEY for Pro access ($29/mo).`;
}
