/**
 * DESIGN-SURFACE-TOKENS-W1 CH1 — the theme SoT.
 *
 * The palette used to be copy-pasted into 62 files, so "change a surface colour" was not an
 * operation this codebase had. These tests pin the properties that make the ONE producer safe
 * to ship on every public page:
 *
 *  - the region is byte-stable and carries the PINNED CDN (an unpinned tag follows a future major);
 *  - no legacy navy literal can reappear through it;
 *  - every non-hex colour keeps its `/ <alpha-value>` suffix — without it, Tailwind 3.4.17 emits
 *    NO RULE for any opacity utility (measured: live /integrations had 0 rules for 7 classes in
 *    the DOM), which is the defect this wave fixed;
 *  - every channel carries a FALLBACK triple, because `algovault-design.css` is served with a 4h
 *    Cloudflare browser TTL while HTML refreshes in 60s — a returning visitor gets new HTML
 *    against the old stylesheet, and an undefined twin computes to transparent (a white page);
 *  - each fallback still renders the colour the token rendered BEFORE the wave (the sRGB table).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOKENS,
  TAILWIND_CDN_VERSION,
  THEME_START,
  THEME_END,
  cssVarFor,
  themeConfig,
  renderThemeRegion,
  renderThemeBlock,
} from '../../src/lib/site-theme.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** oklch(L C H) → sRGB hex. Culori-free so the test has no dependency of its own. */
function oklchToHex(L: number, C: number, H: number): string {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return (
    '#' +
    lin
      .map((x) => {
        const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
        return Math.round(Math.min(1, Math.max(0, v)) * 255)
          .toString(16)
          .padStart(2, '0');
      })
      .join('')
  );
}

function colourStrings(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(themeConfig());
  return out;
}

describe('site-theme: the ONE theme region', () => {
  it('is byte-stable across calls', () => {
    expect(renderThemeRegion()).toBe(renderThemeRegion());
  });

  it('carries the pinned CDN, and only the pinned form', () => {
    const region = renderThemeRegion();
    expect(region).toContain(`<script src="https://cdn.tailwindcss.com/${TAILWIND_CDN_VERSION}"></script>`);
    expect(region).not.toContain('<script src="https://cdn.tailwindcss.com">');
    expect(TAILWIND_CDN_VERSION).toBe('3.4.17');
  });

  it('carries no legacy navy literal', () => {
    for (const legacy of ['#0f1526', '#060a14', '#0a0e1a', '#161d30', 'rgba(6,10,20', 'rgba(10,14,26']) {
      expect(renderThemeRegion()).not.toContain(legacy);
    }
  });

  it('emits no comment inside the region (it ships to View Source on every public page)', () => {
    const region = renderThemeRegion();
    expect(region).not.toContain('<!--');
    expect(region).not.toContain('/*');
    expect(region).not.toMatch(/^\s*\/\//m); // a line comment; the `//` in the CDN URL is not one
  });

  it('gives every non-hex colour the / <alpha-value> suffix', () => {
    const bad = colourStrings().filter((c) => !c.startsWith('#') && !c.endsWith(' / <alpha-value>)'));
    expect(bad).toEqual([]);
  });

  it('gives every channel reference a fallback triple equal to its TOKENS value', () => {
    const refs = [...renderThemeRegion().matchAll(/var\((--[a-z0-9-]+)\s*,\s*([^)]+)\)/g)];
    expect(refs.length).toBeGreaterThan(0);
    for (const [, name, fallback] of refs) {
      const token = (Object.keys(TOKENS) as (keyof typeof TOKENS)[]).find((t) => cssVarFor(t) === name);
      expect(token, `${name} is not a TOKENS entry`).toBeTruthy();
      expect(fallback.trim()).toBe(TOKENS[token!]);
    }
  });

  it('keeps every channel twin defined in algovault-design.css :root, with the same value', () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, 'landing', '_design', 'algovault-design.css'), 'utf8');
    for (const token of Object.keys(TOKENS) as (keyof typeof TOKENS)[]) {
      const m = css.match(new RegExp(`${cssVarFor(token)}\\s*:\\s*([^;]+);`));
      expect(m, `${cssVarFor(token)} missing from :root`).toBeTruthy();
      expect(m![1].trim()).toBe(TOKENS[token]);
    }
  });

  it('renders the pre-wave colour for every surface token (sRGB table, byte-equal colour)', () => {
    // Measured BEFORE the wave from the same :root values — the twins are a refactor of the
    // notation, never of the colour.
    const expected: Record<string, string> = {
      bg: '#0b0d13',
      'bg-2': '#11141a',
      'bg-3': '#171b21',
      line: '#26292f',
      'line-2': '#35383e',
      surface: '#0f1218',
      well: '#05070c',
      brass: '#d2b373',
      'brass-2': '#ba9232',
    };
    for (const [token, hex] of Object.entries(expected)) {
      const [L, C, H] = TOKENS[token as keyof typeof TOKENS].split(' ').map(Number);
      expect(oklchToHex(L, C, H), `${token} drifted`).toBe(hex);
    }
  });

  it('configures exactly the families that have a consumer (no dead config)', () => {
    const colors = (themeConfig() as any).theme.extend.colors;
    expect(Object.keys(colors).sort()).toEqual(['brass', 'line', 'mint', 'navy', 'steel', 'well']);
    // `gold` was NOT aliased to mint: that would have silently disarmed the docs-completeness
    // unconfigured-family guard, whose MUST-FIRE case is exactly `text-gold` / `bg-gold-500`.
    expect(colors.gold).toBeUndefined();
  });

  it('serializes single-value families as { DEFAULT: … } so suffix-less utilities exist', () => {
    const region = renderThemeRegion();
    expect(region).toContain('well: { DEFAULT:');
    expect(region).toContain('line: { DEFAULT:');
    // …and stays visible to the docs-completeness configured-family regex.
    const families = [...region.matchAll(/([a-z][a-z0-9]*)\s*:\s*\{/g)].map((m) => m[1]);
    for (const f of ['navy', 'well', 'line', 'mint', 'brass', 'steel']) expect(families).toContain(f);
  });

  it('wraps the region with its markers exactly once in renderThemeBlock()', () => {
    const block = renderThemeBlock();
    expect(block.split(THEME_START)).toHaveLength(2);
    expect(block.split(THEME_END)).toHaveLength(2);
    expect(block.startsWith(THEME_START)).toBe(true);
    expect(block.endsWith(THEME_END)).toBe(true);
    // renderThemeRegion() itself is marker-free — the same contract as renderSiteNav().
    expect(renderThemeRegion()).not.toContain(THEME_START);
  });
});
