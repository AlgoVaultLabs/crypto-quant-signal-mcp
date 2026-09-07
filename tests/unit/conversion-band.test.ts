// CONVERSION-SURFACES-W2 CH3 — the conversion band: who gets it, who must not, and the two
// properties that make "every page has a door" structural rather than aspirational.
//
// 63% of visitors (449 of 713 over 28d) enter on a page that ends with nothing to do. The band
// rides the brand-footer generator because that is the one path already proven to reach every
// page — glob-derived static injection plus the same function on every server-rendered surface.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  renderConversionBand,
  renderConversionBandRegion,
  isBandExcludedPath,
  isBandExcludedRoute,
  CONVERSION_BAND_EXCLUDE,
  CONVERSION_BAND_START,
  CONVERSION_BAND_END,
} from '../../src/lib/footer-content.js';
import { applyBand, routeForPath } from '../../scripts/inject-footer.mjs';

const ROOT = process.cwd();
const LANDING = join(ROOT, 'landing');

function htmlFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) htmlFiles(p, out);
    else if (name.endsWith('.html')) out.push(relative(ROOT, p));
  }
  return out;
}

describe('conversion band — the exclusion list is DATA, in two key spaces', () => {
  it('carries both key spaces, because the two render paths see different identifiers', () => {
    expect(CONVERSION_BAND_EXCLUDE.paths.length).toBeGreaterThan(0);
    expect(CONVERSION_BAND_EXCLUDE.routes.length).toBeGreaterThan(0);
  });

  it('excludes the landing page, the legal pages and the template', () => {
    for (const p of ['landing/index.html', 'landing/privacy.html', 'landing/terms.html', 'landing/_templates/answer-page.template.html']) {
      expect(isBandExcludedPath(p)).toBe(true);
    }
    expect(isBandExcludedPath('landing/verify.html')).toBe(false);
    expect(isBandExcludedPath('landing/integrations/cline.html')).toBe(false);
  });

  it('excludes the transactional, legal and operator ROUTES', () => {
    for (const r of ['/', '/welcome', '/account', '/signup', '/contact', '/privacy', '/terms', '/referral', '/referral-terms', '/join', '/dashboard']) {
      expect(isBandExcludedRoute(r), r).toBe(true);
    }
    for (const r of ['/track-record', '/carry-tracker', '/verify', '/docs', '/integrations/cline']) {
      expect(isBandExcludedRoute(r), r).toBe(false);
    }
  });

  it('normalises a trailing slash and a query string before deciding', () => {
    expect(isBandExcludedRoute('/welcome/')).toBe(true);
    expect(isBandExcludedRoute('/welcome?utm_source=x')).toBe(true);
    expect(isBandExcludedRoute('/track-record/')).toBe(false);
  });

  it('renders NOTHING for an excluded route, so callers can interpolate unconditionally', () => {
    expect(renderConversionBand({ route: '/welcome' })).toBe('');
    expect(renderConversionBandRegion({ route: '/dashboard' })).toBe('');
    expect(renderConversionBand({ route: '/verify' })).not.toBe('');
  });
});

describe('conversion band — coverage over the committed artifact', () => {
  const files = htmlFiles(LANDING);
  const has = (f: string) => readFileSync(join(ROOT, f), 'utf8').includes('data-conversion-band');

  it('the corpus is non-empty — an empty glob would make the two assertions below vacuous', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('every non-excluded landing page carries a band — ONE PER ARTBOARD, not one per page', () => {
    const missing = files.filter((f) => !isBandExcludedPath(f) && !f.includes('_design/') && !has(f));
    expect(missing).toEqual([]);
    for (const f of files.filter((x) => !isBandExcludedPath(x) && !x.includes('_design/'))) {
      const html = readFileSync(join(ROOT, f), 'utf8');
      // Count the ELEMENT, not the attribute token: the band ships its own scoped stylesheet
      // whose selectors are keyed to `[data-conversion-band]`, so a token count reads 10 for one
      // band.
      const bands = (html.match(/<section data-conversion-band/g) ?? []).length;
      const footers = (html.match(/<footer\s+data-av-brand-footer=/g) ?? []).length;
      // A DUAL-RENDERED page (landing/how-it-works.html) ships two artboards swapped by an
      // @media rule with a footer inside each. One band per PAGE would land inside the desktop
      // artboard and be display:none below 768px — the dead-below-768px class CH2 just retired,
      // reproduced by the band itself. Only one artboard renders, so a visitor still sees one.
      expect(bands, f).toBe(footers);
      expect(bands, f).toBeGreaterThanOrEqual(1);
    }
  });

  it('no excluded page carries one', () => {
    expect(CONVERSION_BAND_EXCLUDE.paths.filter((f) => has(f))).toEqual([]);
  });

  it('the band sits ABOVE the brand footer on every page that has both', () => {
    for (const f of files.filter((x) => !isBandExcludedPath(x) && !x.includes('_design/'))) {
      const h = readFileSync(join(ROOT, f), 'utf8');
      expect(h.indexOf('data-conversion-band'), f).toBeLessThan(h.indexOf('data-av-brand-footer'));
    }
  });
});

describe('conversion band — the injector pass is idempotent and reversible', () => {
  const markers = { start: CONVERSION_BAND_START, end: CONVERSION_BAND_END };
  const render = (route: string) => renderConversionBandRegion({ route });
  const page = (extra = '') =>
    `<html><body><main>x</main>${extra}<footer data-av-brand-footer="desktop">f</footer></body></html>`;

  it('inserts once, then replaces in place — a second run is byte-identical', () => {
    const once = applyBand(page(), 'landing/verify.html', render, isBandExcludedPath, markers);
    expect(once.action).toBe('inserted');
    const twice = applyBand(once.html, 'landing/verify.html', render, isBandExcludedPath, markers);
    expect(twice.action).toBe('replaced');
    expect(twice.html).toBe(once.html);
    expect((once.html.match(/<section data-conversion-band/g) ?? []).length).toBe(1);
  });

  it('REMOVES an existing band when the page joins the exclusion list', () => {
    const banded = applyBand(page(), 'landing/verify.html', render, isBandExcludedPath, markers).html;
    const cleaned = applyBand(banded, 'landing/index.html', render, isBandExcludedPath, markers);
    expect(cleaned.action).toBe('removed');
    expect(cleaned.html).not.toContain('data-conversion-band');
  });

  it('does nothing at all on an excluded page that never had one', () => {
    const r = applyBand(page(), 'landing/terms.html', render, isBandExcludedPath, markers);
    expect(r.action).toBe('none');
    expect(r.html).toBe(page());
  });

  it('maps a repo path to the route the band is keyed on', () => {
    expect(routeForPath('landing/index.html')).toBe('/');
    expect(routeForPath('landing/verify.html')).toBe('/verify');
    expect(routeForPath('landing/integrations/cline.html')).toBe('/integrations/cline');
  });
});

describe('conversion band — tagging', () => {
  const band = renderConversionBand({ route: '/integrations/cline' });

  it('tags all three controls as CTA Click with location=band', () => {
    expect((band.match(/plausible-event-name=CTA\+Click/g) ?? []).length).toBe(3);
    expect((band.match(/plausible-event-location=band/g) ?? []).length).toBe(3);
    for (const cta of ['quickstart', 'telegram', 'pricing']) {
      expect(band).toContain(`plausible-event-cta=${cta}`);
    }
  });

  it('stamps the page so the readout can rank doors BY PAGE', () => {
    expect(band).toContain('plausible-event-page=integrations.cline');
    expect(renderConversionBand({ route: '/track-record' })).toContain('plausible-event-page=track-record');
  });

  it('emits page tokens the class-token grammar can carry — no spaces, no quotes', () => {
    for (const r of ['/verify', '/integrations/binance-agent-os', '/how-it-works', '/track-record']) {
      const tok = (renderConversionBand({ route: r }).match(/plausible-event-page=([^\s"]+)/) ?? [])[1];
      expect(tok, r).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });

  it('keeps the external Telegram link safe (tabnabbing discipline)', () => {
    expect(band).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it('ships its own ordering rules, because /carry-tracker loads neither Tailwind nor the design CSS', () => {
    expect(band).toContain('@media (max-width:639px)');
    expect(band).toContain('.avcb-b{order:1}');
    expect(band).toContain('.avcb-a{order:2}');
    // every colour has a literal fallback for the surfaces that define no tokens
    expect(band).toContain('var(--fg, #e6edf3)');
    expect(band).toContain('var(--line, #30363d)');
  });

  it('gives every control a >=44px touch target', () => {
    expect((band.match(/min-height:44px/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
