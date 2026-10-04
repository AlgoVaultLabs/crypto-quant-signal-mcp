/**
 * DESIGN-INTEGRATIONS-CARD-NESTED-ANCHOR-W1 R5 — the /integrations index cards are STRETCHED-LINK
 * cards, never an <a> inside an <a>.
 *
 * renderIndexCard() used to emit each card as an <a> and, for the 7 exchange kits with a demo,
 * put the Demo <a> inside it. HTML forbids an `a` descendant of `a`, so the parser closed the card
 * at the inner link and ejected its footer into the grid: the exchange-kit grid parsed to 20
 * children, not 13. These assertions run on the PARSED tree (jsdom = parse5, the tree-builder
 * Chrome uses), because the defect only exists after parsing — the source read fine.
 *
 * The page-level guard is scripts/check-card-markup.mjs (deploy.yml + prepublishOnly); this file
 * pins the generator itself. No test here spawns a process.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import MCP_CLIENTS from '../../src/lib/integrations-data/mcp-clients.js';
import AI_AGENTS from '../../src/lib/integrations-data/ai-agents.js';
import EXCHANGE_KITS from '../../src/lib/integrations-data/exchange-kits.js';
import { renderIndexGrid, EXCHANGE_DEMO_URL } from '../../src/lib/integrations-data/render.js';
import { nestedAnchors } from '../../scripts/check-card-markup.mjs';

type Surface = typeof MCP_CLIENTS;
const SURFACES: Array<[string, Surface]> = [
  ['mcp-clients', MCP_CLIENTS],
  ['ai-agents', AI_AGENTS],
  ['exchange-kits', EXCHANGE_KITS],
];

function parseGrid(surface: Surface): Document {
  return new JSDOM(`<!doctype html><body><div class="grid" id="g">${renderIndexGrid(surface)}</div></body>`).window.document;
}

const plausibleOnclick = (surfaceType: string, slug: string): string =>
  `if(window.plausible)plausible('Integration View',{props:{surface:'${surfaceType}',slug:'${slug}',source:'integrations_index',medium:'card'}})`;

describe.each(SURFACES)('renderIndexGrid(%s) — stretched-link cards', (_name, surface) => {
  const entries = surface.entries.filter((e) => e.hasDedicatedPage);
  const doc = parseGrid(surface);
  const kids = [...doc.getElementById('g')!.children];

  it('parses to exactly one top-level child per dedicated-page entry', () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(kids.length).toBe(entries.length);
  });

  it('every top-level child is a positioned div.card-hover', () => {
    for (const kid of kids) {
      expect(kid.tagName).toBe('DIV');
      expect(kid.classList.contains('card-hover')).toBe(true);
      expect(kid.classList.contains('relative')).toBe(true);
    }
  });

  it('no anchor is nested inside an anchor — in the SOURCE as well as the parsed tree', () => {
    // The DOM half alone can never fail: the parser REPAIRS a nested anchor (that repair is the
    // bug), so `a a` is empty even for the pre-fix template — measured by mutation. The source
    // half uses the gate's own tag-level scanner, so the two cannot disagree on what "nested" is.
    expect(nestedAnchors(renderIndexGrid(surface))).toEqual([]);
    expect(doc.querySelectorAll('a a').length).toBe(0);
  });

  it('a demo entry carries exactly 2 links (card-link, card-secondary); every other entry exactly 1', () => {
    entries.forEach((entry, i) => {
      const links = [...kids[i].querySelectorAll('a')];
      const demo = EXCHANGE_DEMO_URL[entry.slug];
      expect(links.length).toBe(demo ? 2 : 1);
      expect(links[0].classList.contains('card-link')).toBe(true);
      expect(links[0].getAttribute('href')).toBe(entry.fullTutorialUrl);
      if (demo) {
        expect(links[1].classList.contains('card-secondary')).toBe(true);
        expect(links[1].getAttribute('href')).toBe(demo);
        expect(links[1].hasAttribute('onclick')).toBe(false);
      }
      expect(kids[i].querySelectorAll('.card-link').length).toBe(1);
    });
  });

  it('the card-link carries the Plausible attribution event for its own slug', () => {
    entries.forEach((entry, i) => {
      const primary = kids[i].querySelector('a.card-link')!;
      expect(primary.getAttribute('onclick')).toBe(plausibleOnclick(entry.surfaceType, entry.slug));
    });
  });

  it('no stopPropagation and no Tailwind hover border — .card-hover:hover is the single hover source', () => {
    const html = renderIndexGrid(surface);
    expect(html).not.toContain('stopPropagation');
    expect(html).not.toContain('hover:border-mint-500/40');
  });
});

describe('EXCHANGE_DEMO_URL', () => {
  const dedicated = new Set(EXCHANGE_KITS.entries.filter((e) => e.hasDedicatedPage).map((e) => e.slug));

  it('every demo slug is a dedicated-page exchange kit (a secondary link never targets a card that is not rendered)', () => {
    for (const slug of Object.keys(EXCHANGE_DEMO_URL)) expect(dedicated.has(slug)).toBe(true);
  });

  it('the exchange-kit grid renders one .card-secondary per demo, and at least one', () => {
    const demos = Object.keys(EXCHANGE_DEMO_URL).filter((s) => dedicated.has(s)).length;
    expect(demos).toBeGreaterThan(0);
    expect(parseGrid(EXCHANGE_KITS).querySelectorAll('a.card-secondary').length).toBe(demos);
  });

  it('the MCP-client and AI-agent grids carry no secondary link', () => {
    expect(parseGrid(MCP_CLIENTS).querySelectorAll('.card-secondary').length).toBe(0);
    expect(parseGrid(AI_AGENTS).querySelectorAll('.card-secondary').length).toBe(0);
  });
});
