// DESIGN-SURFACE-TOKENS-W1 CH1 — the ONE Tailwind theme region for every public surface.
//
// WHY THIS FILE EXISTS
// -------------------
// The Play-CDN `tailwind.config` palette was copy-pasted into 62 files (54 landing pages,
// 2 templates, 4 generators, 2 fn-rendered routes), so no single edit could ever change a
// surface colour. This module is the single producer; `scripts/build_theme.mjs` injects the
// rendered region between `<!-- THEME:START -->` / `<!-- THEME:END -->` markers and gates
// drift, exactly as `build_nav.mjs` does for the nav.
//
// WHY THE VALUES ARE CHANNEL TRIPLES, NOT COLOURS
// ----------------------------------------------
// Tailwind v3's `<alpha-value>` placeholder is what makes `bg-navy-700/60`,
// `hover:border-mint-500/40` and friends emit a rule at all — measured on tailwindcss@3.4.17,
// a plain `'oklch(L C H)'` palette string emits NOTHING for any opacity-modifier class (live
// `/integrations` had 0 such rules against 7 classes in the DOM). Per the v3 docs
// (Customizing Colors → Using CSS variables) a CSS variable used that way must hold CHANNELS
// only, never a colour function — hence `--bg-lch: 0.16 0.012 265` twins in
// `landing/_design/algovault-design.css :root`, which stays the design SoT.
//
// WHY EVERY var() CARRIES A FALLBACK (Q-DST-4)
// -------------------------------------------
// `algovault-design.css` is served unversioned with a 4h Cloudflare browser TTL while HTML
// refreshes in 60s, so a returning visitor can get NEW html against the OLD stylesheet. With
// `oklch(var(--surface-lch) / 1)` and the twin undefined the value is invalid at
// computed-value time: cards, nav and the page background all compute transparent — measured
// in a browser, a white page. The fallback triple makes every consumer correct under the
// stale sheet and on api.algovault.com, where the sheet is cross-origin (404 on that host's
// own path). The triples are interpolated from TOKENS, never typed twice, and
// `build_theme.mjs --self-test` leg (e) fails closed if any drifts from `:root`.
//
// Q-DST-2: `gold` is NOT a family here. The 122 legacy `gold-*` utilities are retired at their
// producer (algovault-skills `scripts/build_landing.mjs`); aliasing gold to mint would have
// silently disarmed the `docs-completeness` unconfigured-family guard. The Advanced tier badge
// uses `brass`, the canonical `--brass` / `--brass-2` tokens, so five tier hues stay distinct.

/** Channel triples (L C H) for every surface token. ONE derivation — see cssVarFor(). */
export const TOKENS = {
  bg: '0.16 0.012 265',
  'bg-2': '0.19 0.014 265',
  'bg-3': '0.22 0.014 265',
  line: '0.28 0.012 265',
  'line-2': '0.34 0.012 265',
  surface: '0.18 0.014 265',
  well: '0.13 0.012 265',
  brass: '0.78 0.09 85',
  'brass-2': '0.68 0.12 85',
} as const;

export type TokenName = keyof typeof TOKENS;

/** `bg-3` → `--bg-3-lch`. The `:root` twin name is DERIVED, never a second list. */
export function cssVarFor(token: TokenName): string {
  return `--${token}-lch`;
}

/** `oklch(var(--surface-lch, 0.18 0.014 265) / <alpha-value>)` — a token-backed palette entry. */
export function channel(token: TokenName): string {
  return `oklch(var(${cssVarFor(token)}, ${TOKENS[token]}) / <alpha-value>)`;
}

/** A literal palette entry (mint has no `:root` twin — it is not a surface). */
function literal(lch: string): string {
  return `oklch(${lch} / <alpha-value>)`;
}

export const THEME_START = '<!-- THEME:START -->';
export const THEME_END = '<!-- THEME:END -->';

/**
 * The Tailwind Play CDN version. PINNED: the CDN root 302s here today, and an unpinned tag
 * would follow a future major. The CDN answers 200 for versions that do not exist (serving a
 * `console.error("Unknown Tailwind version")` stub), so the drift check asserts the body
 * banner, never the status code. Keep in lockstep with the `tailwindcss` devDependency.
 */
export const TAILWIND_CDN_VERSION = '3.4.17';

/**
 * The palette. Single-value families are `{ DEFAULT: … }` objects on purpose: that is the
 * documented v3 key for a suffix-less utility (`bg-well`, `border-line`) AND it keeps the
 * family visible to `tests/unit/docs-completeness.test.ts`'s configured-family regex
 * `/([a-z][a-z0-9]*)\s*:\s*\{/`, which a flat string would be invisible to.
 */
export function themeConfig(): Record<string, unknown> {
  return {
    theme: {
      extend: {
        colors: {
          navy: { 900: channel('bg'), 800: channel('bg-3'), 700: channel('surface'), 600: channel('line-2') },
          well: { DEFAULT: channel('well') },
          line: { DEFAULT: channel('line') },
          mint: {
            50: literal('0.97 0.03 165'),
            100: literal('0.94 0.06 165'),
            200: literal('0.91 0.09 165'),
            300: literal('0.89 0.13 165'),
            400: literal('0.86 0.16 165'),
            500: literal('0.78 0.18 165'),
            600: literal('0.66 0.18 165'),
            700: literal('0.54 0.16 165'),
            800: literal('0.42 0.12 165'),
            900: literal('0.32 0.08 165'),
          },
          brass: { 400: channel('brass'), 500: channel('brass-2') },
          steel: { 400: '#8b9bb5', 500: '#7b8ca0', 600: '#5e6d82' },
        },
      },
    },
  };
}

/**
 * Serialize to the in-page `tailwind.config` literal: unquoted keys, single quotes, 2-space
 * indent, leaf families inline. Deterministic — the region is byte-stable across runs.
 */
export function serializeConfig(value: unknown, indent = 0): string {
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value !== 'object' || value === null) return String(value);
  const entries = Object.entries(value as Record<string, unknown>);
  const inline = entries.every(([, v]) => typeof v === 'string');
  const pad = ' '.repeat(indent);
  const padInner = ' '.repeat(indent + 2);
  if (inline) return `{ ${entries.map(([k, v]) => `${k}: ${serializeConfig(v)}`).join(', ')} }`;
  const body = entries.map(([k, v]) => `${padInner}${k}: ${serializeConfig(v, indent + 2)}`).join(',\n');
  return `{\n${body}\n${pad}}`;
}

/**
 * The region's INNER content — no markers, the same contract as `renderSiteNav()`. The
 * injector and the full-page generators wrap it with THEME_START / THEME_END, so a region
 * can never accumulate markers. Nothing is emitted but the pinned tag and the config: an
 * HTML or JS comment here would ship internal notes to View Source on ~60 public pages.
 */
export function renderThemeRegion(): string {
  return [
    `<script src="https://cdn.tailwindcss.com/${TAILWIND_CDN_VERSION}"></script>`,
    '<script>',
    `tailwind.config = ${serializeConfig(themeConfig())}`,
    '</script>',
  ].join('\n');
}

/** The region WITH its markers — what a generator emits inline. */
export function renderThemeBlock(): string {
  return `${THEME_START}\n${renderThemeRegion()}\n${THEME_END}`;
}
