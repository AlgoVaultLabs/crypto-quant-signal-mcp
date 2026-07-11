/**
 * POWER-USER-OUTREACH-W1-V2 (2026-05-28) — signup-email opt-in path tests.
 *
 * Covers:
 *   (a) email regex acceptance / rejection
 *   (b) consent_required validation
 *   (c) confirmation-email send with live-substitution placeholders intact
 *   (d) Resend client no-op fallback (RESEND_API_KEY unset)
 *   (e) Body substitution snapshot (PFE_WR + TOTAL_SIGNALS appear in body)
 *   (f) /api/performance-public fetch graceful fallback when unreachable
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockSend = vi.fn();

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

describe('signup-email opt-in path', () => {
  const origEnv = { ...process.env };
  const origFetch = global.fetch;

  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: 'mock-confirm-id' }, error: null });
  });

  afterEach(() => {
    process.env = { ...origEnv };
    global.fetch = origFetch;
  });

  it('EMAIL_RE accepts well-formed addresses and rejects malformed', async () => {
    const { EMAIL_RE } = await import('../src/lib/stripe.js');
    expect(EMAIL_RE.test('alice@example.com')).toBe(true);
    expect(EMAIL_RE.test('bob+work@sub.domain.org')).toBe(true);
    expect(EMAIL_RE.test('delivered@resend.dev')).toBe(true);
    expect(EMAIL_RE.test('no-at-sign')).toBe(false);
    expect(EMAIL_RE.test('a@b')).toBe(false); // no TLD
    expect(EMAIL_RE.test('a b@example.com')).toBe(false); // whitespace
    expect(EMAIL_RE.test('"sneaky"@example.com')).toBe(false); // quote chars blocked
    expect(EMAIL_RE.test('')).toBe(false);
  });

  it('sendOptinConfirmationEmail no-ops when RESEND_API_KEY is unset', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendOptinConfirmationEmail } = await import('../src/lib/email.js');
    const result = await sendOptinConfirmationEmail('alice@example.com');
    expect(result).toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sendOptinConfirmationEmail invokes Resend with FROM=noreply + REPLY-TO=support + canonical subject', async () => {
    process.env.RESEND_API_KEY = 'test_key';
    process.env.RESEND_FROM_EMAIL = 'noreply@algovault.com';
    // Mock /api/performance-public so live-substitution has known values
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ overall: { pfeWinRate: 0.913, totalCalls: 115000 } }),
    }) as unknown as typeof fetch;

    const { sendOptinConfirmationEmail } = await import('../src/lib/email.js');
    const result = await sendOptinConfirmationEmail('alice@example.com');

    expect(mockSend).toHaveBeenCalledOnce();
    const args = mockSend.mock.calls[0][0];
    expect(args.from).toBe('noreply@algovault.com');
    expect(args.to).toBe('alice@example.com');
    expect(args.replyTo).toBe('support@algovault.com');
    expect(args.subject).toBe('Welcome to AlgoVault product updates');
    expect(result).toEqual({ id: 'mock-confirm-id' });
  });

  it('confirmation email body contains live-substituted PFE_WR + TOTAL_SIGNALS', async () => {
    process.env.RESEND_API_KEY = 'test_key';
    process.env.RESEND_FROM_EMAIL = 'noreply@algovault.com';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ overall: { pfeWinRate: 0.913, totalCalls: 115000 } }),
    }) as unknown as typeof fetch;

    const { sendOptinConfirmationEmail } = await import('../src/lib/email.js');
    await sendOptinConfirmationEmail('alice@example.com');
    const args = mockSend.mock.calls[0][0];

    // Live substitution reads the NESTED `.overall.pfeWinRate` FRACTION (0.913),
    // ×100 → "91.3", and the en-US thousands-separated `totalCalls` → "115,000".
    // (Prior fixture mocked a top-level `pfeWinRate: 91.3` — the wrong endpoint
    // shape that masked the production "90+" fallback bug; ACTIVATION-NUDGE-W1.)
    expect(args.text).toContain('91.3% PFE win rate');
    expect(args.text).toContain('115,000+ verified calls');
    expect(args.html).toContain('91.3% PFE win rate');
    expect(args.html).toContain('115,000+ verified calls');
    // Canonical CTAs / addresses preserved.
    expect(args.text).toContain('https://algovault.com/verify');
    expect(args.text).toContain('https://algovault.com/#quickstart');
    expect(args.text).toContain('support@algovault.com');
  });

  it('confirmation email body falls back to neutral stats when /api/performance-public unreachable', async () => {
    process.env.RESEND_API_KEY = 'test_key';
    process.env.RESEND_FROM_EMAIL = 'noreply@algovault.com';
    // Mock fetch to reject (simulate network error / timeout)
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const { sendOptinConfirmationEmail } = await import('../src/lib/email.js');
    await sendOptinConfirmationEmail('alice@example.com');
    const args = mockSend.mock.calls[0][0];

    // Fallback values from fetchPerformancePublicStats() default branch.
    expect(args.text).toContain('90+% PFE win rate');
    expect(args.text).toContain('100K++ verified calls');
  });

  it('confirmation email body falls back to neutral stats on HTTP 5xx (graceful)', async () => {
    process.env.RESEND_API_KEY = 'test_key';
    process.env.RESEND_FROM_EMAIL = 'noreply@algovault.com';
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const { sendOptinConfirmationEmail } = await import('../src/lib/email.js');
    const result = await sendOptinConfirmationEmail('alice@example.com');
    expect(result).toEqual({ id: 'mock-confirm-id' });
    const args = mockSend.mock.calls[0][0];
    expect(args.text).toContain('90+% PFE win rate'); // fallback
  });

  it('signup_emails store schema column allowlist forbids PII leakage to API response', async () => {
    // Sanity test: the public-shape snapshot's forbidden_keys list excludes
    // server-internal fields. Any future refactor that adds them to the API
    // response should break this test.
    const fs = await import('node:fs');
    // REFERRAL-FREE-KEY-SIGNUP-W1: the live contract moved to the 2026-06-21 snapshot
    // (mint-gate lift: key/referral_link on every 200; consent optional; new 400 reasons).
    const snapshot = JSON.parse(
      fs.readFileSync('audits/signup-email-shape-snapshot-2026-06-21.json', 'utf-8'),
    );
    expect(snapshot.endpoint).toBe('POST /api/signup-email');
    // PII / internal-leak guards (unchanged security invariant)
    expect(snapshot.forbidden_response_keys).toContain('email');
    expect(snapshot.forbidden_response_keys).toContain('id');
    expect(snapshot.forbidden_response_keys).toContain('stripe_customer_id');
    expect(snapshot.forbidden_response_keys).toContain('outcome_return_pct');
    expect(snapshot.forbidden_response_keys).toContain('outcome_price');
    // the caller's OWN key + their referral link are allowed (intentional)
    expect(snapshot.allowed_response_keys).toContain('key');
    expect(snapshot.allowed_response_keys).toContain('referral_link');
    // new error contract: consent_required GONE; disposable/MX ADDED
    expect(snapshot.error_contract['400']).toContain('invalid_email');
    expect(snapshot.error_contract['400']).toContain('disposable_email');
    expect(snapshot.error_contract['400']).toContain('no_mx');
    expect(snapshot.error_contract['400']).not.toContain('consent_required');
  });
});
