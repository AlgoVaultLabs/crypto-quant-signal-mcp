/**
 * FUNNEL-FIX-SIGNIN-PAID-IDENTITY-W1 — the ONE answer to "which credential belongs to this
 * verified human?", which every sign-in surface projects from.
 *
 * ── 🛑 THE DEFECT THIS REPLACES, MEASURED ───────────────────────────────────────────────────
 * Both human sign-in surfaces — `/auth/:provider/callback` and `/api/signup-email` — called
 * `mintFreeKey(email)` unconditionally. `mintFreeKey` is idempotent on `email UNIQUE`, so it
 * looked safe; what it never asked is whether that email ALREADY belongs to a paying Stripe
 * customer, because `free-keys-store.ts` deliberately has no Stripe import and must not gain
 * one. The result was a paying customer holding an `av_free_` key: measured on
 * `cus_UepUXyDjxzx99c`, whose `free_keys` row was minted 2026-07-17 19:31:17 UTC, 27 minutes
 * before her $49 upgrade invoice at 19:58:07 the same day, and whose `last_used_at` is still
 * NULL. Pasting that key into `/account` returns "Invalid API key" — `resolveCustomerByApiKey`
 * searches Stripe metadata and an `av_free_` key is not there — so she reported it as
 * "you guys took away the account login to cancel my subscription" (GitHub issue #39). The
 * login was never removed. She was handed the wrong credential at the door.
 *
 * ── 🛑 WHY IT LIVES HERE AND NOT IN `mintFreeKey` ───────────────────────────────────────────
 * Fixing the OAuth callback alone would have fixed one lane and left `/api/signup-email` to
 * reproduce the identical bug. Fixing it inside `mintFreeKey` would put a Stripe lookup in the
 * free-key store, which its own module contract forbids (`av_free_` keys must never reach the
 * Stripe customer lookup). So the decision moves UP into a leaf module that may import both,
 * and the surfaces below it stop deciding anything: they project this one value.
 *
 * ── 🛑 DISCLOSURE IS THE CALLER'S PROBLEM, NOT THIS MODULE'S ────────────────────────────────
 * This returns a paid credential whenever one exists. It does NOT know whether the caller
 * verified the email. A surface that has not verified ownership (an unauthenticated POST
 * carrying an address) MUST NOT render `key` when `outcome === 'PAID'` — doing so would turn
 * this fix into a paid-credential disclosure oracle. Verified surfaces (OAuth callback) may
 * render it; unverified ones send it over email instead, which is what proves ownership.
 */
import { resolveCustomerByEmail } from './stripe.js';
import { mintFreeKey } from './free-keys-store.js';

/**
 * PAID  — a Stripe customer owns this email; `key` is THEIR live key. Nothing was minted.
 * FREE  — no such customer; `key` is their free key (minted or returned idempotently).
 * INDETERMINATE — Stripe is configured and did not answer. NOTHING was minted and `key` is
 *   null. This is not a slow FREE: minting during an outage is precisely how a paying human
 *   acquires a shadow free identity, which is the defect above.
 */
export type SigninIdentityOutcome = 'PAID' | 'FREE' | 'INDETERMINATE';

export interface SigninIdentity {
  readonly outcome: SigninIdentityOutcome;
  /** The credential this human owns. `null` on INDETERMINATE — never a substitute credential. */
  readonly key: string | null;
  /** `'free'` on FREE, the Stripe tier on PAID, `null` on INDETERMINATE. */
  readonly tier: string | null;
  readonly customerId: string | null;
  /** Stripe status of their most relevant subscription (`active`, `past_due`, …) — PAID only. */
  readonly subscriptionStatus: string | null;
}

const INDETERMINATE: SigninIdentity = {
  outcome: 'INDETERMINATE',
  key: null,
  tier: null,
  customerId: null,
  subscriptionStatus: null,
};

/**
 * Resolve the credential that belongs to `email`.
 *
 * `refCode` is forwarded to `mintFreeKey` on the FREE path only — a paying customer has no free
 * key for a referral code to attach to, and stamping one would invent a second identity for the
 * same human, which is the whole class of bug this module closes.
 */
export async function resolveSigninIdentity(
  email: string,
  refCode?: string | null,
): Promise<SigninIdentity> {
  // Normalised ONCE, here. Stripe's `email:'…'` search is case-sensitive and `free_keys.email`
  // is UNIQUE, so a surface that lower-cased and one that did not would resolve two different
  // identities for one human — the same duplicate-identity failure by a different route.
  const normalised = email.trim().toLowerCase();

  let lookup: Awaited<ReturnType<typeof resolveCustomerByEmail>>;
  try {
    lookup = await resolveCustomerByEmail(normalised);
  } catch (err) {
    // The resolver already returns INDETERMINATE for a Stripe error; a THROW means something
    // upstream of that. Both mean the same thing here and must NOT read as "no customer".
    console.error(
      'resolveSigninIdentity: customer lookup threw:',
      err instanceof Error ? err.message : err,
    );
    return INDETERMINATE;
  }

  if (lookup.outcome === 'INDETERMINATE') return INDETERMINATE;

  if (lookup.outcome === 'RESOLVED') {
    return {
      outcome: 'PAID',
      key: lookup.apiKey,
      tier: lookup.customer.tier,
      customerId: lookup.customer.customerId,
      subscriptionStatus: lookup.customer.subscriptionStatus,
    };
  }

  const key = await mintFreeKey(normalised, refCode ?? null);
  return { outcome: 'FREE', key, tier: 'free', customerId: null, subscriptionStatus: null };
}
