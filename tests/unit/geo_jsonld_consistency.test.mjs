/**
 * GEO-W1 C4 — JSON-LD consistency unit tests.
 *
 * Asserts that generate_jsonld.mjs's WRITE output meets the AC contract:
 *   - Every landing/*.html contains Product + Organization + WebSite blocks.
 *   - faq.html additionally contains FAQPage.
 *   - glossary.html additionally contains DefinedTermSet.
 *   - Product schema has populated numerical fields (no {{placeholder}} leakage).
 *   - No LITERAL: / TODO: / DEBUG: HTML-comment leakage.
 *   - No forbidden phrases (Build Rule 9 + Data Integrity Law).
 *
 * Run via:   node --test tests/unit/geo_jsonld_consistency.test.mjs
 *
 * These tests are PURE FILE READS — no network, no module load of the generator.
 * The generator's own --check canary catches drift; these tests catch shape bugs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LANDING_DIR = path.join(REPO_ROOT, 'landing');

const REQUIRED_EVERY_PAGE = ['Product', 'Organization', 'WebSite'];

async function readHtml(name) {
  return readFile(path.join(LANDING_DIR, name), 'utf-8');
}

async function listLandingHtml() {
  const all = await readdir(LANDING_DIR);
  return all.filter(f => f.endsWith('.html')).sort();
}

function findManagedBlock(html, name) {
  const pattern = new RegExp(
    `<script type="application/ld\\+json" data-algovault-jsonld="${name}">\\s*([\\s\\S]*?)\\s*</script>`
  );
  const m = html.match(pattern);
  return m ? m[1] : null;
}

test('every landing/*.html contains Product + Organization + WebSite JSON-LD', async () => {
  const files = await listLandingHtml();
  assert.ok(files.length >= 5, `expected >= 5 landing/*.html files, got ${files.length}`);
  for (const f of files) {
    const html = await readHtml(f);
    for (const required of REQUIRED_EVERY_PAGE) {
      const body = findManagedBlock(html, required);
      assert.ok(body, `${f} missing data-algovault-jsonld="${required}" block`);
      assert.doesNotThrow(() => JSON.parse(body), `${f} ${required} block is not valid JSON`);
    }
  }
});

test('every page also has Service + SoftwareApplication blocks (5 total managed)', async () => {
  const files = await listLandingHtml();
  for (const f of files) {
    const html = await readHtml(f);
    for (const name of ['Service', 'SoftwareApplication']) {
      const body = findManagedBlock(html, name);
      assert.ok(body, `${f} missing data-algovault-jsonld="${name}" block`);
      assert.doesNotThrow(() => JSON.parse(body), `${f} ${name} block is not valid JSON`);
    }
  }
});

test('faq.html contains FAQPage block with >= 10 mainEntity Questions', async () => {
  const html = await readHtml('faq.html');
  const m = html.match(/<script type="application\/ld\+json" data-algovault-jsonld="FAQPage">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(m, 'faq.html missing FAQPage block');
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed['@type'], 'FAQPage');
  assert.ok(Array.isArray(parsed.mainEntity), 'mainEntity not an array');
  assert.ok(parsed.mainEntity.length >= 10, `mainEntity length=${parsed.mainEntity.length} (want >= 10)`);
  for (const q of parsed.mainEntity) {
    assert.equal(q['@type'], 'Question');
    assert.ok(q.name && q.name.length > 0, 'Question.name empty');
    assert.equal(q.acceptedAnswer?.['@type'], 'Answer');
    assert.ok(q.acceptedAnswer?.text && q.acceptedAnswer.text.length > 0, 'Answer.text empty');
  }
});

test('glossary.html contains DefinedTermSet block with >= 15 hasDefinedTerm entries', async () => {
  const html = await readHtml('glossary.html');
  const m = html.match(/<script type="application\/ld\+json" data-algovault-jsonld="DefinedTermSet">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(m, 'glossary.html missing DefinedTermSet block');
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed['@type'], 'DefinedTermSet');
  assert.ok(Array.isArray(parsed.hasDefinedTerm), 'hasDefinedTerm not an array');
  assert.ok(parsed.hasDefinedTerm.length >= 15, `hasDefinedTerm length=${parsed.hasDefinedTerm.length} (want >= 15)`);
  for (const t of parsed.hasDefinedTerm) {
    assert.equal(t['@type'], 'DefinedTerm');
    assert.ok(t.name && t.name.length > 0, 'DefinedTerm.name empty');
    assert.ok(t.description && t.description.length > 0, 'DefinedTerm.description empty');
  }
});

test('Product schema has populated numerical fields (no {{placeholder}} leakage)', async () => {
  const html = await readHtml('index.html');
  const body = findManagedBlock(html, 'Product');
  assert.ok(body, 'Product block not found on index.html');
  assert.doesNotMatch(body, /\{\{[^}]+\}\}/, 'Product block contains unresolved {{placeholders}}');
  const parsed = JSON.parse(body);
  assert.ok(parsed.aggregateRating, 'Product.aggregateRating missing');
  assert.match(String(parsed.aggregateRating.ratingValue), /^\d+(\.\d+)?$/, `ratingValue not numeric: ${parsed.aggregateRating.ratingValue}`);
  assert.match(String(parsed.aggregateRating.ratingCount), /^\d+$/, `ratingCount not numeric: ${parsed.aggregateRating.ratingCount}`);
});

test('no LITERAL/TODO/DEBUG comment leakage in any landing/*.html', async () => {
  const files = await listLandingHtml();
  for (const f of files) {
    const html = await readHtml(f);
    assert.equal((html.match(/<!--\s*LITERAL:/gi) || []).length, 0, `${f} has LITERAL: HTML comment`);
    assert.equal((html.match(/<!--\s*TODO:/gi) || []).length, 0, `${f} has TODO: HTML comment`);
    assert.equal((html.match(/<!--\s*DEBUG:/gi) || []).length, 0, `${f} has DEBUG: HTML comment`);
  }
});

test('no forbidden phrases (Data Integrity Law + Build Rule 9) in any landing/*.html', async () => {
  const files = await listLandingHtml();
  // Public-facing-copy forbidden list. These match anywhere in HTML (incl. comments)
  // because LLM crawlers can read source. Comments on this codebase use "GEO-W1" /
  // "Build Rule 9" tokens and similar — those are OK; we match precise marketing-paste
  // phrasings only.
  const forbidden = [
    /\boutcome_return_pct\b/,
    /\bPhase E\b/,
    /\bArm Your Agent\b/,
    /\bWall Street Quant Brain\b/,
    /\bGets Smarter with Every Verdict\b/,
    /\bindustry-leading\b/i,
    /\bbest-in-class\b/i,
    /\bcutting-edge\b/i,
    /\brevolutionary\b/i,
  ];
  for (const f of files) {
    const html = await readHtml(f);
    for (const pat of forbidden) {
      assert.doesNotMatch(html, pat, `${f} contains forbidden phrase: ${pat}`);
    }
  }
});

test('no <PFE_WR> / <TOTAL_SIGNALS> placeholder leakage anywhere', async () => {
  const files = await listLandingHtml();
  for (const f of files) {
    const html = await readHtml(f);
    // brand-facts.md placeholder convention is <ALL_CAPS_WITH_UNDERSCORE>
    // (e.g. <PFE_WR>, <TOTAL_SIGNALS>, <EXCHANGE_COUNT>). Pattern requires at
    // least one underscore to distinguish from incidental short documentation
    // placeholders like <ID> in API doc copy-buttons.
    const matches = html.match(/<[A-Z][A-Z0-9]*_[A-Z0-9_]+>/g) || [];
    assert.equal(matches.length, 0, `${f} has unrendered placeholders: ${matches.slice(0, 3).join(', ')}`);
  }
});
