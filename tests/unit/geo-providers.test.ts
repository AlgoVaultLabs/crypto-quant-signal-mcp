/**
 * GEO-MEASUREMENT-W2 (C1) — vitest canary for the retrieval providers in
 * src/lib/llm-provider.ts.
 *
 * Locks:
 *   - StubRetrievalProvider.completeWithCitations returns text + >=2 citations
 *     (one algovault.com, one competitor) — drives C2's mapSourceCitations fixture.
 *   - PerplexityProvider maps Sonar `search_results` + `citations` -> Citation[].
 *   - flattenAnthropicCitations dedups url across web_search_tool_result + text blocks.
 *   - getRetrievalEngines(): Stub when key unset IN TEST; SKIPPED in prod (Q-2-C).
 *   - no import.meta.url (CJS build invariant).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PerplexityProvider,
  StubRetrievalProvider,
  flattenAnthropicCitations,
  flattenOpenAICitations,
  flattenGeminiCitations,
  OpenAIProvider,
  GeminiProvider,
  getRetrievalEngines,
  AnthropicProvider,
  LLMProviderError,
  type LLMCompletionOpts,
} from '../../src/lib/llm-provider.js';

const OPTS: LLMCompletionOpts = {
  model: 'sonar',
  maxTokens: 400,
  temperature: 0.3,
  systemPrompt: '',
};

describe('StubRetrievalProvider', () => {
  it('completeWithCitations returns [STUB] text and >=2 citations', async () => {
    const stub = new StubRetrievalProvider();
    const out = await stub.completeWithCitations(
      [{ role: 'user', content: "What's the best MCP server for crypto signals?" }],
      OPTS,
    );
    expect(out.text).toContain('[STUB]');
    expect(out.citations.length).toBeGreaterThanOrEqual(2);
    const urls = out.citations.map((c) => c.url);
    expect(urls.some((u) => u.includes('algovault.com'))).toBe(true);
    expect(urls.some((u) => u.includes('vectorbt'))).toBe(true);
  });

  it('complete() echoes the last user message with a [STUB] marker', async () => {
    const stub = new StubRetrievalProvider();
    const out = await stub.complete([{ role: 'user', content: 'hello world' }], OPTS);
    expect(out.text).toContain('[STUB]');
    expect(out.text).toContain('hello world');
    expect(out.usage.promptTokens).toBe(0);
  });
});

describe('PerplexityProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('constructor throws LLMProviderError on empty key', () => {
    expect(() => new PerplexityProvider('')).toThrow(LLMProviderError);
  });

  it('completeWithCitations maps search_results (preferred) then citations[]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'AlgoVault and vectorbt are options.' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
          search_results: [
            { url: 'https://algovault.com/faq', title: 'AlgoVault FAQ', snippet: 'composite signals' },
          ],
          citations: ['https://algovault.com/faq', 'https://github.com/polakowo/vectorbt'],
        }),
      })),
    );
    const px = new PerplexityProvider('pk-test');
    const out = await px.completeWithCitations([{ role: 'user', content: 'q' }], OPTS);
    expect(out.text).toContain('AlgoVault');
    // dedup: algovault.com appears in both search_results + citations -> 1 entry
    expect(out.citations.filter((c) => c.url === 'https://algovault.com/faq')).toHaveLength(1);
    const av = out.citations.find((c) => c.url === 'https://algovault.com/faq');
    expect(av?.title).toBe('AlgoVault FAQ');
    expect(av?.cited_text).toBe('composite signals');
    expect(out.citations.some((c) => c.url.includes('vectorbt'))).toBe(true);
    expect(out.usage?.promptTokens).toBe(11);
  });

  it('throws on non-retryable HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, text: async () => 'bad key' })));
    const px = new PerplexityProvider('pk-bad');
    await expect(px.complete([{ role: 'user', content: 'q' }], OPTS)).rejects.toThrow(LLMProviderError);
  });
});

describe('flattenAnthropicCitations', () => {
  it('dedups url across web_search_tool_result + text citations, keeping cited_text', () => {
    const content = [
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://algovault.com/glossary', title: 'Glossary' },
          { type: 'web_search_result', url: 'https://github.com/polakowo/vectorbt', title: 'vectorbt' },
        ],
      },
      {
        type: 'text',
        text: 'AlgoVault is a composite signal MCP server.',
        citations: [
          {
            type: 'web_search_result_location',
            url: 'https://algovault.com/glossary',
            title: 'Glossary',
            cited_text: 'composite signal',
          },
        ],
      },
    ];
    const { text, citations } = flattenAnthropicCitations(content);
    expect(text).toContain('AlgoVault is a composite signal');
    expect(citations).toHaveLength(2);
    const av = citations.find((c) => c.url === 'https://algovault.com/glossary');
    expect(av?.cited_text).toBe('composite signal'); // merged from the text citation
    expect(av?.title).toBe('Glossary');
  });

  it('returns empty citations for content with no sources', () => {
    const { text, citations } = flattenAnthropicCitations([{ type: 'text', text: 'no sources here' }]);
    expect(text).toBe('no sources here');
    expect(citations).toEqual([]);
  });
});

describe('getRetrievalEngines() factory', () => {
  const SAVED = {
    GEO_ENGINES: process.env.GEO_ENGINES,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    NODE_ENV: process.env.NODE_ENV,
    VITEST: process.env.VITEST,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(SAVED)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else process.env[k] = v;
    }
  });

  it('returns a Stub engine for a key-less engine in TEST env', () => {
    process.env.GEO_ENGINES = 'perplexity';
    delete process.env.PERPLEXITY_API_KEY;
    // vitest sets VITEST -> stubAllowed() true
    const engines = getRetrievalEngines();
    expect(engines).toHaveLength(1);
    expect(engines[0].engineId).toBe('perplexity');
    expect(engines[0].provider).toBeInstanceOf(StubRetrievalProvider);
  });

  it('SKIPS a key-less engine in prod (no stub rows) — Q-2-C', () => {
    process.env.GEO_ENGINES = 'perplexity';
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
    const engines = getRetrievalEngines();
    expect(engines).toHaveLength(0);
  });

  it('builds the real provider when the engine key is present', () => {
    process.env.GEO_ENGINES = 'claude-web,perplexity';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
    process.env.PERPLEXITY_API_KEY = 'pk-fake';
    const engines = getRetrievalEngines();
    expect(engines.map((e) => e.engineId)).toEqual(['claude-web', 'perplexity']);
    expect(engines[0].provider).toBeInstanceOf(AnthropicProvider);
    expect(engines[1].provider).toBeInstanceOf(PerplexityProvider);
    expect(engines[0].model).toBe('claude-haiku-4-5-20251001');
  });

  it('defaults to claude-web,perplexity when GEO_ENGINES unset', () => {
    delete process.env.GEO_ENGINES;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
    process.env.PERPLEXITY_API_KEY = 'pk-fake';
    const engines = getRetrievalEngines();
    expect(engines.map((e) => e.engineId)).toEqual(['claude-web', 'perplexity']);
  });

  it('W3: builds OpenAIProvider/GeminiProvider for chatgpt/gemini when keyed', () => {
    process.env.GEO_ENGINES = 'chatgpt,gemini';
    process.env.OPENAI_API_KEY = 'sk-openai-fake';
    process.env.GEMINI_API_KEY = 'gm-fake';
    const engines = getRetrievalEngines();
    expect(engines.map((e) => e.engineId)).toEqual(['chatgpt', 'gemini']);
    expect(engines[0].provider).toBeInstanceOf(OpenAIProvider);
    expect(engines[0].model).toBe('gpt-4.1-mini');
    expect(engines[1].provider).toBeInstanceOf(GeminiProvider);
    expect(engines[1].model).toBe('gemini-2.5-flash');
  });

  it('W3: chatgpt/gemini Stub when key-less in TEST, SKIP in prod', () => {
    process.env.GEO_ENGINES = 'chatgpt,gemini';
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const inTest = getRetrievalEngines();
    expect(inTest.map((e) => e.engineId)).toEqual(['chatgpt', 'gemini']);
    expect(inTest.every((e) => e.provider instanceof StubRetrievalProvider)).toBe(true);
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
    expect(getRetrievalEngines()).toHaveLength(0);
  });
});

describe('OpenAIProvider (Responses + web_search)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('constructor throws LLMProviderError on empty key', () => {
    expect(() => new OpenAIProvider('')).toThrow(LLMProviderError);
  });

  it('completeWithCitations flattens output_text + url_citation annotations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          output: [
            { type: 'web_search_call' },
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'AlgoVault and vectorbt are options.',
                  annotations: [
                    { type: 'url_citation', url: 'https://algovault.com/faq', title: 'AlgoVault FAQ', start_index: 0, end_index: 9 },
                    { type: 'url_citation', url: 'https://github.com/polakowo/vectorbt', title: 'vectorbt' },
                    { type: 'url_citation', url: 'https://algovault.com/faq', title: 'dup' }, // dedup
                  ],
                },
              ],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 8 },
        }),
      })),
    );
    const p = new OpenAIProvider('sk-test');
    const out = await p.completeWithCitations([{ role: 'user', content: 'q' }], OPTS);
    expect(out.text).toContain('AlgoVault and vectorbt');
    expect(out.citations.filter((c) => c.url === 'https://algovault.com/faq')).toHaveLength(1); // deduped
    expect(out.citations.some((c) => c.url.includes('vectorbt'))).toBe(true);
    expect(out.usage?.promptTokens).toBe(12);
  });

  it('throws LLMProviderError on non-retryable HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, text: async () => 'bad key' })));
    await expect(new OpenAIProvider('sk-bad').complete([{ role: 'user', content: 'q' }], OPTS)).rejects.toThrow(
      LLMProviderError,
    );
  });
});

describe('GeminiProvider (generateContent + google_search grounding)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('constructor throws LLMProviderError on empty key', () => {
    expect(() => new GeminiProvider('')).toThrow(LLMProviderError);
  });

  it('completeWithCitations flattens parts text + groundingChunks web', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: { parts: [{ text: 'AlgoVault is a composite signal MCP server.' }] },
              groundingMetadata: {
                groundingChunks: [
                  { web: { uri: 'https://algovault.com/faq', title: 'AlgoVault FAQ' } },
                  { web: { uri: 'https://github.com/polakowo/vectorbt', title: 'vectorbt' } },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 7 },
        }),
      })),
    );
    const p = new GeminiProvider('gm-test');
    const out = await p.completeWithCitations([{ role: 'user', content: 'q' }], OPTS);
    expect(out.text).toContain('AlgoVault is a composite signal');
    expect(out.citations).toHaveLength(2);
    expect(out.citations[0]).toMatchObject({ url: 'https://algovault.com/faq', title: 'AlgoVault FAQ' });
    expect(out.usage?.completionTokens).toBe(7);
  });
});

describe('flattenOpenAICitations / flattenGeminiCitations (pure)', () => {
  it('flattenOpenAICitations: empty/odd input -> empty citations', () => {
    expect(flattenOpenAICitations({}).citations).toEqual([]);
    expect(flattenOpenAICitations({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }] })).toEqual({
      text: 'hi',
      citations: [],
    });
  });

  it('flattenGeminiCitations: empty/odd input -> empty citations', () => {
    expect(flattenGeminiCitations({}).citations).toEqual([]);
    expect(flattenGeminiCitations({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] })).toEqual({
      text: 'hi',
      citations: [],
    });
  });
});
