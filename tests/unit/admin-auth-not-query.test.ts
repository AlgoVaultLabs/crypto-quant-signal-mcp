/**
 * OPS-AUDIT-REMEDIATION-MEDIUM-W1 / Ch1 — SEC-10: an admin credential in a URL.
 *
 * The defect had two halves, and both are pinned here:
 *   1. `isAdminAuthorized` accepted the key from `req.query.key`, so a URL leaked
 *      into a ticket/screenshot/access log was DIRECTLY REPLAYABLE against
 *      `POST /admin/referrals/payouts/approve-all` — which sends USDC on Base.
 *   2. The payout page re-embedded that key into its rendered HTML form action.
 *
 * The rule these tests enforce: a URL key may BOOTSTRAP a session; it may never
 * AUTHORIZE a request.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  resolveAdminAuth,
  bearerToken,
  buildAdminSessionCookie,
  ADMIN_COOKIE_NAME,
} from '../../src/lib/admin-auth.js';
import { renderAdminPayoutsPage } from '../../src/lib/referral-pages.js';

const ADMIN_KEY = 'admin_live_9f83b1c4d5e6f708';

// Mirrors index.ts safeCompare (constant-time, length-guarded).
const compare = (a: string, b: string): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
};

const deps = (isValidSession: (c?: string) => boolean = () => false) => ({
  adminKey: ADMIN_KEY,
  compare,
  isValidSession,
});

describe('resolveAdminAuth — a URL key never authorizes', () => {
  it('THE REGRESSION: the correct key supplied as a query param does NOT authorize', () => {
    // resolveAdminAuth takes no query input at all — the absence of that parameter
    // IS the fix. This asserts the shape the old code had: a caller holding only the
    // URL key (the leaked-URL replay) gets nothing.
    const res = resolveAdminAuth({ authorization: undefined, cookie: undefined }, deps());
    expect(res.authorized).toBe(false);
    expect(res.via).toBe('none');
  });

  it('authorizes a correct Bearer token', () => {
    const res = resolveAdminAuth({ authorization: `Bearer ${ADMIN_KEY}` }, deps());
    expect(res).toEqual({ authorized: true, via: 'bearer' });
  });

  it('authorizes a valid session cookie', () => {
    const res = resolveAdminAuth({ cookie: `${ADMIN_COOKIE_NAME}=deadbeef` }, deps(() => true));
    expect(res).toEqual({ authorized: true, via: 'cookie' });
  });

  it('rejects a wrong Bearer token and a wrong-length one', () => {
    expect(resolveAdminAuth({ authorization: 'Bearer nope' }, deps()).authorized).toBe(false);
    expect(resolveAdminAuth({ authorization: `Bearer ${ADMIN_KEY}x` }, deps()).authorized).toBe(false);
  });

  it('rejects everything when ADMIN_API_KEY is unset (no empty-string match)', () => {
    const res = resolveAdminAuth({ authorization: 'Bearer ' }, { adminKey: '', compare, isValidSession: () => false });
    expect(res.authorized).toBe(false);
  });
});

describe('bearerToken', () => {
  it('strips the scheme case-insensitively and trims', () => {
    expect(bearerToken('bearer  abc123 ')).toBe('abc123');
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken(undefined)).toBe('');
    expect(bearerToken(['Bearer abc123'])).toBe('abc123');
  });
});

describe('buildAdminSessionCookie', () => {
  it('is HttpOnly + SameSite=Strict, and Secure only over TLS', () => {
    const c = buildAdminSessionCookie('abc', { secure: true });
    expect(c).toContain(`${ADMIN_COOKIE_NAME}=abc`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Secure');
    expect(buildAdminSessionCookie('abc', { secure: false })).not.toContain('Secure');
  });
});

describe('renderAdminPayoutsPage — no credential in the rendered HTML', () => {
  const view = {
    pending: [
      {
        code: 'REF123',
        ownerEmail: 'ref@example.com',
        payoutAddress: '0x778A1234567890abcdef1234567890abcdef1234',
        pendingUsdE2: 12345,
        rowCount: 3,
        ledgerIds: [1, 2, 3],
      },
    ],
    batchTotalUsdE2: 12345,
  };

  it('THE REGRESSION: the Approve-all form action carries NO key parameter', () => {
    const html = renderAdminPayoutsPage(view);
    expect(html).not.toContain(ADMIN_KEY);
    expect(html).not.toContain('key=');
    expect(html).not.toContain('approve-all?');
    // The button must still be there — the fix must not remove the operator's workflow.
    expect(html).toContain('action="/admin/referrals/payouts/approve-all"');
    expect(html).toContain('Approve all');
  });

  it('still renders the irreversibility confirmation', () => {
    expect(renderAdminPayoutsPage(view)).toContain('This is irreversible.');
  });

  it('renders the queue with no Approve-all button when nothing is pending', () => {
    const html = renderAdminPayoutsPage({ pending: [], batchTotalUsdE2: 0 });
    expect(html).not.toContain('approve-all');
    expect(html).toContain('No payouts pending');
  });
});
