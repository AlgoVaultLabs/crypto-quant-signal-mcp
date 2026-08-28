/**
 * Schema + content canaries for the 3 integration-data SoT files
 * (INTEGRATIONS-FULL-STACK-W1 C1 deliverable).
 *
 * Locks: required-field presence, slug uniqueness + kebab-case,
 * hasDedicatedPage:true entries have a fullTutorialUrl, no forbidden
 * phrases / wave IDs / internal-detail terms in any setupSummary /
 * whatYouGet / walkthroughHtml string.
 */

import { describe, it, expect } from 'vitest';
import type { IntegrationEntry, SurfaceModule } from '../../src/lib/integrations-data/types.js';
import MCP_CLIENTS from '../../src/lib/integrations-data/mcp-clients.js';
import AI_AGENTS from '../../src/lib/integrations-data/ai-agents.js';
import EXCHANGE_KITS from '../../src/lib/integrations-data/exchange-kits.js';

const ALL_SURFACES: Array<{ name: string; mod: SurfaceModule }> = [
  { name: 'mcp-clients', mod: MCP_CLIENTS },
  { name: 'ai-agents', mod: AI_AGENTS },
  { name: 'exchange-kits', mod: EXCHANGE_KITS },
];

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const FORBIDDEN_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'intelligence layer', pattern: /intelligence layer/i },
  { name: 'powerful', pattern: /\bpowerful\b/i },
  { name: 'seamless', pattern: /\bseamless\b/i },
  { name: 'robust', pattern: /\brobust\b/i },
  { name: 'cutting-edge', pattern: /cutting-edge/i },
  { name: 'industry-leading', pattern: /industry-leading/i },
  { name: 'Quant LLM', pattern: /Quant LLM/i },
  { name: 'wave-id pattern [A-Z]+-W<num>', pattern: /[A-Z]+-W\d+/ },
  { name: 'Binance-clone', pattern: /Binance-clone/i },
  { name: 'outcome_return_pct', pattern: /outcome_return_pct/ },
  { name: 'phase_e_', pattern: /phase_e_/i },
];

function contentFieldsOf(e: IntegrationEntry): string {
  return [e.setupSummary, e.whatYouGet, e.walkthroughHtml].join('\n');
}

describe('integrations-data: schema + uniqueness', () => {
  it('all 3 surface modules expose meta + entries', () => {
    for (const { name, mod } of ALL_SURFACES) {
      expect(mod.meta, `${name}.meta`).toBeDefined();
      expect(mod.entries, `${name}.entries`).toBeInstanceOf(Array);
      expect(mod.entries.length, `${name}.entries.length`).toBeGreaterThan(0);
    }
  });

  it('every entry has all required fields populated', () => {
    for (const { name, mod } of ALL_SURFACES) {
      for (const e of mod.entries) {
        const ctx = `${name}/${e.slug}`;
        expect(e.slug, `${ctx} slug`).toBeTruthy();
        expect(e.displayName, `${ctx} displayName`).toBeTruthy();
        expect(e.surfaceType, `${ctx} surfaceType`).toBeTruthy();
        expect(e.setupSummary, `${ctx} setupSummary`).toBeTruthy();
        expect(e.whatYouGet, `${ctx} whatYouGet`).toBeTruthy();
        expect(e.walkthroughHtml, `${ctx} walkthroughHtml`).toBeTruthy();
        expect(typeof e.hasDedicatedPage, `${ctx} hasDedicatedPage type`).toBe('boolean');
      }
    }
  });

  it('all slugs are unique within each surface and kebab-case', () => {
    for (const { name, mod } of ALL_SURFACES) {
      const slugs = mod.entries.map((e) => e.slug);
      expect(new Set(slugs).size, `${name} unique slugs`).toBe(slugs.length);
      for (const slug of slugs) {
        expect(KEBAB_CASE.test(slug), `${name}/${slug} kebab-case`).toBe(true);
      }
    }
  });

  it('hasDedicatedPage:true entries have a non-empty fullTutorialUrl', () => {
    for (const { name, mod } of ALL_SURFACES) {
      for (const e of mod.entries) {
        if (e.hasDedicatedPage) {
          expect(e.fullTutorialUrl, `${name}/${e.slug} fullTutorialUrl`).toMatch(
            /^\/integrations\/[a-z0-9-]+$|^https:\/\//,
          );
        }
      }
    }
  });

  it('surfaceType field matches the parent surface', () => {
    const expected: Record<string, IntegrationEntry['surfaceType']> = {
      'mcp-clients': 'mcp-client',
      'ai-agents': 'ai-agent',
      'exchange-kits': 'exchange-kit',
    };
    for (const { name, mod } of ALL_SURFACES) {
      const want = expected[name];
      for (const e of mod.entries) {
        expect(e.surfaceType, `${name}/${e.slug}`).toBe(want);
      }
    }
  });
});

describe('integrations-data: forbidden-phrase canary', () => {
  for (const { name, mod } of ALL_SURFACES) {
    for (const e of mod.entries) {
      it(`${name}/${e.slug} content is forbidden-clean`, () => {
        const content = contentFieldsOf(e);
        for (const { name: patName, pattern } of FORBIDDEN_PATTERNS) {
          expect(pattern.test(content), `${name}/${e.slug} contains forbidden "${patName}"`).toBe(
            false,
          );
        }
      });
    }
  }
});

describe('integrations-data: cross-surface invariants', () => {
  it('every hasDedicatedPage:true slug is unique across the union', () => {
    const dedicated = ALL_SURFACES.flatMap(({ mod }) =>
      mod.entries.filter((e) => e.hasDedicatedPage).map((e) => e.slug),
    );
    expect(new Set(dedicated).size).toBe(dedicated.length);
  });

  it('MCP_CLIENTS contains exactly 9 dedicated + 3 inline', () => {
    const dedicated = MCP_CLIENTS.entries.filter((e) => e.hasDedicatedPage);
    const inline = MCP_CLIENTS.entries.filter((e) => !e.hasDedicatedPage);
    expect(dedicated).toHaveLength(9);
    // plain-http (a transport), zai-api (server-side, nothing to install) and
    // deepseek (the bring-your-own-model path, not an install) each have no
    // /integrations/<slug> page. DeepSeek's own harness DOES have one, under the
    // separate `deepseek-harness` slug — the two are different products.
    expect(inline.map((e) => e.slug).sort()).toEqual(['deepseek', 'plain-http', 'zai-api']);
  });

  it('AI_AGENTS contains exactly 4 entries all with hasDedicatedPage:true', () => {
    expect(AI_AGENTS.entries).toHaveLength(4);
    for (const e of AI_AGENTS.entries) {
      expect(e.hasDedicatedPage, `${e.slug}`).toBe(true);
    }
  });

  it('EXCHANGE_KITS contains exactly 13 entries all with hasDedicatedPage:true', () => {
    // 12 → 13 (BINANCE-AGENT-OS-TRUTH-AND-PAGE-W1, 2026-08-25): +binance-agent-os, the first
    // exchange-kit tutorial sourced in-repo rather than from the algovault-skills checkout.
    expect(EXCHANGE_KITS.entries).toHaveLength(13);
    for (const e of EXCHANGE_KITS.entries) {
      expect(e.hasDedicatedPage, `${e.slug}`).toBe(true);
    }
  });
});

/**
 * LANDING-MCP-CLIENT-REGISTRY-W1 — provenance + factuality locks on the
 * mcp-clients surface.
 *
 * Scoped to mcp-clients deliberately: `kind`/`source`/`verifiedAt` are optional
 * trailing fields on the shared IntegrationEntry, adopted by this surface only.
 * Asserting them across all three surfaces would fail ai-agents/exchange-kits
 * for not having opted in, which is not a defect.
 */
const MCP_ENDPOINT = 'https://api.algovault.com/mcp';

/** Rendered text of a row, as a reader would see it: tags out, entities in. */
function renderedText(e: IntegrationEntry): string {
  return [e.setupSummary, e.whatYouGet, e.walkthroughSummary ?? '', e.walkthroughHtml]
    .join('\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&rarr;/g, '→')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&(?:#39|rsquo|apos);/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function wordCount(html: string): number {
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&rarr;/g, '→')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return text.split(/\s+/).filter(Boolean).length;
}

describe('mcp-clients: provenance (source + verifiedAt)', () => {
  it('is not empty — vacuity guard', () => {
    expect(MCP_CLIENTS.entries.length).toBeGreaterThan(0);
  });

  for (const e of MCP_CLIENTS.entries) {
    it(`${e.slug} carries an https source and a parseable verifiedAt`, () => {
      expect(e.source, `${e.slug} source`).toBeTruthy();
      expect(e.source!.startsWith('https://'), `${e.slug} source is https`).toBe(true);
      expect(e.verifiedAt, `${e.slug} verifiedAt`).toBeTruthy();
      expect(Number.isNaN(Date.parse(e.verifiedAt!)), `${e.slug} verifiedAt parseable`).toBe(false);
    });

    it(`${e.slug} setupSummary is <=20 words`, () => {
      expect(wordCount(e.setupSummary), `${e.slug} setupSummary word count`).toBeLessThanOrEqual(20);
    });
  }
});

describe('mcp-clients: retired Claude Desktop UI path', () => {
  // Claude Desktop moved custom MCP servers from Settings → Integrations to
  // Settings → Connectors. Both the literal arrow and the &rarr; entity forms
  // appear in this repo's HTML, so both are banned here.
  const RETIRED = [/Settings\s*→\s*Integrations/i, /Settings\s*&rarr;\s*Integrations/i];

  for (const e of MCP_CLIENTS.entries) {
    it(`${e.slug} names no retired UI path`, () => {
      const content = renderedText(e);
      for (const pattern of RETIRED) {
        expect(pattern.test(content), `${e.slug} matches ${pattern}`).toBe(false);
      }
    });
  }
});

describe('mcp-clients: ClientKind factuality', () => {
  it('every entry declares a kind, and each kind has at least one row', () => {
    // Vacuity guard: an empty bucket must not read as a pass.
    const kinds = MCP_CLIENTS.entries.map((e) => e.kind);
    for (const [i, k] of kinds.entries()) {
      expect(k, `${MCP_CLIENTS.entries[i].slug} kind`).toBeTruthy();
    }
    for (const want of ['native', 'api-level', 'byo-model'] as const) {
      expect(kinds.filter((k) => k === want).length, `rows with kind=${want}`).toBeGreaterThan(0);
    }
  });

  it('the two DeepSeek rows keep their distinct kinds', () => {
    // These are two different products and the distinction is the whole point of
    // the pair. `deepseek` is the bring-your-own-model path: point a harness you
    // already run at https://api.deepseek.com/anthropic and swap the model behind
    // it. `deepseek-harness` is DeepSeek's own agent runtime, which ships a
    // first-party MCP client (@deepseek-ai/dsh-mcp-client) and connects directly.
    //
    // This lock replaces one that asserted "DeepSeek ships no MCP application and
    // its API exposes no MCP parameter". The second clause is still true; the
    // first was true when written and false from 2026-08-10, and the lock was
    // holding the false half in place. Collapsing the two rows into one — in
    // either direction — is what this now forbids.
    const deepseek = MCP_CLIENTS.entries.find((e) => e.slug === 'deepseek');
    expect(deepseek, 'deepseek row present').toBeDefined();
    expect(deepseek!.kind).toBe('byo-model');

    const harness = MCP_CLIENTS.entries.find((e) => e.slug === 'deepseek-harness');
    expect(harness, 'deepseek-harness row present').toBeDefined();
    expect(harness!.kind).toBe('native');
  });

  it('no byo-model row describes itself as an MCP client', () => {
    const byoModel = MCP_CLIENTS.entries.filter((e) => e.kind === 'byo-model');
    expect(byoModel.length, 'byo-model rows exist (vacuity guard)').toBeGreaterThan(0);
    for (const e of byoModel) {
      expect(/MCP client/i.test(renderedText(e)), `${e.slug} calls itself an MCP client`).toBe(
        false,
      );
    }
  });
});

describe('mcp-clients: endpoint literal', () => {
  // Not "every row shows the endpoint" — plain-http legitimately demonstrates
  // /health, and the byo-model row's first URL is the vendor's. The invariant
  // is narrower and it is the one that actually matters: wherever a row prints
  // an AlgoVault MCP URL, it is the canonical one. A row inventing
  // algovault.com/mcp on a different host or scheme is the failure.
  const MCP_URL_RE = /https?:\/\/[^\s"'<)]*algovault[^\s"'<)]*\/mcp\b/gi;

  it('every AlgoVault MCP URL across the surface is the canonical endpoint', () => {
    const found: Array<{ slug: string; url: string }> = [];
    for (const e of MCP_CLIENTS.entries) {
      for (const url of renderedText(e).match(MCP_URL_RE) ?? []) {
        found.push({ slug: e.slug, url });
      }
    }
    expect(found.length, 'MCP URLs found across the surface (vacuity guard)').toBeGreaterThan(0);
    for (const { slug, url } of found) {
      expect(url.startsWith(MCP_ENDPOINT), `${slug} prints non-canonical MCP URL: ${url}`).toBe(
        true,
      );
    }
  });
});
