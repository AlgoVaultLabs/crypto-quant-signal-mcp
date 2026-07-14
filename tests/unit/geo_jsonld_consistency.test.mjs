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

// GEO-CONTENT-W1: answer/comparison pages carry their OWN JSON-LD (Article/TechArticle +
// FAQPage + Organization @id ref via the Article publisher) and are FILES_TO_SKIP'd from
// generate_jsonld, so they do NOT carry the 5 managed marketing blocks. Their JSON-LD is
// guarded by tests/unit/geo_answer_page_invariants.test.mjs instead — exempt them here.
const GEO_CONTENT_SLUGS = new Set([
  'best-mcp-servers-crypto-trading.html', 'ai-agents-crypto-trade-calls.html',
  'build-crypto-trading-agent-python.html', 'claude-crypto-trading-stack.html',
  'trade-calls-for-python-backtesting.html', 'algovault-vs-raw-indicator-tools.html',
  'build-vs-buy-trading-model.html', 'single-venue-vs-cross-venue-mcp.html',
  // GEO-CONTENT-W2
  'crewai-crypto-trade-call-tools.html', 'langchain-crypto-trade-calls.html',
  'llamaindex-quant-trading-stack.html', 'composite-cross-exchange-trade-calls.html',
  'cross-venue-funding-rate-arbitrage.html', 'crypto-market-regime-detection-api.html',
  'crypto-signal-providers-verifiable-track-record.html', 'crypto-trade-call-api-for-ai-agents.html',
  // CHANNEL-HUB-PAGES-GEO-W1: the 3 channel hub pages are how-to answer pages (own TechArticle +
  // FAQPage + Organization @id ref); excluded from the 5-managed-marketing-blocks requirement.
  'mcp.html', 'rest-api.html', 'webhooks.html',
]);
const managedPages = (files) => files.filter((f) => !GEO_CONTENT_SLUGS.has(f));

test('every landing/*.html contains Product + Organization + WebSite JSON-LD', async () => {
  const files = managedPages(await listLandingHtml());
  assert.ok(files.length >= 5, `expected >= 5 managed landing/*.html files, got ${files.length}`);
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
  const files = managedPages(await listLandingHtml());
  for (const f of files) {
    const html = await readHtml(f);
    for (const name of ['Service', 'SoftwareApplication']) {
      const body = findManagedBlock(html, name);
      assert.ok(body, `${f} missing data-algovault-jsonld="${name}" block`);
      assert.doesNotThrow(() => JSON.parse(body), `${f} ${name} block is not valid JSON`);
    }
  }
});

// ENTITY-FOOTPRINT-W1: canonical Organization @id node — full on the homepage, @id
// reference on every other page (Google 2026-04-15 sameAs guidance). entity-urls.json
// is the sameAs source; deferred (null) profiles must never leak into the rendered output.
const ORG_ID = 'https://algovault.com/#organization';

test('homepage index.html serves the FULL Organization node (@id + sameAs + name)', async () => {
  const body = findManagedBlock(await readHtml('index.html'), 'Organization');
  assert.ok(body, 'index.html missing Organization block');
  const node = JSON.parse(body);
  assert.equal(node['@id'], ORG_ID, 'homepage Organization @id mismatch');
  assert.equal(node['@type'], 'Organization', 'homepage Organization must be a full node');
  assert.ok(Array.isArray(node.sameAs) && node.sameAs.length >= 3, 'homepage Organization.sameAs must list >= 3 profiles');
  assert.ok(node.name, 'homepage Organization.name missing');
  assert.ok(node.sameAs.includes('https://github.com/AlgoVaultLabs'), 'github (strongest profile) must be in sameAs');
  assert.doesNotMatch(JSON.stringify(node.sameAs), /wikidata\.org/i, 'Wikidata stays excluded until the item exists (docs/WIKIDATA-DEFERRED.md)');
});

test('every non-homepage landing page references Organization by @id only (single canonical node)', async () => {
  const files = managedPages(await listLandingHtml()).filter(f => f !== 'index.html');
  assert.ok(files.length >= 4, `expected several non-homepage pages, got ${files.length}`);
  for (const f of files) {
    const body = findManagedBlock(await readHtml(f), 'Organization');
    assert.ok(body, `${f} missing Organization block`);
    const node = JSON.parse(body);
    assert.equal(node['@id'], ORG_ID, `${f} Organization @id mismatch`);
    assert.ok(!('name' in node), `${f} Organization must be an @id reference, not a full node`);
    assert.ok(!('sameAs' in node), `${f} Organization must not re-declare sameAs`);
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
  // OPS-JSONLD-AGGREGATERATING: the synthetic aggregateRating (PFE WR cast as a star
  // rating) was removed per Google's structured-data policy — ratings must come from
  // genuine user reviews. A real aggregateRating may return once G2 reviews accrue.
  assert.ok(!parsed.aggregateRating, 'synthetic Product.aggregateRating must be absent (real reviews only)');
  const pfe = (parsed.additionalProperty || []).find((p) => /PFE win rate/i.test(p.name));
  assert.ok(pfe && /^\d+(\.\d+)?%$/.test(pfe.value), `Product PFE win rate not populated: ${pfe && pfe.value}`);
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
  // Public-facing-copy forbidden list. STRIP HTML comments before grep per the
  // canonical `comment-vs-rendered-DOM-aware-canary` skill (W8 WI promoted at the
  // 4th confirmed sighting). HTML comments documenting which phrases are forbidden
  // (e.g. LANDING-FAQ-GLOSSARY-SUBSTRATE-W1's `<!-- NO Redis / DuckDB / regression
  // gate / retune cadence / weight tuner / cohort schema / Phase E mechanics. -->`)
  // are legitimate inline documentation, not user-facing content. LLM crawlers reading
  // raw source see the comment too, but a comment listing forbidden phrases as
  // explicit prohibitions is a different epistemic signal than a forbidden phrase
  // used as a positive claim — comment-strip lets us enforce the latter without
  // false-positives on the former.
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
    const html = (await readHtml(f)).replace(/<!--[\s\S]*?-->/g, '');
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

// OPS-DOCS-JSONLD-TOOLCOUNT-W1: the docs <head> TechArticle description enumerates the public MCP
// tool set. It is STATIC in docs-src/template.html, but build_docs INJECTS the derived clause
// (techArticleToolClause ← publicToolNames) into the __TECH_ARTICLE_TOOLS__ placeholder — so the
// count + name list can never re-hardcode (the "5 tools" bug this retires). This guards the RENDERED
// output vs the SoT; the derivation itself (mock-7th) is unit-tested in tests/docs-outline.test.ts.
// (NB: generate_jsonld.mjs does NOT render this TechArticle — it only manages the 5 data-algovault-
// jsonld marketing blocks; the docs TechArticle is the page's own, injected by build_docs.)
test('docs.html TechArticle JSON-LD tool clause === the public-tool SoT (no hardcoded count)', async () => {
  const { publicToolNames } = await import('../../dist/lib/feature-registry.js');
  const html = await readHtml('docs.html');
  const m = html.match(/<script type="application\/ld\+json">\s*(\{[\s\S]*?"@type":\s*"TechArticle"[\s\S]*?\})\s*<\/script>/);
  assert.ok(m, 'docs.html missing TechArticle JSON-LD block');
  const node = JSON.parse(m[1]);
  const names = publicToolNames();
  const clause = `${names.length} AlgoVault MCP tools (${names.join(', ')})`;
  assert.ok(
    node.description.includes(clause),
    `TechArticle must state the SoT-derived clause "${clause}"; got: ${node.description.slice(0, 140)}`,
  );
  assert.doesNotMatch(html, /\b5 AlgoVault MCP tools\b/, 'the retired hardcoded "5 AlgoVault MCP tools" must never return');
});
