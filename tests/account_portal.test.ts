import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/lib/stripe.js', () => ({
  getCustomerByApiKey: vi.fn(),
  resolveCustomerByApiKey: vi.fn(),
  getCustomerByEmail: vi.fn(),
  createBillingPortalSession: vi.fn(),
}));
vi.mock('../src/lib/email.js', () => ({
  sendKeyRecoveryEmail: vi.fn(),
}));

import {
  accountPortalHandler,
  accountRecoverKeyHandler,
} from '../src/lib/account-handlers.js';
import * as stripeMock from '../src/lib/stripe.js';
import * as emailMock from '../src/lib/email.js';

interface MockResponse {
  statusCode: number;
  body: string;
  redirectStatus: number | null;
  redirectUrl: string | null;
  status(code: number): MockResponse;
  send(html: string): MockResponse;
  redirect(status: number, url: string): MockResponse;
}

function mockRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: '',
    redirectStatus: null,
    redirectUrl: null,
    status(code: number) { this.statusCode = code; return this; },
    send(html: string) { this.body = html; return this; },
    redirect(status: number, url: string) { this.redirectStatus = status; this.redirectUrl = url; this.statusCode = status; return this; },
  };
  return res;
}

function mockReq(body: Record<string, string>) {
  return {
    body,
    protocol: 'https',
    get: (h: string) => (h === 'host' ? 'api.algovault.com' : ''),
  } as never;
}

describe('/account/portal handler', () => {
  beforeEach(() => {
    vi.mocked(stripeMock.getCustomerByApiKey).mockReset();
    vi.mocked(stripeMock.resolveCustomerByApiKey).mockReset();
    vi.mocked(stripeMock.createBillingPortalSession).mockReset();
  });

  it('valid API key → 303 redirect to Stripe Billing Portal', async () => {
    vi.mocked(stripeMock.resolveCustomerByApiKey).mockResolvedValue({ customerId: 'cus_test_123', tier: 'pro', email: null, subscriptionStatus: 'active', hasActiveSubscription: true });
    vi.mocked(stripeMock.createBillingPortalSession).mockResolvedValue('https://billing.stripe.com/session/abc123');
    const req = mockReq({ api_key: 'av_live_validkey' });
    const res = mockRes();
    await accountPortalHandler(req, res as never);
    expect(res.redirectStatus).toBe(303);
    expect(res.redirectUrl).toBe('https://billing.stripe.com/session/abc123');
    expect(stripeMock.createBillingPortalSession).toHaveBeenCalledWith({
      customerId: 'cus_test_123',
      returnUrl: 'https://api.algovault.com/account',
    });
  });

  it('invalid API key → 401 with error page mentioning "Invalid API key"', async () => {
    vi.mocked(stripeMock.resolveCustomerByApiKey).mockResolvedValue(null);
    const req = mockReq({ api_key: 'av_live_bogus' });
    const res = mockRes();
    await accountPortalHandler(req, res as never);
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Invalid API key');
  });

  it('empty API key → 400 with error page', async () => {
    const req = mockReq({ api_key: '' });
    const res = mockRes();
    await accountPortalHandler(req, res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('paste your API key');
  });

  it('Billing Portal config missing (sentinel) → 503', async () => {
    vi.mocked(stripeMock.resolveCustomerByApiKey).mockResolvedValue({ customerId: 'cus_test_123', tier: 'pro', email: null, subscriptionStatus: 'active', hasActiveSubscription: true });
    vi.mocked(stripeMock.createBillingPortalSession).mockResolvedValue(null);
    const req = mockReq({ api_key: 'av_live_validkey' });
    const res = mockRes();
    await accountPortalHandler(req, res as never);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('temporarily unavailable');
  });
});

describe('/account/recover-key handler', () => {
  beforeEach(() => {
    vi.mocked(stripeMock.getCustomerByEmail).mockReset();
    vi.mocked(emailMock.sendKeyRecoveryEmail).mockReset();
    vi.mocked(emailMock.sendKeyRecoveryEmail).mockResolvedValue(undefined);
  });

  it('matched email → 200 success page + sendKeyRecoveryEmail called once', async () => {
    vi.mocked(stripeMock.getCustomerByEmail).mockResolvedValue({ apiKey: 'av_live_xyz', tier: 'starter' });
    const req = mockReq({ email: 'real@example.com' });
    const res = mockRes();
    await accountRecoverKeyHandler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Recovery email sent');
    expect(res.body).toContain('If an active subscription exists');
    // Wait a tick for the fire-and-forget async block to settle
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(emailMock.sendKeyRecoveryEmail).toHaveBeenCalledOnce();
    expect(emailMock.sendKeyRecoveryEmail).toHaveBeenCalledWith({
      to: 'real@example.com',
      apiKey: 'av_live_xyz',
      tier: 'starter',
    });
  });

  it('non-matching email → SAME 200 success page + sendKeyRecoveryEmail NOT called (no enumeration leak)', async () => {
    vi.mocked(stripeMock.getCustomerByEmail).mockResolvedValue(null);
    const req = mockReq({ email: 'unknown@example.com' });
    const res = mockRes();
    await accountRecoverKeyHandler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Recovery email sent');
    expect(res.body).toContain('If an active subscription exists');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(emailMock.sendKeyRecoveryEmail).not.toHaveBeenCalled();
  });

  it('empty email → 200 success page + no Stripe lookup (no enumeration even on empty)', async () => {
    const req = mockReq({ email: '' });
    const res = mockRes();
    await accountRecoverKeyHandler(req, res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Recovery email sent');
    expect(stripeMock.getCustomerByEmail).not.toHaveBeenCalled();
    expect(emailMock.sendKeyRecoveryEmail).not.toHaveBeenCalled();
  });
});

/**
 * OPS-REACHABILITY-AND-XREPO-INSTALL-W1 CH1 — the portal admits a customer whose billing is
 * BROKEN, because that is the only reason most people open a billing portal.
 *
 * MEASURED 2026-08-25 on `cus_UuBrP1otU51OBm` (owner `av_live_25cb…`, tier starter): 0
 * subscriptions `active`, 1 `past_due`, customer present and not deleted. The handler called the
 * ENTITLEMENT lookup, which returns null without an active subscription, so their real valid key
 * was answered with `401 Invalid API key` — locking them out of the page that fixes a failed
 * card. Their card failing is what put them in `past_due` in the first place.
 */
describe('🛑 /account/portal admits a customer whose subscription is not active', () => {
  const res401 = 'Invalid API key';
  const nonActive = (subscriptionStatus: string | null) => ({
    customerId: 'cus_UuBrP1otU51OBm', tier: 'starter', email: 'x@y.com',
    subscriptionStatus, hasActiveSubscription: false,
  });

  beforeEach(() => {
    vi.mocked(stripeMock.resolveCustomerByApiKey).mockReset();
    vi.mocked(stripeMock.createBillingPortalSession).mockReset();
    vi.mocked(stripeMock.createBillingPortalSession).mockResolvedValue('https://billing.stripe.com/session/ok');
  });

  for (const status of ['past_due', 'unpaid', 'canceled', 'incomplete', 'paused', null]) {
    it(`subscription "${status ?? '(none)'}" → 303 to the portal, NOT 401`, async () => {
      vi.mocked(stripeMock.resolveCustomerByApiKey).mockResolvedValue(nonActive(status));
      const res = mockRes();
      await accountPortalHandler(mockReq({ api_key: 'av_live_25cb2a59a4dd793e24c6ddd0' }), res);
      expect(res.statusCode).toBe(303);
      expect(res.redirectUrl).toBe('https://billing.stripe.com/session/ok');
      expect(res.body).not.toContain(res401);
    });
  }

  it('the portal session is opened for the customer we resolved, not a guess', async () => {
    vi.mocked(stripeMock.resolveCustomerByApiKey).mockResolvedValue(nonActive('past_due'));
    await accountPortalHandler(mockReq({ api_key: 'av_live_x' }), mockRes());
    expect(vi.mocked(stripeMock.createBillingPortalSession).mock.calls[0][0].customerId)
      .toBe('cus_UuBrP1otU51OBm');
  });

  it('🛑 an UNRESOLVABLE key is still 401 — this widens billing state, never authentication', async () => {
    vi.mocked(stripeMock.resolveCustomerByApiKey).mockResolvedValue(null);
    const res = mockRes();
    await accountPortalHandler(mockReq({ api_key: 'av_live_not_a_real_key' }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain(res401);
    expect(vi.mocked(stripeMock.createBillingPortalSession)).not.toHaveBeenCalled();
  });

  it('🛑 the portal does NOT use the entitlement lookup at all', async () => {
    vi.mocked(stripeMock.resolveCustomerByApiKey).mockResolvedValue(nonActive('past_due'));
    await accountPortalHandler(mockReq({ api_key: 'av_live_x' }), mockRes());
    // If this ever fires again, a past_due customer is locked out of their own billing page.
    expect(vi.mocked(stripeMock.getCustomerByApiKey)).not.toHaveBeenCalled();
  });
});
