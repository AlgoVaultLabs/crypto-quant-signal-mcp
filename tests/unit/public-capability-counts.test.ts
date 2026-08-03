/**
 * OPS-AUDIT-REMEDIATION-LOW-W2 · Ch2 — SEC-44 + SEC-46.
 *
 * The fix was NOT typing the right number. `landing/llms.txt` and `llms-full.txt` are what AI
 * answer-engines read, and they advertised "3 MCP tools" against a live `tools/list` of 7 —
 * understating the product on the GEO surface. Typing `7` would recreate the defect the next
 * time a tool ships or a flag flips (several tools are CONDITIONALLY exposed, which is why
 * "3 vs 4 vs 7 vs 9" reads as ambiguous across surfaces). Going qualitative resolves the
 * ambiguity by not needing to resolve it.
 *
 * This test pins that: no capability COUNT may return to the LLM-facing or generator-source
 * surfaces. It deliberately does NOT assert any particular number.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** "3 MCP tools", "4 tools", "all 3 tools" — a bare integer qualifying our tool surface. */
const TOOL_COUNT = /\b\d+\s+(?:MCP\s+)?tools?\b/gi;

/**
 * Surfaces that must carry no capability count. The two `.txt` files are the LLM-facing ones;
 * the rest are GENERATOR SOURCES — editing the rendered landing/*.html instead would be wiped
 * on the next build, so the source is what gets pinned.
 */
const SURFACES = [
  'landing/llms.txt',
  'landing/llms-full.txt',
  'src/lib/integrations-data/mcp-clients.ts',
  'src/lib/integrations-data/ai-agents.ts',
  'docs/integrations/mcp-clients/claude-code.md',
  'docs-src/partials/skills-usage-examples.html',
  'docs-src/partials/quick-start.html',
];

describe('SEC-44 — no hardcoded capability count on LLM-facing or generator-source surfaces', () => {
  for (const f of SURFACES) {
    it(`${f} carries no tool count`, () => {
      if (!existsSync(resolve(ROOT, f))) return;
      const hits = (read(f).match(TOOL_COUNT) ?? []).filter((h) => !/\b8\d\s+tools/i.test(h)); // OKX partner card
      expect(hits, `hardcoded capability count(s): ${hits.join(', ')}`).toEqual([]);
    });
  }

  it('llms-full.txt still documents the tools — the count went, the content did not', () => {
    const t = read('landing/llms-full.txt');
    expect(t).toContain('## The MCP Tools');
    expect(t).toMatch(/### \d+\. `get_trade_call`/);
  });

  it('llms.txt points at the live tool list instead of asserting a number', () => {
    expect(read('landing/llms.txt')).toMatch(/tools\/list/);
  });
});

describe('SEC-46 — the prose asset count is manifest-managed, not baked', () => {
  const manifest = JSON.parse(read('scripts/snapshot-landing-manifest.json'));
  const claim = manifest.claims.find((c: { id: string }) => c.id === 'jsonld-description-asset-count');

  it('a claim owns the JSON-LD description phrasing', () => {
    expect(claim, 'jsonld-description-asset-count missing').toBeDefined();
    expect(claim.accessor).toBe('asset_count');
    expect(claim.apply_to_files).toContain('docs-src/template.html');
  });

  it('its pattern matches the live literal in EVERY declared file (zero match = silent rot)', () => {
    // SCOPE CORRECTION: this row first listed only the GENERATOR SOURCE, so the injector patched a
    // file nobody serves while all five SERVED pages kept the stale literal — verified live after
    // deploy, /docs still read '850+ assets'. Binding the source is not binding the surface.
    for (const f of claim.apply_to_files) {
      expect(new RegExp(claim.find_pattern).test(read(f)), `CLAIM_MATCHED_ZERO in ${f}`).toBe(true);
    }
  });

  it('covers the SERVED pages, not just the generator source', () => {
    expect(claim.apply_to_files).toContain('landing/docs.html');
    expect(claim.apply_to_files.filter((f: string) => f.startsWith('landing/')).length).toBeGreaterThanOrEqual(5);
  });

  it('preserves the "+" floor semantics of the sentence', () => {
    expect(claim.replace_template).toContain('+');
  });

  it('quick-start no longer bakes an asset count at all', () => {
    expect(read('docs-src/partials/quick-start.html')).not.toMatch(/all \d+ assets/);
  });
});
