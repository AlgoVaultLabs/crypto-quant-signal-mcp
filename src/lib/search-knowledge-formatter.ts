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
import type { AuthState, LicenseInfo } from '../types.js';
import { withAuthState } from './tier-warning.js';

export interface SearchKnowledgeResponse {
  query: string;
  total_results: number;
  results: SearchResult[];
  _algovault: {
    bundle_version: string;
    bundle_generated_at: string;
    /**
     * AUTH-THREE-STATE-W1 CH2 (additive). Its own shape, its own snapshot — declared here rather
     * than inherited from `AlgoVaultMeta`.
     *
     * 🛑 EMITTED ON THE MCP TOOL PATH ONLY, and the omission on `/api/search` is the POINT rather
     * than an oversight. Every other member here is a property of the knowledge BUNDLE — identical
     * for every caller — which is exactly why that route ships `Cache-Control: public,
     * max-age=300`. `auth` is per-caller, and a per-caller value under a `public` freshness label
     * varies along a dimension absent from the cache key: the shape that serves one caller's state
     * to the next. Making the license OPTIONAL removes that hazard by construction instead of
     * mitigating it — the cacheable HTTP response stays byte-identical to today, and the MCP tool
     * (which is per-request and never shared-cached) gets the member. `/api/search` also resolves
     * no license at all today, so emitting there would have meant adding an upstream credential
     * lookup to a public endpoint to report a fact nobody asked it for.
     */
    auth?: AuthState;
  };
}

export function formatSearchKnowledgeResponse(
  query: string,
  results: SearchResult[],
  bundle: KnowledgeBundle | null,
  license?: Pick<LicenseInfo, 'key' | 'tier' | 'outcome'>,
): SearchKnowledgeResponse {
  const base = {
    bundle_version: bundle?.version ?? 'unknown',
    bundle_generated_at: bundle?.generated_at ?? '',
  };
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
    // Per-request when it IS emitted: the search cache stores raw SearchResult[]
    // (`search-engine.ts:45,80`), never this envelope, so the in-process LRU cannot replay one
    // caller's auth state to another. The remaining hazard was the SHARED HTTP cache, and the
    // optional license closes it — see the note on `auth` above.
    _algovault: license
      ? withAuthState(base, license)
      : base,
  };
}
