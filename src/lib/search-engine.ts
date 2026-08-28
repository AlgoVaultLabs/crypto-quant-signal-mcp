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

/** The largest page any caller can request — `query()` clamps `limit` to it. */
const MAX_PAGE = 50;

/**
 * SEARCH-TOOL-RANK-BOOST-W1 — guarantee a tool is REACHABLE on the first page.
 *
 * THE DEFECT. BM25 ranks a verbose integration tutorial above a one-sentence tool description
 * for a verbose natural-language query, and knowledge-index.ts:27 records that as WORKING AS
 * DESIGNED — the tutorial genuinely is the richer answer. So this is not a scoring bug and the
 * fix is NOT to reweight the fields; fighting the library would degrade every focused query
 * (`scan_funding_arb`, `get_trade_call`) where BM25 already puts the tool at rank 0-1.
 *
 * What was actually broken is REPRESENTATION. Measured 2026-08-28 for "how do I get a trade
 * signal": the first tool sat at rank 9 of a 10-slot page — the last slot, zero margin — so the
 * next document added to the corpus, of any kind, pushed it off. It did: one new integration
 * page ranked #5 and the page came back with zero tool entries. The invariant "a tool is
 * discoverable on the first page" had been true by luck for some time.
 *
 * THE RE-RANK, and its deliberate minimalism. If the highest-ranked tool already sits on the
 * page, nothing happens. Otherwise exactly ONE tool moves to the LAST slot of the page,
 * displacing exactly one document and preserving BM25's relative order everywhere else. It never
 * reorders the top of the page, never promotes more than one tool, and never invents relevance:
 * the promoted document is the HIGHEST-RANKED tool BM25 scored against this query.
 *
 * It is CORPUS-SIZE-INDEPENDENT by construction — the rule is expressed against `limit`, not
 * against a rank threshold that a growing corpus eats. That property, not the boost, is the
 * deliverable, and `tests/unit/search-tool-rank-boost.test.ts` is where it is pinned.
 *
 * IT REFUSES, IT DOES NOT THROW. This is a live serving path. Any failure to resolve a
 * `source_type` — a missing doc, a throwing resolver — returns the unmodified BM25 order, so the
 * worst case is the behaviour that shipped before this function existed.
 */
export function reRankForToolRepresentation(
  raw: Array<[string, number]>,
  sourceTypeOf: (docId: string) => string | undefined,
  limit: number,
): Array<[string, number]> {
  try {
    if (limit <= 0 || raw.length <= limit) return raw;

    const window = raw.length;
    let toolAt = -1;
    for (let i = 0; i < window; i++) {
      if (sourceTypeOf(raw[i][0]) === 'tool') { toolAt = i; break; }
    }

    // No tool matched this query at all, or one is already on the page: leave BM25 alone.
    if (toolAt === -1 || toolAt < limit) return raw;

    const out = raw.slice();
    const [promoted] = out.splice(toolAt, 1);
    out.splice(limit - 1, 0, promoted);
    return out;
  } catch {
    // A live serving path REFUSES; it does not THROW.
    return raw;
  }
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
      // ASK FOR THE WHOLE WINDOW, NOT THE LIBRARY DEFAULT. `wink-bm25-text-search`'s
      // `search(text, limit)` defaults limit to 10 (its own source: `.slice(0, Math.max((limit ||
      // 10), 1))`), so this call previously returned at most 10 rows however large `safeLimit`
      // was — the `Math.min(50, …)` clamp above advertised a page size the engine could not
      // deliver, and `query(q, 50)` silently returned 10.
      //
      // It also made the re-rank below structurally inert: a tool ranked 11th was not in `raw`
      // to promote. Found by SEARCH-TOOL-RANK-BOOST-W1's corpus-size scenarios, which reported
      // "a tool matches the query at all: expected -1" — the tool was matching and being
      // discarded by the library before we ever saw it.
      raw = engine.search(q, Math.max(this.index.docCount(), MAX_PAGE)) || [];
    } catch (err) {
      // wink-bm25 throws on queries that produce zero tokens after prepTask
      // (e.g., pure punctuation). Treat as empty result, not error.
      console.warn(
        `[search-engine] BM25 search threw on query ${JSON.stringify(q)}: ${err instanceof Error ? err.message : err}`,
      );
      raw = [];
    }

    const ordered = reRankForToolRepresentation(
      raw,
      (docId) => this.index.getDoc(docId)?._source_type,
      safeLimit,
    );

    const results: SearchResult[] = [];
    for (const [docId, score] of ordered.slice(0, safeLimit)) {
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
