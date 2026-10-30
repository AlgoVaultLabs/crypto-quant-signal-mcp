/**
 * knowledge-tools.ts — ARCH-MCP-CALL-PIPELINE-W1 CH2: the knowledge stack the `search_knowledge` and
 * `chat_knowledge` tool paths and the `/api/*` knowledge routes share.
 *
 * Moved VERBATIM from `src/index.ts` (the lazy singletons `getKnowledgeSearch` / `getChatStack`, the
 * chat model allow-list and the licence→chat-tier map) so the tool-call pipeline can dispatch the
 * knowledge tools without importing `index.ts` — which boots the server at import and would be a
 * cycle. `index.ts` keeps importing the same two singletons for its HTTP knowledge routes, so there
 * is still exactly ONE index + ONE chat stack per process (the comment in index.ts that says
 * "single SoT for the index + retrieval" still holds; the SoT merely moved modules).
 *
 * The bundle path is resolved relative to THIS file's compiled location (`dist/tools/`), one level
 * below where `index.ts` resolved it (`dist/`), so the served artifact is unchanged:
 * `dist/knowledge/latest.json`.
 */
import * as path from 'node:path';
import { KnowledgeIndex } from '../lib/knowledge-index.js';
import { SearchEngine, type SearchResult } from '../lib/search-engine.js';
import { ResultCache } from '../lib/result-cache.js';
import { getLLMProvider, type LLMProvider } from '../lib/llm-provider.js';
import { ChatEngine, type ChatResult } from '../lib/chat-engine.js';
import { ChatRateLimit, type ChatTier } from '../lib/chat-rate-limit.js';

let _searchEnginePromise: Promise<{
  index: KnowledgeIndex;
  engine: SearchEngine;
}> | null = null;

function getKnowledgeBundlePath(): string {
  if (process.env.KNOWLEDGE_BUNDLE_PATH) return process.env.KNOWLEDGE_BUNDLE_PATH;
  return path.resolve(__dirname, '..', 'knowledge', 'latest.json');
}

export async function getKnowledgeSearch(): Promise<{ index: KnowledgeIndex; engine: SearchEngine }> {
  if (!_searchEnginePromise) {
    _searchEnginePromise = (async () => {
      const bundlePath = getKnowledgeBundlePath();
      const index = new KnowledgeIndex(bundlePath);
      await index.build();
      const cache = new ResultCache<SearchResult[]>({ ttlMs: 3_600_000, max: 500 });
      const engine = new SearchEngine(index, cache);
      return { index, engine };
    })();
  }
  return _searchEnginePromise;
}

// AV-CHAT-MCP-W1 (C3): the chat stack is built lazily on top of
// getKnowledgeSearch() — single SoT for the index + retrieval.
export const ALLOWED_CHAT_MODELS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
]);

let _chatEnginePromise: Promise<{
  index: KnowledgeIndex;
  chatEngine: ChatEngine;
  rateLimit: ChatRateLimit;
  llm: LLMProvider;
}> | null = null;

export async function getChatStack(): Promise<{
  index: KnowledgeIndex;
  chatEngine: ChatEngine;
  rateLimit: ChatRateLimit;
  llm: LLMProvider;
}> {
  if (!_chatEnginePromise) {
    _chatEnginePromise = (async () => {
      const { index, engine } = await getKnowledgeSearch();
      const llm = getLLMProvider();
      const cache = new ResultCache<ChatResult>({ ttlMs: 86_400_000, max: 200 });
      // OPS-TOOL-PARAM-TRUTH-W1 CH2: the tool parameter lines and the answer cache's bundle version
      // come from the SAME hot-reloaded bundle the snippets are retrieved from, and that both chat
      // paths report as `bundle_version`.
      const chatEngine = new ChatEngine(engine, llm, cache, { bundle: () => index.getBundle() });
      const rateLimit = new ChatRateLimit();
      return { index, chatEngine, rateLimit, llm };
    })();
  }
  return _chatEnginePromise;
}

/**
 * Map LicenseTier → ChatTier. License tiers `internal` and `x402` map to
 * `enterprise` (effectively unmetered for the chat surface).
 */
export function chatTierFor(licenseTier: string): ChatTier {
  if (licenseTier === 'free') return 'free';
  if (licenseTier === 'starter') return 'starter';
  if (licenseTier === 'pro') return 'pro';
  return 'enterprise';
}
