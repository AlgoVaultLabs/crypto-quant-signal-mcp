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
import { getLiveTrackRecordBlock } from './chat-track-record.js';

export const CHAT_ENGINE_SYSTEM_PROMPT = `You are AlgoVault's documentation assistant. AlgoVault is the Brain Layer for AI Trading Agents — a composable MCP server providing crypto-quant trade signals, market regime detection, and funding arbitrage scans across major crypto exchanges.

RULES:
1. Answer using ONLY the provided context snippets below. Do NOT invent tools, parameters, response fields, or integration steps not present in the snippets.
2. If the answer is not in the snippets, respond exactly: "I don't have that in my knowledge base. Try \`search_knowledge\` with different keywords, or check https://algovault.com/docs."
3. Always cite sources inline using the format [source: <url>] after each factual claim.
4. Keep answers concise (≤200 words unless the question explicitly requires more detail).
5. Use code blocks for any code examples. Prefer Python/TypeScript matching the user's question context.
6. Never expose internal fields: outcome_return_pct, outcome_price, Phase E numbers, AOE internals, or any field listed in any response_shapes[*].forbidden_keys.
7. A \`CURRENT TRACK RECORD\` block may appear before the context snippets. Its figures are authoritative and live — if any snippet states a different signal-call count, win rate, exchange count, or asset count, use ONLY the figures in that block and ignore the snippet's number.`;

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
}

const DEFAULT_OPTS: ChatEngineOpts = {
  defaultModel: 'claude-haiku-4-5-20251001',
  maxContextSnippets: 8,
  maxInputTokens: 2000,
  maxOutputTokens: 800,
};

// Naive token estimator: 1 token ≈ 4 chars (English heuristic; Anthropic
// tokenizer is BPE-based but this is close enough for context-budget gating).
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function hashKey(question: string, model: string): string {
  return `${model}|${question.trim().toLowerCase()}`;
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
    const key = hashKey(question, model);

    const cached = this.cache.get(key);
    if (cached) return cached;

    // 1. Retrieve top-N snippets via search engine
    const snippets = await this.searchEngine.query(question, this.opts.maxContextSnippets);

    // 2. Truncate context if total tokens > maxInputTokens (drop lowest-ranked first)
    const truncatedSnippets = this.truncateContext(snippets);

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
      .map((s) => `[${s.source_url}] ${s.excerpt}`)
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

  private truncateContext(snippets: SearchResult[]): SearchResult[] {
    // Sort by score desc (search engine already does this, but defensive)
    const sorted = [...snippets].sort((a, b) => b.score - a.score);
    const out: SearchResult[] = [];
    let runningTokens = 0;
    for (const s of sorted) {
      const snippetTokens = estimateTokens(`[${s.source_url}] ${s.excerpt}`);
      if (runningTokens + snippetTokens > this.opts.maxInputTokens) break;
      out.push(s);
      runningTokens += snippetTokens;
    }
    return out;
  }
}
