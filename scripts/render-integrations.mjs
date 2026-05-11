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
 * mint theme used by landing/docs.html so the mirror reads as part of
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

// DESIGN-W10 / C3 (2026-05-11): canonical Nav (8-item, post-W9 + post-W7-FF state)
// VERBATIM from live algovault.com lines 178-201 per audits/DESIGN-W10-canonical-
// chrome-extract.md §1. Per-page substitutions: (a) Q-W10-2 active-link styling on
// `Integrations` link → `text-mint-400 font-medium`; (b) Q-W10-7 OPTION B utm-
// injection on `/track-record` link to preserve Plausible attribution.
function canonicalNavHtml(exchange) {
  return `<nav class="fixed top-0 w-full z-50 border-b border-white/5" style="background:rgba(6,10,20,0.85);backdrop-filter:blur(12px)">
  <div class="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
    <a href="/" class="flex items-center gap-2.5" aria-label="AlgoVault home">
      <img src="/logo.png" alt="AlgoVault Logo" class="w-7 h-7 rounded-md">
      <span class="text-white font-semibold text-sm">AlgoVault Labs</span>
    </a>
    <div class="hidden sm:flex items-center gap-6 text-sm text-gray-400">
      <a href="/track-record?utm_source=tutorial&utm_medium=web&utm_campaign=integration-${exchange}" class="hover:text-white transition">Track Record</a>
      <a href="/#pricing" class="hover:text-white transition">Pricing</a>
      <a href="/integrations" class="text-mint-400 font-medium">Integrations</a>
      <a href="/skills" class="hover:text-white transition">Skills</a>
      <a href="/docs.html" class="hover:text-white transition">Docs</a>
      <a href="/verify" class="hover:text-white transition">Verify</a>
      <a href="https://api.algovault.com/account" class="hover:text-white transition">Account</a>
      <a href="https://api.algovault.com/signup" class="px-3 py-1 bg-mint-500/15 border border-mint-500/30 text-mint-400 hover:bg-mint-500/25 rounded-full text-xs font-semibold transition">Signup</a>
    </div>
  </div>
</nav>`;
}

// DESIGN-W10 / C3: canonical Footer VERBATIM (desktop variant, /tmp/live-landing.html
// line 493 per chrome-extract §2). Per Q-W10-7: canonical Footer ships verbatim WITHOUT
// utm-injection (no /track-record link in default Footer; utm preservation applies to
// Nav-Footer-Body links, not Footer-only links).
const CANONICAL_FOOTER_HTML = `<footer style="padding:44px 80px 56px;border-top:1px solid var(--line);background:oklch(0.13 0.012 265);display:flex;flex-direction:row;align-items:center;justify-content:space-between;gap:24px;font-size:13px;color:var(--fg-3)">
  <div style="display:flex;align-items:center;gap:10px">
    <img src="/logo.png" alt="AlgoVault" style="width:22px;height:22px;border-radius:6px;object-fit:contain;flex-shrink:0">
    <span style="color:var(--fg-2)">Built by AlgoVault Labs</span>
  </div>
  <div style="display:flex;align-items:center;gap:28px;flex-wrap:wrap">
    <a href="https://github.com/AlgoVaultLabs" target="_blank" rel="noopener" style="color:var(--fg-3);text-decoration:none">GitHub</a>
    <a href="https://x.com/AlgoVaultLabs" target="_blank" rel="noopener" style="color:var(--fg-3);text-decoration:none">X / Twitter</a>
    <a href="/signup" style="color:var(--fg-3);text-decoration:none">Signup</a>
    <a href="/privacy" style="color:var(--fg-3);text-decoration:none">Privacy</a>
  </div>
</footer>`;

// DESIGN-W10-FF-2 (2026-05-12): strip the "TL;DR (3-line hook — MOAT-led)" h2 + bullet
// list from rendered tutorial HTML per Mr.1 directive ("I means remove this section,
// not the section cards"). Section is redundant with the quotable-fact callout above
// the article (both make the MOAT pitch — composite verdict, cross-venue, Merkle-
// anchored). Upstream markdown source PRESERVED at algovault-skills/docs/integrations/
// <x>.md for GitHub readers + Skills Hub PR consumers; strip is signal-MCP-side only.
function stripTLDRSection(bodyHtml) {
  return bodyHtml.replace(
    /<h2>TL;DR[^<]*<\/h2>\s*<ul>[\s\S]*?<\/ul>\s*/,
    ''
  );
}

// DESIGN-W10-FF-3 (2026-05-12): strip the snapshot blockquote pair (3 consecutive
// elements after the markdown H1) from rendered tutorial HTML per Mr.1 directive
// ("Remove the whole part that I circle in red"). Block structure:
//   1. <blockquote><!-- snapshot: ... --></blockquote>   ← marker block
//   2. <p><strong>X% PFE Win Rate · Y+ calls · Z+ Merkle-verified on-chain batches.</strong></p>
//   3. <blockquote>Don't trust — verify the track record → Snapshot taken DATE
//      — live numbers refreshed in-page from API_URL</blockquote>
// All 3 are redundant with the quotable-fact callout above the article (which
// already shows live PFE WR / signal count / Merkle batch count via data-tr-field
// hydration). Upstream markdown source PRESERVED at algovault-skills/docs/
// integrations/<x>.md for GitHub readers + Skills Hub PR consumers.
function stripSnapshotBlock(bodyHtml) {
  return bodyHtml.replace(
    /<blockquote>\s*<!-- snapshot:[\s\S]*?-->\s*<\/blockquote>\s*<p><strong>[\s\S]*?Merkle-verified on-chain batches\.<\/strong><\/p>\s*<blockquote>\s*<p>Don['’]t trust[\s\S]*?performance-public<\/a>[\s\S]*?<\/blockquote>\s*/,
    ''
  );
}

// DESIGN-W10 / C3 / Q-W10-4 + Q-W10-6: wrap each top-level h2 section of markdown-
// rendered HTML in a tier-stat-card VCard. Splits bodyHtml on `<h2>` boundaries.
// First chunk (pre-first-h2) — the markdown H1 + intro paragraph + quotable-fact +
// callout block — gets its own tier-stat-card wrapper (the "intro section").
// Each subsequent chunk (`<h2>...next-h2-or-end`) gets its own wrapper.
function wrapH2InTierStatCard(bodyHtml) {
  // Find all <h2 offsets (allow optional attrs on <h2 e.g. <h2 id="..."> from markdown-it linkify).
  const re = /<h2(?=[ >])/g;
  const offsets = [];
  let m;
  while ((m = re.exec(bodyHtml)) !== null) {
    offsets.push(m.index);
  }
  if (offsets.length === 0) {
    // No h2 — wrap the entire body in a single card.
    return `<div class="tier-stat-card" style="padding:24px;gap:0;margin-bottom:18px">${bodyHtml}</div>`;
  }
  // First chunk: before-first-h2 (intro section)
  const chunks = [];
  const intro = bodyHtml.slice(0, offsets[0]).trim();
  if (intro) {
    chunks.push(`<div class="tier-stat-card" style="padding:24px;gap:0;margin-bottom:18px">${intro}</div>`);
  }
  // Per-h2 chunks
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : bodyHtml.length;
    const section = bodyHtml.slice(start, end).trim();
    chunks.push(`<div class="tier-stat-card" style="padding:24px;gap:0;margin-bottom:18px">${section}</div>`);
  }
  return chunks.join('\n');
}

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

function techArticleSchema(exchange, display) {
  // WEBSITE-REFRESH-W1 follow-up: replaced HowTo (deprecated by Google for
  // SERP rich results in Aug 2023) with TechArticle, which IS rich-result
  // eligible. The HowTo was valid markup but produced "No items detected"
  // in Google's Rich Results Test — TechArticle resolves that.
  const canonical = `https://algovault.com/docs/integrations/${exchange}`;
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "headline": `AlgoVault × ${display} - Build Verifiable AI Trading Agents`,
    "url": canonical,
    "datePublished": "2026-04-25T00:00:00+00:00",
    "dateModified": `${SNAPSHOT_DATE}T15:00:00+00:00`,
    "author": { "@type": "Organization", "name": "AlgoVault Labs", "url": "https://algovault.com" },
    "publisher": { "@type": "Organization", "name": "AlgoVault Labs", "url": "https://algovault.com", "logo": { "@type": "ImageObject", "url": "https://algovault.com/logo.png", "width": 512, "height": 512 } },
    "image": { "@type": "ImageObject", "url": "https://algovault.com/logo.png", "width": 512, "height": 512 },
    "description": `Pair AlgoVault MCP's composite verdict (${SNAPSHOT_PFE_WR}+ PFE Win Rate, Merkle-anchored on Base L2) with ${display}'s execution kit to ship a complete trading agent. Demo runs testnet/demo only — zero real-money risk in any code path.`,
    "proficiencyLevel": "Intermediate|Advanced",
    "about": { "@type": "Thing", "name": `${display} integration with AlgoVault MCP composite verdict` }
  };
}

function htmlShell(exchange, bodyHtml) {
  const title = pageTitle(exchange);
  const display = DISPLAY_NAMES[exchange] ?? (exchange.charAt(0).toUpperCase() + exchange.slice(1));
  const description = `Pair AlgoVault MCP's composite verdict with ${display}'s agent execution kit. Free testnet demo · ${SNAPSHOT_PFE_WR} PFE Win Rate · ${SNAPSHOT_SIGNAL_COUNT}+ calls · ${SNAPSHOT_BATCH_COUNT}+ Merkle-verified on-chain batches.`;
  const canonical = `https://algovault.com/docs/integrations/${exchange}`;
  const techArticle = JSON.stringify(techArticleSchema(exchange, display), null, 2);
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
<!-- BEGIN: AlgoVault canonical design loader (DESIGN-W2 / D2-C) -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/_design/algovault-design.css">
<!-- END: AlgoVault canonical design loader -->
<script defer src="/js/track-record-proxy.js"></script>
<!-- WEBSITE-REFRESH-W1 C7 — Schema.org TechArticle for Google rich-results
     eligibility (replaced HowTo which Google deprecated for SERP rich
     results in Aug 2023; TechArticle is current rich-result-eligible). -->
<script type="application/ld+json">
${techArticle}
</script>
<!-- Privacy-friendly analytics by Plausible (WEBSITE-REFRESH-W1 C6) -->
<script async src="https://plausible.io/js/pa-RwGaS0xWrfzs4vNSkMOAX.js"></script>
<script>
  window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
  plausible.init()
</script>
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
  /* DESIGN-W10 / C3 / Q-W10-10 cascade: use canonical CSS variables for body background.
     algovault-design.css defines --bg / --fg / --fg-2 / --fg-3 / --line / --mint tokens. */
  body { background: var(--bg); color: var(--fg-2, #d1d5db); font-family: var(--font-text, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); margin: 0; padding: 0; }
  /* Inline code + pre code — neutral colors preserved (no gold per DESIGN-W10 swap).
     Build Rule 8 exemption applies to syntax-highlighting inline color spans inside
     code blocks (preserved if present in markdown source). */
  code { font-family: var(--font-mono, 'SF Mono', 'Fira Code', 'Cascadia Code', monospace); background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  pre { overflow-x: auto; background: oklch(0.13 0.012 265); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin: 16px 0; }
  pre code { background: none; padding: 0; font-size: 0.85em; line-height: 1.6; color: var(--fg); }
  /* DESIGN-W10 / C3: article headings — gold (#d4b255 / #c4a34a) → var(--fg) neutral. */
  article h1 { font-size: 2.25rem; font-weight: 700; margin: 0 0 0.5em; color: var(--fg); }
  article h2 { font-size: 1.6rem; font-weight: 600; margin: 0 0 0.5em; color: var(--fg); padding-top: 0; border-top: none; }
  article h3 { font-size: 1.2rem; font-weight: 600; margin: 1.25em 0 0.4em; color: var(--fg-2); }
  article p { margin: 0.75em 0; line-height: 1.7; }
  article ul, article ol { margin: 0.75em 0; padding-left: 1.5em; line-height: 1.7; }
  article li { margin: 0.25em 0; }
  /* DESIGN-W10 / C3: article links — gold → var(--mint). */
  article a { color: var(--mint); text-decoration: underline; }
  article a:hover { filter: brightness(1.1); }
  article strong { color: var(--fg); font-weight: 600; }
  /* DESIGN-W10 / C3: blockquote — gold accent → mint. */
  article blockquote { border-left: 3px solid var(--mint); padding-left: 16px; margin: 1em 0; color: var(--fg-3); font-style: italic; background: oklch(0.86 0.16 165 / 0.05); padding: 12px 16px; border-radius: 0 4px 4px 0; }
  article table { width: 100%; border-collapse: collapse; margin: 1em 0; }
  article th, article td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--line); }
  article th { color: var(--fg); font-weight: 600; }
  article hr { border: none; border-top: 1px solid var(--line); margin: 2em 0; }
</style>
</head>
<body>
<!-- DESIGN-W10 / C3 / Q-W10-1 + Q-W10-2 + Q-W10-7 OPTION B: canonical Nav (Integrations
     active-link + per-page utm-injected /track-record link). REPLACES the pre-W10
     legacy header block per Q-W10-8 ratification. -->
${canonicalNavHtml(exchange)}

<!-- DESIGN-W10 / C3: canonical hero scaffolding (artboard + 3 bg layers + VEyebrow). -->
<main class="lp-integrations-desktop">
  <div class="artboard" style="padding:100px 24px 64px;max-width:1024px;margin:0 auto;width:100%">
    <div class="bg-grid"></div>
    <div class="bg-radial-accent"></div>
    <div class="bg-noise"></div>
    <div style="position:relative;z-index:1">
      <div class="placeholder-cap" style="margin-bottom:14px">· ${exchange} integration</div>
      <!-- WEBSITE-REFRESH-W1 C7 — quotable factoid block (Schema.org Claim) for LLM citation. PRESERVED byte-identical per W10 preservation-LAW. -->
      <p class="quotable-fact" style="background: rgba(16,185,129,0.05); border-left: 3px solid #10b981; padding: 12px 16px; margin: 0 0 24px; border-radius: 0 4px 4px 0; color: #6ee7b7; font-size: 0.95em;" itemscope itemtype="https://schema.org/Claim">
        <span itemprop="claimReviewed">AlgoVault has <strong style="color:#a7f3d0"><span data-tr-field="pfe_wr">${SNAPSHOT_PFE_WR}</span></strong>+ PFE Win Rate across <strong style="color:#a7f3d0"><span data-tr-field="signal_count">${SNAPSHOT_SIGNAL_COUNT}</span></strong>+ signal calls, each Merkle-anchored on Base L2 (verifiable at <a href="/track-record" itemprop="url" style="color:#d4b255">algovault.com/track-record</a>).</span>
      </p>
      <!-- DESIGN-W10-FF-2 (2026-05-12): tier-stat-card per-section wrapping RESTORED
           (W10-FF-1 removal was based on misread of Mr.1 directive). Mr.1 clarified:
           "I means remove this section, not the section cards" — referring to the
           TL;DR section content, not the visual card structure. wrapH2InTierStatCard()
           wraps each h2 section + intro in a card; stripTLDRSection() removes the
           redundant TL;DR section before wrapping (so it doesn't become an empty card). -->
      <article>
${wrapH2InTierStatCard(stripTLDRSection(stripSnapshotBlock(bodyHtml)))}
      </article>
    </div>
  </div>
</main>

<!-- DESIGN-W10 / C3: canonical Footer (verbatim from live algovault.com line 493).
     REPLACES the pre-W10 legacy footer block per Q-W10-8 ratification. -->
${CANONICAL_FOOTER_HTML}
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

  let bodyHtml = md.render(mdSource);
  // AUTO-TRACE-W1 (2026-04-30): wrap the literal capability counter "5
  // exchanges" with the live-proxy span so every re-render preserves the
  // auto-update behavior. The upstream MD source is owned by the
  // algovault-skills repo; doing the wrap here keeps the post-process
  // localized and means the upstream MD doesn't have to know about the
  // proxy contract. Idempotent: re-running on already-wrapped HTML is a
  // no-op because the inner literal "5 exchanges" no longer matches the
  // unwrapped pattern.
  bodyHtml = bodyHtml.replace(
    /(?<!data-tr-field="exchange_count">)\b5 exchanges\b/g,
    '<span data-tr-field="exchange_count">5</span> exchanges',
  );
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
