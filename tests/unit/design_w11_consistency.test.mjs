/**
 * DESIGN-W11 C3 — canonical Landing chrome rollout to /track-record
 * (function-rendered via getPerformanceDashboardHtml in src/index.ts).
 *
 * Asserts the architect-ratified 7 Q-W11-N decisions from audits/DESIGN-W11-mapping.md:
 *   - Q-W11-1: Track Record nav link uses text-mint-400 font-medium active-link styling
 *   - Q-W11-2: body styles replaced with var(--bg) + var(--fg) + zero padding
 *   - Q-W11-3: artboard scaffolding wrapper (max-width:1400px preserves dashboard layout)
 *   - Q-W11-4: brand-mark wrap = /account precedent (direct ahref + aria-label + cross-origin href)
 *   - Q-W11-5: preserve existing "Live Track Record" brand block in current position
 *   - Q-W11-6: pragmatic preservation of pre-existing inline styles
 *   - Q-W11-7: mobile Nav via Tailwind hidden sm:flex (no /track-record-specific mobile CSS)
 *
 * Preservation-LAW: 22× tier-stat-card / 24× exchange-stat-card refs / 4× tf-bar-chart /
 * 3× verify-any-call-card / 44× data-tr-field unique keys / 7× setInterval / 0× JSON-LD
 * all byte-identical post-edit. R-1 inline-fix: JSON-LD baseline = 0 (not 1 as spec
 * Map Anchor premised; W8-FIX did not add JSON-LD to /track-record).
 *
 * Comment-stripping per comment-vs-rendered-DOM-aware-canary (5-sighting canonical
 * CLAUDE.md rule): forbidden-phrase scan strips /* ... *​/ and // ... and <!-- --> before grep.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

async function read(rel) {
  return readFile(resolve(REPO_ROOT, rel), 'utf8');
}

function countOcc(haystack, needle) {
  if (typeof needle === 'string') {
    let n = 0, idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
    return n;
  }
  const re = needle.global ? needle : new RegExp(needle.source, needle.flags + 'g');
  const m = haystack.match(re);
  return m ? m.length : 0;
}

// Strip TS/JS comments (/* */ + //) AND HTML comments (<!-- -->) before forbidden-phrase grep.
// Per comment-vs-rendered-DOM-aware-canary canonical CLAUDE.md rule (5-sighting promoted).
function stripComments(src) {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// Scope a substring to the getPerformanceDashboardHtml function body.
// The function declaration begins at `function getPerformanceDashboardHtml`.
// The function ends at the next top-level `}` followed by `// ── Smithery sandbox export ──`.
function scopeToPerfFunc(src) {
  const start = src.indexOf('function getPerformanceDashboardHtml');
  if (start < 0) return '';
  const end = src.indexOf('// ── Smithery sandbox export', start);
  return src.slice(start, end < 0 ? undefined : end);
}

// ── /track-record chrome assertions (Q-W11-1, Q-W11-4, Q-W11-7) ──────────────

test('/track-record: canonical Nav present in getPerformanceDashboardHtml (Q-W11-2 actual class string)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  const nav = countOcc(func, '<nav class="fixed top-0 w-full z-50 border-b border-white/5"');
  assert.strictEqual(nav, 1, `Expected exactly 1 canonical Nav block; got ${nav}`);
});

test('/track-record: Track Record nav link uses active-link styling (Q-W11-1: text-mint-400 font-medium)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  const active = countOcc(func, '<a href="/track-record" class="text-mint-400 font-medium">Track Record</a>');
  assert.strictEqual(active, 1, `Expected exactly 1 active-link Track Record nav link; got ${active}`);
});

test('/track-record: brand-mark wrap follows /account precedent (Q-W11-4: direct ahref + aria-label + cross-origin)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  const brandMark = countOcc(func, '<a href="https://algovault.com/" class="flex items-center gap-2.5" aria-label="AlgoVault home">');
  assert.strictEqual(brandMark, 1, `Expected exactly 1 canonical brand-mark wrap; got ${brandMark}`);
});

test('/track-record: canonical Footer present (desktop variant verbatim)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  const footerOpen = countOcc(func, '<footer style="padding:44px 80px 56px;border-top:1px solid var(--line);background:oklch(0.13 0.012 265)');
  const footerClose = countOcc(func, '</footer>');
  assert.strictEqual(footerOpen, 1, `Expected exactly 1 canonical Footer open; got ${footerOpen}`);
  assert.strictEqual(footerClose, 1, `Expected exactly 1 </footer>; got ${footerClose}`);
});

test('/track-record: Footer has "Built by AlgoVault Labs" attribution (preservation-LAW link)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  assert.ok(/Built by AlgoVault Labs/.test(func), 'Footer must include Built by AlgoVault Labs attribution');
});

test('/track-record: Tailwind CDN present in <head> (R-2 inline-fix per Q-W10-8 precedent)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  const tw = countOcc(func, 'cdn.tailwindcss.com');
  assert.strictEqual(tw, 1, `Expected exactly 1 Tailwind CDN reference; got ${tw}`);
});

// ── Artboard scaffolding assertions (Q-W11-3) ────────────────────────────────

test('/track-record: artboard wrapper present (Q-W11-3 WRAP ratified)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  assert.strictEqual(countOcc(func, 'class="artboard"'), 1, 'artboard wrapper missing');
  assert.strictEqual(countOcc(func, 'class="bg-grid"'), 1, 'bg-grid layer missing');
  assert.strictEqual(countOcc(func, 'class="bg-radial-accent"'), 1, 'bg-radial-accent layer missing');
  assert.strictEqual(countOcc(func, 'class="bg-noise"'), 1, 'bg-noise layer missing');
  assert.ok(/<main class="lp-track-record">/.test(func), 'lp-track-record main wrapper missing');
});

test('/track-record: artboard max-width preserves dashboard layout (1400px not /account 720px)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  assert.ok(/<div class="artboard" style="padding:80px 24px 64px;max-width:1400px/.test(func),
    'artboard wrapper must keep max-width:1400px for 22-tier-stat-card + 8-col-LATEST-TRADE-CALLS layout');
});

// ── Body-style restructure (Q-W11-2) ─────────────────────────────────────────

test('/track-record: body styles replaced with canonical var(--bg) pattern (Q-W11-2)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  assert.ok(/body \{ font-family: var\(--font-text/.test(func), 'body font-family must use canonical CSS var');
  assert.ok(/background: var\(--bg\)/.test(func), 'body background must use var(--bg)');
  assert.ok(/color: var\(--fg\)/.test(func), 'body color must use var(--fg)');
});

// ── Preservation-LAW HARD ────────────────────────────────────────────────────

test('/track-record preservation: 22× tier-stat-card byte-identical', async () => {
  const src = await read('src/index.ts');
  const n = countOcc(src, 'tier-stat-card');
  assert.ok(n >= 22, `Expected ≥22 tier-stat-card refs; got ${n}`);
});

test('/track-record preservation: 24× exchange-stat-card byte-identical', async () => {
  const src = await read('src/index.ts');
  const n = countOcc(src, 'exchange-stat-card');
  assert.ok(n >= 24, `Expected ≥24 exchange-stat-card refs; got ${n}`);
});

test('/track-record preservation: 4× tf-bar-chart byte-identical', async () => {
  const src = await read('src/index.ts');
  const n = countOcc(src, 'tf-bar-chart');
  assert.ok(n >= 4, `Expected ≥4 tf-bar-chart refs; got ${n}`);
});

test('/track-record preservation: 3× verify-any-call-card byte-identical', async () => {
  const src = await read('src/index.ts');
  const n = countOcc(src, 'verify-any-call-card');
  assert.ok(n >= 3, `Expected ≥3 verify-any-call-card refs; got ${n}`);
});

test('/track-record preservation: "Live Track Record" brand block (Q-W11-5 + W11-FF restyle)', async () => {
  const src = await read('src/index.ts');
  // Title <title>Live Track Record — AlgoVault Labs</title> still has the contiguous substring.
  // Post-W11-FF, the H1 splits on span boundary (Live + <span>Track Record</span>) per
  // canonical mint-on-page-name-noun pattern — the source no longer has the contiguous
  // string in the H1, but rendered text content remains "Live Track Record". Assert both:
  // (a) title still has the substring; (b) H1 uses the canonical mint-accent shape.
  assert.ok(/Live Track Record/.test(src), 'title or rendered H1 must contain "Live Track Record"');
  assert.ok(/Live <span class="text-mint-400">Track Record<\/span>/.test(src),
    'H1 must use canonical mint-on-page-name pattern post-W11-FF (Live <span class="text-mint-400">Track Record</span>)');
});

test('/track-record W11-FF: H1 uses canonical enlarged content-H1 hierarchy', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  assert.ok(/<h1 class="text-5xl sm:text-6xl font-semibold tracking-tight"/.test(func),
    'H1 must carry canonical hierarchy classes (text-5xl sm:text-6xl font-semibold tracking-tight)');
  assert.ok(/style="color:var\(--fg\)"/.test(func),
    'H1 must use inline style="color:var(--fg)" (FF-REL-1 inline-fix: text-fg not in Tailwind config)');
});

test('/track-record W11-FF: brand-block wrapper is space-y-2 + mb-8 (canonical vertical rhythm + section gap)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  // W11-FF2 (2026-05-14): added mb-8 (32px) for section-gap between brand block + exchange-logo strip.
  assert.ok(/<div class="space-y-2 mb-8">\s*<h1/.test(func),
    'Brand block must be wrapped in <div class="space-y-2 mb-8"> (W11-FF2 added mb-8 for canonical section gap)');
});

test('/track-record W11-FF: logo icon REMOVED from brand block context', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  // The old brand block had <div class="logo"><a><img src="/logo.png" width="36" height="36" .../></a>...</div>
  // post-W11-FF that logo + wrapping anchor should be GONE from this function body.
  // Logo references in canonical Nav (img src="/logo.png" alt="AlgoVault Logo" class="w-7 h-7 ...")
  // and canonical Footer (img src="/logo.png" alt="AlgoVault" style="width:22px;height:22px;...")
  // are PRESERVED. Asserting absence of the specific old brand-block markup.
  assert.ok(!/<div class="logo">/.test(func), 'Old <div class="logo"> wrapper must be removed');
  assert.ok(!/width="36" height="36"/.test(func), 'Old 36x36 brand-block logo image must be removed');
});

test('/track-record W11-FF: subtitle uses canonical text-sm + inline style color:var(--fg-3)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  assert.ok(/<p class="text-sm" style="color:var\(--fg-3\)">/.test(func),
    'Subtitle must use canonical class="text-sm" + inline style="color:var(--fg-3)" (FF-REL-1 inline-fix: text-fg-muted not in Tailwind config)');
});

test('/track-record W11-FF: pkg_version live-bind span added (additive — 45th unique data-tr-field key)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  assert.ok(/data-tr-field="pkg_version">\$\{PKG_VERSION\}<\/span>/.test(func),
    'pkg_version live-bind span must wrap ${PKG_VERSION} template literal (build-time fallback + future proxy hydration target)');
});

test('/track-record preservation: 44 unique data-tr-field keys', async () => {
  const src = await read('src/index.ts');
  const matches = src.match(/data-tr-field="[^"]+"/g) || [];
  const unique = new Set(matches);
  assert.ok(unique.size >= 44, `Expected ≥44 unique data-tr-field keys; got ${unique.size}`);
});

test('/track-record preservation: setInterval count unchanged (W11 adds 0)', async () => {
  const src = await read('src/index.ts');
  const n = countOcc(src, 'setInterval(');
  assert.strictEqual(n, 7, `Expected exactly 7 setInterval calls (baseline); got ${n}`);
});

test('/track-record preservation: JSON-LD count = 0 (R-1 inline-fix: spec premise corrected; W8-FIX did NOT add JSON-LD)', async () => {
  const src = await read('src/index.ts');
  const n = countOcc(src, 'application/ld+json');
  assert.strictEqual(n, 0, `Expected exactly 0 JSON-LD blocks (R-1 corrected baseline); got ${n}`);
});

// ── Build Rule 9 forbidden-phrase canary (comment-stripped per canonical rule) ──

test('/track-record chrome additions: 0 forbidden phrases per Build Rule 9 (comment-stripped)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  const stripped = stripComments(func);
  const forbiddenRegex = /\b(intelligence layer|Arm Your Agent|Wall Street Quant Brain|Gets Smarter|cutting-edge|revolutionary|industry-leading|powerful|seamless|robust)\b/i;
  const m = stripped.match(forbiddenRegex);
  assert.strictEqual(m, null, `Forbidden phrase found in rendered chrome: ${m ? m[0] : 'none'}`);
});

// ── Data Integrity LAW (Phase E / outcome WR never in public-facing chrome) ──

test('/track-record chrome additions: NO Phase-E / outcome_won / outcome_return_pct in chrome (Data Integrity LAW)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  // Strip comments — Phase-E mentions in TS code comments documenting the LAW are allowed
  const stripped = stripComments(func);
  // Search for rendered prose (NOT comments) referencing internal-only fields
  const rendered = /(outcome_won|outcome_return_pct|Phase E|Phase-E)/i;
  const m = stripped.match(rendered);
  assert.strictEqual(m, null, `Data Integrity LAW violation: ${m ? m[0] : 'none'} appears in rendered chrome`);
});

// ── Live-bind hydration assertions (Q-W11-3 preservation) ───────────────────

test('/track-record: brand block live-bind spans intact (exchange_count + asset_count + pkg_version)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  assert.ok(/data-tr-field="exchange_count"/.test(func), 'data-tr-field="exchange_count" must persist');
  assert.ok(/data-tr-field="asset_count"/.test(func), 'data-tr-field="asset_count" must persist');
  // Post-W11-FF: ${PKG_VERSION} template literal is wrapped in a data-tr-field="pkg_version" span
  // (additive change — was bare `v${PKG_VERSION}` pre-W11-FF). Both shapes preserve build-time fallback.
  assert.ok(/\$\{PKG_VERSION\}/.test(func), 'pkg_version template literal must persist (now inside data-tr-field span)');
});

test('/track-record: KPI live-bind spans intact (4 tiers + 5 exchanges + 8 timeframes)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  for (const t of ['tier_t1_wr', 'tier_t2_wr', 'tier_t3_wr', 'tier_t4_wr']) {
    assert.ok(new RegExp(`data-tr-field="${t}"`).test(func), `${t} live-bind must persist`);
  }
  for (const ex of ['BINANCE', 'BITGET', 'BYBIT', 'HL', 'OKX']) {
    assert.ok(new RegExp(`data-tr-field="ex_${ex}_n"`).test(func), `ex_${ex}_n live-bind must persist`);
    assert.ok(new RegExp(`data-tr-field="ex_${ex}_wr"`).test(func), `ex_${ex}_wr live-bind must persist`);
  }
});
