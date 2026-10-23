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
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// CHAT-LIVE-SOT-INJECTION-W1: chat() now reads the in-process track-record SoT.
// Stub it so this suite stays hermetic (no DB) and the injected figures are
// deterministic — an unmocked read would attempt a real connection and hang.
const getSignalPerformanceMock = vi.fn();
vi.mock('../../src/resources/signal-performance.js', () => ({
  getSignalPerformance: (...args: unknown[]) => getSignalPerformanceMock(...args),
}));
vi.mock('../../src/lib/capabilities.js', () => ({
  EXCHANGE_COUNT: 12,
  EXCHANGES: [
    { id: 'HL', label: 'Hyperliquid' }, { id: 'BINANCE', label: 'Binance' },
    { id: 'BYBIT', label: 'Bybit' }, { id: 'OKX', label: 'OKX' },
    { id: 'BITGET', label: 'Bitget' }, { id: 'ASTER', label: 'Aster' },
    { id: 'BINGX', label: 'BingX' }, { id: 'GATE', label: 'Gate.io' },
    { id: 'HTX', label: 'HTX' }, { id: 'KUCOIN', label: 'KuCoin' },
    { id: 'MEXC', label: 'MEXC' }, { id: 'PHEMEX', label: 'Phemex' },
  ],
  getAssetCount: async () => 1336,
}));

import { KnowledgeIndex } from '../../src/lib/knowledge-index.js';
import { SearchEngine, type SearchResult } from '../../src/lib/search-engine.js';
import { ResultCache } from '../../src/lib/result-cache.js';
import { ChatEngine, CHAT_ENGINE_SYSTEM_PROMPT, type ChatResult } from '../../src/lib/chat-engine.js';
import { _resetTrackRecordBlockCache } from '../../src/lib/chat-track-record.js';
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
  pages: [], // BUNDLE-EXPAND-BLOG-W1 made `pages` a required KnowledgeBundle field
  _algovault: { bundle_version: 2, generator: 'build-knowledge-json.mjs', repo: 'AlgoVaultLabs/crypto-quant-signal-mcp' }, // BUNDLE-EXPAND-BLOG-W1 bumped schema 1 → 2
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
  beforeEach(() => {
    // Module-level TTL cache in chat-track-record.ts — reset so each case
    // observes a fresh read rather than a neighbour's block.
    _resetTrackRecordBlockCache();
    getSignalPerformanceMock.mockReset();
    getSignalPerformanceMock.mockResolvedValue({
      totalCalls: 382434,
      overall: { totalCalls: 382434, totalEvaluated: 380412, pfeWinRate: 0.9153759608003954 },
    });
  });
  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
    _resetTrackRecordBlockCache();
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

  // ── OPS-KNOWLEDGE-BUNDLE-TOOL-PROJECTION-W1 — the model can NAME what it retrieved ──────────
  // A snippet used to be `[url] excerpt`. A tool doc's url is the shared MCP endpoint and no tool
  // description names its own tool, so chat could retrieve the right tool at rank 1 and still be
  // unable to name it without breaking system-prompt rule 1.
  function contextLines(userMsg: string): string[] {
    const at = userMsg.indexOf('Context snippets:\n');
    expect(at, 'no context block in the user message').toBeGreaterThan(-1);
    return userMsg.slice(at + 'Context snippets:\n'.length).split('\n\n');
  }

  it('each context snippet leads with its title — a tool snippet carries the tool NAME', async () => {
    const { chat, llm, cleanup } = await makeChatStack();
    cleanups.push(cleanup);

    await chat.chat('composite trade call verdict confidence');
    const lines = contextLines(llm.calls[0].messages[0].content);
    expect(lines).toContain(
      '[https://api.algovault.com/mcp] get_trade_call: Composite trade call across exchanges; returns verdict, confidence, regime.',
    );
    expect(lines.some((l) => l.startsWith('[https://algovault.com/docs/integrations/framework_') && l.includes(' for trading agent: Integration '))).toBe(true);
  });

  it('a snippet whose excerpt already opens with its title is not prefixed twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'algovault-chat-title-'));
    const file = join(dir, 'latest.json');
    const integration = {
      framework: 'crewai',
      title: 'AlgoVault × CrewAI — Build Verifiable AI Trading Agents',
      content_markdown: '# AlgoVault × CrewAI — Build Verifiable AI Trading Agents\n\nWire the crewai trading agent to AlgoVault.',
      url: 'https://algovault.com/docs/integrations/crewai',
    };
    // BM25 needs ≥ 3 docs; the two fixture tools share no term with the question.
    writeFileSync(file, JSON.stringify({ ...FIXTURE_BUNDLE, integrations: [integration] }));
    const index = new KnowledgeIndex(file);
    await index.build();
    cleanups.push(() => index.stopWatching());
    const llm = new CountingStub();
    const chat = new ChatEngine(new SearchEngine(index, new ResultCache<SearchResult[]>({ ttlMs: 60_000, max: 100 })), llm, new ResultCache<ChatResult>({ ttlMs: 60_000, max: 100 }));

    await chat.chat('crewai trading agent');
    expect(contextLines(llm.calls[0].messages[0].content)).toEqual([
      '[https://algovault.com/docs/integrations/crewai] AlgoVault × CrewAI — Build Verifiable AI Trading Agents Wire the crewai trading agent to AlgoVault.',
    ]);
  });

  it('the context budget is charged for the line the model receives, title included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'algovault-chat-budget-'));
    const file = join(dir, 'latest.json');
    writeFileSync(file, JSON.stringify(FIXTURE_BUNDLE));
    const index = new KnowledgeIndex(file);
    await index.build();
    cleanups.push(() => index.stopWatching());
    const llm = new CountingStub();
    const BUDGET = 130; // fits ONE titled integration line (72 est. tokens) but two untitled ones (64 each)
    const chat = new ChatEngine(new SearchEngine(index, new ResultCache<SearchResult[]>({ ttlMs: 60_000, max: 100 })), llm, new ResultCache<ChatResult>({ ttlMs: 60_000, max: 100 }), {
      maxInputTokens: BUDGET,
      maxContextSnippets: 50,
      defaultModel: 'claude-haiku-4-5-20251001',
      maxOutputTokens: 200,
    });

    const r = await chat.chat('trade signal');
    const lines = contextLines(llm.calls[0].messages[0].content);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBe(r.citations.length);
    const charged = lines.reduce((sum, l) => sum + Math.ceil(l.length / 4), 0);
    expect(charged, `context lines cost ${charged} est. tokens against a ${BUDGET} budget`).toBeLessThanOrEqual(BUDGET);
  });

  it('Fix-at-generator LAW canary — no hand-written question→answer shortcuts in chat-engine.ts source', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'lib', 'chat-engine.ts'), 'utf8');
    expect(src).not.toMatch(/\b(if|switch)\b.*question.*(includes|match).*\breturn\b/);
  });

  // CHAT-LIVE-SOT-INJECTION-W1: the live-track-record builder is part of the
  // chat answer surface, so it inherits the same LAW.
  it('Fix-at-generator LAW canary — no question→answer shortcuts in chat-track-record.ts source', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'lib', 'chat-track-record.ts'), 'utf8');
    expect(src).not.toMatch(/\b(if|switch)\b.*question.*(includes|match).*\breturn\b/);
  });
});

describe('ChatEngine live track-record injection (CHAT-LIVE-SOT-INJECTION-W1)', () => {
  const cleanups: Array<() => void> = [];
  beforeEach(() => {
    _resetTrackRecordBlockCache();
    getSignalPerformanceMock.mockReset();
    getSignalPerformanceMock.mockResolvedValue({
      totalCalls: 382434,
      overall: { totalCalls: 382434, totalEvaluated: 380412, pfeWinRate: 0.9153759608003954 },
    });
  });
  afterEach(() => {
    cleanups.forEach((c) => c());
    cleanups.length = 0;
    _resetTrackRecordBlockCache();
  });

  it('injects the CURRENT TRACK RECORD block ahead of the context snippets', async () => {
    const { chat, llm, cleanup } = await makeChatStack();
    cleanups.push(cleanup);

    await chat.chat('how many signal calls and what win rate');
    const userMsg = llm.calls[0].messages[0].content;

    expect(userMsg).toContain('CURRENT TRACK RECORD');
    // Live figures, not the corpus's baked ones.
    expect(userMsg).toContain('382,434+ signal calls');
    expect(userMsg).toContain('91.5% PFE win rate');
    expect(userMsg).toContain('12 exchanges');

    // Ordering is load-bearing: the authoritative block must precede both the
    // question and the snippets it overrides.
    const blockAt = userMsg.indexOf('CURRENT TRACK RECORD');
    const questionAt = userMsg.indexOf('how many signal calls');
    const snippetsAt = userMsg.indexOf('Context snippets:');
    expect(blockAt).toBeGreaterThanOrEqual(0);
    expect(snippetsAt).toBeGreaterThan(-1);
    expect(blockAt).toBeLessThan(questionAt);
    expect(questionAt).toBeLessThan(snippetsAt);
  });

  it('still injects the block when there are no context snippets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'algovault-chat-nosnip-'));
    const file = join(dir, 'latest.json');
    writeFileSync(file, JSON.stringify({ ...FIXTURE_BUNDLE, tools: [], integrations: [] }));
    const index = new KnowledgeIndex(file);
    await index.build();
    cleanups.push(() => index.stopWatching());

    const search = new SearchEngine(index, new ResultCache<SearchResult[]>({ ttlMs: 60_000, max: 100 }));
    const llm = new CountingStub();
    const chat = new ChatEngine(search, llm, new ResultCache<ChatResult>({ ttlMs: 60_000, max: 100 }));

    await chat.chat('zzzz no match qqqq');
    expect(llm.calls[0].messages[0].content).toContain('CURRENT TRACK RECORD');
  });

  it('a chat answer is never blocked or blanked by track-record trouble', async () => {
    getSignalPerformanceMock.mockRejectedValue(new Error('db down'));
    const { chat, llm, cleanup } = await makeChatStack();
    cleanups.push(cleanup);

    const r = await chat.chat('what tools are available');
    expect(r.answer).toBe('[stub-answer:1]');
    // Fails open to the labelled static floor rather than an empty preamble.
    expect(llm.calls[0].messages[0].content).toContain('[STATIC] CURRENT TRACK RECORD');
  });

  it('system prompt carries the override rule and no baked exchange count', () => {
    expect(CHAT_ENGINE_SYSTEM_PROMPT).toContain('CURRENT TRACK RECORD');
    expect(CHAT_ENGINE_SYSTEM_PROMPT).toContain('authoritative and live');
    expect(CHAT_ENGINE_SYSTEM_PROMPT).toContain('ignore the snippet');
    // The stale hardcoded count is gone — and no digit-count of exchanges
    // may reappear in its place (forward stability).
    expect(CHAT_ENGINE_SYSTEM_PROMPT).not.toContain('5 exchanges');
    expect(CHAT_ENGINE_SYSTEM_PROMPT).not.toMatch(/\b\d+\s+exchanges\b/);
    expect(CHAT_ENGINE_SYSTEM_PROMPT).toContain('major crypto exchanges');
  });

  // The first post-deploy live gate returned STALE_FAIL: the model obeyed the
  // override but volunteered the retired figures in a contrastive clause
  // ("...supersede the older 56,375+ at 89.4%"), re-emitting the exact
  // literals this wave retires onto a public endpoint. Rule 7 now suppresses
  // that; lock it so the behaviour can't silently regress.
  it('system prompt forbids restating or contrasting superseded figures', () => {
    expect(CHAT_ENGINE_SYSTEM_PROMPT).toContain('Never restate, quote, or contrast');
    expect(CHAT_ENGINE_SYSTEM_PROMPT).toContain('authoritative figures alone');
  });
});
