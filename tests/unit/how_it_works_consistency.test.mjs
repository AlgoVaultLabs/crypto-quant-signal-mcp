// LANDING-HOW-IT-WORKS-W1 (2026-05-13) — structural integrity for /how-it-works
// + Nav-link presence across every existing landing/*.html.
//
// This is a static-file-shape test; no network calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HIW_PATH = path.join(REPO_ROOT, 'landing', 'how-it-works.html');
const HIW = readFileSync(HIW_PATH, 'utf-8');

// ── 1. Required canonical phrases ────────────────────────────────────────────
const REQUIRED_PHRASES = [
  'The Trading Model API',
  'self-tuning quant ML model',
  'Autonomous Optimization Engine',
  'Like an LLM',
  "don't train your own GPT",
  // FF-1 (2026-05-13): Mr.1 changed the LEAD from "Don't train your own trading model."
  // to "Why train your own trading model?". The H2 still carries the "Don't train your
  // own trading model" phrase verbatim — both forms must remain present.
  "Don't train your own trading model",
  'Why train your own trading model',
  "Don't trust",
  'The Brain Layer for AI Trading Agents',
];

for (const phrase of REQUIRED_PHRASES) {
  test(`how-it-works.html contains required phrase: ${phrase}`, () => {
    assert.ok(
      HIW.toLowerCase().includes(phrase.toLowerCase()),
      `Missing required phrase: "${phrase}"`,
    );
  });
}

// ── 2. Forbidden phrases (Build Rule 9 + brand-facts.md M6 AOE-internals law) ─
// Match the AC line 215 list verbatim. Case-insensitive substring search.
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
  // FF-1 (2026-05-13): Mr.1 mandate — public-facing materials use "call"/"calls" only,
  // never "signal"/"signals". Identifier strings (MCP resource URIs, API routes,
  // package names) are excluded — only word "signal" in rendered prose is forbidden
  // for THIS page. landing/how-it-works.html is the first page to enforce; broader
  // MARKETING-SIGNAL-TO-CALL-W1 sweep covers other surfaces.
  'signal',
  'signals',
];

for (const phrase of FORBIDDEN_PHRASES) {
  test(`how-it-works.html does NOT contain forbidden phrase: ${phrase}`, () => {
    // Strip HTML comments before scanning — `comment-vs-rendered-DOM-aware-canary`
    // pattern from DESIGN-W8 WI (promoted to canonical). Comments documenting
    // wave history may legitimately reference forbidden literals; only rendered
    // content matters.
    const stripped = HIW.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(
      !stripped.toLowerCase().includes(phrase.toLowerCase()),
      `Forbidden phrase present in rendered content: "${phrase}"`,
    );
  });
}

// ── 3. JSON-LD blocks ────────────────────────────────────────────────────────
test('how-it-works.html has ≥2 JSON-LD blocks (TechArticle + FAQPage)', () => {
  const matches = HIW.match(/<script\s+type="application\/ld\+json"[^>]*>/g) || [];
  assert.ok(matches.length >= 2, `Expected ≥2 JSON-LD blocks, got ${matches.length}`);
});

test('how-it-works.html JSON-LD declares TechArticle', () => {
  assert.ok(/"@type"\s*:\s*"TechArticle"/.test(HIW), 'Missing @type: TechArticle');
});

test('how-it-works.html JSON-LD declares FAQPage', () => {
  assert.ok(/"@type"\s*:\s*"FAQPage"/.test(HIW), 'Missing @type: FAQPage');
});

test('how-it-works.html FAQPage has ≥3 Question entries (adverse-selection 3-beat block)', () => {
  const qMatches = HIW.match(/"@type"\s*:\s*"Question"/g) || [];
  assert.ok(qMatches.length >= 3, `Expected ≥3 Question entries, got ${qMatches.length}`);
});

// ── 4. data-tr-field live-bind spans (live-bind-data-tr-field-suffix-discipline) ─
const REQUIRED_LIVE_BINDS = ['pfe_wr', 'call_count', 'asset_count', 'merkle_batch_count'];
for (const field of REQUIRED_LIVE_BINDS) {
  test(`how-it-works.html has data-tr-field="${field}" live-bind`, () => {
    const re = new RegExp(`data-tr-field="${field}"`);
    assert.ok(re.test(HIW), `Missing data-tr-field="${field}" span`);
  });
}

// data-tr-field-percent-suffix-discipline (W7 ROUND 8 promoted skill):
// pfe_wr span content MUST include the % suffix INSIDE the span (track-record-proxy.js
// writes a fully-formatted "90.4%" value via setField; placing % OUTSIDE the span
// produces double-% on hydration).
test('pfe_wr span contains the % suffix INSIDE the span (not outside)', () => {
  const insideSpan = /<span\s+data-tr-field="pfe_wr">[^<]*%<\/span>/.test(HIW);
  const outsideSpan = /<span\s+data-tr-field="pfe_wr">[^<]*<\/span>%/.test(HIW);
  assert.ok(insideSpan, 'pfe_wr span must end with % BEFORE </span>');
  assert.ok(!outsideSpan, 'pfe_wr span must NOT have % AFTER </span> — would render as double-%');
});

// ── 5. Build Rule 9 sentence-length sanity ───────────────────────────────────
test('how-it-works.html: 0 <p>/<li> prose sentences over 30 words', () => {
  // Strip comments + script + style + pre/code blocks (code is not prose).
  let h = HIW
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<pre[\s\S]*?<\/pre>/g, '');
  const proseBlocks = [...h.matchAll(/<(p|li|h1|h2|h3)[^>]*>([\s\S]*?)<\/\1>/g)];
  const offenders = [];
  for (const m of proseBlocks) {
    const text = m[2]
      .replace(/<[^>]+>/g, '')
      .replace(/&mdash;/g, '—').replace(/&hellip;/g, '…')
      .replace(/&[a-z]+;/g, ' ')
      .trim();
    for (const sent of text.split(/(?<=[.!?])\s+/)) {
      const s = sent.trim();
      if (s.length < 4) continue;
      const wc = s.split(/\s+/).length;
      if (wc > 30) offenders.push(`(${wc}w) ${s.slice(0, 100)}`);
    }
  }
  assert.equal(offenders.length, 0, `Sentences over 30 words:\n${offenders.join('\n')}`);
});

// ── 6. Canonical Nav link "How it works" present on every existing landing/*.html ─
const NAV_LANDING_FILES = [
  'landing/index.html',
  'landing/how-it-works.html',
  'landing/docs.html',
  'landing/faq.html',
  'landing/glossary.html',
  'landing/integrations.html',
  'landing/skills.html',
  'landing/verify.html',
  'landing/integrations/binance.html',
  'landing/integrations/bitget.html',
  'landing/integrations/bybit.html',
  'landing/integrations/okx.html',
];

for (const rel of NAV_LANDING_FILES) {
  test(`Nav canonical "How it works" link present on ${rel}`, () => {
    const src = readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
    assert.ok(
      /<a\s+href="\/how-it-works"[^>]*>How it works<\/a>/.test(src),
      `Missing canonical Nav link "How it works" on ${rel}`,
    );
  });
}

// ── 7. On-chain claim survival audit on landing/index.html (HARD GATE) ───────
test('landing/index.html: on-chain claim count ≥ 3 (Merkle/on-chain/Base L2)', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'landing/index.html'), 'utf-8');
  const stripped = src.replace(/<!--[\s\S]*?-->/g, '');
  const hits = (stripped.match(/Merkle[ -](?:verified|anchored)|on-chain|Base L2/gi) || []).length;
  assert.ok(hits >= 3, `On-chain claim count ${hits}, expected ≥3 (per Section 18 HARD GATE)`);
});

// ── 8. CoreCapabilities card swap verification (Section 7 of spec) ───────────
test('landing/index.html: "Self-tuning ML model" card present 2x (desktop + mobile)', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'landing/index.html'), 'utf-8');
  const hits = (src.match(/Self-tuning ML model/g) || []).length;
  assert.equal(hits, 2, `Expected 2x "Self-tuning ML model" cards (desktop + mobile), got ${hits}`);
});

test('landing/index.html: legacy "On-chain track record" card removed', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'landing/index.html'), 'utf-8');
  const stripped = src.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(
    !/On-chain track record\./.test(stripped),
    'Legacy "On-chain track record." card copy still present in rendered content',
  );
});

test('landing/index.html: CoreCapabilities subtitle updated to "self-tuning model behind them"', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'landing/index.html'), 'utf-8');
  const hits = (src.match(/plus the self-tuning model behind them/g) || []).length;
  assert.equal(hits, 2, `Expected 2x updated subtitle (desktop + mobile), got ${hits}`);
});
