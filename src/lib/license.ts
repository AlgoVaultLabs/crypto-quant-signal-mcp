/**
 * Three-tier access gating (checked in order):
 * 1. x402 (valid payment proof in header → full access)
 * 2. API key (CQS_API_KEY env var or Authorization: Bearer header)
 *    - Pro ($49/mo): 15K calls/mo, overage $0.01/call
 *    - Enterprise ($299/mo): 100K calls/mo, overage $0.005/call
 * 3. Free tier (no key, no payment)
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { verifyX402Payment, isX402Configured, paymentMatchesToolRoute, classifyToolRouteMismatch } from './x402.js';
import { extractPaymentNonce, tryClaimPayment } from './x402-idempotency-store.js';
import { validateApiKey as stripeValidateApiKey } from './stripe.js';
import { dbExec, dbRun, dbQuery, recordFunnelEvent } from './performance-db.js';
import type { LicenseInfo, LicenseTier } from '../types.js';
// ACTIVATION-NUDGE-W1 (2026-06-18): the soft-quota + 100%-limit upgrade copy is
// now the architect-approved CTA copy with LIVE track-record values + the single
// SOFT_THRESHOLD source (shared with tier-warning's quota_hit_soft band).
import { SOFT_THRESHOLD } from './activation-thresholds.js';
import { getTrackRecord } from './track-record-snapshot.js';
import { buildSoftNudge, buildLimitMessage } from './nudge-copy.js';
// REFERRAL-LIGHT-W1 (C2): free-tier keys + the referee bonus-calls meter.
import { lookupFreeKey, lookupFreeKeyCached, FREE_KEY_PREFIX } from './free-keys-store.js';
import { loadAllBonuses, persistBonusRemaining, grantBonus } from './referral-store.js';

// v1.10.3 FREE-UNLOCK-W1: free tier now grants ALL coins + ALL timeframes —
// the 100-calls/month cap is the primary upsell trigger; funding-arb top-5
// (FREE_FUNDING_LIMIT) remains the secondary upsell hook.
//
// FREE_COINS / FREE_TIMEFRAMES are kept commented-out as reserved
// emergency-rate-limit-defense switches. To re-gate free tier (e.g. if
// upstream Hyperliquid throttles us as a result of this opening), uncomment
// these constants and the corresponding `.has()` checks in canAccessCoin /
// canAccessTimeframe / freeGateMessage.
// const FREE_COINS = new Set(['BTC', 'ETH']);            // reserved (v1.10.3 unlock)
// const FREE_TIMEFRAMES = new Set(['15m', '1h']);        // reserved (v1.10.3 unlock)
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
 * Why an x402 proof presented on a priced tool call was NOT honored as a payment
 * for THAT tool (OPS-X402-MCP-PRICE-BINDING-W1). Carried back on `resolveLicense`'s
 * result (alongside the downgraded free/API-key license, with `pendingSettlement`
 * cleared) so the `/mcp` handler can build a precise `X402_PAYMENT_REQUIRED` error
 * keyed on the CALLED tool's requirements — instead of silently charging the wrong
 * (lower) price or replaying one proof across N calls.
 *
 *  - `cross_tool`  — the proof verified, but its matched requirement belongs to a
 *                    DIFFERENT tool's route (e.g. a $0.01 scan_funding_arb proof on
 *                    the $0.02 get_trade_signal call) → wrong asset/network/payTo
 *                    OR amount below this tool's effective price.
 *  - `insufficient`— the proof matched THIS tool's route identity but underpays its
 *                    effective (timeframe-aware) price (e.g. a base $0.02 proof on a
 *                    premium 1m=$0.05 call). (Surfaced as the default reason for any
 *                    binding failure that isn't provably cross-tool.)
 *  - `replayed`    — the proof's ERC-3009 nonce was already claimed (pre-settle
 *                    replay) → `tryClaimPayment` returned false.
 */
export interface X402Downgrade {
  reason: 'cross_tool' | 'insufficient' | 'replayed';
}

/** Optional binding context for `resolveLicense` — the priced MCP `tools/call` path
 * passes the called tool (+ its timeframe arg) so the x402 grant/settle binds to
 * THAT tool's price. Omitted (HTTP route, webhook authz, non-tools/call) → the
 * pre-binding flattened behavior is preserved byte-for-byte. */
export interface ResolveLicenseOpts {
  tool?: string;
  timeframe?: string;
}

/**
 * Internal-bypass check (BOT-W1 / D1-C, 2026-05-08).
 *
 * If BOT_INTERNAL_BYPASS_ENABLED=true AND the request carries
 * X-AlgoVault-Internal-Key matching ALGOVAULT_INTERNAL_BYPASS_KEY, return
 * tier:'internal' (Infinity quota, no counter tick). Used by the public
 * Telegram bot (`algovault-bot`) which loop-calls signal-MCP from the same
 * Hetzner host. Quota for the bot's end-users is enforced bot-side in its own
 * SQLite — `request_log.is_bot_internal` preserves the attribution column for
 * any server-side analytics.
 *
 * Two-flag firewall per CLAUDE.md `## Build rules > Cross-repo wire-up`:
 * outer `BOT_INTERNAL_BYPASS_ENABLED` (default false) + inner key match.
 */
export function checkInternalBypass(
  headers: Record<string, string | undefined>,
): LicenseInfo | null {
  if (process.env.BOT_INTERNAL_BYPASS_ENABLED !== 'true') return null;
  const expected = process.env.ALGOVAULT_INTERNAL_BYPASS_KEY;
  if (!expected || expected.length < 16) return null;
  const supplied =
    headers['x-algovault-internal-key'] || headers['X-AlgoVault-Internal-Key'];
  if (!supplied) return null;
  if (supplied !== expected) return null;
  return { tier: 'internal', key: null };
}

/**
 * Resolve license from request headers using the 4-tier gate:
 * internal-bypass → x402 payment → API key → free tier.
 *
 * Async because x402 verification hits the Facilitator (~100ms).
 * If x402 is not configured (no wallet address), skips to API key / free.
 *
 * `opts.tool` (OPS-X402-MCP-PRICE-BINDING-W1) — when the caller names a PRICED
 * tool (the `/mcp` `tools/call` path), the x402 grant is BOUND to that tool's
 * effective price and the proof's nonce is CLAIMED before the grant:
 *   - `verifyX402Payment(headers, tool)` matches the proof against ONLY this
 *     tool's pre-built requirement (per-tool, not the flattened cross-tool pool);
 *   - `paymentMatchesToolRoute(settlement, tool, timeframe)` re-asserts the
 *     effective-price floor (incl. the timeframe premium) + asset/network/payTo;
 *   - `tryClaimPayment(nonce, ...)` atomically claims the ERC-3009 nonce (single
 *     point of arbitration against concurrent pre-settle replay).
 * If ANY of those fail — cross-tool / underpay / replay / DB-error / empty nonce —
 * the x402 UPGRADE is DENIED (default-deny): the caller falls through to their
 * API-key/free tier, `pendingSettlement` is cleared (→ NO settle, no charge), and
 * an `x402Downgrade.reason` is returned so the handler can build a precise
 * `X402_PAYMENT_REQUIRED` error keyed on THIS tool. A correct exact/over-price
 * proof for the called tool grants `tier:'x402'` + a claimed settlement (unchanged).
 *
 * When `opts.tool` is omitted (HTTP route — which keeps its OWN post-binding +
 * claim — webhook authz, or any non-tools/call request) the behavior is the prior
 * flattened verify: no per-tool bind, no claim, no downgrade field. This keeps the
 * single chokepoint (`verifyX402Payment` is reached only here) while leaving the
 * already-bound HTTP path untouched (it passes no tool → no double-claim).
 */
export async function resolveLicense(
  headers: Record<string, string | undefined>,
  opts?: ResolveLicenseOpts,
): Promise<{ license: LicenseInfo; pendingSettlement?: PendingSettlement; x402Downgrade?: X402Downgrade }> {
  // Tier 0 (BOT-W1 / D1-C): internal bypass for AlgoVault Telegram bot
  const bypass = checkInternalBypass(headers);
  if (bypass) return { license: bypass };

  // Tier 1: x402 payment proof (only if configured)
  if (isX402Configured()) {
    // Per-tool-bound path (priced MCP tools/call): verify against ONLY this tool's
    // requirement so a cross-tool proof can't deep-equal a higher-priced route.
    const x402Result = opts?.tool
      ? await verifyX402Payment(headers, opts.tool)
      : await verifyX402Payment(headers);

    if (x402Result.valid) {
      const pendingSettlement = x402Result._settlement
        ? { paymentPayload: x402Result._settlement.paymentPayload, requirements: x402Result._settlement.requirements }
        : undefined;

      // Unbound callers (HTTP route / webhook authz) keep the prior behavior: grant
      // x402 here; the HTTP route then re-asserts binding + claims the nonce itself.
      if (!opts?.tool) {
        return { license: { tier: 'x402', key: null }, pendingSettlement };
      }

      // Bound caller: enforce the effective-price floor for THIS tool (+ timeframe
      // premium) AND claim the nonce BEFORE granting. Any failure → downgrade.
      const downgrade = await bindAndClaimX402(pendingSettlement, opts.tool, opts.timeframe);
      if (!downgrade) {
        return { license: { tier: 'x402', key: null }, pendingSettlement };
      }
      // Fall through to API-key/free with the reason; pendingSettlement cleared
      // (no settle/charge) by NOT returning it below.
      const authHeader = headers['authorization'] || headers['Authorization'];
      const license = await resolveFromApiKeyAsync(authHeader);
      return { license, x402Downgrade: downgrade };
    }
  }

  // Tier 2: API key (env var or Authorization header) — validated via Stripe
  const authHeader = headers['authorization'] || headers['Authorization'];
  const license = await resolveFromApiKeyAsync(authHeader);
  return { license };
}

/**
 * Bind a verified settlement to `tool`'s effective price and claim its nonce.
 * Returns `undefined` when the proof is a VALID, single-use payment for this tool
 * (→ caller grants x402 + settles); returns an `X402Downgrade` when it must NOT be
 * honored (cross-tool / underpay / replay / DB-error / empty nonce → caller
 * downgrades to free, no settle). Claim happens AFTER the binding check passes and
 * BEFORE the grant, so a replayed/wrong-tool proof never burns a claim it shouldn't.
 */
async function bindAndClaimX402(
  pendingSettlement: PendingSettlement | undefined,
  tool: string,
  timeframe?: string,
): Promise<X402Downgrade | undefined> {
  // (1) Effective-price + identity floor for THIS tool (asset/network/payTo +
  // amount ≥ effective(tool, timeframe)). Rejects the cross-tool downgrade and the
  // premium-timeframe underpay. paymentMatchesToolRoute default-denies on a missing
  // /malformed settlement or unknown tool; classifyToolRouteMismatch returns the
  // matching reason (identity mismatch → cross_tool; amount underpay → insufficient)
  // so the handler advertises the right `reason`. The two stay in lockstep
  // (`classify === 'ok'` iff `paymentMatchesToolRoute === true`).
  if (!paymentMatchesToolRoute(pendingSettlement, tool, timeframe)) {
    const cls = classifyToolRouteMismatch(pendingSettlement, tool, timeframe);
    return { reason: cls === 'insufficient' ? 'insufficient' : 'cross_tool' };
  }

  // (2) Single-use claim BEFORE the grant — close the pre-settle replay window.
  // Fail-safe: empty nonce or DB error → tryClaimPayment returns false → downgrade
  // (default-deny the upgrade; the buyer's on-chain nonce is unspent, costs a retry).
  const requirements = (pendingSettlement?.requirements ?? {}) as { amount?: unknown };
  const matchedReq = Array.isArray(requirements) ? requirements[0] : requirements;
  const amtRaw = (matchedReq as { amount?: unknown })?.amount;
  const amount = typeof amtRaw === 'string' ? amtRaw : amtRaw != null ? String(amtRaw) : '';
  const nonce = extractPaymentNonce(pendingSettlement?.paymentPayload);
  const claimed = await tryClaimPayment(nonce ?? '', tool, amount);
  if (!claimed) {
    return { reason: 'replayed' };
  }

  return undefined; // valid, single-use payment for this tool → grant + settle
}

/**
 * Synchronous license resolution (no x402). Used for stdio mode.
 */
export function resolveLicenseSync(headers: Record<string, string | undefined>): LicenseInfo {
  const bypass = checkInternalBypass(headers);
  if (bypass) return bypass;
  const authHeader = headers['authorization'] || headers['Authorization'];
  return resolveFromApiKey(authHeader);
}

// SECURITY-FIX-TIER-ESCALATION-W1: once-per-process warn guard for the dev-only
// ALLOW_DEV_KEY_PREFIX escape hatch used below.
let devKeyPrefixWarned = false;

/**
 * Async license resolution — validates an API key against Stripe (HTTP path).
 * SECURITY-FIX-TIER-ESCALATION-W1: a Stripe-INVALID key DEFAULT-DENIES to `free`;
 * the prefix shortcut survives only as a dev-only opt-in (ALLOW_DEV_KEY_PREFIX,
 * default OFF). The stdio path (resolveLicenseSync → resolveFromApiKey) is
 * intentionally UNCHANGED — operators tier their own local CQS_API_KEY.
 */
async function resolveFromApiKeyAsync(authHeader?: string): Promise<LicenseInfo> {
  const key = extractApiKey(authHeader);
  if (!key) return { tier: 'free', key: null };

  // REFERRAL-LIGHT-W1 (C2): av_free_ keys resolve via the free-keys store, NEVER
  // Stripe. A KNOWN free key tracks BY KEY (durable identity for the +500 bonus);
  // an UNKNOWN av_free_ key default-denies to keyless free.
  if (key.startsWith(FREE_KEY_PREFIX)) {
    const fk = await lookupFreeKey(key);
    return fk ? { tier: 'free', key } : { tier: 'free', key: null };
  }

  // Try Stripe validation (cached, 5-min TTL)
  const stripeResult = await stripeValidateApiKey(key);
  if (stripeResult.valid && stripeResult.tier) {
    return { tier: stripeResult.tier, key };
  }

  // SECURITY-FIX-TIER-ESCALATION-W1 — DEFAULT-DENY: a Stripe-invalid key resolves to
  // least privilege (free), never an escalated prefix tier. The prefix shortcut is an
  // explicit dev-only opt-in (ALLOW_DEV_KEY_PREFIX, default OFF; mirrors the
  // BOT_INTERNAL_BYPASS_ENABLED two-flag pattern). The stdio path (resolveFromApiKey
  // via resolveLicenseSync) is intentionally NOT gated — operators tier their own key.
  if (process.env.ALLOW_DEV_KEY_PREFIX === 'true') {
    if (!devKeyPrefixWarned) {
      devKeyPrefixWarned = true;
      console.warn('[SECURITY] ALLOW_DEV_KEY_PREFIX=true — Stripe-invalid API keys resolve to prefix-based tiers (dev-only). Unset in production.');
    }
    return resolveFromApiKey(authHeader);
  }
  return { tier: 'free', key: null };
}

/**
 * Synchronous license resolution from API key (no Stripe call).
 * Used for stdio mode and cache warming.
 */
function resolveFromApiKey(authHeader?: string): LicenseInfo {
  const key = extractApiKey(authHeader);
  if (!key) return { tier: 'free', key: null };

  // REFERRAL-LIGHT-W1 (C2): av_free_ keys are free tier — NEVER the prefix-based
  // pro/enterprise escalation below. The sync (stdio) path is cache-only; a cache
  // miss → keyless free (the durable lookup is the async HTTP path that warms it).
  if (key.startsWith(FREE_KEY_PREFIX)) {
    const fk = lookupFreeKeyCached(key);
    return fk ? { tier: 'free', key } : { tier: 'free', key: null };
  }

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

/**
 * v1.10.3 FREE-UNLOCK-W1: free tier accesses every supported coin.
 * Coin gating is no longer enforced — the monthly 100-call cap (per
 * `checkQuota`) is the primary upsell trigger. Function kept (not removed)
 * because callers still invoke it as a guard; it now always returns true.
 */
export function canAccessCoin(_coin: string, _license?: LicenseInfo): boolean {
  return true;
}

/**
 * v1.10.3 FREE-UNLOCK-W1: free tier accesses every supported timeframe
 * (1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h, 1d — 11 total per the Zod
 * enum at src/index.ts). Same rationale as `canAccessCoin`.
 */
export function canAccessTimeframe(_timeframe: string, _license?: LicenseInfo): boolean {
  return true;
}

export function getFundingArbLimit(requestedLimit: number, license?: LicenseInfo): number {
  const l = license || getRequestLicense();
  if (l.tier !== 'free') return requestedLimit;
  return Math.min(requestedLimit, FREE_FUNDING_LIMIT);
}

/**
 * v1.10.3: returns empty string — coin/timeframe gating removed for free
 * tier. The function is preserved as a callable seam in case the reserved
 * `FREE_COINS` / `FREE_TIMEFRAMES` constants are ever re-enabled. The
 * separate quota-exhaustion path (`getQuotaExhaustedMessage`) handles the
 * "upgrade to Starter" surface that USED to live here.
 */
export function freeGateMessage(_coin: string, _timeframe: string): string {
  return '';
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

// ── REFERRAL-LIGHT-W1 (C2): referee bonus-calls meter ──
// In-memory map mirrors the quota_usage pattern — seeded from referral_bonus at
// initQuotaDb, kept current by write-through persist on consume + the
// grantReferralBonus wrapper. Free-tier units exceeding the monthly allowance
// draw from this (atomic, all-or-nothing). The value is INTERNAL: portal-only,
// never surfaced in the _algovault envelope (strict shape snapshot).
const bonusRemaining = new Map<string, number>();
let bonusLoaded = false;

/**
 * Tracker-key derivation (single source). Free-WITH-key (av_free_ referral key)
 * tracks BY KEY → its durable bonus bucket; keyless free by ip-hash; paid by key.
 * Replaces the three inline `free:${ipHash}` derivations (keyless-free + paid
 * behavior byte-identical; only keyed-free is new — zero av_free_ keys today).
 */
function deriveTrackerKey(license: LicenseInfo): string {
  if (license.tier === 'free') {
    return license.key || `free:${getRequestIpHash() || 'anon'}`;
  }
  return license.key || 'unknown';
}

/** In-memory referral bonus for a tracker key (0 if none). Portal/test reader. */
export function getBonusForKey(trackerKey: string): number {
  return bonusRemaining.get(trackerKey) ?? 0;
}

/** Atomic all-or-nothing consume of `needed` bonus units + write-through persist. */
function consumeBonusUnits(trackerKey: string, needed: number): boolean {
  if (needed <= 0) return true;
  const have = bonusRemaining.get(trackerKey) ?? 0;
  if (have < needed) return false;
  const next = have - needed;
  bonusRemaining.set(trackerKey, next);
  persistBonusRemaining(trackerKey, next);
  return true;
}

/**
 * Grant referral bonus calls (C3 free-signup + paid-conversion). Updates the
 * in-memory meter AND persists via referral_store.grantBonus so a fresh grant is
 * visible to the very next call in this process. Returns the new total.
 */
export async function grantReferralBonus(trackerKey: string, calls: number, sourceCode?: string | null): Promise<number> {
  const total = await grantBonus(trackerKey, calls, sourceCode);
  bonusRemaining.set(trackerKey, total);
  return total;
}

/**
 * Charge a FREE-tier request against the monthly allowance, then the referral
 * bonus for any overflow (atomic). When bonus covers the overflow the monthly
 * counter caps at quota; otherwise the attempt is counted (overage visible) and
 * the call is blocked. Used by both trackCall and trackCallByKey (free path).
 */
function freeMeterCharge(trackerKey: string, tracker: CallTracker, quota: number, units: number): TrackCallResult {
  const before = tracker.count;
  const monthlyRemaining = Math.max(0, quota - before);
  const monthlyConsume = Math.min(units, monthlyRemaining);
  const overflow = units - monthlyConsume;
  let allowed = true;
  if (overflow === 0) {
    tracker.count = before + units;
  } else if (consumeBonusUnits(trackerKey, overflow)) {
    tracker.count = before + monthlyConsume; // monthly capped; overflow drawn from bonus
  } else {
    tracker.count = before + units; // count the attempt so overage is visible
    allowed = false;
  }
  persistTracker(trackerKey, tracker);
  const remaining = Math.max(0, quota - tracker.count);
  const overage = Math.max(0, tracker.count - quota);
  const result: TrackCallResult = { allowed, remaining, overage, used: tracker.count, total: quota };
  const bonus = bonusRemaining.get(trackerKey);
  if (bonus !== undefined) result.bonus_remaining = bonus;
  return result;
}

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
    // REFERRAL-LIGHT-W1 (C2): warm the referral bonus meter from referral_bonus
    // (fire-and-forget, mirrors the quota_usage warm). Grants/consumes during the
    // process keep the map current via grantReferralBonus + write-through persist.
    if (!bonusLoaded) {
      loadAllBonuses()
        .then(rows => { for (const r of rows) bonusRemaining.set(r.tracker_key, r.bonus_remaining); bonusLoaded = true; })
        .catch(() => {});
    }
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

// SCAN-TRADE-CALLS-W1 C1: multi-unit quota seam. Batch tools (scan_trade_calls,
// future batch regime/chat, TG /scan) charge N units per request. Default-deny
// per CLAUDE.md — any non-finite / sub-1 value collapses to 1 so a bad caller
// can never charge 0 (or a negative). Fractional units floor to an integer ≥1.
function clampUnits(units: number): number {
  return Number.isFinite(units) && units >= 1 ? Math.floor(units) : 1;
}

export function getMonthlyQuota(tier: LicenseTier): number {
  switch (tier) {
    case 'starter': return 3_000;
    case 'pro': return 15_000;
    case 'enterprise': return 100_000;
    case 'x402': return Infinity;
    // BOT-W1 / D1-C: internal bypass — server-side counter is bypassed; the
    // bot enforces per-user quota in its own SQLite.
    case 'internal': return Infinity;
    default: return 100;
  }
}

export interface TrackCallResult {
  allowed: boolean;
  remaining: number;
  overage: number;
  used: number;
  total: number;
  /**
   * REFERRAL-LIGHT-W1 (C2): referee bonus calls remaining after this charge.
   * INTERNAL — consumed by the /account portal only; NEVER surfaced in the
   * `_algovault` envelope (the scan/trade shape snapshots are a strict allow-list).
   */
  bonus_remaining?: number;
}

/**
 * Check quota WITHOUT incrementing the counter.
 * Use this when you need to gate a request but will increment later
 * (e.g., get_trade_signal only charges for non-HOLD results).
 */
export function checkQuota(license: LicenseInfo): TrackCallResult {
  if (license.tier === 'x402' || license.tier === 'internal') {
    return { allowed: true, remaining: Infinity, overage: 0, used: 0, total: Infinity };
  }

  const key = deriveTrackerKey(license);
  const tracker = getCallTracker(key);
  const quota = getMonthlyQuota(license.tier);

  const remaining = Math.max(0, quota - tracker.count);
  const overage = Math.max(0, tracker.count - quota);

  if (license.tier === 'free' && tracker.count >= quota) {
    // REFERRAL-LIGHT-W1 (C2): if the referee still has bonus calls, the request
    // is NOT blocked (the actual consume happens in trackCall) — and it is NOT a
    // quota_hit_block (the user hasn't hit a wall).
    const bonus = bonusRemaining.get(key) ?? 0;
    if (bonus > 0) {
      return { allowed: true, remaining, overage, used: tracker.count, total: quota, bonus_remaining: bonus };
    }
    // ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28): stage 6 quota_hit_block. Fires
    // on EVERY blocked call (snapshot reader's COUNT(DISTINCT session_id)
    // collapses to 1-per-session). Fail-open per recordFunnelEvent contract.
    recordFunnelEvent({
      eventType: 'quota_hit_block',
      sessionId: getRequestSessionId() ?? null,
      licenseTier: license.tier,
      meta: {
        used: tracker.count,
        total: quota,
      },
    });
    return { allowed: false, remaining: 0, overage, used: tracker.count, total: quota };
  }

  return { allowed: true, remaining, overage, used: tracker.count, total: quota };
}

/**
 * Increment the call counter and check quota.
 * Returns whether the call is allowed after incrementing.
 *
 * `units` (default 1) charges a batch atomically — a scan returning 5 non-HOLD
 * calls charges 5 in one increment. Existing single-call sites pass nothing and
 * stay byte-identical (units defaults to 1). Default-deny via clampUnits.
 */
export function trackCall(license: LicenseInfo, units = 1): TrackCallResult {
  if (license.tier === 'x402' || license.tier === 'internal') {
    return { allowed: true, remaining: Infinity, overage: 0, used: 0, total: Infinity };
  }

  const key = deriveTrackerKey(license);
  const tracker = getCallTracker(key);
  const quota = getMonthlyQuota(license.tier);

  // REFERRAL-LIGHT-W1 (C2): free tier draws monthly-then-bonus (atomic overflow).
  if (license.tier === 'free') {
    return freeMeterCharge(key, tracker, quota, clampUnits(units));
  }

  tracker.count += clampUnits(units);
  persistTracker(key, tracker);

  const remaining = Math.max(0, quota - tracker.count);
  const overage = Math.max(0, tracker.count - quota);

  return { allowed: true, remaining, overage, used: tracker.count, total: quota };
}

// ── Key-addressed quota meter (CALL-REGIME-WEBHOOK-LAYER-W1, 2026-05-29) ──
// Webhook deliveries are charged to the OWNER's monthly call quota "exactly like
// a pull call" (Mr.1/Cowork-ratified) but run in a background worker with NO
// request context, so the IP-derived free-tier key in trackCall()/checkQuota()
// is unavailable. These two helpers charge/check an EXPLICIT tracker key against
// the SAME in-memory meter (callTrackers) + the SAME getMonthlyQuota() values —
// they add a key-addressed seam, they do NOT change any quota or tier. The
// webhook subscription stores its owner's tracker key (= the API key) so each
// delivery draws from the identical bucket the owner's API key already uses.

/** Check (without incrementing) an explicit tracker key against the monthly meter. */
export function checkQuotaByKey(trackerKey: string, tier: LicenseTier): TrackCallResult {
  if (tier === 'x402' || tier === 'internal') {
    return { allowed: true, remaining: Infinity, overage: 0, used: 0, total: Infinity };
  }
  const tracker = getCallTracker(trackerKey);
  const quota = getMonthlyQuota(tier);
  const remaining = Math.max(0, quota - tracker.count);
  const overage = Math.max(0, tracker.count - quota);
  if (tracker.count >= quota) {
    // REFERRAL-LIGHT-W1 (C2): a free owner with bonus left is not blocked here
    // (consume happens in trackCallByKey).
    if (tier === 'free' && (bonusRemaining.get(trackerKey) ?? 0) > 0) {
      return { allowed: true, remaining, overage, used: tracker.count, total: quota, bonus_remaining: bonusRemaining.get(trackerKey) };
    }
    return { allowed: false, remaining: 0, overage, used: tracker.count, total: quota };
  }
  return { allowed: true, remaining, overage, used: tracker.count, total: quota };
}

/** Increment + check an explicit tracker key against the monthly meter. */
export function trackCallByKey(trackerKey: string, tier: LicenseTier, units = 1): TrackCallResult {
  if (tier === 'x402' || tier === 'internal') {
    return { allowed: true, remaining: Infinity, overage: 0, used: 0, total: Infinity };
  }
  const tracker = getCallTracker(trackerKey);
  const quota = getMonthlyQuota(tier);
  // REFERRAL-LIGHT-W1 (C2): free tier draws monthly-then-bonus (atomic overflow).
  if (tier === 'free') {
    return freeMeterCharge(trackerKey, tracker, quota, clampUnits(units));
  }
  tracker.count += clampUnits(units);
  persistTracker(trackerKey, tracker);
  const remaining = Math.max(0, quota - tracker.count);
  const overage = Math.max(0, tracker.count - quota);
  if (tracker.count > quota) {
    return { allowed: false, remaining: 0, overage, used: tracker.count, total: quota };
  }
  return { allowed: true, remaining, overage, used: tracker.count, total: quota };
}

// ── Upgrade hint for free-tier users ──

// ACTIVATION-FUNNEL-AUDIT-W1 (2026-05-28): `upgrade_from=quota` allows the
// /signup handler to capture `upgrade_cta_clicked` (stage 7) funnel event.
const UPGRADE_URL = 'https://api.algovault.com/signup?plan=starter&upgrade_from=quota';

export function getUpgradeHint(
  license: LicenseInfo,
  context?: { used?: number; total?: number; cappedResults?: number; totalResults?: number },
): string | undefined {
  if (license.tier !== 'free') return undefined;

  // Capped results hint (funding arb)
  if (context?.cappedResults && context?.totalResults && context.totalResults > context.cappedResults) {
    return `Showing top ${context.cappedResults} of ${context.totalResults} opportunities. Unlock all results with Starter at $9.99/mo → ${UPGRADE_URL}`;
  }

  // Quota usage hint: free-tier soft nudge at/above SOFT_THRESHOLD (the single
  // source shared with tier-warning's quota_hit_soft band — A1). Approved CTA
  // copy + LIVE track-record values; `upgrade_from=soft`.
  if (context?.used && context?.total) {
    const pctUsed = context.used / context.total;
    if (pctUsed >= 1.0) return undefined; // Handled by the TIER_LIMIT_REACHED path
    if (pctUsed >= SOFT_THRESHOLD) {
      return buildSoftNudge({ used: context.used, total: context.total, ...getTrackRecord() });
    }
  }

  return undefined;
}

export function getQuotaExhaustedMessage(used: number, total: number): string {
  // ACTIVATION-NUDGE-W1: approved 100%-limit copy + LIVE track-record values via
  // the shared builder (same string the TIER_LIMIT_REACHED envelope renders).
  // `used` is unused in the copy (the message states the `total` cap) but kept
  // in the signature for call-site compatibility + future use.
  void used;
  return buildLimitMessage({ total, ...getTrackRecord() });
}

/**
 * Days remaining until the in-process monthly counter resets. Reads the
 * caller's tracker `periodStart` and computes wall-clock days until
 * `periodStart + MONTH_MS`. If no tracker exists (caller hasn't made any
 * call yet — unusual at the quota-exhausted path), returns 30 as a safe
 * default. Used by ACTIVATION-PAYWALL-W1 `TierLimitReachedError` to set
 * the structured-error `retry_after_days` field.
 */
export function daysUntilMonthReset(license: LicenseInfo): number {
  const key = deriveTrackerKey(license);
  const tracker = callTrackers.get(key);
  if (!tracker) return 30;
  const msUntilReset = (tracker.periodStart + MONTH_MS) - Date.now();
  if (msUntilReset <= 0) return 0;
  return Math.ceil(msUntilReset / (24 * 60 * 60 * 1000));
}
