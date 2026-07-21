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
  it('all 16 hasDedicatedPage:true slugs are unique across the union', () => {
    const dedicated = ALL_SURFACES.flatMap(({ mod }) =>
      mod.entries.filter((e) => e.hasDedicatedPage).map((e) => e.slug),
    );
    expect(new Set(dedicated).size).toBe(dedicated.length);
  });

  it('MCP_CLIENTS contains exactly 5 dedicated + 1 inline (plain-http)', () => {
    const dedicated = MCP_CLIENTS.entries.filter((e) => e.hasDedicatedPage);
    const inline = MCP_CLIENTS.entries.filter((e) => !e.hasDedicatedPage);
    expect(dedicated).toHaveLength(5);
    expect(inline).toHaveLength(1);
    expect(inline[0].slug).toBe('plain-http');
  });

  it('AI_AGENTS contains exactly 4 entries all with hasDedicatedPage:true', () => {
    expect(AI_AGENTS.entries).toHaveLength(4);
    for (const e of AI_AGENTS.entries) {
      expect(e.hasDedicatedPage, `${e.slug}`).toBe(true);
    }
  });

  it('EXCHANGE_KITS contains exactly 12 entries all with hasDedicatedPage:true', () => {
    expect(EXCHANGE_KITS.entries).toHaveLength(12);
    for (const e of EXCHANGE_KITS.entries) {
      expect(e.hasDedicatedPage, `${e.slug}`).toBe(true);
    }
  });
});
