#!/usr/bin/env node
/**
 * Render integration tutorials from algovault-skills/docs/integrations/*.md
 * to landing/integrations/*.html (pre-rendered, committed, static-served).
 *
 * Run from signal-MCP repo root:
 *   node scripts/render-integrations.mjs            # default --source ~/git/algovault-skills
 *   node scripts/render-integrations.mjs --source /path/to/algovault-skills
 *
 * Output: landing/integrations/{binance,okx,bybit,bitget}.html
 *
 * Each rendered HTML page wraps the tutorial body in the same Tailwind navy/
 * gold theme used by landing/docs.html so the mirror reads as part of
 * algovault.com, not as a foreign drop-in.
 *
 * Re-run this script whenever algovault-skills/docs/integrations/<x>.md
 * changes upstream. The output is committed to signal-MCP so the deploy
 * pipeline ships static HTML — no per-request markdown rendering.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import MarkdownIt from 'markdown-it';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const EXCHANGES = ['binance', 'okx', 'bybit', 'bitget'];

const args = process.argv.slice(2);
const sourceArg = args[args.indexOf('--source') + 1];
const SOURCE_REPO = sourceArg && sourceArg !== '--source'
  ? sourceArg
  : join(homedir(), 'git', 'algovault-skills');

const SOURCE_DIR = join(SOURCE_REPO, 'docs', 'integrations');
const TARGET_DIR = join(ROOT, 'landing', 'integrations');

// html: true required so source MDs can include <span data-tr-field="..."> for
// the live track-record proxy (see WEBSITE-REFRESH-W1 C1).
const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Acronym-aware exchange display names (avoid auto-cap "OKX" → "Okx").
const DISPLAY_NAMES = {
  binance: 'Binance',
  okx: 'OKX',
  bybit: 'Bybit',
  bitget: 'Bitget',
};

function pageTitle(exchange) {
  const display = DISPLAY_NAMES[exchange] ?? (exchange.charAt(0).toUpperCase() + exchange.slice(1));
  return `AlgoVault × ${display} — Build Verifiable AI Trading Agents`;
}

// WEBSITE-REFRESH-W1 C1 — number snapshot for description meta + initial render.
// Live source of truth: /api/performance-public + /api/merkle-batches (proxied
// at runtime by /js/track-record-proxy.js to update [data-tr-field] elements).
const SNAPSHOT_DATE = '2026-04-26';
const SNAPSHOT_PFE_WR = '89.4%';
const SNAPSHOT_SIGNAL_COUNT = '56,375';
const SNAPSHOT_BATCH_COUNT = '16';

function htmlShell(exchange, bodyHtml) {
  const title = pageTitle(exchange);
  const display = DISPLAY_NAMES[exchange] ?? (exchange.charAt(0).toUpperCase() + exchange.slice(1));
  const description = `Pair AlgoVault MCP's composite verdict with ${display}'s agent execution kit. Free testnet demo · ${SNAPSHOT_PFE_WR} PFE Win Rate · ${SNAPSHOT_SIGNAL_COUNT}+ calls · ${SNAPSHOT_BATCH_COUNT}+ Merkle-verified on-chain batches.`;
  const canonical = `https://algovault.com/docs/integrations/${exchange}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
<link rel="icon" type="image/png" href="/logo.png">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonical}">
<!-- WEBSITE-REFRESH-W1 C1 — snapshot date for the static numbers below; live source: /api/performance-public + /api/merkle-batches -->
<meta name="last-updated" content="${SNAPSHOT_DATE}">
<script src="https://cdn.tailwindcss.com"></script>
<script defer src="/js/track-record-proxy.js"></script>
<script>
tailwind.config = {
  theme: {
    extend: {
      colors: {
        navy: { 900: '#060a14', 800: '#0a0e1a', 700: '#0f1526', 600: '#161d30' },
        gold: { 400: '#d4b255', 500: '#c4a34a', 600: '#a8893d' },
        steel: { 400: '#8b9bb5', 500: '#7b8ca0', 600: '#5e6d82' }
      }
    }
  }
}
</script>
<style>
  html { scroll-behavior: smooth; }
  body { background: #060a14; color: #d1d5db; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  code { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  pre { overflow-x: auto; background: #0a0e1a; border: 1px solid #1f2937; border-radius: 8px; padding: 16px; margin: 16px 0; }
  pre code { background: none; padding: 0; font-size: 0.85em; line-height: 1.6; color: #e5e7eb; }
  article h1 { font-size: 2.25rem; font-weight: 700; margin: 1.5em 0 0.5em; color: #d4b255; }
  article h2 { font-size: 1.6rem; font-weight: 600; margin: 1.5em 0 0.5em; color: #d4b255; padding-top: 0.5em; border-top: 1px solid #1f2937; }
  article h2:first-of-type { border-top: none; padding-top: 0; }
  article h3 { font-size: 1.2rem; font-weight: 600; margin: 1.25em 0 0.4em; color: #c4a34a; }
  article p { margin: 0.75em 0; line-height: 1.7; }
  article ul, article ol { margin: 0.75em 0; padding-left: 1.5em; line-height: 1.7; }
  article li { margin: 0.25em 0; }
  article a { color: #d4b255; text-decoration: underline; }
  article a:hover { color: #c4a34a; }
  article strong { color: #fff; font-weight: 600; }
  article blockquote { border-left: 3px solid #d4b255; padding-left: 16px; margin: 1em 0; color: #8b9bb5; font-style: italic; background: rgba(212, 178, 85, 0.05); padding: 12px 16px; border-radius: 0 4px 4px 0; }
  article table { width: 100%; border-collapse: collapse; margin: 1em 0; }
  article th, article td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #1f2937; }
  article th { color: #d4b255; font-weight: 600; }
  article hr { border: none; border-top: 1px solid #1f2937; margin: 2em 0; }
</style>
</head>
<body>
<header class="border-b border-navy-600 px-6 py-4">
  <div class="max-w-4xl mx-auto flex items-center justify-between">
    <a href="/" class="flex items-center gap-3 text-white font-bold text-lg">
      <img src="/logo.png" alt="AlgoVault" class="h-8 w-8" />
      <span>AlgoVault</span>
    </a>
    <nav class="text-sm text-steel-400 flex gap-6">
      <a href="/track-record?utm_source=tutorial&utm_medium=web&utm_campaign=integration-${exchange}" class="hover:text-gold-400">Track Record</a>
      <a href="/docs.html" class="hover:text-gold-400">Docs</a>
      <a href="https://github.com/AlgoVaultLabs/algovault-skills" class="hover:text-gold-400">GitHub</a>
    </nav>
  </div>
</header>
<main class="max-w-4xl mx-auto px-6 py-10">
<article>
${bodyHtml}
</article>
</main>
<footer class="border-t border-navy-600 px-6 py-6 mt-12">
  <div class="max-w-4xl mx-auto text-center text-steel-500 text-sm">
    <p>© AlgoVault Labs · MIT licensed · Tutorial source: <a href="https://github.com/AlgoVaultLabs/algovault-skills/blob/main/docs/integrations/${exchange}.md" class="text-gold-400 hover:text-gold-500">algovault-skills/docs/integrations/${exchange}.md</a></p>
    <p class="mt-2">Snapshot taken 2026-04-25 · Live numbers at <a href="/track-record?utm_source=tutorial&utm_medium=web&utm_campaign=integration-${exchange}" class="text-gold-400 hover:text-gold-500">/track-record</a></p>
  </div>
</footer>
</body>
</html>
`;
}

async function renderOne(exchange) {
  const srcPath = join(SOURCE_DIR, `${exchange}.md`);
  const dstPath = join(TARGET_DIR, `${exchange}.html`);
  let mdSource = await readFile(srcPath, 'utf8');

  // Rewrite UTM channel from `repo` to `web` for the rendered (web) mirror —
  // so click-attribution distinguishes GitHub views from algovault.com views.
  mdSource = mdSource.replace(
    /utm_medium=repo&utm_campaign=integration-/g,
    'utm_medium=web&utm_campaign=integration-'
  );

  const bodyHtml = md.render(mdSource);
  const html = htmlShell(exchange, bodyHtml);
  await writeFile(dstPath, html);
  console.log(`[render] ${exchange}.md -> landing/integrations/${exchange}.html (${html.length} bytes)`);
}

async function main() {
  await mkdir(TARGET_DIR, { recursive: true });
  console.log(`[render] source=${SOURCE_DIR}`);
  console.log(`[render] target=${TARGET_DIR}`);
  for (const ex of EXCHANGES) {
    await renderOne(ex);
  }
  console.log(`[render] OK — ${EXCHANGES.length} HTML mirrors written`);
}

main().catch((err) => {
  console.error('[render] FATAL:', err);
  process.exit(1);
});
