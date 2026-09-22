/**
 * CANCEL-PATH-CSP-FORM-ACTION-W1 CH1 — src/lib/off-origin-redirect.ts.
 *
 * The portal hand-off used to be `res.redirect(303, billing.stripe.com/…)` behind a FORM POST, and
 * the served CSP's `form-action 'self'` makes Chrome/Safari refuse that redirect silently. These
 * tests pin the replacement response class (200, no Location, three navigation mechanisms), both
 * escape sinks against a hostile URL, the https-only refusal, and — because a helper that is
 * unit-tested but never called proves nothing — that the portal handler actually calls it.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  sendOffOriginRedirect,
  renderOffOriginRedirectHtml,
} from '../../src/lib/off-origin-redirect.js';

const ROOT = path.resolve(__dirname, '../..');
const COPY = { title: 'Opening your billing portal…', body: 'Stripe hosts it.', cta: 'Open Stripe Billing Portal →' };
const STRIPE = 'https://billing.stripe.com/p/session/live_YWNjdF8xTlpq';

function mockRes() {
  return {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    redirected: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = String(value); return this; },
    send(html: string) { this.body = html; return this; },
    redirect() { this.redirected = true; return this; },
    location() { this.redirected = true; return this; },
  };
}

const HTML_UNESCAPE: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const unescapeHtml = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => HTML_UNESCAPE[m]);

describe('sendOffOriginRedirect — response class', () => {
  it('answers 200 same-origin HTML, never a 3xx, and sets NO Location header', () => {
    const res = mockRes();
    sendOffOriginRedirect(res as never, STRIPE, COPY);
    expect(res.statusCode).toBe(200);
    expect(res.redirected).toBe(false);
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('carries no-store, noindex and a per-response no-referrer', () => {
    const res = mockRes();
    sendOffOriginRedirect(res as never, STRIPE, COPY);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('carries all three navigation mechanisms: meta refresh, inline location.replace, visible link', () => {
    const html = renderOffOriginRedirectHtml(STRIPE, COPY);
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${STRIPE}">`);
    expect(html).toContain(`<script>location.replace(${JSON.stringify(STRIPE)});</script>`);
    // href FIRST and double-quoted — the shape a live probe keys on.
    expect(html).toContain(`<a href="${STRIPE}" class="cta"`);
    expect(html).toContain('Open Stripe Billing Portal →');
  });

  it('the real Stripe URL reaches every sink byte-identical (no re-serialisation)', () => {
    const res = mockRes();
    sendOffOriginRedirect(res as never, STRIPE, COPY);
    expect(res.body).toContain(`content="0;url=${STRIPE}"`);
    expect(res.body).toContain(`<a href="${STRIPE}"`);
    expect(res.body).toContain(`location.replace(${JSON.stringify(STRIPE)})`);
  });

  it('carries no HTML comment and no email address (Cloudflare rewrites bodies containing one)', () => {
    const html = renderOffOriginRedirectHtml(STRIPE, COPY);
    expect(html).not.toContain('<!--');
    expect(html).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    // Literal colours only — check-token-resolution fails on an unresolved var(--x).
    expect(html).not.toContain('var(--');
  });
});

describe('sendOffOriginRedirect — two sinks, two escapes', () => {
  // `"` `<` `'` `\` and `</script>` in one target; it still parses as https, so it is ACCEPTED
  // and every sink must neutralise it on its own terms.
  const HOSTILE = `https://billing.stripe.com/p/session?x="><script>alert(1)</script>&y='a\\b'&z=</script><!--`;

  it('the hostile URL is accepted (it is https) — escaping, not refusal, is what protects it', () => {
    const res = mockRes();
    sendOffOriginRedirect(res as never, HOSTILE, COPY);
    expect(res.statusCode).toBe(200);
  });

  it('HTML sink: href and meta content decode back to exactly the target, with no raw markup', () => {
    const html = renderOffOriginRedirectHtml(HOSTILE, COPY);
    const href = /<a href="([^"]*)" class="cta"/.exec(html)?.[1];
    const meta = /<meta http-equiv="refresh" content="([^"]*)">/.exec(html)?.[1];
    expect(href).toBeDefined();
    expect(meta).toBeDefined();
    expect(unescapeHtml(href!)).toBe(HOSTILE);
    expect(unescapeHtml(meta!)).toBe(`0;url=${HOSTILE}`);
    expect(href).not.toMatch(/[<>"']/);
  });

  it('JS sink: the location.replace argument parses back to exactly the target and cannot close <script>', () => {
    const html = renderOffOriginRedirectHtml(HOSTILE, COPY);
    const arg = /<script>location\.replace\((.*)\);<\/script>/.exec(html)?.[1];
    expect(arg).toBeDefined();
    expect(arg).not.toContain('<');
    expect(arg).not.toContain('>');
    expect(JSON.parse(arg!)).toBe(HOSTILE);
    // Exactly one closing tag in the whole document: the real one.
    expect(html.split('</script>').length - 1).toBe(1);
  });

  it('U+2028 / U+2029 are escaped in the JS sink', () => {
    const url = 'https://billing.stripe.com/p/session?q=\u2028\u2029';
    const arg = /<script>location\.replace\((.*)\);<\/script>/s.exec(renderOffOriginRedirectHtml(url, COPY))?.[1];
    expect(arg).toContain('\\u2028');
    expect(arg).toContain('\\u2029');
    expect(JSON.parse(arg!)).toBe(url);
  });

  it('caller copy is escaped as text', () => {
    const html = renderOffOriginRedirectHtml(STRIPE, { title: '<b>t</b>', body: '"b"&', cta: "<i>c</i>'" });
    expect(html).toContain('<title>&lt;b&gt;t&lt;/b&gt;</title>');
    expect(html).toContain('&quot;b&quot;&amp;');
    expect(html).toContain('&lt;i&gt;c&lt;/i&gt;&#39;');
    expect(html).not.toContain('<b>t</b>');
  });
});

describe('sendOffOriginRedirect — refuses, never throws, on a non-https target', () => {
  const refused = [
    'javascript:alert(1)',
    'http://billing.stripe.com/p/session/x',
    'data:text/html,<script>alert(1)</script>',
    '//billing.stripe.com/p/session/x',
    '/account',
    'not a url',
    '',
    'https://user:pw@billing.stripe.com/p/session/x',
    'https://billing.stripe.com/p/session/x\n<script>',
  ];

  for (const target of refused) {
    it(`refuses ${JSON.stringify(target)} with a generic 502 and no Location`, () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = mockRes();
      expect(() => sendOffOriginRedirect(res as never, target, COPY)).not.toThrow();
      expect(res.statusCode).toBe(502);
      expect(res.redirected).toBe(false);
      expect(res.headers.location).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
      // Neither the page nor the log line may echo the target (it can be a credential).
      if (target) {
        expect(res.body).not.toContain(target);
        expect(err.mock.calls.flat().join(' ')).not.toContain(target);
      }
      expect(err.mock.calls.flat().join(' ')).toMatch(/CRITICAL refused off-origin hand-off: .+ \(refusal #\d+\)/);
      err.mockRestore();
    });
  }

  it('a non-string target is refused, not thrown on', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = mockRes();
    expect(() => sendOffOriginRedirect(res as never, undefined as never, COPY)).not.toThrow();
    expect(res.statusCode).toBe(502);
    err.mockRestore();
  });
});

describe('wiring — the portal handler is a real consumer', () => {
  const src = readFileSync(path.join(ROOT, 'src/lib/account-handlers.ts'), 'utf8');

  it('accountPortalHandler hands off through sendOffOriginRedirect', () => {
    expect(src).toContain("import { sendOffOriginRedirect } from './off-origin-redirect.js';");
    expect(src).toMatch(/sendOffOriginRedirect\(res, portalUrl, \{/);
  });

  it('account-handlers.ts no longer issues ANY redirect (every handler in it is form-reached)', () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bres\.redirect\(/);
    expect(code).not.toMatch(/\bres\.location\(/);
    expect(code).not.toMatch(/setHeader\(\s*['"]Location['"]/i);
  });
});
