/**
 * REFERRAL-FREE-KEY-SIGNUP-W1 — validateSignupEmail invariants (D4). The MX layer
 * uses an INJECTED resolver so these run fully offline + deterministic.
 */
import { describe, it, expect } from 'vitest';
import { validateSignupEmail, type MxResolver } from '../../src/lib/email-validation.js';

const err = (code: string) => Object.assign(new Error(code), { code });

/** Domain has MX records → mail host exists. */
const hasMx: MxResolver = {
  resolveMx: async () => [{ exchange: 'mx1.example.com', priority: 10 }],
  resolve: async () => ['93.184.216.34'],
};
/** No MX AND no A (both ENODATA/ENOTFOUND) → confirmed no mail host. */
const noMailHost: MxResolver = {
  resolveMx: async () => { throw err('ENODATA'); },
  resolve: async () => { throw err('ENOTFOUND'); },
};
/** No MX records, but an A record exists (RFC 5321 implicit-MX fallback) → allow. */
const aRecordOnly: MxResolver = {
  resolveMx: async () => { throw err('ENODATA'); },
  resolve: async () => ['93.184.216.34'],
};
/** Transient DNS failure (timeout/servfail) → must FAIL OPEN (allow). */
const transient: MxResolver = {
  resolveMx: async () => { throw err('ETIMEOUT'); },
  resolve: async () => { throw err('ESERVFAIL'); },
};

describe('validateSignupEmail — REFERRAL-FREE-KEY-SIGNUP-W1', () => {
  it('rejects invalid syntax (layer 1)', async () => {
    expect(await validateSignupEmail('not-an-email', { checkMx: false })).toEqual({ ok: false, reason: 'invalid_email' });
    expect(await validateSignupEmail('', { checkMx: false })).toEqual({ ok: false, reason: 'invalid_email' });
    expect(await validateSignupEmail(`a@${'x'.repeat(260)}.com`, { checkMx: false })).toEqual({ ok: false, reason: 'invalid_email' });
  });

  it('rejects disposable / throwaway domains (layer 2 — mailchecker)', async () => {
    expect(await validateSignupEmail('x@mailinator.com', { checkMx: false })).toEqual({ ok: false, reason: 'disposable_email' });
    expect(await validateSignupEmail('y@guerrillamail.com', { checkMx: false })).toEqual({ ok: false, reason: 'disposable_email' });
  });

  it('accepts a real, non-disposable provider', async () => {
    expect(await validateSignupEmail('real.user@gmail.com', { checkMx: false })).toEqual({ ok: true });
    expect(await validateSignupEmail('dev@example.com', { checkMx: false })).toEqual({ ok: true });
  });

  it('layer 3 — rejects a domain with confirmed no MX and no A record', async () => {
    expect(await validateSignupEmail('user@example.com', { resolver: noMailHost })).toEqual({ ok: false, reason: 'no_mx' });
  });

  it('layer 3 — accepts when the domain has MX, or an A-only implicit-MX fallback', async () => {
    expect(await validateSignupEmail('user@example.com', { resolver: hasMx })).toEqual({ ok: true });
    expect(await validateSignupEmail('user@example.com', { resolver: aRecordOnly })).toEqual({ ok: true });
  });

  it('layer 3 — FAILS OPEN on a transient DNS error (never bounce a real user on a hiccup)', async () => {
    expect(await validateSignupEmail('user@example.com', { resolver: transient })).toEqual({ ok: true });
  });

  it('short-circuits: a disposable address is rejected before any DNS work', async () => {
    let called = false;
    const spy: MxResolver = {
      resolveMx: async () => { called = true; return []; },
      resolve: async () => { called = true; return []; },
    };
    expect(await validateSignupEmail('x@mailinator.com', { resolver: spy })).toEqual({ ok: false, reason: 'disposable_email' });
    expect(called).toBe(false);
  });
});
