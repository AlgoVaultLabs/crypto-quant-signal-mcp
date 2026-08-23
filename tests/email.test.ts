import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockSend = vi.fn();

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

describe('email module', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: 'mock-email-id' }, error: null });
  });

  afterEach(() => {
    process.env = { ...origEnv };
    vi.unstubAllGlobals();
  });

  it('maskEmail produces a***@domain shape', async () => {
    const { maskEmail } = await import('../src/lib/email.js');
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
    expect(maskEmail('bob+work@subdomain.test.org')).toBe('b***@subdomain.test.org');
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('')).toBe('***');
  });

  it('getResendClient returns null when RESEND_API_KEY is unset (no crash)', async () => {
    delete process.env.RESEND_API_KEY;
    const { getResendClient } = await import('../src/lib/email.js');
    expect(getResendClient()).toBeNull();
  });

  it('sendWelcomeEmail no-ops when RESEND_API_KEY is unset', async () => {
    delete process.env.RESEND_API_KEY;
    const { sendWelcomeEmail } = await import('../src/lib/email.js');
    await sendWelcomeEmail({ to: 'alice@example.com', apiKey: 'av_live_xyz', tier: 'starter' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sendWelcomeEmail invokes Resend with tier-titled subject + API key in body', async () => {
    process.env.RESEND_API_KEY = 'test_key';
    process.env.RESEND_FROM_EMAIL = 'noreply@algovault.com';
    const { sendWelcomeEmail, REPLY_TO_ADDRESS } = await import('../src/lib/email.js');
    await sendWelcomeEmail({ to: 'alice@example.com', apiKey: 'av_live_xyz123', tier: 'pro' });
    expect(mockSend).toHaveBeenCalledOnce();
    const args = mockSend.mock.calls[0][0];
    expect(args.from).toBe('noreply@algovault.com');
    expect(args.to).toBe('alice@example.com');
    // CONTACT-FORM-AND-SUPPORT-CLAIM-SWEEP-W1: a replyTo must be a RECEIVING mailbox.
    // `support@` is unverified (port 25 blocked outbound from both hosts, so an SMTP RCPT
    // probe is impossible) and the operator holds `admin@` only — replies were going nowhere.
    // Asserted against the exported constant so the 11 call sites can never drift apart again.
    expect(args.replyTo).toBe(REPLY_TO_ADDRESS);
    expect(REPLY_TO_ADDRESS).toBe('admin@algovault.com');
    expect(args.subject).toBe('Your AlgoVault Pro API key');
    expect(args.html).toContain('av_live_xyz123');
    expect(args.html).toContain('Pro plan');
    expect(args.html).toContain('Welcome to AlgoVault Pro');
    expect(args.html).toContain('https://api.algovault.com/account');
    expect(args.text).toContain('av_live_xyz123');
    expect(args.text).toContain('Welcome to AlgoVault Pro');
  });

  it('sendKeyRecoveryEmail uses the recovery subject + same API-key body shape', async () => {
    process.env.RESEND_API_KEY = 'test_key';
    process.env.RESEND_FROM_EMAIL = 'noreply@algovault.com';
    const { sendKeyRecoveryEmail } = await import('../src/lib/email.js');
    await sendKeyRecoveryEmail({ to: 'bob@example.com', apiKey: 'av_live_abc456', tier: 'starter' });
    expect(mockSend).toHaveBeenCalledOnce();
    const args = mockSend.mock.calls[0][0];
    expect(args.subject).toBe('AlgoVault — your API key');
    expect(args.html).toContain('av_live_abc456');
    expect(args.html).toContain('Your AlgoVault API key');
    expect(args.text).toContain('av_live_abc456');
  });

  it('falls back to noreply@algovault.com when RESEND_FROM_EMAIL is unset', async () => {
    process.env.RESEND_API_KEY = 'test_key';
    delete process.env.RESEND_FROM_EMAIL;
    const { sendWelcomeEmail } = await import('../src/lib/email.js');
    await sendWelcomeEmail({ to: 'alice@example.com', apiKey: 'av_live_xyz', tier: 'starter' });
    expect(mockSend.mock.calls[0][0].from).toBe('noreply@algovault.com');
  });

  // ACTIVATION-NUDGE-W1 flag: the opt-in stats read PFE WR from the NESTED
  // `.overall.pfeWinRate` (a fraction, ×100) — the prior top-level `data.pfeWinRate`
  // read was always undefined → silently rendered the "90+" fallback.
  it('opt-in email renders LIVE stats from the nested .overall.pfeWinRate (×100), not the fallback', async () => {
    process.env.RESEND_API_KEY = 'test_key';
    // 0.9157 → "91.6": a value DISTINCT from the "90+" fallback so a wrong-path
    // (top-level) read cannot pass by luck.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ overall: { pfeWinRate: 0.9157, totalCalls: 246331 }, totalCalls: 246331 }),
    }));
    const { sendOptinConfirmationEmail } = await import('../src/lib/email.js');
    await sendOptinConfirmationEmail('alice@example.com');
    expect(mockSend).toHaveBeenCalledOnce();
    const args = mockSend.mock.calls[0][0];
    for (const body of [args.text, args.html]) {
      expect(body).toContain('91.6% PFE win rate');
      expect(body).toContain('246,331+ verified calls');
      expect(body).not.toContain('90+% PFE win rate'); // not the fallback
      expect(body).not.toContain('0.9% PFE win rate');  // not the un-×100 bug
    }
  });

  it('opt-in email fails open to the "90+" fallback when the stats fetch rejects', async () => {
    process.env.RESEND_API_KEY = 'test_key';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const { sendOptinConfirmationEmail } = await import('../src/lib/email.js');
    await sendOptinConfirmationEmail('bob@example.com');
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0][0].text).toContain('90+% PFE win rate across 100K++ verified calls');
  });
});

// ── OPS-WEBHOOK-QUOTA-METER-PARITY-W1 — the webhook-paused email ──────────────────────────
//
// `checkQuotaByKey` walls EVERY tier on the daily meter, so a paying Starter (1,000/day against
// 10,000/month) can be paused by a wall that lifts at 00:00 UTC. Before this wave the email told
// them to come back next month — hours misreported as weeks, to a paying customer, by email.
describe('sendWebhookQuotaPausedEmail — one discriminator, two variants', () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: 'mock-email-id' }, error: null });
    process.env.RESEND_API_KEY = 're_test_key';
  });
  afterEach(() => { process.env = { ...origEnv }; });

  async function render(args: Record<string, unknown>) {
    const { sendWebhookQuotaPausedEmail } = await import('../src/lib/email.js');
    await sendWebhookQuotaPausedEmail(args as never);
    expect(mockSend).toHaveBeenCalledTimes(1);
    return mockSend.mock.calls[0][0] as { subject: string; html: string; text: string };
  }

  // AC6. The expectations are LITERAL, deliberately: a test that derives its expectation from the
  // template it is pinning asserts nothing at all — deleting the line would simply stop checking it.
  it('🎯 MONTHLY variant is byte-identical to the pre-wave copy', async () => {
    const sent = await render({ to: 'a@example.com', subscriptionId: 42, used: 9876, total: 10000 });
    expect(sent.subject).toBe('Webhook deliveries paused — monthly limit reached');
    expect(sent.html).toContain('You have used 9,876 of your 10,000 monthly calls, so webhook #42 is paused.');
    expect(sent.html).toContain('Deliveries resume automatically when your quota resets next month.');
    expect(sent.text).toContain('Webhook deliveries paused — monthly limit reached.\n\nYou have used 9,876 of your 10,000 monthly calls, so webhook #42 is paused.\n\nDeliveries resume automatically when your quota resets next month.\n');
    expect(sent.text).toContain('— AlgoVault Labs');
    // The wall it must NOT name.
    expect(sent.subject).not.toContain('daily');
    expect(sent.html).not.toContain('00:00 UTC');
  });

  it('🎯 an UNSPECIFIED wall still renders the monthly copy — the daily variant is opt-in', async () => {
    // Every pre-wave caller omits `wall`; none of their emails may change.
    const a = await render({ to: 'a@example.com', subscriptionId: 7, used: 1, total: 2 });
    mockSend.mockClear();
    const b = await render({ to: 'a@example.com', subscriptionId: 7, used: 1, total: 2, wall: 'monthly' });
    expect(a.subject).toBe(b.subject);
    expect(a.html).toBe(b.html);
    expect(a.text).toBe(b.text);
  });

  it('🎯 DAILY variant names the daily wall, the live N/M and the 00:00 UTC horizon', async () => {
    const sent = await render({
      to: 'a@example.com', subscriptionId: 42,
      used: 1234, total: 10000,          // monthly pair — only 12% consumed
      wall: 'daily', dailyUsed: 1000, dailyTotal: 1000,
    });
    expect(sent.subject).toBe('Webhook deliveries paused — daily limit reached');
    expect(sent.html).toContain('You have used 1,000 of your 1,000 calls today, so webhook #42 is paused.');
    expect(sent.html).toContain('Deliveries resume automatically at 00:00 UTC.');
    expect(sent.text).toContain('Webhook deliveries paused — daily limit reached.');
    // 🛑 THE DEFECT THIS WAVE EXISTS TO RETIRE — a wall that lifts in hours must never say weeks.
    expect(sent.html).not.toContain('next month');
    expect(sent.text).not.toContain('next month');
    expect(sent.html).not.toContain('monthly calls');
    // The MONTHLY figures must not leak into the daily copy: rendering 1,234/10,000 under a daily
    // wall is the "100/200 for a wall that lifts at midnight" defect in a different surface.
    expect(sent.html).not.toContain('1,234');
  });

  it('🎯 a daily wall with NO live pair falls back to monthly copy rather than fabricating 0/0', async () => {
    // We can only state N/M when we have them. A fabricated pair is worse than the wrong horizon.
    const sent = await render({ to: 'a@example.com', subscriptionId: 9, used: 5, total: 10, wall: 'daily' });
    expect(sent.subject).toBe('Webhook deliveries paused — monthly limit reached');
    expect(sent.html).not.toContain('0 of your 0');
  });

  it('🎯 every rendered fact projects from ONE wall value — subject, usage and horizon agree', async () => {
    for (const [args, wallWord, horizon] of [
      [{ to: 'a@e.com', subscriptionId: 1, used: 5, total: 10 }, 'monthly', 'next month'],
      [{ to: 'a@e.com', subscriptionId: 1, used: 5, total: 10, wall: 'daily', dailyUsed: 3, dailyTotal: 3 }, 'daily', '00:00 UTC'],
    ] as const) {
      mockSend.mockClear();
      const sent = await render(args as Record<string, unknown>);
      expect(sent.subject).toContain(`${wallWord} limit reached`);
      expect(sent.html).toContain(horizon);
      expect(sent.text).toContain(horizon);
      // The subject's wall and the body's horizon can never disagree, because both read one value.
      const otherHorizon = horizon === 'next month' ? '00:00 UTC' : 'next month';
      expect(sent.html).not.toContain(otherHorizon);
    }
  });
});
