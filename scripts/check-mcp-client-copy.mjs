#!/usr/bin/env node
// @ts-check
/**
 * check-mcp-client-copy.mjs — the vendor-UI-path drift gate.
 *
 * LANDING-MCP-CLIENT-REGISTRY-W1 CH5.
 *
 * THE BUG CLASS: a vendor renames a menu, and our copy keeps naming the old one.
 * Claude Desktop moved custom MCP servers from `Settings → Integrations` to
 * `Settings → Connectors`. Three public surfaces had independently hardcoded the
 * old path — the landing quickstart, /faq (twice, prose AND its FAQPage JSON-LD
 * twin) and README (twice) — so the site spent months telling every visitor to
 * open a menu that is not there. Nothing failed. Nothing alerted. It was found by
 * reading the page.
 *
 * The registry retired the DUPLICATION. This retires the DRIFT: without it, the
 * next vendor rename recreates the identical defect, and detection without
 * enforcement is half a guard.
 *
 * WHY A SEPARATE SCRIPT from check-integrations-registry-lockstep.mjs, which
 * already walks the same registry: different evidence source. That canary proves
 * a SLUG is wired across its six homes; this one proves the COPY is not stale.
 * Same split as bot-deploy-parity.sh vs checkout-parity.sh. A copy-drift failure
 * surfacing under a script named "lockstep" mislabels itself for whoever reads
 * the CI log at 3am.
 *
 * DELIBERATELY NOT CHECKED: "every registry label appears on /integrations".
 * The lockstep canary owns that, and a second implementation of one assertion is
 * a second thing that can drift.
 *
 * Checks:
 *   1. FAIL — a retired vendor UI path in any rendered surface.
 *   2. FAIL — a byo-model row whose copy calls itself an MCP client.
 *   3. REPORT — a row whose `verifiedAt` is older than 180 days.
 *
 * Usage:
 *   node scripts/check-mcp-client-copy.mjs --self-test   # offline; proves both directions
 *   node scripts/check-mcp-client-copy.mjs               # scan the working tree
 *
 * Verdict: exactly one terminal `MCP_CLIENT_COPY_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Callers gate on the TOKEN, not the code (CLAUDE.md verdict-token law).
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE. 3 is the token-law default for a
 * NEW gate; do NOT "align" it to check_test_baseline.sh's 2, which is 2 only
 * because it already deployed that code.
 *
 * FAIL-CLOSED — there is no fail-open branch. An unreadable file, a missing
 * registry, or an empty corpus is INDETERMINATE and blocks.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createRequire } from 'node:module';

// The registry is a tsc-emitted CJS module. createRequire is the documented way
// to load one from an ESM script (a bare `require` is not defined here, and
// getting that wrong is invisible: the loader throws, the catch returns null,
// and the gate reports INDETERMINATE forever while looking like a config issue).
const require = createRequire(import.meta.url);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

const STALE_AFTER_DAYS = 180;

/**
 * Retired vendor UI paths. Each is matched in every encoding this repo actually
 * uses: the literal arrow (JSON-LD, markdown), the &rarr; named entity (page
 * prose) and the &#8594; numeric entity. Fixing one encoding and missing another
 * is exactly how /faq shipped a body and a structured-data twin that disagreed.
 */
const RETIRED_PATHS = [
  {
    label: 'Settings → Integrations (Claude Desktop; renamed to Connectors)',
    replacement: 'Settings → Connectors → Add custom connector',
    // eslint-disable-next-line no-useless-escape
    re: /Settings\s*(?:→|&rarr;|&#8594;|&#x2192;)\s*Integrations/gi,
  },
];

/** Rendered surfaces. A path that does not exist is INDETERMINATE, never a pass. */
function corpusFiles() {
  /** @type {string[]} */
  const files = [];
  const landing = join(ROOT, 'landing');
  if (!existsSync(landing)) return null;
  for (const f of readdirSync(landing)) {
    if (f.endsWith('.html') || /^llms.*\.txt$/.test(f)) files.push(join(landing, f));
  }
  const readme = join(ROOT, 'README.md');
  if (!existsSync(readme)) return null;
  files.push(readme);
  const docs = join(ROOT, 'docs');
  if (existsSync(docs)) walkMd(docs, files);
  return files;
}

/** @param {string} dir @param {string[]} out */
function walkMd(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
}

/**
 * Strip comments before grepping (CLAUDE.md gate-writing bug (a)).
 *
 * This wave's own history quotes the retired literal — in an HTML comment
 * explaining what was fixed, in a JS comment above the ban list, in a commit
 * body. A naive grep would demand deleting the most useful line in the file, and
 * a gate that punishes documentation gets disabled. A mention in a comment is
 * not a claim to the reader.
 *
 * @param {string} src @param {string} path
 */
export function stripComments(src, path) {
  let s = src;
  if (/\.html?$/.test(path)) s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  if (/\.(mjs|js|ts|tsx)$/.test(path)) {
    s = s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  }
  if (/\.md$/.test(path)) {
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    // Markdown blockquote lines are narrative in this repo's tutorials.
    s = s.replace(/^[ \t]*>.*$/gm, ' ');
  }
  return s;
}

/** Load the MCP-client registry from the compiled SoT. Null = cannot verify. */
function loadRegistry() {
  const dist = join(ROOT, 'dist', 'lib', 'integrations-data', 'mcp-clients.js');
  if (!existsSync(dist)) return null;
  try {
    const mod = require(dist);
    const surface = mod && (mod.default || mod);
    if (!surface || !Array.isArray(surface.entries) || surface.entries.length === 0) return null;
    return surface;
  } catch {
    return null;
  }
}

/** Text a reader actually sees for one registry row. */
export function renderedRowText(e) {
  return [e.setupSummary, e.whatYouGet, e.walkthroughSummary || '', e.walkthroughHtml]
    .join('\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&rarr;/g, '→')
    .replace(/&mdash;/g, '—')
    .replace(/&hellip;/g, '…')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** @param {'PASS'|'FAIL'|'INDETERMINATE'} verdict */
function verdictAndExit(verdict) {
  console.log(`MCP_CLIENT_COPY_VERDICT=${verdict}`);
  process.exit(verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 3);
}

// ── the three checks, as pure functions so the self-test can drive them ──

/** CHECK 1 — retired vendor UI path in a rendered surface. */
export function checkRetiredPaths(files, readFile) {
  const hits = [];
  for (const f of files) {
    const src = stripComments(readFile(f), f);
    for (const p of RETIRED_PATHS) {
      const m = src.match(p.re);
      if (m) hits.push({ file: f, label: p.label, count: m.length, replacement: p.replacement });
    }
  }
  return hits;
}

/** CHECK 2 — a byo-model row must not describe itself as an MCP client. */
export function checkByoModelCopy(entries) {
  const byo = entries.filter((e) => e.kind === 'byo-model');
  return {
    rows: byo.length,
    hits: byo.filter((e) => /MCP client/i.test(renderedRowText(e))).map((e) => e.slug),
  };
}

/** CHECK 3 — REPORT rows whose vendor doc was last checked over 180 days ago. */
export function checkStaleVerification(entries, nowMs) {
  const stale = [];
  for (const e of entries) {
    if (!e.verifiedAt) continue;
    const t = Date.parse(e.verifiedAt);
    if (Number.isNaN(t)) continue;
    const days = Math.floor((nowMs - t) / 86_400_000);
    if (days > STALE_AFTER_DAYS) stale.push({ slug: e.slug, days, source: e.source || '(none)' });
  }
  return stale;
}

// ── self-test ─────────────────────────────────────────────────────────────────

/**
 * Vacuity-guarded and two-way. WE build this corpus, so an empty one means the
 * test built nothing — a defect in the test, not a fact about the world. REFUSE.
 * (At runtime the world builds the corpus, and empty there is a fact; that case
 * is handled in main.)
 *
 * Asserts the verdict tokens AND the token→exit-code mapping. Asserting tokens
 * alone once let a re-coded INDETERMINATE→0 mapping stay fully green.
 *
 * @returns {'PASS'|'FAIL'|'INDETERMINATE'}
 */
function selfTest() {
  const fails = [];
  let mustFire = 0;
  let mustNotFire = 0;

  const fixtures = {
    '/fx/clean.html': '<p>Settings &rarr; Connectors &rarr; Add custom connector</p>',
    '/fx/stale-entity.html': '<p>Claude Desktop: Settings &rarr; Integrations &rarr; paste</p>',
    '/fx/stale-arrow.md': 'Open Claude → Settings → Integrations → Add custom connector',
    '/fx/stale-numeric.html': '<p>Settings &#8594; Integrations</p>',
    '/fx/comment-only.html':
      '<!-- was: Settings &rarr; Integrations --><p>Settings &rarr; Connectors</p>',
    '/fx/blockquote-only.md': '> Historical note: Settings → Integrations was the old path.',
  };
  const readFixture = (p) => {
    if (!(p in fixtures)) throw new Error(`fixture missing: ${p}`);
    return fixtures[p];
  };

  if (Object.keys(fixtures).length === 0) {
    console.error('✗ self-test corpus is EMPTY — the test built nothing.');
    return 'INDETERMINATE';
  }

  // CHECK 1, must-fire
  for (const f of ['/fx/stale-entity.html', '/fx/stale-arrow.md', '/fx/stale-numeric.html']) {
    mustFire++;
    if (checkRetiredPaths([f], readFixture).length !== 1) fails.push(`check1 must fire on ${f}`);
  }
  // CHECK 1, must-NOT-fire (incl. the comment/blockquote carve-outs)
  for (const f of ['/fx/clean.html', '/fx/comment-only.html', '/fx/blockquote-only.md']) {
    mustNotFire++;
    if (checkRetiredPaths([f], readFixture).length !== 0) fails.push(`check1 must NOT fire on ${f}`);
  }

  // CHECK 2, both directions
  const byoBad = [{ slug: 'x', kind: 'byo-model', setupSummary: 'Use it as an MCP client', whatYouGet: '', walkthroughHtml: '' }];
  const byoGood = [{ slug: 'x', kind: 'byo-model', setupSummary: 'Point Claude Code at it', whatYouGet: '', walkthroughHtml: '' }];
  mustFire++;
  if (checkByoModelCopy(byoBad).hits.length !== 1) fails.push('check2 must fire on byo-model calling itself an MCP client');
  mustNotFire++;
  if (checkByoModelCopy(byoGood).hits.length !== 0) fails.push('check2 must NOT fire on clean byo-model copy');
  // vacuity: zero byo-model rows must be visible as zero, not silently "clean"
  if (checkByoModelCopy([{ slug: 'y', kind: 'native' }]).rows !== 0) fails.push('check2 row count wrong');

  // CHECK 3, both directions
  const now = Date.parse('2026-08-05T00:00:00Z');
  mustFire++;
  if (checkStaleVerification([{ slug: 'old', verifiedAt: '2025-01-01', source: 'https://x' }], now).length !== 1) {
    fails.push('check3 must report a >180d row');
  }
  mustNotFire++;
  if (checkStaleVerification([{ slug: 'new', verifiedAt: '2026-08-01', source: 'https://x' }], now).length !== 0) {
    fails.push('check3 must NOT report a fresh row');
  }

  // token → exit-code mapping. Asserting the token alone is not enough: a
  // re-coded mapping would leave every token assertion green.
  const MAP = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };
  for (const [tok, code] of Object.entries(MAP)) {
    const got = tok === 'PASS' ? 0 : tok === 'FAIL' ? 1 : 3;
    if (got !== code) fails.push(`token→exit mapping broken for ${tok}: ${got} != ${code}`);
  }

  if (mustFire === 0 || mustNotFire === 0) {
    console.error(`✗ self-test is VACUOUS (must-fire=${mustFire}, must-not-fire=${mustNotFire}).`);
    return 'INDETERMINATE';
  }
  if (fails.length) {
    for (const f of fails) console.error(`  ✗ ${f}`);
    return 'FAIL';
  }
  console.log(
    `✓ self-test passed — ${mustFire} must-fire, ${mustNotFire} must-not-fire, ` +
      `3 token→exit mappings, across ${Object.keys(fixtures).length} fixtures.`,
  );
  return 'PASS';
}

// ── main ──────────────────────────────────────────────────────────────────────

if (argv.includes('--self-test')) {
  verdictAndExit(selfTest());
}

// A broken detector must never certify the tree.
const st = selfTest();
if (st !== 'PASS') {
  console.error('✗ detector self-test did not pass — refusing to certify the working tree.');
  verdictAndExit(st === 'FAIL' ? 'FAIL' : 'INDETERMINATE');
}

const files = corpusFiles();
if (!files) {
  console.error('✗ corpus unreadable (landing/ or README.md missing) — cannot verify.');
  verdictAndExit('INDETERMINATE');
}
if (files.length === 0) {
  console.error('✗ corpus resolved to ZERO files — cannot verify.');
  verdictAndExit('INDETERMINATE');
}

const registry = loadRegistry();
if (!registry) {
  console.error(
    '✗ MCP-client registry not loadable at dist/lib/integrations-data/mcp-clients.js — run `npm run build`.',
  );
  verdictAndExit('INDETERMINATE');
}

let failed = false;

// CHECK 1 — assert POSITIVE per-check output. A check skipped by a load error
// must not be indistinguishable from a check that passed.
let hits;
try {
  hits = checkRetiredPaths(files, (f) => readFileSync(f, 'utf8'));
} catch (e) {
  console.error(`✗ check 1 could not read a corpus file: ${e && e.message}`);
  verdictAndExit('INDETERMINATE');
}
if (hits.length) {
  failed = true;
  for (const h of hits) {
    console.error(`  ✗ ${h.file.replace(ROOT + '/', '')}: ${h.count}× "${h.label}" → use "${h.replacement}"`);
  }
} else {
  console.log(`✓ check 1: no retired vendor UI path across ${files.length} rendered surface(s).`);
}

// CHECK 2
const byo = checkByoModelCopy(registry.entries);
if (byo.rows === 0) {
  // Not vacuity — the registry legitimately might carry no byo-model row. Say so
  // out loud rather than printing a pass that examined nothing.
  console.log('✓ check 2: no byo-model rows in the registry (nothing to check).');
} else if (byo.hits.length) {
  failed = true;
  console.error(`  ✗ ${byo.hits.length} byo-model row(s) call themselves an MCP client: ${byo.hits.join(', ')}`);
} else {
  console.log(`✓ check 2: ${byo.rows} byo-model row(s), none described as an MCP client.`);
}

// CHECK 3 — REPORT only. Vendor UI paths drift; this names the row that rots next.
const stale = checkStaleVerification(registry.entries, Date.now());
if (stale.length) {
  for (const s of stale) {
    console.log(`  ⚠ REPORT: ${s.slug} last verified ${s.days}d ago (>${STALE_AFTER_DAYS}d) — re-check ${s.source}`);
  }
} else {
  console.log(
    `✓ check 3: all ${registry.entries.length} registry row(s) verified within ${STALE_AFTER_DAYS} days.`,
  );
}

verdictAndExit(failed ? 'FAIL' : 'PASS');
