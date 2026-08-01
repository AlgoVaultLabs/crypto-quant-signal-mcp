#!/usr/bin/env node
/**
 * check-claim-coverage.mjs — invert match → COVERAGE.
 *
 * OPS-JSONLD-PFE-PROPERTYVALUE-MANAGE-W1.
 *
 * WHY THIS EXISTS — the third instance of ONE root cause.
 *
 * Injector claims are phrasing-specific regexes, so a NEW PHRASING of the same fact silently
 * escapes management and rots. Every prior fix added one more row, which cannot retire the class:
 *
 *   1. OPS-SKILLS-PFE-WR-LIVEBIND-W1 (2026-07-25) — "N.N%+ Merkle-verified PFE Win Rate" on
 *      skills.html matched only the adjacent lowercase form; 89.4% rotted while live was 91.8%.
 *   2. SEC-32 in OPS-DOCS-HOLDRATE-LIVE-W1 (2026-08-01) — hold_rate spans sat outside the claim.
 *   3. THIS wave — the schema.org additionalProperty/PropertyValue form, 12 sites, stale at 91.8
 *      against a live 91.7. And while sweeping for it, two MORE variants surfaced that nobody had
 *      looked for: a FAQPage JSON-LD Answer ("win rate is N.N% on a rolling…", stale at 90.2) and
 *      16 GEO pages writing `<span class="stat" data-tr-field=…>` instead of `<span data-tr-field=…>`.
 *
 * CLAUDE.md's generator rule (>=3 same-root-cause fixes -> the next MUST make the class structurally
 * impossible) is why this file exists. A per-phrasing regex can only ever answer "does my pattern
 * match something?". This asks the inverse and much stronger question: **is every numeric claim site
 * in public output accounted for?** A new phrasing is then a BUILD FAILURE on the commit that
 * introduces it, not a discovery two months later.
 *
 * A crawler-facing literal cannot self-heal: a `data-tr-field` span at least hydrates client-side
 * from /api/performance-public, but JSON-LD and plain text are only ever as fresh as the last
 * deploy-time injection. That asymmetry is why coverage, not visibility, is the thing to assert.
 *
 * Exit: 0 PASS · 1 FAIL · 3 INDETERMINATE (token-law default for a NEW gate). Callers gate on the
 * TOKEN, never the bare code. Fail-CLOSED: an unreadable or empty corpus is INDETERMINATE.
 *
 * Usage:
 *   node scripts/check-claim-coverage.mjs              # scan
 *   node scripts/check-claim-coverage.mjs --self-test  # two-way, vacuity-guarded
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const TOKEN = 'CLAIM_COVERAGE_VERDICT';
const MANIFEST = path.join(REPO_ROOT, 'scripts', 'snapshot-landing-manifest.json');
const EXEMPTIONS = path.join(REPO_ROOT, 'scripts', 'data', 'claim-coverage-exemptions.json');

/** Metric vocabulary whose values are served by /api/performance-public and MUST be injected. */
const CLAIM_WORDS = /(PFE[ _-]?WR|PFE win rate|win[ _-]?rate|HOLD[ _-]?rate|hold_rate|pfe_wr)/i;
/** A percentage literal, optionally "~"-qualified. */
const PCT = /(?<![\d.\w])~?\s?\d{1,3}(?:\.\d)?%/g;
/** Proximity window (chars) between claim vocabulary and a literal. */
const NEAR = 90;

const SCAN_DIRS = [
  { dir: 'landing', exts: ['.html', '.txt'] },
  { dir: 'docs-src', exts: ['.html'] },
];
const SCAN_FILES = ['README.md'];

/** Comments are documentation, not occurrences (CLAUDE.md: strip before any ban-scan). Same-length
 *  blanking keeps every offset and line number true. */
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
}

function walk(dir, exts, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('._')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, acc);
    else if (exts.some((x) => e.name.endsWith(x))) acc.push(full);
  }
  return acc;
}

const lineOf = (t, i) => t.slice(0, i).split('\n').length;

/**
 * Pure scanner — exported so the self-test can drive it with fixtures instead of the repo.
 * @param {Array<{file:string,text:string}>} docs
 * @param {Array<object>} claims        manifest claim rows
 * @param {Array<object>} exemptions    rows with {file, contains?, reason, followup}
 */
export function scan(docs, claims, exemptions) {
  const uncovered = [];
  const exemptUsed = new Map();
  let sites = 0;
  let managed = 0;

  // Pre-compile each claim's own regex once. A claim only covers files it lists.
  const compiled = [];
  for (const c of claims) {
    let rx = null;
    try {
      rx = new RegExp(c.find_pattern, 'g');
    } catch {
      continue; // an unparseable pattern covers nothing; the injector will surface it separately
    }
    compiled.push({ id: c.id, rx, files: new Set(c.apply_to_files || []) });
  }

  for (const d of docs) {
    const clean = stripComments(d.text);

    // Byte ranges this file's claims actually match.
    const ranges = [];
    for (const c of compiled) {
      if (!c.files.has(d.file)) continue;
      c.rx.lastIndex = 0;
      for (const m of clean.matchAll(c.rx)) ranges.push([m.index, m.index + m[0].length, c.id]);
    }

    for (const m of clean.matchAll(PCT)) {
      const a = m.index;
      const b = a + m[0].length;
      const ctx = clean.slice(Math.max(0, a - NEAR), b + NEAR);
      if (!CLAIM_WORDS.test(ctx)) continue;
      sites++;

      // OVERLAP, not start-containment: a claim's match legitimately begins a few bytes before or
      // after the literal (e.g. `(data-tr-field="pfe_wr"[^>]*>)[^<]+(<)` starts at the attribute,
      // while the literal starts inside the element). Comparing start offsets under-counts
      // coverage and manufactures false failures.
      const owner = ranges.find(([s, e]) => s < b && a < e);
      if (owner) {
        managed++;
        continue;
      }

      const ex = exemptions.find(
        (x) => x.file === d.file && (x.contains === undefined || ctx.includes(x.contains))
      );
      if (ex) {
        const key = `${ex.file}${ex.contains ? ` :: ${ex.contains}` : ' :: (whole file)'}`;
        exemptUsed.set(key, (exemptUsed.get(key) || 0) + 1);
        continue;
      }

      uncovered.push({ file: d.file, line: lineOf(clean, a), literal: m[0].trim(), ctx: ctx.replace(/\s+/g, ' ').slice(0, 150) });
    }
  }

  // A stale exemption is a silently narrowed guard — report rows that matched nothing.
  const stale = exemptions.filter(
    (x) => ![...exemptUsed.keys()].some((k) => k.startsWith(x.file))
  );

  return { sites, managed, uncovered, exemptUsed, stale };
}

function load() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const claims = Array.isArray(manifest) ? manifest : manifest.claims;
  const exemptions = JSON.parse(fs.readFileSync(EXEMPTIONS, 'utf8')).exemptions;
  const docs = [];
  for (const { dir, exts } of SCAN_DIRS) {
    for (const f of walk(path.join(REPO_ROOT, dir), exts)) {
      docs.push({ file: path.relative(REPO_ROOT, f), text: fs.readFileSync(f, 'utf8') });
    }
  }
  for (const rel of SCAN_FILES) {
    const f = path.join(REPO_ROOT, rel);
    if (fs.existsSync(f)) docs.push({ file: rel, text: fs.readFileSync(f, 'utf8') });
  }
  return { claims, exemptions, docs };
}

// ───────────────────────────── self-test ─────────────────────────────
const CLAIMS_FIX = [
  {
    id: 'dtrf-pfe-wr',
    find_pattern: '(data-tr-field="pfe_wr"[^>]*>)[^<]+(<)',
    apply_to_files: ['a.html'],
  },
  {
    id: 'jsonld-propertyvalue-pfe-wr',
    find_pattern: '("name": "PFE win rate", "value": ")\\d+\\.\\d(%")',
    apply_to_files: ['a.html'],
  },
];
const EX_FIX = [{ file: 'b.html', contains: 'conviction ≥ 60%', reason: 'threshold', followup: null }];

function selfTest() {
  const fails = [];
  let checked = 0;
  const D = (file, text) => [{ file, text }];
  const expect = (label, docs, wantUncovered) => {
    checked++;
    const r = scan(docs, CLAIMS_FIX, EX_FIX);
    const got = r.uncovered.length;
    if (got === wantUncovered) console.log(`  ✓ ${label} ⇒ uncovered=${got}`);
    else {
      fails.push(label);
      console.log(`  ✗ ${label} ⇒ expected uncovered=${wantUncovered}, got ${got}` +
        (got ? ` (${r.uncovered.map((u) => u.literal).join(',')})` : ''));
    }
  };

  console.log('--- must-FAIL (an unmanaged claim site) ---');
  expect('a brand-new phrasing nobody wrote a claim for',
    D('a.html', '<p>Our engine holds a 91.8% PFE win rate this quarter.</p>'), 1);
  expect('managed span form, but on a file the claim does not list',
    D('zz.html', '<p><span data-tr-field="pfe_wr">91.7%</span> PFE win rate</p>'), 1);
  expect('PropertyValue form on an unlisted file',
    D('zz.html', '<p>"name": "PFE win rate", "value": "91.8%"</p>'), 1);
  expect('exemption is file-scoped — same text, different file',
    D('c.html', '<p>every call (conviction ≥ 60%) … win-rate record</p>'), 1);

  console.log('--- must-PASS ---');
  expect('span form on a listed file',
    D('a.html', '<p><span data-tr-field="pfe_wr">91.7%</span> PFE win rate</p>'), 0);
  expect('PropertyValue form on a listed file',
    D('a.html', '<p>"name": "PFE win rate", "value": "91.7%"</p>'), 0);
  expect('class="stat" variant — the one that escaped my first sweep',
    D('a.html', '<p><span class="stat" data-tr-field="pfe_wr">91.7%</span> PFE win rate</p>'), 0);
  expect('exempted threshold on its own file',
    D('b.html', '<p>every call (conviction ≥ 60%) … win-rate record</p>'), 0);
  expect('claim word present but no percentage',
    D('a.html', '<p>Our PFE win rate is published live.</p>'), 0);
  expect('percentage present but no claim word',
    D('a.html', '<p>Funding rate 0.01% per 8h.</p>'), 0);
  expect('claim inside an HTML comment is documentation',
    D('a.html', '<!-- historic: 84.0% PFE win rate -->'), 0);

  // A stale exemption must be detected — the guard narrowing itself is the failure mode.
  checked++;
  const st = scan(D('a.html', '<p>ok</p>'), CLAIMS_FIX, EX_FIX).stale;
  if (st.length === 1 && st[0].file === 'b.html') console.log('  ✓ stale exemption row detected');
  else { fails.push('stale-exemption'); console.log(`  ✗ stale exemption not detected (got ${st.length})`); }

  // Vacuity guard: a self-test that asserts nothing must never report a pass.
  if (checked < 12) {
    console.log(`${TOKEN}=INDETERMINATE — only ${checked} assertions ran (expected >= 12)`);
    process.exit(3);
  }
  if (fails.length) {
    console.log(`${TOKEN}=FAIL — self-test ${fails.length}/${checked}: ${fails.join(' | ')}`);
    process.exit(1);
  }
  console.log(`${TOKEN}=PASS — self-test ${checked} assertions (4 must-fail, 7 must-pass, 1 stale-exemption)`);
  process.exit(0);
}

// ───────────────────────────── main ─────────────────────────────
if (process.argv.includes('--self-test')) selfTest();

let claims, exemptions, docs;
try {
  ({ claims, exemptions, docs } = load());
} catch (err) {
  console.log(`${TOKEN}=INDETERMINATE — could not load inputs: ${err.message}`);
  process.exit(3);
}
if (!docs.length || !claims?.length || !Array.isArray(exemptions)) {
  console.log(`${TOKEN}=INDETERMINATE — empty corpus (files=${docs.length} claims=${claims?.length ?? 0} exemptions=${exemptions?.length ?? 'n/a'})`);
  process.exit(3);
}

const { sites, managed, uncovered, exemptUsed, stale } = scan(docs, claims, exemptions);

if (!sites || !managed) {
  console.log(`${TOKEN}=INDETERMINATE — scanned ${docs.length} file(s) but found sites=${sites} managed=${managed}; the scanner is probably broken, not the tree clean`);
  process.exit(3);
}

// No silent caps: every exemption is printed, with its reason and the wave that retires it.
for (const [key, n] of [...exemptUsed.entries()].sort()) {
  const ex = exemptions.find((x) => key.startsWith(x.file));
  console.log(`ℹ exempt ×${n}: ${key}`);
  console.log(`    reason: ${ex.reason}`);
  if (ex.followup) console.log(`    follow-up: ${ex.followup}`);
}
for (const s of stale) {
  console.log(`⚠ STALE exemption row matched nothing — delete it or fix its selector: ${s.file}${s.contains ? ` :: ${s.contains}` : ''}`);
}

if (uncovered.length) {
  for (const u of uncovered) {
    console.log(`  ✗ UNCOVERED ${u.file}:${u.line} — "${u.literal}" is a public numeric claim that no manifest claim injects.`);
    console.log(`      …${u.ctx}…`);
  }
  console.log(
    `${TOKEN}=FAIL — ${uncovered.length} uncovered of ${sites} claim site(s). Add a row to ` +
      'scripts/snapshot-landing-manifest.json so it tracks the live SoT, or an exemption row WITH A ' +
      'REASON to scripts/data/claim-coverage-exemptions.json.'
  );
  process.exit(1);
}

console.log(
  `✓ claim coverage: ${sites} numeric claim site(s) across ${docs.length} file(s) — ` +
    `${managed} manifest-managed, ${[...exemptUsed.values()].reduce((a, b) => a + b, 0)} explicitly exempted, 0 unaccounted.`
);
console.log(`${TOKEN}=PASS`);
process.exit(0);
