// NAV-PLATFORM-GENERATOR-W1 CH3 — /tools index page (registry-driven).
// Freezes: every nav Platform>Tools anchor resolves to a real card id (model anchors ⊆ page
// ids), one card per public tool, no equities/outcome leakage, valid standalone HTML with the
// nav region markers. Vitest .ts (not .mjs) to avoid the node:test double-run trap.
// Requires `npm run build` first (renderToolsPage imports compiled dist).
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderToolsPage } from '../scripts/build_tools_page.mjs';
import { publicToolEntries, navModelHrefs, buildNavModel } from '../src/lib/nav-manifest.js';

const html = (): string => renderToolsPage();
const ids = (h: string): Set<string> => new Set([...h.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]));

describe('CH3 AC — model anchors ⊆ page ids (the mega-menu Tools links all resolve)', () => {
  it('every publicToolEntry anchor exists as an id in tools.html', () => {
    const pageIds = ids(html());
    for (const e of publicToolEntries()) expect(pageIds.has(e.anchor)).toBe(true);
  });
  it('every /tools#<anchor> the nav model emits resolves to a page id', () => {
    const pageIds = ids(html());
    const navAnchors = navModelHrefs(buildNavModel())
      .filter((h) => h.startsWith('https://algovault.com/tools#'))
      .map((h) => h.split('#')[1]);
    expect(navAnchors.length).toBeGreaterThan(0);
    for (const a of navAnchors) expect(pageIds.has(a)).toBe(true);
  });
  it('renders exactly one card per public tool (6; equities held out)', () => {
    const doc = new JSDOM(html()).window.document;
    const cards = doc.querySelectorAll('.tools-card');
    expect(cards.length).toBe(publicToolEntries().length);
    expect(cards.length).toBe(6);
    // each card carries its canonical tool name in <code>
    const names = [...cards].map((c) => c.querySelector('code')?.textContent);
    expect(names).toEqual(publicToolEntries().map((e) => e.name));
  });
});

describe('CH3 Data-Integrity — no internal-metric leakage + equities held from the card grid', () => {
  it('the page never surfaces the internal outcome/phase-e fields (Data-Integrity gate)', () => {
    const s = html().toLowerCase();
    for (const f of ['outcome_return_pct', 'outcome_price', 'phase e']) expect(s).not.toContain(f);
  });
  it('NO equity tool is rendered as a card (equities public-copy HOLD, A4)', () => {
    // The card grid is crypto-only; equity tools are held. NB: the crypto tools' CANONICAL
    // descriptions cross-reference get_equity_* as functional routing hints — that is the live,
    // already-public description copy (tools/list · /capabilities · registry), not an equities
    // card/listing. The HOLD forbids featuring equities, which the card set enforces:
    const doc = new JSDOM(html()).window.document;
    const cardIds = [...doc.querySelectorAll('.tools-card')].map((c) => c.id);
    for (const held of ['get-equity-call', 'get-equity-regime']) expect(cardIds).not.toContain(held);
    expect(cardIds.some((id) => id.includes('equity'))).toBe(false);
  });
  it('the get_trade_signal alias is not surfaced as a card', () => {
    const doc = new JSDOM(html()).window.document;
    const names = [...doc.querySelectorAll('.tools-card code')].map((c) => c.textContent);
    expect(names).not.toContain('get_trade_signal');
  });
});

describe('CH3 — valid standalone page with nav region + footer', () => {
  it('is a full HTML doc with the nav markers + a nav + brand footer', () => {
    const h = html();
    expect(h.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(h).toContain('<head>');
    expect(h).toContain('<body>');
    expect(h).toContain('<!-- NAV:START -->');
    expect(h).toContain('<!-- NAV:END -->');
    expect(h).toContain('data-mobile-nav-toggle'); // nav baked between the markers
    expect(h).toContain('id="mobile-menu"');
    expect(h).toContain('https://algovault.com/tools'); // canonical
  });
  it('matches the landing design system (Tailwind mint config + design css)', () => {
    const h = html();
    expect(h).toContain('cdn.tailwindcss.com');
    expect(h).toContain("400: 'oklch(0.86 0.16 165)'"); // canonical mint-400 anchor
    expect(h).toContain('/_design/algovault-design.css');
  });
});
