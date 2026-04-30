/**
 * Unit tests for v1.10.3 FREE-UNLOCK-W1 license gating.
 *
 * Asserts:
 *   - Free tier accepts EVERY coin (BTC, ETH, SOL, PEPE, DOGE, …)
 *   - Free tier accepts EVERY timeframe (1m through 1d, all 11)
 *   - Paid tiers continue to bypass the gate (always returned true pre-1.10.3 too)
 *   - `freeGateMessage` returns empty string (coin/timeframe gating removed)
 *   - `getFundingArbLimit` still caps free tier at FREE_FUNDING_LIMIT (5)
 *   - Monthly quota enforcement is preserved (100/mo for free tier)
 */
import { describe, it, expect } from 'vitest';
import {
  canAccessCoin,
  canAccessTimeframe,
  freeGateMessage,
  getFundingArbLimit,
  getMonthlyQuota,
} from '../../src/lib/license.js';
import type { LicenseInfo } from '../../src/types.js';

const FREE: LicenseInfo = { tier: 'free', key: null };
const STARTER: LicenseInfo = { tier: 'starter', key: 'av_live_test', customerId: 'cus_test' };
const PRO: LicenseInfo = { tier: 'pro', key: 'av_live_test', customerId: 'cus_test' };
const ENTERPRISE: LicenseInfo = { tier: 'enterprise', key: 'av_live_test', customerId: 'cus_test' };

describe('canAccessCoin (v1.10.3 free-tier unlock — accepts every coin)', () => {
  const COINS = ['BTC', 'ETH', 'SOL', 'PEPE', 'DOGE', 'XRP', 'BNB', 'GOLD', 'TSLA', 'SP500'];
  it.each(COINS)('free tier accepts %s', (coin) => {
    expect(canAccessCoin(coin, FREE)).toBe(true);
  });
  it.each(COINS)('starter tier accepts %s', (coin) => {
    expect(canAccessCoin(coin, STARTER)).toBe(true);
  });
  it('case-insensitive — accepts lowercase + mixed', () => {
    expect(canAccessCoin('sol', FREE)).toBe(true);
    expect(canAccessCoin('Eth', FREE)).toBe(true);
  });
  it('accepts the empty string (gating is fully off)', () => {
    expect(canAccessCoin('', FREE)).toBe(true);
  });
});

describe('canAccessTimeframe (v1.10.3 free-tier unlock — accepts every timeframe)', () => {
  // Per src/index.ts:97 Zod enum (canonical capability list = 11 timeframes)
  const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'];
  it.each(TIMEFRAMES)('free tier accepts %s', (tf) => {
    expect(canAccessTimeframe(tf, FREE)).toBe(true);
  });
  it.each(TIMEFRAMES)('pro tier accepts %s', (tf) => {
    expect(canAccessTimeframe(tf, PRO)).toBe(true);
  });
  it.each(TIMEFRAMES)('enterprise tier accepts %s', (tf) => {
    expect(canAccessTimeframe(tf, ENTERPRISE)).toBe(true);
  });
});

describe('freeGateMessage (v1.10.3 — empty after free-tier unlock)', () => {
  it('returns empty string for any (coin, timeframe) on free tier', () => {
    expect(freeGateMessage('BTC', '1h')).toBe('');
    expect(freeGateMessage('SOL', '4h')).toBe('');
    expect(freeGateMessage('PEPE', '1d')).toBe('');
    expect(freeGateMessage('DOGE', '1m')).toBe('');
  });
  it('NEVER mentions "Starter" / "Upgrade" — quota path owns that surface now', () => {
    const msgs = [
      freeGateMessage('SOL', '4h'),
      freeGateMessage('XRP', '15m'),
      freeGateMessage('TSLA', '12h'),
    ];
    for (const m of msgs) {
      expect(m).not.toMatch(/Starter|Upgrade|9\.99/i);
    }
  });
});

describe('getFundingArbLimit (free tier still capped at 5)', () => {
  it('caps free at 5 even when caller requests more', () => {
    expect(getFundingArbLimit(10, FREE)).toBe(5);
    expect(getFundingArbLimit(50, FREE)).toBe(5);
  });
  it('respects requested-limit when ≤ 5', () => {
    expect(getFundingArbLimit(3, FREE)).toBe(3);
  });
  it('lets paid tiers through unchanged', () => {
    expect(getFundingArbLimit(50, STARTER)).toBe(50);
    expect(getFundingArbLimit(50, PRO)).toBe(50);
  });
});

describe('getMonthlyQuota (regression: free tier stays at 100/month)', () => {
  it('free = 100', () => {
    expect(getMonthlyQuota('free')).toBe(100);
  });
  it('starter = 3000, pro = 15000, enterprise = 100000', () => {
    expect(getMonthlyQuota('starter')).toBe(3_000);
    expect(getMonthlyQuota('pro')).toBe(15_000);
    expect(getMonthlyQuota('enterprise')).toBe(100_000);
  });
});
