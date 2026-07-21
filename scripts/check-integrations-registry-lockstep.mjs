#!/usr/bin/env node
/**
 * check-integrations-registry-lockstep.mjs — OPS-INTEGRATIONS-VENUE-PAGES-W1
 *
 * An integration page's slug has to be listed in FIVE independent places or the
 * page is silently broken in a different way at each one:
 *
 *   1. `src/lib/integrations-data/exchange-kits.ts`  — the card on /integrations
 *   2. `scripts/render-integrations.mjs` EXCHANGES   — whether the HTML is generated
 *   3. `src/index.ts` INTEGRATION_EXCHANGES          — whether the route 404s
 *   4. `landing/integrations/<slug>.html`            — the artifact Express loads at boot
 *   5. `landing/sitemap.xml`                         — whether crawlers ever see it
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
  return [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]);
}

// ── The five sources ──
const kitsSrc = read('src/lib/integrations-data/exchange-kits.ts');
const kits = [...kitsSrc.matchAll(/slug:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);

const renderSrc = read('scripts/render-integrations.mjs');
const renderExchanges = arrayLiteral(renderSrc, 'const EXCHANGES');

const indexSrc = read('src/index.ts');
const routeExchanges = arrayLiteral(indexSrc, 'const INTEGRATION_EXCHANGES');

const rendered = readdirSync(join(ROOT, 'landing', 'integrations'))
  .filter((f) => f.endsWith('.html'))
  .map((f) => f.replace(/\.html$/, ''));

const sitemapSrc = read('landing/sitemap.xml');
const sitemap = [...sitemapSrc.matchAll(/\/integrations\/([a-z0-9-]+)</g)].map((m) => m[1]);

const problems = [];
const note = (msg) => problems.push(msg);

// ── 1. The three exchange-slug lists must agree exactly ──
const setEq = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
if (!setEq(kits, renderExchanges)) {
  note(
    `exchange-kits.ts and render-integrations.mjs EXCHANGES disagree:\n` +
    `    only in exchange-kits.ts : ${kits.filter((s) => !renderExchanges.includes(s)).join(', ') || '—'}\n` +
    `    only in render EXCHANGES : ${renderExchanges.filter((s) => !kits.includes(s)).join(', ') || '—'}`,
  );
}
if (!setEq(renderExchanges, routeExchanges)) {
  note(
    `render-integrations.mjs EXCHANGES and index.ts INTEGRATION_EXCHANGES disagree:\n` +
    `    only in render EXCHANGES        : ${renderExchanges.filter((s) => !routeExchanges.includes(s)).join(', ') || '—'}\n` +
    `    only in INTEGRATION_EXCHANGES   : ${routeExchanges.filter((s) => !renderExchanges.includes(s)).join(', ') || '—'}\n` +
    `    (a slug missing from the route allow-list 404s; a slug missing from the\n` +
    `     render list has no HTML for Express to load at boot)`,
  );
}

// ── 2. Every allow-listed slug must have a rendered artifact ──
// index.ts reads each mirror into INTEGRATION_HTML at STARTUP and only warns on
// a miss — so this drift surfaces as a 404 in prod, never as a build failure.
for (const slug of routeExchanges) {
  if (!existsSync(join(ROOT, 'landing', 'integrations', `${slug}.html`))) {
    note(`'${slug}' is in INTEGRATION_EXCHANGES but landing/integrations/${slug}.html does not exist → 404 in prod`);
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

// ── Report ──
console.log(
  `[lockstep] exchange-kits=${kits.length} render=${renderExchanges.length} ` +
  `route=${routeExchanges.length} rendered=${rendered.length} sitemap=${sitemap.length}`,
);
if (problems.length === 0) {
  console.log('✓ check-integrations-registry-lockstep: all five slug sources agree.');
  process.exit(0);
}
console.error(`\n✗ check-integrations-registry-lockstep found ${problems.length} drift(s):\n`);
for (const p of problems) console.error(`  - ${p}`);
console.error('');
process.exit(CHECK ? 1 : 0);
