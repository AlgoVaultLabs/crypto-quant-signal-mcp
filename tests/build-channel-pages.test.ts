// CHANNEL-HUB-PAGES-GEO-W1 CH2 — the 3 generated hub pages (GEO structure + verbatim reuse + JSON-LD).
// Vitest .ts (not the spec's .mjs) to avoid the node:test/vitest double-run trap. Requires
// `npm run build && node scripts/build_channel_pages.mjs` first (the gate does both).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { CHANNELS, hostedChannels, channelToolCoverage, channelHref } from '../src/lib/channel-registry.js';
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
    it(`/${c.slug}: ≥1 <pre> code block, verbatim from a docs section`, () => {
      const h = page(c.slug);
      const pres = [...h.matchAll(/<pre[\s\S]*?<\/pre>/g)].map((m) => m[0]);
      expect(pres.length).toBeGreaterThanOrEqual(1);
      const d = docs();
      // every code block on the page must appear byte-for-byte in docs.html (not invented)
      for (const pre of pres) expect(d.includes(pre)).toBe(true);
    });
  }
  it('A1 — /mcp reuses the MCP config + handshake; /rest-api reuses x402 (NOT the MCP handshake as its method)', () => {
    const mcp = page('mcp');
    expect(mcp).toMatch(/mcpServers/); // #connect-mcp config
    expect(mcp).toMatch(/initialize/); // #testing-with-curl MCP-over-HTTP handshake
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
    it(`/${c.slug}: no baked track-record numbers (WR% / big call counts) in prose`, () => {
      const doc = new JSDOM(page(c.slug)).window.document;
      // strip nav + code + footer; check the article prose only
      doc.querySelectorAll('nav, script, pre, footer').forEach((e) => e.remove());
      const prose = doc.querySelector('.ch-wrap')!.textContent!;
      expect(prose).not.toMatch(/\d+(\.\d+)?\s*%/);
      expect(prose).not.toMatch(/\b\d{3,}\b/);
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
