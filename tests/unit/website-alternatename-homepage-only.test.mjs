/**
 * SEO-SITE-NAME-AND-PREFERRED-SOURCES-W1 R1 — the site-name signal set.
 *
 * Google resolves `algovault.com` to the BARE DOMAIN in its source-preferences tool while the
 * control `seroundtable.com` resolves to a brand name. Per Google's site-names doc (verified
 * 2026-08-27) the documented remedy is NOT to change `WebSite.name` — it is to supply
 * `alternateName` in preference order with the lowercase domain LAST, and to keep the page's
 * other naming signals consistent.
 *
 * WHY THIS TEST EXISTS. The `WebSite` node is GENERATOR-OWNED: `generate_jsonld.mjs` strips and
 * reinjects every `data-algovault-jsonld="WebSite"` block across all eleven landing pages that
 * carry one. A hand-edit to `landing/index.html` alone is wiped by the next generator WRITE and
 * nothing would notice — the block would still be present, still parse, and still pass
 * `geo_jsonld_consistency`, which asserts presence and not content. So the property under test
 * is not "index.html contains alternateName" but "the GENERATOR would still produce what is
 * committed".
 *
 * WHY IT DOES NOT RUN THE GENERATOR. `generate_jsonld.mjs` live-fetches /api/performance-public
 * and /api/merkle-batches, so its output moves every few minutes and can never be byte-compared
 * in CI — the same reason its own `--check` is deliberately NOT wired as a deploy gate. Instead
 * this re-renders the template using the live values ALREADY BAKED INTO each committed node.
 * Deterministic, offline, and it still fails the moment template and committed output disagree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripHomepageOnlyWebsiteKeys } from '../../scripts/generate_jsonld.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LANDING = path.join(REPO_ROOT, 'landing');
const HOMEPAGE = 'index.html';

const WEBSITE_RE =
  /<script type="application\/ld\+json" data-algovault-jsonld="WebSite">\n([\s\S]*?)\n<\/script>/;
/** The two live literals the generator substitutes into the WebSite description. */
const LIVE_RE = /([\d.]+)% PFE win rate across (\d+) verified calls/;

async function committedWebsiteNodes() {
  const tpl = (await readFile(path.join(LANDING, '_jsonld/website.json.template'), 'utf-8')).trimEnd();
  const files = (await readdir(LANDING)).filter((f) => f.endsWith('.html')).sort();
  const rows = [];
  for (const f of files) {
    const html = await readFile(path.join(LANDING, f), 'utf-8');
    const m = html.match(WEBSITE_RE);
    if (!m) continue;
    rows.push({ file: f, committed: m[1], tpl, html });
  }
  return rows;
}

test('every committed WebSite node is exactly what the generator would produce', async () => {
  const rows = await committedWebsiteNodes();
  // Vacuity guard — this corpus is the WORLD's (committed files), but a zero-row or
  // homepage-less read means the regex stopped matching, which is a defect in this test.
  assert.ok(rows.length >= 6, `only ${rows.length} WebSite nodes found — regex likely stale`);
  assert.equal(rows.filter((r) => r.file === HOMEPAGE).length, 1, 'exactly one home page expected');

  let home = 0;
  let subs = 0;
  for (const { file, committed, tpl } of rows) {
    const live = committed.match(LIVE_RE);
    assert.ok(live, `${file}: WebSite description lost its live-value pair`);
    let expected = tpl.replace('{{pfe_wr}}', live[1]).replace('{{total_calls}}', live[2]);
    if (file !== HOMEPAGE) expected = stripHomepageOnlyWebsiteKeys(expected);
    assert.equal(committed, expected, `${file}: committed WebSite node != generator output`);
    file === HOMEPAGE ? home++ : subs++;
  }
  assert.equal(home, 1);
  assert.ok(subs >= 5, `only ${subs} sub-pages checked`);
});

test('alternateName is HOME-PAGE-ONLY, in preference order, lowercase domain last', async () => {
  const rows = await committedWebsiteNodes();
  for (const { file, committed } of rows) {
    const node = JSON.parse(committed);
    if (file === HOMEPAGE) {
      assert.deepEqual(
        node.alternateName,
        ['AlgoVault Labs', 'algovault.com'],
        'home-page alternateName drifted',
      );
      // Google: "Specify them in order of your preference, with the most important one listed
      // first", with the lowercase domain as the explicit final backup.
      assert.equal(node.alternateName.at(-1), 'algovault.com', 'domain must be LAST');
    } else {
      assert.equal(node.alternateName, undefined, `${file} must not carry alternateName`);
    }
  }
});

test('og:site_name on the home page equals WebSite.name verbatim', async () => {
  const html = await readFile(path.join(LANDING, HOMEPAGE), 'utf-8');
  const og = html.match(/<meta property="og:site_name" content="([^"]*)">/);
  assert.ok(og, 'og:site_name missing from the home page');
  const node = JSON.parse(html.match(WEBSITE_RE)[1]);
  // It reinforces the WebSite node; it must never contradict it.
  assert.equal(og[1], node.name);
});

test('the homepage-only stripper fails LOUD when the template stops carrying the key', () => {
  // Two-way: proving it can FAIL is the point. A stripper that silently no-ops on a drifted
  // template would emit alternateName on all eleven pages with every assertion still green.
  assert.throws(
    () => stripHomepageOnlyWebsiteKeys('{\n  "@type": "WebSite",\n  "name": "AlgoVault"\n}'),
    /no longer carries the homepage-only key "alternateName"/,
  );
  const stripped = stripHomepageOnlyWebsiteKeys(
    '{\n  "name": "AlgoVault",\n  "alternateName": ["A", "b.com"],\n  "url": "x"\n}',
  );
  assert.equal(stripped, '{\n  "name": "AlgoVault",\n  "url": "x"\n}');
  JSON.parse(stripped); // the removal must leave valid JSON, not a dangling comma
});
