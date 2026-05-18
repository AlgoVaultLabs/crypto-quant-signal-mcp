/**
 * search_knowledge response formatter — AV-CHAT-MCP-W1 (C2).
 *
 * Pure allow-list formatter. The `SearchKnowledgeResponse` shape is the public
 * contract for both:
 *   - search_knowledge MCP tool (`tools/call` text payload, JSON.stringify'd)
 *   - /api/search HTTP endpoint (response body)
 *
 * Locked by `audits/search-knowledge-shape-snapshot-2026-05-18.json`. Any
 * additive key requires (a) updating that snapshot file + dated successor,
 * (b) updating the TS interface here, (c) updating the formatter to include
 * the key.
 */
import type { KnowledgeBundle } from './knowledge-formatter.js';
import type { SearchResult } from './search-engine.js';

export interface SearchKnowledgeResponse {
  query: string;
  total_results: number;
  results: SearchResult[];
  _algovault: {
    bundle_version: string;
    bundle_generated_at: string;
  };
}

export function formatSearchKnowledgeResponse(
  query: string,
  results: SearchResult[],
  bundle: KnowledgeBundle | null,
): SearchKnowledgeResponse {
  return {
    query,
    total_results: results.length,
    results: results.map((r) => ({
      id: r.id,
      score: r.score,
      source_type: r.source_type,
      source_url: r.source_url,
      title: r.title,
      excerpt: r.excerpt,
    })),
    _algovault: {
      bundle_version: bundle?.version ?? 'unknown',
      bundle_generated_at: bundle?.generated_at ?? '',
    },
  };
}
