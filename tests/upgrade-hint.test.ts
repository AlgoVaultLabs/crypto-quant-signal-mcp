import { describe, it, expect, beforeEach } from 'vitest';
import { getUpgradeHint, getQuotaExhaustedMessage, trackCall, resetLicenseCache } from '../src/lib/license.js';
import type { LicenseInfo } from '../src/types.js';

describe('getUpgradeHint', () => {
  const free: LicenseInfo = { tier: 'free', key: null };
  const starter: LicenseInfo = { tier: 'starter', key: 'av_starter_test' };
  const pro: LicenseInfo = { tier: 'pro', key: 'pro_test' };
  const enterprise: LicenseInfo = { tier: 'enterprise', key: 'ent_test' };
  const x402: LicenseInfo = { tier: 'x402', key: null };

  it('returns undefined for non-free tiers', () => {
    for (const license of [starter, pro, enterprise, x402]) {
      expect(getUpgradeHint(license, { used: 90, total: 100 })).toBeUndefined();
      expect(getUpgradeHint(license, { cappedResults: 5, totalResults: 20 })).toBeUndefined();
    }
  });

  it('returns undefined for free tier under 80% usage', () => {
    expect(getUpgradeHint(free, { used: 50, total: 100 })).toBeUndefined();
    expect(getUpgradeHint(free, { used: 79, total: 100 })).toBeUndefined();
  });

  it('returns quota hint when free tier is at 80%+ usage', () => {
    const hint = getUpgradeHint(free, { used: 80, total: 100 });
    expect(hint).toContain('80/100');
    expect(hint).toContain('Starter');
    expect(hint).toContain('$9.99/mo');
    expect(hint).toContain('signup?plan=starter');
  });

  it('returns quota hint at 95% usage', () => {
    const hint = getUpgradeHint(free, { used: 95, total: 100 });
    expect(hint).toContain('95/100');
  });

  it('returns undefined at 100% usage (handled by quota block)', () => {
    expect(getUpgradeHint(free, { used: 100, total: 100 })).toBeUndefined();
  });

  it('returns capped results hint when funding arb is limited', () => {
    const hint = getUpgradeHint(free, { cappedResults: 5, totalResults: 12 });
    expect(hint).toContain('top 5 of 12');
    expect(hint).toContain('Starter');
    expect(hint).toContain('$9.99/mo');
  });

  it('returns undefined when results are not capped', () => {
    expect(getUpgradeHint(free, { cappedResults: 5, totalResults: 3 })).toBeUndefined();
    expect(getUpgradeHint(free, { cappedResults: 5, totalResults: 5 })).toBeUndefined();
  });

  it('capped results hint takes priority over quota hint', () => {
    const hint = getUpgradeHint(free, {
      cappedResults: 5,
      totalResults: 20,
      used: 85,
      total: 100,
    });
    expect(hint).toContain('top 5 of 20');
    expect(hint).not.toContain('85/100');
  });

  it('returns undefined with no context', () => {
    expect(getUpgradeHint(free)).toBeUndefined();
    expect(getUpgradeHint(free, {})).toBeUndefined();
  });
});

describe('getQuotaExhaustedMessage', () => {
  it('includes usage count and upgrade URL', () => {
    const msg = getQuotaExhaustedMessage(100, 100);
    expect(msg).toContain('100/100');
    expect(msg).toContain('Starter');
    expect(msg).toContain('x402');
    expect(msg).toContain('signup?plan=starter');
  });
});
