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
import { createRequire } from 'node:module';
import MarkdownIt from 'markdown-it';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// FOOTER-UNIFY-W1: the brand footer comes from the single SoT (compiled
// dist/lib/footer-content.js; run `npm run build` before this generator).
// createRequire loads the tsc-emitted CJS module from this ESM script.
const require = createRequire(import.meta.url);
const { renderBrandFooter } = require(join(ROOT, 'dist', 'lib', 'footer-content.js'));
// OPS-INTEGRATIONS-LIVE-SOT-W1: the supported-exchange COUNT comes from the one
// venue SoT (src/lib/capabilities.ts → dist/lib/capabilities.js), never a hand-
// typed literal, so the page count can't diverge from /api/performance-public.
// NOTE: imported as SOT_EXCHANGE_COUNT — this file already has its own local
// `EXCHANGES` const, which is the list of 7 tutorial SLUGS (binance, gemini,
// kraken, …), a DIFFERENT set from the 12 signal venues. Do not conflate them.
const { EXCHANGE_COUNT: SOT_EXCHANGE_COUNT } = require(join(ROOT, 'dist', 'lib', 'capabilities.js'));
// BROKER-PAIRING-CRYPTO-W1 (2026-06-05): +3 crypto agentic-trading kits
// (Gemini self-hosted MCP / Kraken CLI / Alpaca crypto MCP) extend the
// exchange-kit tutorial pattern; sources in algovault-skills/docs/integrations/.
// OPS-INTEGRATIONS-VENUE-PAGES-W1 (2026-07-21): +4 signal-venue tutorials.
// HTX / MEXC / Phemex / Gate.io were verified and HALTed — see
// audits/OPS-INTEGRATIONS-VENUE-PAGES-W1-endpoint-truth.md for why.
const EXCHANGES = ['binance', 'okx', 'bybit', 'bitget', 'gemini', 'kraken', 'alpaca',
  'hyperliquid', 'aster', 'bingx', 'kucoin'];
// AI-AGENT-FRAMEWORK-TUTORIALS-W1 (2026-05-18): 4 framework integration mirrors
// extend the same render pipeline. Same template — eyebrow shows `<slug> integration`,
// canonical URL = /integrations/<slug>, page title = AlgoVault × <Display>.
const FRAMEWORKS = ['langchain', 'llamaindex', 'maf', 'crewai'];
// INTEGRATIONS-FULL-STACK-W1 C4 (2026-05-19): 5 MCP-client pages sourced
// from THIS repo at `docs/integrations/mcp-clients/<slug>.md` (NOT the
// algovault-skills repo). Same htmlShell template; getSrcPath() routes
// per-slug.
const MCP_CLIENTS = ['claude-desktop', 'claude-code', 'cursor', 'cline', 'smithery'];
const ALL_TARGETS = [...EXCHANGES, ...FRAMEWORKS, ...MCP_CLIENTS];

const args = process.argv.slice(2);
const sourceArg = args[args.indexOf('--source') + 1];
const SOURCE_REPO = sourceArg && sourceArg !== '--source'
  ? sourceArg
  : join(homedir(), 'git', 'algovault-skills');

const SOURCE_DIR = join(SOURCE_REPO, 'docs', 'integrations');
const LOCAL_MCP_CLIENTS_DIR = join(ROOT, 'docs', 'integrations', 'mcp-clients');
const TARGET_DIR = join(ROOT, 'landing', 'integrations');

function getSrcPath(slug) {
  if (MCP_CLIENTS.includes(slug)) {
    return join(LOCAL_MCP_CLIENTS_DIR, `${slug}.md`);
  }
  return join(SOURCE_DIR, `${slug}.md`);
}

// html: true required so source MDs can include <span data-tr-field="..."> for
// the live track-record proxy (see WEBSITE-REFRESH-W1 C1).
const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Acronym-aware target display names (avoid auto-cap "OKX" → "Okx").
const DISPLAY_NAMES = {
  binance: 'Binance',
  okx: 'OKX',
  bybit: 'Bybit',
  bitget: 'Bitget',
  // BROKER-PAIRING-CRYPTO-W1 crypto agentic-trading kits
  gemini: 'Gemini',
  kraken: 'Kraken',
  alpaca: 'Alpaca',
  // AI-AGENT-FRAMEWORK-TUTORIALS-W1 frameworks
  langchain: 'LangChain',
  llamaindex: 'LlamaIndex',
  maf: 'Microsoft Agent Framework',
  crewai: 'CrewAI',
  // INTEGRATIONS-FULL-STACK-W1 C4 MCP clients
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  // OPS-INTEGRATIONS-VENUE-PAGES-W1 — labels VERBATIM from capabilities.ts EXCHANGES.
  hyperliquid: 'Hyperliquid',
  aster: 'Aster',
  bingx: 'BingX',
  kucoin: 'KuCoin',
  cursor: 'Cursor',
  cline: 'Cline (VSCode)',
  smithery: 'Smithery',
};

// NAV-PLATFORM-GENERATOR-W1 (A1): canonicalNavHtml() RETIRED. The per-page integration nav is
// now the ONE unified nav — injected by scripts/build_nav.mjs from src/lib/site-nav.ts
// renderSiteNav() (single-derivation across all 26 surfaces). Integration pages emit empty
// <!-- NAV:START/END --> markers (below); build_nav fills them. Consequences of unification:
//   • hrefs are ABSOLUTE (A6), not relative — one region works apex + api-served.
//   • the /track-record link no longer carries a per-page utm_campaign (a byte-identical region
//     cannot; body-embedded tutorial links KEEP their utm for Plausible attribution).
//   • the "Integrations" active-link is applied CLIENT-SIDE by the controller (URL match).
const NAV_REGION_MARKERS = '<!-- NAV:START -->\n<!-- NAV:END -->';

// DESIGN-W10 / C3: canonical Footer VERBATIM (desktop variant, /tmp/live-landing.html
// line 493 per chrome-extract §2). Per Q-W10-7: canonical Footer ships verbatim WITHOUT
// utm-injection (no /track-record link in default Footer; utm preservation applies to
// Nav-Footer-Body links, not Footer-only links).
// FOOTER-UNIFY-W1: single-source brand footer (was an inline literal copy → drift). Desktop variant.
const CANONICAL_FOOTER_HTML = renderBrandFooter('desktop');

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

// OPS-INTEGRATION-COPY-HYGIENE (2026-06-05, Mr.1): internal strategy language
// ("MOAT") is never public-facing. Strip any heading parenthetical that
// contains "MOAT" (e.g. "Why AlgoVault? (closing — MOAT recap)") from the
// rendered HTML as a generator-level guarantee — the source .md headings are
// kept clean too, so this only fires if a future source reintroduces one.
// Reader-facing hints like "(90s read)" / "(3-line hook)" are preserved
// (no MOAT token, so they never match).
function stripInternalHeadingAnnotations(bodyHtml) {
  return bodyHtml.replace(
    /(<h[1-6][^>]*>[^<]*?)\s*\([^)]*\bMOAT\b[^)]*\)/gi,
    '$1',
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

// WEBSITE-REFRESH-W1 C1 — number snapshot for the initial render.
// Live source of truth: /api/performance-public + /api/merkle-batches (proxied
// at runtime by /js/track-record-proxy.js to update [data-tr-field] elements).
//
// OPS-INTEGRATIONS-LIVE-SOT-W1: these were hand-maintained consts that last
// moved on 2026-04-26 and rotted (89.4% / 56,375 vs a live 91.5% / 383,785).
// They are now READ LIVE at regen; the literals below are only a fail-open
// FLOOR. Monotonic-safe: every rendered count carries a trailing `+`, so a
// floor understates rather than overstates.
//
// TODO: revisit fallback floor by 2026-08-03
const SNAPSHOT_FALLBACK = Object.freeze({
  pfeWr: '91.5%',
  callCount: '383,785',
  batchCount: '100',
  assetCount: '1330',
});

/** Mutated once by `main()` before any page renders. */
let SNAPSHOT = {
  ...SNAPSHOT_FALLBACK,
  date: new Date().toISOString().slice(0, 10),
  live: false,
};

/**
 * Read the live numbers exactly as `scripts/snapshot-landing-data.mjs` does —
 * native fetch, short timeout, fail-open. A regen must never be blocked by an
 * unreachable SoT; it just renders the floor.
 *
 * Values are validated before use: `pfeWinRate` is a FRACTION (`number | null`)
 * and a bad/absent count would otherwise render "0.0%" / "0" as public fact.
 */
async function fetchSnapshot() {
  const base = process.env.API_BASE_URL || 'https://api.algovault.com';
  const out = { ...SNAPSHOT_FALLBACK, date: new Date().toISOString().slice(0, 10), live: false };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  try {
    const perf = await fetch(`${base}/api/performance-public`, { signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? r.json() : null));
    const calls = num(perf?.totalCalls);
    const wr = num(perf?.overall?.pfeWinRate);
    if (calls && wr && wr <= 1) {
      out.callCount = calls.toLocaleString('en-US');
      out.pfeWr = `${(wr * 100).toFixed(1)}%`;
      out.live = true;
    }
    // Floor-rounded to the nearest 10 — mirrors formatAssetCount() in
    // track-record-proxy.js exactly, so the baked floor equals what the proxy paints.
    const assets = num(perf?.asset_count);
    if (assets) out.assetCount = String(Math.floor(assets / 10) * 10);
  } catch { /* fail-open — floor stands */ }
  try {
    const merkle = await fetch(`${base}/api/merkle-batches`, { signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? r.json() : null));
    // OPS-CAPPED-COLLECTION-GUARD-W1: server-derived COUNT(*) ONLY. `batches` is a
    // LIMIT-capped page, so its length pins at the cap once more batches exist — the
    // array fallback was the wrong-number shape kept alive. Absent field → floor
    // stands (this function's existing fail-open idiom), never a short count.
    const n = typeof merkle?.batch_count === 'number' ? merkle.batch_count : 0;
    if (n > 0) out.batchCount = String(n);
  } catch { /* fail-open — floor stands */ }
  return out;
}

/**
 * Live-proxy hooks that `landing/js/track-record-proxy.js` actually calls
 * setField() for. A `data-tr-field` outside this set NEVER hydrates — its
 * literal is frozen at bake time. Keep in sync with that file.
 *
 * The retired keys map to their live successors: `signal_count` was dropped in
 * v1.10.0 (OUTPUT-SANITIZE-W1 C5) in favour of `call_count`.
 */
const RETIRED_TR_HOOKS = Object.freeze({
  signal_count: 'call_count',
  total_calls: 'call_count',
  merkle_batches: 'merkle_batch_count',
});

/**
 * Normalise track-record hooks + numbers in upstream-authored body HTML.
 *
 * Mirrors `scripts/refresh-integrations-numbers.mjs` (the committed-page
 * refresher) so both paths agree byte-for-byte — a page is identical whether it
 * was re-rendered from source or refreshed in place. Single-derivation: both
 * read the same SNAPSHOT + venue SoT.
 */
function normaliseTrackRecordBody(bodyHtml) {
  let out = bodyHtml;
  for (const [dead, live] of Object.entries(RETIRED_TR_HOOKS)) {
    out = out.replaceAll(`data-tr-field="${dead}"`, `data-tr-field="${live}"`);
  }
  const setField = (key, value) =>
    (out = out.replace(
      new RegExp(`(<span data-tr-field="${key}">)[^<]*(</span>)`, 'g'),
      `$1${value}$2`,
    ));
  setField('pfe_wr', SNAPSHOT.pfeWr);
  setField('call_count', SNAPSHOT.callCount);
  setField('batch_count', SNAPSHOT.batchCount);
  setField('merkle_batch_count', SNAPSHOT.batchCount);
  setField('exchange_count', String(SOT_EXCHANGE_COUNT));
  if (SNAPSHOT.assetCount) setField('asset_count', SNAPSHOT.assetCount);
  return out;
}

function techArticleSchema(exchange, display) {
  // WEBSITE-REFRESH-W1 follow-up: replaced HowTo (deprecated by Google for
  // SERP rich results in Aug 2023) with TechArticle, which IS rich-result
  // eligible. The HowTo was valid markup but produced "No items detected"
  // in Google's Rich Results Test — TechArticle resolves that.
  const canonical = `https://algovault.com/integrations/${exchange}`;
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "headline": `AlgoVault × ${display} - Build Verifiable AI Trading Agents`,
    "url": canonical,
    "datePublished": "2026-04-25T00:00:00+00:00",
    "dateModified": `${SNAPSHOT.date}T15:00:00+00:00`,
    "author": { "@type": "Organization", "name": "AlgoVault Labs", "url": "https://algovault.com" },
    "publisher": { "@type": "Organization", "name": "AlgoVault Labs", "url": "https://algovault.com", "logo": { "@type": "ImageObject", "url": "https://algovault.com/logo.png", "width": 512, "height": 512 } },
    "image": { "@type": "ImageObject", "url": "https://algovault.com/logo.png", "width": 512, "height": 512 },
    // OPS-INTEGRATIONS-LIVE-SOT-W1: crawler-facing prose carries NO volatile
    // number. Meta + JSON-LD cannot self-heal (no client proxy runs for a
    // crawler), so a baked figure here rots permanently — the class is killed
    // by removing the number, not by refreshing it. Body spans keep the numbers.
    "description": `Pair AlgoVault MCP's composite verdict (verifiable, Merkle-anchored on Base L2 across our supported exchanges) with ${display}'s execution kit to ship a complete trading agent. Demo runs testnet/demo only — zero real-money risk in any code path.`,
    "proficiencyLevel": "Intermediate|Advanced",
    "about": { "@type": "Thing", "name": `${display} integration with AlgoVault MCP composite verdict` }
  };
}

function htmlShell(exchange, bodyHtml) {
  const title = pageTitle(exchange);
  const display = DISPLAY_NAMES[exchange] ?? (exchange.charAt(0).toUpperCase() + exchange.slice(1));
  const description = `Pair AlgoVault MCP's verifiable, Merkle-anchored composite verdict across our supported exchanges with ${display}'s agent execution kit. Free testnet demo — zero real-money risk in any code path.`;
  const canonical = `https://algovault.com/integrations/${exchange}`;
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
<meta name="last-updated" content="${SNAPSHOT.date}">
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
<!-- ANALYTICS:START -->
<!-- ANALYTICS:END -->
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
<!-- NAV-PLATFORM-GENERATOR-W1 (A1): unified nav region — scripts/build_nav.mjs injects the
     shared renderSiteNav() here (single-derivation; retires the old per-page canonicalNavHtml). -->
${NAV_REGION_MARKERS}

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
        <span itemprop="claimReviewed">AlgoVault has <strong style="color:#a7f3d0"><span data-tr-field="pfe_wr">${SNAPSHOT.pfeWr}</span></strong>+ PFE Win Rate across <strong style="color:#a7f3d0"><span data-tr-field="call_count">${SNAPSHOT.callCount}</span></strong>+ signal calls, each Merkle-anchored on Base L2 (verifiable at <a href="/track-record" itemprop="url" style="color:#d4b255">algovault.com/track-record</a>).</span>
      </p>
      <!-- DESIGN-W10-FF-2 (2026-05-12): tier-stat-card per-section wrapping RESTORED
           (W10-FF-1 removal was based on misread of Mr.1 directive). Mr.1 clarified:
           "I means remove this section, not the section cards" — referring to the
           TL;DR section content, not the visual card structure. wrapH2InTierStatCard()
           wraps each h2 section + intro in a card; stripTLDRSection() removes the
           redundant TL;DR section before wrapping (so it doesn't become an empty card). -->
      <article>
${wrapH2InTierStatCard(stripInternalHeadingAnnotations(stripTLDRSection(stripSnapshotBlock(bodyHtml))))}
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
  const srcPath = getSrcPath(exchange);
  const dstPath = join(TARGET_DIR, `${exchange}.html`);
  let mdSource = await readFile(srcPath, 'utf8');

  // SEO-STRIP-TRACKING-PARAMS-W1: strip the utm_* tracking triple from the
  // INTERNAL algovault.com/track-record link in the rendered (web) mirror.
  // An internal utm_source makes Google treat /track-record?utm_… as a
  // duplicate of the canonical /track-record (crawl-budget waste + mixed
  // canonical signals; Google "Consolidate duplicate URLs") and makes GA-style
  // analytics start a NEW acquisition mid-session. The GitHub-facing markdown
  // KEEPS its ?utm_source=tutorial&utm_medium=repo variant (out of scope — that
  // renders on github.com, not algovault.com). Idempotent: a link with no query
  // no longer matches. (Superseded the prior repo→web channel rewrite, which
  // only relabeled the medium instead of removing the internal tracking param.)
  mdSource = mdSource.replace(
    /(https:\/\/algovault\.com\/track-record)\?utm_source=tutorial&utm_medium=(?:repo|web)&utm_campaign=integration-[a-z0-9-]+/g,
    '$1',
  );

  let bodyHtml = md.render(mdSource);
  // SEO-STRIP-TRACKING-PARAMS-W1: with the utm_campaign removed above, preserve the
  // per-exchange click attribution on the (now clean) body track-record link(s) via a
  // Plausible custom event — same pattern as the /integrations index cards
  // (renderIndexCard). Body links only: md.render emits `<a href="…/track-record">`
  // with an IMMEDIATE `>`, whereas the nav/drawer /track-record links (injected later
  // by build_nav) carry class attributes, so they never match this pattern.
  bodyHtml = bodyHtml.replace(
    /<a href="https:\/\/algovault\.com\/track-record">/g,
    `<a href="https://algovault.com/track-record" onclick="if(window.plausible)plausible('CTA Click',{props:{source:'integration_tutorial',slug:'${exchange}',campaign:'track-record'}})">`,
  );
  // AUTO-TRACE-W1 (2026-04-30): wrap the literal capability counter "N
  // exchanges" with the live-proxy span so every re-render preserves the
  // auto-update behavior. The upstream MD source is owned by the
  // algovault-skills repo; doing the wrap here keeps the post-process
  // localized and means the upstream MD doesn't have to know about the
  // proxy contract. Idempotent: re-running on already-wrapped HTML is a
  // no-op because the digits are then followed by "</span>", not " exchanges".
  //
  // OPS-INTEGRATIONS-LIVE-SOT-W1: matches ANY digit count, not just the
  // upstream's hardcoded "5", and NORMALISES it to the venue SoT. Upstream MD
  // still says "5 exchanges"; rather than requiring an external-repo edit to
  // correct it, the generator now rewrites whatever number it finds to
  // SOT_EXCHANGE_COUNT — so an out-of-date upstream can no longer leak a wrong
  // count onto a public page.
  bodyHtml = bodyHtml.replace(
    /(?<!data-tr-field="exchange_count">)\b\d+ exchanges\b/g,
    `<span data-tr-field="exchange_count">${SOT_EXCHANGE_COUNT}</span> exchanges`,
  );

  // OPS-INTEGRATIONS-VENUE-PAGES-W1 — body-content normalisation (the
  // structural half of the fix).
  //
  // Everything above normalises only what THIS generator authors. The tutorial
  // BODY comes from the algovault-skills repo, and it used to pass through raw
  // — so an upstream `.md` carrying a retired literal or a dead live-proxy hook
  // leaked it straight onto a public page. That is exactly how `89.4%` /
  // `56,375` / `data-tr-field="signal_count"` survived from 2026-04-26 to
  // 2026-07-19, and re-running this generator would have re-introduced them
  // even after the rendered pages were corrected.
  //
  // Now the generator is the single normalisation point: whatever the upstream
  // says, the rendered page carries live-hydrating hooks and live numbers. The
  // upstream sources were corrected in the same wave, but this makes the class
  // structurally unable to return the next time someone edits a tutorial there.
  bodyHtml = normaliseTrackRecordBody(bodyHtml);

  const html = htmlShell(exchange, bodyHtml);
  await writeFile(dstPath, html);
  console.log(`[render] ${exchange}.md -> landing/integrations/${exchange}.html (${html.length} bytes)`);
}

async function main() {
  await mkdir(TARGET_DIR, { recursive: true });
  // OPS-INTEGRATIONS-LIVE-SOT-W1: read the numbers ONCE, before any page
  // renders, so all 16 mirrors carry an identical, live snapshot.
  SNAPSHOT = await fetchSnapshot();
  console.log(
    `[render] snapshot ${SNAPSHOT.live ? 'LIVE' : 'FALLBACK (SoT unreachable — rendering floor)'}` +
    ` pfeWr=${SNAPSHOT.pfeWr} callCount=${SNAPSHOT.callCount} batchCount=${SNAPSHOT.batchCount}` +
    ` assetCount=${SNAPSHOT.assetCount} exchanges=${SOT_EXCHANGE_COUNT} date=${SNAPSHOT.date}`,
  );
  console.log(`[render] source(exchanges + frameworks)=${SOURCE_DIR}`);
  console.log(`[render] source(mcp-clients)=${LOCAL_MCP_CLIENTS_DIR}`);
  console.log(`[render] target=${TARGET_DIR}`);
  for (const slug of ALL_TARGETS) {
    await renderOne(slug);
  }
  console.log(`[render] OK — ${ALL_TARGETS.length} HTML mirrors written (${EXCHANGES.length} exchanges + ${FRAMEWORKS.length} frameworks + ${MCP_CLIENTS.length} mcp-clients)`);
}

main().catch((err) => {
  console.error('[render] FATAL:', err);
  process.exit(1);
});
