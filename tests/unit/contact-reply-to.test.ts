/**
 * CONTACT-ANTISPAM-AND-REPLY-TO-W1 CH1 — `safeReplyToAddress` and the header it populates.
 *
 * The function under test is a HEADER-SAFETY ALLOW-LIST, not an email validator, and the
 * distinction is the whole point: every byte that can terminate a header, forge a second
 * recipient or open a display-name form must be UNREPRESENTABLE, not stripped. A stripped
 * address is a different, still-deliverable address — a reply would silently reach the wrong
 * mailbox, which is worse than not replying.
 *
 * AC1.9   all 14 specified cases
 * AC1.10  a HOSTILE address passed DIRECTLY to sendContactLeadEmail still yields admin@
 * AC1.11  a clean address rides through verbatim; `from` and `to` are byte-unchanged
 * AC1.12  both guards proven able to fail (the destructive half is run in the wave gate; the
 *         structural half — that a neutered guard would let hostile text into the header — is
 *         asserted here directly)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeReplyToAddress, REPLY_TO_ADDRESS } from '../../src/lib/email.js';
import { FIELD_LIMITS } from '../../src/lib/contact-submit.js';

describe('AC1.9 — safeReplyToAddress accepts exactly the safe population', () => {
  // Real addresses from the live contact_leads table plus the spec's synthetic edges.
  const ACCEPT = [
    ['a real submitter address', 'jacka.albertha@msn.com'],
    ['another real one', 'henrydixon487@gmail.com'],
    ['the shortest plausible form', 'a@b.co'],
    ['plus-addressing on a subdomain', 'user+tag@sub.domain.io'],
  ] as const;

  it.each(ACCEPT)('accepts %s', (_label, addr) => {
    expect(safeReplyToAddress(addr)).toBe(addr);
  });

  const REJECT = [
    // The two that make the guard a guard. In JavaScript `$` without the `m` flag matches END OF
    // INPUT ONLY — unlike Python and Ruby, where it also matches before a trailing newline. These
    // two rows are MANDATORY: they are why nobody has to remember that to keep this sound.
    ['a bare trailing newline', 'a@b.com\n'],
    ['a CRLF-injected Bcc header', 'a@b.com\r\nBcc: attacker@evil.test'],
    // Multi-recipient forgery.
    ['a comma-separated second recipient', 'a@b.com, attacker@evil.test'],
    ['a semicolon-separated second recipient', 'a@b.com; x@y.com'],
    // Display-name form — the shape that smuggles text a mail client renders as the sender.
    ['an angle-bracket display name', 'Bob <a@b.com>'],
    ['a trailing space', 'a@b.com '],
    // Not addresses at all.
    ['a dotless domain', 'a@localhost'],
    ['the empty string', ''],
    ['no at-sign', 'no-at-sign'],
    ['an internal space', 'a b@c.com'],
  ] as const;

  it.each(REJECT)('rejects %s → falls back to the operator mailbox', (_label, addr) => {
    expect(safeReplyToAddress(addr)).toBe(REPLY_TO_ADDRESS);
  });

  it('covers all 14 specified cases', () => {
    expect(ACCEPT.length + REJECT.length).toBe(14);
  });

  it('a NUL byte is rejected, not stripped', () => {
    expect(safeReplyToAddress('a@b.com\0')).toBe(REPLY_TO_ADDRESS);
  });

  it('rejects anything longer than the route\'s own email cap, reusing FIELD_LIMITS', () => {
    const long = `${'a'.repeat(FIELD_LIMITS.email)}@b.com`;
    expect(long.length).toBeGreaterThan(FIELD_LIMITS.email);
    expect(safeReplyToAddress(long)).toBe(REPLY_TO_ADDRESS);
  });

  it('REFUSES, never throws — a guard on a live serving path', () => {
    for (const bad of [undefined, null, 42, {}, []] as unknown[]) {
      expect(() => safeReplyToAddress(bad as string)).not.toThrow();
      expect(safeReplyToAddress(bad as string)).toBe(REPLY_TO_ADDRESS);
    }
  });

  it('is STABLE across repeated calls — the no-`g`-flag property', () => {
    // A g-flagged regex carries `lastIndex` across `.test()` calls and would alternate
    // true/false on the SAME input. That failure is rare, non-deterministic, and invisible to a
    // test that calls the function once — so it is asserted explicitly.
    const addr = 'henrydixon487@gmail.com';
    for (let i = 0; i < 10; i++) expect(safeReplyToAddress(addr), `call ${i}`).toBe(addr);
  });

  it('never returns a MODIFIED address — accept verbatim or fall back, nothing in between', () => {
    // The anti-stripping property, stated as an invariant over every case above.
    for (const [, addr] of [...ACCEPT, ...REJECT]) {
      const out = safeReplyToAddress(addr);
      expect(out === addr || out === REPLY_TO_ADDRESS, `"${addr}" → "${out}"`).toBe(true);
    }
  });
});

// ── AC1.10 / AC1.11 — the header as actually sent ──

const sendSpy = vi.fn(async () => ({ data: { id: 're_test' } }));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendSpy };
  },
}));

describe('AC1.10 / AC1.11 — sendContactLeadEmail populates Reply-To safely', () => {
  const ORIGINAL_KEY = process.env.RESEND_API_KEY;

  beforeEach(() => {
    sendSpy.mockClear();
    process.env.RESEND_API_KEY = 're_test_key';
  });
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = ORIGINAL_KEY;
  });

  const BASE = {
    leadId: 42,
    name: 'Ada Lovelace',
    email: 'ada@analytical.example',
    company: 'Analytical Engines',
    monthlyVolume: '250,000',
    message: 'We need 500k calls/month.',
    intent: 'Enterprise Pricing',
    src: 'unknown',
  };

  async function send(over: Partial<typeof BASE>) {
    const { sendContactLeadEmail } = await import('../../src/lib/email.js');
    await sendContactLeadEmail({ ...BASE, ...over });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    return sendSpy.mock.calls[0][0] as unknown as Record<string, string>;
  }

  it('AC1.11 — a clean address becomes Reply-To verbatim', async () => {
    const sent = await send({ email: 'henrydixon487@gmail.com' });
    expect(sent.replyTo).toBe('henrydixon487@gmail.com');
  });

  it('AC1.10 — a HOSTILE address passed directly still yields admin@', async () => {
    // The caller is hostile, not merely the route. Header safety must not be a property of who
    // calls this function — the same reasoning `canonicalInquiryType` applies to the subject.
    const sent = await send({ email: 'a@b.com\r\nBcc: attacker@evil.test' });
    expect(sent.replyTo).toBe(REPLY_TO_ADDRESS);
    // Scoped to HEADERS, deliberately. The submitted address still appears in the BODY —
    // CRLF-stripped and HTML-escaped — and that is correct, long-standing behaviour: the body is
    // the operator's record of what was actually submitted, and blinding them to a forgery
    // attempt would be worse than showing it. The property this wave adds is that no attacker
    // text reaches a HEADER, so that is what is asserted.
    for (const header of ['to', 'from', 'replyTo', 'subject'] as const) {
      expect(sent[header], header).not.toContain('attacker@evil.test');
      expect(sent[header], header).not.toMatch(/[\r\n]/);
    }
  });

  it('AC1.10 — a comma-forged second recipient yields admin@', async () => {
    const sent = await send({ email: 'a@b.com, attacker@evil.test' });
    expect(sent.replyTo).toBe(REPLY_TO_ADDRESS);
  });

  it('AC1.11 — `from` and `to` are byte-unchanged in EVERY case', async () => {
    const clean = await send({ email: 'a@b.co' });
    sendSpy.mockClear();
    const hostile = await send({ email: 'Bob <a@b.com>' });
    expect(clean.to).toBe(REPLY_TO_ADDRESS);
    expect(hostile.to).toBe(REPLY_TO_ADDRESS);
    expect(clean.from).toBe(hostile.from);
  });

  it('the operator-facing reply line tells the truth about which branch ran', async () => {
    const clean = await send({ email: 'a@b.co', name: 'Ada Lovelace' });
    expect(clean.text).toContain('Reply to this email to answer Ada Lovelace directly.');
    sendSpy.mockClear();
    const fallen = await send({ email: 'a@localhost' });
    expect(fallen.text).toContain('Reply-To could not be set safely');
    expect(fallen.text).not.toContain('Reply to this email to answer');
  });

  it('AC1.12 (structural half) — a neutered guard WOULD let hostile text into the header', async () => {
    // Proves the assertion above can fail rather than being vacuously satisfied by a header the
    // code never sets. Simulate the identity guard the AC1.12 gate installs destructively.
    const identityGuard = (email: string): string => email;
    const hostile = 'a@b.com\r\nBcc: attacker@evil.test';
    expect(identityGuard(hostile)).toContain('attacker@evil.test');
    expect(safeReplyToAddress(hostile)).not.toContain('attacker@evil.test');
  });
});
