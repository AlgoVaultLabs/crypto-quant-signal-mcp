/**
 * SEARCH-TOOL-RANK-BOOST-W1 — the CORPUS-SIZE-INDEPENDENCE contract.
 *
 * The boost is not the deliverable; this file is. `knowledge-flow.test.ts` asserts that a
 * trading query surfaces a tool on the first page, and it passed for months on luck: measured
 * 2026-08-28 against the live bundle, the first tool sat at rank 9 of a 10-slot page. Zero
 * margin. The next document added to the corpus — a routine integration page — pushed it off,
 * and the guard fired on a wave that had done nothing wrong.
 *
 * Raising that guard's window to 15 would have bought back one page of margin and re-spent it
 * the same way. So the property under test here is not "a tool is on the page today" but "a tool
 * is on the page REGARDLESS OF HOW LARGE THE CORPUS GROWS", asserted by growing the corpus on
 * purpose across two orders of magnitude.
 *
 * The scenarios drive the pure `reRankForToolRepresentation` seam directly AND the real
 * `SearchEngine` over a synthetic bundle, because the two can disagree: the pure function can be
 * correct while the engine never calls it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeIndex } from '../../src/lib/knowledge-index.js';
import { SearchEngine, reRankForToolRepresentation } from '../../src/lib/search-engine.js';
import { ResultCache } from '../../src/lib/result-cache.js';

const QUERY = 'how do I get a trade signal';

/** A bundle with ONE tool and `n` integration pages written to out-rank it — the real shape. */
function syntheticBundle(n: number) {
  return {
    version: '0.0.0',
    generated_at: '2026-08-28T00:00:00Z',
    package_name: 'synthetic',
    description: 'synthetic corpus',
    keywords: [],
    whats_new: '',
    tools: [
      {
        name: 'get_trade_signal',
        description: 'Returns a trade signal for one asset.',
        parameters: { symbol: {}, timeframe: {} },
      },
    ],
    response_shapes: [],
    // Each page repeats the query's terms far more often than the terse tool description does,
    // which is exactly why BM25 ranks them above it. That is the condition being reproduced,
    // not worked around.
    integrations: Array.from({ length: n }, (_, i) => ({
      framework: `integration-${i}`,
      title: `AlgoVault x Integration ${i} — get a trade signal`,
      url: `https://algovault.com/integrations/integration-${i}`,
      content_markdown:
        `How do I get a trade signal in Integration ${i}? ` +
        'Ask it for a trade signal and it returns a trade signal. '.repeat(12),
    })),
    examples: [],
    discussions: [],
    pages: [],
    _algovault: { bundle_version: 2, generator: 'build-knowledge-json.mjs', repo: 'AlgoVaultLabs/crypto-quant-signal-mcp' },
  };
}

async function engineOver(n: number) {
  const dir = mkdtempSync(join(tmpdir(), 'rank-boost-'));
  const path = join(dir, 'bundle.json');
  writeFileSync(path, JSON.stringify(syntheticBundle(n)));
  const index = new KnowledgeIndex(path);
  await index.build();
  const search = new SearchEngine(index, new ResultCache({ ttlMs: 60_000, max: 100 }));
  return { index, search };
}

describe('search tool-rank boost — corpus-size independence (the deliverable)', () => {
  // n starts at 5, not 0: wink-bm25 refuses to consolidate a collection this small
  // ("document collection is too small for consolidation"), which is a library floor rather
  // than anything this wave controls. 5 -> 400 still spans two orders of magnitude.
  for (const n of [5, 25, 120, 400]) {
    it(`a tool is on the first page with ${n} competing integration page(s)`,
      { timeout: 60_000 }, async () => {
        const { index, search } = await engineOver(n);
        try {
          const page = await search.query(QUERY, 10);
          expect(page.length, 'the query returns results at all').toBeGreaterThan(0);
          expect(
            page.filter((r) => r.source_type === 'tool').length,
            `no tool on page 1 with a corpus of ${n} integrations`,
          ).toBeGreaterThan(0);
        } finally {
          index.stopWatching();
        }
      });
  }

  it('the corpus really does out-rank the tool without the boost — the scenario is not vacuous',
    { timeout: 60_000 }, async () => {
      // If BM25 put the tool on page 1 by itself here, every assertion above would pass with the
      // boost deleted, and this file would be theatre.
      const { index, search } = await engineOver(400);
      try {
        // Same widened call the engine makes. A bare search(QUERY) returns wink-bm25's
        // 10-row default and would report 'no tool matched' when one plainly did.
        const raw = index.getBM25Index()!.search(QUERY, index.docCount()) || [];
        const firstTool = raw.findIndex(([id]) => index.getDoc(id)?._source_type === 'tool');
        expect(firstTool, 'a tool matches the query at all').toBeGreaterThanOrEqual(0);
        expect(firstTool, 'BM25 alone puts the tool OFF page 1').toBeGreaterThanOrEqual(10);
        // …and the shipped engine still lands it on the page.
        const page = await search.query(QUERY, 10);
        expect(page.filter((r) => r.source_type === 'tool').length).toBe(1);
      } finally {
        index.stopWatching();
      }
    });
});

describe('search tool-rank boost — the re-rank seam', () => {
  const T = (i: number) => [`tool:t${i}`, 1] as [string, number];
  const I = (i: number) => [`integration:i${i}`, 1] as [string, number];
  const typeOf = (id: string) => (id.startsWith('tool:') ? 'tool' : 'integration');

  it('promotes exactly one tool, to the LAST page slot, preserving every other order', () => {
    const raw = [...Array.from({ length: 12 }, (_, i) => I(i)), T(0), T(1)];
    const out = reRankForToolRepresentation(raw, typeOf, 10);
    expect(out.slice(0, 9).map(([id]) => id)).toEqual(raw.slice(0, 9).map(([id]) => id));
    expect(out[9][0]).toBe('tool:t0');
    expect(out.filter(([id]) => id.startsWith('tool:')).length).toBe(2);
    expect(out.length).toBe(raw.length);
  });

  it('does nothing when a tool is already on the page', () => {
    const raw = [I(0), T(0), ...Array.from({ length: 20 }, (_, i) => I(i + 1))];
    expect(reRankForToolRepresentation(raw, typeOf, 10)).toEqual(raw);
  });

  it('does nothing when no tool matched the query at all', () => {
    const raw = Array.from({ length: 30 }, (_, i) => I(i));
    expect(reRankForToolRepresentation(raw, typeOf, 10)).toEqual(raw);
  });

  it('does nothing when the whole result set already fits on the page', () => {
    const raw = [...Array.from({ length: 6 }, (_, i) => I(i)), T(0)];
    expect(reRankForToolRepresentation(raw, typeOf, 10)).toEqual(raw);
  });

  it('reaches the WHOLE result set, not a fixed window — a deep tool is still promoted', () => {
    // This replaces an assertion that the reach stopped at MAX_PAGE=50. That bound was dropped
    // deliberately: wink-bm25 scores every document and only slices at the end, so a wider reach
    // costs nothing, while a fixed window re-introduces exactly the corpus-size dependence this
    // wave exists to remove — it would simply move the cliff from rank 10 to rank 50.
    const raw = [...Array.from({ length: 300 }, (_, i) => I(i)), T(0)];
    const out = reRankForToolRepresentation(raw, typeOf, 10);
    expect(out[9][0]).toBe('tool:t0');
    expect(out.slice(0, 9).map(([id]) => id)).toEqual(raw.slice(0, 9).map(([id]) => id));
  });

  it('REFUSES rather than throws when source_type cannot be resolved', () => {
    const raw = [...Array.from({ length: 12 }, (_, i) => I(i)), T(0)];
    const throwing = () => { throw new Error('index went away mid-request'); };
    expect(() => reRankForToolRepresentation(raw, throwing, 10)).not.toThrow();
    expect(reRankForToolRepresentation(raw, throwing, 10)).toEqual(raw);
    // An unresolvable doc is simply not a tool; the order survives unchanged.
    expect(reRankForToolRepresentation(raw, () => undefined, 10)).toEqual(raw);
  });

  it('a non-positive limit is a no-op, not a splice at index -1', () => {
    const raw = [...Array.from({ length: 12 }, (_, i) => I(i)), T(0)];
    expect(reRankForToolRepresentation(raw, typeOf, 0)).toEqual(raw);
  });
});
