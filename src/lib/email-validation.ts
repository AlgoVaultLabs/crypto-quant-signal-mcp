/**
 * REFERRAL-FREE-KEY-SIGNUP-W1 — signup email validation (D4): three layers, in
 * cheap→expensive order, fail-OPEN on transient DNS so a hiccup never bounces a
 * real user (research: real-time validation beats double-opt-in friction; only a
 * CONFIRMED-bad address is rejected):
 *   1. syntax    — the shared EMAIL_RE (same gate every other caller uses)
 *   2. disposable— mailchecker.isValid (bundled, maintained 2026-03 disposable list)
 *   3. MX        — the domain must accept mail (MX records, or an A/AAAA fallback
 *                  per RFC 5321 §5.1). resolveMx throwing ENOTFOUND/ENODATA after
 *                  the A fallback also fails = confirmed no-mail-host → reject.
 *
 * Pure + injectable (the resolver is a param) so tests run offline. No captcha.
 */
import { promises as dnsPromises } from 'node:dns';
import { isValid as mailcheckerIsValid } from 'mailchecker';
import { EMAIL_RE } from './stripe.js';

export type EmailValidationReason = 'invalid_email' | 'disposable_email' | 'no_mx';
export type EmailValidationResult = { ok: true } | { ok: false; reason: EmailValidationReason };

/** Minimal DNS surface we depend on — injectable for offline tests. */
export interface MxResolver {
  resolveMx(hostname: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolve(hostname: string): Promise<string[]>;
}

const DNS_TIMEOUT_MS = 4000;

/** A DNS error code that means "this name has no such record" (NOT a transient failure). */
function isNoRecordError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error('dns_timeout'), { code: 'ETIMEOUT' })), ms);
      // Node: unref so a pending timer never holds the process open.
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
}

/**
 * Confirmed-no-mail-host check. Returns true ONLY when the domain provably has no
 * MX AND no A/AAAA record (→ reject). Any transient DNS error → false (fail-open).
 */
async function hasNoMailHost(domain: string, resolver: MxResolver): Promise<boolean> {
  try {
    const mx = await withTimeout(resolver.resolveMx(domain), DNS_TIMEOUT_MS);
    if (mx && mx.length > 0) return false; // has MX → mail host exists
  } catch (err) {
    if (!isNoRecordError(err)) return false; // transient (timeout/servfail) → fail-open
    // ENOTFOUND/ENODATA on MX → fall through to the A/AAAA fallback
  }
  // No MX record — RFC 5321 implicit-MX fallback to an address record.
  try {
    const a = await withTimeout(resolver.resolve(domain), DNS_TIMEOUT_MS);
    if (a && a.length > 0) return false; // has A → mail host exists (implicit MX)
  } catch (err) {
    if (!isNoRecordError(err)) return false; // transient → fail-open
  }
  return true; // confirmed: no MX and no A → reject
}

export async function validateSignupEmail(
  email: string,
  opts?: { checkMx?: boolean; resolver?: MxResolver },
): Promise<EmailValidationResult> {
  // 1. syntax (same as the existing /api/signup-email gate)
  if (!email || !EMAIL_RE.test(email) || email.length > 254) return { ok: false, reason: 'invalid_email' };
  // 2. disposable / throwaway domains
  if (!mailcheckerIsValid(email)) return { ok: false, reason: 'disposable_email' };
  // 3. MX (opt-out for tests; fail-open on transient DNS)
  if (opts?.checkMx !== false) {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    const resolver: MxResolver = opts?.resolver ?? dnsPromises;
    if (await hasNoMailHost(domain, resolver)) return { ok: false, reason: 'no_mx' };
  }
  return { ok: true };
}
