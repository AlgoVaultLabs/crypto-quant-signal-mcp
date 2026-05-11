#!/usr/bin/env node
/**
 * DESIGN-W6 build-time JSX render pipeline.
 *
 * Reads JSX from `Design/AlgoVault Landing Hero v1/` (vault),
 * compiles via Babel (@babel/preset-react + commonjs),
 * eval's as a virtual module,
 * renders via ReactDOMServer.renderToString,
 * applies wave-level architect-ratified overrides:
 *   - SKIP TradFiCallout (Q-W10 spec rule 10)
 *   - FILTER X402 5th pricing tier (Q-W10)
 *   - OVERRIDE pricing tier name UPPERCASE → Title Case (Q-W18; W5 Q-D1)
 *   - INJECT <span data-tr-field> for live-stat placeholders (Q-W11/Q-W14)
 *   - MAP footer placeholder hrefs to real URLs (Q-W15)
 *   - REWRITE CoreCapabilities subtitle (Q-W16; factuality)
 *   - STRIP UseCases meta dates (Q-W13)
 *   - PATCH FAQ defaultOpen=true so all 5 answers ship in DOM
 * outputs static HTML to stdout or file.
 *
 * No production runtime React; build-time only.
 *
 * Usage:
 *   node scripts/render-jsx-static.mjs --target=belowfold --mobile=false --out=/tmp/preview.html
 *   node scripts/render-jsx-static.mjs --target=landing-rest --mobile=true --out=/tmp/lr-mobile.html
 *
 * Exit codes:
 *   0 = render success
 *   1 = JSX read / Babel compile / eval / render error (logged to stderr)
 *   2 = invalid args
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Module } from 'node:module';
import { JSDOM } from 'jsdom';
import babel from '@babel/core';
import React from 'react';
import { renderToString } from 'react-dom/server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const VAULT_DESIGN = '/Users/tank/My Drive/Obsidian Vault/AlgoVault MCP/Design/AlgoVault Landing Hero v1';

// JSDOM globals for JSX module-end Object.assign(window, {...}) hooks.
// Node 25 has read-only navigator getter on globalThis; assign defensively via defineProperty.
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://algovault.com/' });
function safeDefine(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  } catch {
    /* read-only — skip; JSX SSR for our 2 files doesn't need it (navigator.clipboard is inside an unfired onClick) */
  }
}
safeDefine('window', dom.window);
safeDefine('document', dom.window.document);
safeDefine('HTMLElement', dom.window.HTMLElement);
safeDefine('Element', dom.window.Element);
safeDefine('React', React); // JSX classic runtime needs React in scope

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function evalJsxSrc(src, filePath, exportNames) {
  // Append CommonJS export shim so we can extract named components after eval
  const shim = `\n;module.exports = { ${exportNames.join(', ')} };\n`;
  const fullSrc = src + shim;
  const compiled = babel.transformSync(fullSrc, {
    presets: ['@babel/preset-react'],
    plugins: ['@babel/plugin-transform-modules-commonjs'],
    filename: filePath,
    babelrc: false,
    configFile: false,
  });
  const m = new Module(filePath);
  m.filename = filePath;
  m.paths = Module._nodeModulePaths(path.dirname(filePath));
  m._compile(compiled.code, filePath);
  return m.exports;
}

// ── JSX-source patches (pre-Babel) ──────────────────────────────────────────

function patchBelowFold(src) {
  // Q-W16 + Mr.1 fix-forward 2026-05-11 ROUND 3: CoreCapabilities subtitle — "Four MCP tools" →
  // "Three MCP tools + on-chain track record" with line break between sentences per Mr.1 directive.
  // Factuality LAW: AlgoVault has 3 MCP tools + 1 on-chain track record callout (NOT 4 tools).
  return src.replace(
    'Four MCP tools your agent can call directly. Each returns a single, structured verdict — not raw indicators.',
    'Three MCP tools your agent can call — plus an on-chain track record.   Each returns a single, structured verdict — not raw indicators.'
  );
}

function patchLandingRest(src) {
  // FAQ all-open default for SSR — so all 5 answer divs ship in the DOM.
  let s = src.replace('defaultOpen={!!it.open}', 'defaultOpen={true}');

  // Mr.1 fix-forward 2026-05-11 ROUND 3 — 5 specific copy edits:

  // 1) ThreeTools H2: "3 tools, one verdict." → "3 tools, One verdict." (capital O)
  s = s.replaceAll('3 tools, one verdict.', '3 tools, One verdict.');

  // 2) ThreeTools subtitle: keep text but no specific change required (sentences are already split
  // by canonical layout LRLead component); Mr.1's text matches what's there.

  // 3) UseCases subtitle: drop the "call, confidence, regime, factors, every call Merkle-anchored
  // on Base L2" middle phrase per Mr.1 directive. New shorter form.
  s = s.replace(
    'AlgoVault MCP gives your agent a composite verdict in one call — call, confidence, regime, factors, every call Merkle-anchored on Base L2. Pair it with any of these official Agent Trade Kits to ship a complete trading agent.',
    'AlgoVault MCP gives your agent a composite verdict in one call. Pair it with any of these official Agent Trade Kits to ship a complete trading agent.'
  );

  // 4) UseCases trademark notice: drop the "All demos run testnet/demo only — zero real-money
  // risk in any code path." prefix per Mr.1 directive.
  s = s.replace(
    'All demos run testnet/demo only — zero real-money risk in any code path. AlgoVault returns analytics; your agent and risk policy decide what to execute. Exchange logos and names are trademarks of their respective owners. Used for nominative reference to integration tutorials. No partnership or endorsement implied.',
    'AlgoVault returns analytics; your agent and risk policy decide what to execute. Exchange logos and names are trademarks of their respective owners. Used for nominative reference to integration tutorials. No partnership or endorsement implied.'
  );

  // 5) LiveTrackRecord subtitle per Mr.1: "Every qualifying trade call (confidence ≥ 60%) is
  // tracked, Merkle-anchored on Base L2." (drops "PFE directional accuracy and excursion analysis. All public.")
  s = s.replace(
    'Every qualifying trade call (confidence ≥ 60%) is tracked. PFE directional accuracy and excursion analysis. All public.',
    'Every qualifying trade call (confidence ≥ 60%) is tracked, Merkle-anchored on Base L2.'
  );

  return s;
}

// ── Post-render overrides (HTML string-level) ───────────────────────────────

function applyTitleCase(html) {
  // Q-W18: pricing tier names UPPERCASE → Title Case (preserve W5 Q-D1 ratification)
  return html
    .replace(/>FREE</g, '>Free<')
    .replace(/>STARTER</g, '>Starter<')
    .replace(/>PRO</g, '>Pro<')
    .replace(/>ENTERPRISE</g, '>Enterprise<');
}

function filterX402Tier(html) {
  // Q-W10: strip 5th-card X402 article entirely; non-greedy match across <article>...X402 PER CALL...</article>
  return html.replace(/<article[^>]*?>(?:(?!<\/article>)[\s\S])*?X402 PER CALL(?:(?!<\/article>)[\s\S])*?<\/article>/g, '');
}

function injectLiveDataLiveTrack(html) {
  // Q-W11: 3 LIVE-tagged stats live-bind via existing track-record-proxy.js W3 hydration.
  // Mr.1 fix-forward 2026-05-11: % moved INSIDE span (was outside, causing double-% when
  // proxy.js setField writes formatted "90.2%" string).
  // 90.2% (LIVE PFE) — first occurrence only (LiveTrackRecord LIVE row)
  html = html.replace(/>90\.2%</, '><span data-tr-field="pfe_wr">90.2%</span><');
  // 80,059+ (LIVE Calls) — first occurrence; + stays outside span (proxy.js writes "80,059")
  html = html.replace(/>80,059\+</, '><span data-tr-field="call_count">80,059</span>+<');
  // 29 → context anchor on Merkle batches (avoid generic "29" matches)
  html = html.replace(/>29(<\/div><div[^>]*>[^<]*Merkle batches on-chain)/, '><span data-tr-field="merkle_batch_count">29</span>$1');
  // Top stats: "5 Exchanges" + "11 Timeframes" — wrap with proxy spans (live-bind via track-record-proxy.js).
  html = html.replace(/>5 Exchanges</, '><span data-tr-field="exchange_count">5</span> Exchanges<');
  html = html.replace(/>11 Timeframes</, '><span data-tr-field="timeframe_count">11</span> Timeframes<');
  return html;
}

function wrapCounterLiteralsInProse(html) {
  // Wrap every "5 exchanges" (lowercase, in prose / FAQ answers / pricing bullets) with a proxy
  // span. Required by tests/unit/copy-consistency.test.ts AUTO-TRACE-W1 capability-counter canary
  // — every "<digit> exchange(s)" / "<digit> timeframe(s)" literal must be inside a data-tr-field
  // proxy span (or inside a SNAPSHOT-LINE marker or inside JSON-LD description/text). React-
  // rendered prose text doesn't auto-wrap, so we substitute post-render. Conservative match: only
  // the canonical "5 exchanges" / "11 timeframes" forms; preserves non-counter occurrences (e.g.
  // "exchanges trading", "exchanges support").
  // Applied to ALL physical lines so every unique line satisfies the canary.
  html = html.replaceAll('5 exchanges', '<span data-tr-field="exchange_count">5</span> exchanges');
  html = html.replaceAll('11 timeframes', '<span data-tr-field="timeframe_count">11</span> timeframes');
  return html;
}

function injectLiveDataPricingTagline(html) {
  // Q-W14: SimplePricing tagline 3 placeholder values
  // Mr.1 fix-forward 2026-05-11: % moved INSIDE span (was outside, causing double-% when JS
  // setField populates with formatted "98.8%" string). Same pattern as Q-W7-1 PFE WR fix.
  // 98.8% big in tagline (single occurrence in SimplePricing render)
  html = html.replace(/>98\.8%</, '><span data-tr-field="hold_rate">98.8%</span><');
  // Tagline body paragraph: "We reject 98.8% of scans"
  html = html.replace(/We reject 98\.8% of scans/, 'We reject <span data-tr-field="hold_rate">98.8%</span> of scans');
  // "90.2%+ Merkle-verified accuracy on 80,059+ signals" — % stays outside span here because
  // track-record-proxy.js formats pfe_wr as "90.2%" but the literal in canvas is "90.2%+" (with
  // trailing PLUS sign indicating "or higher"). Strip the trailing + or move it. Going with %+
  // staying outside, but binding span to a NEW field that returns just the number. Since
  // track-record-proxy.js doesn't have a "pfe_wr_value" field returning just the number, use
  // the existing pfe_wr "90.2%" and SHIFT the +. Final form: span="<live>"+ "%+" → "<live>%+".
  // setField("pfe_wr") writes "90.2%" → final renders "90.2%+" (correct, % only once).
  html = html.replace(/90\.2%\+ Merkle-verified accuracy on 80,059\+ signals/, '<span data-tr-field="pfe_wr">90.2%</span>+ Merkle-verified accuracy on <span data-tr-field="call_count">80,059</span>+ signals');
  return html;
}

function applyFooterUrls(html) {
  // Q-W15: placeholder hrefs → real URLs (footer + ForDevelopers pills row).
  // Same architectural pattern: any `href={`#${labelText}`}` placeholder gets a real URL.
  return html
    .replace(/href="#GitHub"/g, 'href="https://github.com/AlgoVaultLabs" target="_blank" rel="noopener"')
    .replace(/href="#X \/ Twitter"/g, 'href="https://x.com/AlgoVaultLabs" target="_blank" rel="noopener"')
    .replace(/href="#Signup"/g, 'href="/signup"')
    .replace(/href="#Privacy"/g, 'href="/privacy"')
    .replace(/href="#npm"/g, 'href="https://www.npmjs.com/package/crypto-quant-signal-mcp" target="_blank" rel="noopener"')
    .replace(/href="#MCP Registry"/g, 'href="https://registry.modelcontextprotocol.io/v0/servers?search=algovault" target="_blank" rel="noopener"');
}

function stripUseCasesDate(html) {
  // Q-W13: strip stale date placeholder
  return html.replace(/verified 2026-04-26/g, 'official Skills Hub');
}

function injectUseCasesLogos(html) {
  // Q-W7 hero pattern carries to UseCases card grid: replace the <span class="xchg-mark"...>{mark}</span>
  // letter chip with <img src="/_design/logos/{exchange}.{ext}" alt="{Exchange} logo"> per architect ratification.
  // Mark letters: B=Binance, O=OKX, BY=Bybit, BG=Bitget. Hyperliquid NOT in UseCases (HL is hero only).
  //
  // Mr.1 fix-forward 2026-05-11 ROUND 3: "exchange logo is not visible here, change the shape color
  // to the image attached color" — strip JSX `--mark` brand-color background (yellow/white/etc) which
  // visually merged with the logo's same-colored brand mark, replacing with dark canvas color so
  // logos pop. Also enlarge the chip from 28×28 to 32×32 + image 26×26 (was 22×22) to fill more
  // space and make logo recognizable. Border lightens the chip outline for definition against
  // dark UseCases card background.
  const logoMap = {
    'B':  { src: '/_design/logos/binance.png', alt: 'Binance logo' },
    'O':  { src: '/_design/logos/okx.png',     alt: 'OKX logo' },
    'BY': { src: '/_design/logos/bybit.png',   alt: 'Bybit logo' },
    'BG': { src: '/_design/logos/bitget.png',  alt: 'Bitget logo' },
  };
  return html.replace(
    /(<span class="xchg-mark" style=")[^"]*(">)(B|O|BY|BG)(<\/span>)/g,
    (match, openSpan, closeQuote, letter, closeSpan) => {
      const cfg = logoMap[letter];
      if (!cfg) return match;
      // DESIGN-W7 fix-forward 2026-05-11 ROUND 4 (Mr.1 directive: chip bg matches page,
      // brand-color logos render directly on dark): chip background changes from white-ish
      // (which competed with the logo's brand color) to var(--bg-2) dark grey. The logos
      // were re-processed (scripts/process-exchange-logos.mjs) with transparent backgrounds
      // so the dark chip is visible around the logo's filled brand color.
      // Chip 32×32, logo 26×26 with object-fit:contain for safe aspect preservation.
      const styledOpen = openSpan + 'width:32px;height:32px;border-radius:7px;background:var(--bg-2);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0' + closeQuote;
      const img = `<img src="${cfg.src}" alt="${cfg.alt}" style="width:26px;height:26px;object-fit:contain;padding:2px">`;
      return styledOpen + img + closeSpan;
    }
  );
}

function preserveQuickstartAnchor(html) {
  // Existing landing/index.html has internal-page links href="#quickstart" (line 245 hero CTA + 739).
  // JSX TryIn30 renders id="try-it". Substitute id="try-it" → id="quickstart" to preserve internal-link contract.
  return html.replace(/id="try-it"/g, 'id="quickstart"');
}

function adjustPricingGridCols(html) {
  // After X402 filter, desktop grid was 5-col → make 4-col
  return html.replace(/grid-template-columns:repeat\(5,\s*1fr\)/g, 'grid-template-columns:repeat(4, 1fr)');
}

// ── DESIGN-W7 hero overrides (architect-ratified 2026-05-10) ─────────────────

function patchV1Minimal(src) {
  // Pre-Babel patches.
  // 1. Drop <TrustRow /> renders entirely (W3 ratification stands per H-A1; 14.2k/3.1k are fictional).
  //    Use `{null}` JSX expression (React renders null as nothing) NOT bare `null` (which becomes
  //    text content "null" inside JSX). Pre-W7-fix-forward shipped the broken bare-null literal.
  let s = src.replace(/<TrustRow\s+compact\s*\/>/g, '{null}');
  s = s.replace(/<TrustRow\s*\/>/g, '{null}');
  return s;
}

function w7HeroCounter(html) {
  // H-PR1: counter live-bind. JSX renders the counter element as `<div>` (desktop) OR `<span>` (mobile)
  // both with className="counter". Match both element types. Replace numeric value + add
  // `data-tr-field="total_calls_executed"`. Track-record-proxy.js (C2) computes totalCalls + totalHolds.
  html = html.replace(
    /<(div|span) class="counter" style="([^"]*)">[\d,]+<\/(div|span)>/g,
    '<$1 class="counter" data-tr-field="total_calls_executed" style="$2">0</$3>'
  );
  // Label: "agent calls" → "Agent Calls"
  html = html.replaceAll('>agent calls<', '>Agent Calls<');
  return html;
}

function w7HeroRecentCall(html) {
  // H-PR2: MOST RECENT CALL live-bind via vanilla-JS poller (C4 wires this).
  // JSX `useCyclingCall()` initially returns `LAST_CALLS[0]` = 'BTC 1h Binance · HOLD · 0.8s ago'.
  // Replace the rendered initial-state string with a `data-w7-recent-call` mount-point.
  // Pattern: the recent-call sits in a `<div style="font-family:var(--font-mono);font-size:13.5px..."` container (desktop)
  // OR `<div style="font-family:var(--font-mono);font-size:11px..."` container (mobile).
  // Cleanest substitution: find the literal initial LAST_CALLS[0] string anywhere it appears and
  // wrap with a poller mount-point + aria-live polite.
  // Desktop shape: `<div style="...">BTC 1h Binance · HOLD · 0.8s ago</div>`
  html = html.replace(
    /(<div style="[^"]*font-family:var\(--font-mono\)[^"]*">)BTC 1h Binance · HOLD · 0\.8s ago(<\/div>)/g,
    '$1<span data-w7-recent-call aria-live="polite">Loading…</span>$2'
  );
  // Mobile shape: `Last: {last}` → `Last: <!-- -->BTC 1h Binance · HOLD · 0.8s ago` (React inserts
  // `<!-- -->` separator between static text and dynamic JSX value).
  html = html.replace(
    /(Last: <!-- -->)BTC 1h Binance · HOLD · 0\.8s ago/g,
    '$1<span data-w7-recent-call aria-live="polite">Loading…</span>'
  );
  // Fallback: any other rendered occurrence of LAST_CALLS[0] (defensive — should be 0 after the 2 above)
  html = html.replace(
    /BTC 1h Binance · HOLD · 0\.8s ago/g,
    '<span data-w7-recent-call aria-live="polite">Loading…</span>'
  );
  return html;
}

function w7HeroDropVerdict(html) {
  // Q-W7-2: DROP V0Diagram verdict snippet (`verdict: LONG / conf 0.84 · regime trend`).
  // SVG renders 2 `<g transform="translate(...)"><text ...>verdict: LONG</text></g>` + sibling for conf.
  // Match the FULL <g>…</g> blocks (verdict + conf 0.84) and remove.
  html = html.replace(/<g transform="translate\([^)]+\)"><text [^>]*>verdict: LONG<\/text><\/g>/g, '');
  html = html.replace(/<g transform="translate\([^)]+\)"><text [^>]*>conf 0\.84 · regime trend<\/text><\/g>/g, '');
  return html;
}

function w7HeroP50ToPfeWr(html) {
  // Q-W7-1: replace `p50 latency / 640ms` slot in 4-stat row with `PFE WR / <span data-tr-field="pfe_wr">90.2%</span>`.
  // Label substitution
  html = html.replaceAll('>p50 latency<', '>PFE WR<');
  // Value substitution: `>640<span style="...">ms</span><` → live-bind PFE WR.
  // Mr.1 fix-forward 2026-05-11: % moved INSIDE the span so track-record-proxy.js's
  // setField (which sets full "90.2%" string) replaces correctly. Pre-fix had `>90.2</span>%<`
  // resulting in "90.2%%" double-%.
  html = html.replace(
    />640<span style="[^"]*">ms<\/span></g,
    '><span data-tr-field="pfe_wr">90.2%</span><'
  );
  return html;
}

function w7HeroFourStatLiveBinds(html) {
  // 4-stat row label rename + live-bind for VENUES + TIMEFRAMES + SIGNALS.
  // VENUES (per Q-W7-4 + H-PR3 pattern): live-bind to exchange_count
  html = html.replaceAll('>venues<', '>Venues<');
  html = html.replace(
    /(>Venues<\/div>[\s\S]*?<div style="[^"]*">)32(<\/div>)/,
    '$1<span data-tr-field="exchange_count">5</span>$2'
  );
  // TIMEFRAMES: live-bind to timeframe_count
  html = html.replaceAll('>timeframes<', '>Timeframes<');
  html = html.replace(
    /(>Timeframes<\/div>[\s\S]*?<div style="[^"]*">)11(<\/div>)/,
    '$1<span data-tr-field="timeframe_count">11</span>$2'
  );
  // SIGNALS → "Total Trade Calls" + live-bind to call_count (H-PR3)
  html = html.replaceAll('>signals<', '>Total Trade Calls<');
  html = html.replace(
    /(>Total Trade Calls<\/div>[\s\S]*?<div style="[^"]*">)37(<\/div>)/,
    '$1<span data-tr-field="call_count">81207</span>$2'
  );
  return html;
}

function w7HeroDiagramFooter(html) {
  // Q-W7-4: V0Diagram footer text "32 venues integrated · 5 featured" → live-bind both numbers.
  // SVG `<tspan>` supports data-attr (CSS attribute selector + querySelector match across span/tspan).
  html = html.replace(
    /<tspan fill="([^"]+)" font-weight="600">\d+<\/tspan> venues integrated · 5 featured/g,
    '<tspan fill="$1" font-weight="600" data-tr-field="exchange_count">5</tspan> venues integrated · <tspan data-tr-field="exchange_count">5</tspan> featured'
  );
  return html;
}

function w7HeroNavVersion(html, version) {
  // Q-W7-3: replace nav `v1.4 shipped` pill with current package.json version.
  return html.replace(/v1\.4 shipped/g, `v${version} shipped`);
}

function w7HeroCTAUrls(html) {
  // Mr.1 fix-forward 2026-05-11 ROUND 3: V1Hero CTAs link to "#" placeholder. Wire real URLs.
  // - "Try Free in Claude" → /#quickstart (the TryIn30 section on this page = in-page jump to
  //   the 3-step quickstart guide for Claude Desktop integration). Default suggestion since
  //   Mr.1 asked. Alternative: /docs.html, https://claude.ai/, or external Claude Desktop dl page.
  // - "View Track Record" → /track-record per Mr.1 explicit directive.
  return html
    .replace(
      /<a href="#" class="btn btn-primary accent-cyan"([^>]*)>(\s*Try Free in Claude)/g,
      '<a href="/#quickstart" class="btn btn-primary accent-cyan"$1>$2'
    )
    .replace(
      /<a href="#" class="btn btn-secondary"([^>]*)>(\s*View Track Record)/g,
      '<a href="/track-record" class="btn btn-secondary"$1>$2'
    );
}

function w7HeroStripNav(html) {
  // Strip the V1Hero-rendered <nav class="nav"...>...</nav> block — the existing live W3 nav
  // (top of landing/index.html, consistent across all sub-pages: faq.html, glossary.html etc.)
  // is preserved. Adopting V1Hero's nav would break cross-page nav consistency (different link
  // sets — V1Hero has Product/Verdicts/Track Record/Docs/Pricing; live has Track Record/Pricing/
  // Integrations/Skills/Docs/Verify/Account/Signup). Post-render strip is the cleanest path.
  return html.replace(/<nav class="nav"[^>]*>[\s\S]*?<\/nav>/g, '');
}

function w7HeroCallStreamLiveBind(html) {
  // Mr.1 fix-forward 2026-05-10 23:50: V1Feed (CALL STREAM · LIVE) currently renders FICTIONAL
  // FEED_BASE constants (BTC/ETH/SOL/etc with hardcoded confidence values 0.84/0.62/etc).
  // Mr.1 question: "Is the Call Stream Live & updated? what's the 0.79, 0.66 number means?"
  // → Live-bind to /api/recent-calls?limit=6 + 2.5s polling. Confidence values (0.84 etc) are
  // confidence/100 (decimal form) — JSX renders r.c.toFixed(2) = '0.84' from server's confidence=84.
  // Mark the V1Feed scrolling container with data-w7-call-stream so a vanilla-JS poller can
  // populate rows on each fetch. Strip the FEED_BASE-rendered initial rows (replaced by live data).
  // The V1Feed container is identified by the unique `animation: feed-scroll` style.
  return html.replace(
    /(<div style="animation:feed-scroll [^"]*;will-change:transform">)([\s\S]*?)(<\/div><div style="position:absolute;inset:28px 0 0 0;pointer-events:none;background:linear-gradient\(180deg, oklch\(0\.13)/g,
    '$1<!-- DESIGN-W7 / Mr.1 fix-forward 2026-05-10: rows live-bound via fetchCallStream poller (2.5s, /api/recent-calls?limit=6); FEED_BASE placeholders stripped --><div data-w7-call-stream-rows aria-live="polite"></div>$3'
  );
}

function w7HeroDiagramChipsToLogos(html) {
  // Q-W7 carry-forward (W6 hero chip→logo migration extends to V0Diagram chips).
  // V0Diagram featured chips render: outer rect (40×32 dark fill + thin border) + inner colored
  // rect (22×22) + monogram text + name text. Replace ALL inner content (colored rect + monogram)
  // AND override outer rect to a uniform white-ish background where the logo can sit visibly.
  //
  // Mr.1 fix-forward 2026-05-11 ROUND 3: same shape size for 5 exchanges (uniform 40×32 white-ish
  // chip), logo fills via xMidYMid meet (preserves aspect, no distortion). Brand-color outer rect
  // replaced because the logos themselves carry brand color — 5 yellow/white/teal chips are
  // visually noisy + obscure logos.
  const logoMap = {
    'H':  { src: '/_design/logos/hyperliquid.png', alt: 'Hyperliquid logo' },
    'B':  { src: '/_design/logos/binance.png',     alt: 'Binance logo' },
    'BY': { src: '/_design/logos/bybit.png',       alt: 'Bybit logo' },
    'O':  { src: '/_design/logos/okx.png',         alt: 'OKX logo' },
    'BG': { src: '/_design/logos/bitget.png',      alt: 'Bitget logo' },
  };
  // DESIGN-W7 fix-forward 2026-05-11 ROUND 4 (Mr.1 directive: chip bg matches page,
  // brand-color logos render directly on dark): drop the white-ish inner rect entirely.
  // Logos were re-processed (scripts/process-exchange-logos.mjs) with transparent backgrounds
  // so they sit directly on the outer .hero-flow-node-venue dark chip (fill=oklch(0.2 0.012 265),
  // stroke=oklch(0.34 0.012 265)). The image fills the chip area via xMidYMid meet.
  return html.replace(
    /<rect x="-15" y="-11" width="22" height="22" rx="6" fill="oklch\([^)]+\)" opacity="0\.95"><\/rect><text x="-4" y="5\.5" text-anchor="middle"[^>]*>(H|B|BY|O|BG)<\/text>/g,
    (match, mono) => {
      const cfg = logoMap[mono];
      if (!cfg) return match;
      // Image only — no inner rect. Image fills 36×28 within the 40×32 outer chip (2px breathing
      // room on each side). xMidYMid meet preserves aspect without distortion.
      return `<image href="${cfg.src}" x="-18" y="-14" width="36" height="28" preserveAspectRatio="xMidYMid meet"><title>${cfg.alt}</title></image>`;
    }
  );
}

function w7HeroHideFlowDiagramLabel(html) {
  // Mr.1 fix-forward 2026-05-11: "remove the flow.diagram words"
  // The canonical canvas has a "flow.diagram" placeholder-cap header above the V0Diagram panel.
  // Strip it via class addition (CSS .flow-diagram-hide rule sets display:none).
  return html.replace(
    /(<span class="placeholder-cap")(>flow\.diagram<\/span>)/g,
    '$1 style="display:none"$2'
  );
}

function w7HeroArtboardWidth(html) {
  // Mr.1 fix-forward 2026-05-11: "Fill up the whole page, you can see the right side is blank"
  // V1Hero JSX renders <div class="artboard" style="width:1440px;height:900px;padding:28px 80px">.
  // Fixed width:1440px causes left-aligned layout on wider viewports (>1440px).
  // Strip fixed width + height; replace with max-width + auto margin so artboard centers.
  // Mr.1 fix-forward 2026-05-11 ROUND 3: top-padding increased from 28px to 100px so eyebrow
  // clears the W3 fixed nav (~56px tall + 8px gap). Without this, the "Model Context Protocol
  // server · 5 venues monitored" eyebrow renders BEHIND the nav and is invisible.
  return html
    .replace(
      /<div class="artboard" style="width:1440px;height:900px;padding:28px 80px">/g,
      '<div class="artboard" style="padding:100px 80px 28px;max-width:1440px;margin:0 auto;width:100%">'
    )
    // Mobile artboard (375px wide) — keep narrow but center; mobile nav is also fixed
    .replace(
      /<div class="artboard" style="width:375px;height:1100px;padding:20px 22px">/g,
      '<div class="artboard" style="padding:80px 22px 20px;max-width:375px;margin:0 auto;width:100%">'
    );
}

// MOST RECENT CALL + CALL STREAM pollers (vanilla JS — appended after hero render at C3 inject time)
const W7_RECENT_CALL_POLLER_JS = `<script>
(function(){
  // DESIGN-W7 / H-PR2 (Mr.1 ratification 2026-05-10):
  // MOST RECENT CALL poller — /api/recent-calls?limit=1 every 1.5s → [data-w7-recent-call] mount-points.
  // Plus DESIGN-W7 fix-forward 2026-05-10 23:50 (Mr.1 directive):
  // CALL STREAM poller — /api/recent-calls?limit=6 every 2.5s → [data-w7-call-stream-rows] container.
  if (window.__w7RecentCallInit) return;
  window.__w7RecentCallInit = true;
  var EX_NAMES = {HL:'Hyperliquid',BINANCE:'Binance',BYBIT:'Bybit',OKX:'OKX',BITGET:'Bitget'};
  var EX_SHORT = {HL:'HL',BINANCE:'BN',BYBIT:'BY',OKX:'OK',BITGET:'BG'};
  function fmtAgo(secs){
    if (secs == null || !isFinite(secs) || secs < 0) return '—';
    if (secs < 60) return secs.toFixed(0) + 's ago';
    if (secs < 3600) return Math.round(secs/60) + 'm ago';
    return Math.round(secs/3600) + 'h ago';
  }
  function escapeHtml(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c] || c;
    });
  }
  // DESIGN-W7 fix-forward ROUND 7 (Mr.1 directive 2026-05-11): MOST RECENT CALL was
  // re-fetching /api/recent-calls?limit=1 on every 1-3s tick, which returns the SAME
  // latest call until a new one is generated (typical cadence is 30-60s between new calls)
  // → panel re-renders identical row with only "57s ago" → "1m ago" updating. Mr.1 wants
  // VARIETY each tick. Refactor: fetch /api/recent-calls?limit=10 (server-enforced cap
  // per audits/recent-calls-public-shape-snapshot-2026-05-09.json) every 30s into a
  // recentCallsCache; rotationIndex cursor advances per 1-3s tick; refreshRecentCall
  // reads from cache + renders the call at the current cursor (mod cache.length).
  // Full cycle through 10 rows takes ~10-30s depending on jitter; cache refresh ensures
  // freshness.
  var recentCallsCache = [];
  var rotationIndex = 0;
  function fetchRecentCallsCache(){
    fetch('/api/recent-calls?limit=10').then(function(r){
      if (!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(rows){
      if (Array.isArray(rows) && rows.length) {
        recentCallsCache = rows;
      }
    }).catch(function(err){
      console.warn('[w7-recent-call-cache] fetch failed', err);
    });
  }
  function refreshRecentCall(){
    if (!recentCallsCache.length) return; // wait for first cache fill
    var r = recentCallsCache[rotationIndex % recentCallsCache.length];
    rotationIndex++;
    var ex = EX_NAMES[r.exchange] || r.exchange;
    var line = (r.slug||'') + ' ' + (r.timeframe||'') + ' ' + ex + ' · ' + ((r.call||'').toUpperCase()) + ' · ' + fmtAgo(r.seconds_ago);
    document.querySelectorAll('[data-w7-recent-call]').forEach(function(el){ el.textContent = line; });
  }
  function refreshCallStream(){
    fetch('/api/recent-calls?limit=6').then(function(r){
      if (!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(rows){
      if (!Array.isArray(rows)) return;
      // DESIGN-W7 fix-forward ROUND 5 (Mr.1 directive 2026-05-11): drop the confidence column;
      // distribute remaining 5 columns evenly. Final shape:
      //   Asset · TF · VX · Call · Time-ago (1fr 1fr 1fr 1fr 1fr).
      // r.confidence is still received but not rendered (still available on the API for
      // future callers via /api/recent-calls; the public response shape is unchanged).
      var dirColor = function(d){
        d = (d||'').toUpperCase();
        if (d === 'BUY' || d === 'LONG') return 'oklch(0.78 0.15 165)';
        if (d === 'SELL' || d === 'SHORT') return 'oklch(0.65 0.20 25)';
        return 'oklch(0.78 0.005 265)';
      };
      // Duplicate rows for seamless scroll loop (matches V1Feed FEED_BASE × 2 pattern)
      var seamlessRows = rows.concat(rows);
      var html = seamlessRows.map(function(r){
        var sym = escapeHtml(r.slug || '');
        var tf = escapeHtml(r.timeframe || '');
        var vx = escapeHtml(EX_SHORT[r.exchange] || r.exchange || '');
        var d = ((r.call||'').toUpperCase());
        var ago = fmtAgo(r.seconds_ago);
        // DESIGN-W7 fix-forward ROUND 6 (Mr.1 directive 2026-05-11): ROUND 5 set
        // column WIDTHS to 1fr×5 but content stayed default-left-aligned within each
        // column — short content (3-5 chars) huddled at left side of each 105px column,
        // leaving wide visual gaps. Now: Asset stays start-aligned (left anchor),
        // middle 3 cells (TF/VX/Call) center-aligned, Time-ago stays right-aligned
        // (right anchor). Content visually distributes across the panel width.
        return '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr 1fr;align-items:center;gap:6px;padding:3px 10px;height:22px;line-height:16px;border-bottom:1px solid oklch(0.2 0.012 265 / 0.7);color:var(--fg-2)">' +
          '<span style="color:var(--fg)">' + sym + '</span>' +
          '<span style="color:var(--fg-3);text-align:center">' + tf + '</span>' +
          '<span style="color:var(--fg-4);text-align:center">' + vx + '</span>' +
          '<span style="color:' + dirColor(d) + ';font-weight:600;letter-spacing:0.04em;text-align:center">' + escapeHtml(d) + '</span>' +
          '<span style="color:var(--fg-4);text-align:right;font-size:9px">' + escapeHtml(ago) + '</span>' +
        '</div>';
      }).join('');
      document.querySelectorAll('[data-w7-call-stream-rows]').forEach(function(el){ el.innerHTML = html; });
    }).catch(function(err){
      console.warn('[w7-call-stream] refresh failed', err);
    });
  }
  function bothRefresh(){ refreshRecentCall(); refreshCallStream(); }
  // ROUND 7: warm the rotation cache (resolves async; refreshRecentCall waits for cache).
  fetchRecentCallsCache();
  setInterval(fetchRecentCallsCache, 30000); // 30s cache refresh — keeps rotation rows fresh.
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', bothRefresh);
  } else { bothRefresh(); }
  // DESIGN-W7 fix-forward ROUND 6 (Mr.1 directive 2026-05-11): MOST RECENT CALL cadence
  // randomized to 1000-3000ms via recursive setTimeout (was setInterval 1500ms fixed).
  // Jittered cadence simulates organic event-stream arrival rate — visible motion every
  // 1-3s reads as "tons of calls flowing in" social-proof effect. Each tick independently
  // randomized; refreshRecentCall function body unchanged (only invocation cadence).
  function scheduleNextRecentCall(){
    setTimeout(function(){
      refreshRecentCall();
      scheduleNextRecentCall();
    }, 1000 + Math.random() * 2000);
  }
  scheduleNextRecentCall();
  setInterval(refreshCallStream, 2500); // 2.5s — matches W3 recent-calls-feed cadence
})();
</script>`;

// FAQ accordion vanilla-JS (appended after FAQ render)
const FAQ_ACCORDION_JS = `<script>
(function(){
  // DESIGN-W6 FAQ accordion: collapse items 2-N on load; wire click-to-toggle.
  // Runs once on DOMContentLoaded (idempotent — protects against double-include).
  if (window.__w6FaqInit) return;
  window.__w6FaqInit = true;
  document.addEventListener('DOMContentLoaded', function(){
    var faqSection = document.getElementById('faq');
    if (!faqSection) return;
    var articles = faqSection.querySelectorAll('article');
    articles.forEach(function(article, i){
      var btn = article.querySelector('button');
      var answer = article.querySelectorAll(':scope > div')[0];
      if (!btn || !answer) return;
      // Initial state: only first item open
      var initiallyOpen = (i === 0);
      if (!initiallyOpen) {
        answer.style.display = 'none';
      }
      // Click handler
      btn.addEventListener('click', function(){
        var hidden = (answer.style.display === 'none');
        answer.style.display = hidden ? '' : 'none';
        article.setAttribute('data-w6-faq-open', hidden ? 'true' : 'false');
        // Rotate the chevron svg if present
        var svg = btn.querySelector('svg');
        if (svg) svg.style.transform = hidden ? 'rotate(180deg)' : 'rotate(0deg)';
      });
      article.setAttribute('data-w6-faq-open', initiallyOpen ? 'true' : 'false');
    });
  });
})();
</script>`;

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.target || 'belowfold';
  const mobile = args.mobile === 'true';
  const out = args.out;

  if (!['belowfold', 'landing-rest', 'hero'].includes(target)) {
    console.error(`[render-jsx-static] invalid --target=${target} (expected belowfold|landing-rest|hero)`);
    process.exit(2);
  }

  let html = '';

  try {
    if (target === 'belowfold') {
      const srcRaw = await readFile(path.join(VAULT_DESIGN, 'v1-belowfold.jsx'), 'utf-8');
      const src = patchBelowFold(srcRaw);
      const exports = await evalJsxSrc(
        src,
        path.join(VAULT_DESIGN, 'v1-belowfold.jsx'),
        ['AlgoVaultBelowFold', 'CoreCapabilities', 'WhenToUse', 'VsRawAPIs', 'BFIcon', 'BFEyebrow', 'BFH2', 'BFSection']
      );
      // Render 3 sections individually for clean per-section output (no top-level artboard wrapper —
      // C2 places each section directly in landing/index.html below-fold region).
      const cc = renderToString(React.createElement(exports.CoreCapabilities, { mobile }));
      const wt = renderToString(React.createElement(exports.WhenToUse, { mobile }));
      const vs = renderToString(React.createElement(exports.VsRawAPIs, { mobile }));
      html = cc + wt + vs;
    } else if (target === 'landing-rest') {
      const srcRaw = await readFile(path.join(VAULT_DESIGN, 'v1-landing-rest.jsx'), 'utf-8');
      const src = patchLandingRest(srcRaw);
      const exports = await evalJsxSrc(
        src,
        path.join(VAULT_DESIGN, 'v1-landing-rest.jsx'),
        [
          'AlgoVaultLandingRest', 'TryIn30', 'TradFiCallout', 'ThreeTools', 'UseCases',
          'LiveTrackRecord', 'TamperProof', 'SimplePricing', 'ForDevelopers', 'FAQ', 'LandingFooter',
          'LRBlock', 'LREyebrow', 'LRH2', 'LRLead', 'Pill', 'Check', 'Bullet', 'FAQItem',
        ]
      );
      // Render in spec order, SKIP TradFiCallout (architect mandate Q-W10 spec rule 10).
      const try30 = preserveQuickstartAnchor(renderToString(React.createElement(exports.TryIn30, { mobile })));
      const tt = renderToString(React.createElement(exports.ThreeTools, { mobile }));
      const uc = injectUseCasesLogos(stripUseCasesDate(renderToString(React.createElement(exports.UseCases, { mobile }))));
      const ltr = injectLiveDataLiveTrack(renderToString(React.createElement(exports.LiveTrackRecord, { mobile })));
      const tp = renderToString(React.createElement(exports.TamperProof, { mobile }));
      const sp = adjustPricingGridCols(applyTitleCase(injectLiveDataPricingTagline(filterX402Tier(
        renderToString(React.createElement(exports.SimplePricing, { mobile }))
      ))));
      const fd = applyFooterUrls(renderToString(React.createElement(exports.ForDevelopers, { mobile })));
      const fq = renderToString(React.createElement(exports.FAQ, { mobile })) + FAQ_ACCORDION_JS;
      const ft = applyFooterUrls(renderToString(React.createElement(exports.LandingFooter, { mobile })));
      // Final pass: wrap "5 exchanges" / "11 timeframes" prose literals with proxy spans (copy-consistency canary).
      html = wrapCounterLiteralsInProse(try30 + tt + uc + ltr + tp + sp + fd + fq + ft);
    } else if (target === 'hero') {
      // DESIGN-W7 hero render — V1Hero from v1-minimal.jsx with `count=32, diagram='flow'`
      // (matches canonical AlgoVault Landing.html bootstrap line 59).
      const pkgJson = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
      const version = pkgJson.version;

      const srcRaw = await readFile(path.join(VAULT_DESIGN, 'v1-minimal.jsx'), 'utf-8');
      const src = patchV1Minimal(srcRaw);
      const exports = await evalJsxSrc(
        src,
        path.join(VAULT_DESIGN, 'v1-minimal.jsx'),
        ['V1Hero', 'V0Diagram', 'V1Diagram', 'V1Feed', 'EXCHANGES', 'useTickingCounter', 'useCyclingCall', 'fmt', 'TrustRow', 'ExchangeTile']
      );
      // Q-W7-5 OVERRIDE: diagram='flow' (canonical canvas default = V0Diagram). count=32 (visual density).
      let raw = renderToString(React.createElement(exports.V1Hero, { mobile, count: 32, diagram: 'flow' }));
      // Apply 8 wave-level overrides per architect ratification 2026-05-10:
      raw = w7HeroCounter(raw);                    // H-PR1 + label "Agent Calls"
      raw = w7HeroRecentCall(raw);                 // H-PR2 mount-point (poller fills via JS)
      raw = w7HeroDropVerdict(raw);                // Q-W7-2 DROP verdict snippet
      raw = w7HeroP50ToPfeWr(raw);                 // Q-W7-1 P50 → PFE WR
      raw = w7HeroFourStatLiveBinds(raw);          // VENUES + TIMEFRAMES + Total Trade Calls
      raw = w7HeroDiagramFooter(raw);              // Q-W7-4 footer "5 venues integrated · 5 featured" live-bind
      raw = w7HeroNavVersion(raw, version);        // Q-W7-3 nav v1.x shipped
      raw = w7HeroDiagramChipsToLogos(raw);        // W6 Q-W7 carry-forward (5 SVG <image> logos in V0Diagram chips, Mr.1 fix-forward: fill chip)
      raw = w7HeroCallStreamLiveBind(raw);         // Mr.1 fix-forward: V1Feed FEED_BASE → live /api/recent-calls?limit=6 poller
      raw = w7HeroHideFlowDiagramLabel(raw);       // Mr.1 fix-forward 2026-05-11: hide "flow.diagram" placeholder-cap label
      raw = w7HeroArtboardWidth(raw);              // Mr.1 fix-forward 2026-05-11: strip fixed 1440px width, allow max-width centering + top-pad to clear W3 nav
      raw = w7HeroCTAUrls(raw);                    // Mr.1 fix-forward 2026-05-11 R3: Try Free in Claude → /#quickstart, View Track Record → /track-record
      raw = w7HeroStripNav(raw);                   // strip V1Hero's nav (existing live W3 nav preserved for cross-page consistency)
      // Append vanilla-JS poller for MOST RECENT CALL (mounts to all [data-w7-recent-call] in the dual-render block)
      html = raw + W7_RECENT_CALL_POLLER_JS;
    }
  } catch (e) {
    console.error(`[render-jsx-static] render failed: ${e.message}`);
    if (process.env.DEBUG) console.error(e.stack);
    process.exit(1);
  }

  if (out) {
    await writeFile(out, html);
    console.error(`[render-jsx-static] target=${target} mobile=${mobile} → ${out} (${html.length} bytes)`);
  } else {
    process.stdout.write(html);
  }
}

main();
