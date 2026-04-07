/**
 * Analytics summary resource — usage stats gated to pro/enterprise/x402.
 */
import { getUsageStats } from '../lib/analytics.js';
import { getRequestLicense } from '../lib/license.js';

export async function getAnalyticsSummary(): Promise<Record<string, unknown>> {
  const license = getRequestLicense();
  if (license.tier === 'free') {
    throw new Error('Analytics access requires Pro ($49/mo), Enterprise, or x402 payment.');
  }
  return getUsageStats();
}
