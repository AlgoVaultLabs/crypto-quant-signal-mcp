/**
 * OPS-TOOL-PARAM-TRUTH-W1 CH2 — chat_knowledge can only teach REAL parameter names.
 *
 * Measured on the live /api/chat (2026-10-30): asked which tool lists Binance coins whose 4h regime
 * is TRENDING_UP above 70 confidence, the answer named `scan_market_regimes` and then invented
 * `venue: "binance"` and `confidence_threshold: 70`, because a tool snippet carried only the first
 * 200 characters of its description. A tool snippet now carries that tool's parameter lines,
 * rendered from the bundle's `tools[].parameters` (the in-process tools/list inputSchema).
 *
 * The tools below are read off the REAL in-process tools/list (`listServerTools`, `dist/index.js`),
 * so the AC is judged on the schemas that ship, not on a hand-written fixture. Run `npm run build`
 * first (as every dist-reading suite here assumes).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// chat() reads the live track-record SoT; a rejected read makes the block empty (fail-open), which
// keeps this suite hermetic. capabilities is stubbed as in chat-engine.test.ts.
vi.mock('../../src/resources/signal-performance.js', () => ({
  getSignalPerformance: async () => { throw new Error('hermetic: no track record'); },
}));
vi.mock('../../src/lib/capabilities.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/capabilities.js')>()),
  getAssetCount: async () => 0,
}));

import { KnowledgeIndex } from '../../src/lib/knowledge-index.js';
import { SearchEngine, type SearchResult } from '../../src/lib/search-engine.js';
import { ResultCache } from '../../src/lib/result-cache.js';
import { ChatEngine, CHAT_ENGINE_SYSTEM_PROMPT, CHAT_CONTEXT_FORMAT, toolParameterLines, type ChatResult } from '../../src/lib/chat-engine.js';
import { _resetTrackRecordBlockCache } from '../../src/lib/chat-track-record.js';
import type { LLMProvider, LLMMessage, LLMCompletionOpts, LLMCompletion } from '../../src/lib/llm-provider.js';
import { listServerTools } from '../../scripts/lib/mcp-tools-list.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const E1 = 'Which AlgoVault MCP tool lists every coin on Binance whose 4h market regime is TRENDING_UP with confidence above 70, and what parameters do I pass?';
const MODEL = 'claude-haiku-4-5-20251001';

class CapturingStub implements LLMProvider {
  readonly name = 'stub' as const;
  calls: Array<{ messages: LLMMessage[]; opts: LLMCompletionOpts }> = [];
  async complete(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<LLMCompletion> {
    this.calls.push({ messages, opts });
    return { text: `[stub-answer:${this.calls.length}]`, usage: { promptTokens: 10, completionTokens: 20 } };
  }
}

type Served = { name: string; description: string; inputSchema: Record<string, unknown> };
type Prop = { type?: string; enum?: string[]; items?: { type?: string; enum?: string[] }; default?: unknown; description?: string };

let served: Served[] = [];
const cleanups: Array<() => void> = [];

function bundleWith(tools: Served[], version = '9.9.9') {
  return {
    version, generated_at: '2026-10-30T00:00:00.000Z', package_name: 'crypto-quant-signal-mcp', description: 'fixture', keywords: [], whats_new: '',
    tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
    response_shapes: [], integrations: [], examples: [], discussions: [], pages: [],
    _algovault: { bundle_version: 2, generator: 'build-knowledge-json.mjs', repo: 'AlgoVaultLabs/crypto-quant-signal-mcp' },
  };
}

async function stack(bundle: ReturnType<typeof bundleWith>, opts: { maxInputTokens?: number; cache?: ResultCache<ChatResult> } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'algovault-chat-params-')), 'latest.json');
  writeFileSync(file, JSON.stringify(bundle));
  const index = new KnowledgeIndex(file);
  await index.build();
  cleanups.push(() => index.stopWatching());
  const llm = new CapturingStub();
  const cache = opts.cache ?? new ResultCache<ChatResult>({ ttlMs: 60_000, max: 100 });
  const chat = new ChatEngine(new SearchEngine(index, new ResultCache<SearchResult[]>({ ttlMs: 60_000, max: 100 })), llm, cache, {
    bundle: () => index.getBundle(),
    ...(opts.maxInputTokens ? { maxInputTokens: opts.maxInputTokens } : {}),
  });
  return { chat, llm, index, file };
}

/** The user message's context snippets (each `\n\n`-separated block is ONE snippet). */
function snippets(userMsg: string): string[] {
  const at = userMsg.indexOf('Context snippets:\n');
  return at < 0 ? [] : userMsg.slice(at + 'Context snippets:\n'.length).split('\n\n');
}

beforeAll(async () => {
  served = (await listServerTools(REPO_ROOT)) as Served[];
  _resetTrackRecordBlockCache();
});
afterAll(() => { cleanups.forEach((c) => c()); });

describe('chat context carries the matched tool\'s parameter lines (OPS-TOOL-PARAM-TRUTH-W1 CH2)', () => {
  it('AC: the context for E1 holds scan_market_regimes\'s exchange / timeframe / regime / minConfidence lines, enums verbatim', async () => {
    const { chat, llm } = await stack(bundleWith(served));
    await chat.chat(E1);
    const tool = snippets(llm.calls[0].messages[0].content).find((s) => s.startsWith('[https://api.algovault.com/mcp] scan_market_regimes: '));
    expect(tool, 'scan_market_regimes was not in the E1 context').toBeDefined();
    const props = (served.find((t) => t.name === 'scan_market_regimes')!.inputSchema.properties) as Record<string, Prop>;
    const lines = tool!.split('\n');
    const lineOf = (name: string) => lines.find((l) => l.startsWith(`- ${name} (`));
    expect(lineOf('exchange')).toBe(`- exchange (string, one of ${props.exchange.enum!.join('|')}, default ${props.exchange.default}): ${props.exchange.description}`);
    expect(lineOf('timeframe')).toBe(`- timeframe (string, one of 1h|4h|1d, default 4h): ${props.timeframe.description}`);
    expect(lineOf('regime')).toBe(`- regime (array of string, one of TRENDING_UP|TRENDING_DOWN|RANGING|VOLATILE): ${props.regime.description}`);
    expect(lineOf('minConfidence')).toBe(`- minConfidence (number): ${props.minConfidence.description}`);
    expect(props.exchange.enum).toContain('BINANCE');
    // The whole block, in schema order, one line per parameter.
    expect(lines.slice(lines.indexOf('Parameters:') + 1).map((l) => l.slice(2, l.indexOf(' ('))))
      .toEqual(Object.keys(props));
  });

  it('every served tool renders one line per inputSchema property, required keys marked', () => {
    for (const t of served) {
      const props = Object.keys((t.inputSchema.properties ?? {}) as Record<string, unknown>);
      const lines = toolParameterLines(t.inputSchema);
      expect(lines.map((l) => l.slice(2, l.indexOf(' (')))).toEqual(props);
      for (const req of (t.inputSchema.required ?? []) as string[]) {
        expect(lines.find((l) => l.startsWith(`- ${req} (`)), `${t.name}.${req}`).toMatch(/, required\): /);
      }
    }
    expect(toolParameterLines({})).toEqual([]);
    expect(toolParameterLines({ properties: 'not-an-object' })).toEqual([]);
  });

  it('a parameter block is never cut mid-way: the budget either takes the whole tool snippet or none of it', async () => {
    // BM25 needs ≥ 3 docs; the two fillers share no term with the question, so only the screener matches.
    const filler = (name: string): Served => ({ name, description: 'Unrelated placeholder alpha bravo.', inputSchema: {} });
    const only = [...served.filter((t) => t.name === 'scan_market_regimes'), filler('zz_filler_one'), filler('zz_filler_two')];
    const Q = 'regime screener';
    const probe = await stack(bundleWith(only));
    await probe.chat.chat(Q);
    const all = snippets(probe.llm.calls[0].messages[0].content);
    expect(all).toHaveLength(1);
    const [whole] = all;
    const cost = Math.ceil(whole.length / 4); // the engine's estimator, charged on the rendered snippet
    expect(whole).toContain('\nParameters:\n- exchange (');

    const fits = await stack(bundleWith(only), { maxInputTokens: cost });
    await fits.chat.chat(Q);
    expect(snippets(fits.llm.calls[0].messages[0].content)).toEqual([whole]);

    const short = await stack(bundleWith(only), { maxInputTokens: cost - 1 });
    await short.chat.chat(Q);
    expect(snippets(short.llm.calls[0].messages[0].content)).toEqual([]);
  });

  it('answers are keyed on bundle version + CHAT_CONTEXT_FORMAT: a pre-change cache entry is never served', async () => {
    const cache = new ResultCache<ChatResult>({ ttlMs: 60_000, max: 100 });
    // The entry the pre-change engine would have written for this question (key `model|question`).
    cache.set(`${MODEL}|${E1.trim().toLowerCase()}`, { question: E1, answer: 'STALE venue: "binance"', citations: [], model: MODEL, usage: { promptTokens: 0, completionTokens: 0 } });
    const a = await stack(bundleWith(served, '1.0.0'), { cache });
    expect((await a.chat.chat(E1)).answer).not.toContain('STALE');
    expect(a.llm.calls).toHaveLength(1);
    expect((await a.chat.chat(E1)).answer).toBe('[stub-answer:1]'); // same version → cached
    expect(a.llm.calls).toHaveLength(1);

    const b = await stack(bundleWith(served, '1.0.1'), { cache }); // a new bundle version → a fresh answer
    await b.chat.chat(E1);
    expect(b.llm.calls).toHaveLength(1);
    expect(CHAT_CONTEXT_FORMAT).toBeGreaterThanOrEqual(2);
  });

  it('the production chat stack (getChatStack) is wired to the bundle: its context carries the parameter lines', async () => {
    // A unit test that hands ChatEngine a bundle cannot prove the served stack does. This drives the
    // one factory both chat paths use (MCP chat_knowledge + /api/chat), with the stub LLM.
    const file = join(mkdtempSync(join(tmpdir(), 'algovault-chat-stack-')), 'latest.json');
    writeFileSync(file, JSON.stringify(bundleWith(served)));
    vi.stubEnv('KNOWLEDGE_BUNDLE_PATH', file);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      const { getChatStack } = await import('../../src/tools/knowledge-tools.js');
      const stack = await getChatStack();
      cleanups.push(() => stack.index.stopWatching());
      const spy = vi.spyOn(stack.llm, 'complete');
      await stack.chatEngine.chat(E1);
      const userMsg = (spy.mock.calls[0][0] as LLMMessage[])[0].content;
      expect(userMsg).toContain('[https://api.algovault.com/mcp] scan_market_regimes: ');
      expect(userMsg).toContain('\nParameters:\n- exchange (string, one of ');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the system prompt tells the model to copy parameter names and allowed values exactly', () => {
    expect(CHAT_ENGINE_SYSTEM_PROMPT).toContain(
      "Copy parameter names and allowed values exactly as listed in a tool's parameter lines; never rename or reformat them.",
    );
  });
});
