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
 *
 * FIXTURE MAINTENANCE — LANDING-MCP-CLIENT-REGISTRY-W1 (2026-08-05): regenerated to absorb
 * 5 net-new mcp-clients rows (codex, kimi, glm-zcode, zai-api, deepseek). renderSurfaceSection()
 * renders EVERY entry, so this fixture gates the whole surface, not just the original six —
 * left frozen it would have blocked every future client, which is default-deny-forever.
 * Reviewed line-by-line before regenerating; the diff REMOVES exactly 3 lines and every one
 * is a consequence of the change rather than content loss:
 *   1. `<tr>` -> `<tr class="border-b border-white/10">` — renderTableRow() omits the border on
 *      the LAST row; plain-http was last, deepseek is now. Same markup, new position.
 *   2. footer preamble "verified 2026-04-30" -> "verified per client". Each row now carries its
 *      own `verifiedAt`, so one surface-wide date became a false claim the moment a single row
 *      was re-checked (5 were, on 2026-08-05).
 *   3. the @smithery/cli footer link's trailing "." -> " &middot;" — it is no longer the last
 *      link in the list. Positional only.
 * Every other line of the original six rows is present verbatim in the new fixture (verified by
 * exhaustive old-line containment, not by eyeballing the diff).
 *
 * FIXTURE MAINTENANCE — PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 (CH7, 2026-08-09): regenerated
 * to absorb the R-B free-tier allowance change in `mcp-clients.ts` `intro`:
 *   "capped at 100 calls/month." -> "capped at 200 calls/month, and at 100 calls per UTC day."
 * The word-level diff against the old fixture was EXACTLY that one sentence — 4 words added
 * before the count and 4 after it, zero other lines touched — verified before regenerating
 * rather than after. The second clause is not decoration: R-B added a SECOND meter, and copy
 * naming only the monthly one would understate the wall a free caller actually hits first.
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

  it('preserves the original 6 MCP-client table rows', () => {
    expect(renderedWithoutExchangeKits).toContain('Claude Desktop');
    expect(renderedWithoutExchangeKits).toContain('Cursor');
    expect(renderedWithoutExchangeKits).toContain('Cline (VSCode)');
    expect(renderedWithoutExchangeKits).toContain('Claude Code');
    expect(renderedWithoutExchangeKits).toContain('Smithery');
    expect(renderedWithoutExchangeKits).toContain('Plain HTTP / curl');
  });

  it('renders the 5 MCP-client rows added 2026-08-05', () => {
    expect(renderedWithoutExchangeKits).toContain('Codex');
    expect(renderedWithoutExchangeKits).toContain('Kimi Code');
    expect(renderedWithoutExchangeKits).toContain('ZCode (GLM)');
    expect(renderedWithoutExchangeKits).toContain('Z.ai API');
    expect(renderedWithoutExchangeKits).toContain('DeepSeek');
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
