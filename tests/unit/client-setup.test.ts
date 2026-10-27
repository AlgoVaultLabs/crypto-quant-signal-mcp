/**
 * GROWTH-AGENT-SIGNIN-OAUTH-W1 CH1 — the ONE setup derivation.
 *
 * Every key-bearing surface (/welcome, the paid-welcome / free-key / recovery emails, lifecycle E1)
 * renders `client-setup.ts` `setupSnippet`, which projects from the docs registry row. These pin:
 *   - the Claude Desktop snippet is the stdio `command` + `args` form (its config file ignores `url`);
 *   - parity with the docs, modulo the key, the track token and `?src=docs` (ruling Q2);
 *   - no surface carries a hand-written snippet.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

const { SETUP_CONFIG_SNIPPETS } = await import('../../src/lib/integrations-data/mcp-clients.js');
const MCP_CLIENTS = (await import('../../src/lib/integrations-data/mcp-clients.js')).default.entries;
const {
  setupSnippet, SETUP_SLUGS, SETUP_HEADING, SETUP_LABELS, SETUP_DESKTOP_NOTE, SETUP_OTHER_CLIENTS_LINE,
} = await import('../../src/lib/client-setup.js');

const KEY = 'av_free_0123456789abcdef0123';
const DOCS_URL = 'https://api.algovault.com/mcp?src=docs';
const BARE_URL = 'https://api.algovault.com/mcp';

function desktopServer(snippet: string): Record<string, unknown> {
  const doc = JSON.parse(snippet) as { mcpServers: Record<string, Record<string, unknown>> };
  return doc.mcpServers.algovault;
}

describe('the Claude Desktop snippet is the stdio form', () => {
  it('docs and every key-bearing render are command + args, with no url', () => {
    const renders = [
      SETUP_CONFIG_SNIPPETS['claude-desktop']({ apiKey: 'av_live_&hellip;', trackToken: 'chan-docs' }),
      setupSnippet('claude-desktop', { apiKey: KEY, trackToken: 'chan-email', format: 'text' }),
      setupSnippet('claude-desktop', { apiKey: KEY, trackToken: 'chan-welcome', format: 'text' }),
    ];
    for (const s of renders) {
      const server = desktopServer(s);
      expect(server.command).toBe('npx');
      expect(Array.isArray(server.args)).toBe(true);
      expect(server).not.toHaveProperty('url');
      expect(s).not.toContain('"url"');
    }
  });

  it('the key rides the env, the track token rides a header', () => {
    const server = desktopServer(setupSnippet('claude-desktop', { apiKey: KEY, trackToken: 'chan-email', format: 'text' }));
    expect(server.env).toEqual({ AUTH_HEADER: `Bearer ${KEY}` });
    expect(server.args).toEqual(['-y', 'mcp-remote', BARE_URL, '--header', 'Authorization:${AUTH_HEADER}',
      '--header', 'X-AlgoVault-Track-Token:chan-email']);
  });
});

describe('setup parity with the docs — modulo key, track token and ?src=docs (Q2)', () => {
  it('the docs entries carry the very function the setup surfaces render', () => {
    for (const slug of SETUP_SLUGS) {
      const entry = MCP_CLIENTS.find((e) => e.slug === slug);
      expect(entry?.configSnippet, slug).toBe(SETUP_CONFIG_SNIPPETS[slug]);
    }
  });

  it('every slug renders the registry bytes with only the docs query removed', () => {
    for (const slug of SETUP_SLUGS) {
      const registry = SETUP_CONFIG_SNIPPETS[slug]({ apiKey: KEY, trackToken: 'chan-x' });
      expect(registry, slug).toContain(DOCS_URL);
      const html = setupSnippet(slug, { apiKey: KEY, trackToken: 'chan-x', format: 'html' });
      expect(html, slug).toBe(registry.split(DOCS_URL).join(BARE_URL));
      expect(html, slug).not.toContain('?src=docs');
    }
  });

  it('the docs walkthroughs are the same function with the docs placeholders', () => {
    const desktop = MCP_CLIENTS.find((e) => e.slug === 'claude-desktop');
    expect(JSON.stringify(desktop)).toContain(JSON.stringify(
      SETUP_CONFIG_SNIPPETS['claude-desktop']({ apiKey: 'av_live_&hellip;', trackToken: 'chan-docs' })).slice(1, -1));
  });

  it('html escapes the key once; text decodes the registry entities', () => {
    const odd = 'av_free_<&>"';
    expect(setupSnippet('cursor', { apiKey: odd, trackToken: 't', format: 'html' })).toContain('av_free_&lt;&amp;&gt;&quot;');
    expect(setupSnippet('cursor', { apiKey: odd, trackToken: 't', format: 'text' })).toContain('av_free_<&>"');
    expect(setupSnippet('claude-desktop', { apiKey: '&hellip;', trackToken: 't', format: 'text' })).toContain('Bearer &hellip;');
  });
});

describe('every key-bearing surface renders setupSnippet, never its own copy', () => {
  it('/welcome shows all three clients, each from setupSnippet on chan-welcome', async () => {
    const { getWelcomePageHtml } = await import('../../src/lib/welcome-page.js');
    const html = getWelcomePageHtml(KEY, 'free', 'x@y.com', { newSignupEnabled: true, oauthProviders: {} });
    expect(html).toContain(SETUP_HEADING);
    for (const slug of SETUP_SLUGS) {
      expect(html, slug).toContain(SETUP_LABELS[slug]);
      expect(html, slug).toContain(setupSnippet(slug, { apiKey: KEY, trackToken: 'chan-welcome', format: 'html' }));
    }
    expect(html).toContain(SETUP_DESKTOP_NOTE);
    expect(html).toContain('https://algovault.com/integrations');
  });

  // Q1 = A: the paid welcome + key recovery bodies (`renderEmailHtml` / `renderEmailText`). The
  // free-key email carries no config snippet, only the Authorization line, and is not in scope.
  it('the paid welcome + key recovery emails carry the Desktop snippet + the last line', async () => {
    process.env.RESEND_API_KEY = 'test_key';
    process.env.RESEND_FROM_EMAIL = 'noreply@algovault.com';
    const email = await import('../../src/lib/email.js');
    mockSend.mockReset();
    mockSend.mockResolvedValue({ data: { id: 'id' }, error: null });
    await email.sendWelcomeEmail({ to: 'a@example.com', apiKey: KEY, tier: 'starter' });
    await email.sendKeyRecoveryEmail({ to: 'a@example.com', apiKey: KEY, tier: 'starter' });
    expect(mockSend).toHaveBeenCalledTimes(2);
    for (const [args] of mockSend.mock.calls) {
      expect(args.html).toContain(setupSnippet('claude-desktop', { apiKey: KEY, trackToken: 'chan-email', format: 'html' }));
      expect(args.text).toContain(setupSnippet('claude-desktop', { apiKey: KEY, trackToken: 'chan-email', format: 'text' }));
      expect(args.text).toContain(SETUP_OTHER_CLIENTS_LINE);
      expect(args.text).toContain(SETUP_DESKTOP_NOTE);
      expect(args.text).not.toContain('"url"');
    }
    delete process.env.RESEND_API_KEY;
  });

  it('lifecycle E1 renders setupSnippet with the recipient key on chan-email', async () => {
    const { renderLifecycleEmail } = await import('../../src/lib/lifecycle/render.js');
    const m = renderLifecycleEmail('activation_nudge', {
      keyMasked: 'av_free_…0123', used: 0, total: 200, resetDate: '1 November 2026', periodKey: 'p', apiKey: KEY,
    }, 'https://api.algovault.com/email/unsubscribe/x');
    expect(m.text).toContain(setupSnippet('claude-desktop', { apiKey: KEY, trackToken: 'chan-email', format: 'text' }));
    expect(m.text).toContain(SETUP_OTHER_CLIENTS_LINE);
  });

  it('no surface source carries a hand-written MCP config', () => {
    for (const f of ['src/lib/email.ts', 'src/lib/welcome-page.ts', 'src/lib/lifecycle-copy.ts', 'src/lib/client-setup.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toContain('"mcpServers"');
      expect(src, f).not.toContain('"mcp-remote"');
      expect(src, f).not.toContain('X-AlgoVault-Track-Token:');
    }
  });
});
