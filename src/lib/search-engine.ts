/**
 * SearchEngine — AV-CHAT-MCP-W1 (C1).
 *
 * BM25 lexical retrieval over a KnowledgeIndex. Result-cached at 1h TTL.
 * Consumed by:
 *   - search_knowledge MCP tool (C2)
 *   - /api/search HTTP endpoint (C2)
 *   - ChatEngine (C3) — builds LLM context from search results
 *
 * All three callers share the SAME SearchEngine instance via module-singleton
 * in src/index.ts — single SoT for the index + cache.
 */
import type { KnowledgeIndex, KnowledgeDocSourceType } from './knowledge-index.js';
import type { ResultCache } from './result-cache.js';

export interface SearchResult {
  id: string;
  score: number;
  source_type: KnowledgeDocSourceType;
  source_url: string;
  title: string;
  excerpt: string;
}

const MAX_EXCERPT_CHARS = 200;

function makeExcerpt(text: string): string {
  if (!text) return '';
  // Collapse whitespace + strip basic markdown control chars
  const collapsed = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const stripped = collapsed.replace(/[`*_~#>]/g, '');
  if (stripped.length <= MAX_EXCERPT_CHARS) return stripped;
  return stripped.slice(0, MAX_EXCERPT_CHARS).trimEnd() + '…';
}

export class SearchEngine {
  constructor(
    private readonly index: KnowledgeIndex,
    private readonly cache: ResultCache<SearchResult[]>,
  ) {}

  async query(q: string, limit: number = 10): Promise<SearchResult[]> {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 10));
    const key = `${safeLimit}|${q.trim().toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const engine = this.index.getBM25Index();
    if (!engine) {
      // Index empty (bundle file not yet loaded) — return empty results, not throw.
      return [];
    }

    let raw: Array<[string, number]>;
    try {
      raw = engine.search(q) || [];
    } catch (err) {
      // wink-bm25 throws on queries that produce zero tokens after prepTask
      // (e.g., pure punctuation). Treat as empty result, not error.
      console.warn(
        `[search-engine] BM25 search threw on query ${JSON.stringify(q)}: ${err instanceof Error ? err.message : err}`,
      );
      raw = [];
    }

    const results: SearchResult[] = [];
    for (const [docId, score] of raw.slice(0, safeLimit)) {
      const doc = this.index.getDoc(docId);
      if (!doc) continue;
      results.push({
        id: docId,
        score,
        source_type: doc._source_type,
        source_url: doc._source_url,
        title: doc.title,
        excerpt: makeExcerpt(doc._excerpt_source),
      });
    }

    this.cache.set(key, results);
    return results;
  }
}
