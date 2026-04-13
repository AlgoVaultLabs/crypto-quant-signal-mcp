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
import { dbExec, dbRun, dbQuery } from './performance-db.js';
import type { LicenseInfo, LicenseTier } from '../types.js';

const FREE_COINS = new Set(['BTC', 'ETH']);
const FREE_TIMEFRAMES = new Set(['15m', '1h']);
const FREE_FUNDING_LIMIT = 5;

// ── Per-request context ──

interface RequestContext {
  license: LicenseInfo;
  sessionId?: string;
  ipHash?: string;
  /** Set by tool handler so HTTP layer can skip x402 settlement for HOLD. */
  lastVerdict?: string;
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

/** Store the tool verdict so HTTP handler can skip x402 settlement for HOLD. */
export function setRequestVerdict(verdict: string): void {
  const ctx = requestContext.getStore();
  if (ctx) ctx.lastVerdict = verdict;
}

export function getRequestVerdict(): string | undefined {
  return requestContext.getStore()?.lastVerdict;
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
    parts.push(`${coin} requires Starter ($9.99/mo) or higher (free tier: BTC and ETH only)`);
  }
  if (!FREE_TIMEFRAMES.has(timeframe)) {
    parts.push(`${timeframe} requires Starter ($9.99/mo) or higher (free tier: 15m and 1h only)`);
  }
  if (parts.length === 0) return '';
  return `${parts.join('. ')}. Upgrade → https://api.algovault.com/signup?plan=starter`;
}

// ── Call count tracking for quota enforcement ──
// In-memory map is the hot path; DB is write-through for persistence across restarts.

interface CallTracker {
  count: number;
  periodStart: number;
}

const callTrackers = new Map<string, CallTracker>();
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
let quotaDbInitialized = false;

/** Initialize quota_usage table and load persisted counts into memory. */
export function initQuotaDb(): void {
  if (quotaDbInitialized) return;
  try {
    dbExec(`CREATE TABLE IF NOT EXISTS quota_usage (
      tracker_key TEXT PRIMARY KEY,
      call_count INTEGER NOT NULL DEFAULT 0,
      period_start TEXT NOT NULL
    )`);
    // Load persisted counts into memory (dbQuery is always async)
    const now = Date.now();
    dbQuery<{ tracker_key: string; call_count: string; period_start: string }>(
      'SELECT tracker_key, call_count, period_start FROM quota_usage'
    ).then(r => loadQuotaRows(r, now)).catch(() => {});
    quotaDbInitialized = true;
  } catch {
    // DB not ready yet — will retry on next call
  }
}

function loadQuotaRows(rows: { tracker_key: string; call_count: string; period_start: string }[], now: number): void {
  for (const row of rows) {
    const periodStart = new Date(row.period_start).getTime();
    if (now - periodStart > MONTH_MS) continue; // expired period, skip
    callTrackers.set(row.tracker_key, {
      count: Number(row.call_count),
      periodStart,
    });
  }
}

function persistTracker(key: string, tracker: CallTracker): void {
  try {
    dbRun(
      `INSERT INTO quota_usage (tracker_key, call_count, period_start)
       VALUES (?, ?, ?)
       ON CONFLICT (tracker_key) DO UPDATE SET call_count = ?, period_start = ?`,
      key, tracker.count, new Date(tracker.periodStart).toISOString(),
      tracker.count, new Date(tracker.periodStart).toISOString()
    );
  } catch {
    // Best-effort persistence — don't block the request
  }
}

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

export interface TrackCallResult {
  allowed: boolean;
  remaining: number;
  overage: number;
  used: number;
  total: number;
}

/**
 * Check quota WITHOUT incrementing the counter.
 * Use this when you need to gate a request but will increment later
 * (e.g., get_trade_signal only charges for non-HOLD results).
 */
export function checkQuota(license: LicenseInfo): TrackCallResult {
  if (license.tier === 'x402') {
    return { allowed: true, remaining: Infinity, overage: 0, used: 0, total: Infinity };
  }

  const key = license.tier === 'free' ? `free:${getRequestIpHash() || 'anon'}` : (license.key || 'unknown');
  const tracker = getCallTracker(key);
  const quota = getMonthlyQuota(license.tier);

  const remaining = Math.max(0, quota - tracker.count);
  const overage = Math.max(0, tracker.count - quota);

  if (license.tier === 'free' && tracker.count >= quota) {
    return { allowed: false, remaining: 0, overage, used: tracker.count, total: quota };
  }

  return { allowed: true, remaining, overage, used: tracker.count, total: quota };
}

/**
 * Increment the call counter and check quota.
 * Returns whether the call is allowed after incrementing.
 */
export function trackCall(license: LicenseInfo): TrackCallResult {
  if (license.tier === 'x402') {
    return { allowed: true, remaining: Infinity, overage: 0, used: 0, total: Infinity };
  }

  const key = license.tier === 'free' ? `free:${getRequestIpHash() || 'anon'}` : (license.key || 'unknown');
  const tracker = getCallTracker(key);
  const quota = getMonthlyQuota(license.tier);

  tracker.count++;
  persistTracker(key, tracker);

  const remaining = Math.max(0, quota - tracker.count);
  const overage = Math.max(0, tracker.count - quota);

  // Free tier: block when quota exhausted
  if (license.tier === 'free' && tracker.count > quota) {
    return { allowed: false, remaining: 0, overage, used: tracker.count, total: quota };
  }

  return { allowed: true, remaining, overage, used: tracker.count, total: quota };
}

// ── Upgrade hint for free-tier users ──

const UPGRADE_URL = 'https://api.algovault.com/signup?plan=starter';

export function getUpgradeHint(
  license: LicenseInfo,
  context?: { used?: number; total?: number; cappedResults?: number; totalResults?: number },
): string | undefined {
  if (license.tier !== 'free') return undefined;

  // Capped results hint (funding arb)
  if (context?.cappedResults && context?.totalResults && context.totalResults > context.cappedResults) {
    return `Showing top ${context.cappedResults} of ${context.totalResults} opportunities. Unlock all results with Starter at $9.99/mo → ${UPGRADE_URL}`;
  }

  // Quota usage hint (80%+ used)
  if (context?.used && context?.total) {
    const pctUsed = context.used / context.total;
    if (pctUsed >= 1.0) return undefined; // Handled by quota block
    if (pctUsed >= 0.8) {
      return `You've used ${context.used}/${context.total} free calls this month. Unlock 3,000 calls/mo with Starter at $9.99/mo → ${UPGRADE_URL}`;
    }
  }

  return undefined;
}

export function getQuotaExhaustedMessage(used: number, total: number): string {
  return `Free tier limit reached (${used}/${total} calls this month). Upgrade to Starter ($9.99/mo) for 3,000 calls/mo, or pay per call via x402. → ${UPGRADE_URL}`;
}
