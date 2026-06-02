/**
 * LLM provider abstraction — AV-CHAT-MCP-W1 (C3).
 *
 * Wraps `@anthropic-ai/sdk@^0.96`. Surface designed so future providers
 * (`OpenAIProvider`, `GeminiProvider`) can implement the same interface
 * without ChatEngine churn.
 *
 * The locked verbatim system prompt is identical across every chat call so
 * Anthropic prompt caching is a no-brainer: pass `systemPromptCacheable=true`
 * and the SDK emits a `cache_control: { type: 'ephemeral' }` breakpoint on
 * the system block. With Haiku 4.5 the savings are ~$0.65/mo at expected
 * utilization; with Sonnet 4.6 they're ~$5+/mo.
 *
 * If `ANTHROPIC_API_KEY` is unset, the factory returns `StubLLMProvider`
 * (canned response with the question echoed back). Server still boots; chat
 * tool returns a recognizable `[STUB] ...` payload with citations intact.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMCompletionOpts {
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt: string;
  systemPromptCacheable?: boolean;
}

export interface LLMCompletion {
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    cachedPromptTokens?: number;
  };
}

// GEO-MEASUREMENT-W2 (C1) — retrieval-engine citation surface.
// A `Citation` is one web source the engine grounded its answer on. Unified
// across engines: Anthropic `web_search_tool_result` blocks, Perplexity
// `search_results`/`citations`, and (W3/W4) ChatGPT-search / Gemini-grounding
// all flatten into this one shape — so the extractor + source-citation map +
// gap-list never learn engine-specific payloads.
export interface Citation {
  url: string;
  title?: string;
  cited_text?: string;
}

// Text + the sources it cited. Parallels `LLMCompletion` ({text,usage}); adds
// `citations`. `usage` optional so cost still flows to geo_query_runs.
export interface RetrievalResult {
  text: string;
  citations: Citation[];
  usage?: LLMCompletion['usage'];
}

// Provider name union — extended for forward-compat per CHAT-USAGE-ANALYTICS-W1
// Q-4 Path B (Cowork-ratified). LLM-PROVIDER-A/B-W1 will add concrete classes
// for 'openai' / 'gemini'; the union widens here so analytics + dashboards
// can reference all 4 from day one with zero migration coordination.
// GEO-MEASUREMENT-W2 (C1) widens with 'perplexity' for PerplexityProvider.
export type LLMProviderName = 'anthropic' | 'stub' | 'openai' | 'gemini' | 'perplexity';

export interface LLMProvider {
  readonly name: LLMProviderName;
  complete(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<LLMCompletion>;
  /**
   * GEO-MEASUREMENT-W2 — citation-aware completion. Optional: only retrieval
   * engines (Claude web_search, Perplexity Sonar) implement it; plain chat
   * providers leave it undefined. Returns text + the flattened source map.
   */
  completeWithCitations?(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<RetrievalResult>;
}

export class LLMProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'LLMProviderError';
  }
}

const RETRY_DELAYS_MS = [500, 1500]; // 2 retries with exponential backoff

// GEO-MEASUREMENT-W2 (C1) — web_search server-tool config.
// `web_search_20250305` is the stable GA tool-type (confirmed live in
// @anthropic-ai/sdk@0.96.0 resources/messages/messages.d.ts; the newer
// `web_search_20260209` also exists — pin GA for stability). max_uses caps
// searches/answer to bound the $10/1K-searches cost.
const WEB_SEARCH_TOOL_TYPE = 'web_search_20250305' as const;
const WEB_SEARCH_MAX_USES = 5;

interface AnthropicCitationLike {
  url?: unknown;
  title?: unknown;
  cited_text?: unknown;
}

/**
 * GEO-MEASUREMENT-W2 (C1) — flatten an Anthropic Messages `content` array
 * (text + web_search_tool_result blocks) into joined answer text + a deduped
 * `Citation[]`. Pulls URLs from BOTH `web_search_tool_result` result items AND
 * inline text-block citations (which additionally carry `cited_text`).
 * Exported pure fn — unit-testable with a synthetic content array, no live API.
 */
export function flattenAnthropicCitations(content: readonly unknown[]): {
  text: string;
  citations: Citation[];
} {
  const texts: string[] = [];
  const byUrl = new Map<string, Citation>();
  const add = (c: AnthropicCitationLike): void => {
    if (!c || typeof c.url !== 'string' || c.url.length === 0) return;
    const existing = byUrl.get(c.url) ?? { url: c.url };
    if (typeof c.title === 'string' && c.title) existing.title = c.title;
    if (typeof c.cited_text === 'string' && c.cited_text) existing.cited_text = c.cited_text;
    byUrl.set(c.url, existing);
  };

  for (const raw of content) {
    const block = raw as { type?: string; text?: unknown; citations?: unknown; content?: unknown };
    if (block.type === 'text') {
      if (typeof block.text === 'string') texts.push(block.text);
      if (Array.isArray(block.citations)) for (const c of block.citations) add(c as AnthropicCitationLike);
    } else if (block.type === 'web_search_tool_result') {
      if (Array.isArray(block.content)) for (const r of block.content) add(r as AnthropicCitationLike);
    }
  }

  return { text: texts.join('').trim(), citations: [...byUrl.values()] };
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new LLMProviderError(
        'MISSING_ANTHROPIC_API_KEY',
        'AnthropicProvider requires a non-empty apiKey',
      );
    }
    this.client = new Anthropic({ apiKey });
  }

  async complete(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<LLMCompletion> {
    const system = opts.systemPromptCacheable
      ? [{ type: 'text' as const, text: opts.systemPrompt, cache_control: { type: 'ephemeral' as const } }]
      : opts.systemPrompt;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: opts.model,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
          system,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });
        const textBlock = response.content.find((b) => b.type === 'text');
        const text = textBlock && textBlock.type === 'text' ? textBlock.text : '';
        return {
          text,
          usage: {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            cachedPromptTokens: response.usage.cache_read_input_tokens ?? undefined,
          },
        };
      } catch (err: unknown) {
        lastErr = err;
        // Retry on 429 (rate limit), 500, 503; otherwise propagate
        const status = (err as { status?: number })?.status;
        const isRetryable = status === 429 || status === 500 || status === 503;
        if (!isRetryable || attempt >= RETRY_DELAYS_MS.length) {
          break;
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new LLMProviderError('ANTHROPIC_API_ERROR', `Anthropic API call failed: ${message}`);
  }

  /**
   * GEO-MEASUREMENT-W2 (C1) — citation-aware completion via the `web_search`
   * server tool (GA). Same retry policy as `complete()`. Returns answer text
   * + the flattened source-citation map. `complete()` is UNCHANGED (frozen).
   */
  async completeWithCitations(
    messages: LLMMessage[],
    opts: LLMCompletionOpts,
  ): Promise<RetrievalResult> {
    const system = opts.systemPromptCacheable
      ? [{ type: 'text' as const, text: opts.systemPrompt, cache_control: { type: 'ephemeral' as const } }]
      : opts.systemPrompt;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: opts.model,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
          system,
          tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: WEB_SEARCH_MAX_USES }],
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        });
        const { text, citations } = flattenAnthropicCitations(response.content);
        return {
          text,
          citations,
          usage: {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            cachedPromptTokens: response.usage.cache_read_input_tokens ?? undefined,
          },
        };
      } catch (err: unknown) {
        lastErr = err;
        const status = (err as { status?: number })?.status;
        const isRetryable = status === 429 || status === 500 || status === 503;
        if (!isRetryable || attempt >= RETRY_DELAYS_MS.length) break;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new LLMProviderError('ANTHROPIC_API_ERROR', `Anthropic web_search call failed: ${message}`);
  }
}

export class StubLLMProvider implements LLMProvider {
  readonly name = 'stub' as const;

  async complete(messages: LLMMessage[], _opts: LLMCompletionOpts): Promise<LLMCompletion> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const echo = lastUser ? lastUser.content.slice(0, 100) : '';
    return {
      text: `[STUB] ${echo}`,
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }
}

let _stubWarnLogged = false;

/**
 * Factory — returns `AnthropicProvider` if `ANTHROPIC_API_KEY` is present,
 * otherwise `StubLLMProvider` with a console.warn (once) at startup.
 */
export function getLLMProvider(): LLMProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey && apiKey.trim().length > 0) {
    return new AnthropicProvider(apiKey);
  }
  if (!_stubWarnLogged) {
    _stubWarnLogged = true;
    console.warn(
      '[llm-provider] ANTHROPIC_API_KEY not set — chat_knowledge will return [STUB] responses. ' +
        'See audits/AV-CHAT-MCP-W1-endpoint-truth.md Q-3 for provisioning steps.',
    );
  }
  return new StubLLMProvider();
}

// ---------------------------------------------------------------------------
// GEO-MEASUREMENT-W2 (C1) — retrieval engines (Claude web_search + Perplexity)
// ---------------------------------------------------------------------------

const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';

interface PerplexitySearchResult {
  url?: string;
  title?: string;
  snippet?: string;
}
interface PerplexityChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  citations?: string[];
  search_results?: PerplexitySearchResult[];
}

/**
 * GEO-MEASUREMENT-W2 (C1) — Perplexity Sonar provider. OpenAI-compatible
 * `api.perplexity.ai/chat/completions` via raw `fetch` (zero new dep). Plain
 * `complete()` for text; `completeWithCitations()` maps Sonar's `search_results`
 * (rich: url+title+snippet) — falling back to the legacy `citations` URL array —
 * into the unified `Citation[]`. Model from `PERPLEXITY_MODEL` (default `sonar`).
 */
export class PerplexityProvider implements LLMProvider {
  readonly name = 'perplexity' as const;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model?: string) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new LLMProviderError(
        'MISSING_PERPLEXITY_API_KEY',
        'PerplexityProvider requires a non-empty apiKey',
      );
    }
    this.apiKey = apiKey;
    this.model = model || process.env.PERPLEXITY_MODEL || 'sonar';
  }

  private async call(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<PerplexityChatResponse> {
    // OpenAI-shaped messages: prepend a system message when systemPrompt set.
    const body = {
      model: opts.model || this.model,
      messages: [
        ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
    };

    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const res = await fetch(`${PERPLEXITY_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const isRetryable = res.status === 429 || res.status === 500 || res.status === 503;
          const errText = await res.text().catch(() => '');
          if (isRetryable && attempt < RETRY_DELAYS_MS.length) {
            await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
            continue;
          }
          throw new LLMProviderError(
            'PERPLEXITY_API_ERROR',
            `Perplexity API ${res.status}: ${errText.slice(0, 200)}`,
          );
        }
        return (await res.json()) as PerplexityChatResponse;
      } catch (err: unknown) {
        lastErr = err;
        if (err instanceof LLMProviderError) throw err;
        if (attempt >= RETRY_DELAYS_MS.length) break;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new LLMProviderError('PERPLEXITY_API_ERROR', `Perplexity API call failed: ${message}`);
  }

  private static usageOf(json: PerplexityChatResponse): LLMCompletion['usage'] {
    return {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    };
  }

  async complete(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<LLMCompletion> {
    const json = await this.call(messages, opts);
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      usage: PerplexityProvider.usageOf(json),
    };
  }

  async completeWithCitations(
    messages: LLMMessage[],
    opts: LLMCompletionOpts,
  ): Promise<RetrievalResult> {
    const json = await this.call(messages, opts);
    const byUrl = new Map<string, Citation>();
    // Prefer rich search_results (url+title+snippet); fall back to citations[].
    for (const sr of json.search_results ?? []) {
      if (typeof sr.url === 'string' && sr.url) {
        byUrl.set(sr.url, {
          url: sr.url,
          ...(sr.title ? { title: sr.title } : {}),
          ...(sr.snippet ? { cited_text: sr.snippet } : {}),
        });
      }
    }
    for (const u of json.citations ?? []) {
      if (typeof u === 'string' && u && !byUrl.has(u)) byUrl.set(u, { url: u });
    }
    return {
      text: json.choices?.[0]?.message?.content ?? '',
      citations: [...byUrl.values()],
      usage: PerplexityProvider.usageOf(json),
    };
  }
}

// ---------------------------------------------------------------------------
// GEO-MEASUREMENT-W3 — ChatGPT (OpenAI Responses) + Gemini (Google grounding).
// Both raw-fetch, mirroring PerplexityProvider. Provider `name`s are 'openai' /
// 'gemini' (already in LLMProviderName since W1 — no enum change). Engine IDs
// are 'chatgpt' / 'gemini' (GEO_ENGINES tokens). Shared retry helper below.
// ---------------------------------------------------------------------------

/** POST + parse JSON with the same retry policy as PerplexityProvider.call. */
async function postJsonRetry(url: string, init: RequestInit, errCode: string): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const isRetryable = res.status === 429 || res.status === 500 || res.status === 503;
        const errText = await res.text().catch(() => '');
        if (isRetryable && attempt < RETRY_DELAYS_MS.length) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        throw new LLMProviderError(errCode, `${errCode} ${res.status}: ${errText.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err: unknown) {
      lastErr = err;
      if (err instanceof LLMProviderError) throw err;
      if (attempt >= RETRY_DELAYS_MS.length) break;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new LLMProviderError(errCode, `${errCode} call failed: ${message}`);
}

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

interface OpenAIResponse {
  output?: unknown[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * GEO-MEASUREMENT-W3 (C1) — flatten an OpenAI Responses payload (verified live
 * 2026-06-02: `output[]` = [web_search_call, message]; message.content[] has
 * type 'output_text' + text + annotations[] of `url_citation`). Joins the
 * output text + dedups `url_citation` annotations → Citation[]. Exported pure fn.
 */
export function flattenOpenAICitations(response: unknown): { text: string; citations: Citation[] } {
  const r = (response ?? {}) as { output?: unknown };
  const texts: string[] = [];
  const byUrl = new Map<string, Citation>();
  const output = Array.isArray(r.output) ? r.output : [];
  for (const blk of output) {
    const b = blk as { content?: unknown };
    const content = Array.isArray(b.content) ? b.content : [];
    for (const c of content) {
      const cc = c as { text?: unknown; annotations?: unknown };
      if (typeof cc.text === 'string') texts.push(cc.text);
      const anns = Array.isArray(cc.annotations) ? cc.annotations : [];
      for (const a of anns) {
        const aa = a as { type?: string; url?: unknown; title?: unknown };
        if (aa.type === 'url_citation' && typeof aa.url === 'string' && aa.url) {
          const ex = byUrl.get(aa.url) ?? { url: aa.url };
          if (typeof aa.title === 'string' && aa.title) ex.title = aa.title;
          byUrl.set(aa.url, ex);
        }
      }
    }
  }
  return { text: texts.join('').trim(), citations: [...byUrl.values()] };
}

/**
 * GEO-MEASUREMENT-W3 (C1) — ChatGPT engine via the OpenAI Responses API +
 * `web_search` GA tool (raw fetch). Model from `OPENAI_MODEL` (default
 * `gpt-4.1-mini`). `name='openai'`.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai' as const;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model?: string) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new LLMProviderError('MISSING_OPENAI_API_KEY', 'OpenAIProvider requires a non-empty apiKey');
    }
    this.apiKey = apiKey;
    this.model = model || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  }

  private async call(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<OpenAIResponse> {
    const body = {
      model: opts.model || this.model,
      input: messages.map((m) => ({ role: m.role, content: m.content })),
      ...(opts.systemPrompt ? { instructions: opts.systemPrompt } : {}),
      tools: [{ type: 'web_search' }],
      max_output_tokens: opts.maxTokens,
      temperature: opts.temperature,
    };
    return (await postJsonRetry(
      OPENAI_RESPONSES_URL,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      'OPENAI_API_ERROR',
    )) as OpenAIResponse;
  }

  private static usageOf(j: OpenAIResponse): LLMCompletion['usage'] {
    return { promptTokens: j.usage?.input_tokens ?? 0, completionTokens: j.usage?.output_tokens ?? 0 };
  }

  async complete(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<LLMCompletion> {
    const j = await this.call(messages, opts);
    return { text: flattenOpenAICitations(j).text, usage: OpenAIProvider.usageOf(j) };
  }

  async completeWithCitations(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<RetrievalResult> {
    const j = await this.call(messages, opts);
    const { text, citations } = flattenOpenAICitations(j);
    return { text, citations, usage: OpenAIProvider.usageOf(j) };
  }
}

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiResponse {
  candidates?: unknown[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * GEO-MEASUREMENT-W3 (C1) — flatten a Gemini generateContent payload with
 * Google Search grounding: text from `candidates[].content.parts[].text`;
 * citations from `candidates[].groundingMetadata.groundingChunks[].web{uri,title}`.
 * Exported pure fn.
 */
export function flattenGeminiCitations(response: unknown): { text: string; citations: Citation[] } {
  const r = (response ?? {}) as { candidates?: unknown };
  const texts: string[] = [];
  const byUrl = new Map<string, Citation>();
  const candidates = Array.isArray(r.candidates) ? r.candidates : [];
  for (const cand of candidates) {
    const c = cand as {
      content?: { parts?: unknown };
      groundingMetadata?: { groundingChunks?: unknown };
    };
    const parts = c.content && Array.isArray(c.content.parts) ? c.content.parts : [];
    for (const p of parts) {
      const pp = p as { text?: unknown };
      if (typeof pp.text === 'string') texts.push(pp.text);
    }
    const chunks =
      c.groundingMetadata && Array.isArray(c.groundingMetadata.groundingChunks)
        ? c.groundingMetadata.groundingChunks
        : [];
    for (const chunk of chunks) {
      const w = (chunk as { web?: { uri?: unknown; title?: unknown } }).web;
      if (w && typeof w.uri === 'string' && w.uri) {
        const ex = byUrl.get(w.uri) ?? { url: w.uri };
        if (typeof w.title === 'string' && w.title) ex.title = w.title;
        byUrl.set(w.uri, ex);
      }
    }
  }
  return { text: texts.join('').trim(), citations: [...byUrl.values()] };
}

/**
 * GEO-MEASUREMENT-W3 (C1) — Gemini engine via `generateContent` +
 * `google_search` grounding (raw fetch; `x-goog-api-key` header, NOT `?key=`).
 * Model from `GEMINI_MODEL` (default `gemini-2.5-flash`). `name='gemini'`.
 */
export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini' as const;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model?: string) {
    if (!apiKey || typeof apiKey !== 'string') {
      throw new LLMProviderError('MISSING_GEMINI_API_KEY', 'GeminiProvider requires a non-empty apiKey');
    }
    this.apiKey = apiKey;
    this.model = model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  }

  private async call(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<GeminiResponse> {
    const model = opts.model || this.model;
    const body = {
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      ...(opts.systemPrompt ? { systemInstruction: { parts: [{ text: opts.systemPrompt }] } } : {}),
      tools: [{ google_search: {} }],
      generationConfig: { maxOutputTokens: opts.maxTokens, temperature: opts.temperature },
    };
    return (await postJsonRetry(
      `${GEMINI_BASE_URL}/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      'GEMINI_API_ERROR',
    )) as GeminiResponse;
  }

  private static usageOf(j: GeminiResponse): LLMCompletion['usage'] {
    return {
      promptTokens: j.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: j.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }

  async complete(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<LLMCompletion> {
    const j = await this.call(messages, opts);
    return { text: flattenGeminiCitations(j).text, usage: GeminiProvider.usageOf(j) };
  }

  async completeWithCitations(messages: LLMMessage[], opts: LLMCompletionOpts): Promise<RetrievalResult> {
    const j = await this.call(messages, opts);
    const { text, citations } = flattenGeminiCitations(j);
    return { text, citations, usage: GeminiProvider.usageOf(j) };
  }
}

const STUB_CITATIONS: Citation[] = [
  { url: 'https://algovault.com/faq', title: 'AlgoVault FAQ', cited_text: 'AlgoVault provides composite quant trade signals for AI agents via MCP.' },
  { url: 'https://github.com/polakowo/vectorbt', title: 'vectorbt', cited_text: 'vectorbt is a Python library for backtesting quantitative strategies.' },
];

/**
 * GEO-MEASUREMENT-W2 (C1) — retrieval stub. TEST/dev only (never selected in
 * prod by the factory — Q-2-C). Returns a realistic `[STUB]` answer + ≥2
 * citations (one algovault.com, one competitor) so C2's `mapSourceCitations`
 * fixture + the full flow run with no live key.
 */
export class StubRetrievalProvider implements LLMProvider {
  readonly name = 'stub' as const;

  async complete(messages: LLMMessage[], _opts: LLMCompletionOpts): Promise<LLMCompletion> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return {
      text: `[STUB] ${lastUser ? lastUser.content.slice(0, 100) : ''}`,
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }

  async completeWithCitations(
    messages: LLMMessage[],
    _opts: LLMCompletionOpts,
  ): Promise<RetrievalResult> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return {
      text: `[STUB] ${lastUser ? lastUser.content.slice(0, 100) : ''} — AlgoVault is a composite quant signal MCP server; alternatives include vectorbt.`,
      citations: STUB_CITATIONS.map((c) => ({ ...c })),
      usage: { promptTokens: 0, completionTokens: 0 },
    };
  }
}

/** One runnable retrieval engine: an id (`claude-web`/`perplexity`/…), its provider, and its model. */
export interface RetrievalEngine {
  engineId: string;
  provider: LLMProvider;
  model: string;
}

const DEFAULT_GEO_ENGINES = 'claude-web,perplexity';

/**
 * Q-2-C: stubs are TEST-ONLY. In prod a key-less engine is SKIPPED entirely so
 * no `[STUB]` rows ever land in geo_mentions. vitest sets `VITEST` + `NODE_ENV=test`.
 */
function stubAllowed(): boolean {
  return process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
}

/**
 * Build one engine from its id. Real provider when its key is present; else
 * Stub in test, or `null` (skipped + warned) in prod. Adding a future engine
 * (W3 ChatGPT-search, W4 Gemini-grounding) = ONE new `case` here + 1 key +
 * 1 `GEO_ENGINES` entry — zero downstream change.
 */
function buildRetrievalEngine(engineId: string): RetrievalEngine | null {
  let realKey: string | undefined;
  let model = '';
  let makeProvider: ((key: string) => LLMProvider) | undefined;

  switch (engineId) {
    case 'claude-web':
      realKey = process.env.ANTHROPIC_API_KEY;
      model = process.env.GEO_CLAUDE_WEB_MODEL || 'claude-haiku-4-5-20251001';
      makeProvider = (k) => new AnthropicProvider(k);
      break;
    case 'perplexity':
      realKey = process.env.PERPLEXITY_API_KEY;
      model = process.env.PERPLEXITY_MODEL || 'sonar';
      makeProvider = (k) => new PerplexityProvider(k, model);
      break;
    case 'chatgpt':
      realKey = process.env.OPENAI_API_KEY;
      model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
      makeProvider = (k) => new OpenAIProvider(k, model);
      break;
    case 'gemini':
      realKey = process.env.GEMINI_API_KEY;
      model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      makeProvider = (k) => new GeminiProvider(k, model);
      break;
    default:
      console.warn(`[geo-retrieval] unknown engine '${engineId}' in GEO_ENGINES — skipped`);
      return null;
  }

  if (realKey && realKey.trim().length > 0) {
    return { engineId, provider: makeProvider(realKey), model };
  }
  if (stubAllowed()) {
    return { engineId, provider: new StubRetrievalProvider(), model: `stub-${engineId}` };
  }
  console.warn(
    `[geo-retrieval] engine '${engineId}' has no API key — SKIPPED in prod (no [STUB] rows persisted)`,
  );
  return null;
}

/**
 * Resolve the runnable retrieval engines from `GEO_ENGINES`
 * (default `claude-web,perplexity`). Key-less engines: Stub in test, skipped in prod.
 */
export function getRetrievalEngines(): RetrievalEngine[] {
  const ids = (process.env.GEO_ENGINES || DEFAULT_GEO_ENGINES)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const engines: RetrievalEngine[] = [];
  for (const id of ids) {
    const engine = buildRetrievalEngine(id);
    if (engine) engines.push(engine);
  }
  return engines;
}
