#!/usr/bin/env node
// CHANNEL-HUB-PAGES-GEO-W1 CH2 — generate the 3 channel hub pages from the channel SoT.
//
// Renders landing/{mcp,rest-api,webhooks}.html from src/lib/channel-registry.ts (CHANNELS) + a
// shared GEO template. Each page: a standalone ≤60-word summary passage, self-answering H2s
// (what it is · when to use vs the others · connect + verbatim docs code · tool coverage · FAQ),
// and TechArticle + FAQPage + Organization @id JSON-LD (schema.org-validated). Code blocks are
// EXTRACTED VERBATIM from landing/docs.html (Rule 3 — source, don't invent) via the channel's
// docsAnchors. Nav is baked via the shared renderSiteNav() (same region build_nav.mjs injects).
//
//   node scripts/build_channel_pages.mjs           # write the 3 pages
//   node scripts/build_channel_pages.mjs --check    # 0 = in sync, 1 = drift
// Invoked by scripts/build_landing.mjs (so `npm run build:landing` regenerates them).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const NAV_START = '<!-- NAV:START -->';
const NAV_END = '<!-- NAV:END -->';
const ORG_ID = 'https://algovault.com/#organization';
const DOCS = 'https://algovault.com/docs.html';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Extract the FIRST <pre>…</pre> block in a docs.html section (anchor id → next id). Verbatim. */
function extractFirstPre(docsHtml, anchorId) {
  const id = anchorId.replace(/^#/, ''); // docsAnchors carry the "#"; the id= attribute does not.
  const start = docsHtml.indexOf(`id="${id}"`);
  if (start < 0) return null;
  const after = docsHtml.slice(start + id.length + 5);
  const nextIdx = after.search(/id="[a-z][a-z0-9-]*"/);
  const section = nextIdx < 0 ? after : after.slice(0, nextIdx);
  const m = section.match(/<pre[\s\S]*?<\/pre>/);
  return m ? m[0] : null;
}

/** Per-channel SEO keywords (routing/discovery terms — no volatile counts). */
const KEYWORDS = {
  mcp: 'MCP, Model Context Protocol, AI agent, Claude, Cursor, crypto trade calls, MCP server',
  'rest-api': 'REST API, HTTP API, x402, pay-per-call, USDC, Base, crypto trade calls, API key',
  webhooks: 'webhooks, push notifications, trade call events, regime shift, HMAC, real-time',
};

function techArticleJsonLd(c) {
  return JSON.stringify(
    {
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: `Connect to AlgoVault via ${c.label}`,
      description: c.summary,
      url: `https://algovault.com/${c.slug}`,
      mainEntityOfPage: `https://algovault.com/${c.slug}`,
      articleSection: 'Channels',
      proficiencyLevel: 'Beginner',
      keywords: KEYWORDS[c.key] ?? c.label,
      inLanguage: 'en',
      publisher: { '@id': ORG_ID },
    },
    null,
    2,
  );
}

function faqJsonLd(c) {
  return JSON.stringify(
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: c.faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
    null,
    2,
  );
}

function renderChannelPage(c, deps) {
  const { channelToolCoverage, publicToolEntries, docsHtml, renderSiteNav, renderBrandFooter } = deps;
  const anchor = c.docsAnchors[0] ?? '';
  // Verbatim code blocks from the channel's docs sections (Rule 3).
  const codeBlocks = c.docsAnchors
    .map((a) => ({ a, pre: extractFirstPre(docsHtml, a) }))
    .filter((x) => x.pre)
    .map(
      (x) =>
        `      <div class="ch-code">\n${x.pre}\n        <a class="ch-code-ref" href="${DOCS}${x.a}">Full reference in the docs →</a>\n      </div>`,
    )
    .join('\n');

  // Tool coverage — derived from the registry; each links its /tools#anchor.
  const entryByName = new Map(publicToolEntries().map((e) => [e.name, e]));
  const coverage = channelToolCoverage(c)
    .map((n) => entryByName.get(n))
    .filter(Boolean)
    .map((e) => `        <li><a href="https://algovault.com/tools#${e.anchor}">${esc(e.label)}</a></li>`)
    .join('\n');

  const faqHtml = c.faq
    .map(
      (f) =>
        `      <details class="ch-faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`,
    )
    .join('\n');

  const title = `${c.label} — Connect to AlgoVault | AlgoVault Labs`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(c.summary.slice(0, 155))}">
<link rel="canonical" href="https://algovault.com/${c.slug}">
<link rel="icon" type="image/png" href="/logo.png">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(c.summary.slice(0, 155))}">
<meta property="og:type" content="article">
<meta property="og:url" content="https://algovault.com/${c.slug}">
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
<script type="application/ld+json" data-algovault-jsonld="TechArticle">
${techArticleJsonLd(c)}
</script>
<script type="application/ld+json" data-algovault-jsonld="FAQPage">
${faqJsonLd(c)}
</script>
<script type="application/ld+json" data-algovault-jsonld="Organization">
${JSON.stringify({ '@context': 'https://schema.org', '@id': ORG_ID }, null, 2)}
</script>
<style>
  html { scroll-behavior: smooth; }
  body { background: var(--bg, #060a14); color: var(--fg-2, #d1d5db); font-family: var(--font-text, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); margin: 0; padding: 0; }
  .ch-wrap { max-width: 760px; margin: 0 auto; padding: 112px 24px 72px; }
  .ch-eyebrow { font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 12px; letter-spacing: 0.12em; color: var(--mint, oklch(0.86 0.16 165)); text-transform: uppercase; margin: 0 0 14px; }
  .ch-h1 { font-family: var(--font-display, 'Inter Tight', sans-serif); font-size: 42px; line-height: 1.05; letter-spacing: -0.02em; font-weight: 600; color: var(--fg, #f5f7fa); margin: 0 0 20px; }
  .ch-summary { font-size: 18px; line-height: 1.6; color: var(--fg, #f5f7fa); border-left: 3px solid var(--mint, oklch(0.86 0.16 165)); padding: 4px 0 4px 18px; margin: 0 0 44px; }
  .ch-wrap h2 { font-family: var(--font-display, 'Inter Tight', sans-serif); font-size: 24px; font-weight: 600; color: var(--fg, #f5f7fa); margin: 44px 0 14px; letter-spacing: -0.01em; }
  .ch-wrap p { font-size: 15.5px; line-height: 1.7; color: var(--fg-2, #d1d5db); margin: 0 0 16px; }
  .ch-code { margin: 18px 0; }
  .ch-code pre { overflow-x: auto; background: oklch(0.13 0.012 265); border: 1px solid var(--line, rgba(255,255,255,0.08)); border-radius: 10px; padding: 16px; margin: 0; }
  .ch-code pre code { font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 12.5px; line-height: 1.65; color: var(--fg, #f5f7fa); background: none; }
  .ch-code-ref { display: inline-block; margin-top: 10px; font-size: 13px; color: var(--mint, oklch(0.86 0.16 165)); text-decoration: none; }
  .ch-coverage { list-style: none; padding: 0; margin: 8px 0 0; display: flex; flex-wrap: wrap; gap: 8px; }
  .ch-coverage li a { display: inline-block; font-family: var(--font-mono, monospace); font-size: 13px; color: var(--fg-2, #d1d5db); border: 1px solid var(--line, rgba(255,255,255,0.08)); border-radius: 999px; padding: 4px 12px; text-decoration: none; }
  .ch-coverage li a:hover { color: var(--mint, oklch(0.86 0.16 165)); border-color: var(--mint, oklch(0.86 0.16 165)); }
  .ch-faq { border: 1px solid var(--line, rgba(255,255,255,0.08)); border-radius: 10px; padding: 14px 18px; margin: 10px 0; background: oklch(0.18 0.014 265 / 0.4); }
  .ch-faq summary { cursor: pointer; font-weight: 600; color: var(--fg, #f5f7fa); font-size: 15px; }
  .ch-faq p { margin: 12px 0 2px; }
  .ch-cta { display: inline-block; margin-top: 28px; padding: 11px 22px; border-radius: 10px; background: var(--mint, oklch(0.86 0.16 165)); color: #060a14; font-weight: 600; text-decoration: none; font-size: 15px; }
</style>
<!-- ANALYTICS:START -->
<!-- ANALYTICS:END -->
</head>
<body>
${NAV_START}
${renderSiteNav()}
${NAV_END}
<main class="ch-wrap">
  <p class="ch-eyebrow">· Channels — how you connect</p>
  <h1 class="ch-h1">${esc(c.label)}</h1>
  <p class="ch-summary">${esc(c.summary)}</p>

  <h2>When to use ${esc(c.label)} vs the other channels</h2>
  <p>${esc(c.whenToUse)}</p>

  <h2>Connect</h2>
${codeBlocks || `      <p>See the <a href="${DOCS}${anchor}" class="ch-code-ref">full reference in the docs →</a>.</p>`}

  <h2>Tool coverage</h2>
  <p>Every publicly-listed tool reachable through ${esc(c.label)} (equities are held from public listings):</p>
  <ul class="ch-coverage">
${coverage}
  </ul>

  <h2>Frequently asked questions</h2>
${faqHtml}

  <a class="ch-cta" href="https://algovault.com/tools">Explore the tools →</a>
</main>
${renderBrandFooter('desktop')}
</body>
</html>
`;
}

/** Write (or --check) the 3 channel pages. Returns {changed:[], drifted:[]}. */
export function buildChannelPages({ check = false, root = REPO_ROOT } = {}) {
  const { hostedChannels, channelToolCoverage } = require(path.join(root, 'dist', 'lib', 'channel-registry.js'));
  const { publicToolEntries } = require(path.join(root, 'dist', 'lib', 'nav-manifest.js'));
  const { renderSiteNav } = require(path.join(root, 'dist', 'lib', 'site-nav.js'));
  const { renderBrandFooter } = require(path.join(root, 'dist', 'lib', 'footer-content.js'));
  const docsHtml = fs.readFileSync(path.join(root, 'landing', 'docs.html'), 'utf8');
  const deps = { channelToolCoverage, publicToolEntries, docsHtml, renderSiteNav, renderBrandFooter };

  const changed = [];
  const drifted = [];
  for (const c of hostedChannels()) {
    const file = path.join(root, 'landing', `${c.slug}.html`);
    const rel = `landing/${c.slug}.html`;
    const html = renderChannelPage(c, deps);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (existing !== html) {
      drifted.push(rel);
      if (!check) {
        fs.writeFileSync(file, html);
        changed.push(rel);
      }
    }
  }
  return { changed, drifted };
}

// ── CLI ──
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const check = process.argv.includes('--check');
  const { changed, drifted } = buildChannelPages({ check });
  if (check && drifted.length) {
    console.error(`✗ build_channel_pages --check: OUT OF SYNC:\n  ${drifted.join('\n  ')}\n  Run: node scripts/build_channel_pages.mjs`);
    process.exit(1);
  }
  console.log(check ? '✓ build_channel_pages --check: 3 channel pages in sync.' : `✓ build_channel_pages: ${changed.length} page(s) written${changed.length ? ':\n  ' + changed.join('\n  ') : ' (all in sync)'}`);
}
