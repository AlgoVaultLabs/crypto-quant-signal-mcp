/**
 * BOT-W2 C1 — /welcome page deep-link button (D1-C).
 *
 * After Stripe checkout completes, /welcome shows the user their api_key + a
 * "Connect to Telegram bot" button that opens t.me/algovaultofficialbot with
 * `/start auth_<api_key>` pre-filled. Bot validates the key via signal-MCP's
 * /api/bot/validate-key (internal-bypass-gated) on receipt.
 */

import { describe, expect, it } from 'vitest';
import { getWelcomePageHtml } from '../src/lib/welcome-page.js';

describe('BOT-W2 /welcome page deep-link button', () => {
  it('renders the Connect-Telegram button when apiKey is non-null', () => {
    const html = getWelcomePageHtml('av_live_abc123def456789012345678', 'starter', 'u@example.com');
    expect(html).toContain('Connect @algovaultofficialbot');
    expect(html).toContain('https://t.me/algovaultofficialbot?start=auth_av_live_abc123def456789012345678');
    expect(html).toContain('class="tg-btn"');
  });

  it('omits the button when apiKey is null (key still being provisioned)', () => {
    const html = getWelcomePageHtml(null, null, 'u@example.com');
    expect(html).not.toContain('Connect @algovaultofficialbot');
    expect(html).not.toContain('?start=auth_');
    expect(html).toContain('Your API key is being provisioned');
  });

  it('encodes the api_key defensively in the deep-link URL', () => {
    // av_live_<24hex> is URL-safe today, but encodeURIComponent is applied as
    // belt-and-braces so a future key shape change with special chars doesn't
    // silently break the deep-link.
    const html = getWelcomePageHtml('test+with/special chars', 'starter', null);
    // The +/space/etc are URL-encoded.
    expect(html).toContain('?start=auth_test%2Bwith%2Fspecial%20chars');
    expect(html).not.toContain('?start=auth_test+with/special chars');
  });

  it('opens the bot link in a new tab with rel=noopener', () => {
    const html = getWelcomePageHtml('av_live_aaaaaaaaaaaaaaaaaaaaaaaa', 'pro', null);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
  });

  it('keeps the existing api-key copy block alongside the new button', () => {
    const html = getWelcomePageHtml('av_live_aaaaaaaaaaaaaaaaaaaaaaaa', 'starter', null);
    expect(html).toContain('Your API Key');
    expect(html).toContain('id="api-key"');
    // Both blocks should appear in the rendered page.
    expect(html.indexOf('Your API Key')).toBeLessThan(html.indexOf('Connect to Telegram bot'));
  });
});
