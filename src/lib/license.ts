/**
 * Three-tier access gating (checked in order):
 * 1. x402 (valid payment proof in header → full access)
 * 2. API key (CQS_API_KEY env var or Authorization: Bearer header)
 *    - Pro ($49/mo): 15K calls/mo, overage $0.01/call
 *    - Enterprise ($299/mo): 100K calls/mo, overage $0.005/call
 * 3. Free tier (no key, no payment)
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { verifyX402Payment, isX402Configured } from './x402.js';
import { validateApiKey as stripeValidateApiKey } from './stripe.js';
import type { LicenseInfo, LicenseTier } from '../types.js';

const FREE_COINS = new Set(['BTC', 'ETH']);
const FREE_TIMEFRAMES = new Set(['15m', '1h']);
const FREE_FUNDING_LIMIT = 5;

// ── Per-request context ──

interface RequestContext {
  license: LicenseInfo;
  sessionId?: string;
  ipHash?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Get the license for the current request.
 * In HTTP mode: reads from AsyncLocalStorage (set per-request).
 * In stdio mode: falls back to env-based license.
 */
export function getRequestLicense(): LicenseInfo {
  const ctx = requestContext.getStore();
  if (ctx) return ctx.license;
  // Stdio fallback — resolve from env only
  return resolveFromApiKey();
}

export function getRequestSessionId(): string | undefined {
  return requestContext.getStore()?.sessionId;
}

export function getRequestIpHash(): string | undefined {
  return requestContext.getStore()?.ipHash;
}

/** Settlement refs from a verified x402 payment, for async settle after response. */
export interface PendingSettlement {
  paymentPayload: unknown;
  requirements: unknown;
}

/**
 * Resolve license from request headers using the 3-tier gate:
 * x402 payment → API key → free tier.
 *
 * Async because x402 verification hits the Facilitator (~100ms).
 * If x402 is not configured (no wallet address), skips to API key / free.
 */
export async function resolveLicense(
  headers: Record<string, string | undefined>,
): Promise<{ license: LicenseInfo; pendingSettlement?: PendingSettlement }> {
  // Tier 1: x402 payment proof (only if configured)
  if (isX402Configured()) {
    const x402Result = await verifyX402Payment(headers);
    if (x402Result.valid) {
      return {
        license: { tier: 'x402', key: null },
        pendingSettlement: x402Result._settlement
          ? { paymentPayload: x402Result._settlement.paymentPayload, requirements: x402Result._settlement.requirements }
          : undefined,
      };
    }
  }

  // Tier 2: API key (env var or Authorization header) — validated via Stripe
  const authHeader = headers['authorization'] || headers['Authorization'];
  const license = await resolveFromApiKeyAsync(authHeader);
  return { license };
}

/**
 * Synchronous license resolution (no x402). Used for stdio mode.
 */
export function resolveLicenseSync(headers: Record<string, string | undefined>): LicenseInfo {
  const authHeader = headers['authorization'] || headers['Authorization'];
  return resolveFromApiKey(authHeader);
}

/**
 * Async license resolution — validates API key against Stripe.
 * Falls back to prefix-based check if Stripe is not configured.
 */
async function resolveFromApiKeyAsync(authHeader?: string): Promise<LicenseInfo> {
  const key = extractApiKey(authHeader);
  if (!key) return { tier: 'free', key: null };

  // Try Stripe validation (cached, 5-min TTL)
  const stripeResult = await stripeValidateApiKey(key);
  if (stripeResult.valid && stripeResult.tier) {
    return { tier: stripeResult.tier, key };
  }

  // Fallback: prefix-based (for local dev / backward compat)
  return resolveFromApiKey(authHeader);
}

/**
 * Synchronous license resolution from API key (no Stripe call).
 * Used for stdio mode and cache warming.
 */
function resolveFromApiKey(authHeader?: string): LicenseInfo {
  const key = extractApiKey(authHeader);
  if (!key) return { tier: 'free', key: null };

  // Prefix-based tier detection (backward compat)
  const tier: LicenseTier = key.startsWith('ent_') ? 'enterprise' : key.startsWith('av_starter_') ? 'starter' : 'pro';
  return { tier, key };
}

function extractApiKey(authHeader?: string): string | null {
  const envKey = process.env.CQS_API_KEY || null;

  let headerKey: string | null = null;
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) headerKey = match[1];
  }

  const key = envKey || headerKey;
  if (!key || key.trim().length === 0) return null;
  return key;
}

// ── For tests — reset env-based cache ──

let cachedLicense: LicenseInfo | null = null;

export function getCachedLicense(): LicenseInfo {
  if (cachedLicense) return cachedLicense;
  cachedLicense = resolveFromApiKey();
  return cachedLicense;
}

export function resetLicenseCache(): void {
  cachedLicense = null;
}

// ── Access checks ──

export function isFreeTier(license?: LicenseInfo): boolean {
  const l = license || getRequestLicense();
  return l.tier === 'free';
}

export function canAccessCoin(coin: string, license?: LicenseInfo): boolean {
  const l = license || getRequestLicense();
  if (l.tier !== 'free') return true;
  return FREE_COINS.has(coin.toUpperCase());
}

export function canAccessTimeframe(timeframe: string, license?: LicenseInfo): boolean {
  const l = license || getRequestLicense();
  if (l.tier !== 'free') return true;
  return FREE_TIMEFRAMES.has(timeframe);
}

export function getFundingArbLimit(requestedLimit: number, license?: LicenseInfo): number {
  const l = license || getRequestLicense();
  if (l.tier !== 'free') return requestedLimit;
  return Math.min(requestedLimit, FREE_FUNDING_LIMIT);
}

export function freeGateMessage(coin: string, timeframe: string): string {
  const parts: string[] = [];
  if (!FREE_COINS.has(coin.toUpperCase())) {
    parts.push(`${coin} is a Pro asset (free tier: BTC and ETH only)`);
  }
  if (!FREE_TIMEFRAMES.has(timeframe)) {
    parts.push(`${timeframe} is a Pro timeframe (free tier: 15m and 1h only)`);
  }
  if (parts.length === 0) return '';
  return `${parts.join('. ')}. Upgrade to Starter ($9.99/mo) or Pro ($49/mo), or pay per call via x402.`;
}

// ── Call count tracking for quota enforcement ──

interface CallTracker {
  count: number;
  periodStart: number;
}

const callTrackers = new Map<string, CallTracker>();
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function getCallTracker(key: string): CallTracker {
  let tracker = callTrackers.get(key);
  if (!tracker || Date.now() - tracker.periodStart > MONTH_MS) {
    tracker = { count: 0, periodStart: Date.now() };
    callTrackers.set(key, tracker);
  }
  return tracker;
}

export function getMonthlyQuota(tier: LicenseTier): number {
  switch (tier) {
    case 'starter': return 3_000;
    case 'pro': return 15_000;
    case 'enterprise': return 100_000;
    case 'x402': return Infinity;
    default: return 100;
  }
}

export function trackCall(license: LicenseInfo): { allowed: boolean; remaining: number; overage: number } {
  if (license.tier === 'free' || license.tier === 'x402') {
    return { allowed: true, remaining: Infinity, overage: 0 };
  }

  const key = license.key || 'unknown';
  const tracker = getCallTracker(key);
  const quota = getMonthlyQuota(license.tier);

  tracker.count++;

  const remaining = Math.max(0, quota - tracker.count);
  const overage = Math.max(0, tracker.count - quota);

  return { allowed: true, remaining, overage };
}
