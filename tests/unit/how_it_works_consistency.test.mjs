// DESIGN-HOW-IT-WORKS-W1 (2026-05-14) — structural integrity for /how-it-works.
//
// Page is now rendered from Design/AlgoVault How it Works V1/v1-howitworks.jsx via
// scripts/render-jsx-static.mjs --target=how-it-works. Test validates:
//   R8.1+R8.2 — canonical M6 phrases verbatim
//   R8.3 — 6 data-tr-field live-binds (pfe_wr, call_count, asset_count, exchange_count,
//          timeframe_count, merkle_batch_count)
//   R8.4 — 5 CTA hrefs wired to canonical absolute URLs
//   R8.5 — forbidden phrases absent (AOE internals + Build Rule 9 + FF-1 signal-in-prose)
//   R8.6 — canonical chrome (Nav/Footer/head canonical CSS + track-record-proxy.js)
//   R8.7 — external-link rel discipline
//   + on-chain claim survival on landing/index.html (HARD GATE per W1)
//   + CoreCapabilities Self-tuning ML model card present (per W1 + FF-1)
//   + Nav "How it works" link present on every landing/*.html
//
// Static-file-shape test; no network calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HIW_PATH = path.join(REPO_ROOT, 'landing', 'how-it-works.html');
const HIW = readFileSync(HIW_PATH, 'utf-8');

// Strip HTML comments for forbidden-phrase scanning per the canonical
// comment-vs-rendered-DOM-aware-canary skill (W8 WI, promoted 5-sighting).
const HIW_NO_COMMENTS = HIW.replace(/<!--[\s\S]*?-->/g, '');

// ── R8.1+R8.2: Required canonical phrases ─────────────────────────────────────
// Per spec R8.1 hero + R8.2 substrate-frame canonical phrases.
const REQUIRED_PHRASES = [
  'How AlgoVault Works',
  'The Trading Model API',
  'Self-Tuning Quantitative Machine Learning',
  'Autonomous Optimization Engine',
  // R8.2 — substrate-frame: case-insensitive "don't train your own" covers BOTH the
  // BuildVsBuy lead "You don't train your own GPT" AND any H2 variant. JSX uses
  // "Why train your own trading model?" (FF-1 canonical form per brand-facts § M6).
  "don't train your own",
  // Hero subhead — case-insensitive
  'Built for Autonomous AI agents',
];

for (const phrase of REQUIRED_PHRASES) {
  test(`how-it-works.html contains required phrase: ${phrase}`, () => {
    assert.ok(
      HIW.toLowerCase().includes(phrase.toLowerCase()),
      `Missing required phrase: "${phrase}"`,
    );
  });
}

// ── R8.5: Forbidden phrases ──────────────────────────────────────────────────
// Public-facing prose MUST NOT contain AOE internals OR Build Rule 9 forbidden
// marketing-paste phrasings. Identifier exclusions handled separately below.
const FORBIDDEN_PHRASES = [
  'Redis',
  'DuckDB',
  'cohort',
  'regression gate',
  'retune',
  'weight tuner',
  'Phase E',
  'outcome_return_pct',
  '55.8%',
  '3,013',
  '3013 signals',
  'Quant LLM',
  'Arm Your Agent',
  'Wall Street Quant Brain',
  'Gets Smarter with Every Verdict',
  'intelligence layer',
  'industry-leading',
  'cutting-edge',
];

for (const phrase of FORBIDDEN_PHRASES) {
  test(`how-it-works.html does NOT contain forbidden phrase: ${phrase}`, () => {
    assert.ok(
      !HIW_NO_COMMENTS.toLowerCase().includes(phrase.toLowerCase()),
      `Forbidden phrase present in rendered content: "${phrase}"`,
    );
  });
}

// ── R8.5 extension: FF-1 signal/signals mandate ───────────────────────────────
// Public-facing prose uses "call"/"calls", never "signal"/"signals". EXCLUSIONS
// preserved as identifier strings: CSS class `signal-id-input`, npm package name
// `crypto-quant-signal-mcp`. Strip these identifier occurrences before the
// forbidden-phrase grep (per the global-string-replacement-architect-ratified-triage
// discipline from FF-1 WI).
test('how-it-works.html: zero "signal"/"signals" in user-facing prose (identifier exclusions preserved)', () => {
  const allowedIdentifierStrings = [
    /\bsignal-id-input\b/g,                // CSS class for DOM querySelector
    /\bcrypto-quant-signal-mcp\b/g,        // npm package name
  ];
  let stripped = HIW_NO_COMMENTS;
  for (const re of allowedIdentifierStrings) stripped = stripped.replace(re, '__ID__');
  const offenders = (stripped.match(/\bsignals?\b/gi) || []);
  assert.equal(
    offenders.length, 0,
    `"signal"/"signals" present in prose (excluding identifier strings): ${offenders.length} hits — first 5: ${offenders.slice(0, 5).join(', ')}`,
  );
});

// ── R8.3: data-tr-field live-binds (6 required) ──────────────────────────────
const REQUIRED_LIVE_BINDS = [
  'pfe_wr',
  'call_count',
  'asset_count',
  'exchange_count',
  'timeframe_count',
  'merkle_batch_count',
];
for (const field of REQUIRED_LIVE_BINDS) {
  test(`how-it-works.html has data-tr-field="${field}" live-bind`, () => {
    const re = new RegExp(`data-tr-field="${field}"`);
    assert.ok(re.test(HIW), `Missing data-tr-field="${field}" span`);
  });
}

// pfe_wr % suffix discipline (W7 ROUND 8 promoted skill).
test('pfe_wr span contains the % suffix INSIDE the span (not outside)', () => {
  const insideSpan = /<span\s+data-tr-field="pfe_wr">[^<]*%<\/span>/.test(HIW);
  const outsideSpan = /<span\s+data-tr-field="pfe_wr">[^<]*<\/span>%/.test(HIW);
  assert.ok(insideSpan, 'pfe_wr span must end with % BEFORE </span>');
  assert.ok(!outsideSpan, 'pfe_wr span must NOT have % AFTER </span> — would render as double-%');
});

// ── R8.4: CTA hrefs wired to canonical absolute URLs ──────────────────────────
test('how-it-works.html: Try Free in Claude → https://algovault.com/#quickstart (≥2)', () => {
  const matches = HIW.match(/href="https:\/\/algovault\.com\/#quickstart"/g) || [];
  assert.ok(matches.length >= 2, `Expected ≥2 quickstart CTAs, got ${matches.length}`);
});

test('how-it-works.html: View Live Track Record → https://algovault.com/track-record (≥1)', () => {
  assert.ok(/href="https:\/\/algovault\.com\/track-record"/.test(HIW),
    'Missing absolute track-record CTA');
});

test('how-it-works.html: Read the integration docs → https://algovault.com/docs.html (≥1)', () => {
  assert.ok(/href="https:\/\/algovault\.com\/docs\.html"/.test(HIW),
    'Missing absolute docs.html CTA');
});

// FF-2 (2026-05-15): Mr.1 removed VerifySection demo form. The body-level absolute
// `https://algovault.com/verify` PillCTA is gone with it. Canonical Nav's relative
// `/verify` link (in HEAD_AND_NAV constant) covers the navigation requirement —
// users still reach /verify via the top nav.
test('how-it-works.html: /verify link present in canonical Nav (Track Record dropdown — no data-loss)', () => {
  // NAV-PLATFORM-GENERATOR-W1: Verify moved off the top bar INTO the Track Record dropdown,
  // absolute href (A6). Still reachable via the nav — the no-data-loss requirement.
  assert.ok(/<a href="https:\/\/algovault\.com\/verify"[^>]*>Verify<\/a>/.test(HIW),
    'Missing /verify Nav link (Track Record dropdown)');
});

test('how-it-works.html: Try Free in Telegram → https://t.me/algovaultofficialbot (≥2)', () => {
  const matches = HIW.match(/href="https:\/\/t\.me\/algovaultofficialbot"/g) || [];
  assert.ok(matches.length >= 2, `Expected ≥2 Telegram CTAs, got ${matches.length}`);
});

// ── R8.6: Canonical chrome consistency ───────────────────────────────────────
test('how-it-works.html: head contains canonical algovault-design.css cross-origin link', () => {
  assert.ok(HIW.includes('<link rel="stylesheet" href="/_design/algovault-design.css">'),
    'Missing canonical /_design/algovault-design.css link');
});

test('how-it-works.html: head contains track-record-proxy.js (live data hydration)', () => {
  assert.ok(HIW.includes('/js/track-record-proxy.js'),
    'Missing track-record-proxy.js script tag');
});

test('how-it-works.html: canonical Nav present; active-link applied client-side by the controller', () => {
  assert.ok(/<nav class="fixed top-0 w-full z-50/.test(HIW),
    'Missing canonical Nav block');
  assert.ok(/<a href="https:\/\/algovault\.com\/how-it-works"[^>]*data-nav-link>How it works<\/a>/.test(HIW),
    'Missing How it works nav link (data-nav-link for the client-side active matcher)');
  // NAV-PLATFORM-GENERATOR-W1: the mint active-link is applied CLIENT-SIDE (byte-identical HTML
  // on every surface; the controller marks the matching link mint) — not a server-rendered class.
  assert.ok(HIW.includes("classList.add('text-mint-400','font-medium')"),
    'Missing client-side active-link controller logic');
});

test('how-it-works.html: canonical Footer present with 4 canonical links (GitHub/X/Signup/Privacy)', () => {
  assert.ok(/Built by AlgoVault Labs/.test(HIW), 'Missing footer brand block');
  assert.ok(HIW.includes('https://github.com/AlgoVaultLabs'), 'Missing GitHub link');
  assert.ok(HIW.includes('https://x.com/AlgoVaultLabs'), 'Missing X link');
  assert.ok(/<a href="https:\/\/algovault\.com\/privacy"/.test(HIW), 'Missing Privacy link');
});

// R7: no bundler-thumbnail residue
test('how-it-works.html: zero __bundler_loading / __bundler_thumbnail residue', () => {
  assert.ok(!/__bundler_loading|__bundler_thumbnail/.test(HIW),
    'Bundler scaffolding residue present');
});

// ── R8.7: External-link rel discipline ───────────────────────────────────────
test('how-it-works.html: every external https:// href has rel="noopener" (target+rel discipline)', () => {
  // Find all <a href="https://X"> where X is NOT algovault.com / api.algovault.com.
  // Each MUST have rel= containing "noopener" (per LANDING-HERO-CTA-TG-W1 W7 ROUND 8 skill).
  const externalLinks = [...HIW.matchAll(/<a\s+([^>]*?\s)?href="https:\/\/((?!algovault\.com|api\.algovault\.com)[^"]+)"([^>]*)>/g)];
  const offenders = externalLinks.filter(m => {
    const attrs = (m[1] || '') + (m[3] || '');
    return !/rel\s*=\s*"[^"]*noopener/i.test(attrs);
  });
  assert.equal(offenders.length, 0,
    `External links missing rel="noopener": ${offenders.length} — first 3 hosts: ${offenders.slice(0, 3).map(m => m[2]).join(', ')}`);
});

// ── R8 extension: 5+ JSON-LD blocks present (TechArticle + 5 GEO from generate_jsonld) ─
test('how-it-works.html: has ≥ 5 JSON-LD blocks (GEO-W1 generator + canonical chrome)', () => {
  const matches = HIW.match(/<script\s+type="application\/ld\+json"[^>]*>/g) || [];
  assert.ok(matches.length >= 5, `Expected ≥5 JSON-LD blocks, got ${matches.length}`);
});

// ── Build Rule 9 sentence-length cap (DROPPED for JSX-rendered pages) ────────
// The W1 version of this test extracted `<p>/<li>` content + sentence-split on `.!?`.
// On the W1 hand-authored HTML, this worked because each `<p>` contained at most one
// paragraph of prose. The DESIGN-W1 JSX-rendered output uses `<p>` blocks that
// frequently contain nested labels, button text, code snippets, and section primitives —
// stripping inner tags concatenates text across element boundaries, producing
// false-positive 30+ word "sentences" that aren't real prose violations.
//
// Build Rule 9 enforcement is moved to the JSX-authoring layer (Claude Design canvas
// review + Mr.1 manual review pre-merge) per the wave-design pattern. Post-render
// sentence-extraction was the wrong abstraction layer.

// ── Nav "How it works" link present on every existing landing/*.html ──────────
const NAV_LANDING_FILES = [
  'landing/index.html',
  'landing/how-it-works.html',
  'landing/docs.html',
  'landing/faq.html',
  'landing/glossary.html',
  'landing/integrations.html',
  'landing/skills.html',
  'landing/verify.html',
  // Integration sub-pages (landing/integrations/*.html) intentionally use a slimmer nav
  // (Track Record · Integrations · Docs) WITHOUT the "How it works" marketing link — all 11
  // integration pages omit it uniformly, so the canonical-nav assertion applies to top-level
  // marketing pages only. (Was: binance/bitget/bybit/okx — removed 2026-06-16.)
];
for (const rel of NAV_LANDING_FILES) {
  test(`Nav canonical "How it works" link present on ${rel}`, () => {
    const src = readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
    assert.ok(
      /<a\s+href="https:\/\/algovault\.com\/how-it-works"[^>]*>How it works<\/a>/.test(src),
      `Missing canonical Nav link "How it works" on ${rel}`,
    );
  });
}

// ── Landing/index.html: on-chain claim survival (LANDING-HOW-IT-WORKS-W1 HARD GATE) ──
test('landing/index.html: on-chain claim count ≥ 3 (Merkle/on-chain/Base L2)', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'landing/index.html'), 'utf-8');
  const stripped = src.replace(/<!--[\s\S]*?-->/g, '');
  const hits = (stripped.match(/Merkle[ -](?:verified|anchored)|on-chain|Base L2/gi) || []).length;
  assert.ok(hits >= 3, `On-chain claim count ${hits}, expected ≥3 (per Section 18 HARD GATE)`);
});

// ── Landing/index.html: CoreCapabilities Self-tuning ML model card present 2x ─
test('LANDING-SECTION-REORDER-W1: "Self-tuning ML model" card REMOVED with CoreCapabilities', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'landing/index.html'), 'utf-8');
  // SUPERSEDED BY LANDING-SECTION-REORDER-W1: the "Core capabilities" section (with the Self-tuning ML model card) was removed.
  const hits = (src.match(/Self-tuning ML model/g) || []).length;
  assert.equal(hits, 0, `Expected 0 "Self-tuning ML model" (CoreCapabilities removed), got ${hits}`);
});

test('LANDING-SECTION-REORDER-W1: CoreCapabilities subtitle REMOVED', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'landing/index.html'), 'utf-8');
  // SUPERSEDED BY LANDING-SECTION-REORDER-W1: CoreCapabilities section removed.
  const hits = (src.match(/plus the self-tuning model behind them/g) || []).length;
  assert.equal(hits, 0, `Expected 0 (CoreCapabilities subtitle removed), got ${hits}`);
});
