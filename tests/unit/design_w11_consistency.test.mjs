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
 * Preservation-LAW (post-P1-TRACK-RECORD-LEADERBOARD-W1): chrome (Nav / Footer /
 * artboard / H1 / brand-block) + 3x verify-any-call-card + 7x setInterval remain
 * byte-stable. SUPERSEDED by P1: the 3 fixed per-segment grids (tier-stat-card /
 * exchange-stat-card / tf-bar-chart) + their 35 static per-segment data-tr-field
 * spans are replaced by ONE unified leaderboard (#leaderboard-section) rendered
 * live from the same payload; JSON-LD baseline 0 -> 1 (R4 Dataset). See
 * audits/P1-TRACK-RECORD-LEADERBOARD-W1-endpoint-truth.md.
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

// LANDING-MOBILE-NAV-FUNCTION-RENDERED-W1: the canonical nav was extracted to the
// shared SoT src/lib/site-nav.ts (renderSiteNav). The page now DELEGATES; the byte-level
// nav content contract (class strings, links, active-link, brand-mark) is owned by the
// frozen-oracle byte-equivalence gate in tests/site-nav.test.ts. These assertions verify
// the page uses the shared generator with the correct params + the SoT carries the chrome.
test('/track-record: canonical Nav via shared renderSiteNav generator (Q-W11-2; NAV-PLATFORM-GENERATOR-W1)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  // NAV-PLATFORM-GENERATOR-W1: /track-record delegates to the arg-less shared renderSiteNav().
  assert.match(func, /renderSiteNav\(\)/, '/track-record must render its nav via the shared renderSiteNav()');
  assert.strictEqual(countOcc(func, '<nav class="fixed top-0'), 0,
    'inline <nav> literal must be retired from the page body (now via renderSiteNav)');
});

test('/track-record: active-link styling applied client-side by the shared nav controller (Q-W11-1)', async () => {
  const func = scopeToPerfFunc(await read('src/index.ts'));
  assert.match(func, /renderSiteNav\(\)/, '/track-record must render its nav via the shared renderSiteNav()');
  // The current-page highlight is now applied CLIENT-SIDE by the controller (byte-identical
  // HTML everywhere; JS marks the matching link mint) — a runtime classList.add, not a class.
  const { renderSiteNav } = await import('../../dist/lib/site-nav.js');
  const nav = renderSiteNav();
  assert.ok(nav.includes("classList.add('text-mint-400','font-medium')"),
    'shared nav controller must apply the mint active-link style client-side');
  assert.ok(nav.includes('data-nav-link'), 'top-bar links must carry data-nav-link for the active matcher');
});

test('/track-record: canonical brand-mark wrap via shared nav SoT (Q-W11-4: direct ahref + aria-label + cross-origin)', async () => {
  const func = scopeToPerfFunc(await read('src/index.ts'));
  assert.match(func, /renderSiteNav\(\)/, '/track-record nav comes from the shared renderSiteNav()');
  const { renderSiteNav } = await import('../../dist/lib/site-nav.js');
  const nav = renderSiteNav();
  assert.strictEqual(countOcc(nav, '<a href="https://algovault.com/" class="flex items-center gap-2.5" aria-label="AlgoVault home">'), 1,
    'shared nav must carry exactly 1 canonical brand-mark wrap');
});

test('/track-record: footer renders from the single brand-footer SoT (FOOTER-UNIFY-W1)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  // FOOTER-UNIFY-W1: the inline footer literal is retired — the page renders the ONE SoT footer.
  assert.strictEqual(countOcc(func, "renderBrandFooter('desktop')"), 1,
    'track-record must render the canonical footer via renderBrandFooter (single source)');
  assert.strictEqual(countOcc(func, '<footer style="padding:44px 80px 56px;border-top:1px solid var(--line);background:oklch(0.13 0.012 265)'), 0,
    'no inline brand-footer literal may survive in src/index.ts (drift retired)');
});

test('FOOTER-UNIFY-W1: the brand-footer SoT carries the "Built by AlgoVault Labs" attribution (preservation-LAW)', async () => {
  const sot = await read('src/lib/footer-content.ts');
  assert.ok(/Built by AlgoVault Labs/.test(sot), 'footer-content SoT must include the Built by AlgoVault Labs attribution');
  assert.ok(sot.includes('oklch(0.13 0.012 265)'), 'footer-content SoT must define the canonical brand-footer background');
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

// SUPERSEDED BY P1-TRACK-RECORD-LEADERBOARD-W1: the 3 fixed per-segment grids
// (tier-stat-card / exchange-stat-card / tf-bar-chart) are REPLACED by ONE unified
// leaderboard rendered client-side from the same /api/performance-public payload.
// The rendered grids are gone; any residual tier-stat-card / exchange-stat-card
// strings are CSS-comment provenance only.
test('/track-record: 3 fixed per-segment grids replaced by the unified leaderboard (P1)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  assert.strictEqual(countOcc(func, 'id="leaderboard-section"'), 1, 'unified leaderboard present');
  assert.ok(/function renderLeaderboard\(\)/.test(func), 'renderLeaderboard controller present');
  assert.strictEqual(countOcc(func, 'class="tier-stat-grid"'), 0, 'rendered tier-stat-grid removed');
  assert.strictEqual(countOcc(func, 'class="exchange-stat-grid"'), 0, 'rendered exchange-stat-grid removed');
  assert.strictEqual(countOcc(func, 'id="tf-bar-chart"'), 0, 'rendered tf-bar-chart removed');
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

test('/track-record W11-FF: subtitle uses canonical text-sm + mint accent color #5BEEB3 (matches leaderboard kicker)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  // P1-TRACK-RECORD-LEADERBOARD-W1 follow-up (operator request 2026-06-21): the
  // brand-block subtitle was recolored from var(--fg-3) to the leaderboard kicker
  // mint (#5BEEB3) for visual continuity. data-tr-field hydration spans unchanged.
  assert.ok(/<p class="text-sm" style="color:#5BEEB3">/.test(func),
    'Subtitle must use class="text-sm" + inline style="color:#5BEEB3" (mint accent matching the leaderboard kicker)');
});

test('/track-record W11-FF: pkg_version live-bind span added (additive — 45th unique data-tr-field key)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  assert.ok(/data-tr-field="pkg_version">\$\{PKG_VERSION\}<\/span>/.test(func),
    'pkg_version live-bind span must wrap ${PKG_VERSION} template literal (build-time fallback + future proxy hydration target)');
});

// SUPERSEDED BY P1-TRACK-RECORD-LEADERBOARD-W1 (Q-P1-9): the 35 per-segment static
// data-tr-field spans (tier_t*/ex_*/tf_*) are replaced by the leaderboard's dynamic
// render from cachedData — genuinely live, re-rendered on the existing 30s load()
// loop. The lower static count does NOT reduce live coverage: every surviving
// critical live-bind key persists, and leaderboard numbers stay live.
test('/track-record: surviving data-tr-field live-bind keys intact post-P1 (Q-P1-9)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  for (const k of ['pkg_version', 'exchange_count', 'asset_count', 'merkle_batch_count', 'latest_batch_at', 'next_batch_in']) {
    assert.ok(new RegExp(`data-tr-field="${k}"`).test(func), `${k} live-bind must persist`);
  }
  // leaderboard numbers stay live via the 30s loop (renderAll -> renderLeaderboard).
  assert.ok(/renderLeaderboard\(\);/.test(func), 'renderLeaderboard invoked for live re-render');
});

test('/track-record preservation: setInterval count unchanged (W11 adds 0)', async () => {
  const src = await read('src/index.ts');
  const n = countOcc(src, 'setInterval(');
  assert.strictEqual(n, 7, `Expected exactly 7 setInterval calls (baseline); got ${n}`);
});

// SUPERSEDED BY P1-TRACK-RECORD-LEADERBOARD-W1 (R4 GEO): baseline was 0; P1 adds
// exactly 1 schema.org Dataset (variableMeasured = PFE Win Rate + Sample Size).
// No synthetic aggregateRating (Data Integrity LAW + Google rich-results policy).
test('/track-record: exactly 1 Dataset JSON-LD (P1 R4; baseline was 0)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  assert.strictEqual(countOcc(func, 'application/ld+json'), 1, 'exactly 1 JSON-LD block');
  assert.ok(/"@type":"Dataset"/.test(func), 'JSON-LD is a Dataset');
  assert.ok(/"variableMeasured"/.test(func), 'Dataset declares variableMeasured');
  assert.ok(!/"aggregateRating"/.test(func), 'no synthetic aggregateRating key');
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

// SUPERSEDED BY P1-TRACK-RECORD-LEADERBOARD-W1: the per-segment data-tr-field spans
// (tier_t*_wr / ex_*_wr|n / tf_*_wr) are replaced by the leaderboard reading the
// SAME segment maps from cachedData (live, re-rendered each 30s refresh).
test('/track-record: leaderboard reads all 4 segment dimensions from the payload (P1)', async () => {
  const src = await read('src/index.ts');
  const func = scopeToPerfFunc(src);
  assert.ok(/d\.byExchange/.test(func), 'reads byExchange (Venue dimension)');
  assert.ok(/d\.byAsset/.test(func), 'reads byAsset (Asset dimension)');
  assert.ok(/d\.byTimeframe/.test(func), 'reads byTimeframe (Timeframe dimension)');
  assert.ok(/d\.byTier/.test(func), 'reads byTier (Tier dimension)');
  // Q-P1-8: the Timeframe dimension derives its included set from the single
  // HIDE_TFS source so it can't drift from the published aggregate.
  assert.ok(/HIDE_TFS\[tf\]/.test(func), 'timeframe dimension filtered through HIDE_TFS (single source)');
});
