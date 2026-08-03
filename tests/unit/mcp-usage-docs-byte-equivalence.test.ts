/**
 * Byte-equivalence canary for the INTEGRATIONS-FULL-STACK-W1 C1 refactor.
 *
 * The pre-refactor MCP_USAGE_HTML inline string is captured at
 * tests/fixtures/mcp-usage-html-pre-refactor.txt. The refactored
 * `renderIntegrationH2({mcpClients, aiAgents, exchangeKits: null})` MUST
 * produce HTML that — after whitespace normalization — byte-matches the
 * fixture. This catches accidental content drift during the data-layer
 * extraction.
 *
 * Normalization: collapse any run of whitespace (spaces, tabs, newlines)
 * to a single space; trim leading/trailing. Order of tags, attributes,
 * and text content is preserved.
 *
 * FIXTURE MAINTENANCE — OPS-TRACK-TOKEN-STDIO-CLIENT-WRAPPER-W1 (2026-05-29):
 * the fixture was deliberately regenerated to absorb the additive
 * `X-AlgoVault-Track-Token:chan-docs` headers embedded in the MCP-client
 * snippets (architect-approved public-copy edit). The canary still guards
 * against *accidental* drift from this new baseline; any future intentional
 * snippet edit must regenerate the fixture in the same commit.
 *
 * FIXTURE MAINTENANCE — OPS-AUDIT-REMEDIATION-LOW-W2 (2026-08-02, SEC-44): regenerated to
 * absorb the removal of a hardcoded capability count ("its 3 tools" -> "its tools"). The
 * count was stale — live tools/list returns 7 — and several tools are conditionally exposed,
 * so a number would rot again on the next flag flip. Verified before regenerating that the
 * word-level diff against the old fixture was EXACTLY that edit and nothing else.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import MCP_CLIENTS from '../../src/lib/integrations-data/mcp-clients.js';
import AI_AGENTS from '../../src/lib/integrations-data/ai-agents.js';
import { renderIntegrationH2, normalizeHtml } from '../../src/lib/integrations-data/render.js';
import { MCP_USAGE_HTML } from '../../src/lib/mcp-usage-docs.js';

const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'mcp-usage-html-pre-refactor.txt');

/**
 * Byte-equivalence asserts the refactored renderer, when called with
 * exchangeKits:null (the C1 contract), produces output byte-matching the
 * pre-refactor inline HTML. The fixture is permanent; this test catches
 * accidental content drift in any future edit to the data files or
 * renderer.
 *
 * MCP_USAGE_HTML (the actual export consumed by build_landing.mjs) is
 * exercised separately — at C1 it equals the renderer output with
 * exchangeKits:null; from C2 onward it adds the exchangeKits H3 too.
 */
describe('mcp-usage-docs byte-equivalence (C1 refactor contract)', () => {
  const renderedWithoutExchangeKits = renderIntegrationH2({
    mcpClients: MCP_CLIENTS,
    aiAgents: AI_AGENTS,
    exchangeKits: null,
  });

  it('renderer output (exchangeKits:null) normalizes to match pre-refactor fixture', () => {
    const fixture = readFileSync(FIXTURE_PATH, 'utf8');
    expect(normalizeHtml(renderedWithoutExchangeKits)).toBe(normalizeHtml(fixture));
  });

  it('renderer output preserves outer #integration + first two H3 anchors', () => {
    expect(renderedWithoutExchangeKits).toContain('id="integration"');
    expect(renderedWithoutExchangeKits).toContain('id="connect-mcp"');
    expect(renderedWithoutExchangeKits).toContain('id="connect-ai-agent"');
  });

  it('exchangeKits:null path does NOT introduce a 3rd H3 anchor', () => {
    expect(renderedWithoutExchangeKits).not.toContain('id="connect-exchange-kit"');
    expect(renderedWithoutExchangeKits).not.toContain('Connect Your Exchange Kit');
  });

  it('preserves the 6 MCP-client table rows (5 dedicated + Plain HTTP)', () => {
    expect(renderedWithoutExchangeKits).toContain('Claude Desktop');
    expect(renderedWithoutExchangeKits).toContain('Cursor');
    expect(renderedWithoutExchangeKits).toContain('Cline (VSCode)');
    expect(renderedWithoutExchangeKits).toContain('Claude Code');
    expect(renderedWithoutExchangeKits).toContain('Smithery');
    expect(renderedWithoutExchangeKits).toContain('Plain HTTP / curl');
  });

  it('preserves the 4 AI-agent framework table rows', () => {
    expect(renderedWithoutExchangeKits).toContain('LangChain');
    expect(renderedWithoutExchangeKits).toContain('LlamaIndex');
    expect(renderedWithoutExchangeKits).toContain('Microsoft Agent Framework');
    expect(renderedWithoutExchangeKits).toContain('CrewAI');
  });

  it('preserves all 4 NEW /integrations/<framework> tutorial links', () => {
    expect(renderedWithoutExchangeKits).toContain('/integrations/langchain');
    expect(renderedWithoutExchangeKits).toContain('/integrations/llamaindex');
    expect(renderedWithoutExchangeKits).toContain('/integrations/maf');
    expect(renderedWithoutExchangeKits).toContain('/integrations/crewai');
  });

  it('does NOT leak the deprecated /docs/integrations/<slug> path', () => {
    expect(renderedWithoutExchangeKits).not.toMatch(
      /\/docs\/integrations\/(binance|okx|bybit|bitget|langchain|llamaindex|maf|crewai)/,
    );
  });
});

describe('MCP_USAGE_HTML (live export, post-C2)', () => {
  it('contains all 3 H3 anchors (Exchange Kit added in C2)', () => {
    expect(MCP_USAGE_HTML).toContain('id="integration"');
    expect(MCP_USAGE_HTML).toContain('id="connect-mcp"');
    expect(MCP_USAGE_HTML).toContain('id="connect-ai-agent"');
    expect(MCP_USAGE_HTML).toContain('id="connect-exchange-kit"');
  });

  it('contains 7 exchange-kit display names in the new H3 block', () => {
    expect(MCP_USAGE_HTML).toContain('Binance');
    expect(MCP_USAGE_HTML).toContain('OKX');
    expect(MCP_USAGE_HTML).toContain('Bybit');
    expect(MCP_USAGE_HTML).toContain('Bitget');
    // +3 crypto agentic-trading kits
    expect(MCP_USAGE_HTML).toContain('Gemini');
    expect(MCP_USAGE_HTML).toContain('Kraken');
    expect(MCP_USAGE_HTML).toContain('Alpaca');
  });

  it('H2 intro mentions exchange kits (3-path framing)', () => {
    expect(MCP_USAGE_HTML).toContain('exchange Agent Trade Kit');
  });
});
