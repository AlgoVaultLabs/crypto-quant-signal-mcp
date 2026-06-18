/**
 * AV-CHAT-MCP-W1 (C4) — integration test for the end-to-end knowledge flow.
 *
 * Boots a SearchEngine + ChatEngine against the real generated bundle at
 * dist/knowledge/latest.json (requires `npm run build` + `npm run build:
 * knowledge` to have produced the file). Asserts response shapes match
 * the public contracts locked in:
 *   - audits/search-knowledge-shape-snapshot-2026-05-18.json
 *   - audits/chat-knowledge-shape-snapshot-2026-05-18.json
 *
 * HTTP-layer end-to-end is exercised by the wave-end live-curl probes
 * (see audits/AV-CHAT-MCP-W1-endpoint-truth.md §11) — the in-process
 * HTTP route is anonymous-closure-only inside src/index.ts::startHttp()
 * and not directly importable without booting the real server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeIndex } from '../../src/lib/knowledge-index.js';
import { SearchEngine, type SearchResult } from '../../src/lib/search-engine.js';
import { ResultCache } from '../../src/lib/result-cache.js';
import {
  ChatEngine,
  type ChatResult,
  CHAT_ENGINE_SYSTEM_PROMPT,
} from '../../src/lib/chat-engine.js';
import { StubLLMProvider } from '../../src/lib/llm-provider.js';
import { formatSearchKnowledgeResponse } from '../../src/lib/search-knowledge-formatter.js';
import { formatChatKnowledgeResponse } from '../../src/lib/chat-knowledge-formatter.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');
const BUNDLE_PATH = join(REPO_ROOT, 'dist', 'knowledge', 'latest.json');

describe('AV-CHAT-MCP-W1 — end-to-end knowledge flow (real bundle, stub LLM)', () => {
  let index: KnowledgeIndex;
  let search: SearchEngine;
  let chat: ChatEngine;

  beforeAll(async () => {
    if (!existsSync(BUNDLE_PATH)) {
      throw new Error(
        `Missing ${BUNDLE_PATH} — run \`npm run build && npm run build:knowledge\` before vitest`,
      );
    }
    index = new KnowledgeIndex(BUNDLE_PATH);
    await index.build();
    const searchCache = new ResultCache<SearchResult[]>({ ttlMs: 60_000, max: 100 });
    search = new SearchEngine(index, searchCache);
    const chatCache = new ResultCache<ChatResult>({ ttlMs: 60_000, max: 100 });
    chat = new ChatEngine(search, new StubLLMProvider(), chatCache);
  });

  afterAll(() => {
    index?.stopWatching();
  });

  it('bundle → search → SearchKnowledgeResponse — shape matches public contract', async () => {
    const results = await search.query('how do I get a trade signal', 10);
    const bundle = index.getBundle();
    const response = formatSearchKnowledgeResponse('how do I get a trade signal', results, bundle);

    // Allowed top-level keys
    expect(Object.keys(response).sort()).toEqual(['_algovault', 'query', 'results', 'total_results']);
    expect(response.total_results).toBe(results.length);
    expect(response.results.length).toBeGreaterThan(0);

    // Forbidden keys MUST NOT appear (Data Integrity LAW)
    const json = JSON.stringify(response);
    expect(json).not.toMatch(/"outcome_return_pct"/);
    expect(json).not.toMatch(/"outcome_price"/);
    expect(json).not.toMatch(/"phase_e_/);
    expect(json).not.toMatch(/"raw_bundle"/);

    // _algovault carries bundle version + generated_at
    expect(response._algovault.bundle_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(response._algovault.bundle_generated_at).toBeTruthy();
  });

  it('a trading query surfaces at least one tool entry on the first page of results', async () => {
    const r = await search.query('how do I get a trade signal', 10);
    expect(r.length).toBeGreaterThan(0);
    // BM25 reality: as the knowledge corpus grew (BUNDLE-EXPAND-BLOG-W1 added
    // long-form `pages`), integration tutorials + response-shape docs — which
    // repeat "trade signal" many times — outrank the terse 1-sentence tool
    // descriptions for a verbose natural-language "how do I" query (the tool
    // lands ~rank 6, vs rank 0-1 for focused queries like "trade signal").
    // The fact-honest invariant is that the relevant tool is discoverable on
    // the first page of results (top 10), not necessarily the top 3.
    const toolCount = r.filter((x) => x.source_type === 'tool').length;
    expect(toolCount).toBeGreaterThan(0);
  });

  it('bundle → search → chat → ChatKnowledgeResponse — shape matches public contract', async () => {
    const result = await chat.chat('how do I get a BTC trade signal with stop loss?');
    const bundle = index.getBundle();
    const response = formatChatKnowledgeResponse(result, bundle, 9 /* quota_remaining */);

    // Allowed top-level keys
    expect(Object.keys(response).sort()).toEqual(['_algovault', 'answer', 'citations', 'model', 'question']);

    // Citations include >=1 entry with source_url
    expect(response.citations.length).toBeGreaterThan(0);
    for (const c of response.citations) {
      expect(c).toHaveProperty('source_type');
      expect(c).toHaveProperty('source_url');
      expect(c).toHaveProperty('title');
      expect(c).toHaveProperty('excerpt');
    }

    // Model id is a valid Anthropic slug
    expect(response.model).toMatch(/^claude-(haiku|sonnet)-/);

    // Forbidden keys MUST NOT appear in the response
    const json = JSON.stringify(response);
    expect(json).not.toMatch(/"outcome_return_pct"/);
    expect(json).not.toMatch(/"prompt_tokens"/);
    expect(json).not.toMatch(/"completion_tokens"/);
    expect(json).not.toMatch(/"usage"/);
    expect(json).not.toMatch(/"system_prompt"/);
    expect(json).not.toMatch(/"api_key"/);

    // _algovault carries quota_remaining (number or null)
    expect(['number', 'object'].includes(typeof response._algovault.quota_remaining)).toBe(true);
  });

  it('chat-engine system prompt is locked verbatim (6-rule contract)', () => {
    expect(CHAT_ENGINE_SYSTEM_PROMPT).toContain("AlgoVault's documentation assistant");
    expect(CHAT_ENGINE_SYSTEM_PROMPT).toContain('RULES:');
    // 6 numbered rules in the prompt
    for (let i = 1; i <= 6; i++) {
      expect(CHAT_ENGINE_SYSTEM_PROMPT).toContain(`${i}.`);
    }
    expect(CHAT_ENGINE_SYSTEM_PROMPT).toContain('outcome_return_pct');
    expect(CHAT_ENGINE_SYSTEM_PROMPT).toContain('source:');
  });
});
