/**
 * DESIGN-SURFACE-TOKENS-W1 CH1 — the injector.
 *
 * The property that matters most here is NEGATIVE: the migration must not touch anything
 * between the two Tailwind tags. Measured in Plan Mode, the CDN tag and the `tailwind.config`
 * script are adjacent in 0 of 56 pages — the canonical design loader sits between them on every
 * one, and on the 26 integration sub-pages the gap also holds track-record-proxy, JSON-LD and
 * the whole ANALYTICS region. A span replace (the shape the first spec asked for) would have
 * deleted all of it, starting with the stylesheet the region's own variables come from.
 */
import { describe, it, expect } from 'vitest';
import {
  THEME_START,
  THEME_END,
  applyRegion,
  migrateLegacyBlock,
  findConfigBlocks,
  escapeClass,
  PALETTE_CLASS_RE,
} from '../../scripts/build_theme.mjs';

const REGION = '<script src="https://cdn.tailwindcss.com/3.4.17"></script>\n<script>\ntailwind.config = { x: 1 }\n</script>';
const LEGACY_CONFIG = `<script>
tailwind.config = {
  theme: { extend: { colors: { navy: { 900: '#0${'6'}0a14' } } } }
}
</script>`;

const page = (between: string, config = LEGACY_CONFIG) => `<!DOCTYPE html><html><head>
<script src="https://cdn.tailwindcss.com"></script>
${between}${config}
</head><body>x</body></html>
`;

const LOADER = `<!-- BEGIN: AlgoVault canonical design loader (DESIGN-W2 / D2-C) -->
<link rel="stylesheet" href="/_design/algovault-design.css">
<!-- END: AlgoVault canonical design loader -->
`;

describe('build_theme: applyRegion', () => {
  it('is idempotent and never doubles a marker', () => {
    const html = `<head>\n${THEME_START}\nOLD\n${THEME_END}\n</head>`;
    const once = applyRegion(html, REGION).html;
    const twice = applyRegion(once, REGION).html;
    expect(twice).toBe(once);
    expect(once.split(THEME_START)).toHaveLength(2);
    expect(once.split(THEME_END)).toHaveLength(2);
    expect(once).toContain(REGION);
    expect(once).not.toContain('OLD');
  });

  it('reports marked=false on a page with no markers, leaving it untouched', () => {
    const html = '<head></head>';
    expect(applyRegion(html, REGION)).toEqual({ marked: false, html });
  });
});

describe('build_theme: migrateLegacyBlock', () => {
  it('migrating then applying equals applying to an already-marked twin', () => {
    const migrated = migrateLegacyBlock(page(LOADER), REGION);
    expect(migrated.ok).toBe(true);
    const marked = page(LOADER, `${THEME_START}\nOLD REGION\n${THEME_END}`).replace(
      '<script src="https://cdn.tailwindcss.com"></script>\n',
      '',
    );
    expect(migrated.html).toBe(applyRegion(marked, REGION).html);
  });

  it('PRESERVES every block sitting between the two tags', () => {
    const between = `${LOADER}<script defer src="/js/track-record-proxy.js"></script>
<script type="application/ld+json">{"@context":"https://schema.org"}</script>
<!-- ANALYTICS:START -->
<script async src="/js/insights.js"></script>
<!-- ANALYTICS:END -->
`;
    const { ok, html } = migrateLegacyBlock(page(between), REGION);
    expect(ok).toBe(true);
    for (const needle of [
      '<link rel="stylesheet" href="/_design/algovault-design.css">',
      '<script defer src="/js/track-record-proxy.js"></script>',
      '<script type="application/ld+json">{"@context":"https://schema.org"}</script>',
      '<!-- ANALYTICS:START -->',
      '<script async src="/js/insights.js"></script>',
      '<!-- ANALYTICS:END -->',
    ]) {
      expect(html, `migration dropped ${needle}`).toContain(needle);
    }
    expect(html).not.toContain('<script src="https://cdn.tailwindcss.com"></script>');
    expect(html.indexOf(THEME_START)).toBeGreaterThan(html.indexOf('<!-- ANALYTICS:END -->'));
  });

  it('migrates the CDN-only shape (privacy/terms) to just after the design loader', () => {
    const html = `<!DOCTYPE html><html><head>
<script src="https://cdn.tailwindcss.com"></script>
${LOADER}<style>body{background:#0a0e1a}</style>
</head><body>x</body></html>
`;
    const res = migrateLegacyBlock(html, REGION);
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('cdn-only migration');
    expect(res.html.indexOf(THEME_START)).toBeGreaterThan(res.html.indexOf('<!-- END: AlgoVault canonical design loader -->'));
    expect(res.html).toContain('<style>body{background:#0a0e1a}</style>');
  });

  it('REFUSES an unproven shape and returns the file untouched', () => {
    const two = page(LOADER).replace(
      '<script src="https://cdn.tailwindcss.com"></script>',
      '<script src="https://cdn.tailwindcss.com"></script>\n<script src="https://cdn.tailwindcss.com"></script>',
    );
    const res = migrateLegacyBlock(two, REGION);
    expect(res.ok).toBe(false);
    expect(res.html).toBe(two);

    const none = migrateLegacyBlock('<head></head>', REGION);
    expect(none.ok).toBe(false);

    const already = migrateLegacyBlock(`<head>${THEME_START}${THEME_END}</head>`, REGION);
    expect(already.ok).toBe(false);
    expect(already.reason).toBe('already marked');
  });

  it('finds the config block regardless of which other script tags surround it', () => {
    expect(findConfigBlocks(page(LOADER))).toHaveLength(1);
    expect(findConfigBlocks('<script>\nconsole.log(1)\n</script>')).toHaveLength(0);
  });
});

describe('build_theme: the compile canary’s class scanner', () => {
  it('matches palette utilities with and without an alpha modifier, and rejects neighbours', () => {
    const found = [...'bg-navy-700 hover:border-mint-500/40 xbg-mint-500/10 border-line bg-well text-steel-400'.matchAll(PALETTE_CLASS_RE)].map((m) => m[1]);
    expect(found).toContain('bg-navy-700');
    expect(found).toContain('hover:border-mint-500/40');
    expect(found).toContain('border-line');
    expect(found).toContain('bg-well');
    expect(found).toContain('text-steel-400');
    // `xbg-mint-500/10` is not a class — a scanner without a left boundary would report it as one.
    expect(found).not.toContain('bg-mint-500/10');
  });

  it('escapes a class into the selector Tailwind emits', () => {
    expect(escapeClass('hover:border-mint-500/40')).toBe('.hover\\:border-mint-500\\/40');
    expect(escapeClass('bg-navy-700')).toBe('.bg-navy-700');
  });
});
