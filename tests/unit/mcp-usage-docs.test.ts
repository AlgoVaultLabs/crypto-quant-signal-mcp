/**
 * Unit tests for v1.10.3 MCP_USAGE_HTML constant.
 *
 * Asserts:
 *   - Section anchor `id="connect-mcp"` is present (deep-link target)
 *   - All 6 client surfaces appear (table rows + <details> blocks)
 *   - Per-client config snippets contain the verified URL/path/header markers
 *   - No raw-curl example without 3-step-handshake reference (per the
 *     OUTPUT-SANITIZE-W1 follow-up rule about not shipping broken quickstart copy)
 *   - Verification footnote cites the 5 official-doc URLs
 */
import { describe, it, expect } from 'vitest';
import { MCP_USAGE_HTML } from '../../src/lib/mcp-usage-docs.js';

describe('MCP_USAGE_HTML — structural invariants', () => {
  it('contains the #connect-mcp anchor (deep-link target from welcome email + signup page)', () => {
    expect(MCP_USAGE_HTML).toContain('id="connect-mcp"');
  });

  it('opens with the right H2 heading', () => {
    expect(MCP_USAGE_HTML).toMatch(/<h2[^>]*>[\s\S]*Connect Your MCP Client[\s\S]*<\/h2>/);
  });

  it.each([
    ['Claude Desktop',     /claude_desktop_config\.json/],
    ['Cursor',             /\.cursor\/mcp\.json/],
    ['Cline',              /cline_mcp_settings\.json|streamableHttp/],
    ['Claude Code',        /claude mcp add/],
    ['Smithery',           /@smithery\/cli install/],
    ['Plain HTTP',         /api\.algovault\.com\/mcp/],
  ])('mentions %s with verified config marker', (name, configPattern) => {
    expect(MCP_USAGE_HTML).toContain(name);
    expect(MCP_USAGE_HTML).toMatch(configPattern);
  });

  it('uses streamableHttp (the recommended modern transport for Cline)', () => {
    expect(MCP_USAGE_HTML).toContain('streamableHttp');
  });

  it('cites all 5 verified upstream doc URLs in the footnote', () => {
    expect(MCP_USAGE_HTML).toContain('modelcontextprotocol.io/quickstart/user');
    expect(MCP_USAGE_HTML).toContain('cursor.com/docs/context/mcp');
    expect(MCP_USAGE_HTML).toContain('docs.cline.bot/mcp');
    expect(MCP_USAGE_HTML).toContain('code.claude.com/docs/en/mcp');
    expect(MCP_USAGE_HTML).toContain('@smithery/cli');
  });

  it('cites the verification fetch date so future drift is auditable', () => {
    expect(MCP_USAGE_HTML).toMatch(/verified \d{4}-\d{2}-\d{2}/i);
  });

  it('has 6 <details> blocks (one walkthrough per client surface)', () => {
    const matches = MCP_USAGE_HTML.match(/<details[^>]*>/g) ?? [];
    expect(matches.length).toBe(6);
  });

  it('the Plain-HTTP block points at the existing 3-step handshake guide (no broken raw-curl repeat)', () => {
    // Per OUTPUT-SANITIZE-W1 fix-forward: don't ship a raw `tools/call` curl
    // without the initialize → notifications/initialized → tools/call dance
    // OR a clear pointer to the existing #testing-with-curl section.
    expect(MCP_USAGE_HTML).toMatch(/href="#testing-with-curl"/);
  });

  it('mentions free-tier unlock copy (all coins + all timeframes, 100/mo cap)', () => {
    expect(MCP_USAGE_HTML).toMatch(/every coin.*every timeframe|all 11 timeframes|every supported/i);
    expect(MCP_USAGE_HTML).toMatch(/100 calls\/month|capped at 100/i);
  });
});
