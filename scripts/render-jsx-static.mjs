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
// FOOTER-UNIFY-W1: the brand footer comes from the single SoT (compiled
// dist/lib/footer-content.js; run `npm run build` before this generator).
const require = Module.createRequire(import.meta.url);
const { renderBrandFooter } = require(path.join(REPO_ROOT, 'dist', 'lib', 'footer-content.js'));
const VAULT_DESIGN = '/Users/tank/My Drive/Obsidian Vault/AlgoVault MCP/Design/AlgoVault Landing Hero v1';
// DESIGN-W9 (2026-05-11): verify.jsx canonical SoT lives in a sibling vault folder.
const VAULT_TRACK_RECORD = '/Users/tank/My Drive/Obsidian Vault/AlgoVault MCP/Design/AlgoVault Track Record v1';
// DESIGN-HOW-IT-WORKS-W1 (2026-05-14): v1-howitworks.jsx canonical SoT lives in a sibling vault folder.
const VAULT_HOW_IT_WORKS = '/Users/tank/My Drive/Obsidian Vault/AlgoVault MCP/Design/AlgoVault How it Works V1';

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
  // LANDING-HOW-IT-WORKS-W1 (2026-05-13): "on-chain track record" 4th card replaced with
  // "Self-tuning ML model" card linking to /how-it-works (substrate M6 frame). Subtitle text updated
  // to reflect the new 4th card. Factuality LAW: AlgoVault has 3 MCP tools + 1 substrate-model card.
  return src.replace(
    'Four MCP tools your agent can call directly. Each returns a single, structured verdict — not raw indicators.',
    'Three MCP tools your agent can call — plus the self-tuning model behind them.<br/>Each returns a single, structured verdict — not raw indicators.'
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
  // ROUND 9 (2026-05-11): line-break between the two sentences per Mr.1 visual review.
  s = s.replace(
    'AlgoVault MCP gives your agent a composite verdict in one call — call, confidence, regime, factors, every call Merkle-anchored on Base L2. Pair it with any of these official Agent Trade Kits to ship a complete trading agent.',
    'AlgoVault MCP gives your agent a composite verdict in one call.<br/>Pair it with any of these official Agent Trade Kits to ship a complete trading agent.'
  );

  // 4) UseCases trademark notice: drop the "All demos run testnet/demo only — zero real-money
  // risk in any code path." prefix per Mr.1 directive.
  // ROUND 9 (2026-05-11): arrange the 4 sentences across 3 lines per Mr.1 visual review.
  s = s.replace(
    'All demos run testnet/demo only — zero real-money risk in any code path. AlgoVault returns analytics; your agent and risk policy decide what to execute. Exchange logos and names are trademarks of their respective owners. Used for nominative reference to integration tutorials. No partnership or endorsement implied.',
    'AlgoVault returns analytics; your agent and risk policy decide what to execute.<br/>Exchange logos and names are trademarks of their respective owners.<br/>Used for nominative reference to integration tutorials. No partnership or endorsement implied.'
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

// RETIRED by WEBSITE-X402-SURFACING-W1 (2026-06-08): the x402 5th card now SHIPS
// (PRICING-X402-CARD-W1 deferral fulfilled — x402 LIVE + CDP-Bazaar-listed). No longer
// called from the landing-rest chain; kept for history.
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
    // Signup/checkout/welcome is api-canonical (the whole flow runs on api.algovault.com;
    // /welcome + /account are not in the apex Caddy allowlist, and Stripe success_url is built
    // from the request host) — so this link MUST be absolute or it 404s on algovault.com.
    .replace(/href="#Signup"/g, 'href="https://api.algovault.com/welcome"')
    // LANDING-REFERRAL-PAGE-W1: footer "Refer & Earn" → the apex /referral page.
    // RELATIVE (unlike #Signup) because /referral rides the apex Caddy reverse_proxy
    // (handle /referral, same as /track-record), so algovault.com/referral resolves.
    // The "&" in the label serializes to "&amp;" in the rendered href placeholder.
    .replace(/href="#Refer &amp; Earn"/g, 'href="/referral"')
    .replace(/href="#Privacy"/g, 'href="/privacy"')
    .replace(/href="#npm"/g, 'href="https://www.npmjs.com/package/crypto-quant-signal-mcp" target="_blank" rel="noopener"')
    .replace(/href="#MCP Registry"/g, 'href="https://registry.modelcontextprotocol.io/v0/servers?search=algovault" target="_blank" rel="noopener"')
    // DESIGN-W7 fix-forward ROUND 8 (Mr.1 visual review 2026-05-11): wire the 3 placeholder
    // hrefs in LiveTrackRecord (View Live Track Record) + TamperProof callout (Verify a Call,
    // View Contract) to their real URLs so click-throughs work post-render. View Contract
    // links to the deployed Merkle-anchor contract on Basescan (external = target=_blank).
    .replace(/href="#track"/g, 'href="/track-record"')
    .replace(/href="#verify-call"/g, 'href="/verify"')
    .replace(/href="#contract"/g, 'href="https://basescan.org/address/0x6485396ac981fe0a58540dfbf3e730f6f7bcbf81" target="_blank" rel="noopener noreferrer"');
}

// FOOTER-UNIFY-W1: injectFooterBadge() RETIRED. The apex footer (badge included) now comes
// whole from the single SoT renderBrandFooter() — see the `ft` render in the landing-rest
// target. No separate badge injection / footer literal survives in this generator.

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

// RETIRED by WEBSITE-X402-SURFACING-W1 (2026-06-08): grid stays 5-col now that the
// x402 5th card ships. No longer called; kept for history.
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
  // Mr.1 fix-forward 2026-05-11 ROUND 3 + LANDING-HERO-CTA-TG-W1 (2026-05-14): V1Hero CTAs wired to
  // real URLs.
  // - "Try Free in Telegram" → https://t.me/algovaultofficialbot (external, opens new tab; lower-
  //   friction first-try path for non-Claude users per 2026 North Star acquisition focus).
  //   Per external-link-target-blank-noopener-rel-discipline skill: target="_blank" + rel="noopener
  //   noreferrer" on every t.me anchor.
  // - "View Track Record" → /track-record per Mr.1 explicit directive (internal, in-page nav).
  return html
    .replace(
      /<a href="#" class="btn btn-primary accent-cyan"([^>]*)>(\s*Try Free in Telegram)/g,
      '<a href="https://t.me/algovaultofficialbot" target="_blank" rel="noopener noreferrer" class="btn btn-primary accent-cyan"$1>$2'
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

// ── DESIGN-W9 /verify canonical rebuild ──────────────────────────────────────
//
// C2 (this section): JSX-faithful render of verify.jsx (771 LoC, 7 components)
// via Babel + ReactDOMServer; dual-render desktop+mobile with @media swap;
// preserves W4 form behavior (verifySignal + URL-param auto-lookup + Enter
// key + dual-input value sync) byte-identical per Q-W9-10 architect-ratified
// preservation strategy 2026-05-11.
//
// C3 (verify-overrides functions added later): eyebrow rename, VRecent empty
// state, contract address full EIP-55 + Basescan link, VFooter <pre> outcome
// strip per Q-W9-9 spec-cross-section-contradiction-probe, 4 data-tr-field
// live-bind hydrations + track-record-proxy.js script include (Q-W9-11
// hydration order: proxy.js FIRST, then inline W9 block).

// Head + AlgoVault Labs sticky nav verbatim from the W4 landing/verify.html
// shell. The 5 JSON-LD blocks (Product, Service, SoftwareApplication,
// Organization, WebSite) are preserved byte-identical per spec rule 7.
const VERIFY_HEAD_AND_NAV = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verify Any AlgoVault Trade Call</title>
<meta name="description" content="Verify any AlgoVault trade call on-chain. Every trade call is hashed on Base L2 before the outcome is known.">
<meta name="last-updated" content="2026-05-11">
<link rel="icon" type="image/png" href="/logo.png">
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
  body { background: #060a14; color: #d1d5db; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  code { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; }
  .hash-text { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; word-break: break-all; }
  /* DESIGN-W9 dual-render @media swap (lp-verify-{desktop,mobile} per dual-render-desktop-mobile-media-swap skill) */
  @media (max-width: 767px) { .lp-verify-desktop { display: none !important; } }
  @media (min-width: 768px) { .lp-verify-mobile { display: none !important; } }
  /* DESIGN-W9: hide JSX VResult section by default (filled=false renders nothing inside the gated block,
     but the wrapper class is reserved for VERIFY-DEEPLINK-W1 to reveal on ?id= URL param routing) */
  [data-w9-result] { display: none; }
</style>
<!-- ANALYTICS:START -->
<!-- ANALYTICS:END -->
<script type="application/ld+json" data-algovault-jsonld="Product">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "AlgoVault",
  "description": "Composite BUY/SELL/HOLD trade calls for AI trading agents. 15 crypto perp venues. Market regime classification and cross-venue funding-rate arbitrage. Every signal Merkle-anchored on Base L2.",
  "url": "https://algovault.com",
  "image": "https://algovault.com/logo.png",
  "brand": { "@type": "Brand", "name": "AlgoVault Labs" },
  "category": "Software / API / FinanceApplication",
  "offers": [
    { "@type": "Offer", "price": "0", "priceCurrency": "USD", "name": "Free", "description": "100 calls/month, all assets, all 11 timeframes, HOLDs always free" },
    { "@type": "Offer", "price": "9.99", "priceCurrency": "USD", "name": "Starter", "description": "3,000 calls/month", "url": "https://api.algovault.com/signup?plan=starter" },
    { "@type": "Offer", "price": "49", "priceCurrency": "USD", "name": "Pro", "description": "15,000 calls/month", "url": "https://api.algovault.com/signup?plan=pro" },
    { "@type": "Offer", "price": "299", "priceCurrency": "USD", "name": "Enterprise", "description": "100,000 calls/month, SLA, priority support", "url": "https://api.algovault.com/signup?plan=enterprise" }
  ],
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "90.2",
    "bestRating": "100",
    "worstRating": "0",
    "ratingCount": "81339"
  },
  "additionalProperty": [
    { "@type": "PropertyValue", "name": "PFE win rate", "value": "90.2%" },
    { "@type": "PropertyValue", "name": "Verified trade calls", "value": "81339" },
    { "@type": "PropertyValue", "name": "Asset count", "value": "730" },
    { "@type": "PropertyValue", "name": "Exchange count", "value": "5" },
    { "@type": "PropertyValue", "name": "Timeframe count (API)", "value": "11" },
    { "@type": "PropertyValue", "name": "Merkle batches on Base L2", "value": "30" },
    { "@type": "PropertyValue", "name": "Track-record window", "value": "2026-04-10 to 2026-05-10" }
  ]
}
</script>
<script type="application/ld+json" data-algovault-jsonld="Service">
{
  "@context": "https://schema.org",
  "@type": "Service",
  "name": "AlgoVault Trade Call Intelligence",
  "serviceType": "Composite trade-call API for AI trading agents",
  "provider": { "@type": "Organization", "name": "AlgoVault Labs", "url": "https://algovault.com" },
  "url": "https://algovault.com",
  "description": "Composite BUY/SELL/HOLD trade calls with confidence, market regime classification, and cross-venue funding-rate arbitrage. 15 crypto perp venues. Every signal Merkle-anchored on Base L2 and verifiable at /verify.",
  "areaServed": "Worldwide",
  "audience": { "@type": "Audience", "audienceType": "AI trading agents, algorithmic trading systems, MCP-compatible clients" },
  "hasOfferCatalog": {
    "@type": "OfferCatalog",
    "name": "AlgoVault subscription tiers",
    "itemListElement": [
      { "@type": "Offer", "name": "Free", "price": "0", "priceCurrency": "USD" },
      { "@type": "Offer", "name": "Starter", "price": "9.99", "priceCurrency": "USD" },
      { "@type": "Offer", "name": "Pro", "price": "49", "priceCurrency": "USD" },
      { "@type": "Offer", "name": "Enterprise", "price": "299", "priceCurrency": "USD" }
    ]
  }
}
</script>
<script type="application/ld+json" data-algovault-jsonld="SoftwareApplication">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "AlgoVault",
  "applicationCategory": "FinanceApplication",
  "operatingSystem": "Any (MCP-compatible)",
  "description": "Composite trade calls for AI trading agents. 15 crypto perp venues, 730+ assets, 11 timeframes. Market regime classification + cross-venue funding-rate arbitrage. Every signal Merkle-anchored on Base L2.",
  "url": "https://algovault.com",
  "offers": [
    { "@type": "Offer", "price": "0", "priceCurrency": "USD", "name": "Free", "description": "All crypto + TradFi assets, all 11 timeframes (1m-1d), 100 calls/month, HOLD calls always free" },
    { "@type": "Offer", "price": "9.99", "priceCurrency": "USD", "name": "Starter", "description": "All crypto + TradFi assets, all 11 timeframes, 3,000 calls/month", "url": "https://api.algovault.com/signup?plan=starter" },
    { "@type": "Offer", "price": "49", "priceCurrency": "USD", "name": "Pro", "description": "All crypto and TradFi assets, all 11 timeframes, 15K calls/month", "url": "https://api.algovault.com/signup?plan=pro" },
    { "@type": "Offer", "price": "299", "priceCurrency": "USD", "name": "Enterprise", "description": "Unlimited calls, SLA, priority support", "url": "https://api.algovault.com/signup?plan=enterprise" }
  ],
  "author": { "@type": "Organization", "name": "AlgoVault Labs", "url": "https://algovault.com" },
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": "90.2",
    "bestRating": "100",
    "worstRating": "0",
    "ratingCount": "81339"
  }
}
</script>
<script type="application/ld+json" data-algovault-jsonld="Organization">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "AlgoVault Labs",
  "url": "https://algovault.com",
  "logo": "https://algovault.com/logo.png",
  "description": "Composite call-interpretation infrastructure for AI trading agents. TradingView is for human chart-readers, MT4 for human algo traders, AlgoVault for AI agents.",
  "sameAs": [
    "https://github.com/AlgoVaultLabs",
    "https://twitter.com/AlgoVaultLabs"
  ],
  "foundingDate": "2026"
}
</script>
<script type="application/ld+json" data-algovault-jsonld="WebSite">
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "AlgoVault",
  "url": "https://algovault.com",
  "description": "The Brain Layer for AI Trading Agents. Composite trade calls + market regime + cross-venue funding arbitrage via MCP. 90.2% PFE win rate across 81339 verified calls, Merkle-anchored on Base L2.",
  "publisher": { "@type": "Organization", "name": "AlgoVault Labs", "url": "https://algovault.com" },
  "inLanguage": "en"
}
</script>
</head>
<body class="min-h-screen">

<!-- Cross-page sticky nav (AlgoVault Labs canonical) — preserved across landing pages -->
<nav class="fixed top-0 w-full z-50 border-b border-white/5" style="background:rgba(6,10,20,0.85);backdrop-filter:blur(12px)">
  <div class="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
    <div class="flex items-center gap-2.5">
      <a href="/" class="flex items-center gap-2.5">
        <img src="/logo.png" alt="AlgoVault Logo" class="w-7 h-7 rounded-md">
        <span class="text-white font-semibold text-sm">AlgoVault Labs</span>
      </a>
    </div>
    <div class="hidden sm:flex items-center gap-6 text-sm text-gray-400">
      <a href="/track-record" class="hover:text-white transition">Track Record</a>
      <a href="/#pricing" class="hover:text-white transition">Pricing</a>
      <a href="/integrations" class="hover:text-white transition">Integrations</a>
      <a href="/skills" class="hover:text-white transition">Skills</a>
      <a href="/docs.html" class="hover:text-white transition">Docs</a>
      <a href="/verify" class="text-mint-400 font-medium">Verify</a>
      <a href="https://api.algovault.com/account" class="hover:text-white transition">Account</a>
      <a href="https://api.algovault.com/welcome" class="px-3 py-1 bg-mint-500/15 border border-mint-500/30 text-mint-400 hover:bg-mint-500/25 rounded-full text-xs font-semibold transition">Signup</a>
    </div>
  </div>
</nav>
`;

// W4 preserved JS — verifySignal() + URL-param auto-lookup + dual-render adapter (input-sync + .signal-id-input
// keydown listener for Enter). Byte-identical preservation of W4 verifySignal body + fmtDate + truncHash per
// Q-W9-10 architect-ratified preservation strategy 2026-05-11. Null-guards on #batches-table /
// #try-it-section /#sample-ids /#contract-info because the W4 landing/verify.html "Published Batches" +
// "Try It" pills sections do NOT exist in the W9 JSX-faithful rebuild (canonical design drops them).
const VERIFY_W4_PRESERVED_JS = `<script>
var API_BASE = '';

function truncHash(h) {
  if (!h) return '';
  return h.slice(0, 6) + '...' + h.slice(-4);
}

function fmtDate(d) {
  if (!d) return '';
  var dt = new Date(typeof d === 'number' ? d * 1000 : d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
         dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }) + ' UTC';
}

// DESIGN-W9 dual-render adapter: keep desktop+mobile signal-id inputs synced so verifySignal()
// always sees the typed value regardless of which artboard is visible at the user's viewport.
document.addEventListener('input', function(e) {
  if (e.target && e.target.classList && e.target.classList.contains('signal-id-input')) {
    var inputs = document.querySelectorAll('.signal-id-input');
    inputs.forEach(function(el) { if (el !== e.target) el.value = e.target.value; });
  }
});

async function verifySignal() {
  var inputEl = document.getElementById('signal-id');
  if (!inputEl) {
    var inputs = document.querySelectorAll('.signal-id-input');
    for (var i = 0; i < inputs.length; i++) { if (inputs[i].value) { inputEl = inputs[i]; break; } }
  }
  var id = inputEl ? inputEl.value : '';
  // W9-FIX-FORWARD R2 (2026-05-11): class-based mount + wrapper. Dual-render aware (one mount
  // per artboard); verifySignal writes innerHTML to all. Wrapper toggles display:block on
  // user call OR on ?id= URL param. Removed emerald-500 border wrapper per Mr.1 visual review.
  var mounts = document.querySelectorAll('.verify-result-mount');
  var wrappers = document.querySelectorAll('.verify-result-wrapper');
  var btn = document.getElementById('verify-btn');
  if (!mounts.length) return;
  if (!id) {
    mounts.forEach(function(m){ m.innerHTML = ''; });
    wrappers.forEach(function(w){ w.style.display = 'none'; });
    return;
  }
  wrappers.forEach(function(w){ w.style.display = 'block'; });
  if (btn) { btn.textContent = 'Checking...'; btn.disabled = true; }
  function setAll(content) { mounts.forEach(function(m){ m.innerHTML = content; }); }
  try {
    var res = await fetch(API_BASE + '/api/verify-signal?signalId=' + id);
    var data = await res.json();
    if (data.error === 'Signal not found') {
      setAll(
        '<div style="padding:20px 0">' +
          '<div style="display:inline-flex;align-items:center;gap:8px;margin-bottom:10px"><span style="width:7px;height:7px;border-radius:50%;background:oklch(0.7 0.18 25)"></span><span style="font-family:var(--font-mono);font-size:11px;color:oklch(0.7 0.18 25);letter-spacing:0.14em;font-weight:700">NOT FOUND</span></div>' +
          '<p style="font-size:14px;color:var(--fg-3);margin:0">No call with ID ' + id + ' exists.</p>' +
        '</div>'
      );
      return;
    }
    if (data.verified === false && data.reason) {
      setAll(
        '<div style="padding:20px 0">' +
          '<div style="display:inline-flex;align-items:center;gap:8px;margin-bottom:10px"><span style="width:7px;height:7px;border-radius:50%;background:oklch(0.78 0.13 220)"></span><span style="font-family:var(--font-mono);font-size:11px;color:oklch(0.78 0.13 220);letter-spacing:0.14em;font-weight:700">PENDING</span></div>' +
          '<p style="font-size:14px;color:var(--fg-3);margin:0 0 8px">Call recorded, awaiting next daily batch (00:05 UTC).</p>' +
          '<div style="font-family:var(--font-mono);font-size:11.5px;color:var(--fg-4)">' + data.signal.coin + ' &middot; ' + data.signal.direction + ' &middot; ' + data.signal.confidence + '% confidence</div>' +
        '</div>'
      );
      return;
    }
    var s = data.signal;
    var b = data.batch;
    var rowStyle = 'display:grid;grid-template-columns:120px 1fr;align-items:start;gap:14px;padding:10px 0;border-bottom:1px solid var(--line);font-family:var(--font-mono)';
    var labelStyle = 'font-size:10.5px;color:var(--fg-4);letter-spacing:0.1em;text-transform:uppercase';
    var valueStyle = 'font-size:13px;color:var(--fg-2);word-break:break-all;line-height:1.4';
    setAll(
      // VERIFIED ON-CHAIN status header — borderless (Mr.1 "remove black frame")
      '<div style="display:inline-flex;align-items:center;gap:8px;margin-bottom:18px">' +
        '<span style="width:7px;height:7px;border-radius:50%;background:var(--accent, var(--mint));box-shadow:0 0 8px var(--accent, var(--mint))"></span>' +
        '<span style="font-family:var(--font-mono);font-size:11px;color:var(--accent, var(--mint));letter-spacing:0.14em;font-weight:700">VERIFIED ON-CHAIN</span>' +
      '</div>' +
      '<div style="font-family:var(--font-display);font-size:22px;font-weight:600;letter-spacing:-0.018em;color:var(--fg);margin-bottom:6px">Call #' + s.id + '</div>' +
      '<p style="font-family:var(--font-mono);font-size:12.5px;color:var(--fg-3);margin:0 0 22px">' + s.coin + ' &middot; ' + s.direction + ' &middot; ' + s.confidence + '% confidence' + (s.timeframe ? ' &middot; ' + s.timeframe : '') + '</p>' +
      // 2-col stats row
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">' +
        '<div><div style="' + labelStyle + ';margin-bottom:5px">Price at Call</div><div style="font-family:var(--font-mono);font-size:13.5px;color:var(--fg)">$' + Number(s.price).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 6}) + '</div></div>' +
        '<div><div style="' + labelStyle + ';margin-bottom:5px">Timestamp</div><div style="font-family:var(--font-mono);font-size:13.5px;color:var(--fg)">' + fmtDate(s.timestamp) + '</div></div>' +
        '<div><div style="' + labelStyle + ';margin-bottom:5px">Batch</div><div style="font-family:var(--font-mono);font-size:13.5px;color:var(--fg)">#' + b.id + ' &middot; ' + b.signalCount + ' calls</div></div>' +
        '<div><div style="' + labelStyle + ';margin-bottom:5px">Published</div><div style="font-family:var(--font-mono);font-size:13.5px;color:var(--fg)">' + fmtDate(b.publishedAt) + '</div></div>' +
      '</div>' +
      // Hashes + tx
      '<div style="' + rowStyle + '"><span style="' + labelStyle + '">Call Hash</span><span style="' + valueStyle + '">' + s.hash + '</span></div>' +
      '<div style="' + rowStyle + '"><span style="' + labelStyle + '">Merkle Root</span><span style="' + valueStyle + '">' + b.root + '</span></div>' +
      '<div style="' + rowStyle + '"><span style="' + labelStyle + '">Tx Hash</span><span style="' + valueStyle + '">' + truncHash(b.txHash) + ' <a href="' + b.basescanUrl + '" target="_blank" rel="noopener noreferrer" style="color:var(--accent, var(--mint));text-decoration:none;margin-left:6px">View on Basescan &rarr;</a></span></div>' +
      '<div style="' + rowStyle + '"><span style="' + labelStyle + '">Contract</span><span style="' + valueStyle + '">' + truncHash(data.contractAddress) + ' <a href="https://basescan.org/address/' + data.contractAddress + '" target="_blank" rel="noopener noreferrer" style="color:var(--accent, var(--mint));text-decoration:none;margin-left:6px">View on Basescan &rarr;</a></span></div>' +
      '<div style="' + rowStyle + ';border-bottom:none"><span style="' + labelStyle + '">Chain</span><span style="' + valueStyle + '">Base (8453)</span></div>'
    );
  } catch (err) {
    setAll(
      '<div style="padding:20px 0">' +
        '<div style="display:inline-flex;align-items:center;gap:8px;margin-bottom:10px"><span style="width:7px;height:7px;border-radius:50%;background:oklch(0.7 0.18 25)"></span><span style="font-family:var(--font-mono);font-size:11px;color:oklch(0.7 0.18 25);letter-spacing:0.14em;font-weight:700">ERROR</span></div>' +
        '<p style="font-size:14px;color:var(--fg-3);margin:0">Verification request failed. Try again.</p>' +
      '</div>'
    );
  } finally {
    if (btn) { btn.textContent = 'Verify on-chain \\u2192'; btn.disabled = false; }
  }
}

// Enter key triggers verify on EITHER artboard input (dual-render aware).
document.querySelectorAll('.signal-id-input').forEach(function(el) {
  el.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') verifySignal();
  });
});

// W9-FIX-FORWARD Fix 6 (2026-05-11): URL param auto-lookup ONLY when ?id= or ?signalId= explicitly
// present. The W4 auto-load-most-recent fallback (fetch /api/performance-public → recentSignals[0].id
// → verifySignal()) REMOVED — Mr.1 observed the result panel showing PENDING content on page load
// without user interaction; root cause was that fallback. Wrapper stays hidden until user clicks
// Verify on-chain → button OR navigates with ?id=<hex> deep-link.
(function() {
  var params = new URLSearchParams(window.location.search);
  var id = params.get('signalId') || params.get('id');
  if (id) {
    document.querySelectorAll('.signal-id-input').forEach(function(el) { el.value = id; });
    verifySignal();
  }
  // else: do nothing on page load. User must click button or arrive with deep-link.
})();

// W9-FIX-FORWARD Fix 4a (2026-05-11): Recent ID pills loader — fetches /api/verify-sample-ids and
// populates ALL .sample-ids-row mount points (dual-render: desktop + mobile artboards each have one;
// HTML id-uniqueness preserved by giving desktop the sample-ids id + class, mobile class-only).
// Click handler propagates the chosen id to both desktop + mobile inputs via .signal-id-input class.
(async function() {
  var containers = document.querySelectorAll('.sample-ids-row');
  if (!containers.length) return; // mount-points absent — skip (pre-Fix-4a state)
  try {
    var res = await fetch('/api/verify-sample-ids');
    var data = await res.json();
    if (!data.signals || data.signals.length === 0) return;
    containers.forEach(function(container) {
      data.signals.forEach(function(s) {
        var btn = document.createElement('button');
        btn.className = 'pill';
        btn.dataset.id = s.id;
        btn.textContent = '#' + s.id;
        btn.title = s.coin + ' ' + s.signal + ' \\u2022 ' + s.timeframe + ' \\u2022 ' + s.confidence + '%';
        btn.style.cssText = 'background:oklch(0.18 0.014 265 / 0.55);border:1px solid var(--line);border-radius:999px;padding:3px 10px;color:var(--accent, var(--mint));cursor:pointer;font-family:var(--font-mono);font-size:11px;font-weight:500;transition:background 0.2s';
        btn.onmouseenter = function() { this.style.background = 'oklch(0.32 0.08 170 / 0.32)'; };
        btn.onmouseleave = function() { this.style.background = 'oklch(0.18 0.014 265 / 0.55)'; };
        btn.onclick = function() {
          document.querySelectorAll('.signal-id-input').forEach(function(el) { el.value = btn.dataset.id; });
          verifySignal();
        };
        container.appendChild(btn);
      });
    });
  } catch (e) {}
})();

// W9-FIX-FORWARD Fix 6 (2026-05-11): DOMContentLoaded reveal-on-?id JS (defense-in-depth for the
// wrapper toggle — verifySignal() also reveals on user call, this handles the case where the page
// loads with ?id= present but verifySignal hasn't yet completed).
document.addEventListener('DOMContentLoaded', function() {
  if (new URLSearchParams(location.search).has('id') || new URLSearchParams(location.search).has('signalId')) {
    document.querySelectorAll('.verify-result-wrapper').forEach(function(w){ w.style.display = 'block'; });
  }
});
</script>`;

// Pre-Babel patches for verify.jsx (none required for C2 — JSX is canonical SoT; all overrides
// happen as post-render substitutions in C3 per jsx-source-patch-vs-post-render-substitution skill).
function patchVerifyJsx(src) {
  return src;
}

// W4 form preservation: rename JSX <input id="verify-input-d"> to id="signal-id" (desktop only;
// mobile strips id for HTML id-uniqueness per dual-render-desktop-mobile-media-swap skill); add
// class="signal-id-input" to BOTH inputs for cross-artboard querySelector; add
// id="verify-btn" + onclick to desktop button only; both buttons get onclick + class.
// Per Q-W9-10 architect-ratified preservation strategy.
// isDesktop flag: desktop gets id="signal-id" + id="verify-btn"; mobile strips ids entirely.
function preserveVerifyW4Form(html, isDesktop) {
  if (isDesktop) {
    // Desktop input — rename id + add class
    html = html.replace(
      /<input id="verify-input-d"/g,
      '<input id="signal-id" class="signal-id-input"'
    );
    // Desktop label for-attr (JSX htmlFor renders as for)
    html = html.replace(/<label for="verify-input-d"/g, '<label for="signal-id"');
    // Desktop button: add id="verify-btn" + onclick + class
    html = html.replace(
      /<button type="button" class="btn btn-primary"\s+aria-label="Verify on-chain"/g,
      '<button type="button" id="verify-btn" class="btn btn-primary verify-btn-trigger" onclick="verifySignal()" aria-label="Verify on-chain"'
    );
  } else {
    // Mobile input — strip id, add class (avoids dual-id collision with desktop)
    html = html.replace(
      /<input id="verify-input-m"/g,
      '<input class="signal-id-input"'
    );
    // Mobile label — strip for-attr entirely (no matching id)
    html = html.replace(/<label for="verify-input-m"/g, '<label');
    // Mobile button: onclick + class only (no id — avoids dual-id collision)
    html = html.replace(
      /<button type="button" class="btn btn-primary"\s+aria-label="Verify on-chain"/g,
      '<button type="button" class="btn btn-primary verify-btn-trigger" onclick="verifySignal()" aria-label="Verify on-chain"'
    );
  }
  return html;
}

// Wrap desktop + mobile artboards in lp-verify-{desktop,mobile} divs. @media swap CSS is in the
// VERIFY_HEAD_AND_NAV <style> block.
// DESIGN-W9-FIX-FORWARD R2 (2026-05-11): result mount moved INSIDE each artboard, immediately
// after VInput section. Class-based selectors (.verify-result-wrapper > .verify-result-mount)
// support dual-render — verifySignal queries class + writes to all mounts. Wrapper hidden by
// default; revealed on user-initiated verifySignal call OR on ?id= URL param.
function wrapVerifyDualRender(desktopHtml, mobileHtml) {
  return `<main class="verify-main">\n` +
    `<div class="lp-verify-desktop">${desktopHtml}</div>\n` +
    `<div class="lp-verify-mobile">${mobileHtml}</div>\n` +
    `</main>\n`;
}

// Assemble full HTML document.
function buildVerifyHtmlDocument(bodyContent, appendedJs) {
  return VERIFY_HEAD_AND_NAV + bodyContent + (appendedJs || '') + '\n</body>\n</html>\n';
}

// ── DESIGN-W9 C3 — Wave overrides + 4 data-tr-field live-binds ──────────────

// Override 1 (Mr.1 directive #3): VRecent eyebrow rename `· social proof` → `· Agent Verification Records`.
function applyVerifyOverride1Eyebrow(html) {
  return html.replaceAll('· social proof', '· Agent Verification Records');
}

// Override 2 (Q-W9-4 architect-ratified): VRecent rows REMOVED — replace with empty-state shell.
// Anchor: VRecent VCard has unique `padding:0;overflow:hidden` style; last row contains literal `14m ago`;
// closing structure ends with `</div></div></section>` (closing row + VCard + section).
function applyVerifyOverride2VRecentEmpty(html) {
  // Empty-state shell card — visually similar treatment to the VCard but with copy + cue.
  const emptyShell = '<div class="recent-verifications-empty" style="border:1px solid var(--line);border-radius:14px;background:oklch(0.18 0.014 265 / 0.55);padding:32px 22px;text-align:center">'
    + '<div style="font-family:var(--font-mono);font-size:11px;color:var(--fg-4);letter-spacing:0.14em;text-transform:uppercase;margin-bottom:10px">No recent verifications yet</div>'
    + '<p style="font-size:14.5px;color:var(--fg-2);margin:0 auto;line-height:1.55;max-width:42rem">Verifications will appear here once requesters opt in to public attribution.</p>'
    + '</div>';
  // Match the VRecent VCard from opening (with padding:0;overflow:hidden style) through the
  // close `</div></div>` immediately preceding `</section>` (positive lookahead).
  return html.replace(
    /<div [^>]*padding:0;overflow:hidden[^>]*>[\s\S]*?14m ago[\s\S]*?<\/div><\/div>(?=<\/section>)/g,
    emptyShell + '</div>' // +1 </div> to compensate for the lookahead-anchored second </div> being consumed by match
  );
}

// Override 3 + 5: VFooter contract address full EIP-55 + Basescan link wrap (+ basescan ↗ href rewrite).
function applyVerifyOverride3Contract(html) {
  // Replace JSX placeholder `0x9aF3…b21c` with the canonical full EIP-55 address.
  html = html.replaceAll('0x9aF3…b21c', '0x6485396ac981Fe0A58540dfBF3E730f6F7BcbF81');
  // Wrap the now-full address (rendered inside a mint-colored span) in a Basescan anchor.
  html = html.replace(
    /(<span style="color:var\(--accent, var\(--mint\)\)">)(0x6485396ac981Fe0A58540dfBF3E730f6F7BcbF81)(<\/span>)/g,
    '<a href="https://basescan.org/address/0x6485396ac981Fe0A58540dfBF3E730f6F7BcbF81" target="_blank" rel="noopener noreferrer" style="text-decoration:none">$1$2$3</a>'
  );
  return html;
}

// Override 4 (Q-W9-2 + Q-W9-3): VerifyNav link rewrites.
// Override 5: VFooter link rewrites (basescan ↗, docs ↗).
function applyVerifyOverride45Links(html) {
  // Q-W9-3 architect-ratified: REMOVE Verdicts link (/verdicts page doesn't exist).
  html = html.replace(/<a href="#">Verdicts<\/a>/g, '');
  // Q-W9-2: rewrite VerifyNav nav-cta "Open in Claude →" to /docs.html#mcp-install.
  html = html.replace(
    /<a href="#" class="nav-cta">Open in Claude →<\/a>/g,
    '<a href="/docs.html#mcp-install" class="nav-cta">Open in Claude →</a>'
  );
  // VerifyNav Docs: rewrite to /docs.html.
  html = html.replace(/<a href="#">Docs<\/a>/g, '<a href="/docs.html">Docs</a>');
  // VFooter basescan ↗ link: full Basescan URL + target="_blank" + rel="noopener noreferrer".
  html = html.replace(
    /<a href="#"([^>]*)>basescan ↗<\/a>/g,
    '<a href="https://basescan.org/address/0x6485396ac981Fe0A58540dfBF3E730f6F7BcbF81" target="_blank" rel="noopener noreferrer"$1>basescan ↗</a>'
  );
  // VFooter docs ↗ link: internal /docs.html (no target=_blank).
  html = html.replace(
    /<a href="#"([^>]*)>docs ↗<\/a>/g,
    '<a href="/docs.html"$1>docs ↗</a>'
  );
  return html;
}

// Override 6 (Q-W9-9 architect-ratified — spec-cross-section-contradiction-probe 2nd sighting):
// Strip the `outcome:{won,pfe_bps}` line from the VFooter <pre> code example. JSX text is
// HTML-encoded by React (" → &quot;), so the literal pattern uses HTML entities. After strip,
// the trailing comma on `"tx":...` is also removed so JSON-ish demo parses cleanly.
function applyVerifyOverride6PreOutcomeStrip(html) {
  return html.replace(
    /(&quot;tx&quot;:\s*&quot;0x7f91…12cc&quot;),\n\s*&quot;outcome&quot;:\{[^}]+\}/g,
    '$1'
  );
}

// W9 live-bind hydration block — 4 data-tr-field spans + setInterval countdown.
// Q-W9-11 architect-ratified hydration order: track-record-proxy.js FIRST (cross-page parity for
// existing batch_count + call_count spans if present), THEN inline W9 block (verify-page-scoped
// latest_batch + latest_batch_n + latest_batch_at + next_batch_in fields not supported by proxy.js).
const VERIFY_W9_LIVEBIND_JS = `<!-- DESIGN-W9 hydration: proxy.js FIRST (Q-W9-11 ratification) for cross-page parity; inline W9 block THEN -->
<script src="/js/track-record-proxy.js" defer></script>
<script>
(function(){
  // DESIGN-W9 inline hydration (verify-page-scoped fields).
  if (window.__w9VerifyHydrationInit) return;
  window.__w9VerifyHydrationInit = true;
  function fmtBatchAt(iso) {
    if (!iso) return null;
    var dt = new Date(iso);
    if (isNaN(dt.getTime())) return null;
    var Y = dt.getUTCFullYear();
    var M = String(dt.getUTCMonth() + 1).padStart(2, '0');
    var D = String(dt.getUTCDate()).padStart(2, '0');
    var h = String(dt.getUTCHours()).padStart(2, '0');
    var m = String(dt.getUTCMinutes()).padStart(2, '0');
    return Y + '-' + M + '-' + D + ' ' + h + ':' + m + ' UTC';
  }
  function fmtNextBatchIn() {
    // Production batches publish 00:05 UTC daily (per system-map.md + live observation 2026-05-11).
    var now = new Date();
    var next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 5, 0));
    if (next <= now) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
    var totalMin = Math.max(0, Math.floor((next - now) / 60000));
    var h = Math.floor(totalMin / 60);
    var m = totalMin % 60;
    return h > 0 ? (h + 'h ' + m + 'm') : (m + 'm');
  }
  function setField(name, value) {
    if (value == null) return;
    document.querySelectorAll('[data-tr-field="' + name + '"]').forEach(function(el){ el.textContent = value; });
  }
  // Q-W9-12 inline-fix: API field names are batch_id + published_at (NOT batchNumber + timestamp as spec said).
  fetch('/api/merkle-batches').then(function(r){
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function(data){
    if (!data || !Array.isArray(data.batches) || !data.batches.length) return;
    var latest = data.batches[0];
    setField('latest_batch', '#' + latest.batch_id);
    setField('latest_batch_n', String(latest.batch_id));
    setField('latest_batch_at', fmtBatchAt(latest.published_at));
  }).catch(function(err){
    console.warn('[w9-verify-hydration] /api/merkle-batches fetch failed', err);
  });
  // Client-computed countdown (W8-FIX pattern): 60s setInterval.
  function updateNextBatchCountdown() { setField('next_batch_in', fmtNextBatchIn()); }
  updateNextBatchCountdown();
  setInterval(updateNextBatchCountdown, 60000);
})();
</script>`;

// ── DESIGN-W9-FIX-FORWARD overrides (2026-05-11 post-deploy Mr.1 visual review) ──

// Fix 1: strip JSX-rendered <nav class="nav">…</nav> (VerifyNav) — duplicates the global W7 nav.
// Modeled on existing w7HeroStripNav. Cross-page consistency wins: global AlgoVault Labs nav stays.
function applyVerifyFixForward1StripNav(html) {
  return html.replace(/<nav class="nav"[^>]*>[\s\S]*?<\/nav>/g, '');
}

// Fix 4a: replace JSX literal `· tries: leaf hash → merkle proof → batch root → tx · all client-side`
// (rendered as `<span>· tries: leaf hash …</span>`) with `<div id="sample-ids">Recent ID:</div>`
// so the W4 pills loader (restored in VERIFY_W4_PRESERVED_JS) can populate 5 clickable signal-id pills.
// isDesktop param dedupes id="sample-ids" across dual-render (desktop gets id; mobile gets class only).
// Pills loader uses querySelectorAll('.sample-ids-row') to populate BOTH artboards.
function applyVerifyFixForward4aPillsMarkup(html, isDesktop) {
  const idAttr = isDesktop ? 'id="sample-ids" ' : '';
  return html.replace(
    /<span>· tries: leaf hash → merkle proof → batch root → tx · all client-side<\/span>/g,
    `<div ${idAttr}class="sample-ids-row" style="display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px;font-family:var(--font-mono);font-size:11.5px;color:var(--fg-4)">Recent ID:</div>`
  );
}

// Fix 4b: replace JSX literal `tip: use the share button on any /track-record row to get a deep-link`
// with new copy `Tips: Click Call ID on /track-record > Latest Trade Calls to Verify`.
// JSX renders the tip with React `<!-- -->` separator between adjacent text nodes and JSX children
// (React's classic-runtime renderToString inserts a comment marker to split text-children regions
// for hydration boundary tracking). Regex accounts for the `<!-- --> ` between "any" and the anchor.
// R3.1 amendment (2026-05-11 Mr.1 directive): "Signal ID" → "Call ID" in tip text.
function applyVerifyFixForward4bTipsCopy(html) {
  return html.replace(
    /<span style="color:var\(--fg-3\)">tip: use the share button on any<!-- --> (<a href="\/track-record"[^>]*>\/track-record<\/a>) row to get a deep-link<\/span>/g,
    '<span style="color:var(--fg-3)">Tips: Click Call ID on $1 &gt; Latest Trade Calls to Verify</span>'
  );
}

// ── DESIGN-W9 FIX-FORWARD ROUND 2 (2026-05-11 Mr.1 visual review post-Round-1-deploy) ──

// Fix R2-1: insert result-mount immediately after VInput section close (currently the result mount
// sat after both artboards at page-bottom). Class-based (.verify-result-mount + wrapper) for
// dual-render. verifySignal writes innerHTML to all mounts; wrapper toggles display.
// Anchor: VInput section ends with `Latest Trade Calls to Verify</span></div></div></section>` (post Fix 4b).
function applyVerifyFixForwardR2InsertResultMount(html, isDesktop) {
  const sectionPadding = isDesktop ? '0 80px 56px' : '0 22px 36px';
  const mountSection =
    `<section style="padding:${sectionPadding}" class="verify-result-section">` +
      `<div class="verify-result-wrapper" style="display:none">` +
        `<div class="verify-result-mount" aria-live="polite" style="padding:0"></div>` +
      `</div>` +
    `</section>`;
  return html.replace(
    /(Latest Trade Calls to Verify<\/span><\/div><\/div><\/section>)/g,
    '$1' + mountSection
  );
}

// Fix R2-2: strip bg-radial-accent divs (the green/mint radial glow Mr.1 saw bleeding above the
// global W7 sticky nav). bg-grid + bg-noise preserved — Mr.1 only flagged the green shape.
function applyVerifyFixForwardR2StripRadialAccent(html) {
  return html.replace(/<div class="bg-radial-accent"><\/div>/g, '');
}

// Fix R2-3: insert "How to Verify" (3-step) + "How It Works" (4-step) sections immediately before
// VFaq section. Restores pre-W9 verify.html content as VCard-style cards per Mr.1 directive
// "Put back How to Verify + How It Works as cards, Above FAQ".
// Anchor: VFaq's opening `<section ...><div ...>· faq</div>`.
function applyVerifyFixForwardR2AddHowSections(html, isDesktop) {
  const sectionPadding = isDesktop ? '0 80px 80px' : '0 22px 36px';
  const headingSize = isDesktop ? 38 : 26;
  const cardCols = isDesktop ? '1fr 1fr 1fr' : '1fr';
  const cardCols4 = isDesktop ? 'repeat(4, 1fr)' : '1fr';
  const cardPad = isDesktop ? '24px 22px' : '20px 20px';

  const eyebrow = (text) =>
    `<div style="display:inline-flex;align-items:center;gap:10px;margin-bottom:18px;font-family:var(--font-mono);font-size:11px;color:var(--fg-3);letter-spacing:0.14em;text-transform:uppercase">` +
      `<span style="width:5px;height:5px;border-radius:50%;background:var(--accent, var(--mint));box-shadow:0 0 8px var(--accent, var(--mint))"></span>` +
      `· ${text}` +
    `</div>`;
  const h2 = (text) =>
    `<h2 style="font-family:var(--font-display);font-size:${headingSize}px;font-weight:500;letter-spacing:-0.022em;line-height:1.05;margin:0 0 28px;text-wrap:balance">${text}</h2>`;
  const card = (num, title, body) =>
    `<div style="border:1px solid var(--line);border-radius:14px;background:oklch(0.18 0.014 265 / 0.55);padding:${cardPad};display:flex;flex-direction:column;gap:12px">` +
      `<div style="display:flex;align-items:center;justify-content:space-between">` +
        `<span style="width:32px;height:32px;border-radius:8px;display:grid;place-items:center;background:oklch(0.32 0.08 170 / 0.22);border:1px solid oklch(0.5 0.14 165 / 0.4);color:var(--accent, var(--mint));font-family:var(--font-mono);font-size:12px;font-weight:600">${num}</span>` +
      `</div>` +
      `<div>` +
        `<div style="font-family:var(--font-display);font-size:16px;font-weight:500;letter-spacing:-0.012em;color:var(--fg);margin-bottom:6px">${title}</div>` +
        `<p style="font-size:13px;color:var(--fg-3);margin:0;line-height:1.55">${body}</p>` +
      `</div>` +
    `</div>`;

  const howToVerify =
    `<section style="padding:${sectionPadding}">` +
      eyebrow('How to Verify') +
      h2('Verify any AlgoVault call in 3 steps.') +
      `<div style="display:grid;grid-template-columns:${cardCols};gap:14px">` +
        card('01', 'Pick a Call',
          `Use a Recent ID pill above, click a Signal ID on <a href="/track-record" style="color:var(--accent, var(--mint));text-decoration:none">/track-record</a> &gt; Latest Trade Calls, or pull <span style="font-family:var(--font-mono);color:var(--accent, var(--mint))">GET /api/performance-public</span> for any call.id.`) +
        card('02', 'Check the Proof',
          'Enter the ID above and click Verify on-chain. You’ll see the call’s hash, its Merkle proof, and the on-chain batch it belongs to.') +
        card('03', 'Verify On-Chain',
          'Click the Basescan link to inspect the Merkle root in the smart contract. The proof confirms the call existed before its outcome window opened.') +
      `</div>` +
    `</section>`;

  const howItWorks =
    `<section style="padding:${sectionPadding}">` +
      eyebrow('How It Works') +
      h2('Hashed first. Anchored daily. Immutable forever.') +
      `<div style="display:grid;grid-template-columns:${cardCols4};gap:14px">` +
        card('01', 'Call Created',
          'Every BUY/SELL/HOLD call is hashed via keccak256(coin, signal, confidence, timeframe, timestamp, price) at the moment it’s generated — BEFORE the outcome is known.') +
        card('02', 'Hash Stored',
          'The hash is stored alongside the call in our database. Deterministic; anyone with the call data can recompute and verify it.') +
        card('03', 'Daily Batch',
          'At 00:05 UTC, all new call hashes assemble into a Merkle tree. Each leaf is a call hash; the tree produces a single root committing the entire set.') +
        card('04', 'On-Chain Anchor',
          'The Merkle root is published to the AlgoVault contract on Base L2 — permanent, immutable, publicly verifiable by anyone.') +
      `</div>` +
    `</section>`;

  return html.replace(
    /(<section[^>]*>\s*<div[^>]*>\s*<span[^>]*><\/span>· faq)/g,
    howToVerify + howItWorks + '$1'
  );
}

// Aggregate C3 overrides for a single artboard.
// DESIGN-W9-FIX-FORWARD (2026-05-11): Q-W9-4 REVERSED by architect — applyVerifyOverride2VRecentEmpty
// REMOVED from chain (ship JSX VRecent 10 rows verbatim per Mr.1's "we publish Merkle batches
// proactively, demo rows showing past published verifications are factually accurate"
// reversal). Q-W9-4 ratification preserved in audits/DESIGN-W9-mapping.md for historical record.
// isDesktop param dedupes id="sample-ids" across dual-render (Fix 4a HTML id-uniqueness).
function applyVerifyC3Overrides(html, isDesktop) {
  html = applyVerifyOverride1Eyebrow(html);
  // applyVerifyOverride2VRecentEmpty — REMOVED per Fix-Forward Fix 5 (architect override Q-W9-4 reversal)
  html = applyVerifyOverride3Contract(html);
  html = applyVerifyOverride45Links(html);
  html = applyVerifyOverride6PreOutcomeStrip(html);
  // Fix-Forward Round 1 additions (post-deploy 2026-05-11):
  html = applyVerifyFixForward1StripNav(html);                  // Fix 1: strip JSX VerifyNav (duplicate nav)
  html = applyVerifyFixForward4aPillsMarkup(html, isDesktop);   // Fix 4a: replace JSX helper text with #sample-ids div (desktop) / class-only (mobile)
  html = applyVerifyFixForward4bTipsCopy(html);                 // Fix 4b: replace JSX tip copy
  // Fix-Forward Round 2 additions (Mr.1 post-Round-1 visual review 2026-05-11):
  html = applyVerifyFixForwardR2InsertResultMount(html, isDesktop); // R2-1: result mount inside VInput
  html = applyVerifyFixForwardR2StripRadialAccent(html);            // R2-2: strip green radial glow
  html = applyVerifyFixForwardR2AddHowSections(html, isDesktop);    // R2-3: How to Verify + How It Works cards above VFaq
  // Fix-Forward Round 3 additions (Mr.1 post-Round-2 visual review 2026-05-11):
  html = applyVerifyFixForwardR3Placeholder(html);                  // R3-1: placeholder #86... integer-style
  html = applyVerifyFixForwardR3HeroSubhead(html);                  // R3-3: subhead 2-line + trade call + cannot
  html = applyVerifyFixForwardR3SignalToCall(html);                 // R3-4: user-facing "Signal" → "Call" sweep
  return html;
}

// ── DESIGN-W9 FIX-FORWARD ROUND 3 (2026-05-11 Mr.1 post-Round-2 visual review) ──

// R3-1: VInput placeholder format. JSX renders `0x4a2…f91   ·   or   2026-05-09T17:42:18Z`
// (hex hash example + ISO timestamp); Mr.1 wants integer-style `#86...` per Image 1 (matches
// Recent ID pills format like #86995, #87554 etc.). Keep the timestamp branch for clarity.
function applyVerifyFixForwardR3Placeholder(html) {
  return html.replace(
    /placeholder="0x4a2…f91   ·   or   2026-05-09T17:42:18Z"/g,
    'placeholder="#86...   ·   or   2026-05-09T17:42:18Z"'
  );
}

// R3-3: Hero subhead — 2-line arrangement + "signal" → "trade call" + "can't" → "cannot".
// Actual rendered shape (verified via grep):
//   Every signal is hashed on Base L2 <em style="...">before</em> the outcome is known. Inspect
//   the contract on Basescan — we can’t edit history.
// (Note: apostrophe is U+2019 RIGHT SINGLE QUOTATION MARK, NOT ASCII apostrophe.)
function applyVerifyFixForwardR3HeroSubhead(html) {
  // Body hero subhead (×2 dual-render). Meta description in HEAD updated directly in
  // VERIFY_HEAD_AND_NAV constant (this function runs on artboard HTML only, before head assembly).
  return html.replace(
    /Every signal is hashed on Base L2 <em style="([^"]*)">before<\/em> the outcome is known\. Inspect the contract on Basescan — we can’t edit history\./g,
    'Every trade call is hashed on Base L2 <em style="$1">before</em> the outcome is known.<br/>Inspect the contract on Basescan — we cannot edit history.'
  );
}

// R3-4: User-facing "Signal" → "Call" terminology sweep. Preserves technical terms:
//   - verify://signal/{id} (MCP URI — load-bearing primitive)
//   - signal_hash, signal_id (DB column names)
//   - /api/verify-signal (API endpoint URL)
//   - signal-performance (MCP resource name)
// Targets user-visible copy ONLY: labels, eyebrow text, headings, FAQ Q&A, placeholder caps.
function applyVerifyFixForwardR3SignalToCall(html) {
  // 1. VInput label + aria — JSX renders both as "signal id or call timestamp" and "Signal ID or call timestamp"
  html = html.replaceAll('signal id or call timestamp', 'call id or call timestamp');
  html = html.replaceAll('Signal ID or call timestamp', 'Call ID or call timestamp');
  // 2. VFaq Q&A: "What does it mean that a signal is Merkle-anchored?"
  html = html.replaceAll(
    'What does it mean that a signal is Merkle-anchored?',
    'What does it mean that a call is Merkle-anchored?'
  );
  // 3. VFaq: "How do I verify a signal myself without trusting algovault.com?"
  html = html.replaceAll(
    'How do I verify a signal myself without trusting algovault.com?',
    'How do I verify a call myself without trusting algovault.com?'
  );
  // 4. VFaq: "Can a signal be edited after it's batched?" (apostrophe is unicode right-single-quote)
  html = html.replaceAll(
    'Can a signal be edited after it’s batched?',
    'Can a call be edited after it’s batched?'
  );
  // 5. VFaq answer prose: "Each signal's payload is hashed..." → "Each call's payload..."
  html = html.replaceAll('Each signal’s payload', 'Each call’s payload');
  // 6. VFaq answer "Once anchored, neither the signal nor the root..." → "Once anchored, neither the call nor the root..."
  html = html.replaceAll(
    'Once anchored, neither the signal nor the root can be modified',
    'Once anchored, neither the call nor the root can be modified'
  );
  // 7. JSX VHowItWorks step 1 title "Signal generated" → "Call generated"
  html = html.replaceAll('>Signal generated<', '>Call generated<');
  // 8. JSX VHowItWorks intro paragraph: "A signal can't be edited..." → "A trade call cannot be edited..."
  html = html.replaceAll(
    'A signal can’t be edited after the market answers',
    'A trade call cannot be edited after the market answers'
  );
  // 9. R3.1 amendment: JSX VHowItWorks step 1 body "Model emits a typed call..." → "Model emits a Trade Call..."
  html = html.replaceAll(
    'Model emits a typed call (asset · TF · direction · confidence)',
    'Model emits a Trade Call (asset · TF · direction · confidence)'
  );
  // 8. JSX VHowItWorks step 1 body: "Model emits a typed call (asset · TF · direction · confidence) from live market features."
  //    — already uses "call", fine. No change.
  // 9. JSX VHowItWorks H2 "Hashed first. Outcome second." — fine, no signal/call ambiguity.
  // 10. JSX VHero badge `<span data-tr-field="latest_batch">#31</span>` — fine, no change.
  // 11. JSX VFooter `<pre>` example `mcp:read("verify://signal/0x4a2…f91")` — PRESERVED (MCP URI primitive).
  return html;
}

// ── DESIGN-HOW-IT-WORKS-W1 (2026-05-14) — /how-it-works JSX-faithful render ─

// Pre-Babel patches for v1-howitworks.jsx.
// DESIGN-HOW-IT-WORKS-FF-2 (2026-05-15): Mr.1 directive — REMOVE the VerifySection demo
// form (the "Don't trust. Verify." section with input + status + metadata grid). The
// inject-VerifySection patch from FF-1 W1 (which injected `<VerifySection mobile={mobile} />`
// between AgentsSection and BuildVsBuySection) is REVERTED — the JSX's default HowItWorksPage
// composition is now respected verbatim (Hero → WhatIs → Flywheel → Agents → BuildVsBuy →
// FAQ → BottomCTA → Footer; no Verify section in body). Canonical Nav's relative `/verify`
// link (in HEAD_AND_NAV) covers the navigation requirement.
function patchHowItWorks(src) {
  return src;
}

// Strip JSX-emitted Nav (<header style="position:relative;zIndex:5;...">...</header>)
// — replaced by canonical Nav in the HEAD_AND_NAV constant per R5 + DESIGN-W10 chrome
// contract. The JSX uses only ONE <header> tag (the Nav at line 156-214 of v1-howitworks.jsx),
// so the broad pattern is safe.
function stripHowItWorksJsxNav(html) {
  return html.replace(/<header[^>]*>[\s\S]*?<\/header>/g, '');
}

// Strip JSX-emitted Footer (<footer style="padding:36px 22px...">...</footer> mobile +
// <footer style="padding:40px 64px...">...</footer> desktop) — replaced by canonical
// Footer block per R4. The JSX uses only ONE <footer> tag, so the broad pattern is safe.
function stripHowItWorksJsxFooter(html) {
  return html.replace(/<footer[^>]*>[\s\S]*?<\/footer>/g, '');
}

// R2 — Group A: Hero spec ticker. JSX renders 4 tuples as
//   <div><span style="color:var(--fg);font-weight:600">86,420</span><span style="color:var(--fg-4)">verified calls</span></div>
// (etc). Wrap each numeric span content in a data-tr-field span. Anchored on the
// "color:rgb(248, 251, 250);font-weight:600" inline style which React renders for T.fg + 600
// (T.fg = oklch(0.97 0.005 265) → rgb(248, 251, 250) post-color-normalize). To be safe across
// React's serialization quirks, anchor on the textContent itself when paired with the visible label.
function applyHowItWorksGroupAHeroTicker(html) {
  // Match `>86,420</span>` adjacent to "verified calls" label
  html = html.replace(/>86,420<\/span>/, '><span data-tr-field="call_count">86,420</span></span>');
  html = html.replace(/>90\.4%<\/span>/, '><span data-tr-field="pfe_wr">90.4%</span></span>');
  // 720+ in ticker — the literal includes the `+` in the JSX. Wrap "720" + keep "+" outside.
  html = html.replace(/>720\+<\/span>/, '><span data-tr-field="asset_count">720</span>+</span>');
  // The hero ticker "5" alone — anchor on adjacent "venues" label to disambiguate from other "5"s
  // (e.g. the FlywheelSection step "01"/"02" indices, BuildVsBuy "5 venues" already in Group D).
  html = html.replace(
    /(>)5(<\/span>(?:<!-- -->)?<span[^>]*>venues<\/span>)/,
    '$1<span data-tr-field="exchange_count">5</span>$2'
  );
  return html;
}

// R2 — Group B: Hero diagram MODEL node "Batch 34". JSX line 312:
//   <div style="font-family:...;color:rgb(141, 140, 140);margin-top:4px">Batch 34</div>
// Wrap the "34" literal in a data-tr-field span. Anchor on "Batch " prefix to avoid matching
// other 34s (e.g. arbitrary y-coordinate values in SVG path data).
function applyHowItWorksGroupBBatch(html) {
  return html.replace(/>Batch 34</g, '>Batch <span data-tr-field="merkle_batch_count">34</span><');
}

// R2 — Group C: WhatIsSection card body (line 447): "720+ assets. 11 timeframes."
// JSX renders this inside a <p>. The "720+" and "11 timeframes" literals are unique enough
// to anchor on, but to keep the diff surgical, target the full sentence pattern.
function applyHowItWorksGroupCWhatIs(html) {
  return html.replace(
    /Same model evaluates Binance, Hyperliquid, Bybit, OKX, Bitget\. 720\+ assets\. 11 timeframes\./g,
    'Same model evaluates Binance, Hyperliquid, Bybit, OKX, Bitget. <span data-tr-field="asset_count">720</span>+ assets. <span data-tr-field="timeframe_count">11</span> timeframes.'
  );
}

// R2 — Group C (extra): WhatIsSection on-chain card body (line 452):
// "Every signal hashed at emission, anchored on Base L2 daily. 33+ Merkle batches published."
// FF-1 mandate: "signal" → "call" in public-facing prose. Also live-bind 33 batch count.
function applyHowItWorksGroupCOnChain(html) {
  return html.replace(
    /Every signal hashed at emission, anchored on Base L2 daily\. 33\+ Merkle batches published\./g,
    'Every call hashed at emission, anchored on Base L2 daily. <span data-tr-field="merkle_batch_count">33</span>+ Merkle batches published.'
  );
}

// R2 — Group D: BuildVsBuySection "Call Algovault" column (lines 956-957). JSX renders
// these in <li> rows. The cells are the full string of each tuple — anchor on the unique
// phrasing then live-bind the numbers + retain the rest.
function applyHowItWorksGroupDBuildVsBuy(html) {
  // Row: "720+ assets · 11 timeframes · 5 venues"
  html = html.replace(
    /720\+ assets · 11 timeframes · 5 venues/g,
    '<span data-tr-field="asset_count">720</span>+ assets · <span data-tr-field="timeframe_count">11</span> timeframes · <span data-tr-field="exchange_count">5</span> venues'
  );
  // Row: "86,000+ verified calls · 90.4% PFE WR"
  html = html.replace(
    /86,000\+ verified calls · 90\.4% PFE WR/g,
    '<span data-tr-field="call_count">86,000</span>+ verified calls · <span data-tr-field="pfe_wr">90.4%</span> PFE WR'
  );
  return html;
}

// R2 — Group E: FAQ A2 answer (line 1129):
//   "...updating across 720+ assets has no single trade to crowd..."
// React's renderToString inserts <!-- --> separators between text and JSX boundaries.
// Anchor on the unique surrounding text rather than the bare "720+".
function applyHowItWorksGroupEFaqA2(html) {
  return html.replace(
    /updating across 720\+ assets has no single trade to crowd/g,
    'updating across <span data-tr-field="asset_count">720</span>+ assets has no single trade to crowd'
  );
}

// R3 — CTA href rewrites per architect-ratified URL table.
function applyHowItWorksCTAs(html) {
  // 1. Hero + Bottom-CTA "Try Free in Claude" buttons (api.algovault.com/mcp → /#quickstart)
  html = html.replace(
    /href="https:\/\/api\.algovault\.com\/mcp"/g,
    'href="https://algovault.com/#quickstart"'
  );
  // 2. Hero "View Live Track Record" CTA — /track-record → absolute URL
  // NOTE: must be specific to NOT touch /track-record in BFEyebrow link text elsewhere.
  // Anchor on the PillCTA pattern (textContent "View Live Track Record" + href).
  html = html.replace(
    /href="\/track-record"/g,
    'href="https://algovault.com/track-record"'
  );
  // 3. Agents section "Read the integration docs" — /docs.html → absolute URL
  html = html.replace(
    /href="\/docs\.html"/g,
    'href="https://algovault.com/docs.html"'
  );
  // 4. Verify section "Verify any call" — /verify → absolute URL
  html = html.replace(
    /href="\/verify"/g,
    'href="https://algovault.com/verify"'
  );
  // 5. Build-vs-buy "Start free — 100 calls/mo" — /signup → /#quickstart
  html = html.replace(
    /href="\/signup"/g,
    'href="https://algovault.com/#quickstart"'
  );
  // 6 + 7: Telegram + Basescan hrefs are already correct — KEEP.
  return html;
}

// R6 — External-link discipline. Every <a> with an external https:// href (NOT
// algovault.com / api.algovault.com / basescan.org-as-existing) gets
// target="_blank" rel="noopener noreferrer" if missing.
function applyHowItWorksExternalLinkRel(html) {
  // Find <a> tags with external https:// hrefs. Algovault domains are internal.
  // Replace patterns that don't already have target+rel.
  return html.replace(
    /<a([^>]*?\s)href="https:\/\/((?!algovault\.com|api\.algovault\.com)[^"]+)"([^>]*)>/g,
    (match, before, host, after) => {
      // Skip if target+rel already present in either before or after
      if (/target=|rel=/i.test(before + after)) return match;
      return `<a${before}href="https://${host}"${after} target="_blank" rel="noopener noreferrer">`;
    }
  );
}

// DESIGN-HOW-IT-WORKS-FF-1 (2026-05-14): FlywheelSection client-side hydration.
// JSX uses `useState` + `React.useEffect` + `setInterval` to cycle the active step every
// 1600ms (lines 541-545 in v1-howitworks.jsx). SSR renders `active=0` permanently;
// useEffect never fires without React hydration. Mr.1 directive: make the looping
// flywheel animation actually play on the deployed page.
//
// Strategy: rewrite the 4 SSR-rendered cards per artboard with class-based markup
// (`.fw-card`, `.fw-active`) + inject CSS that styles each state + inject a JS
// controller that runs setInterval(1600ms) toggling `.fw-active` on the matching
// `[data-fw-step="N"]` card. Keyframes (fw-pulse, fw-shimmer, fw-dot-pulse,
// fw-progress, fw-orbit) are already in the JSX-emitted `<style>` block — we just
// reference them from the new CSS class rules.
//
// cwOrder = [0, 1, 3, 2] per JSX line 549: DOM positions 0/1/2/3 map to steps 01/02/04/03.
// data-fw-step is the 0-indexed step number (0..3), NOT the DOM position. JS cycles
// activeStep 0→1→2→3→0; CSS targets [data-fw-step="N"].fw-active.
const FW_STEP_LABELS = {
  '01': 'Agent calls get_trade_call',
  '02': 'Outcome lands in the dataset',
  '03': 'AOE updates model weights',
  '04': 'Next call uses the sharper model',
};

function buildFlywheelCard(stepN, mobile) {
  const stepIdx = parseInt(stepN, 10) - 1; // 0..3
  const label = FW_STEP_LABELS[stepN];
  const padding = mobile ? '20px 18px' : '24px 22px';
  const minHeight = mobile ? 120 : 140;
  const titleSize = mobile ? 16 : 18;
  // Card markup — all 4 cards uniform; active state via .fw-active class (JS-toggled).
  return `<div class="fw-card" data-fw-step="${stepIdx}" style="padding:${padding};border:1px solid oklch(0.28 0.012 265);border-radius:14px;background:oklch(0.18 0.014 265 / 0.5);position:relative;min-height:${minHeight}px;transition:border-color .35s ease, background .45s ease, transform .5s cubic-bezier(.2,.8,.2,1), opacity .35s ease, filter .35s ease;overflow:hidden;z-index:1;opacity:0.42;filter:saturate(0.6)">` +
    `<div class="fw-badge" style="position:absolute;top:0;right:0;width:38px;height:26px;border-left:1px solid oklch(0.28 0.012 265);border-bottom:1px solid oklch(0.28 0.012 265);border-radius:0 14px 0 10px;background:transparent;color:oklch(0.44 0.012 265);font-family:'JetBrains Mono', ui-monospace, monospace;font-size:11px;font-weight:700;display:grid;place-items:center;transition:background .35s, color .35s, border-color .35s">${stepN}</div>` +
    `<div class="fw-step-label" style="display:inline-flex;align-items:center;gap:10px;font-family:'JetBrains Mono', ui-monospace, monospace;font-size:11px;color:oklch(0.44 0.012 265);letter-spacing:0.1em">` +
      `<span class="fw-step-dot" style="width:8px;height:8px;border-radius:50%;background:oklch(0.34 0.012 265);display:inline-block"></span>` +
      `STEP ${stepN}` +
    `</div>` +
    `<div class="fw-title" style="margin-top:14px;font-family:'Inter Tight', 'Inter', system-ui, sans-serif;font-size:${titleSize}px;color:oklch(0.78 0.008 265);line-height:1.3;letter-spacing:-0.012em;font-weight:500;transition:color .3s">${label}</div>` +
    `<div class="fw-progress-bar" style="position:absolute;left:0;right:0;bottom:0;height:3px;background:oklch(0.24 0.012 265 / 0.6);overflow:hidden">` +
      `<div class="fw-progress-fill" style="height:100%;background:linear-gradient(90deg, #5BEEB3, oklch(0.92 0.12 170));box-shadow:0 0 12px #5BEEB3;width:0%"></div>` +
    `</div>` +
    `<div class="fw-shimmer" style="position:absolute;inset:0;pointer-events:none;background:linear-gradient(120deg, transparent 30%, oklch(1 0 0 / 0.12) 50%, transparent 70%);opacity:0;transform:translateX(-110%)"></div>` +
  `</div>`;
}

// CSS additions to layer on top of the existing JSX-emitted keyframes block
// (fw-pulse / fw-shimmer / fw-dot-pulse / fw-progress / fw-orbit are already defined).
const FLYWHEEL_CSS = `<style>
.fw-card.fw-active {
  border-color: #5BEEB3 !important;
  background: linear-gradient(180deg, oklch(0.26 0.08 170 / 0.55), oklch(0.2 0.05 170 / 0.4)) !important;
  transform: translateY(-4px) scale(1.035);
  opacity: 1 !important;
  filter: none !important;
  z-index: 2 !important;
  animation: fw-pulse 1.6s ease-out 1;
}
.fw-card.fw-active .fw-badge {
  background: #5BEEB3 !important;
  color: #0a1813 !important;
  border-left-color: #5BEEB3 !important;
  border-bottom-color: #5BEEB3 !important;
}
.fw-card.fw-active .fw-step-label { color: #5BEEB3 !important; }
.fw-card.fw-active .fw-step-dot {
  background: #5BEEB3 !important;
  box-shadow: 0 0 12px #5BEEB3, 0 0 0 4px oklch(0.32 0.08 170 / 0.35) !important;
  animation: fw-dot-pulse 1.2s ease-in-out infinite;
}
.fw-card.fw-active .fw-title {
  color: oklch(0.97 0.005 265) !important;
  font-weight: 600 !important;
}
.fw-card.fw-active .fw-progress-fill { animation: fw-progress 1.6s linear forwards; }
.fw-card.fw-active .fw-shimmer {
  opacity: 1 !important;
  animation: fw-shimmer 1.2s ease-out 1 forwards;
}
</style>`;

// JS controller — DOMContentLoaded, finds each flywheel grid, cycles activeStep 0→3 every 1600ms.
// Each grid is identified by data-fw-grid attribute on the parent <div> (post-render injected).
const FLYWHEEL_JS = `<script>
(function fwInit(){
  function setup() {
    var grids = document.querySelectorAll('[data-fw-grid]');
    if (!grids.length) return;
    grids.forEach(function(grid){
      var cards = grid.querySelectorAll('[data-fw-step]');
      if (cards.length !== 4) return;
      var activeStep = 0;
      function refresh() {
        cards.forEach(function(card){
          var step = parseInt(card.getAttribute('data-fw-step'), 10);
          var isActive = step === activeStep;
          if (isActive) {
            card.classList.add('fw-active');
            // Re-trigger one-shot animations (shimmer + pulse + progress) by clone-swap
            // of the elements bearing the animation.
            ['fw-shimmer', 'fw-progress-fill'].forEach(function(cls){
              var el = card.querySelector('.' + cls);
              if (el) {
                var twin = el.cloneNode(true);
                el.parentNode.replaceChild(twin, el);
              }
            });
            // Re-trigger card-level fw-pulse animation
            card.style.animation = 'none';
            void card.offsetWidth;
            card.style.animation = '';
          } else {
            card.classList.remove('fw-active');
          }
        });
      }
      refresh();
      setInterval(function(){
        activeStep = (activeStep + 1) % 4;
        refresh();
      }, 1600);
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();
</script>`;

// Rewrite all 4 cards in EACH artboard's flywheel grid + tag parent grid with data-fw-grid.
// Anchor: the 4 cards in DOM order (cwOrder = [0,1,3,2] → steps 01,02,04,03). Each card is a
// <div> with a specific padding signature (24px 22px desktop / 20px 18px mobile) containing
// "STEP <!-- -->NN". The parent grid is the <div style="display:grid;grid-template-columns:1fr 1fr;..."
// that contains these 4 cards + the optional LOOP marker (desktop only).
function applyHowItWorksFlywheelHydration(html, isDesktop) {
  // Tag the parent grid wrapper by anchoring on the first card's STEP 01.
  // The grid wrapper is at JSX line 583: <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;position:relative">
  // (mobile sets gap differently — but JSX gap:18 either way per the JSX. Let me anchor on the literal style.)
  const gridStyleDesktop = 'display:grid;grid-template-columns:1fr 1fr;gap:18px;position:relative';
  const gridStyleMobile = gridStyleDesktop; // same — JSX uses gap:18 in both modes for the flywheel grid
  const gridStyle = isDesktop ? gridStyleDesktop : gridStyleMobile;

  // Find the parent grid by searching for the literal opening
  const gridOpenMarker = `<div style="${gridStyle}">`;
  const gridStartIdx = html.indexOf(gridOpenMarker);
  if (gridStartIdx < 0) return html; // grid not found (silent skip — fallback to SSR cards)

  // Walk forward to find balanced </div> for this grid
  let depth = 1;
  let pos = gridStartIdx + gridOpenMarker.length;
  while (pos < html.length && depth > 0) {
    if (html.slice(pos, pos + 5) === '<div ' || html.slice(pos, pos + 5) === '<div>') {
      depth++;
      pos += 5;
    } else if (html.slice(pos, pos + 6) === '</div>') {
      depth--;
      pos += 6;
    } else {
      pos++;
    }
  }
  const gridEnd = pos;
  const gridInner = html.slice(gridStartIdx + gridOpenMarker.length, gridEnd - 6);

  // Determine if this grid contains a LOOP center marker (desktop only)
  const hasLoopMarker = gridInner.includes('LOOP</div>');
  // Capture the LOOP marker block if present (anchor on the unique outermost LOOP wrapper)
  let loopBlock = '';
  if (hasLoopMarker) {
    // The LOOP marker is the LAST child div inside the grid (a position:absolute centered overlay).
    // Find it by walking back from the LOOP text to its enclosing div.
    const loopIdx = gridInner.indexOf('LOOP</div>');
    // Walk back to find <div style="position:absolute;left:50%;top:50%;
    let lp = loopIdx;
    while (lp > 0) {
      if (gridInner.slice(lp, lp + 5) === '<div ') {
        const snip = gridInner.slice(lp, lp + 200);
        if (snip.includes('position:absolute;left:50%;top:50%')) break;
      }
      lp--;
    }
    if (lp > 0) {
      // Walk forward to balanced </div> for the LOOP wrapper
      let d = 1, q = lp + 5;
      while (q < gridInner.length && d > 0) {
        if (gridInner.slice(q, q + 5) === '<div ' || gridInner.slice(q, q + 5) === '<div>') { d++; q += 5; }
        else if (gridInner.slice(q, q + 6) === '</div>') { d--; q += 6; }
        else q++;
      }
      loopBlock = gridInner.slice(lp, q);
    }
  }

  // Build the new grid content: 4 cards (in cwOrder DOM positions: 01, 02, 04, 03) + LOOP if applicable
  const newCards = ['01', '02', '04', '03'].map(n => buildFlywheelCard(n, !isDesktop)).join('');
  const newGridInner = newCards + loopBlock;

  // Splice in: wrap with data-fw-grid attribute on the grid div
  const newGridOpen = `<div data-fw-grid="${isDesktop ? 'desktop' : 'mobile'}" style="${gridStyle}">`;
  return html.slice(0, gridStartIdx) + newGridOpen + newGridInner + '</div>' + html.slice(gridEnd);
}

// FF-1 (2026-05-13) carry-forward: Mr.1 mandate — public-facing prose uses "call"/"calls",
// never "signal"/"signals". EXCLUSIONS preserved: CSS class `signal-id-input` (DOM
// querySelector seam), npm package literal `crypto-quant-signal-mcp` (package name).
// Targets user-visible prose only — preserves identifier strings per the
// global-string-replacement-architect-ratified-triage discipline.
function applyHowItWorksSignalToCall(html) {
  // VerifySection lead text "Paste any signal ID into the verify form..."
  html = html.replaceAll('Paste any signal ID into the verify form', 'Paste any call ID into the verify form');
  // Input placeholder "Paste signal ID (sig_…)" → "Paste call ID (sig_…)" — keep "sig_" hash prefix
  html = html.replaceAll('placeholder="Paste signal ID (sig_…)"', 'placeholder="Paste call ID (sig_…)"');
  // Status idle prompt "idle — paste a signal id" → "idle — paste a call id"
  html = html.replaceAll('idle — paste a signal id', 'idle — paste a call id');
  // FAQ Q2 wording "uses your signals?" → "uses your calls?"
  html = html.replaceAll('uses your signals?', 'uses your calls?');
  return html;
}

// React 18 renderToString escapes ASCII apostrophes in text content as &#x27; for SSR
// safety. For SEO + test-grep portability, decode them back to literal apostrophes
// (browsers render both identically; grep / curl / canary tests prefer literal chars).
// Safe scope: text content only — attribute values use the same encoding but that's
// also harmless since browsers normalize. Decoding globally is fine here.
function normalizeApostrophes(html) {
  return html.replace(/&#x27;/g, "'");
}

// DESIGN-HOW-IT-WORKS-FF-3 (2026-05-15): Mr.1 directive — swap HeroDiagram chips from
// 16×16 colored-text badges (BN/HL/BY/OK/BG monogram on tone bg) to 32×32 logo tiles
// matching the landing-page hero exactly (same shape + size + dark bg as the V0Diagram
// chips processed via w7HeroDiagramChipsToLogos). Inner image 26×26 with object-fit:contain.
// Also widens the chip wrapper from 110→132 (desktop) to fit "Hyperliquid" alongside the
// larger badge; mobile keeps 84px width (renders 2-letter code, not full name).
// Logo assets: landing/_design/logos/{binance,bybit,hyperliquid,okx,bitget}.png — already
// shipped via deploy.yml's `cp -r landing/_design/*` block (no new asset additions).
function applyHowItWorksHeroChipsToLogos(html) {
  const logoMap = {
    'BN': { src: '/_design/logos/binance.png',     alt: 'Binance logo' },
    'HL': { src: '/_design/logos/hyperliquid.png', alt: 'Hyperliquid logo' },
    'BY': { src: '/_design/logos/bybit.png',       alt: 'Bybit logo' },
    'OK': { src: '/_design/logos/okx.png',         alt: 'OKX logo' },
    'BG': { src: '/_design/logos/bitget.png',      alt: 'Bitget logo' },
  };
  // 1. Swap the inner colored 16×16 badge → 32×32 dark tile with logo image
  //    Anchor on the exact rendered span markup (5 chips × 2 artboards = 10 hits).
  html = html.replace(
    /<span style="width:16px;height:16px;border-radius:4px;background:#[0-9A-Fa-f]{6};color:#0a0a0a;display:grid;place-items:center;font-weight:700;font-size:9px">(BN|HL|BY|OK|BG)<\/span>/g,
    (match, code) => {
      const cfg = logoMap[code];
      if (!cfg) return match;
      // Match landing-page chip pattern: 32×32 outer (rounded 7px, dark bg, thin border),
      // 26×26 inner image (object-fit:contain, 2px padding) — same dimensions as the
      // V0Diagram chips processed via w7HeroDiagramChipsToLogos.
      return `<span style="width:32px;height:32px;border-radius:7px;background:oklch(0.13 0.012 265);border:1px solid oklch(0.34 0.012 265);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0">` +
        `<img src="${cfg.src}" alt="${cfg.alt}" style="width:26px;height:26px;object-fit:contain;padding:2px">` +
      `</span>`;
    }
  );
  // 2. Widen the chip wrapper from width:110 → 132 on desktop to fit "Hyperliquid"
  //    alongside the larger 32×32 badge. Mobile width:84 stays (renders 2-letter code).
  //    Anchor on the unique JSX-rendered desktop chip wrapper signature: the desktop chips
  //    use width:110px (mobile uses 84px). Replace `;width:110px` literally — appears 5×
  //    only in the HeroDiagram chips (other 110px occurrences would not have this exact
  //    trailing form). Audit confirmed 5 hits = 5 desktop chips.
  html = html.replaceAll(';color:oklch(0.78 0.008 265);width:110px', ';color:oklch(0.78 0.008 265);width:132px');
  return html;
}

// Strip mobile-artboard duplicate section IDs (HTML id-uniqueness — same pattern as
// DESIGN-W7-FF + DESIGN-W9 mobile-id strip). Only the HeroSection in v1-howitworks.jsx
// has an id (`id="how-it-works"` at line 366); all other sections use data-screen-label
// instead of id.
function stripHowItWorksMobileSectionIds(html) {
  return html.replace(/<section id="how-it-works"/g, '<section');
}

// Wrap desktop + mobile artboards in lp-howit-{desktop,mobile} divs.
// @media swap CSS is in HOW_IT_WORKS_HEAD_AND_NAV <style> block.
function wrapHowItWorksDualRender(desktopHtml, mobileHtml) {
  return `<main class="how-it-works-main">\n` +
    `<div class="lp-howit-desktop">${desktopHtml}</div>\n` +
    `<div class="lp-howit-mobile">${mobileHtml}</div>\n` +
    `</main>\n`;
}

// Canonical Footer matching landing/index.html exactly. R4: Mr.1 directive "use the
// same footer for all pages". Two variants (desktop row-flex, mobile column-flex) wrapped
// in .lp-howit-{desktop,mobile} for @media swap.
// FOOTER-UNIFY-W1: single-source brand footer in the how-it-works dual-render artboards
// (was two inline literal copies → drift; how-it-works now also carries the Follow badge +
// Refer&Earn via the canonical SoT). The lp-howit-{desktop,mobile} media-swap wrappers stay.
const HOW_IT_WORKS_FOOTER_HTML = `<div class="lp-howit-desktop">${renderBrandFooter('desktop')}</div>
<div class="lp-howit-mobile">${renderBrandFooter('mobile')}</div>`;

// Canonical chrome contract head + nav. Mirrors VERIFY_HEAD_AND_NAV with /how-it-works-specific
// title, description, canonical, and `How it works` active-link.
// data-algovault-jsonld blocks are stripped (generate_jsonld.mjs injects them via its own pass).
const HOW_IT_WORKS_HEAD_AND_NAV = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>How AlgoVault Works — The Trading Model API for AI Agents</title>
<meta name="description" content="AlgoVault is a self-tuning quant ML model served as an MCP API. One call returns a composite verdict — direction, confidence, regime — across 15 perp venues. Every call Merkle-anchored on Base L2.">
<meta name="last-updated" content="2026-05-14">
<link rel="canonical" href="https://algovault.com/how-it-works">
<link rel="icon" type="image/png" href="/logo.png">
<meta property="og:title" content="How AlgoVault Works — The Trading Model API">
<meta property="og:description" content="A self-tuning quant ML model with a published track record. One MCP call returns a composite verdict — direction, confidence, regime — Merkle-anchored on Base L2.">
<meta property="og:type" content="article">
<meta property="og:url" content="https://algovault.com/how-it-works">
<meta property="og:image" content="https://algovault.com/logo.png">
<meta property="og:site_name" content="AlgoVault Labs">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="How AlgoVault Works — The Trading Model API">
<meta name="twitter:description" content="A self-tuning quant ML model with a published track record. One MCP call returns a composite verdict — Merkle-anchored on Base L2.">
<meta name="twitter:image" content="https://algovault.com/logo.png">
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
  body { background: #0d1815; color: #d1d5db; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  /* DESIGN-HOW-IT-WORKS-W1 dual-render @media swap (lp-howit-{desktop,mobile}). */
  @media (max-width: 767px) { .lp-howit-desktop { display: none !important; } }
  @media (min-width: 768px) { .lp-howit-mobile { display: none !important; } }
</style>
<!-- ANALYTICS:START -->
<!-- ANALYTICS:END -->
<!-- track-record-proxy.js hydrates [data-tr-field] spans from /api/performance-public -->
<script defer src="/js/track-record-proxy.js"></script>
</head>
<body class="min-h-screen">

<!-- Cross-page sticky nav (AlgoVault Labs canonical) — preserved across landing pages -->
<nav class="fixed top-0 w-full z-50 border-b border-white/5" style="background:rgba(6,10,20,0.85);backdrop-filter:blur(12px)">
  <div class="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
    <div class="flex items-center gap-2.5">
      <a href="/" class="flex items-center gap-2.5">
        <img src="/logo.png" alt="AlgoVault Logo" class="w-7 h-7 rounded-md">
        <span class="text-white font-semibold text-sm">AlgoVault Labs</span>
      </a>
    </div>
    <div class="hidden sm:flex items-center gap-6 text-sm text-gray-400">
      <a href="/track-record" class="hover:text-white transition">Track Record</a>
      <a href="/how-it-works" class="text-mint-400 font-medium" aria-current="page">How it works</a>
      <a href="/#pricing" class="hover:text-white transition">Pricing</a>
      <a href="/integrations" class="hover:text-white transition">Integrations</a>
      <a href="/skills" class="hover:text-white transition">Skills</a>
      <a href="/docs.html" class="hover:text-white transition">Docs</a>
      <a href="/verify" class="hover:text-white transition">Verify</a>
      <a href="https://api.algovault.com/account" class="hover:text-white transition">Account</a>
      <a href="https://api.algovault.com/welcome" class="px-3 py-1 bg-mint-500/15 border border-mint-500/30 text-mint-400 hover:bg-mint-500/25 rounded-full text-xs font-semibold transition">Signup</a>
    </div>
  </div>
</nav>
<div style="position:relative;z-index:1;padding-top:56px">
`;

// Assemble full HTML document.
// FF-1 (2026-05-14): append FLYWHEEL_CSS to head + FLYWHEEL_JS at end of body for
// client-side flywheel cycling animation (Mr.1 directive).
function buildHowItWorksHtmlDocument(bodyContent) {
  return HOW_IT_WORKS_HEAD_AND_NAV.replace('</head>', FLYWHEEL_CSS + '\n</head>') +
    bodyContent +
    '\n</div>\n' +
    HOW_IT_WORKS_FOOTER_HTML +
    '\n' + FLYWHEEL_JS +
    '\n</body>\n</html>\n';
}

// Aggregate post-render overrides for a single artboard.
function applyHowItWorksOverrides(html, isDesktop) {
  html = stripHowItWorksJsxNav(html);          // R5: drop JSX Nav (canonical replaces it)
  html = stripHowItWorksJsxFooter(html);       // R4: drop JSX Footer (canonical replaces it)
  html = applyHowItWorksGroupAHeroTicker(html);// R2.A: 4 hero ticker live-binds
  html = applyHowItWorksGroupBBatch(html);     // R2.B: "Batch 34" → merkle_batch_count
  html = applyHowItWorksGroupCWhatIs(html);    // R2.C: WhatIsSection "720+ assets. 11 timeframes."
  html = applyHowItWorksGroupCOnChain(html);   // R2.C-extra: WhatIs on-chain card "33+ Merkle batches" + signal→call
  html = applyHowItWorksGroupDBuildVsBuy(html);// R2.D: BuildVsBuy buy-column rows
  html = applyHowItWorksGroupEFaqA2(html);     // R2.E: FAQ A2 "across 720+ assets"
  html = applyHowItWorksCTAs(html);            // R3: CTA href rewrites
  html = applyHowItWorksSignalToCall(html);    // FF-1 carry-forward: public-facing prose signal→call
  html = applyHowItWorksHeroChipsToLogos(html);// FF-3 (2026-05-15): hero chips 16×16 monogram → 32×32 logo tile (matches landing)
  html = applyHowItWorksFlywheelHydration(html, isDesktop); // FF-1 (2026-05-14): client-side flywheel cycling
  html = applyHowItWorksExternalLinkRel(html); // R6: external-link rel discipline
  html = normalizeApostrophes(html);           // React-SSR &#x27; → ' for SEO + test-grep portability
  if (!isDesktop) {
    html = stripHowItWorksMobileSectionIds(html);  // dual-render id-uniqueness
  }
  return html;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.target || 'belowfold';
  const mobile = args.mobile === 'true';
  const out = args.out;

  if (!['belowfold', 'landing-rest', 'hero', 'verify', 'how-it-works'].includes(target)) {
    console.error(`[render-jsx-static] invalid --target=${target} (expected belowfold|landing-rest|hero|verify|how-it-works)`);
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
      // LANDING-SECTION-REORDER-W1: CoreCapabilities REMOVED from the page; WhenToUse + VsRawAPIs are
      // now rendered into the merged 'landing-rest' sequence. This 'belowfold' target is retained but
      // DORMANT for the homepage (lp-belowfold artboard removed). Debt: OPS-LANDING-JSX-SOT-CONSOLIDATE-W1.
      const wt = renderToString(React.createElement(exports.WhenToUse, { mobile }));
      const vs = renderToString(React.createElement(exports.VsRawAPIs, { mobile }));
      html = wt + vs;
    } else if (target === 'landing-rest') {
      const srcRaw = await readFile(path.join(VAULT_DESIGN, 'v1-landing-rest.jsx'), 'utf-8');
      const src = patchLandingRest(srcRaw);
      const exports = await evalJsxSrc(
        src,
        path.join(VAULT_DESIGN, 'v1-landing-rest.jsx'),
        [
          'AlgoVaultLandingRest', 'TryIn30', 'TradFiCallout', 'ThreeTools', 'UseCases', 'LiveVerdict',
          'LiveTrackRecord', 'TamperProof', 'TrustBand', 'SimplePricing', 'ForDevelopers', 'FAQ', 'LandingFooter',
          'LRBlock', 'LREyebrow', 'LRH2', 'LRLead', 'Pill', 'Check', 'Bullet', 'FAQItem',
        ]
      );
      // LANDING-SECTION-REORDER-W1: render the 2 moved belowfold sections (WhenToUse + VsRawAPIs) from
      // v1-belowfold.jsx into the merged sequence (positions 7-8, after Pricing). JSX files stay separate;
      // this render concatenation is the canonical merged-order SoT. Debt: OPS-LANDING-JSX-SOT-CONSOLIDATE-W1.
      const bfSrc = patchBelowFold(await readFile(path.join(VAULT_DESIGN, 'v1-belowfold.jsx'), 'utf-8'));
      const bfExports = await evalJsxSrc(bfSrc, path.join(VAULT_DESIGN, 'v1-belowfold.jsx'), ['WhenToUse', 'VsRawAPIs', 'BFIcon', 'BFEyebrow', 'BFH2', 'BFSection']);
      const wt = renderToString(React.createElement(bfExports.WhenToUse, { mobile }));
      const vs = renderToString(React.createElement(bfExports.VsRawAPIs, { mobile }));
      // Render in spec order, SKIP TradFiCallout (architect mandate Q-W10 spec rule 10).
      const try30 = preserveQuickstartAnchor(renderToString(React.createElement(exports.TryIn30, { mobile })));
      // LANDING-SECTION-REORDER-W1: ThreeTools ("3 tools, One verdict.") REMOVED from the page (not rendered).
      const uc = injectUseCasesLogos(stripUseCasesDate(renderToString(React.createElement(exports.UseCases, { mobile }))));
      // P2-LANDING-VERDICT-CARD-W1: styled verdict-with-receipts example card. Uses
      // data-tr-field directly in JSX (TrustBand pattern) → no post-render injector.
      const lv = renderToString(React.createElement(exports.LiveVerdict, { mobile }));
      const ltr = injectLiveDataLiveTrack(renderToString(React.createElement(exports.LiveTrackRecord, { mobile })));
      const tp = renderToString(React.createElement(exports.TamperProof, { mobile }));
      // LANDING-CONVERSION-TRUST-W1: additive trust band between TamperProof and pricing.
      const tb = renderToString(React.createElement(exports.TrustBand, { mobile }));
      // WEBSITE-X402-SURFACING-W1 (2026-06-08): restored the x402 5th pricing card —
      // the PRICING-X402-CARD-W1 deferral is fulfilled (x402 is LIVE + CDP-Bazaar-listed).
      // filterX402Tier + adjustPricingGridCols RETIRED from the chain so the 5th card
      // ships and the grid stays 5-col (matches the JSX SoT's repeat(5, 1fr)).
      const sp = applyTitleCase(injectLiveDataPricingTagline(
        renderToString(React.createElement(exports.SimplePricing, { mobile }))
      ));
      const fd = applyFooterUrls(renderToString(React.createElement(exports.ForDevelopers, { mobile })));
      const fq = renderToString(React.createElement(exports.FAQ, { mobile })) + FAQ_ACCORDION_JS;
      // FOOTER-UNIFY-W1: the apex footer comes whole from the single SoT (badge + absolute
      // links included), not the vault LandingFooter JSX → applyFooterUrls → injectFooterBadge.
      const ft = renderBrandFooter(mobile ? 'mobile' : 'desktop');
      // Final pass: wrap "5 exchanges" / "11 timeframes" prose literals with proxy spans (copy-consistency canary).
      html = wrapCounterLiteralsInProse(lv + ltr + tp + tb + sp + wt + vs + uc + try30 + fd + fq + ft);
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
      // LANDING-HERO-DEDENSIFY-W1 (2026-06-22): the right-panel 4-stat row (PFE WR / Venues /
      // Timeframes / Total Trade Calls) was removed from the hero to de-densify. The two passes
      // that rewrote+live-bound that row (w7HeroP50ToPfeWr + w7HeroFourStatLiveBinds) are now
      // no-ops on the new JSX and are intentionally NOT called; pfe_wr/exchange_count/
      // timeframe_count/call_count still live-bind via the proof line + diagram footer.
      raw = w7HeroDiagramFooter(raw);              // Q-W7-4 footer "5 venues integrated · 5 featured" live-bind
      raw = w7HeroNavVersion(raw, version);        // Q-W7-3 nav v1.x shipped
      raw = w7HeroDiagramChipsToLogos(raw);        // W6 Q-W7 carry-forward (5 SVG <image> logos in V0Diagram chips, Mr.1 fix-forward: fill chip)
      raw = w7HeroCallStreamLiveBind(raw);         // Mr.1 fix-forward: V1Feed FEED_BASE → live /api/recent-calls?limit=6 poller
      raw = w7HeroHideFlowDiagramLabel(raw);       // Mr.1 fix-forward 2026-05-11: hide "flow.diagram" placeholder-cap label
      raw = w7HeroArtboardWidth(raw);              // Mr.1 fix-forward 2026-05-11: strip fixed 1440px width, allow max-width centering + top-pad to clear W3 nav
      raw = w7HeroCTAUrls(raw);                    // LANDING-HERO-CTA-TG-W1 2026-05-14: Try Free in Telegram → https://t.me/algovaultofficialbot (+target/rel); View Track Record → /track-record
      raw = w7HeroStripNav(raw);                   // strip V1Hero's nav (existing live W3 nav preserved for cross-page consistency)
      // Append vanilla-JS poller for MOST RECENT CALL (mounts to all [data-w7-recent-call] in the dual-render block)
      html = raw + W7_RECENT_CALL_POLLER_JS;
    } else if (target === 'verify') {
      // DESIGN-W9 C2 (2026-05-11): /verify canonical rebuild from verify.jsx (771 LoC, 7 components).
      // Dual-render desktop + mobile; output is a FULL HTML document (not a section fragment).
      // W4 form behavior preserved byte-identical per Q-W9-10 architect ratification.
      const srcRaw = await readFile(path.join(VAULT_TRACK_RECORD, 'verify.jsx'), 'utf-8');
      const src = patchVerifyJsx(srcRaw);
      const exports = await evalJsxSrc(
        src,
        path.join(VAULT_TRACK_RECORD, 'verify.jsx'),
        ['VerifyPage', 'VHero', 'VInput', 'VResult', 'VHowItWorks', 'VRecent', 'VFaq', 'VFooter', 'VerifyNav', 'VEyebrow', 'VPulse', 'VCard', 'VField']
      );
      // Render filled=false (VResult section gates on filled=true and renders nothing here;
      // VERIFY-DEEPLINK-W1 will reveal on ?id= URL routing).
      let desktopRaw = renderToString(React.createElement(exports.VerifyPage, { mobile: false, filled: false }));
      let mobileRaw = renderToString(React.createElement(exports.VerifyPage, { mobile: true, filled: false }));
      // Q-W9-10 preservation: W4 form primitives wired to JSX VInput shell.
      // isDesktop flag prevents dual-id collision on #signal-id + #verify-btn.
      desktopRaw = preserveVerifyW4Form(desktopRaw, true);
      mobileRaw = preserveVerifyW4Form(mobileRaw, false);
      // DESIGN-W9 C3: 5 wave-level overrides per architect ratification 2026-05-11.
      // Fix-forward 2026-05-11: isDesktop flag dedupes id="sample-ids" across dual-render.
      desktopRaw = applyVerifyC3Overrides(desktopRaw, true);
      mobileRaw = applyVerifyC3Overrides(mobileRaw, false);
      // Dual-render @media swap wrap.
      const wrapped = wrapVerifyDualRender(desktopRaw, mobileRaw);
      // Full HTML document with head + nav + body + W4 JS preserved + W9 live-bind hydration.
      // Q-W9-11 hydration order: W4_PRESERVED_JS first (verifySignal handler) then W9_LIVEBIND_JS
      // (track-record-proxy.js script tag + inline batch hydration).
      html = buildVerifyHtmlDocument(wrapped, VERIFY_W4_PRESERVED_JS + '\n' + VERIFY_W9_LIVEBIND_JS);
    } else if (target === 'how-it-works') {
      // DESIGN-HOW-IT-WORKS-W1 (2026-05-14): /how-it-works JSX-faithful rebuild from
      // v1-howitworks.jsx (1289 LoC). Dual-render desktop + mobile; output is a FULL HTML
      // document. Canonical Nav + Footer swapped in per R4+R5 (drop JSX-emitted chrome,
      // insert production chrome from landing/index.html for cross-page consistency).
      const srcRaw = await readFile(path.join(VAULT_HOW_IT_WORKS, 'v1-howitworks.jsx'), 'utf-8');
      const src = patchHowItWorks(srcRaw);
      const exports = await evalJsxSrc(
        src,
        path.join(VAULT_HOW_IT_WORKS, 'v1-howitworks.jsx'),
        ['HowItWorksPage']
      );
      let desktopRaw = renderToString(React.createElement(exports.HowItWorksPage, { mobile: false }));
      let mobileRaw = renderToString(React.createElement(exports.HowItWorksPage, { mobile: true }));
      desktopRaw = applyHowItWorksOverrides(desktopRaw, true);
      mobileRaw = applyHowItWorksOverrides(mobileRaw, false);
      const wrapped = wrapHowItWorksDualRender(desktopRaw, mobileRaw);
      html = buildHowItWorksHtmlDocument(wrapped);
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
