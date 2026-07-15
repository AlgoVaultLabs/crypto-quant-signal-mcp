#!/usr/bin/env node
// NAV-PLATFORM-GENERATOR-W1 CH3 — registry-driven /tools index generator.
//
// Renders landing/tools.html: one card per PUBLICLY-LISTED tool (feature-registry
// publicToolNames() — equities held via publicListing:false), each with the canonical name +
// its live description + an anchor `id=<slug>` matching the nav Platform > Tools links
// (/tools#<slug>). Cards + nav both derive from the ONE model (nav-manifest.publicToolEntries),
// so the mega-menu's "See all tools" always resolves to a real anchor. Nav is baked via the
// shared renderSiteNav() (same region scripts/build_nav.mjs injects — idempotent).
//
//   node scripts/build_tools_page.mjs          # write landing/tools.html
//   node scripts/build_tools_page.mjs --check   # 0 = in sync, 1 = drift
// Also invoked by scripts/build_landing.mjs (so `npm run build:landing` regenerates it).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const NAV_START = '<!-- NAV:START -->';
const NAV_END = '<!-- NAV:END -->';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Registry channel key → the human "how you connect" label (public channels only).
const CHANNEL_LABEL = { mcp: 'MCP', httpX402: 'REST / x402', bot: 'Telegram', webhook: 'Webhooks' };

function toolCard(entry, cap) {
  const channels = Object.entries(cap.channels || {})
    .filter(([k, on]) => on && CHANNEL_LABEL[k])
    .map(([k]) => `<span class="tools-badge">${CHANNEL_LABEL[k]}</span>`)
    .join('');
  return `      <article id="${entry.anchor}" class="tools-card">
        <div class="tools-card-head">
          <h3 class="tools-card-title">${esc(entry.label)}</h3>
          <code class="tools-card-name">${esc(entry.name)}</code>
        </div>
        <p class="tools-card-desc">${esc(cap.description)}</p>
        <div class="tools-card-channels">${channels}</div>
      </article>`;
}

// The 5 managed JSON-LD blocks (Organization @id-ref + Product/Service/SoftwareApplication/
// WebSite) are brand-level + byte-identical across sub-pages, injected/refreshed by the manual
// generate_jsonld.mjs numeric-refresh seam. Since build_tools_page regenerates the WHOLE page,
// we PRESERVE any existing managed blocks (carry them into the new <head>) so a build:landing
// run never strips the JSON-LD — generate_jsonld stays the single owner of their content, and
// the geo_jsonld_consistency canary keeps passing.
function preservedJsonLd(existingHtml) {
  const blocks = [...existingHtml.matchAll(/<script type="application\/ld\+json" data-algovault-jsonld="[^"]+">[\s\S]*?<\/script>/g)].map((m) => m[0]);
  return blocks.length ? `${blocks.join('\n')}\n` : '';
}

/** The full landing/tools.html string (nav baked, footer from the SoT, JSON-LD preserved). */
export function renderToolsPage(existingHtml = '') {
  const { publicToolEntries } = require(path.join(REPO_ROOT, 'dist', 'lib', 'nav-manifest.js'));
  const { projectCapabilities } = require(path.join(REPO_ROOT, 'dist', 'lib', 'feature-registry.js'));
  const { renderSiteNav } = require(path.join(REPO_ROOT, 'dist', 'lib', 'site-nav.js'));
  const { renderAnalyticsSnippet } = require(path.join(REPO_ROOT, 'dist', 'lib', 'analytics-snippet.js'));
  const { renderBrandFooter } = require(path.join(REPO_ROOT, 'dist', 'lib', 'footer-content.js'));

  const caps = projectCapabilities().tools;
  const capOf = (name) => caps.find((t) => t.name === name) || { description: '', channels: {} };
  const entries = publicToolEntries();
  const cards = entries.map((e) => toolCard(e, capOf(e.name))).join('\n');

  const title = 'Tools — AlgoVault Labs';
  const description =
    'Every AlgoVault MCP tool: composite trade-call verdicts, market-regime, cross-venue funding arbitrage, market scanning, and knowledge — the Brain Layer for AI trading agents.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="https://algovault.com/tools">
<link rel="icon" type="image/png" href="/logo.png">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://algovault.com/tools">
<script src="https://cdn.tailwindcss.com"></script>
<!-- BEGIN: AlgoVault canonical design loader (DESIGN-W2 / D2-C) -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/_design/algovault-design.css">
<!-- END: AlgoVault canonical design loader -->
<script>
tailwind.config = {
  theme: {
    extend: {
      colors: {
        navy: { 900: '#060a14', 800: '#0a0e1a', 700: '#0f1526', 600: '#161d30' },
        mint: { 50: 'oklch(0.97 0.03 165)', 100: 'oklch(0.94 0.06 165)', 200: 'oklch(0.91 0.09 165)', 300: 'oklch(0.89 0.13 165)', 400: 'oklch(0.86 0.16 165)', 500: 'oklch(0.78 0.18 165)', 600: 'oklch(0.66 0.18 165)', 700: 'oklch(0.54 0.16 165)', 800: 'oklch(0.42 0.12 165)', 900: 'oklch(0.32 0.08 165)' },
        steel: { 400: '#8b9bb5', 500: '#7b8ca0', 600: '#5e6d82' }
      }
    }
  }
}
</script>
<style>
  html { scroll-behavior: smooth; }
  body { background: var(--bg, #060a14); color: var(--fg-2, #d1d5db); font-family: var(--font-text, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); margin: 0; padding: 0; }
  .tools-wrap { max-width: 1024px; margin: 0 auto; padding: 112px 24px 72px; }
  .tools-eyebrow { font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 12px; letter-spacing: 0.12em; color: var(--mint, oklch(0.86 0.16 165)); text-transform: uppercase; margin: 0 0 14px; }
  .tools-h1 { font-family: var(--font-display, 'Inter Tight', sans-serif); font-size: 44px; line-height: 1.05; letter-spacing: -0.02em; font-weight: 600; color: var(--fg, #f5f7fa); margin: 0 0 16px; }
  .tools-sub { font-size: 17px; color: var(--fg-3, #9ca3af); max-width: 640px; line-height: 1.6; margin: 0 0 48px; }
  .tools-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; }
  .tools-card { border: 1px solid var(--line, rgba(255,255,255,0.08)); border-radius: 14px; padding: 22px; background: oklch(0.18 0.014 265 / 0.5); backdrop-filter: blur(10px); scroll-margin-top: 80px; transition: border-color 0.2s, transform 0.2s; }
  .tools-card:hover { border-color: var(--mint, oklch(0.86 0.16 165)); transform: translateY(-2px); }
  .tools-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .tools-card-title { font-family: var(--font-display, 'Inter Tight', sans-serif); font-size: 19px; font-weight: 600; color: var(--fg, #f5f7fa); margin: 0; }
  .tools-card-name { font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 12px; color: var(--mint, oklch(0.86 0.16 165)); background: oklch(0.86 0.16 165 / 0.08); padding: 3px 8px; border-radius: 6px; }
  .tools-card-desc { font-size: 14.5px; line-height: 1.6; color: var(--fg-2, #d1d5db); margin: 0 0 16px; }
  .tools-card-channels { display: flex; flex-wrap: wrap; gap: 6px; }
  .tools-badge { font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 10.5px; letter-spacing: 0.04em; color: var(--fg-3, #9ca3af); border: 1px solid var(--line, rgba(255,255,255,0.08)); border-radius: 999px; padding: 2px 9px; }
</style>
${preservedJsonLd(existingHtml)}<!-- ANALYTICS:START -->
${renderAnalyticsSnippet()}
<!-- ANALYTICS:END -->
</head>
<body>
${NAV_START}
${renderSiteNav()}
${NAV_END}
<main class="tools-wrap">
  <p class="tools-eyebrow">· The Brain Layer</p>
  <h1 class="tools-h1">Tools</h1>
  <p class="tools-sub">Every AlgoVault MCP tool an AI agent can call — one composite verdict per request, across crypto perpetual futures. Connect via MCP, REST, Webhooks, or Telegram.</p>
  <div class="tools-grid">
${cards}
  </div>
</main>
${renderBrandFooter('desktop')}
</body>
</html>
`;
}

/** Write (or --check) landing/tools.html. Returns {file, changed, drift}. */
export function buildToolsPage({ check = false, root = REPO_ROOT } = {}) {
  const file = path.join(root, 'landing', 'tools.html');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const html = renderToolsPage(existing ?? ''); // preserve managed JSON-LD blocks across regens
  const drift = existing !== html;
  if (drift && !check) fs.writeFileSync(file, html);
  return { file: 'landing/tools.html', changed: drift && !check, drift };
}

// ── CLI ──
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const check = process.argv.includes('--check');
  const { drift } = buildToolsPage({ check });
  if (check && drift) {
    console.error('✗ build_tools_page --check: landing/tools.html OUT OF SYNC. Run: node scripts/build_tools_page.mjs');
    process.exit(1);
  }
  console.log(check ? '✓ build_tools_page --check: landing/tools.html in sync.' : `✓ build_tools_page: landing/tools.html ${drift ? 'written' : 'already in sync'}.`);
}
