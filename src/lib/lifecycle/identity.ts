/**
 * IDENTITY-LIFECYCLE-W3 CH1 — email pseudonymisation and the unsubscribe token.
 *
 * ONE keyed derivation, domain-separated, reusing the estate's existing
 * `ALGOVAULT_IP_HASH_KEY` secret rather than minting a second credential nobody rotates. The
 * domain prefix is what makes that safe: `HMAC(key, 'lifecycle-email-v1:' + email)` and
 * `HMAC(key, 'lifecycle-unsub-v1:' + recipientId)` cannot collide with each other or with
 * `hashIp`, and a value from one namespace is meaningless in another.
 *
 * WHY A KEYED HASH AND NOT THE ADDRESS. The suppression list has to outlive the account: a
 * bounce webhook hands us an address we may hold no other record of, and an unsubscribe is by
 * definition the end of a relationship. Storing the address to remember "never mail this" would
 * mean retaining personal data precisely for the people who asked us to stop — so the list is
 * keyed on a pseudonym, and the plaintext is kept only where an identity table already holds it.
 *
 * WHY THE UNSUBSCRIBE TOKEN IS A REAL HMAC AND NOT `notifyUnsubSig`'s FIXED SALT.
 * `referral-notify.ts` documents its fixed salt as adequate because forging it flips a
 * reversible preference on a semi-private code. This one is not that: a lifecycle unsubscribe is
 * PERMANENT by design (§Build Rule 8, "no lifecycle mail ever again"), and the subject is a
 * recipient id, so a guessable token would let anyone silently and irreversibly cut a customer
 * off from their own quota warnings. Same SHAPE as `notifyUnsubSig` — one HMAC scheme in the
 * estate, per architect ruling Q6 — with a real secret and the full digest.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveIpHashKey } from '../analytics.js';

export const LIFECYCLE_EMAIL_HASH_VERSION = 'lc1';
const EMAIL_DOMAIN = 'lifecycle-email-v1:';
const UNSUB_DOMAIN = 'lifecycle-unsub-v1:';
const PREF_DOMAIN = 'lifecycle-pref-v1:';

/**
 * `lc1:<32 hex>` for an email address. Case- and whitespace-normalised first, because
 * `Foo@Example.com ` and `foo@example.com` are one person and a suppression that missed the
 * variant would mail someone who unsubscribed.
 *
 * Never returns an unkeyed value — `resolveIpHashKey` throws when the key is absent, a
 * placeholder, or too short. Do NOT catch-and-default: a defaulted pseudonym is reversible, and
 * a reversible one here is a plaintext email list of people who opted out.
 */
export function hashEmail(email: string): string {
  const normalised = email.trim().toLowerCase();
  if (!normalised) throw new Error('hashEmail: empty address');
  const mac = createHmac('sha256', resolveIpHashKey()).update(EMAIL_DOMAIN + normalised).digest('hex').slice(0, 32);
  return `${LIFECYCLE_EMAIL_HASH_VERSION}:${mac}`;
}

/** The signature half of an unsubscribe token. Full 64-hex digest — this one is load-bearing. */
function unsubSig(recipientId: string): string {
  return createHmac('sha256', resolveIpHashKey()).update(UNSUB_DOMAIN + recipientId).digest('hex');
}

/**
 * `<base64url(recipientId)>.<sig>` — no PII in the URL. The recipient id is an opaque internal
 * identifier (a masked-key handle or an opt-in row id), never an address.
 */
export function unsubscribeToken(recipientId: string): string {
  return `${Buffer.from(recipientId, 'utf8').toString('base64url')}.${unsubSig(recipientId)}`;
}

export function unsubscribeUrl(recipientId: string, apiBase: string): string {
  return `${apiBase}/email/unsubscribe/${unsubscribeToken(recipientId)}`;
}

/**
 * Verify and unpack. Returns the recipient id, or null for anything malformed or unsigned.
 *
 * Constant-time comparison: a token check that short-circuits on the first differing byte leaks
 * the signature one request at a time, and `/webhooks` aside, this route is public and unrated
 * beyond the shared limiter.
 */
export function verifyUnsubscribeToken(token: string): string | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const idPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(idPart) || !/^[0-9a-f]{64}$/.test(sigPart)) return null;
  let recipientId: string;
  try {
    recipientId = Buffer.from(idPart, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!recipientId) return null;
  let expected: string;
  try {
    expected = unsubSig(recipientId);
  } catch {
    // The signing key is unusable. REFUSE — never accept an unverifiable token, and never
    // throw on a live serving path (a guard on a serving path refuses, it does not throw).
    return null;
  }
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sigPart, 'hex');
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? recipientId : null;
}

/**
 * `av_free_…a1b2` — enough for a human to recognise WHICH key, never enough to use it.
 *
 * §Build Rule 9: emails show the mask, never the secret. Key recovery stays the existing flow,
 * which is authenticated; an email is not.
 */
export function maskKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.length <= 12) return `${apiKey.slice(0, 4)}…`;
  return `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`;
}

// ── Preference handle (CH3) ────────────────────────────────────────────────────────────────
//
// The /account usage page needs the toggle to post back "which key", and the obvious way — a
// hidden field carrying the API key — puts the SECRET into rendered HTML. Caught by this wave's
// own test. So the page carries an opaque signed handle instead: the key never appears in the
// document, and a handle that leaks grants exactly one capability, flipping a mail preference.
//
// DOMAIN-SEPARATED FROM THE UNSUBSCRIBE TOKEN, deliberately. Reusing `unsubscribeToken` here
// would have been one line, and it would mean a leaked preference handle could also permanently
// unsubscribe somebody — a strictly larger capability than the form it came from. Two prefixes,
// two namespaces, and a value from one is meaningless in the other.

export function preferenceToken(apiKey: string): string {
  const sig = createHmac('sha256', resolveIpHashKey()).update(PREF_DOMAIN + apiKey).digest('hex');
  return `${Buffer.from(apiKey, 'utf8').toString('base64url')}.${sig}`;
}

export function verifyPreferenceToken(token: string): string | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const idPart = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(idPart) || !/^[0-9a-f]{64}$/.test(sigPart)) return null;
  let apiKey: string;
  try { apiKey = Buffer.from(idPart, 'base64url').toString('utf8'); } catch { return null; }
  if (!apiKey) return null;
  let expected: string;
  try {
    expected = createHmac('sha256', resolveIpHashKey()).update(PREF_DOMAIN + apiKey).digest('hex');
  } catch {
    return null;  // unusable key: refuse, never throw on a serving path
  }
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sigPart, 'hex');
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? apiKey : null;
}
