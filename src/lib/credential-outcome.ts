/**
 * credential-outcome.ts — AUTH-THREE-STATE-W1 CH1. The ONE vocabulary for "what happened when we
 * tried to resolve the caller's credential".
 *
 * THE CLASS THIS RETIRES. `resolveFromApiKeyAsync` had four separate not-found paths that all
 * returned a byte-identical `{ tier: 'free', key: null }`: no credential at all, an unknown
 * `av_free_` key, a key Stripe says does not exist, and a key we could not ask about because
 * Stripe was unreachable. Because the object was identical, no consumer could tell them apart and
 * none tried — so a paying customer whose key was typo'd, revoked, or pasted from the wrong
 * environment was silently served the anonymous free tier with HTTP 200, metered into
 * `free:<ipHash>`, and given no way to find out. Measured live 2026-08-18: all four states
 * returned the same verdict on the same shared bucket, three calls apart.
 *
 * FORMAT VALIDATION IS NOT EXISTENCE VALIDATION. That principle already existed in this repo, but
 * only inside two `/account/*` handlers — see the SEC-08 docblock at
 * `tests/unit/referral-existence-guard.test.ts:24-29`, where a well-formed-but-nonexistent key
 * minted a referral row from an unauthenticated caller. This module generalises it onto every
 * serving path: shape and existence are answered SEPARATELY, and the two answers are different
 * members of the same outcome.
 *
 * WHY THE SHAPE CHECK CAN NEVER GATE THE LOOKUP. `classifyCredential` labels a result that has
 * already come back; it must never be used to decide whether to ASK. A Stripe-valid key that
 * predates the current generator fails the shape test and is still a real paying customer —
 * `tests/security-fix-tier-escalation.test.ts:82-87` pins exactly that case with
 * `av_live_realcustomer`. Short-circuiting the existence lookup on a malformed-looking key would
 * turn that test red and deny a real customer.
 *
 * LEAF. Type-only imports, for the reason `quota-surfaces.ts:32-35` documents: `license.ts` is a
 * CONSUMER of this module, so a value import would close a cycle.
 */
import type { LicenseTier, LicenseInfo } from '../types.js';

/**
 * The single canonical key-shape constant: `av_live_` / `av_free_` followed by 24 lowercase hex
 * characters. Both generators mint exactly this — `crypto.randomBytes(12).toString('hex')` in
 * `stripe.ts#generateApiKey` and the identical call in `free-keys-store.ts#generateFreeKey`.
 *
 * This is the ONLY key-shape regex literal in `src/`, asserted by
 * `tests/credential-outcome.test.ts` and carried into CI by
 * `scripts/check-credential-outcome-conformance.mjs` (R3). It replaced two byte-identical copies
 * in `account-handlers.ts`; a third copy is now a build failure rather than a code-review catch.
 */
export const AV_KEY_SHAPE = /^av_(live|free)_[a-f0-9]{24}$/;

/**
 * The five distinguishable realities. Every consumer projects from this one value rather than
 * re-deriving "is this caller authenticated" from `{tier, key}` truthiness.
 *
 * - `ABSENT`        — nothing was presented. Serve the free tier; unchanged from before this wave.
 * - `MALFORMED`     — something was presented and it cannot be a key we issued. Serve, but SAY SO.
 * - `UNKNOWN`       — well-formed, and it exists in neither Stripe nor `free_keys`. Refuse.
 * - `INDETERMINATE` — well-formed, and we could not reach the store to ask. Refuse, retryable.
 * - `RESOLVED`      — the principal is established (API key, x402 payment, or internal bypass).
 */
export type CredentialOutcome = 'ABSENT' | 'MALFORMED' | 'UNKNOWN' | 'INDETERMINATE' | 'RESOLVED';

/** The shape verdict. Pure, and deliberately NOT an outcome — shape alone never decides existence. */
export type CredentialShape = 'ABSENT' | 'MALFORMED' | 'WELL_FORMED';

/**
 * The resolved credential as a serving path sees it. `presented` and `retryable` are PROJECTIONS
 * of `outcome`, never independent fields — see `isPresented` / `isRetryable` below.
 */
export interface CredentialResolution {
  outcome: CredentialOutcome;
  tier: LicenseTier;
  key: string | null;
  presented: boolean;
  retryable: boolean;
}

/**
 * Pure shape classification. No I/O, no store, no network — which is precisely why it stays
 * correct while Stripe is down, and why `license.ts` can consult it on the INDETERMINATE branch.
 *
 * Whitespace-only counts as ABSENT: an empty `Authorization: Bearer ` header presents nothing.
 */
export function classifyCredential(raw: string | null | undefined): CredentialShape {
  if (raw == null) return 'ABSENT';
  const trimmed = raw.trim();
  if (trimmed === '') return 'ABSENT';
  return AV_KEY_SHAPE.test(trimmed) ? 'WELL_FORMED' : 'MALFORMED';
}

/**
 * Did the caller present a credential at all? `ABSENT` is the only outcome that means "no".
 *
 * x402 and internal-bypass callers read as presented, and that is correct: the payment proof and
 * the bypass header ARE the credential they presented — just not an API key.
 */
export function isPresented(outcome: CredentialOutcome): boolean {
  return outcome !== 'ABSENT';
}

/**
 * Is retrying the same request worth anything? Only when we could not determine the answer.
 *
 * `UNKNOWN` is a settled fact and retrying it is pure waste; `INDETERMINATE` is the absence of an
 * answer and self-heals the moment the upstream returns. Collapsing the two is the defect this
 * whole wave exists to end, so the distinction is a function of the outcome and nothing else.
 */
export function isRetryable(outcome: CredentialOutcome): boolean {
  return outcome === 'INDETERMINATE';
}

/**
 * The outcome for a resolved license, for consumers that hold a `LicenseInfo` rather than a
 * `CredentialResolution`.
 *
 * THE FALLBACK NEVER REFUSES, and that is a deliberate safety property rather than laziness. Every
 * path through `resolveLicense` stamps an explicit outcome as of CH1, so the `??` branch is
 * reachable only from a hand-constructed `LicenseInfo` — a fixture, or a future rail that has not
 * been taught this vocabulary yet. Refusing a caller because we lost track of our own bookkeeping
 * would be refusing without evidence, which is the same error as serving without evidence. So an
 * unstamped license degrades to the two SERVING outcomes and never to a refusing one.
 */
export function credentialOutcomeOf(license: Pick<LicenseInfo, 'key' | 'outcome'>): CredentialOutcome {
  return license.outcome ?? (license.key ? 'RESOLVED' : 'ABSENT');
}

/** Project the full resolution from a license. One derivation; every field follows `outcome`. */
export function credentialResolutionOf(license: LicenseInfo): CredentialResolution {
  const outcome = credentialOutcomeOf(license);
  return {
    outcome,
    tier: license.tier,
    key: license.key,
    presented: isPresented(outcome),
    retryable: isRetryable(outcome),
  };
}
