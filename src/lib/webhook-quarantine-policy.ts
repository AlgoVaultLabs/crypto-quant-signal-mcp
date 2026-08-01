/**
 * OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 CH3 — the ONE quarantine-window derivation.
 *
 * A pure LEAF: no store, no HTTP, no side effects beyond reading `process.env`
 * (import graph has no cycle) — sibling in spirit to `webhook-failure-class.ts`.
 *
 * WHY THIS EXISTS (D2). A paying `starter` customer's webhook expired on exactly
 * the same 7-day clock as an anonymous free one: tier bought nothing in the
 * lifecycle. Sub 6 was quarantined 2026-07-24T15:34:36Z and terminally disabled
 * ~7d later with `quarantine_expired`, and nobody told the customer. Paid tiers
 * now get 30 days of automatic recovery attempts instead of 7.
 *
 * THREE RULES, each pinned by a test in tests/webhook-quarantine-policy.test.ts:
 *
 *  1. PAID tier  → 30d. The paid set is derived from `LicenseTier` (src/types.ts),
 *     NOT hand-written twice.
 *  2. Anything else — `free`, `internal`, null, undefined, '', or ANY unrecognised
 *     string → 7d, the INCUMBENT window. The fallback is current behaviour, never
 *     a silent widening: an unknown tier must not quietly buy a customer 30 days.
 *     Default-deny discipline — garbage input yields the incumbent policy.
 *  3. `WEBHOOK_QUARANTINE_MAX_SEC`, when set to a valid POSITIVE integer, wins for
 *     EVERY tier. That is the single-env-var rollback lever back to pre-wave
 *     uniform behaviour. Invalid/garbage/zero/negative → ignored (never NaN,
 *     never 0), tier policy applies.
 *
 * `internal` is deliberately NOT paid: it is our own operator key, not a customer
 * whose retention we are protecting, and the conservative incumbent window is the
 * safe default for it. `x402` IS paid — it is a live revenue rail (USDC on Base),
 * and leaving it out would have put a paying customer back on the free clock,
 * reintroducing the very defect this module exists to fix.
 */

import type { LicenseTier } from '../types.js';

/** Incumbent (pre-wave) window — free / internal / unknown. */
export const QUARANTINE_MAX_SEC_FREE = 7 * 24 * 3600; // 604800
/** Paid window — 30d of automatic recovery attempts before terminal disable. */
export const QUARANTINE_MAX_SEC_PAID = 30 * 24 * 3600; // 2592000

/**
 * The paid subset of `LicenseTier`. Typed as a `LicenseTier[]` so that REMOVING a
 * member from the union is a compile error here — the set cannot silently drift
 * away from the SoT. Membership is a deliberate product decision, not a default:
 * a NEW tier added to `LicenseTier` is unpaid (7d) until someone lists it here.
 */
const PAID_TIERS: readonly LicenseTier[] = ['starter', 'pro', 'enterprise', 'x402'];

const PAID_TIER_SET: ReadonlySet<string> = new Set<string>(PAID_TIERS);

/** True only for an exact, case-sensitive match on a paid tier. */
export function isPaidTier(tier: string | null | undefined): boolean {
  return typeof tier === 'string' && PAID_TIER_SET.has(tier);
}

/**
 * Read the global override. Returns null unless it parses to a strictly positive
 * integer — `''`, `'abc'`, `'0'`, `'-1'`, `'1.5e400'` and NaN all yield null so the
 * caller falls through to tier policy. Never returns 0 (which would expire every
 * quarantined sub instantly on the next sweep).
 */
const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function envOverrideSec(): number | null {
  const raw = process.env.WEBHOOK_QUARANTINE_MAX_SEC;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  // STRICT decimal/scientific gate BEFORE Number() (CLAUDE.md): `Number('0x10')` is
  // 16 and passes `isFinite`, which would silently install a SIXTEEN-SECOND window
  // and expire every quarantined subscription on the very next sweep.
  if (trimmed === '' || !DECIMAL_RE.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * The ONLY place a quarantine window is computed. Every reader — the health-probe
 * sweep, the owner-facing API, the notification templates — projects from this.
 */
export function quarantineMaxSecFor(tier: string | null | undefined): number {
  const override = envOverrideSec();
  if (override !== null) return override; // rollback lever wins for every tier
  return isPaidTier(tier) ? QUARANTINE_MAX_SEC_PAID : QUARANTINE_MAX_SEC_FREE;
}

/**
 * Absolute epoch-seconds deadline at which a quarantined sub expires to
 * `disabled(quarantine_expired)`. Callers MUST derive every user-facing expiry
 * date from this — never from a hardcoded "7 days" or "30 days" string.
 */
export function quarantineExpiresAt(quarantinedAt: number, tier: string | null | undefined): number {
  return quarantinedAt + quarantineMaxSecFor(tier);
}
