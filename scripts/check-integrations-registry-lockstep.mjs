#!/usr/bin/env node
/**
 * check-integrations-registry-lockstep.mjs — OPS-INTEGRATIONS-VENUE-PAGES-W1
 *
 * An integration page's slug has to be listed in SIX independent places or the
 * page is silently broken in a different way at each one:
 *
 *   1. its family's registry in `src/lib/integrations-data/` — the card on /integrations
 *   2. `scripts/render-integrations.mjs` list        — whether the HTML is generated
 *   3. `src/index.ts` INTEGRATION_* allow-list       — whether the route 404s
 *   4. `landing/integrations/<slug>.html`            — the artifact Express loads at boot
 *   5. `landing/sitemap.xml`                         — whether crawlers ever see it
 *   6. `landing/integrations.html` + `landing/docs.html` — generated index blocks
 *      (these are emitted from the registry by `scripts/build_landing.mjs`; a new
 *      kit entry leaves them stale until that generator is re-run)
 *
 * Every family is checked: exchanges, frameworks and MCP clients. A row with
 * `hasDedicatedPage: false` has no page, so it must appear in no list. A slug in
 * RETIRED_INTEGRATION_SLUGS must appear nowhere: the route answers it with a 301.
 *
 * Nothing previously tied these together, and they had already drifted: the
 * gemini/kraken/alpaca pages shipped in BROKER-PAIRING-CRYPTO-W1 (2026-06-05)
 * but were missing from the sitemap and from the footer-injection targets for
 * ~6 weeks — live, reachable, and invisible to search.
 *
 * This canary makes that class structurally impossible. It is a STATIC check
 * (no network, no live SoT), so it is safe to gate CI on — unlike a numbers
 * check, nothing here drifts on its own between commits.
 *
 * Usage:
 *   node scripts/check-integrations-registry-lockstep.mjs           # report
 *   node scripts/check-integrations-registry-lockstep.mjs --check   # exit 1 on drift
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Extract a single-quoted string-array literal assigned to `name`. */
function arrayLiteral(src, name) {
  // Tolerates multi-line arrays and a trailing `as const`.
  const m = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(src);
  if (!m) throw new Error(`could not locate the ${name} array literal`);
  // Comments inside the array are prose, not slugs.
  return [...m[1].replace(/\/\/.*$/gm, '').matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]);
}

/** `{ slug, dedicated }` per registry row, in file order. Each flag sits in its own slug's literal. */
function registryRows(rel) {
  return read(rel).split(/(?=\n\s+slug:\s*')/).slice(1).map((chunk) => {
    const slug = /slug:\s*'([a-z0-9-]+)'/.exec(chunk)[1];
    const flag = /hasDedicatedPage:\s*(true|false)/.exec(chunk);
    return { slug, dedicated: flag ? flag[1] === 'true' : null };
  });
}

// The keys of the one declaration the route also reads.
function retiredSlugs() {
  const m = /RETIRED_INTEGRATION_SLUGS\b[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\)/.exec(
    read('src/lib/integrations-data/retired-slugs.ts'),
  );
  if (!m) throw new Error('could not locate the RETIRED_INTEGRATION_SLUGS literal');
  return [...m[1].matchAll(/^\s*'?([a-z0-9-]+)'?:\s*\{/gm)].map((x) => x[1]);
}

// ── The sources ──
const FAMILIES = [
  { name: 'exchange', registry: 'src/lib/integrations-data/exchange-kits.ts', render: 'const EXCHANGES', route: 'const INTEGRATION_EXCHANGES' },
  { name: 'framework', registry: 'src/lib/integrations-data/ai-agents.ts', render: 'const FRAMEWORKS', route: 'const INTEGRATION_FRAMEWORKS' },
  { name: 'mcp-client', registry: 'src/lib/integrations-data/mcp-clients.ts', render: 'const MCP_CLIENTS', route: 'const INTEGRATION_MCP_CLIENTS' },
];
const renderSrc = read('scripts/render-integrations.mjs');
const indexSrc = read('src/index.ts');

const rendered = readdirSync(join(ROOT, 'landing', 'integrations'))
  .filter((f) => f.endsWith('.html'))
  .map((f) => f.replace(/\.html$/, ''));

const sitemapSrc = read('landing/sitemap.xml');
const sitemap = [...sitemapSrc.matchAll(/\/integrations\/([a-z0-9-]+)</g)].map((m) => m[1]);

const problems = [];
const note = (msg) => problems.push(msg);
const setEq = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
const only = (a, b) => a.filter((s) => !b.includes(s)).join(', ') || '—';
const indexPage = read('landing/integrations.html');

const families = FAMILIES.map((f) => {
  const rows = registryRows(f.registry);
  return {
    ...f,
    rows,
    dedicated: rows.filter((r) => r.dedicated === true).map((r) => r.slug),
    pageless: rows.filter((r) => r.dedicated === false).map((r) => r.slug),
    renderList: arrayLiteral(renderSrc, f.render),
    routeList: arrayLiteral(indexSrc, f.route),
  };
});

for (const f of families) {
  // We construct this corpus, so an empty parse is a broken check, never a clean tree.
  if (f.dedicated.length === 0) note(`${f.name}: parsed zero dedicated pages from ${f.registry}, so nothing was checked`);
  for (const r of f.rows) {
    if (r.dedicated === null) note(`${f.name}: '${r.slug}' has no hasDedicatedPage flag in ${f.registry}`);
  }

  // ── 1. The three slug lists of a family must agree exactly ──
  if (!setEq(f.dedicated, f.renderList)) {
    note(
      `${f.name}: the registry and render-integrations.mjs disagree:\n` +
      `    only in registry : ${only(f.dedicated, f.renderList)}\n` +
      `    only in render   : ${only(f.renderList, f.dedicated)}`,
    );
  }
  if (!setEq(f.renderList, f.routeList)) {
    note(
      `${f.name}: render-integrations.mjs and the index.ts allow-list disagree:\n` +
      `    only in render : ${only(f.renderList, f.routeList)}\n` +
      `    only in route  : ${only(f.routeList, f.renderList)}\n` +
      `    (a slug missing from the route allow-list 404s; a slug missing from the\n` +
      `     render list has no HTML for Express to load at boot)`,
    );
  }

  // ── 2. Every allow-listed slug must have a rendered artifact ──
  // index.ts reads each mirror into INTEGRATION_HTML at STARTUP and only warns on
  // a miss — so this drift surfaces as a 404 in prod, never as a build failure.
  for (const slug of f.routeList) {
    if (!existsSync(join(ROOT, 'landing', 'integrations', `${slug}.html`))) {
      note(`'${slug}' is in ${f.route.replace('const ', '')} but landing/integrations/${slug}.html does not exist → 404 in prod`);
    }
  }

  // ── 2b. A row with no page must not have one anywhere ──
  for (const slug of f.pageless) {
    if (f.renderList.includes(slug) || f.routeList.includes(slug) || rendered.includes(slug)) {
      note(`${f.name}: '${slug}' is hasDedicatedPage:false but is listed or rendered as a page`);
    }
  }

  // ── 4. Generated index blocks must already list every dedicated slug ──
  // `scripts/build_landing.mjs` renders the cards into landing/integrations.html
  // (and a docs.html block) from the registry. Adding a registry entry without
  // re-running that generator leaves the index silently missing the new page —
  // which is how this canary's own wave first failed CI.
  const missing = f.dedicated.filter((slug) => !indexPage.includes(`/integrations/${slug}`));
  if (missing.length) {
    note(
      `landing/integrations.html is missing ${f.name} slug(s): ${missing.join(', ')}\n` +
      `    → run \`npm run build:landing\` and commit the regenerated index`,
    );
  }
}

// ── 3. Every rendered page must be in the sitemap ──
for (const slug of rendered) {
  if (!sitemap.includes(slug)) {
    note(`landing/integrations/${slug}.html is rendered but missing from sitemap.xml → live but uncrawlable`);
  }
}
// ...and the sitemap must not advertise a page that does not exist.
for (const slug of sitemap) {
  if (!rendered.includes(slug)) {
    note(`sitemap.xml advertises /integrations/${slug} but no rendered page exists → crawler 404`);
  }
}

// ── 5. A retired slug appears nowhere ──
const retired = retiredSlugs();
if (retired.length === 0) note('parsed zero retired slugs from retired-slugs.ts, so nothing was checked');
const GENERATED_PAGES = ['landing/integrations.html', 'landing/docs.html', 'landing/mcp.html', 'landing/index.html'];
for (const slug of retired) {
  for (const f of families) {
    if (f.rows.some((r) => r.slug === slug)) note(`retired slug '${slug}' is still in ${f.registry}`);
    if (f.renderList.includes(slug)) note(`retired slug '${slug}' is still in render-integrations.mjs ${f.render.replace('const ', '')}`);
    if (f.routeList.includes(slug)) note(`retired slug '${slug}' is still in index.ts ${f.route.replace('const ', '')}, so the page wins over the 301`);
  }
  if (rendered.includes(slug)) note(`retired slug '${slug}' still has landing/integrations/${slug}.html`);
  if (sitemap.includes(slug)) note(`retired slug '${slug}' is still in sitemap.xml → crawlers follow a redirect forever`);
  const link = new RegExp(`/integrations/${slug}(?![a-z0-9-])`);
  for (const page of GENERATED_PAGES) {
    if (link.test(read(page))) note(`retired slug '${slug}' is still linked from ${page}`);
  }
}

// ── Report ──
console.log(
  `[lockstep] ${families.map((f) => `${f.name}=${f.dedicated.length}/${f.renderList.length}/${f.routeList.length}`).join(' ')} ` +
  `(registry/render/route) rendered=${rendered.length} sitemap=${sitemap.length} retired=${retired.length}`,
);
if (problems.length === 0) {
  console.log('✓ check-integrations-registry-lockstep: all six slug surfaces agree.');
  process.exit(0);
}
console.error(`\n✗ check-integrations-registry-lockstep found ${problems.length} drift(s):\n`);
for (const p of problems) console.error(`  - ${p}`);
console.error('');
process.exit(CHECK ? 1 : 0);
