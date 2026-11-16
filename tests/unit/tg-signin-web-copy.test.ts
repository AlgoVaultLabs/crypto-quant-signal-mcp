/**
 * TG-SIGNIN-W1-R2 CH2 — §Copy W1–W3 on the web surfaces, verbatim (W1 by Mr.1's ruling 2026-11-16 09:08; W2 and
 * W3 reused from TG-SIGNIN-W1 CH2, R2.1).
 *
 *   W1  /welcome, the reveal of a checkout from the Telegram bot that carries a minted sign-in token: W1 + an
 *       "Open Telegram" button whose link carries the token (`?start=tgl_<token>`) stand IN PLACE OF the `auth_`
 *       Connect button — the token signs in the chat that opens it, and the link never carries the key.
 *   W2  the welcome and the recovery emails, HTML and text: how to sign in with the key just sent.
 *   W3  /welcome, any other page with a key — a checkout not from the bot, or a Telegram checkout whose mint
 *       failed: the Connect button stays and W3 is added. And the Google / GitHub key page, for a PAID key only.
 *
 * The pending and refused arms never show a token, even when a caller passes one: there is no key on the page,
 * and the refused arm is deliberately no oracle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The Resend client, captured (the tests/email.test.ts shape) — the emails render for real.
const mockSend = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

import { getWelcomePageHtml, getWelcomeRevealHtml, TG_SIGNIN_W3 } from '../../src/lib/welcome-page.js';

const W1 = '✅ Payment received. Tap Open Telegram to finish signing in.';
const W2 = 'Using Telegram? Open @algovaultofficialbot, tap 🔑 Sign In and paste this key.';
const W3 = 'In Telegram: open @algovaultofficialbot, tap 🔑 Sign In and paste your key.';
const KEY = 'av_live_0a0a0a0a0a0a0a0a0a0a0a0a';
const TOKEN = 'tgl_3f9a0c7e5b1d2468ace0bd13579f2a6c';
const PAGE_OPTS = { newSignupEnabled: true, oauthProviders: { google: true, github: true } };

/** Visible text: scripts, styles and tags dropped, whitespace collapsed. */
const textOf = (html: string): string =>
  html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
const tgCard = (html: string): string => {
  const start = html.indexOf('<div class="tg-connect">');
  return start < 0 ? '' : html.slice(start, html.indexOf('</div>', html.indexOf('class="tg-btn"', start)) + '</div>'.length);
};

describe('/welcome — W1 for a Telegram checkout\'s reveal (R2.3)', () => {
  const html = getWelcomeRevealHtml({ kind: 'reveal', apiKey: KEY, tier: 'starter', email: 'buyer@example.com', signinToken: TOKEN }, PAGE_OPTS);

  it('W1 verbatim, and an Open Telegram button whose link carries the token', () => {
    expect(textOf(html)).toContain(W1);
    expect(tgCard(html)).toContain(
      `<a href="https://t.me/algovaultofficialbot?start=${TOKEN}" target="_blank" rel="noopener" class="tg-btn">Open Telegram</a>`,
    );
  });

  it('in place of the auth_ Connect button — no key goes into a Telegram link, and W3 is not shown', () => {
    expect(html).not.toContain('?start=auth_');
    expect(html).not.toContain('Connect @algovaultofficialbot');
    expect(textOf(html)).not.toContain(W3);
    expect(tgCard(html)).not.toContain(KEY);
  });

  it('the reveal still shows the key itself; the only occurrence it loses is the auth_ link', () => {
    expect(html).toContain(`<code id="api-key">${KEY}</code>`);
    const withButton = getWelcomePageHtml(KEY, 'starter', 'buyer@example.com', PAGE_OPTS);
    expect(withButton).toContain(`?start=auth_${KEY}`);
    expect(html.split(KEY).length).toBe(withButton.split(KEY).length - 1);
  });

  it('the token appears in that one link and nowhere else on the page', () => {
    expect(html.split(TOKEN)).toHaveLength(2);
  });
});

describe('/welcome — W3 beside the Connect button for every other page with a key', () => {
  const ordinary = getWelcomeRevealHtml({ kind: 'reveal', apiKey: KEY, tier: 'pro', email: 'buyer@example.com' }, PAGE_OPTS);

  it('a reveal without a token (not from the bot, or a failed mint) keeps the auth_ button and adds W3 verbatim', () => {
    expect(ordinary).toContain(`https://t.me/algovaultofficialbot?start=auth_${KEY}`);
    expect(ordinary).toContain('Connect @algovaultofficialbot');
    expect(textOf(ordinary)).toContain(W3);
    expect(textOf(ordinary)).not.toContain(W1);
    expect(ordinary).not.toContain('?start=tgl_');
  });

  it('W3 sits inside the Telegram card, before its button', () => {
    const card = tgCard(ordinary);
    expect(card.indexOf(W3)).toBeGreaterThan(0);
    expect(card.indexOf(W3)).toBeLessThan(card.indexOf('class="tg-btn"'));
  });

  it('the pending and refused arms never show a token, even when a caller passes one', () => {
    const opts = { ...PAGE_OPTS, tgSigninToken: TOKEN };
    const pending = getWelcomeRevealHtml({ kind: 'pending', tier: 'pro', email: 'buyer@example.com' }, opts);
    const refused = getWelcomeRevealHtml({ kind: 'refused', reason: 'already_shown' }, opts);
    for (const page of [pending, refused]) {
      expect(page).not.toContain(TOKEN);
      expect(textOf(page)).not.toContain(W1);
      expect(textOf(page)).not.toContain(W3);
      expect(page).not.toContain('class="tg-btn"');
    }
    // …and both stay byte-identical to their pre-wave arms.
    expect(pending).toBe(getWelcomePageHtml(null, 'pro', 'buyer@example.com', PAGE_OPTS));
    expect(refused).toBe(getWelcomePageHtml(null, null, null, { ...PAGE_OPTS, keyAlreadyShown: true }));
  });

  it('a page with no key shows no Telegram card at all, token or not', () => {
    expect(getWelcomePageHtml(null, 'starter', 'buyer@example.com', { ...PAGE_OPTS, tgSigninToken: TOKEN })).not.toContain('tg-connect"');
  });
});

describe('W2 in the welcome and the recovery emails (R2.1)', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: 'mock-email-id' }, error: null });
    process.env.RESEND_API_KEY = 'test_key';
  });
  afterEach(() => { process.env = { ...origEnv }; });

  it('the welcome email carries W2 in HTML and text, after the key', async () => {
    const { sendWelcomeEmail } = await import('../../src/lib/email.js');
    await sendWelcomeEmail({ to: 'buyer@example.com', apiKey: KEY, tier: 'starter' });
    const { html, text } = mockSend.mock.calls[0][0] as { html: string; text: string };
    expect(textOf(html)).toContain(W2);
    expect(text).toContain(W2);
    expect(html.indexOf(W2)).toBeGreaterThan(html.indexOf(KEY));
    expect(text.indexOf(W2)).toBeGreaterThan(text.indexOf(KEY));
  });

  it('the recovery email carries W2 in HTML and text', async () => {
    const { sendKeyRecoveryEmail } = await import('../../src/lib/email.js');
    await sendKeyRecoveryEmail({ to: 'buyer@example.com', apiKey: KEY, tier: 'pro' });
    const { html, text } = mockSend.mock.calls[0][0] as { html: string; text: string };
    expect(textOf(html)).toContain(W2);
    expect(text).toContain(W2);
  });
});

describe('W3 on the Google / GitHub key page, paid keys only (R2.1, source)', () => {
  it('the exported copy is §Copy W3 verbatim', () => {
    expect(TG_SIGNIN_W3).toBe(W3);
  });

  it('the callback renders it after the key, gated on a PAID identity', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8');
    const start = src.indexOf("app.get('/auth/:provider/callback'");
    const end = src.indexOf('// ── AV-CHAT-MCP-W1', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const route = src.slice(start, end);
    const line = "(paid ? `<p>${TG_SIGNIN_W3}</p>` : '') +";
    expect(route.split(line)).toHaveLength(2);
    const iKey = route.indexOf('user-select:all">${key}</pre>`');
    expect(iKey).toBeGreaterThan(0);
    expect(route.indexOf(line)).toBeGreaterThan(iKey);
    expect(route.indexOf(line)).toBeLessThan(route.indexOf('`<p>Referral link:'));
  });
});
