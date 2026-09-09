/**
 * IDENTITY-LIFECYCLE-W3 — the outbound credential guard (architect ruling Q7, 2026-09-09).
 *
 * Build Rule 9 as AMENDED: "Never a PAID secret in any email. A free-tier key may appear in the
 * activation snippet only."
 *
 * The rule is enforced HERE and in `scanOutboundCredentials`, not in prose, because a written
 * instruction not to put paid keys in emails is exactly the shape the next wave violates while
 * adding a template. These assertions are the control.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const KEY = 'a'.repeat(48);

function freshEnv(): void {
  vi.resetModules();
  process.env.PERFORMANCE_DB_PATH = ':memory:';
  process.env.ALGOVAULT_IP_HASH_KEY = KEY;
  delete process.env.DATABASE_URL;
  delete process.env.LIFECYCLE_MODE;
}

const FREE = 'av_free_16322c186f8aa6b01a9853d0';
const PAID = 'av_live_deadbeefcafe0123456789ab';

const CTX = {
  keyMasked: 'av_free_…53d0',
  used: 160,
  total: 200,
  resetDate: '14 September 2026',
  mcpConfigSnippet: '',
  periodKey: 'p1',
};

describe('scanOutboundCredentials — an ALLOW-LIST, not a deny-list', () => {
  beforeEach(freshEnv);

  it('permits a free-tier key', async () => {
    const { scanOutboundCredentials } = await import('../../src/lib/lifecycle/render.js');
    expect(scanOutboundCredentials(`Bearer ${FREE}`).ok).toBe(true);
  });

  it('REFUSES a paid key', async () => {
    const { scanOutboundCredentials } = await import('../../src/lib/lifecycle/render.js');
    const r = scanOutboundCredentials(`Bearer ${PAID}`);
    expect(r.ok).toBe(false);
    // The report carries a PREFIX only — a guard that logs the whole secret in order to complain
    // about a secret has reproduced the defect it exists to prevent.
    expect(r.offending).toEqual(['av_live_…']);
    expect(r.offending.join()).not.toContain('deadbeefcafe');
  });

  it('REFUSES formats this guard was never told about — that is why it is an allow-list', async () => {
    const { scanOutboundCredentials } = await import('../../src/lib/lifecycle/render.js');
    // There is NO `av_live_` constant in the codebase: paid keys are Stripe-validated, not
    // prefix-recognised. Enumerating paid formats would be guessing at a set nobody maintains,
    // so anything credential-shaped that is not `av_free_` refuses — including formats invented
    // after this test was written.
    for (const bad of ['sk_live_51Hxxxxxxxxxxxxxxxxxx', 'whsec_abcdefghijklmnop', 'pk_test_abcdefghijkl', 'rk_live_zzzzzzzzzzzzzz']) {
      expect(scanOutboundCredentials(bad).ok, bad).toBe(false);
    }
  });

  it('does NOT trip on the unsubscribe or preference handles', async () => {
    const { scanOutboundCredentials } = await import('../../src/lib/lifecycle/render.js');
    const { unsubscribeToken, preferenceToken } = await import('../../src/lib/lifecycle/identity.js');
    // The handles are `<base64url>.<64 hex>` — deliberately not credential-shaped. Asserted
    // rather than assumed, because a guard that fires on every footer would be disabled within a
    // day and would take the real protection with it.
    expect(scanOutboundCredentials(unsubscribeToken(FREE)).ok).toBe(true);
    expect(scanOutboundCredentials(preferenceToken(FREE)).ok).toBe(true);
  });

  it('scans every part it is given, not just the first', async () => {
    const { scanOutboundCredentials } = await import('../../src/lib/lifecycle/render.js');
    expect(scanOutboundCredentials('clean subject', 'clean text', `<p>${PAID}</p>`).ok).toBe(false);
  });
});

describe('the engine REFUSES a body carrying a paid key', () => {
  beforeEach(freshEnv);

  const recipient = { recipientId: 'fk_guard1', email: 'guard@example.com', identityBound: true };

  it('a free-key snippet renders and ledgers normally', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const { mcpConfigSnippet } = await import('../../src/lib/lifecycle-copy.js');
    const r = await eng.sendLifecycle('activation_nudge', recipient,
      { ...CTX, mcpConfigSnippet: mcpConfigSnippet(FREE) });
    expect(r.status).toBe('would_send');
  });

  it('a PAID-key snippet is refused, and NOTHING is written to the ledger', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const { mcpConfigSnippet } = await import('../../src/lib/lifecycle-copy.js');
    const { dbQuery } = await import('../../src/lib/performance-db.js');
    const { ensureLifecycleSchema } = await import('../../src/lib/lifecycle/schema.js');

    const r = await eng.sendLifecycle('activation_nudge', recipient,
      { ...CTX, mcpConfigSnippet: mcpConfigSnippet(PAID) });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('non_free_credential_in_body');

    // THE REFUSAL RUNS BEFORE THE LEDGER CLAIM. Shadow mode PERSISTS the rendered bytes, so a
    // guard placed after the claim would still have written the paid secret to
    // `lifecycle_sends.rendered_html` at rest — refusing to send it while storing it.
    ensureLifecycleSchema();
    const rows = await dbQuery('SELECT * FROM lifecycle_sends');
    expect(rows).toHaveLength(0);
  });

  it('the refusal does not consume the slot — a fixed body can still be sent', async () => {
    const eng = await import('../../src/lib/lifecycle/engine.js');
    const { mcpConfigSnippet } = await import('../../src/lib/lifecycle-copy.js');
    await eng.sendLifecycle('activation_nudge', recipient, { ...CTX, mcpConfigSnippet: mcpConfigSnippet(PAID) });
    // Not burning the slot is deliberate: the refusal is a bug in what we rendered, not a
    // decision about this recipient, and permanently blocking their message would turn a
    // fixable defect into silent data loss.
    const after = await eng.sendLifecycle('activation_nudge', recipient, { ...CTX, mcpConfigSnippet: mcpConfigSnippet(FREE) });
    expect(after.status).toBe('would_send');
  });
});

describe('the LIVE E1 template carries only a free key', () => {
  beforeEach(freshEnv);

  it('renders clean through the real copy module', async () => {
    const { renderLifecycleEmail, scanOutboundCredentials } = await import('../../src/lib/lifecycle/render.js');
    const { mcpConfigSnippet } = await import('../../src/lib/lifecycle-copy.js');
    const { unsubscribeToken } = await import('../../src/lib/lifecycle/identity.js');
    for (const step of ['activation_nudge', 'quota_80', 'quota_wall', 'reset_return'] as const) {
      const m = renderLifecycleEmail(step, { ...CTX, mcpConfigSnippet: mcpConfigSnippet(FREE) },
        `https://api.algovault.com/email/unsubscribe/${unsubscribeToken(FREE)}`);
      const scan = scanOutboundCredentials(m.subject, m.text, m.html);
      expect(scan.ok, `${step}: ${scan.offending.join()}`).toBe(true);
    }
  });
});
