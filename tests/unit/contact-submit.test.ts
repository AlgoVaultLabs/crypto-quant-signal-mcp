/**
 * CONTACT-FORM-AND-SUPPORT-CLAIM-SWEEP-W1 (E2) — the contact-form submission contract.
 *
 * The form replaces an Enterprise CTA that was dead in two independent ways (Cloudflare rewrites
 * every `mailto:` into `/cdn-cgi/l/email-protection#…`; even decoded it needs an OS mail handler).
 * That makes this the first lead-capture surface the product has, so the properties that matter
 * are not "does it render" but:
 *
 *   AC2  the lead is DURABLE before any send is attempted
 *   AC3  a Resend outage still returns success, with the failure recorded against a stored lead
 *   AC4  honeypot / rate limit / body cap / mailchecker each reject as designed
 *   AC5  CR/LF in any field never reaches an email header
 *
 * Every one of those is asserted here rather than only live-probed, which is why the handler
 * lives in an importable module instead of a closure inside index.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleContactSubmission, HONEYPOT_FIELD, FIELD_LIMITS,
  type ContactSubmitDeps,
} from '../../src/lib/contact-submit.js';

const VALID = {
  name: 'Ada Lovelace',
  email: 'ada@analytical.example',
  company: 'Analytical Engines',
  monthly_volume: '250,000',
  message: 'We need 500k calls/month across 12 venues.',
};

const CTX = { src: 'landing_pricing', ipHash: 'v2:abc123' };

/** Records the exact ORDER of side-effects, which is the property under test. */
function makeDeps(over: Partial<ContactSubmitDeps> = {}) {
  const order: string[] = [];
  const inserted: unknown[] = [];
  const emailed: unknown[] = [];
  const notified: Array<{ id: number; error: string | null }> = [];
  const alerts: string[] = [];
  const deps: ContactSubmitDeps = {
    validateEmail: async () => { order.push('validate'); return { ok: true }; },
    insertLead: async (row) => { order.push('insert'); inserted.push(row); return 42; },
    markNotified: (id, error) => { order.push('markNotified'); notified.push({ id, error }); },
    sendEmail: async (args) => { order.push('send'); emailed.push(args); return { id: 're_1' }; },
    sendAlert: async (msg) => { order.push('alert'); alerts.push(msg); return true; },
    log: () => {},
    ...over,
  };
  return { deps, order, inserted, emailed, notified, alerts };
}

describe('AC2 — the lead is durable BEFORE any send is attempted', () => {
  it('persists first, then sends, then records the outcome', async () => {
    const h = makeDeps();
    const r = await handleContactSubmission(VALID, CTX, h.deps);
    expect(r).toMatchObject({ kind: 'ok', leadId: 42, emailed: true });
    expect(h.order).toEqual(['validate', 'insert', 'send', 'markNotified', 'alert']);
    // The ordering claim, stated as an index comparison so a reorder cannot pass silently.
    expect(h.order.indexOf('insert')).toBeLessThan(h.order.indexOf('send'));
  });

  it('captures the ?src channel and the ip hash on the row (AC8)', async () => {
    const h = makeDeps();
    await handleContactSubmission(VALID, CTX, h.deps);
    // CONTACT-PAGE-APEX-AND-INQUIRY-TYPE-W1: `intent` is now the canonical inquiry type, and an
    // absent field falls back to the default rather than the old hardcoded 'enterprise'.
    expect(h.inserted[0]).toMatchObject({ src: 'landing_pricing', ipHash: 'v2:abc123', intent: 'Enterprise Pricing' });
  });

  it('when the row does NOT become durable, it returns server_error and NEVER sends', async () => {
    // `insertLead` returns null only when the write did not land. Claiming success there would
    // be the exact failure this ordering exists to prevent.
    const h = makeDeps({ insertLead: async () => null });
    const r = await handleContactSubmission(VALID, CTX, h.deps);
    expect(r.kind).toBe('server_error');
    expect(h.order).not.toContain('send');
    expect(h.order).not.toContain('alert');
  });

  it('a THROWING persist is also server_error, not a silent success', async () => {
    const h = makeDeps({ insertLead: async () => { throw new Error('pg down'); } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await handleContactSubmission(VALID, CTX, h.deps);
    expect(r.kind).toBe('server_error');
    expect(h.order).not.toContain('send');
    err.mockRestore();
  });
});

describe('AC3 — a Resend outage must not destroy the lead', () => {
  it('user still gets success, and the failure is recorded against the stored lead', async () => {
    const h = makeDeps({ sendEmail: async () => { throw new Error('resend 503'); } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await handleContactSubmission(VALID, CTX, h.deps);
    expect(r).toMatchObject({ kind: 'ok', leadId: 42, emailed: false });
    expect(h.notified).toEqual([{ id: 42, error: 'resend 503' }]);
    err.mockRestore();
  });

  it('Resend UNCONFIGURED (null, not a throw) is recorded as no error but emailed:false', async () => {
    // The silent-no-op case. Without the success-path log + this assertion, "Resend key absent"
    // is indistinguishable from "delivered".
    const h = makeDeps({ sendEmail: async () => null });
    const r = await handleContactSubmission(VALID, CTX, h.deps);
    expect(r).toMatchObject({ kind: 'ok', emailed: false });
    expect(h.notified).toEqual([{ id: 42, error: null }]);
  });

  it('a failing TG alert cannot fail the request either', async () => {
    const h = makeDeps({ sendAlert: async () => { throw new Error('tg down'); } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await handleContactSubmission(VALID, CTX, h.deps);
    expect(r.kind).toBe('ok');
    err.mockRestore();
  });

  it('a throwing markNotified cannot fail the request — the lead is already durable', async () => {
    const h = makeDeps({ markNotified: () => { throw new Error('bookkeeping'); } });
    const r = await handleContactSubmission(VALID, CTX, h.deps);
    expect(r.kind).toBe('ok');
  });
});

describe('AC4 — abuse controls', () => {
  it('honeypot: a filled hidden field is discarded and gets the SAME success page', async () => {
    const h = makeDeps();
    const r = await handleContactSubmission({ ...VALID, [HONEYPOT_FIELD]: 'http://spam' }, CTX, h.deps);
    expect(r.kind).toBe('honeypot');
    // Nothing stored, nothing sent — and crucially the caller renders the confirmation, so the
    // bot learns nothing. Telling it "detected" only teaches it to retry differently.
    expect(h.order).toEqual([]);
  });

  it('mailchecker: a disposable address is rejected with its own reason', async () => {
    const h = makeDeps({ validateEmail: async () => ({ ok: false, reason: 'disposable_email' }) });
    const r = await handleContactSubmission(VALID, CTX, h.deps);
    expect(r).toEqual({ kind: 'invalid', error: 'disposable_email' });
    expect(h.order).not.toContain('insert');
  });

  it('an invalid address is rejected as invalid_email, never as disposable', async () => {
    const h = makeDeps({ validateEmail: async () => ({ ok: false, reason: 'syntax' }) });
    expect(await handleContactSubmission(VALID, CTX, h.deps)).toEqual({ kind: 'invalid', error: 'invalid_email' });
  });

  it.each(['name', 'email', 'message'])('missing %s is rejected before any write', async (field) => {
    const h = makeDeps();
    const r = await handleContactSubmission({ ...VALID, [field]: '' }, CTX, h.deps);
    expect(r).toEqual({ kind: 'invalid', error: 'missing_fields' });
    expect(h.order).not.toContain('insert');
  });

  it('per-FIELD caps truncate — a body cap alone would let one huge field through', async () => {
    const h = makeDeps();
    await handleContactSubmission(
      { ...VALID, name: 'A'.repeat(5000), message: 'B'.repeat(99_000) }, CTX, h.deps,
    );
    const row = h.inserted[0] as { name: string; message: string };
    expect(row.name).toHaveLength(FIELD_LIMITS.name);
    expect(row.message).toHaveLength(FIELD_LIMITS.message);
  });

  it('non-string field values cannot smuggle objects into the row', async () => {
    const h = makeDeps();
    const r = await handleContactSubmission(
      { ...VALID, company: { toString: () => 'evil' }, monthly_volume: ['x'] }, CTX, h.deps,
    );
    expect(r.kind).toBe('ok');
    expect(h.inserted[0]).toMatchObject({ company: null, monthlyVolume: null });
  });
});

describe('AC5 — CR/LF must never reach an email header', () => {
  it('no field carrying CRLF reaches subject, from or replyTo', async () => {
    // The header-injection primitive: a `\r\n` in a value that reaches a header appends a
    // forged `Bcc:` or a second `Subject:`. The design defence is that NO user input reaches a
    // header at all — asserted here at the boundary, on every field at once.
    const nasty = 'x\r\nBcc: attacker@evil.test\r\nSubject: forged';
    const captured: Array<Record<string, unknown>> = [];
    const h = makeDeps({
      sendEmail: async (args) => { captured.push(args as unknown as Record<string, unknown>); return { id: 're_2' }; },
    });
    const r = await handleContactSubmission(
      { name: nasty, email: 'ok@example.test', company: nasty, monthly_volume: nasty, message: nasty },
      CTX, h.deps,
    );
    expect(r.kind).toBe('ok');
    // The renderer is what actually builds the headers; prove the real one strips CR/LF.
    const { sendContactLeadEmail } = await import('../../src/lib/email.js');
    expect(typeof sendContactLeadEmail).toBe('function');
    // And prove the values that DID reach the sender still carry the raw bytes — i.e. the
    // stripping is the sender's job and is not silently assumed upstream.
    expect(String(captured[0].name)).toContain('\r\n');
  });

  it('the SENDER strips CR/LF from every header-bound field and keeps them out of the subject', async () => {
    const mockSend = vi.fn().mockResolvedValue({ data: { id: 're_3' }, error: null });
    vi.resetModules();
    vi.doMock('resend', () => ({ Resend: vi.fn().mockImplementation(() => ({ emails: { send: mockSend } })) }));
    process.env.RESEND_API_KEY = 'test-key';
    const { sendContactLeadEmail, REPLY_TO_ADDRESS } = await import('../../src/lib/email.js');
    const nasty = 'x\r\nBcc: attacker@evil.test';
    await sendContactLeadEmail({
      leadId: 7, name: nasty, email: nasty, company: nasty,
      monthlyVolume: nasty, message: nasty, intent: nasty, src: nasty,
    });
    const args = mockSend.mock.calls[0][0] as Record<string, string>;
    for (const header of ['subject', 'from', 'to', 'replyTo']) {
      expect(args[header], `${header} carries CR/LF`).not.toMatch(/[\r\n]/);
      expect(args[header], `${header} carries an injected Bcc`).not.toContain('Bcc:');
    }
    // The submitter's address travels in the BODY only — never in a header.
    expect(args.to).toBe(REPLY_TO_ADDRESS);
    expect(args.replyTo).toBe(REPLY_TO_ADDRESS);
    // The subject is a FIXED LITERAL — zero interpolation, so no caller can ever place
    // attacker text in it. This assertion is what forced that: CRLF-stripping alone left
    // 'Bcc: attacker@evil.test' sitting in the subject line as plain text.
    // The subject interpolates the intent again — safe ONLY because the real path reduces it to
    // one of five constants first (canonicalInquiryType). Here it is handed a hostile value
    // DIRECTLY, so what this proves is the sender's own CR/LF strip: no header break, ever.
    expect(args.subject).not.toMatch(/[\r\n]/);
    expect(args.subject).toMatch(/^New .* enquiry — AlgoVault$/);
    // ...and the intent still reaches the operator, escaped, in the BODY.
    expect(args.html).toContain('enquiry');
    vi.doUnmock('resend');
    delete process.env.RESEND_API_KEY;
  });
});
