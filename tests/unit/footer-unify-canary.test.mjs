/**
 * FOOTER-UNIFY-W1 — footer-drift CI canary.
 *
 * Makes the 7→1 collapse structurally permanent: the brand footer markup lives in exactly
 * ONE place (src/lib/footer-content.ts renderBrandFooter), and the 4-place hand-sync that
 * PH-BADGE-COMPACT-W1 suffered cannot re-emerge. Pairs with `node scripts/inject-footer.mjs
 * --check` (asserts the committed static brand files match the SoT).
 *
 * Run: node --test tests/unit/footer-unify-canary.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The ONE target derivation, imported rather than re-listed. Safe to import: inject-footer.mjs
// guards its entrypoint, so loading it here does not rewrite every landing page as a side effect.
import { deriveFooterTargets } from '../../scripts/inject-footer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFile(path.join(ROOT, rel), 'utf8');
const count = (hay, needle) => hay.split(needle).length - 1;

// The distinctive brand-footer style literal. After unification it is PARAMETERIZED inside
// the SoT (background:${BRAND_FOOTER_BG_SIGNATURE}), so it must appear as a verbatim literal
// in ZERO source files — any re-appearance = a re-inlined footer (drift).
const FOOTER_STYLE_LITERAL = 'border-top:1px solid var(--line);background:oklch(0.13 0.012 265);display:flex';

const SOURCE_CONSUMERS = [
  'src/index.ts',
  'src/lib/account-handlers.ts',
  'scripts/render-jsx-static.mjs',
  'scripts/render-integrations.mjs',
];

// FOOTER-CONTACT-AND-UNIVERSAL-COVERAGE-W1 — DERIVED, not typed.
//
// This used to be a hand-written six-entry list. That is the same defect the injector's own
// TARGETS array had, and it failed the same way: it named 4 of the 24 integrations pages, so a
// page could lose its footer and this canary would still pass. The target set now comes from
// the one derivation both the injector and this test read.
//
// `minMarkers` is 2 for the two dual-render artboard pages (desktop + mobile) and 1 elsewhere —
// read from the file rather than declared, so adding a dual-render page needs no edit here.
const DUAL_RENDER = new Set(['landing/index.html', 'landing/how-it-works.html']);

const footerConfig = JSON.parse(
  await readFile(path.join(ROOT, 'ops', 'footer-coverage-config.json'), 'utf8'),
);
const derived = deriveFooterTargets(ROOT, footerConfig);

test('no inline brand-footer style literal survives outside the SoT', async () => {
  for (const f of SOURCE_CONSUMERS) {
    const src = await read(f);
    assert.strictEqual(count(src, FOOTER_STYLE_LITERAL), 0,
      `${f} contains an inline brand-footer literal — it must render from renderBrandFooter() instead`);
  }
});

test('the Follow badge (follow.svg) is defined exactly once, in the SoT', async () => {
  const sot = await read('src/lib/footer-content.ts');
  assert.strictEqual(count(sot, 'follow.svg'), 1, 'SoT must define the Follow badge exactly once');
  for (const f of SOURCE_CONSUMERS) {
    assert.strictEqual(count(await read(f), 'follow.svg'), 0, `${f} must not contain its own follow.svg badge copy`);
  }
});

test('the retired footer identifiers no longer define footers', async () => {
  const acct = await read('src/lib/account-handlers.ts');
  assert.strictEqual(count(acct, 'const ACCOUNT_FOOTER_HTML ='), 0, 'ACCOUNT_FOOTER_HTML literal must be retired');
  const rjs = await read('scripts/render-jsx-static.mjs');
  assert.strictEqual(count(rjs, 'function injectFooterBadge'), 0, 'injectFooterBadge() must be retired');
  assert.ok(rjs.includes("renderBrandFooter(mobile ? 'mobile' : 'desktop')"),
    'render-jsx-static must render the apex footer from the SoT');
  const rint = await read('scripts/render-integrations.mjs');
  assert.ok(rint.includes("renderBrandFooter('desktop')"), 'render-integrations must render the footer from the SoT');
});

test('the derived target set is non-vacuous and covers the whole landing tree', async () => {
  assert.strictEqual(derived.status, 'PASS', `target derivation failed: ${derived.why || ''}`);
  // Vacuity guard: an empty or near-empty set would make every assertion below pass silently.
  // 50 is a floor, not the count — it must not need editing when a page is added.
  assert.ok(derived.targets.length >= 50,
    `expected the full landing tree (>=50 pages), got ${derived.targets.length}`);
});

test('EVERY non-exempt public page renders the shared-footer marker', async () => {
  for (const file of derived.targets) {
    const minMarkers = DUAL_RENDER.has(file) ? 2 : 1;
    const html = await read(file);
    assert.ok(count(html, 'data-av-brand-footer') >= minMarkers,
      `${file} must carry >=${minMarkers} data-av-brand-footer marker(s)`);
    assert.ok(count(html, 'follow.svg') >= minMarkers, `${file} must render the Follow badge`);
  }
});

// FOOTER-CONTACT-AND-UNIVERSAL-COVERAGE-W1 — THE FLIPPED ASSERTION.
//
// This test used to assert the exact OPPOSITE: that faq/glossary/skills must NOT carry the brand
// marker, pinning Mr.1 ruling Q2=A ("those footer types are intentionally different, leave them").
// The architect reversed that ruling to "Unify + preserve" with the differing footers' measured
// contents in front of them, so the exemption and the test that encoded it are flipped together —
// leaving either half behind would half-disable the guard or make the test a lie.
//
// The "preserve" leg is the substantive part: the links unique to the retired page-nav footer
// (Home / Track Record / Glossary) were carried into FOOTER_LINKS, so the replace lost nothing.
test('the formerly-exempt footer types now carry the SoT footer, with their links preserved', async () => {
  const sot = await read('src/lib/footer-content.ts');
  for (const label of ['Home', 'Track Record', 'Glossary', 'Contact', 'Terms']) {
    assert.ok(sot.includes(`label: '${label}'`), `FOOTER_LINKS must carry the '${label}' link`);
  }
  for (const f of ['landing/faq.html', 'landing/glossary.html', 'landing/skills.html']) {
    const html = await read(f);
    assert.ok(count(html, 'data-av-brand-footer') >= 1,
      `${f} must NOW carry the brand footer (Q2=A reversed by FOOTER-CONTACT-AND-UNIVERSAL-COVERAGE-W1)`);
    for (const href of ['algovault.com/track-record', 'algovault.com/glossary', 'algovault.com/contact']) {
      assert.ok(html.includes(href), `${f} footer must still reach ${href} — the "preserve" leg`);
    }
  }
});
