// NAV-PLATFORM-GENERATOR-W1 CH2 — renderSiteNav() shared generator (the ONE nav renderer).
// Guards (a) whole-nav byte-equivalence vs the frozen oracle fixture (so an unintended nav
// change can never silently ship — regenerate tests/fixtures/site-nav.html on a deliberate
// change), and (b) the controller behavior (mobile hamburger + Platform/Track-Record dropdown
// + mobile accordion + a11y) via jsdom. renderSiteNav() is arg-less: one byte-identical region
// for every surface (absolute hrefs; current-page highlight applied client-side).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import { renderSiteNav } from '../src/lib/site-nav.js';

const fx = (n: string): string => readFileSync(join(process.cwd(), 'tests', 'fixtures', n), 'utf8');
const NAV_OPEN =
  '<nav class="fixed top-0 w-full z-50 border-b border-white/5" style="background:rgba(6,10,20,0.85);backdrop-filter:blur(12px)">';
const BRAND = '<a href="https://algovault.com/" class="flex items-center gap-2.5" aria-label="AlgoVault home">';

describe('renderSiteNav — whole-nav byte-equivalence (frozen oracle)', () => {
  it('is byte-identical to the frozen tests/fixtures/site-nav.html oracle', () => {
    expect(renderSiteNav()).toBe(fx('site-nav.html'));
  });
  it('preserves the nav wrapper + brand block verbatim', () => {
    const html = renderSiteNav();
    expect(html).toContain(NAV_OPEN);
    expect(html).toContain(BRAND);
    expect(html).toContain('AlgoVault Labs');
  });
});

describe('renderSiteNav — Platform mega-menu + Track Record dropdown + mobile chrome', () => {
  const html = renderSiteNav();
  it('desktop bar carries the parity signature + Platform mega + Track Record dropdown', () => {
    expect(html).toContain('hidden sm:flex items-center gap-6'); // check_mobile_nav_parity.sh signature
    expect(html).toContain('aria-controls="nav-platform-panel"');
    expect(html).toContain('aria-controls="nav-track-record-panel"');
    expect(html).toContain('w-[640px]'); // 3-col mega panel
  });
  it('carries the hamburger + #mobile-menu drawer + accordions + controller', () => {
    expect(html).toContain('data-mobile-nav-toggle');
    expect(html).toContain('id="mobile-menu"');
    expect(html).toContain('data-mobile-nav-panel');
    expect(html).toContain('aria-controls="mobile-menu"');
    expect(html).toContain('data-nav-accordion-toggle');
    expect(html).toContain('NAV-PLATFORM-GENERATOR-W1 controller');
    expect(html).toMatch(/w-11 h-11/); // ≥44px WCAG 2.5.5 touch target
    expect(html).toContain('bg-mint-500/15'); // Signup CTA reuses the mint accent
  });
  it('Verify stays reachable (Track Record dropdown) — no data-loss', () => {
    expect(html).toMatch(/nav-track-record-panel[\s\S]*href="https:\/\/algovault\.com\/verify"[\s\S]*Verify/);
  });
});

function mount() {
  const errors: string[] = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e: Error) => errors.push(e.message));
  const dom = new JSDOM(`<!doctype html><html><body>${renderSiteNav()}</body></html>`, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window: w } = dom;
  const d = w.document;
  const toggle = d.querySelector('[data-mobile-nav-toggle]') as HTMLElement;
  const panel = d.getElementById('mobile-menu') as HTMLElement;
  const click = (el: Element): void => {
    el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  return { w, d, toggle, panel, errors, click, isOpen: () => !panel.classList.contains('hidden') };
}

describe('renderSiteNav — mobile controller behavior (jsdom)', () => {
  it('toggle opens/closes, syncs aria + icon, closes on Escape / outside / link', () => {
    const { w, d, toggle, panel, errors, click, isOpen } = mount();
    const iconOpen = toggle.querySelector('[data-mobile-nav-icon-open]') as HTMLElement;
    const iconClose = toggle.querySelector('[data-mobile-nav-icon-close]') as HTMLElement;

    expect(isOpen()).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    click(toggle); // open
    expect(isOpen()).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Close menu');
    expect(iconOpen.classList.contains('hidden')).toBe(true);
    expect(iconClose.classList.contains('hidden')).toBe(false);

    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' })); // Escape closes
    expect(isOpen()).toBe(false);

    click(toggle);
    click(d.body); // outside-nav click closes
    expect(isOpen()).toBe(false);

    click(toggle);
    click(panel.querySelector('a') as Element); // panel-link click closes
    expect(isOpen()).toBe(false);

    expect(errors).toEqual([]);
  });
});

describe('renderSiteNav — desktop dropdown + mobile accordion behavior (jsdom)', () => {
  it('a desktop dropdown opens on click, syncs aria-expanded, closes on Escape', () => {
    const { w, d, click } = mount();
    const toggle = d.querySelector('[data-nav-dropdown-toggle]') as HTMLElement;
    const panel = d.getElementById(toggle.getAttribute('aria-controls')!) as HTMLElement;
    expect(panel.classList.contains('hidden')).toBe(true);
    click(toggle);
    expect(panel.classList.contains('hidden')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(panel.classList.contains('hidden')).toBe(true);
  });
  it('opening a second dropdown closes the first (single-open)', () => {
    const { d, click } = mount();
    const toggles = [...d.querySelectorAll('[data-nav-dropdown-toggle]')] as HTMLElement[];
    expect(toggles.length).toBeGreaterThanOrEqual(2);
    const p0 = d.getElementById(toggles[0].getAttribute('aria-controls')!) as HTMLElement;
    const p1 = d.getElementById(toggles[1].getAttribute('aria-controls')!) as HTMLElement;
    click(toggles[0]);
    expect(p0.classList.contains('hidden')).toBe(false);
    click(toggles[1]);
    expect(p0.classList.contains('hidden')).toBe(true);
    expect(p1.classList.contains('hidden')).toBe(false);
  });
  it('a mobile accordion expands its panel on click', () => {
    const { d, click } = mount();
    const acc = d.querySelector('[data-nav-accordion-toggle]') as HTMLElement;
    const panel = d.getElementById(acc.getAttribute('aria-controls')!) as HTMLElement;
    expect(panel.classList.contains('hidden')).toBe(true);
    click(acc);
    expect(panel.classList.contains('hidden')).toBe(false);
    expect(acc.getAttribute('aria-expanded')).toBe('true');
  });
});
