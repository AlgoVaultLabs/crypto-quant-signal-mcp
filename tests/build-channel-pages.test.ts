// CHANNEL-HUB-PAGES-GEO-W1 CH2 — the 3 generated hub pages (GEO structure + verbatim reuse + JSON-LD).
// Vitest .ts (not the spec's .mjs) to avoid the node:test/vitest double-run trap. Requires
// `npm run build && node scripts/build_channel_pages.mjs` first (the gate does both).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { CHANNELS, hostedChannels, channelToolCoverage, channelHref } from '../src/lib/channel-registry.js';
import { FREE_MONTHLY_CALLS, planCallsLabel } from '../src/lib/plans.js';
import { buildNavModel, type NavDropdown } from '../src/lib/nav-manifest.js';
import { existsSync } from 'node:fs';

const ROOT = process.cwd();
const page = (slug: string): string => readFileSync(join(ROOT, 'landing', `${slug}.html`), 'utf8');
const docs = (): string => readFileSync(join(ROOT, 'landing', 'docs.html'), 'utf8');
const wordCount = (html: string): number => new JSDOM(html).window.document.body.textContent!.trim().split(/\s+/).length;

describe('CH2 — 3 substantial GEO-structured pages', () => {
  for (const c of hostedChannels()) {
    it(`/${c.slug}: ≥500 words, ≤60-word summary block, self-answering H2s`, () => {
      const h = page(c.slug);
      expect(wordCount(h)).toBeGreaterThanOrEqual(500);
      const doc = new JSDOM(h).window.document;
      const summary = doc.querySelector('.ch-summary')!;
      expect(summary).toBeTruthy();
      expect(summary.textContent!.trim().split(/\s+/).length).toBeLessThanOrEqual(60);
      const h2s = [...doc.querySelectorAll('h2')].map((e) => e.textContent!.toLowerCase());
      expect(h2s.some((t) => t.includes('when to use'))).toBe(true);
      expect(h2s.some((t) => t.includes('connect'))).toBe(true);
      expect(h2s.some((t) => t.includes('tool coverage'))).toBe(true);
      expect(h2s.some((t) => t.includes('question'))).toBe(true);
    });
    it(`/${c.slug}: carries the injected nav region markers + a nav`, () => {
      const h = page(c.slug);
      expect(h).toContain('<!-- NAV:START -->');
      expect(h).toContain('<!-- NAV:END -->');
      expect(h).toContain('data-mobile-nav-toggle');
    });
  }
});

describe('CH2 — verbatim code reuse from docs (Rule 3, source don’t invent)', () => {
  for (const c of hostedChannels()) {
    // DOCS-COMPLETENESS-AND-NAVIGATION-W1 CH2 widened this from "the first <pre> is verbatim" to
    // "the WHOLE projected slice is verbatim". The INTENT is unchanged and is what the describe
    // text above still states: a channel page never diverges from docs.html. The projection
    // satisfies it MORE strongly than the excerpt did — the excerpt could only be verbatim about
    // the one block it kept, and was silent about the two tables it dropped.
    it(`/${c.slug}: every projected slice is a byte-identical substring of its docs section`, async () => {
      const h = page(c.slug);
      const d = docs();
      const { extractSection } = await import('../scripts/build_channel_pages.mjs');
      expect(c.docsAnchors.length).toBeGreaterThan(0);
      for (const anchor of c.docsAnchors) {
        const slice = extractSection(d, anchor);
        expect(slice, `${anchor} extracts nothing`).toBeTruthy();
        expect(d.includes(slice), `${anchor} slice is not verbatim from docs.html`).toBe(true);
        expect(h.includes(slice), `${anchor} slice is not present on /${c.slug}`).toBe(true);
      }
    });

    it(`/${c.slug}: ≥1 <pre> code block, verbatim from a docs section`, () => {
      const h = page(c.slug);
      const pres = [...h.matchAll(/<pre[\s\S]*?<\/pre>/g)].map((m) => m[0]);
      expect(pres.length).toBeGreaterThanOrEqual(1);
      const d = docs();
      // every code block on the page must appear byte-for-byte in docs.html (not invented)
      for (const pre of pres) expect(d.includes(pre)).toBe(true);
    });

    // The completeness half, which is the whole point of the chapter: /rest-api carried 0 tables
    // while its docs section carried 2, and no upstream edit could have fixed that.
    it(`/${c.slug}: carries every <table> and <pre> its docs sections carry`, async () => {
      const h = page(c.slug);
      const d = docs();
      const { extractSection } = await import('../scripts/build_channel_pages.mjs');
      const dropped: string[] = [];
      for (const anchor of c.docsAnchors) {
        const slice = extractSection(d, anchor) ?? '';
        for (const block of [...slice.matchAll(/<table[\s\S]*?<\/table>/g), ...slice.matchAll(/<pre[\s\S]*?<\/pre>/g)]) {
          if (!h.includes(block[0])) dropped.push(`${anchor}: ${block[0].slice(0, 60)}`);
        }
      }
      expect(dropped).toEqual([]);
    });
  }
  it('A1 — /mcp reuses the MCP config + curl block; /rest-api reuses x402 (NOT the MCP handshake as its method)', () => {
    const mcp = page('mcp');
    expect(mcp).toMatch(/mcpServers/); // #connect-mcp config
    // DOCS-SAMPLE-EXECUTABLE-W1: the matcher moved from /initialize/ to the ONE-SHOT block, and
    // the reason is the point of this wave. The transport is stateless, so the first <pre> in
    // #testing-with-curl is now a single `tools/call` POST with no handshake — and
    // build_channel_pages extracts exactly that first block, so `initialize` no longer reaches
    // this page at all. The INTENT is unchanged and is what this line still asserts: /mcp reuses
    // the MCP-over-HTTP curl block from docs.html rather than inventing its own.
    expect(mcp).toMatch(/"method":\s*"tools\/call"/); // #testing-with-curl one-shot MCP-over-HTTP call
    expect(mcp).toMatch(/text\/event-stream/);        // …carrying both required Accept types
    const rest = page('rest-api');
    expect(rest).toMatch(/x402-fetch|wrapFetchWithPayment/); // #x402 keyless pay-per-call
    // the REST connect CODE must be the x402 block, not the MCP initialize handshake
    const restConnectCode = [...rest.matchAll(/<pre[\s\S]*?<\/pre>/g)].map((m) => m[0]).join('\n');
    expect(restConnectCode).not.toMatch(/Mcp-Session-Id|"method":\s*"initialize"/);
  });
});

describe('CH2 — Data-Integrity + registry-derived coverage', () => {
  for (const c of hostedChannels()) {
    it(`/${c.slug}: no equities-internal / outcome_* leakage`, () => {
      const s = page(c.slug).toLowerCase();
      for (const f of ['outcome_return_pct', 'outcome_price', 'phase e']) expect(s).not.toContain(f);
    });
    it(`/${c.slug}: no baked track-record numbers (WR% / big call counts) in AUTHORED prose`, async () => {
      const doc = new JSDOM(page(c.slug)).window.document;
      // strip nav + code + footer; check the article prose only
      doc.querySelectorAll('nav, script, pre, footer').forEach((e) => e.remove());
      const wrap = doc.querySelector('.ch-wrap')!;
      // DOCS-COMPLETENESS-AND-NAVIGATION-W1 CH2. The `.ch-section` region is a byte-identical
      // projection of docs.html — asserted above, which is what EARNS this exclusion rather than
      // assuming it — and docs.html carries its own numerical-citation guards. Re-checking it here
      // with a cruder instrument only produces false positives: measured, the digits it objects to
      // are `300` (a cache max-age), `402`/`400` (HTTP statuses) and `200`/`100` (call limits).
      wrap.querySelectorAll('.ch-section').forEach((e) => e.remove());
      const prose = wrap.textContent!;
      expect(prose).not.toMatch(/\d+(\.\d+)?\s*%/);
      // Every remaining 3+ digit figure must TRACE to a declared source. That is strictly stronger
      // than the blanket ban it replaces: a baked `494,855` still fails, and a quoted plan limit now
      // has to PROVE it came from the pricing SoT instead of merely looking plausible.
      const { ERROR_CONTRACT } = await import('../scripts/check-docs-samples-live.mjs');
      const sourced = new Set<string>([
        String(FREE_MONTHLY_CALLS),
        planCallsLabel('starter'),
        planCallsLabel('pro'),
        ...ERROR_CONTRACT.map((r: { code: number }) => String(Math.abs(r.code))),
      ]);
      const unsourced = [...new Set(prose.match(/\b[\d,]{3,}\b/g) ?? [])].filter((n) => !sourced.has(n));
      expect(unsourced, 'figures with no declared source').toEqual([]);
    });
    it(`/${c.slug}: tool-coverage list === channelToolCoverage (registry-derived, no equities)`, () => {
      const doc = new JSDOM(page(c.slug)).window.document;
      const ul = doc.querySelector('.ch-coverage')!;
      const anchors = [...ul.querySelectorAll('a')].map((a) => a.getAttribute('href')!.split('#')[1]);
      const expected = channelToolCoverage(c).map((n) => n.replace(/_/g, '-'));
      expect(anchors).toEqual(expected);
      expect(anchors.some((a) => a.includes('equity'))).toBe(false);
    });
  }
});

describe('CH5 — single-derivation invariant: nav slugs === page slugs === docs anchors', () => {
  const navChannels = () =>
    (buildNavModel().groups.find((g): g is NavDropdown => g.kind === 'dropdown' && g.label === 'Platform') as NavDropdown)
      .columns!.find((c) => c.title === 'Channels')!;
  it('nav Channels hosted destinations === /<slug> for every hosted channel', () => {
    const hostedHrefs = hostedChannels().map((c) => channelHref(c));
    const navHosted = navChannels().items.map((i) => i.href).filter((h) => h.startsWith('https://algovault.com/') && !h.includes('/docs'));
    expect(navHosted.sort()).toEqual(hostedHrefs.sort());
  });
  it('every hosted slug has a generated page file AND a docs #<slug> anchor', () => {
    const docsHtml = docs();
    for (const c of hostedChannels()) {
      expect(existsSync(join(ROOT, 'landing', `${c.slug}.html`))).toBe(true);
      expect(docsHtml).toContain(`id="${c.slug}"`);
    }
  });
  it('the hosted slug set is exactly {mcp, rest-api, webhooks}; telegram is external (no slug/page)', () => {
    expect(hostedChannels().map((c) => c.slug).sort()).toEqual(['mcp', 'rest-api', 'webhooks']);
    const tg = CHANNELS.find((c) => c.key === 'telegram')!;
    expect(tg.slug).toBeUndefined();
    expect(existsSync(join(ROOT, 'landing', 'telegram.html'))).toBe(false);
  });
});

describe('CH2 — JSON-LD (TechArticle + FAQPage + Organization @id, schema.org-validated)', () => {
  for (const c of hostedChannels()) {
    it(`/${c.slug}: valid TechArticle + FAQPage (FAQ === SoT) + Organization @id ref`, () => {
      const h = page(c.slug);
      const block = (name: string) => {
        const m = h.match(new RegExp(`data-algovault-jsonld="${name}">\\s*([\\s\\S]*?)\\s*</script>`));
        return m ? JSON.parse(m[1]) : null;
      };
      const tech = block('TechArticle');
      expect(tech['@type']).toBe('TechArticle');
      expect(tech.url).toBe(`https://algovault.com/${c.slug}`);
      expect(tech.publisher['@id']).toBe('https://algovault.com/#organization');
      const faq = block('FAQPage');
      expect(faq['@type']).toBe('FAQPage');
      expect(faq.mainEntity.map((q: any) => q.name)).toEqual(c.faq.map((f) => f.q)); // FAQ single-sourced from the SoT
      expect(block('Organization')['@id']).toBe('https://algovault.com/#organization');
    });
  }
});
