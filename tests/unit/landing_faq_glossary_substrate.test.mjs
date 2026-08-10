// LANDING-FAQ-GLOSSARY-SUBSTRATE-W1 (2026-05-13) — structural integrity for the
// M6 substrate-frame additions on /faq (3-Q adverse-selection rebuttal) and
// /glossary (Autonomous Optimization Engine entry).
//
// Pattern mirrors how_it_works_consistency.test.mjs (LANDING-HOW-IT-WORKS-W1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FAQ_PATH = path.join(REPO_ROOT, 'landing', 'faq.html');
const GLO_PATH = path.join(REPO_ROOT, 'landing', 'glossary.html');
const FAQ = readFileSync(FAQ_PATH, 'utf-8');
const GLO = readFileSync(GLO_PATH, 'utf-8');

// ── 1. FAQ: 3 new adverse-selection Q&As present (anchors + beat phrases) ───
const FAQ_REQUIRED_ANCHORS = [
  'id="adverse-selection-why-sell"',
  'id="alpha-decay-rebuttal"',
  'id="how-selling-strengthens-the-model"',
];
for (const anchor of FAQ_REQUIRED_ANCHORS) {
  test(`faq.html contains new article anchor: ${anchor}`, () => {
    assert.ok(FAQ.includes(anchor), `Missing anchor: ${anchor}`);
  });
}

const FAQ_BEAT_PHRASES = [
  'AlgoVault is infrastructure, not an alpha bet',
  "composite verdict isn",         // matches "composite verdict isn't" (&rsquo; or apostrophe)
  'Market depth also swamps subscriber flow',
  'every AlgoVault call adds to the outcome dataset',
  'Like OpenAI',                    // matches "Like OpenAI's API traffic improves GPT"
];
for (const phrase of FAQ_BEAT_PHRASES) {
  test(`faq.html contains M6 beat phrase: ${phrase.slice(0, 60)}`, () => {
    assert.ok(FAQ.includes(phrase), `Missing beat phrase: "${phrase}"`);
  });
}

// ── 2. Glossary: AOE entry present ──────────────────────────────────────────
test('glossary.html contains AOE anchor id="aoe"', () => {
  assert.ok(GLO.includes('id="aoe"'), 'Missing id="aoe" anchor');
});

test('glossary.html contains "Autonomous Optimization Engine" term name', () => {
  assert.ok(GLO.includes('Autonomous Optimization Engine'), 'Missing AOE term name');
});

test('glossary.html AOE entry cross-links to /how-it-works', () => {
  // Inside the AOE <article>...</article> body
  const m = GLO.match(/<article id="aoe"[\s\S]*?<\/article>/);
  assert.ok(m, 'AOE article block missing');
  assert.ok(m[0].includes('/how-it-works'), 'AOE entry missing /how-it-works cross-link');
});

test('glossary.html AOE entry cross-links to /track-record', () => {
  const m = GLO.match(/<article id="aoe"[\s\S]*?<\/article>/);
  assert.ok(m, 'AOE article block missing');
  assert.ok(m[0].includes('/track-record'), 'AOE entry missing /track-record cross-link');
});

// ── 3. FAQ cross-links to /glossary#aoe ─────────────────────────────────────
test('faq.html links to /glossary#aoe at least once', () => {
  assert.ok(/href="[^"]*\/glossary#aoe/.test(FAQ), 'FAQ missing /glossary#aoe link');
});

test('faq.html links to /how-it-works at least once (in M6 block)', () => {
  // Restrict to the M6 block to ensure the link is in the new content, not just Nav.
  const m = FAQ.match(/<article id="adverse-selection-why-sell"[\s\S]*?<article id="what-is-algovault"/);
  assert.ok(m, 'M6 FAQ block boundary not found');
  assert.ok(m[0].includes('/how-it-works'), 'M6 FAQ block missing /how-it-works link');
});

// ── 4. Forbidden M6 AOE-internals (HARD GATE) ───────────────────────────────
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
  'powerful',
  'seamless',
  'robust',
  'revolutionary',
];

for (const phrase of FORBIDDEN_PHRASES) {
  test(`faq.html does NOT contain forbidden phrase: ${phrase}`, () => {
    const stripped = FAQ.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(
      !stripped.toLowerCase().includes(phrase.toLowerCase()),
      `Forbidden phrase present in rendered content: "${phrase}"`,
    );
  });
  test(`glossary.html does NOT contain forbidden phrase: ${phrase}`, () => {
    const stripped = GLO.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(
      !stripped.toLowerCase().includes(phrase.toLowerCase()),
      `Forbidden phrase present in rendered content: "${phrase}"`,
    );
  });
}

// ── 5. JSON-LD shape — FAQPage mainEntity grew by 3, DefinedTermSet by 1 ────
test('faq.html FAQPage JSON-LD has ≥13 mainEntity items (was 10, +3 M6)', () => {
  const m = FAQ.match(/<script\s+type="application\/ld\+json"[^>]*data-algovault-jsonld="FAQPage"[^>]*>\s*([\s\S]*?)<\/script>/);
  assert.ok(m, 'FAQPage JSON-LD block not found');
  const data = JSON.parse(m[1]);
  const n = (data.mainEntity || []).length;
  assert.ok(n >= 13, `FAQPage mainEntity has ${n}, expected ≥13`);
});

test('faq.html FAQPage JSON-LD first 3 entries are the M6 beats', () => {
  const m = FAQ.match(/<script\s+type="application\/ld\+json"[^>]*data-algovault-jsonld="FAQPage"[^>]*>\s*([\s\S]*?)<\/script>/);
  const data = JSON.parse(m[1]);
  const firstThree = data.mainEntity.slice(0, 3).map((q) => q.name).join(' | ');
  assert.ok(
    firstThree.includes('why sell access') &&
      firstThree.includes('alpha decay') &&
      firstThree.includes('strengthen the model'),
    `First 3 FAQ entries don't look like M6 beats. Got: ${firstThree}`,
  );
});

// RE-BASELINED 2026-08-10 by HOLD-DEEMPHASIS-SWEEP-W1: 16 -> 15.
// The "HOLD rate" DefinedTerm was DELETED on architect ruling (Q1) — JSON-LD node + rendered
// <article> + its live span, as one unit, so structured data and rendered text cannot diverge.
// A floor is the right shape here (the set grows as terms are added) but a floor still has to be
// lowered when a term is deliberately retired, and lowering it is the honest act: leaving 16 would
// have forced someone to re-add a term nobody wants. Paired with a NEGATIVE assertion below so the
// reduction is pinned on BOTH sides — the count did not merely drop, it dropped for this reason.
test('glossary.html DefinedTermSet has ≥15 terms (was 16 before the HOLD-rate retirement)', () => {
  const m = GLO.match(/<script\s+type="application\/ld\+json"[^>]*data-algovault-jsonld="DefinedTermSet"[^>]*>\s*([\s\S]*?)<\/script>/);
  assert.ok(m, 'DefinedTermSet JSON-LD block not found');
  const data = JSON.parse(m[1]);
  const n = (data.hasDefinedTerm || []).length;
  assert.ok(n >= 15, `DefinedTermSet hasDefinedTerm has ${n}, expected ≥15`);
});

test('glossary.html carries NO "HOLD rate" term — JSON-LD and rendered, both gone', () => {
  const m = GLO.match(/<script\s+type="application\/ld\+json"[^>]*data-algovault-jsonld="DefinedTermSet"[^>]*>\s*([\s\S]*?)<\/script>/);
  const data = JSON.parse(m[1]);
  const names = (data.hasDefinedTerm || []).map((t) => t.name);
  assert.ok(!names.includes('HOLD rate'), 'HOLD rate DefinedTerm was retired — do not re-add it here');
  // The rendered half must go with it: a JSON-LD term with no article (or the reverse) is the
  // structured-data/rendered divergence the architect ruled against.
  assert.ok(!/id="hold-rate"/.test(GLO), 'rendered HOLD rate <article> must be gone too');
  assert.ok(!/data-tr-field="hold_rate"/.test(GLO), 'the live hold_rate span must be gone too');
});

test('glossary.html DefinedTermSet first entry is AOE (alphabetical "A")', () => {
  const m = GLO.match(/<script\s+type="application\/ld\+json"[^>]*data-algovault-jsonld="DefinedTermSet"[^>]*>\s*([\s\S]*?)<\/script>/);
  const data = JSON.parse(m[1]);
  const first = data.hasDefinedTerm[0];
  assert.equal(first.name, 'Autonomous Optimization Engine', `First term should be AOE, got: ${first.name}`);
  assert.equal(first.alternateName, 'AOE', `AOE alternateName missing`);
});

// ── 6. data-tr-field live-bind discipline ───────────────────────────────────
test('faq.html M6 block has data-tr-field="asset_count" span for beat-2 730+ claim', () => {
  const m = FAQ.match(/<article id="alpha-decay-rebuttal"[\s\S]*?<\/article>/);
  assert.ok(m, 'alpha-decay article missing');
  assert.ok(/data-tr-field="asset_count"/.test(m[0]), 'Missing asset_count live-bind in beat-2 paragraph');
});

test('glossary.html AOE entry has data-tr-field="pfe_wr" span', () => {
  const m = GLO.match(/<article id="aoe"[\s\S]*?<\/article>/);
  assert.ok(m, 'AOE article missing');
  assert.ok(/data-tr-field="pfe_wr"/.test(m[0]), 'Missing pfe_wr live-bind in AOE entry');
});

// data-tr-field-percent-suffix-discipline (W7 ROUND 8 promoted skill):
// pfe_wr span content MUST include the % suffix INSIDE the span.
test('glossary.html AOE pfe_wr span has % INSIDE the span (not outside)', () => {
  const m = GLO.match(/<article id="aoe"[\s\S]*?<\/article>/);
  const insideSpan = /<span\s+data-tr-field="pfe_wr">[^<]*%<\/span>/.test(m[0]);
  const outsideSpan = /<span\s+data-tr-field="pfe_wr">[^<]*<\/span>%/.test(m[0]);
  assert.ok(insideSpan, 'pfe_wr span must end with % BEFORE </span>');
  assert.ok(!outsideSpan, 'pfe_wr span must NOT have % AFTER </span> — would render double-%');
});

// ── 7. Build Rule 9 sentence-length sanity (≤30 words/sentence on M6 prose) ─
function offendersIn(html, articleAnchors) {
  // Restrict scan to specific articles to avoid pre-existing offenders elsewhere.
  let offenders = [];
  for (const anchor of articleAnchors) {
    const re = new RegExp(`<article id="${anchor}"[\\s\\S]*?</article>`);
    const m = html.match(re);
    if (!m) continue;
    let block = m[0]
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<pre[\s\S]*?<\/pre>/g, '');
    const prose = [...block.matchAll(/<(p|li|h1|h2|h3)[^>]*>([\s\S]*?)<\/\1>/g)];
    for (const pm of prose) {
      const text = pm[2]
        .replace(/<[^>]+>/g, '')
        .replace(/&mdash;/g, '—').replace(/&hellip;/g, '…')
        .replace(/&rsquo;/g, "'").replace(/&ldquo;/g, '"').replace(/&rdquo;/g, '"')
        .replace(/&[a-z]+;/g, ' ')
        .trim();
      for (const sent of text.split(/(?<=[.!?])\s+/)) {
        const s = sent.trim();
        if (s.length < 4) continue;
        const wc = s.split(/\s+/).length;
        if (wc > 30) offenders.push(`[${anchor}] (${wc}w) ${s.slice(0, 100)}`);
      }
    }
  }
  return offenders;
}

test('faq.html M6 articles: 0 sentences over 30 words', () => {
  const offenders = offendersIn(FAQ, [
    'adverse-selection-why-sell',
    'alpha-decay-rebuttal',
    'how-selling-strengthens-the-model',
  ]);
  assert.equal(offenders.length, 0, `Build Rule 9 sentence-length violations:\n${offenders.join('\n')}`);
});

test('glossary.html AOE article: 0 sentences over 30 words', () => {
  const offenders = offendersIn(GLO, ['aoe']);
  assert.equal(offenders.length, 0, `Build Rule 9 sentence-length violations:\n${offenders.join('\n')}`);
});
