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
import { freeCallsLabel, freeDailyCallsLabel } from '../../src/lib/plans.js';

describe('MCP_USAGE_HTML — structural invariants', () => {
  it('contains the #connect-mcp anchor (deep-link target from welcome email + signup page)', () => {
    expect(MCP_USAGE_HTML).toContain('id="connect-mcp"');
  });

  it('has the "Connect Your MCP Client" section heading', () => {
    // The doc was restructured under a top-level "Integration" <h2> with
    // three <h3> subsections (MCP Client / AI Agent / Exchange Kit); the
    // MCP-client walkthrough heading is now an <h3> carrying id="connect-mcp".
    expect(MCP_USAGE_HTML).toMatch(/<h[23][^>]*>[\s\S]*Connect Your MCP Client[\s\S]*<\/h[23]>/);
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

  it('has at least one <details> walkthrough per client surface (≥6)', () => {
    // Shape-not-frozen-count (Build Rule 5): the doc grew from the original 6
    // MCP-client walkthroughs to also cover AI-agent + exchange-kit surfaces
    // (17 <details> at time of writing). The 6 enumerated client surfaces
    // above remain the floor — assert ≥6 rather than an exact count that
    // drifts every time a surface/walkthrough is added.
    const matches = MCP_USAGE_HTML.match(/<details[^>]*>/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(6);
  });

  it('the Plain-HTTP block points at the existing 3-step handshake guide (no broken raw-curl repeat)', () => {
    // Per OUTPUT-SANITIZE-W1 fix-forward: don't ship a raw `tools/call` curl
    // without the initialize → notifications/initialized → tools/call dance
    // OR a clear pointer to the existing #testing-with-curl section.
    expect(MCP_USAGE_HTML).toMatch(/href="#testing-with-curl"/);
  });

  it('mentions free-tier unlock copy (all coins + all timeframes, the two allowance caps)', () => {
    expect(MCP_USAGE_HTML).toMatch(/every coin.*every timeframe|all 11 timeframes|every supported/i);
    // Derived from the plan SoT, not a literal: R-B moved the free cap 100 -> 200 and added a
    // second daily meter, and a hardcoded expectation here is what makes the next move a chore.
    expect(MCP_USAGE_HTML).toContain(`capped at ${freeCallsLabel()} calls/month`);
    expect(MCP_USAGE_HTML).toContain(`${freeDailyCallsLabel()} calls per UTC day`);
  });
});

describe('MCP_USAGE_HTML — channel-attribution track token (OPS-TRACK-TOKEN-STDIO-CLIENT-WRAPPER-W1)', () => {
  it('embeds the no-space mcp-remote args form X-AlgoVault-Track-Token:chan-docs', () => {
    // No space after the colon — dodges the Claude-Desktop/Cursor Windows
    // npx arg-mangling bug (geelen/mcp-remote README).
    expect(MCP_USAGE_HTML).toContain('"--header", "X-AlgoVault-Track-Token:chan-docs"');
  });

  it('embeds the headers-object JSON form "X-AlgoVault-Track-Token": "chan-docs"', () => {
    expect(MCP_USAGE_HTML).toContain('"X-AlgoVault-Track-Token": "chan-docs"');
  });

  it('uses a chan-docs slug that satisfies the C6 reader TOKEN_RE (8–64) so it actually records', () => {
    // Guards the R0 finding: a slug < 8 chars (e.g. the original "docs") is
    // SILENTLY rejected by extractHeaderTrackToken → zero attribution.
    expect('chan-docs').toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it('rewrites the free-tier prose to keep the tracking header (auth dropped, tracking kept)', () => {
    expect(MCP_USAGE_HTML).not.toContain('drop the <code class="text-xs">--header</code> args entirely');
    expect(MCP_USAGE_HTML).toContain('keep the <code class="text-xs">X-AlgoVault-Track-Token</code> header');
  });
});
