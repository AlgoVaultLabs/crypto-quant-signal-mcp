/**
 * Three-tier access gating (checked in order):
 * 1. x402 (valid payment proof in header → full access)
 * 2. API key (CQS_API_KEY env var or Authorization: Bearer header)
 *    - Starter: 10K calls/mo + 1K/day · Pro: 100K/mo + 10K/day (see plans.ts#PLANS —
 *      the ONE ladder; this comment names tiers, never their numbers)
 *    - Enterprise: custom volume, contact-us. There is no overage billing on any tier:
 *      the wall REFUSES, it does not bill.
 * 3. Free tier (no key, no payment)
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { utcDayKey, utcDayResetAtMs, hoursUntilUtcDayReset } from './utc-day.js';
import { verifyX402Payment, isX402Configured, paymentMatchesToolRoute, classifyToolRouteMismatch } from './x402.js';
import { extractPaymentNonce, extractPayerWallet, tryClaimPayment, railForRequirement } from './x402-idempotency-store.js';
import { validateApiKey as stripeValidateApiKey } from './stripe.js';
import { dbExec, dbRun, dbQuery, recordFunnelEvent } from './performance-db.js';
import type { LicenseInfo, LicenseTier, SuggestedX402 } from '../types.js';
// ACTIVATION-NUDGE-W1 (2026-06-18): the soft-quota + 100%-limit upgrade copy is
// now the architect-approved CTA copy with LIVE track-record values + the single
// SOFT_THRESHOLD source (shared with tier-warning's quota_hit_soft band).
import { SOFT_THRESHOLD } from './activation-thresholds.js';
// OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1 CH2: the one derivation of "which meter binds".
// LEAF (type-only imports), so this consumer edge closes no cycle — the same reason
// `quota-notice.ts` is safe to import from here.
import { bindingMeter } from './binding-meter.js';
import { getTrackRecord } from './track-record-snapshot.js';
import { buildSoftNudge } from './nudge-copy.js';
// OPS-QUOTA-EXHAUSTION-NOTICE-W1: the 100% wall message moved to the one notice contract.
import { buildQuotaNoticeMessage } from './quota-notice.js';
import { PLANS, FREE_MONTHLY_CALLS, FREE_DAILY_CALLS, DEFAULT_UPGRADE_PLAN, planPriceLabel } from './plans.js';
// REFERRAL-LIGHT-W1 (C2): free-tier keys + the referee bonus-calls meter.
import { lookupFreeKey, lookupFreeKeyCached, FREE_KEY_PREFIX } from './free-keys-store.js';
import { loadAllBonuses, persistBonusRemaining, grantBonus } from './referral-store.js';
import { recordIndeterminate } from './indeterminate-counter.js';
// AUTH-THREE-STATE-W1 CH1: the ONE credential vocabulary. LEAF (type-only imports of its own), so
// this consumer edge closes no cycle — same reasoning as `binding-meter.ts` above.
import { classifyCredential, isRetryable, type CredentialOutcome } from './credential-outcome.js';

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
  /**
   * OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: the per-request `classifyTraffic`
   * verdict (is_automated), computed ONCE at the /mcp POST (and x402/a2mcp) layer
   * where raw UA/IP/tier are in scope, then read by `logRequest()` to stamp
   * `request_log.is_automated`. Single-derivation with the `mcp_connect` funnel
   * emit — the SAME verdict feeds both. Absent (edge paths) → fail-open FALSE.
   */
  isAutomated?: boolean;
  /**
   * OPS-CLIENT-ATTRIBUTION-W1: the raw request User-Agent, captured ONCE at the /mcp POST
   * layer where headers are in scope (the SAME value that feeds classifyTraffic above), then
   * read by `logRequest()` to stamp `request_log.user_agent` + `client_name`. Threaded rather
   * than re-read so the persisted identity and the is_automated verdict are guaranteed to
   * describe the same string. Absent (stdio / edge paths) → stored as NULL / 'unknown'.
   */
  userAgent?: string | null;
  /**
   * FUNNEL-FIX-ATTRIBUTION-W1: the classifed acquisition source (classifySource) for
   * this request, resolved ONCE at the /mcp POST layer where headers are in scope, then
   * read at the agent_sessions write to stamp first_touch (write-once) + last_touch.
   * Additive; does NOT touch resolveSessionIdentity. Absent (edge paths) → not stamped.
   */
  source?: string;
  /**
   * OPS-HL-INTERACTIVE-PRIORITY-W1: this request opted OUT of the interactive
   * rate-limit lane (`X-AlgoVault-Priority: background`), so its upstream venue
   * fetches run in the BATCH lane — waiting politely instead of competing with live
   * callers for the interactive reserve. Resolved ONCE at the /mcp POST layer where
   * headers are in scope, then read by the tool handler. Absent → FALSE (fail-safe:
   * an unrecognized request stays interactive, never silently delayed).
   */
  background?: boolean;
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

/** FUNNEL-FIX-ATTRIBUTION-W1: the classified acquisition source for the current request. */
export function getRequestSource(): string | undefined {
  return requestContext.getStore()?.source;
}

// PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (CH5): `setRequestVerdict` / `getRequestVerdict` and
// the `lastVerdict` context field are DELETED. They existed for exactly one purpose — their own
// docstring said so: "so HTTP layer can skip x402 settlement for HOLD" — and R-A removed that
// skip. Verified before removal: one writer (index.ts), ZERO readers, no test.
//
// Deleted rather than left in place because a write-only seam is worse than no seam: it still
// LOOKS like the source of truth for "what did this request decide", so the next wave wires a
// second consumer to a field nothing maintains. Same reasoning as this file's
// `getQuotaExhaustedMessage` tombstone above. The per-request verdict is still logged to
// `request_log.verdict`, which is where a consumer should read it.

/**
 * OPS-ANALYTICS-GENUINE-VS-AUTOMATED-SPLIT-W1: read the per-request automated
 * verdict for the `request_log.is_automated` stamp. Fail-open FALSE when unset
 * (stdio / edge paths without a classifier input) — never silently inflate the
 * automated bucket.
 */
export function getRequestIsAutomated(): boolean {
  return requestContext.getStore()?.isAutomated ?? false;
}

/**
 * OPS-CLIENT-ATTRIBUTION-W1: read the per-request raw User-Agent for the
 * `request_log.user_agent` / `client_name` stamp. Returns null when unset (stdio / edge
 * paths) — the writer then stores NULL + `unknown` rather than inventing an identity.
 */
export function getRequestUserAgent(): string | null {
  return requestContext.getStore()?.userAgent ?? null;
}

/**
 * OPS-HL-INTERACTIVE-PRIORITY-W1 — PURE header resolution, unit-tested.
 *
 * A caller may opt into the batch lane with `X-AlgoVault-Priority: background`, but
 * ONLY an internally-authenticated caller is honoured. The batch lane is allowed to
 * WAIT up to ~5 minutes to yield the interactive reserve; parking an ordinary public
 * client there would look like a hang, so the gate is deliberately closed to them.
 * This is not a security boundary (self-deprioritising harms nobody) — it is a
 * blast-radius one.
 */
export function resolveBackgroundPriority(
  headers: Record<string, string | undefined>,
  tier: string,
): boolean {
  if (tier !== 'internal') return false;
  const raw = headers['x-algovault-priority'] ?? headers['X-AlgoVault-Priority'];
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'background';
}

/**
 * Read the per-request background flag. Fail-safe FALSE on every edge path (stdio,
 * x402, direct calls) — an unknown request keeps today's interactive behaviour.
 */
export function getRequestIsBackground(): boolean {
  return requestContext.getStore()?.background ?? false;
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
 *                    replay) → `tryClaimPayment` returned `'ALREADY_CLAIMED'`.
 *  - `unavailable` — the claim could not be evaluated at all (database fault) →
 *                    `tryClaimPayment` returned `'INDETERMINATE'`. Distinct from
 *                    `replayed` ON PURPOSE: one is a fact about the buyer's nonce,
 *                    the other is a confession about ours. This member exists ONLY
 *                    because that boolean was retired (OPS-ZERO-VS-UNKNOWN-W3) —
 *                    which is why this docblock claiming a boolean was doubly wrong.
 *                    _(Corrected REVENUE-METER-TRUTH-W6 CH7.)_
 */
export interface X402Downgrade {
  reason: 'cross_tool' | 'insufficient' | 'replayed' | 'unavailable';
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
  return { tier: 'internal', key: null, outcome: 'RESOLVED' };
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
  // AUTH-THREE-STATE-W1 CH1: a bypass caller IS an established principal — the bypass header is the
  // credential they presented, just not an API key. Stamped RESOLVED so `withAuthState` has an
  // outcome to report for exactly the tiers that have no quota to report (CH2), and so the refusal
  // predicate can never see an unstamped license on the highest-trust path in the system.
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
        // AUTH-THREE-STATE-W1 CH1: the payment proof IS the credential and it verified — RESOLVED.
        // The API key is never consulted on this rail, which is why `/x402/*` is unaffected by the
        // refusal (asserted in CH3 rather than assumed).
        return { license: { tier: 'x402', key: null, outcome: 'RESOLVED' }, pendingSettlement };
      }

      // Bound caller: enforce the effective-price floor for THIS tool (+ timeframe
      // premium) AND claim the nonce BEFORE granting. Any failure → downgrade.
      const downgrade = await bindAndClaimX402(pendingSettlement, opts.tool, opts.timeframe);
      if (!downgrade) {
        // Bound, price-checked and nonce-claimed — same RESOLVED reasoning as the unbound path.
        return { license: { tier: 'x402', key: null, outcome: 'RESOLVED' }, pendingSettlement };
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
  //
  // Fail-safe in BOTH directions, but they are NOT the same outcome and must not be described
  // as one (see :350-351, fifteen lines below):
  //   empty nonce → `'ALREADY_CLAIMED'` → reason `'replayed'`    (a determined refusal: a verified
  //                                                               EIP-3009 payment always carries a
  //                                                               nonce, so its absence is a fact)
  //   DB error    → `'INDETERMINATE'`   → reason `'unavailable'` (we could not evaluate the claim)
  // Either way the upgrade is default-denied and the buyer's on-chain nonce is still unspent, so
  // the cost is one retry.
  //
  // _(Corrected REVENUE-METER-TRUTH-W6 CH7. This line read "empty nonce or DB error →
  // tryClaimPayment returns false → downgrade" — wrong twice: the function has not returned a
  // boolean since OPS-ZERO-VS-UNKNOWN-W3, and lumping the two causes into ONE outcome re-asserted
  // in prose the exact three-into-two collapse that :347-348 forbids in code. Rewriting it as
  // "returns 'ALREADY_CLAIMED'" would have fixed the first error and kept the worse one.)_
  const requirements = (pendingSettlement?.requirements ?? {}) as { amount?: unknown };
  const matchedReq = Array.isArray(requirements) ? requirements[0] : requirements;
  const amtRaw = (matchedReq as { amount?: unknown })?.amount;
  const amount = typeof amtRaw === 'string' ? amtRaw : amtRaw != null ? String(amtRaw) : '';
  const nonce = extractPaymentNonce(pendingSettlement?.paymentPayload);
  // OPS-X402-WALLET-ATTRIBUTION-W1: capture the ERC-3009 payer wallet additively (fail-open —
  // undefined → the EMPTY STRING, never affects the claim decision). Base/USDC rail (MCP x-payment).
  // _(Corrected 2026-08-04 REVENUE-METER-TRUTH-W1 CH1 — this said "NULL column"; see the identical
  // note at x402-http-routes.ts. The column is `NOT NULL DEFAULT ''` per SEC-49 and the store writes
  // `payerWallet ?? ''`, so no NULL is reachable from either writer.)_
  const payerWallet = extractPayerWallet(pendingSettlement?.paymentPayload);
  // OPS-ZERO-VS-UNKNOWN-W3: matched by NAME, never truthiness — a `!claimed` test would
  // re-collapse three states into two and report a database fault as a settled replay.
  // OPS-X402-RAIL-DERIVE-FROM-NETWORK-W1: derived, never hardcoded — see the note at the HTTP
  // site. Passed the WHOLE `requirements` (not `matchedReq`): the derivation is deliberately
  // order-independent over an array, whereas the `[0]` above rents the answer from upstream
  // iteration order. `matchedReq` is still used for the amount, where [0] is the existing
  // contract and out of this wave's scope to change.
  const rail = railForRequirement(pendingSettlement?.requirements);
  const outcome = await tryClaimPayment(nonce ?? '', tool, amount, payerWallet, rail);
  if (outcome === 'INDETERMINATE') return { reason: 'unavailable' };
  if (outcome === 'ALREADY_CLAIMED') return { reason: 'replayed' };

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
  if (!key) return { tier: 'free', key: null, outcome: 'ABSENT' };

  // REFERRAL-LIGHT-W1 (C2): av_free_ keys resolve via the free-keys store, NEVER
  // Stripe. A KNOWN free key tracks BY KEY (durable identity for the +500 bonus);
  // an UNKNOWN av_free_ key default-denies to keyless free.
  if (key.startsWith(FREE_KEY_PREFIX)) {
    // AUTH-THREE-STATE-W1 — A STORE FAULT IS NOT A MISS, on this lane either.
    //
    // `lookupFreeKey` THROWS when the store is unreachable, and an unhandled throw here surfaced
    // as a 500. That is loud rather than silent, so it was never the reported defect — but it left
    // the free-key lane unable to say the one thing this wave exists to say, and it made the
    // resolver's answer depend on ambient infrastructure: WITH a database it answers UNKNOWN,
    // WITHOUT one it dies. CI proved that concretely — a case asserting UNKNOWN passed locally
    // against SQLite and failed on a runner that has no database at all.
    //
    // Same law as the Stripe branch below: could-not-ask is INDETERMINATE and RETRYABLE, never a
    // settled "no such key". Shape stays the discriminant and is still knowable without the store,
    // so an `av_free_`-prefixed string that could never have been minted is MALFORMED and served
    // whatever the store is doing.
    let fk: Awaited<ReturnType<typeof lookupFreeKey>>;
    try {
      fk = await lookupFreeKey(key);
    } catch (err) {
      if (classifyCredential(key) !== 'WELL_FORMED') {
        return { tier: 'free', key, outcome: 'MALFORMED' };
      }
      recordIndeterminate('free_key_lookup', 'free-key store unreachable');
      console.error('[license] free-key lookup failed:', err instanceof Error ? err.message : err);
      return { tier: 'free', key, indeterminate: true, outcome: 'INDETERMINATE', retryable: true };
    }
    // A store MISS is labelled by shape: a revoked or mistyped free key is UNKNOWN (refusable),
    // while a string that could never have been minted is MALFORMED (always served).
    if (!fk) return { tier: 'free', key: null, outcome: unresolvedOutcome(key) };
    // OPS-QUOTA-CLAIM-ALIAS-W1 CH1: the adopted bucket is resolved HERE, on the async path that
    // can afford a DB read, and carried on the license so `deriveTrackerKey` stays lookup-free.
    // Spread-on-presence: a key with no `bucket_key` yields a license object with no `bucketKey`,
    // byte-identical to pre-wave for every key issued before this column existed.
    return fk.bucket_key
      ? { tier: 'free', key, bucketKey: fk.bucket_key, outcome: 'RESOLVED' }
      : { tier: 'free', key, outcome: 'RESOLVED' };
  }

  // Try Stripe validation (cached, 5-min TTL)
  const stripeResult = await stripeValidateApiKey(key);
  if (stripeResult.valid && stripeResult.tier) {
    return { tier: stripeResult.tier, key, outcome: 'RESOLVED' };
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
  // OPS-ZERO-VS-UNKNOWN-W1 — "could not determine" is NOT "invalid".
  //
  // Until now a Stripe outage returned `valid:false`, which fell through to the default-deny
  // below and resolved a PAYING customer to `{tier:'free', key:null}`. That is not a graceful
  // degradation: the caller is then metered against `free:<ipHash>`, burns a 100-call ceiling
  // they never bought, and is refused — having paid. A transient upstream fault became a
  // permanent-looking customer-facing failure.
  //
  // POLICY, stated rather than inherited: on INDETERMINATE we keep the caller's KEY IDENTITY
  // (so they are never metered into the anonymous free bucket) and resolve to their last known
  // tier if the cache still holds one; otherwise we return the key WITHOUT a tier grant, and the
  // route surfaces a RETRYABLE error rather than a silent downgrade. We do NOT fail the process
  // and we do NOT escalate — a guard on a live serving path refuses the operation, it does not
  // take the server down, and it never grants more than it can prove.
  if (stripeResult.indeterminate) {
    // AUTH-THREE-STATE-W1 CH1 — SHAPE IS THE DISCRIMINANT HERE TOO, and this branch is the one
    // that makes default-ON refusal safe.
    //
    // This test fires BEFORE the not-found return below, and `validateApiKey` answers
    // `indeterminate` when Stripe is merely UNCONFIGURED as well as when it is unreachable. So a
    // naive "INDETERMINATE ⇒ refuse" would refuse `Bearer ${env:AV_API_KEY}` — the literal string
    // our own docs' top failure mode produces — during any Stripe outage, and in every environment
    // without STRIPE_SECRET_KEY. That is precisely the compat lane the whole default-ON argument
    // rests on, so it is closed here rather than defended by convention.
    //
    // Shape is knowable WITHOUT Stripe: a credential that cannot be one we issued is a client
    // misconfiguration, and Stripe's health has no bearing on it. It is therefore MALFORMED and
    // always served, whatever the upstream is doing.
    //
    // `key` is PRESERVED on this branch too, so the object is byte-identical to what this branch
    // has always returned and only `outcome` is added. CH1 changes no behaviour — including which
    // bucket a caller meters on mid-outage. Dropping the key here would quietly move every
    // unexpanded-env-var caller from their own bucket to `free:<ipHash>`, which is a metering
    // change wearing a labelling change, and it would break the key-preservation guard at
    // `tests/unit/indeterminate-auth.test.ts:92-96` that OPS-ZERO-VS-UNKNOWN-W1 left behind.
    if (classifyCredential(key) !== 'WELL_FORMED') {
      return { tier: 'free', key, outcome: 'MALFORMED' };
    }
    recordIndeterminate('stripe_validate_api_key', 'license resolution could not determine tier');
    // KEY IDENTITY IS PRESERVED. That is the load-bearing half: with `key` retained the caller
    // is metered on their own bucket, not `free:<ipHash>`, so an upstream blip can no longer burn
    // an anonymous ceiling they never bought. The tier is not escalated — we never grant what we
    // cannot prove — and `indeterminate` tells the route to surface a RETRYABLE error instead of
    // presenting a downgrade as settled fact.
    //
    // `indeterminate` is KEPT beside `outcome`, not replaced by it: it is what `recordIndeterminate`
    // and the OPS-ZERO-VS-UNKNOWN-W1 policy above are written against. This chapter makes that
    // policy executable — the "RETRYABLE error" the docblock has promised since that wave finally
    // has a reader in CH2 — it does not rewrite it.
    return { tier: 'free', key, indeterminate: true, outcome: 'INDETERMINATE', retryable: true };
  }
  // AUTH-THREE-STATE-W1 CH1 — THE CORE DEFECT. This return was byte-identical to the three above
  // it, so "Stripe says this key does not exist" and "no key was sent" were one value. A paying
  // customer with a typo'd or revoked key landed here and was served the anonymous free tier.
  return { tier: 'free', key: null, outcome: unresolvedOutcome(key) };
}

/**
 * The outcome for a credential the store came back EMPTY on. Shape is the discriminant, and the
 * asymmetry is deliberate:
 *
 * - WELL_FORMED ⇒ `UNKNOWN`. Nobody sends a correctly-shaped 24-hex AlgoVault key by accident, so
 *   this is a real customer holding a key that does not resolve — the case worth refusing.
 * - anything else ⇒ `MALFORMED`. It cannot be a key we ever minted, so "not found" tells us
 *   nothing we did not already know from the shape, and refusing it would break the documented
 *   unexpanded-`${env:AV_API_KEY}` lane for zero security benefit.
 *
 * 🛑 Called only AFTER a lookup returns empty. It must never be used to decide whether to look up:
 * `tests/security-fix-tier-escalation.test.ts:82-87` pins a Stripe-VALID key that fails the shape
 * test, and short-circuiting on shape would deny that customer.
 */
function unresolvedOutcome(key: string): CredentialOutcome {
  return classifyCredential(key) === 'WELL_FORMED' ? 'UNKNOWN' : 'MALFORMED';
}

/**
 * Synchronous license resolution from API key (no Stripe call).
 * Used for stdio mode and cache warming.
 */
function resolveFromApiKey(authHeader?: string): LicenseInfo {
  const key = extractApiKey(authHeader);
  if (!key) return { tier: 'free', key: null, outcome: 'ABSENT' };

  // REFERRAL-LIGHT-W1 (C2): av_free_ keys are free tier — NEVER the prefix-based
  // pro/enterprise escalation below. The sync (stdio) path is cache-only; a cache
  // miss → keyless free (the durable lookup is the async HTTP path that warms it).
  if (key.startsWith(FREE_KEY_PREFIX)) {
    const fk = lookupFreeKeyCached(key);
    if (fk) return { tier: 'free', key, outcome: 'RESOLVED' };
    // AUTH-THREE-STATE-W1 CH1: a cache MISS on this path is not evidence of non-existence — this
    // lookup is cache-only BY DESIGN and never consults the durable store (that is the async HTTP
    // path's job, per the note above). Labelling it UNKNOWN would assert a fact we did not
    // establish, which is the exact error this wave exists to stop, so a well-formed key that
    // simply is not warm reads INDETERMINATE.
    //
    // `key: null` is retained deliberately: the documented stdio behaviour is "miss ⇒ keyless
    // free", and CH1 changes no behaviour — only what the license can SAY about itself.
    return classifyCredential(key) === 'WELL_FORMED'
      ? { tier: 'free', key: null, outcome: 'INDETERMINATE', retryable: true }
      : { tier: 'free', key: null, outcome: 'MALFORMED' };
  }

  // Prefix-based tier detection (backward compat)
  // The prefix tiering itself is UNCHANGED — deliberate operator-stdio behaviour, HTTP-reachable
  // only under ALLOW_DEV_KEY_PREFIX=true, pinned by tests/security-fix-tier-escalation.test.ts:89.
  const tier: LicenseTier = key.startsWith('ent_') ? 'enterprise' : key.startsWith('av_starter_') ? 'starter' : 'pro';
  return { tier, key, outcome: 'RESOLVED' };
}

function extractApiKey(authHeader?: string): string | null {
  const envKey = process.env.CQS_API_KEY || null;

  let headerKey: string | null = null;
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) headerKey = match[1];
  }

  // SEC-25 (OPS-AUDIT-REMEDIATION-LOW-W1): the CALLER's credential wins. This was
  // `envKey || headerKey`, so setting CQS_API_KEY on the server silently overrode every
  // caller's Authorization header — one env var re-tiering every request on the box, and an
  // authenticated caller being billed/limited against somebody else's key.
  // The stdio path is unaffected by construction: there is no Authorization header there, so
  // `headerKey` is null and the operator's own CQS_API_KEY still applies (see the
  // resolveFromApiKeyAsync note above — "operators tier their own local CQS_API_KEY").
  const key = headerKey || envKey;
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

/**
 * TEST SEAM — clear the in-memory call meters (PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 CH3).
 *
 * `resetLicenseCache` clears the cached LICENSE, which is a different thing: the meters are a
 * separate module-level map and survived it. That gap was invisible while HOLD was free — two
 * successive HOLD calls both charged nothing, so a test could compare their envelopes and see
 * identical `_algovault.quota`. Under R-A the meter advances on every call, so any test that
 * invokes a tool twice and compares output needs the meter reset between them or it is
 * comparing "first call" against "second call".
 *
 * Deliberately NOT exported as part of the runtime contract: production has no reason to zero a
 * caller's meter, and a reachable "reset my quota" primitive is a billing bypass.
 */
export function _resetCallTrackersForTest(): void {
  callTrackers.clear();
  dailyTrackers.clear();
  bonusRemaining.clear();
}

// PRICING-FOLLOWUPS-GENERATOR-W1 CH1: `dailyUsedFor()` is DELETED.
//
// It was a second way to ask "how many calls has this caller made today", alongside the one
// `checkQuota` computes to decide the daily wall — and its docstring claimed "/account portal
// diagnostics" as a consumer it never had. Measured before deleting: zero non-test references in
// all of `src/`. It was exported, tested, and called by nothing, the same class as
// `hoursUntilUtcDayReset` in the same module.
//
// `checkQuota` now returns `daily_used` / `daily_total` from the read it already performs, so
// there is exactly ONE production answer to that question. Two ways to read one number is drift
// surface, and this pair is what a refusal message prints — the place drift is most expensive.

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

// ── The DAILY meter (PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 CH4, R-B/R-D) ──
//
// A SECOND meter, not a sub-limit of the monthly one. Monthly caps the budget; daily shapes the
// pacing. They refuse INDEPENDENTLY, so `dailyCalls * 31 !== monthlyCalls` by design.
//
// The period is a UTC CALENDAR DAY, deliberately unlike the monthly meter's ROLLING 30-day
// window. That asymmetry is the whole point of R-D: the rolling window is anchored on each
// caller's own first call, so its reset lands on a date nobody can be told in advance — you
// cannot write "resets on the 1st" in copy when it is a different instant for every caller. A
// UTC day resets at 00:00Z for everyone, which is a fact the pricing page can state.
interface DailyTracker {
  count: number;
  /** `YYYY-MM-DD` in UTC. Changing day IS the reset — no timer, no sweep. */
  day: string;
}

const dailyTrackers = new Map<string, DailyTracker>();

// CH1: the UTC day-boundary arithmetic moved DOWN into the `utc-day.ts` leaf so `quota-notice.ts`
// — which may not import this module (cycle) — projects the daily retry hint from the SAME
// derivation the meter enforces against. Re-exported so every existing importer of `license.ts`
// keeps working; the `import` above it is what this module's own internals bind to (a bare
// `export … from` re-exports without binding locally, and the two `utcDayKey()` calls below
// would be a ReferenceError).
export { utcDayKey, utcDayResetAtMs, hoursUntilUtcDayReset };

/** Advance the daily meter and write it through. Never refuses — refusal is `checkQuota`'s job. */
function chargeDaily(key: string, units: number): DailyTracker {
  const t = getDailyTracker(key);
  t.count += units;
  persistDailyTracker(key, t);
  return t;
}

function getDailyTracker(key: string): DailyTracker {
  const today = utcDayKey();
  let t = dailyTrackers.get(key);
  if (!t || t.day !== today) {
    t = { count: 0, day: today };
    dailyTrackers.set(key, t);
  }
  return t;
}

/**
 * PRICING-BOT-DELIVERY-METERING-W1 CH2 — the ONLY export this wave adds to this module.
 *
 * Read the EPISODE KEYS a tracker is currently in: the monthly window's start instant and the UTC
 * day. `checkQuotaByKey` already returns used/total/remaining/limit, so those are not duplicated
 * here — this covers the two fields it does not carry, which the bot needs to scope its
 * "notify once per exhaustion episode" state to the right window (the same window-keyed shape
 * BOT-QUOTA-REFUSAL-SEAM-W1 uses for the free tier).
 *
 * STRICTLY READ-ONLY, and deliberately NOT `getCallTracker`/`getDailyTracker`: both of those
 * CREATE an entry as a side effect, so exposing them would let a read materialise a tracker for a
 * key that has never been charged. This reads the maps directly and answers `null` for absent —
 * absent means "no episode yet", which is a fact, not a zero.
 */
export function getTrackerEpisode(trackerKey: string): {
  periodStart: string | null;
  dailyDay: string | null;
} {
  const call = callTrackers.get(trackerKey);
  const daily = dailyTrackers.get(trackerKey);
  const today = utcDayKey();
  return {
    // An expired window is reported as absent rather than as its stale start: the next charge
    // resets it, so reporting the old instant would name an episode that is already over.
    periodStart:
      call && Date.now() - call.periodStart <= MONTH_MS ? new Date(call.periodStart).toISOString() : null,
    dailyDay: daily && daily.day === today ? daily.day : null,
  };
}

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
    // OPS-QUOTA-CLAIM-ALIAS-W1 CH1 — a CLAIMED key charges the bucket it ADOPTED.
    //
    // One live counter per identity. Not a copy: there is no second row to keep in step, so a
    // caller at 100/200 who claims has 100 remaining IN TOTAL, not 100 keyed AND 100 keyless. That
    // 2x hole is invisible to a wall-only test — at 200/200 both rows are walled and it ships.
    //
    // 🛑 LOOKUP-FREE, deliberately. `bucketKey` is resolved on the ASYNC path and carried on the
    // license; consulting the key store here would put a cache miss on the hot path, and a miss
    // would fall through to `license.key` — a fresh allowance, the very hole this closes. The sync
    // (stdio) path is safe from the other direction for the same reason: a cache miss there yields
    // `key: null`, so the caller lands on `free:${ipHash}` — the same row the alias points at.
    if (license.bucketKey) return license.bucketKey;
    return license.key || `free:${getRequestIpHash() || 'anon'}`;
  }
  return license.key || 'unknown';
}

/**
 * The tracker key for an arbitrary free-tier api key — the ONE derivation the bonus meter shares
 * with the quota meter (OPS-QUOTA-CLAIM-ALIAS-W1 CH1).
 *
 * `grantReferralBonus` is called with the raw `av_free_…` key by `referral-accrual.ts`, while a
 * claimed key SPENDS under its adopted bucket. Granting under one and consuming under the other
 * strands the bonus: the caller is told "you both get bonus calls" and never receives them —
 * precisely the promise-that-never-arrives class `quota-notice.ts` documents avoiding on the chat
 * wall. Routing both through this function keeps identity orthogonal to allowance on BOTH meters,
 * not only the one this wave set out to fix.
 *
 * Cache-only and synchronous by design: it runs on the grant path, and an unresolvable key simply
 * meters by itself, which is the pre-wave behaviour.
 */
export function resolveBonusTrackerKey(apiKey: string): string {
  if (!apiKey.startsWith(FREE_KEY_PREFIX)) return apiKey;
  return lookupFreeKeyCached(apiKey)?.bucket_key || apiKey;
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
  // OPS-QUOTA-CLAIM-ALIAS-W1 CH1 — grant into the SAME bucket that will spend it.
  //
  // Callers hand this the raw `av_free_…` key (`referral-accrual.ts`, both sites), but a CLAIMED
  // key consumes its bonus under the bucket it adopted. Granting under the key and consuming under
  // the bucket strands the grant silently — the caller is promised bonus calls and never receives
  // one. Resolving here rather than at each call site keeps it a single derivation, and is a no-op
  // for every key without an adopted bucket.
  const resolved = resolveBonusTrackerKey(trackerKey);
  const total = await grantBonus(resolved, calls, sourceCode);
  bonusRemaining.set(resolved, total);
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
      period_start TEXT NOT NULL,
      milestone_referral_shown INTEGER NOT NULL DEFAULT 0,
      daily_count INTEGER NOT NULL DEFAULT 0,
      daily_day TEXT NOT NULL DEFAULT ''
    )`);
    // REFERRAL-INPRODUCT-NUDGE-W1: backfill the lifetime-dedup column on EXISTING
    // tables (prod PG is pre-applied via SSH; this is the in-code idempotent net).
    ensureQuotaMilestoneColumn().catch(() => {});
    // CH4: same net for the daily meter. The CREATE above only helps a FRESH store; every
    // existing deployment reaches the columns through this idempotent ensure.
    ensureQuotaDailyColumns()
      .then(() => dbQuery<{ tracker_key: string; daily_count: string; daily_day: string }>(
        'SELECT tracker_key, daily_count, daily_day FROM quota_usage',
      ))
      .then((r) => loadDailyRows(r ?? []))
      .catch(() => {});
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

/**
 * Warm the daily meter from the store, DISCARDING any row whose day is not today.
 *
 * The monthly loader skips an expired period; this is the same idea on a calendar boundary. A
 * loader that trusted the stored count without checking the day would resurrect yesterday's
 * total after any restart or deploy — walling a caller for a day they have not spent. That is
 * the failure mode worth guarding: it is silent, it only appears after a restart, and it looks
 * exactly like correct enforcement.
 */
function loadDailyRows(rows: { tracker_key: string; daily_count: string; daily_day: string }[]): void {
  const today = utcDayKey();
  for (const row of rows) {
    if (row.daily_day !== today) continue; // stale day — starts at zero, by design
    dailyTrackers.set(row.tracker_key, { count: Number(row.daily_count) || 0, day: today });
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

/**
 * Write-through for the daily meter (PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 CH4).
 *
 * Stores the DAY alongside the count, so a restart cannot resurrect yesterday's total: the
 * loader compares the stored day to today and treats a mismatch as zero. Storing only a count
 * would silently carry a caller's spent day across a deploy, walling them for a day they never
 * used. Best-effort, exactly like `persistTracker` — a metering write must never fail a request.
 */
function persistDailyTracker(key: string, t: DailyTracker): void {
  if (!_dailyColsReady) return; // columns not ensured yet — in-memory meter still works
  try {
    dbRun(
      `INSERT INTO quota_usage (tracker_key, call_count, period_start, daily_count, daily_day)
       VALUES (?, 0, ?, ?, ?)
       ON CONFLICT (tracker_key) DO UPDATE SET daily_count = ?, daily_day = ?`,
      key, new Date().toISOString(), t.count, t.day,
      t.count, t.day,
    );
  } catch {
    // Best-effort persistence — don't block the request
  }
}

// ── REFERRAL-INPRODUCT-NUDGE-W1 (2026-06-22): usage-milestone aha referral (c) ──
const PG = !!process.env.DATABASE_URL;

let _dailyColsReady = false;
/**
 * Idempotent ensure of the DAILY meter columns on the EXISTING `quota_usage` store — it extends
 * that table rather than adding a second one, so a caller's two meters cannot end up in
 * disagreeing rows.
 *
 * PG: native `ADD COLUMN IF NOT EXISTS`, and prod is PRE-APPLIED via SSH BEFORE the code deploy
 * (CLAUDE.md: pre-apply schema, then ship code that is a no-op against the prepared DB).
 * SQLite has NO `ADD COLUMN IF NOT EXISTS` (verified 3.37 — it is a syntax error), so it takes
 * the `PRAGMA table_info` pre-check, mirroring `ensureQuotaMilestoneColumn` exactly.
 */
export async function ensureQuotaDailyColumns(): Promise<void> {
  if (_dailyColsReady) return;
  try {
    if (PG) {
      dbExec('ALTER TABLE quota_usage ADD COLUMN IF NOT EXISTS daily_count INTEGER NOT NULL DEFAULT 0;');
      dbExec("ALTER TABLE quota_usage ADD COLUMN IF NOT EXISTS daily_day TEXT NOT NULL DEFAULT '';");
    } else {
      const rows = await dbQuery<{ name: string }>('PRAGMA table_info(quota_usage)', []);
      const have = new Set(rows.map((r) => r.name));
      if (!have.has('daily_count')) dbExec('ALTER TABLE quota_usage ADD COLUMN daily_count INTEGER NOT NULL DEFAULT 0;');
      if (!have.has('daily_day')) dbExec("ALTER TABLE quota_usage ADD COLUMN daily_day TEXT NOT NULL DEFAULT '';");
    }
    _dailyColsReady = true;
  } catch {
    // Leave the flag false: the in-memory meter keeps enforcing, we simply do not persist.
    // A metering table we cannot extend must not take the server down.
  }
}

/** TEST SEAM — re-arm the daily-column ensure (module-level latch). */
export function _resetDailyColsForTest(ready = false): void {
  _dailyColsReady = ready;
}

/** Monthly billable-call counts at which a KEYED user is offered the referral
 *  (trigger c). Free cap is 100/mo → both reachable. Lifetime-deduped per milestone
 *  (the `milestone_referral_shown` column persists across the monthly reset) and
 *  capped to ≤1 aha referral/session by `shouldShowAhaReferral`. Tunable. */
export const MILESTONE_REFERRAL_VALUES = [25, 50] as const;

let _milestoneColInit = false;
/** Idempotent ensure of the lifetime-dedup column on the EXISTING quota_usage store
 *  (extends it — NOT a new throttle store). PG: native IF NOT EXISTS; SQLite: PRAGMA
 *  pre-check (no ADD COLUMN IF NOT EXISTS). Prod PG is pre-applied via SSH. */
export async function ensureQuotaMilestoneColumn(): Promise<void> {
  if (_milestoneColInit) return;
  try {
    if (PG) {
      dbExec('ALTER TABLE quota_usage ADD COLUMN IF NOT EXISTS milestone_referral_shown INTEGER NOT NULL DEFAULT 0;');
    } else {
      const rows = await dbQuery<{ name: string }>('PRAGMA table_info(quota_usage)', []);
      if (!rows.some((r) => r.name === 'milestone_referral_shown')) {
        dbExec('ALTER TABLE quota_usage ADD COLUMN milestone_referral_shown INTEGER NOT NULL DEFAULT 0;');
      }
    }
    _milestoneColInit = true;
  } catch {
    // Best-effort — the fresh CREATE TABLE already carries the column; never block.
  }
}

/** Reset the milestone-column latch — tests only. */
export function _resetMilestoneColInitForTest(): void {
  _milestoneColInit = false;
}

/**
 * REFERRAL-INPRODUCT-NUDGE-W1 trigger (c): if the caller's post-increment monthly
 * billable-call count EXACTLY hits an unshown milestone, mark it shown (LIFETIME —
 * survives the monthly reset) and return the milestone value; else `null`. Reads the
 * live in-memory count (trackCall already ran upstream) so the exact-equality gate
 * means the DB read/write fires only on the crossing call (≤ a couple per user,
 * ever). Fail-soft — returns null on any error so the response path is never broken.
 */
export async function recordAhaMilestoneCrossing(license: LicenseInfo): Promise<number | null> {
  try {
    const trackerKey = deriveTrackerKey(license);
    const callCount = callTrackers.get(trackerKey)?.count ?? 0;
    if (!(MILESTONE_REFERRAL_VALUES as readonly number[]).includes(callCount)) return null;
    const rows = await dbQuery<{ milestone_referral_shown: string | number | null }>(
      'SELECT milestone_referral_shown FROM quota_usage WHERE tracker_key = ?', [trackerKey],
    );
    const shown = rows.length ? Number(rows[0].milestone_referral_shown ?? 0) : 0;
    if (callCount <= shown) return null; // already shown this milestone (or a higher one)
    dbRun('UPDATE quota_usage SET milestone_referral_shown = ? WHERE tracker_key = ?', callCount, trackerKey);
    return callCount;
  } catch {
    return null;
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

// OPS-QUOTA-EXHAUSTION-NOTICE-W1: the allowances now project from the ONE plan SoT
// (`plans.ts`) instead of being a fourth copy of the same literals. Behaviour identical.
export function getMonthlyQuota(tier: LicenseTier): number {
  switch (tier) {
    case 'starter': return PLANS.starter.monthlyCalls;
    case 'pro': return PLANS.pro.monthlyCalls;
    case 'enterprise': return PLANS.enterprise.monthlyCalls;
    case 'x402': return Infinity;
    // BOT-W1 / D1-C: internal bypass — server-side counter is bypassed; the
    // bot enforces per-user quota in its own SQLite.
    case 'internal': return Infinity;
    default: return FREE_MONTHLY_CALLS;
  }
}

/**
 * Per-UTC-day allowance for a tier (PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1, R-B/R-D).
 *
 * Sibling of `getMonthlyQuota`, projected from the SAME plan SoT for the same reason: a second
 * copy of the ladder is how the page and the enforcement drift apart. The two meters refuse
 * INDEPENDENTLY — this is NOT a sub-limit of the monthly quota, so `dailyCalls * 31` is
 * deliberately not `monthlyCalls`.
 *
 * `Infinity` for the exempt tiers and for Enterprise, whose `dailyCalls` is `null` ("no daily
 * ceiling"). A null must never collapse to 0, which would refuse every call.
 */
export function getDailyCap(tier: LicenseTier): number {
  switch (tier) {
    case 'starter': return PLANS.starter.dailyCalls ?? Infinity;
    case 'pro': return PLANS.pro.dailyCalls ?? Infinity;
    case 'enterprise': return PLANS.enterprise.dailyCalls ?? Infinity;
    case 'x402': return Infinity;
    // Parity with getMonthlyQuota: the bot enforces per-user quota in its own SQLite, and the
    // ~6,200 internal calls/day CH1 measured would break on day one without this.
    case 'internal': return Infinity;
    default: return FREE_DAILY_CALLS;
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
  /**
   * PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (CH4): WHICH meter refused, or `null` when the call
   * was allowed. Additive — every existing consumer ignores it.
   *
   * The two meters retry on completely different horizons (hours to 00:00 UTC vs days to the
   * caller's own rolling reset), so a refusal that does not say which one fired cannot render a
   * correct retry hint. A daily wall must never tell a caller to come back in 27 days.
   */
  limit?: 'daily' | 'monthly' | null;
  /**
   * The DAILY meter's own pair, present whenever a finite daily cap applies to this tier.
   *
   * PRICING-FOLLOWUPS-GENERATOR-W1 CH1. `used`/`total` above are and remain the MONTHLY pair —
   * they feed the `_algovault.quota` envelope, where monthly is the correct and expected number.
   * CH4 returned only that pair from the daily branch too, so a daily refusal rendered
   * `100/200`: the monthly figures under a daily wall. The two meters now travel as two pairs.
   *
   * ONE derivation: these are the same `daily.count` / `dailyCap` the branch below already
   * computed to decide `limit`, returned rather than re-read. That is why `dailyUsedFor()` — a
   * second, independent way to ask "daily used" — was deleted in the same change.
   */
  daily_used?: number;
  daily_total?: number;
}

/**
 * Whether a PAID tier is hard-walled at its ceiling, or merely metered.
 *
 * ⚠️ `false` PRESERVES TODAY'S BEHAVIOUR, and that is a deliberate, flagged decision rather than
 * an oversight. On live `main` `checkQuota` walls ONLY `tier === 'free'` and `trackCall` returns
 * `allowed: true` unconditionally for paid tiers — so the advertised Starter/Pro ceilings have
 * never been refusals, only meters. R-B's "a call is refused when either is exhausted" assumes an
 * enforcement posture that does not exist yet.
 *
 * Flipping this to `true` is a NEW customer-facing refusal on the revenue path, so it is an
 * architect decision, not a side effect of adding a second meter. CH1 measured every paying
 * subscriber at ≤5.1% of the new monthly cap, so nothing is walled either way today — which is
 * precisely why this can wait for an explicit ruling instead of being decided here.
 *
 * Both meters read this ONE flag, so the posture cannot drift between them.
 */
const PAID_TIERS_ARE_HARD_WALLED = false;

/** True when this tier's meters REFUSE at the ceiling (vs merely counting past it). */
function tierIsWalled(tier: LicenseTier): boolean {
  return tier === 'free' || PAID_TIERS_ARE_HARD_WALLED;
}

/**
 * Check quota WITHOUT incrementing the counter.
 * Use this when you need to gate a request but will increment later
 * (e.g., get_trade_signal only charges for non-HOLD results).
 */
export function checkQuota(license: LicenseInfo): TrackCallResult {
  if (license.tier === 'x402' || license.tier === 'internal') {
    return { allowed: true, remaining: Infinity, overage: 0, used: 0, total: Infinity, limit: null };
  }

  const key = deriveTrackerKey(license);
  const tracker = getCallTracker(key);
  const quota = getMonthlyQuota(license.tier);

  const remaining = Math.max(0, quota - tracker.count);
  const overage = Math.max(0, tracker.count - quota);

  if (tierIsWalled(license.tier) && tracker.count >= quota) {
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
        // PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1: WHICH wall the caller hit. The two meters
        // refuse independently and convert differently — a monthly wall is a budget signal, a
        // daily wall is a pacing one — so the funnel cannot attribute upgrade intent without
        // knowing which fired. CH4 emits `'daily'` from the daily meter.
        limit: 'monthly' as const,
      },
    });
    return { allowed: false, remaining: 0, overage, used: tracker.count, total: quota, limit: 'monthly' };
  }

  // The DAILY meter, checked SECOND and reported second on purpose: when both are exhausted the
  // monthly wall is the binding one (its retry is days, not hours), so naming the daily wall
  // there would understate the wait. Bonus calls are a MONTHLY grant and deliberately do not
  // lift a daily wall — pacing is not budget.
  const dailyCap = getDailyCap(license.tier);
  if (Number.isFinite(dailyCap)) {
    const daily = getDailyTracker(key);
    // REPORTING is unconditional on a finite cap; REFUSING still requires the tier to be walled.
    // `trackCall` advances the daily meter for paid tiers too (`chargeDaily` is unconditional),
    // so withholding the pair from an unwalled tier would hide a number we are in fact keeping —
    // and `PAID_TIERS_ARE_HARD_WALLED` is a rollback lever that must not change what a caller can
    // SEE, only what refuses them.
    if (tierIsWalled(license.tier) && daily.count >= dailyCap) {
      recordFunnelEvent({
        eventType: 'quota_hit_block',
        sessionId: getRequestSessionId() ?? null,
        licenseTier: license.tier,
        meta: { used: daily.count, total: dailyCap, limit: 'daily' as const },
      });
      // The daily pair travels WITH the discriminator. Returning `limit: 'daily'` while carrying
      // only the monthly pair is what made the refusal say "100/200 … 30 days" for a wall that
      // lifts at midnight — the funnel event below already had the right numbers, and only the
      // caller-facing return did not.
      return {
        allowed: false, remaining, overage, used: tracker.count, total: quota,
        limit: 'daily', daily_used: daily.count, daily_total: dailyCap,
      };
    }
    // Allowed, but a daily cap DOES apply — report it so a caller can see both meters without a
    // second call. Same two numbers, same read; no independent path to disagree with.
    return {
      allowed: true, remaining, overage, used: tracker.count, total: quota,
      limit: null, daily_used: daily.count, daily_total: dailyCap,
    };
  }

  return { allowed: true, remaining, overage, used: tracker.count, total: quota, limit: null };
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
    return { allowed: true, remaining: Infinity, overage: 0, used: 0, total: Infinity, limit: null };
  }

  const key = deriveTrackerKey(license);
  const tracker = getCallTracker(key);
  const quota = getMonthlyQuota(license.tier);

  // CH4: ONE charging rule, BOTH meters. The daily meter advances on every charged unit
  // regardless of tier or posture — a meter that only counts when it also refuses cannot report
  // usage, and `_algovault` surfaces the count long before anyone is walled.
  chargeDaily(key, clampUnits(units));

  // OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1 CH2, WIRED in CH6 after the live post-deploy check.
  //
  // `chargeDaily` above advances the daily meter on EVERY call, but this function's return shape
  // carried only the monthly pair. Every tool builds its envelope from THIS result
  // (`withQuotaState(..., { dailyUsed: quota.daily_used })`), so it received `undefined` and
  // `emitDaily` was false — `_algovault.quota` shipped WITHOUT `daily`/`binding` in production
  // while every unit test passed, because those tests call `withQuotaState` directly WITH a pair.
  // CH2 was deployed and INERT: the always-on block still told a caller pacing at the daily cap
  // that they had the monthly remainder left, which is the precise defect the chapter names.
  //
  // A charging function that will not report what it charged forces every consumer to re-read the
  // meter — the second derivation this wave exists to delete. Mirrors `checkQuota`'s rule exactly:
  // REPORTING is unconditional on a finite cap; only REFUSING requires a walled tier. Read AFTER
  // `chargeDaily` so the reported count matches the post-increment `used` beside it.
  const dailyCap = getDailyCap(license.tier);
  const dailyPair = Number.isFinite(dailyCap)
    ? { daily_used: getDailyTracker(key).count, daily_total: dailyCap }
    : {};

  // REFERRAL-LIGHT-W1 (C2): free tier draws monthly-then-bonus (atomic overflow).
  if (license.tier === 'free') {
    return { ...freeMeterCharge(key, tracker, quota, clampUnits(units)), ...dailyPair };
  }

  tracker.count += clampUnits(units);
  persistTracker(key, tracker);

  const remaining = Math.max(0, quota - tracker.count);
  const overage = Math.max(0, tracker.count - quota);

  return { allowed: true, remaining, overage, used: tracker.count, total: quota, ...dailyPair };
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
    return { allowed: true, remaining: Infinity, overage: 0, used: 0, total: Infinity, limit: null };
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
    // OPS-WEBHOOK-QUOTA-METER-PARITY-W1: NO daily pair here, DELIBERATELY. Reaching this branch
    // means the monthly meter refused before the daily one was ever consulted — so there is no
    // daily reading to report, and producing one would mean calling `getDailyTracker`, which
    // MATERIALISES a `{count: 0, day: today}` entry for a key that has none. `getTrackerEpisode`
    // reads that same map, so inventing the entry here would make a caller who has never made a
    // daily-metered call report `dailyDay: <today>` — an episode this very read had invented.
    // That is the exact hazard `entitlement.ts` documents reading the episode BEFORE the gate to
    // avoid. Absent is the honest answer; a fabricated 0/N is not.
    return { allowed: false, remaining: 0, overage, used: tracker.count, total: quota, limit: 'monthly' };
  }
  // CH4: the daily meter, with THIS path's existing posture preserved. Note the by-key path
  // walls EVERY tier while `checkQuota` walls only free — a pre-existing inconsistency this wave
  // deliberately does not "fix", because doing so would silently stop refusing paid webhook
  // owners at their ceiling. Recorded rather than changed.
  const dailyCap = getDailyCap(tier);
  // OPS-WEBHOOK-QUOTA-METER-PARITY-W1: the daily pair travels with the decision it produced.
  //
  // ONE derivation — these are the SAME `daily.count` / `dailyCap` the branch below already
  // computed to decide `limit`, returned rather than re-read, exactly as `trackCall` does. Read
  // INSIDE the existing finite-cap guard and never hoisted above the monthly return, so the set of
  // keys this function materialises is byte-identical to before.
  //
  // WHY IT MUST BE RETURNED: a caller of the ALLOWED path could not render a daily meter at all,
  // so `/api/webhooks` had no wall to name and the webhook-paused email told a subscriber walled
  // until 00:00 UTC to come back next month.
  let dailyPair: { daily_used: number; daily_total: number } | undefined;
  if (Number.isFinite(dailyCap)) {
    const daily = getDailyTracker(trackerKey);
    dailyPair = { daily_used: daily.count, daily_total: dailyCap };
    if (daily.count >= dailyCap) {
      return { allowed: false, remaining, overage, used: tracker.count, total: quota, limit: 'daily', ...dailyPair };
    }
  }
  return { allowed: true, remaining, overage, used: tracker.count, total: quota, limit: null, ...dailyPair };
}

/** Increment + check an explicit tracker key against BOTH meters. */
export function trackCallByKey(trackerKey: string, tier: LicenseTier, units = 1): TrackCallResult {
  if (tier === 'x402' || tier === 'internal') {
    return { allowed: true, remaining: Infinity, overage: 0, used: 0, total: Infinity, limit: null };
  }
  const tracker = getCallTracker(trackerKey);
  const quota = getMonthlyQuota(tier);
  chargeDaily(trackerKey, clampUnits(units)); // CH4: one charging rule, both meters
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
  context?: {
    used?: number;
    total?: number;
    cappedResults?: number;
    totalResults?: number;
    /**
     * OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1 CH2 — the DAILY pair. Optional; absent ⇒ the hint
     * fires on the monthly ratio exactly as before, with byte-identical copy.
     */
    dailyUsed?: number;
    dailyTotal?: number;
  },
): string | undefined {
  if (license.tier !== 'free') return undefined;

  // Capped results hint (funding arb)
  if (context?.cappedResults && context?.totalResults && context.totalResults > context.cappedResults) {
    // PRICING-ANNUAL-AND-HOLD-PROMISE-W1: name + price project from the plan SoT (was `Starter at
    // $9.99/mo` hand-typed, which a price move would have left stale on a live upsell surface).
    return `Showing top ${context.cappedResults} of ${context.totalResults} opportunities. Unlock all results with ${PLANS[DEFAULT_UPGRADE_PLAN].label} at ${planPriceLabel(DEFAULT_UPGRADE_PLAN)}/mo → ${UPGRADE_URL}`;
  }

  // Quota usage hint: free-tier soft nudge at/above SOFT_THRESHOLD (the single
  // source shared with tier-warning's quota_hit_soft band — A1). Approved CTA
  // copy + LIVE track-record values; `upgrade_from=soft`.
  if (context?.used && context?.total) {
    // OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1 CH2: fire on the BINDING meter, and render THAT
    // meter's pair with THAT meter's horizon. Before this, the hint divided by the monthly limit
    // unconditionally — so the 100/day caller sat at 0.40 and was never nudged at all, on any call,
    // right up to the wall.
    const binding = bindingMeter(
      { used: context.used, limit: context.total, resetAtMs: 0 },
      typeof context.dailyTotal === 'number' && typeof context.dailyUsed === 'number'
        ? { used: context.dailyUsed, limit: context.dailyTotal, resetAtMs: 0 }
        : null,
    );
    // `bindingMeter` returns null only when NEITHER meter is honestly metered; the pre-wave
    // expression is the correct fallback for that (and is unreachable given the `context.total`
    // guard above, which is why it is a `??` and not a branch).
    const pctUsed = binding?.ratio ?? context.used / context.total;
    if (pctUsed >= 1.0) return undefined; // Handled by the TIER_LIMIT_REACHED path
    if (pctUsed >= SOFT_THRESHOLD) {
      return buildSoftNudge({
        used: binding?.used ?? context.used,
        total: binding?.limit ?? context.total,
        // The horizon noun travels WITH the pair. `'this month'` is the default in `buildSoftNudge`,
        // so a monthly binding renders the pre-wave string byte-for-byte.
        ...(binding?.binding === 'daily' ? { period: 'today' } : {}),
        ...getTrackRecord(),
      });
    }
  }

  return undefined;
}

// OPS-QUOTA-EXHAUSTION-NOTICE-W1 (2026-08-02): `getQuotaExhaustedMessage` DELETED.
// It was a second name for the wall message, and after `scan_trade_calls` (its last
// production caller) moved to the shared notice it had zero consumers outside one test —
// a dead export that still LOOKS like the source of truth is how a future surface ends up
// rendering a fifth, stale variant. Call `buildQuotaNoticeMessage` from `quota-notice.ts`.

/**
 * Epoch ms at which the caller's rolling monthly meter resets — `periodStart + MONTH_MS`.
 *
 * The companion to `daysUntilMonthReset`, and the field the exhaustion notice actually needs:
 * a day count tells a caller roughly how long, a date tells them WHEN. Note the window is
 * ROLLING (anchored on the caller's first call), not a calendar month — so the reset lands on
 * an arbitrary date and cannot be reconstructed as "1st of next month".
 *
 * No tracker (caller has made no call — not reachable from the exhausted path) → a full
 * window from now, matching `daysUntilMonthReset`'s 30-day default.
 */
export function monthResetAtMs(license: LicenseInfo): number {
  const tracker = callTrackers.get(deriveTrackerKey(license));
  return (tracker?.periodStart ?? Date.now()) + MONTH_MS;
}

/** Epoch ms the caller's current metering period began, or `undefined` with no tracker. */
export function periodStartMs(license: LicenseInfo): number | undefined {
  return callTrackers.get(deriveTrackerKey(license))?.periodStart;
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
