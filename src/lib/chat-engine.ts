/**
 * ChatEngine — AV-CHAT-MCP-W1 (C3).
 *
 * Orchestrates: question → SearchEngine.query(N snippets) → build prompt
 * with snippets as inline context → LLM.complete → ChatResult with
 * citations. Cache-layered at 24h TTL (chat answers are stable across the
 * knowledge bundle's release boundary).
 *
 * Fix-at-generator LAW (this wave): NO hand-written `if question.includes(X)
 * return Y` shortcuts. ALL answers go through the LLM. The CI canary in
 * C4 will fail-fast on any new such block (grep for the regex pattern).
 *
 * Locked verbatim system prompt below — see CLAUDE.md "VERBATIM SYSTEM
 * PROMPT for chat engine" and the AV-CHAT-MCP-W1 spec §C3.
 */
import type { SearchEngine, SearchResult } from './search-engine.js';
import type { LLMProvider } from './llm-provider.js';
import type { ResultCache } from './result-cache.js';
import type { KnowledgeBundle } from './knowledge-formatter.js';
import { getLiveTrackRecordBlock } from './chat-track-record.js';

export const CHAT_ENGINE_SYSTEM_PROMPT = `You are AlgoVault's documentation assistant. AlgoVault is the Brain Layer for AI Trading Agents — a composable MCP server providing crypto-quant trade signals, market regime detection, and funding arbitrage scans across major crypto exchanges.

RULES:
1. Answer using ONLY the provided context snippets below. Do NOT invent tools, parameters, response fields, or integration steps not present in the snippets.
2. If the answer is not in the snippets, respond exactly: "I don't have that in my knowledge base. Try \`search_knowledge\` with different keywords, or check https://algovault.com/docs."
3. Always cite sources inline using the format [source: <url>] after each factual claim.
4. Keep answers concise (≤200 words unless the question explicitly requires more detail).
5. Use code blocks for any code examples. Prefer Python/TypeScript matching the user's question context.
6. Never expose internal fields: outcome_return_pct, outcome_price, Phase E numbers, AOE internals, or any field listed in any response_shapes[*].forbidden_keys.
7. A \`CURRENT TRACK RECORD\` block may appear before the context snippets. Its figures are authoritative and live — if any snippet states a different signal-call count, win rate, exchange count, or asset count, use ONLY the figures in that block and ignore the snippet's number. Never restate, quote, or contrast the superseded snippet figures (do not write "up from X" or "previously Y") — answer with the authoritative figures alone, as if they were the only ones present.
8. Copy parameter names and allowed values exactly as listed in a tool's parameter lines; never rename or reformat them.`;

/**
 * The version of the context format a snippet renders to. It is part of every answer's cache key,
 * so an answer built from an older context is never served after the format changes. Bump it with
 * any change to `contextSnippetLine` or `toolParameterLines`.
 *   2 — OPS-TOOL-PARAM-TRUTH-W1: a tool snippet carries that tool's parameter lines.
 */
export const CHAT_CONTEXT_FORMAT = 2;

/** The slice of the knowledge bundle the context reads: its version and each tool's inputSchema. */
export type ChatContextBundle = Pick<KnowledgeBundle, 'version' | 'tools'>;

export interface ChatResult {
  question: string;
  answer: string;
  citations: Array<{
    source_type: string;
    source_url: string;
    title: string;
    excerpt: string;
  }>;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
}

export interface ChatEngineOpts {
  defaultModel: string;
  maxContextSnippets: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /**
   * The bundle the snippets were retrieved from — wired to `KnowledgeIndex.getBundle()`, the same
   * object the chat response reports as `bundle_version`. It supplies the tool parameter lines and
   * the cache key's version. `null` renders no parameter lines.
   */
  bundle: () => ChatContextBundle | null;
}

const DEFAULT_OPTS: ChatEngineOpts = {
  defaultModel: 'claude-haiku-4-5-20251001',
  maxContextSnippets: 8,
  // OPS-TOOL-PARAM-TRUTH-W1 R0: the largest tool snippet with its parameter block (scan_market_regimes)
  // is ~639 est. tokens, and with the next three tool snippets ~1,616 — inside this budget, so unchanged.
  maxInputTokens: 2000,
  maxOutputTokens: 800,
  bundle: () => null,
};

// Naive token estimator: 1 token ≈ 4 chars (English heuristic; Anthropic
// tokenizer is BPE-based but this is close enough for context-budget gating).
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The ONE line format an LLM context snippet takes — used to BUILD the context and to BUDGET it,
 * so the two can never disagree about what a snippet costs.
 *
 * OPS-KNOWLEDGE-BUNDLE-TOOL-PROJECTION-W1: a snippet used to be `[url] excerpt`. For a tool doc the
 * url is the shared MCP endpoint and the excerpt is the start of the description, and no
 * description names its own tool — so the model could retrieve the right tool and still be unable
 * to name it without breaking rule 1. The title (a tool doc's title IS its name) now leads the
 * excerpt. It is skipped when the excerpt already opens with it, which integration pages do.
 */
function contextSnippetLine(
  s: Pick<SearchResult, 'id' | 'source_type' | 'source_url' | 'title' | 'excerpt'>,
  toolParameters: ReadonlyMap<string, Record<string, unknown>>,
): string {
  const title = s.title.replace(/\s+/g, ' ').trim();
  const opensWithTitle = title !== '' && s.excerpt.toLowerCase().startsWith(title.toLowerCase());
  const line = `[${s.source_url}] ${title === '' || opensWithTitle ? s.excerpt : `${title}: ${s.excerpt}`}`;
  // OPS-TOOL-PARAM-TRUTH-W1 CH2: a tool snippet carried only the first 200 characters of its
  // description, so the model named the right tool and then invented every parameter. The tool's own
  // lines ride with it, inside the one string the budget charges, so a block is never cut mid-way.
  const params = s.source_type === 'tool' ? toolParameters.get(s.id.slice('tool:'.length)) : undefined;
  const lines = params ? toolParameterLines(params) : [];
  return lines.length > 0 ? `${line}\nParameters:\n${lines.join('\n')}` : line;
}

/**
 * OPS-TOOL-PARAM-TRUTH-W1 CH2 — a tool's parameters as the lines the model copies from, one per
 * property of its inputSchema (the tools/list projection the bundle carries), in schema order:
 * `- <name> (<type>[, one of A|B|C][, default X][, required]): <description>`. An array names its
 * item type, and its items' enum is the "one of". A schema without object `properties` renders none.
 */
export function toolParameterLines(parameters: Record<string, unknown>): string[] {
  const props = parameters?.properties;
  if (props === null || typeof props !== 'object' || Array.isArray(props)) return [];
  const required = new Set(Array.isArray(parameters.required) ? parameters.required.map(String) : []);
  return Object.entries(props as Record<string, Record<string, unknown> | null>).map(([name, schema]) => {
    const p = schema ?? {};
    const items = (p.items ?? null) as Record<string, unknown> | null;
    const type = p.type === 'array' ? `array of ${String(items?.type ?? 'any')}` : String(p.type ?? 'any');
    const values = Array.isArray(p.enum) ? p.enum : Array.isArray(items?.enum) ? items.enum : null;
    const facts = [type];
    if (values) facts.push(`one of ${values.map(String).join('|')}`);
    if ('default' in p) facts.push(`default ${typeof p.default === 'string' ? p.default : JSON.stringify(p.default)}`);
    if (required.has(name)) facts.push('required');
    const desc = typeof p.description === 'string' ? p.description.replace(/\s+/g, ' ').trim() : '';
    return `- ${name} (${facts.join(', ')})${desc ? `: ${desc}` : ''}`;
  });
}

function hashKey(question: string, model: string, bundleVersion: string): string {
  return `${CHAT_CONTEXT_FORMAT}|${bundleVersion}|${model}|${question.trim().toLowerCase()}`;
}

export class ChatEngine {
  private readonly opts: ChatEngineOpts;

  constructor(
    private readonly searchEngine: SearchEngine,
    private readonly llm: LLMProvider,
    private readonly cache: ResultCache<ChatResult>,
    opts: Partial<ChatEngineOpts> = {},
  ) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  async chat(question: string, opts?: { model?: string }): Promise<ChatResult> {
    const model = opts?.model ?? this.opts.defaultModel;
    // ONE bundle read per answer: the cache key's version and the parameter lines project from it.
    const bundle = this.opts.bundle();
    const key = hashKey(question, model, bundle?.version ?? 'none');

    const cached = this.cache.get(key);
    if (cached) return cached;

    // 1. Retrieve top-N snippets via search engine
    const snippets = await this.searchEngine.query(question, this.opts.maxContextSnippets);

    // 2. Truncate context if total tokens > maxInputTokens (drop lowest-ranked first). The same
    // renderer builds the context below, so the budget charges exactly what the model receives.
    const toolParameters = new Map((bundle?.tools ?? []).map((t) => [t.name, t.parameters] as const));
    const render = (s: SearchResult): string => contextSnippetLine(s, toolParameters);
    const truncatedSnippets = this.truncateContext(snippets, render);

    // 3. Build user message with context.
    //
    // CHAT-LIVE-SOT-INJECTION-W1: the live track-record block is prepended
    // AHEAD of the question so it precedes the snippets, whose baked figures
    // it overrides (system prompt rule 7). `getLiveTrackRecordBlock()` is
    // itself fail-open, but the await is guarded too — a chat answer must
    // never be blocked or blanked by track-record trouble.
    let trackRecordBlock = '';
    try {
      trackRecordBlock = await getLiveTrackRecordBlock();
    } catch {
      trackRecordBlock = '';
    }
    const preamble = trackRecordBlock ? `${trackRecordBlock}\n\n` : '';

    const contextBlock = truncatedSnippets
      .map(render)
      .join('\n\n');
    const userMessage = contextBlock
      ? `${preamble}${question}\n\nContext snippets:\n${contextBlock}`
      : `${preamble}${question}`;

    // 4. Call LLM
    const completion = await this.llm.complete(
      [{ role: 'user', content: userMessage }],
      {
        model,
        maxTokens: this.opts.maxOutputTokens,
        temperature: 0.3,
        systemPrompt: CHAT_ENGINE_SYSTEM_PROMPT,
        systemPromptCacheable: true,
      },
    );

    // 5. Build result
    const result: ChatResult = {
      question,
      answer: completion.text,
      citations: truncatedSnippets.map((s) => ({
        source_type: s.source_type,
        source_url: s.source_url,
        title: s.title,
        excerpt: s.excerpt,
      })),
      model,
      usage: {
        promptTokens: completion.usage.promptTokens,
        completionTokens: completion.usage.completionTokens,
      },
    };

    this.cache.set(key, result);
    return result;
  }

  private truncateContext(snippets: SearchResult[], render: (s: SearchResult) => string): SearchResult[] {
    // Sort by score desc (search engine already does this, but defensive)
    const sorted = [...snippets].sort((a, b) => b.score - a.score);
    const out: SearchResult[] = [];
    let runningTokens = 0;
    for (const s of sorted) {
      const snippetTokens = estimateTokens(render(s));
      if (runningTokens + snippetTokens > this.opts.maxInputTokens) break;
      out.push(s);
      runningTokens += snippetTokens;
    }
    return out;
  }
}
