import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const stripComments = (s: string) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

/**
 * OPS-AUDIT-REMEDIATION-HIGH-W1 · Ch2 · SEC-08.
 *
 * `accountReferralsHandler` validated the api key's FORMAT
 * (`/^av_(live|free)_[a-f0-9]{24}$/`) and then went straight to
 * loadReferralStatsView → ensureUserCode, which INSERTs a referral_codes row. Format validation
 * is not existence validation, so ANY well-formed-but-nonexistent key minted a row from an
 * unauthenticated caller — unbounded growth of the referral source of truth, and via the
 * payout-address sibling an attacker-chosen Base USDC address attached to a phantom code.
 *
 * These are source-level assertions: both handlers reach a live Postgres/Stripe path, so the
 * runtime behaviour is covered by the post-deploy probe. What must be pinned here is the
 * ORDERING invariant — the existence check precedes every mint.
 */
describe('referral mint requires an EXISTING principal (SEC-08)', () => {
  const ah = src('src/lib/account-handlers.ts');
  const code = stripComments(ah);

  it('defines the existence check on the canonical resolver, not a second lookup', () => {
    expect(code).toContain('async function apiKeyExists(');
    // resolveLicense returns key: null for an unknown av_free_ and a Stripe-invalid av_live_.
    expect(code).toContain('resolveLicense({ authorization:');
    expect(code).toContain('license.key !== null');
  });

  it('BOTH minting handlers gate on it', () => {
    const guards = code.split('await apiKeyExists(apiKey)').length - 1;
    // accountReferralsHandler + accountPayoutAddressHandler — the audit flagged both.
    expect(guards).toBe(2);
  });

  it('the check runs BEFORE the mint in each handler (ordering is the whole invariant)', () => {
    for (const fn of ['accountReferralsHandler', 'accountPayoutAddressHandler']) {
      const start = code.indexOf(`export async function ${fn}`);
      expect(start).toBeGreaterThan(-1);
      const body = code.slice(start, start + 3000);
      const guardAt = body.indexOf('apiKeyExists(apiKey)');
      // Whichever mint path this handler uses, the guard must precede it.
      const mintAt = Math.min(
        ...['ensureUserCode(apiKey)', 'loadReferralStatsView(apiKey)']
          .map((m) => body.indexOf(m))
          .filter((i) => i > -1),
      );
      expect(guardAt).toBeGreaterThan(-1);
      expect(mintAt).toBeGreaterThan(-1);
      expect(guardAt).toBeLessThan(mintAt);
    }
  });

  it('a nonexistent key is refused with 404, not served a freshly-minted dashboard', () => {
    expect(code).toContain("res.status(404).send(getAccountErrorPageHtml('That API key was not found.");
  });
});
