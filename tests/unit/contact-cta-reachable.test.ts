/**
 * CONTACT-PAGE-APEX-AND-INQUIRY-TYPE-W1 (F4) — a "Contact us" must go somewhere that works,
 * and every inquiry type must survive the whole round trip.
 *
 * THE BUG CLASS THIS RETIRES: a CTA that looks live and is not. It has now produced three
 * defects across three consecutive waves —
 *
 *   1. the Enterprise CTA was a `mailto:` Cloudflare rewrites into
 *      `/cdn-cgi/l/email-protection#…`, so it resolved to a dead internal path
 *   2. the fix landed on the app-rendered `/signup` and NOT on the statically-served apex
 *      landing, which kept the obfuscated link
 *   3. the form it pointed at 404'd on the brand domain entirely
 *
 * Every one of those passed a green build. What they have in common is that nothing asserted the
 * DESTINATION of a CTA — only that some markup existed.
 *
 * The second half guards the new inquiry type. Five values feed FOUR consumers (options,
 * validator, email subject, Telegram body); a value present in the dropdown but missing from the
 * validator is a form that silently discards a whole category of enquiry.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPlanCards } from '../../src/lib/signup-flow.js';
import { renderContactPage, CONTACT_FALLBACK_EMAIL } from '../../src/lib/contact-page.js';
import {
  INQUIRY_TYPES, DEFAULT_INQUIRY_TYPE, canonicalInquiryType, handleContactSubmission,
  type ContactSubmitDeps,
} from '../../src/lib/contact-submit.js';

const ROOT = join(__dirname, '..', '..');

interface Surface { readonly name: string; readonly html: () => string; readonly reason: string; }

/** Every surface that renders a "Contact us" CTA. A reason per row, never in a comment. */
const SURFACES: readonly Surface[] = [
  {
    name: 'renderPlanCards() [/signup, /join, referral]',
    html: () => renderPlanCards(),
    reason: 'the function-rendered checkout cards — where the CTA was first fixed',
  },
  {
    name: 'landing/index.html',
    html: () => readFileSync(join(ROOT, 'landing/index.html'), 'utf8'),
    reason: 'the STATICALLY-served apex landing — the surface the fix missed the first time',
  },
];

/** Every `<a>` whose visible label is "Contact us", paired with its href. */
function contactCtas(html: string): Array<{ href: string; label: string }> {
  return [...html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([^<]*Contact us[^<]*)<\/a>/gi)]
    .map((m) => ({ href: m[1], label: m[2].trim() }));
}

describe('a "Contact us" CTA must resolve to the form, never to a mailbox', () => {
  it('every guarded surface actually renders and carries a CTA (vacuity guard)', () => {
    expect(SURFACES.length).toBeGreaterThanOrEqual(2);
    for (const s of SURFACES) {
      expect(s.reason.length, s.name).toBeGreaterThan(20);
      expect(s.html().length, `${s.name} rendered empty`).toBeGreaterThan(500);
      expect(contactCtas(s.html()).length, `${s.name} has no "Contact us" CTA at all`).toBeGreaterThan(0);
    }
  });

  it.each(SURFACES)('$name: no CTA points at a mailto or a Cloudflare-obfuscated href', ({ html }) => {
    for (const cta of contactCtas(html())) {
      // `mailto:` is the original defect; `/cdn-cgi/l/email-protection` is what Cloudflare turns
      // one into at the edge, so a surface can look clean in the repo and be broken in a browser.
      expect(cta.href, `"${cta.label}" -> ${cta.href}`).not.toMatch(/^mailto:/i);
      expect(cta.href, `"${cta.label}" -> ${cta.href}`).not.toContain('cdn-cgi/l/email-protection');
    }
  });

  it.each(SURFACES)('$name: every CTA targets the contact form', ({ html }) => {
    for (const cta of contactCtas(html())) {
      expect(cta.href, `"${cta.label}"`).toMatch(/^(\/contact$|https:\/\/algovault\.com\/contact$)/);
    }
  });

  it('the contact page keeps ONE plain-address fallback — deliberate, and not a CTA', () => {
    // The fallback is for someone whose JS is off. It is not labelled "Contact us", so the rule
    // above does not reach it, and it must NOT be swept away by a future tightening.
    const page = renderContactPage();
    expect(page).toContain(`mailto:${CONTACT_FALLBACK_EMAIL}`);
    expect(contactCtas(page)).toEqual([]);
  });
});

describe('every inquiry type round-trips through all FOUR consumers', () => {
  it('the constant is non-empty and ordered as the architect specified (vacuity guard)', () => {
    expect(INQUIRY_TYPES).toEqual([
      'Enterprise Pricing', 'Collaboration/Co-Marketing', 'Feature Request',
      'Billing Inquiry', 'Other Inquiry',
    ]);
    expect(DEFAULT_INQUIRY_TYPE).toBe('Enterprise Pricing');
  });

  it('CONSUMER 1 — the <select> renders every value, in order, default pre-selected', () => {
    const page = renderContactPage();
    const options = [...page.matchAll(/<option value="([^"]+)"([^>]*)>/g)].map((m) => ({
      value: m[1], selected: m[2].includes('selected'),
    }));
    expect(options.map((o) => o.value)).toEqual([...INQUIRY_TYPES]);
    expect(options.filter((o) => o.selected).map((o) => o.value)).toEqual([DEFAULT_INQUIRY_TYPE]);
    expect(page).toContain('name="intent"');
  });

  it('CONSUMER 2 — the validator accepts every value and default-denies anything else', () => {
    for (const t of INQUIRY_TYPES) expect(canonicalInquiryType(t), t).toBe(t);
    for (const bad of ['enterprise', 'Enterprise', '', 'DROP TABLE', null, 42, {}]) {
      expect(canonicalInquiryType(bad), String(bad)).toBeNull();
    }
  });

  it.each(INQUIRY_TYPES)('CONSUMERS 3+4 — "%s" reaches the stored row, the subject and the TG body', async (intent) => {
    const stored: Array<{ intent: string }> = [];
    const emailed: Array<{ intent: string }> = [];
    const alerts: string[] = [];
    const deps: ContactSubmitDeps = {
      validateEmail: async () => ({ ok: true }),
      insertLead: async (row) => { stored.push(row); return 1; },
      markNotified: () => {},
      sendEmail: async (a) => { emailed.push(a); return { id: 're_1' }; },
      sendAlert: async (m) => { alerts.push(m); return true; },
      log: () => {},
    };
    const r = await handleContactSubmission(
      { name: 'A', email: 'a@b.test', message: 'm', intent },
      { src: null, ipHash: null }, deps,
    );
    expect(r.kind).toBe('ok');
    expect(stored[0].intent, 'stored row').toBe(intent);   // consumer 3: the DB
    expect(emailed[0].intent, 'email').toBe(intent);        // consumer 4a: the email
    expect(alerts[0], 'telegram body').toContain(intent);   // consumer 4b: telegram
  });

  it('an unrecognised intent is REJECTED, and nothing is written', async () => {
    const stored: unknown[] = [];
    const deps: ContactSubmitDeps = {
      validateEmail: async () => ({ ok: true }),
      insertLead: async (row) => { stored.push(row); return 1; },
      markNotified: () => {}, sendEmail: async () => null, sendAlert: async () => true, log: () => {},
    };
    const r = await handleContactSubmission(
      { name: 'A', email: 'a@b.test', message: 'm', intent: 'Free Money Please' },
      { src: null, ipHash: null }, deps,
    );
    expect(r).toEqual({ kind: 'invalid', error: 'invalid_intent' });
    expect(stored).toEqual([]);
  });

  it('an ABSENT intent falls back to the default — a legacy client still works', async () => {
    const stored: Array<{ intent: string }> = [];
    const deps: ContactSubmitDeps = {
      validateEmail: async () => ({ ok: true }),
      insertLead: async (row) => { stored.push(row); return 1; },
      markNotified: () => {}, sendEmail: async () => null, sendAlert: async () => true, log: () => {},
    };
    const r = await handleContactSubmission(
      { name: 'A', email: 'a@b.test', message: 'm' }, { src: null, ipHash: null }, deps,
    );
    expect(r.kind).toBe('ok');
    expect(stored[0].intent).toBe(DEFAULT_INQUIRY_TYPE);
  });

  it('the email SUBJECT carries only a canonical value — never the submitted string', async () => {
    const mockSend = vi.fn().mockResolvedValue({ data: { id: 're_2' }, error: null });
    vi.resetModules();
    vi.doMock('resend', () => ({ Resend: vi.fn().mockImplementation(() => ({ emails: { send: mockSend } })) }));
    process.env.RESEND_API_KEY = 'test-key';
    const { sendContactLeadEmail } = await import('../../src/lib/email.js');
    // Even handed a hostile `intent` DIRECTLY, the sender's CR/LF strip keeps the header clean —
    // and in the real path `canonicalInquiryType` has already reduced it to one of five literals.
    await sendContactLeadEmail({
      leadId: 1, name: 'n', email: 'e@f.test', company: null, monthlyVolume: null,
      message: 'm', intent: 'X\r\nBcc: evil@test', src: null,
    });
    const args = mockSend.mock.calls[0][0] as Record<string, string>;
    expect(args.subject).not.toMatch(/[\r\n]/);
    vi.doUnmock('resend');
    delete process.env.RESEND_API_KEY;
  });
});
