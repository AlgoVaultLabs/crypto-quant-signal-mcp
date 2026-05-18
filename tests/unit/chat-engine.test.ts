/**
 * AV-CHAT-MCP-W1 (C4) — vitest canary for src/lib/chat-engine.ts.
 *
 * Locks ChatEngine invariants:
 *   - chat() builds context by calling SearchEngine.query(question, N).
 *   - chat() result includes citations[] with source_url + title + excerpt.
 *   - chat() caches per question+model so repeated calls do not re-invoke LLM.
 *   - chat() truncates context when total estimated tokens > maxInputTokens.
 *   - Fix-at-generator LAW: no hand-written if/switch/return shortcut blocks
 *     in chat-engine.ts source (regex canary).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { KnowledgeIndex } from '../../src/lib/knowledge-index.js';
import { SearchEngine, type SearchResult } from '../../src/lib/search-engine.js';
import { ResultCache } from '../../src/lib/result-cache.js';
import { ChatEngine, type ChatResult } from '../../src/lib/chat-engine.js';
import type { LLMProvider, LLMMessage, LLMCompletionOpts, LLMCompletion } from '../../src/lib/llm-provider.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..');

class CountingStub implements LLMProvider {
  readonly name = 'stub' as const;
  calls: Array<{ messages: LLMMessage[]; opts: LLMCompletionOpts }> = [];
  async complete(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<LLMCompletion> {
    this.calls.push({ messages, opts });
    return { text: `[stub-answer:${this.calls.length}]`, usage: { promptTokens: 10, completionTokens: 20 } };
  }
}

const FIXTURE_BUNDLE = {
  version: '1.99.0',
  generated_at: '2026-05-18T00:00:00.000Z',
  package_name: 'crypto-quant-signal-mcp',
  description: 'fixture',
  keywords: ['fixture'],
  whats_new: 'fixture',
  tools: [
    { name: 'get_trade_call', description: 'Composite trade call across exchanges; returns verdict, confidence, regime.', parameters: {} },
    { name: 'scan_funding_arb', description: 'Cross-venue funding arbitrage scanner.', parameters: {} },
  ],
  response_shapes: [],
  integrations: Array.from({ length: 20 }, (_, i) => ({
    framework: `framework_${i}`,
    title: `Integration ${i} for trading agent`,
    content_markdown: `Integration ${i} body with lots of trade trade trade signal signal text. ${'trade signal '.repeat(50)}`,
    url: `https://algovault.com/docs/integrations/framework_${i}`,
  })),
  examples: [],
  discussions: [],
  _algovault: { bundle_version: 1, generator: 'build-knowledge-json.mjs', repo: 'AlgoVaultLabs/crypto-quant-signal-mcp' },
};

async function makeChatStack(): Promise<{
  chat: ChatEngine;
  llm: CountingStub;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'algovault-chat-test-'));
  const file = join(dir, 'latest.json');
  writeFileSync(file, JSON.stringify(FIXTURE_BUNDLE));
  const index = new KnowledgeIndex(file);
  await index.build();
  const searchCache = new ResultCache<SearchResult[]>({ ttlMs: 60_000, max: 100 });
  const search = new SearchEngine(index, searchCache);
  const llm = new CountingStub();
  const chatCache = new ResultCache<ChatResult>({ ttlMs: 60_000, max: 100 });
  const chat = new ChatEngine(search, llm, chatCache);
  return { chat, llm, cleanup: () => index.stopWatching() };
}

describe('ChatEngine (AV-CHAT-MCP-W1 C3)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
  });

  it('builds context from search results — LLM receives snippets in user message', async () => {
    const { chat, llm, cleanup } = await makeChatStack();
    cleanups.push(cleanup);

    await chat.chat('how do I get a trade signal');
    expect(llm.calls).toHaveLength(1);
    const userMsg = llm.calls[0].messages[0].content;
    expect(userMsg).toContain('how do I get a trade signal');
    expect(userMsg).toContain('Context snippets:');
    expect(llm.calls[0].opts.systemPrompt).toContain("AlgoVault's documentation assistant");
    expect(llm.calls[0].opts.systemPromptCacheable).toBe(true);
  });

  it('returns citations with source_url + title + excerpt', async () => {
    const { chat, cleanup } = await makeChatStack();
    cleanups.push(cleanup);

    const r = await chat.chat('trade signal');
    expect(r.citations.length).toBeGreaterThan(0);
    for (const c of r.citations) {
      expect(typeof c.source_url).toBe('string');
      expect(typeof c.title).toBe('string');
      expect(typeof c.excerpt).toBe('string');
    }
  });

  it('caches identical (question, model) pairs — does not re-invoke LLM', async () => {
    const { chat, llm, cleanup } = await makeChatStack();
    cleanups.push(cleanup);

    await chat.chat('what tools are available');
    await chat.chat('what tools are available');
    await chat.chat('What Tools Are Available'); // case-insensitive
    expect(llm.calls).toHaveLength(1);
  });

  it('truncates context when total estimated tokens > maxInputTokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'algovault-chat-trunc-'));
    const file = join(dir, 'latest.json');
    writeFileSync(file, JSON.stringify(FIXTURE_BUNDLE));
    const index = new KnowledgeIndex(file);
    await index.build();
    cleanups.push(() => index.stopWatching());

    const search = new SearchEngine(index, new ResultCache<SearchResult[]>({ ttlMs: 60_000, max: 100 }));
    const llm = new CountingStub();
    const chat = new ChatEngine(search, llm, new ResultCache<ChatResult>({ ttlMs: 60_000, max: 100 }), {
      maxInputTokens: 100,
      maxContextSnippets: 50,
      defaultModel: 'claude-haiku-4-5-20251001',
      maxOutputTokens: 200,
    });

    await chat.chat('trade signal');
    const userMsg = llm.calls[0].messages[0].content;
    // Estimator is ~4 chars/token, so maxInputTokens=100 should cap context ≈ 400 chars
    // (excluding the question prefix). Total length should stay bounded.
    expect(userMsg.length).toBeLessThan(1500);
  });

  it('Fix-at-generator LAW canary — no hand-written question→answer shortcuts in chat-engine.ts source', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'lib', 'chat-engine.ts'), 'utf8');
    expect(src).not.toMatch(/\b(if|switch)\b.*question.*(includes|match).*\breturn\b/);
  });
});
