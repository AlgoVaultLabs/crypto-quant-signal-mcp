#!/usr/bin/env node
/**
 * check-live-numeric-claims.mjs — the docs-surface analogue of
 * tests/unit/tool-description-forward-stability.test.ts.
 *
 * OPS-DOCS-HOLDRATE-LIVE-W1 (SEC-12 + SEC-32).
 *
 * WHY THIS EXISTS. `/docs` publicly stated a HOLD rate of "~84%" while the live SoT was 99.2%.
 * The number traced to no live field, no brand-facts M-tier substitution and no `data-tr-field`
 * consumer — an automatic fail under the numerical-citation rule, on the one product whose entire
 * pitch is verifiability. Retyping the digit would have recreated the defect one release later, so
 * the claim became live-sourced and manifest-managed instead. This gate is what stops the literal
 * form coming back.
 *
 * FOUR RULES, each earned by a defect found live in this wave:
 *
 *   R1 HARDCODED   A HOLD-rate / win-rate percentage in a public page must live inside a
 *                  `data-tr-field` span. This is the "~84%" defect itself.
 *
 *   R2 DOUBLE_PCT  No `%%` on any public surface. Counted by SITE, never by line: `grep -c` counts
 *                  LINES, and two sites on one minified line read as one. `91.6%%` and `99.1%%`
 *                  both shipped to the npm README.
 *
 *   R3 ARMED_PCT   The generator-level version of R2, and the reason R2 alone is not enough. A
 *                  manifest claim whose `replace_template` writes `{value}%` puts the `%` INSIDE
 *                  the span. A span holding a bare number that is FOLLOWED by a literal `%` is
 *                  therefore *armed*: it looks fine right now and bakes `99.2%%` on the next
 *                  injector run. Both prior README incidents were "fixed" by deleting the inner
 *                  `%` — the wrong side of the contract, which re-arms every time. Measured at the
 *                  start of this wave: 3 armed sites sitting green.
 *
 *   R4 DEAD_HOOK   A page carrying `data-tr-field` spans must load track-record-proxy.js. Without
 *                  it the span renders the deploy-baked fallback forever and never hydrates — and
 *                  a dead span is indistinguishable from a live one by inspection. `landing/docs.html`
 *                  was exactly this: adding spans there without the script would have "fixed" the
 *                  stale number by shipping a number that could go stale again silently.
 *
 * Exit: 0 PASS · 1 FAIL · 3 INDETERMINATE (token-law default for a new gate). Callers gate on the
 * TOKEN, never the bare code. Fail-CLOSED: an unreadable corpus is INDETERMINATE, not a pass.
 *
 * Usage:
 *   node scripts/check-live-numeric-claims.mjs              # scan the repo
 *   node scripts/check-live-numeric-claims.mjs --self-test  # two-way, vacuity-guarded
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const TOKEN = 'LIVE_NUMERIC_CLAIMS_VERDICT';

/**
 * Scanned surfaces. `.html` only, and that exclusion is REASONED, not an oversight: R1/R3/R4 all
 * require a `data-tr-field` span to be *possible*, and a `.txt` or `.md` build artifact cannot
 * carry one. Holding `landing/llms-full.txt` to a rule it structurally cannot satisfy would force
 * either a permanent exemption or a false failure. Its qualitative "~98% HOLD rate" (which points
 * at the live endpoint and carries a snapshot date) is tracked separately, not silently covered.
 * README.md IS included for R2/R3 — it is the canonical npm README and both prior incidents were
 * there — but not for R1/R4, which need a rendered page.
 */
const HTML_ROOTS = ['docs-src', 'landing'];
const EXTRA_R2_R3_FILES = ['README.md'];

/** Claim vocabulary for R1 — the metric families whose values must be live. */
const CLAIM_WORDS = /(HOLD[ _-]?rate|win[ _-]?rate|PFE[ _-]?WR|PFE win rate|hold_rate|pfe_wr)/i;
/** A bare percentage literal, optionally prefixed by ~ or "roughly". */
const PCT_LITERAL = /(?:~\s*)?\d{1,3}(?:\.\d+)?\s*%/g;
/** Proximity window (chars) between a claim word and a bare percentage for R1 to fire. */
const NEAR = 90;
/**
 * A percentage introduced by a comparison/threshold marker is a CONFIGURATION VALUE, not a
 * published rate — e.g. "every qualifying call (conviction ≥ 60%) is Merkle-anchored", which sits
 * one clause away from the words "win-rate track record" and would otherwise trip R1. Requiring a
 * live span for a threshold would be wrong: the threshold is not served by the SoT.
 */
const THRESHOLD_MARKER =
  /(?:(?<=\s)[≥≤><]=?|at least|no less than|above|below|under|over|conviction)\s*$/i;
// The `(?<=\s)` on the operator class is LOAD-BEARING. Without it the `>` that closes EVERY HTML
// tag reads as a comparison operator, so `<p>91.3% PFE win rate` is silently exempted and R1
// detects nothing on real markup. The self-test caught it — the difference between a gate and a
// decoration, and exactly why must-fire fixtures are not ceremony.

/**
 * JSON-LD is EXCLUDED from R1/R4 and the exclusion is reasoned, not convenient: a `<span>` cannot
 * exist inside a JSON string value, and structured data is already managed by a different manifest
 * family (`jsonld-*` claims with their own find_patterns). Demanding a span there would be
 * demanding something structurally impossible.
 *
 * It is NOT, however, silently dropped — the gate REPORTS its numeric-claim sites on every run.
 * Measured 2026-08-01: the `additionalProperty` form `"name": "PFE win rate", "value": "91.8%"`
 * is matched by NO manifest claim (`jsonld-description-pfe-rate` requires the % to PRECEDE the
 * label, and here it follows), so 19 files carry an unmanaged literal that is already stale
 * against a live `pfeWinRate` of 91.7%. That is the SEC-32 orphan pattern in a second surface, and
 * closing it changes public bytes in 19 files — a separate, operator-visible wave:
 * OPS-JSONLD-PFE-PROPERTYVALUE-MANAGE-W{NEXT}.
 */
const JSONLD_BLOCK = /<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi;

/**
 * R1 exemptions. Each row carries its own `reason` and `followup` and is PRINTED on every run —
 * an exemption that lives only in a comment gets "fixed" by a future wave enforcing the contract,
 * and one that is never printed reads as "covered everything".
 */
const R1_EXEMPTIONS = [
  {
    file: 'landing/integrations/maf.html',
    near: '90%+ PFE Win Rate model should do',
    reason:
      'Qualitative FLOOR claim in illustrative prose about what a selective model does, not a ' +
      'published rate — and it is currently TRUE (live pfeWinRate 91.7%). Its source of truth is ' +
      'algovault-skills/docs/integrations/maf.md in a SEPARATE repo, so rewriting the rendered ' +
      'HTML here would be a lane fix that the next render-integrations.mjs run silently reverts.',
    followup: 'OPS-SKILLS-NUMERIC-CLAIM-SWEEP-W{NEXT}',
  },
];

const SPAN_RE = /<span[^>]*data-tr-field="([A-Za-z_0-9]+)"[^>]*>([^<]*)<\/span>/g;
const PROXY_RE = /track-record-proxy\.js/;

/** Strip HTML comments AND markdown-ish comment blocks before any ban-scan.
 *  CLAUDE.md law: a mention inside a comment is documentation, not an occurrence. The docs
 *  template's own comment explains the dead-hook rule and quotes `%`; the answer-page template
 *  lists `hold_rate` in a build rule. A naive scanner demands deleting the most useful lines
 *  in the file. */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
}

/** Blank JSON-LD blocks (same length, so offsets/line numbers stay true). */
function stripJsonLd(html) {
  return html.replace(JSONLD_BLOCK, (m) => ' '.repeat(m.length));
}

/** Count numeric claim sites living inside JSON-LD, purely so the gate can REPORT what it does
 *  not enforce. A bounded scope that is never printed reads as "covered everything". */
function countJsonLdClaimSites(html) {
  let n = 0;
  for (const block of html.match(JSONLD_BLOCK) || []) {
    for (const m of block.matchAll(PCT_LITERAL)) {
      const s = Math.max(0, m.index - NEAR);
      if (CLAIM_WORDS.test(block.slice(s, m.index + m[0].length + NEAR))) n++;
    }
  }
  return n;
}

/** Replace each data-tr-field span with same-length filler so offsets stay stable and its
 *  contents are exempt from R1 (a live span is precisely what R1 wants). */
function maskSpans(html) {
  return html.replace(SPAN_RE, (m) => ' '.repeat(m.length)); // plain space: same length, no control chars
}

function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('._')) continue; // macOS AppleDouble resource forks
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.html')) acc.push(full);
  }
  return acc;
}

function lineOf(text, idx) {
  return text.slice(0, idx).split('\n').length;
}

/**
 * The scanner. Pure over (files -> content) so the self-test can drive it with fixtures.
 * @param {Array<{file:string, text:string, htmlSurface:boolean}>} docs
 * @param {Array<object>} manifestClaims
 */
export function scan(docs, manifestClaims) {
  const hits = [];
  let spansSeen = 0;
  let jsonLdSites = 0;
  const exemptionsApplied = new Set();

  // Fields whose manifest template writes a literal % inside the span (drives R3).
  const pctFields = new Set();
  for (const c of manifestClaims || []) {
    if (!String(c.replace_template || '').includes('%')) continue;
    const m = /data-tr-field="([A-Za-z_0-9]+)"/.exec(String(c.find_pattern || ''));
    if (m) pctFields.add(m[1]);
  }

  for (const d of docs) {
    const clean = stripComments(d.text);
    if (d.htmlSurface) jsonLdSites += countJsonLdClaimSites(clean);

    // ── R2 DOUBLE_PCT — count SITES, not lines ──
    for (const m of clean.matchAll(/%%/g)) {
      hits.push({
        rule: 'R2',
        file: d.file,
        line: lineOf(clean, m.index),
        detail: 'literal `%%` on a public surface (counted by SITE)',
      });
    }

    // ── R3 ARMED_PCT — span lacking % but followed by one ──
    for (const m of clean.matchAll(SPAN_RE)) {
      spansSeen++;
      const field = m[1];
      const inside = m[2];
      const after = clean.slice(m.index + m[0].length, m.index + m[0].length + 2);
      if (!pctFields.has(field)) continue;
      // A trailing literal % after the span is a violation EITHER WAY, and both halves matter:
      //   inside="99.2"  + trailing %  → ARMED: renders fine today, bakes `99.2%%` next inject.
      //   inside="99.2%" + trailing %  → ALREADY renders `99.2%%` to the reader right now.
      // Checking only the first (the obvious reading of "armed") would let the second ship, which
      // is the state the npm README was actually in.
      if (after.trimStart().startsWith('%')) {
        const armed = !inside.trimEnd().endsWith('%');
        hits.push({
          rule: 'R3',
          file: d.file,
          line: lineOf(clean, m.index),
          detail:
            `span data-tr-field="${field}" holds "${inside}" and is followed by a literal % — ` +
            (armed
              ? 'the manifest template writes the % INSIDE, so the next inject bakes `%%`.'
              : 'this already renders `%%` to the reader.') +
            ' Move the % inside the span; never delete it from the template.',
        });
      }
    }

    if (!d.htmlSurface) continue;

    // ── R1 HARDCODED — claim word near a bare percentage outside any span ──
    const masked = stripJsonLd(maskSpans(clean));
    for (const m of masked.matchAll(PCT_LITERAL)) {
      const s = Math.max(0, m.index - NEAR);
      const e = Math.min(masked.length, m.index + m[0].length + NEAR);
      const ctx = masked.slice(s, e);
      if (!CLAIM_WORDS.test(ctx)) continue;
      if (THRESHOLD_MARKER.test(masked.slice(Math.max(0, m.index - 24), m.index))) continue;
      const ex = R1_EXEMPTIONS.find((x) => x.file === d.file && ctx.includes(x.near));
      if (ex) {
        exemptionsApplied.add(`${ex.file} — ${ex.near} [${ex.followup}]`);
        continue;
      }
      hits.push({
        rule: 'R1',
        file: d.file,
        line: lineOf(masked, m.index),
        detail:
          `hardcoded "${m[0].trim()}" next to a HOLD-rate/win-rate claim. ` +
          'Public metric values must live in a <span data-tr-field="…"> hydrated from ' +
          '/api/performance-public, with a deploy-baked fallback.',
      });
    }

    // ── R4 DEAD_HOOK — spans present but the hydrator is not loaded ──
    // COMPLETE DOCUMENTS ONLY. `docs-src/partials/*.html` are fragments composed into
    // landing/docs.html; a fragment cannot carry a <script> tag, and demanding one would both be
    // impossible and duplicate the hydrator 24x in the assembled page. The composed output IS
    // checked — that is where the dead-hook risk actually lives.
    const isCompleteDocument = /<\/body>|<html[\s>]/i.test(d.text);
    if (isCompleteDocument && SPAN_RE.test(clean)) {
      SPAN_RE.lastIndex = 0;
      if (!PROXY_RE.test(d.text)) {
        hits.push({
          rule: 'R4',
          file: d.file,
          line: 1,
          detail:
            'page carries data-tr-field spans but does not load track-record-proxy.js — ' +
            'every span on it is a DEAD HOOK that renders the baked fallback forever.',
        });
      }
    }
    SPAN_RE.lastIndex = 0;
  }

  return { hits, spansSeen, jsonLdSites, exemptionsApplied: [...exemptionsApplied] };
}

function loadManifest() {
  const p = path.join(REPO_ROOT, 'scripts', 'snapshot-landing-manifest.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(raw) ? raw : raw.claims;
}

function collectDocs() {
  const docs = [];
  for (const root of HTML_ROOTS) {
    for (const f of walk(path.join(REPO_ROOT, root))) {
      docs.push({ file: path.relative(REPO_ROOT, f), text: fs.readFileSync(f, 'utf8'), htmlSurface: true });
    }
  }
  for (const rel of EXTRA_R2_R3_FILES) {
    const f = path.join(REPO_ROOT, rel);
    if (fs.existsSync(f)) docs.push({ file: rel, text: fs.readFileSync(f, 'utf8'), htmlSurface: false });
  }
  return docs;
}

// ───────────────────────────── self-test ─────────────────────────────
const GOOD_MANIFEST = [
  { id: 'dtrf-hold-rate', find_pattern: '(data-tr-field="hold_rate"[^>]*>)[^<]+(<)', replace_template: '$1{value}%$2' },
];
const LIVE_OK =
  '<p>The engine returns HOLD on <span data-tr-field="hold_rate">99.2%</span> of scans.</p>' +
  '<script defer src="/js/track-record-proxy.js"></script>';

function selfTest() {
  const fails = [];
  let checked = 0;
  const expect = (label, docs, manifest, wantRule) => {
    checked++;
    const { hits } = scan(docs, manifest);
    const got = hits.some((h) => h.rule === wantRule);
    if (wantRule === null) {
      if (hits.length) {
        fails.push(label);
        console.log(`  ✗ ${label} ⇒ expected CLEAN, got ${hits.map((h) => h.rule).join(',')}`);
      } else console.log(`  ✓ ${label} ⇒ clean`);
    } else if (got) console.log(`  ✓ ${label} ⇒ ${wantRule}`);
    else {
      fails.push(label);
      console.log(`  ✗ ${label} ⇒ expected ${wantRule}, got ${hits.map((h) => h.rule).join(',') || 'nothing'}`);
    }
  };
  const D = (text, htmlSurface = true) => [{ file: 'fixture.html', text, htmlSurface }];

  console.log('--- must-fire ---');
  expect('the original defect: "Current HOLD rate is ~84%"', D('<p>Current HOLD rate is ~84%, so we reject most scans.</p>' + LIVE_OK), GOOD_MANIFEST, 'R1');
  expect('hardcoded win rate', D('<p>91.3% PFE win rate across all calls.</p>' + LIVE_OK), GOOD_MANIFEST, 'R1');
  expect('literal %% in source', D('<p>91.6%% PFE win rate</p>' + LIVE_OK), GOOD_MANIFEST, 'R2');
  expect('ARMED span (bare number, trailing %)', D('<p><span data-tr-field="hold_rate">99.2</span>% HOLD</p>' + LIVE_OK), GOOD_MANIFEST, 'R3');
  expect('ALREADY-doubled span (renders %% today)', D('<p><span data-tr-field="hold_rate">99.2%</span>% HOLD</p>' + LIVE_OK), GOOD_MANIFEST, 'R3');
  expect(
    'dead hook (complete page, spans, no hydrator)',
    D('<html><body><p><span data-tr-field="hold_rate">99.2%</span> of scans</p></body></html>'),
    GOOD_MANIFEST,
    'R4'
  );

  console.log('--- must-NOT-fire ---');
  expect('the shipped live form', D(LIVE_OK), GOOD_MANIFEST, null);
  expect('claim word in an HTML comment only', D('<!-- HOLD rate is ~84% historically -->' + LIVE_OK), GOOD_MANIFEST, null);
  expect('unrelated percentage far from any claim word', D('<p>Funding rate 0.01% per 8h window.</p>' + LIVE_OK), GOOD_MANIFEST, null);
  expect('README-shaped surface exempt from R1/R4', D('<p>91.3% PFE win rate</p>', false), GOOD_MANIFEST, null);
  expect(
    'threshold value, not a published rate',
    D('<p>Every qualifying call (conviction &ge; 60%) is anchored, so the win-rate record is complete.</p>'.replace('&ge;', '≥') + LIVE_OK),
    GOOD_MANIFEST,
    null
  );
  expect(
    'partial/fragment with spans and no hydrator (composed into a page that has one)',
    D('<p><span data-tr-field="hold_rate">99.2%</span> of scans</p>'),
    GOOD_MANIFEST,
    null
  );
  expect(
    'JSON-LD PropertyValue (span structurally impossible)',
    D('<script type="application/ld+json">{"name":"PFE win rate","value":"91.8%"}</script>' + LIVE_OK),
    GOOD_MANIFEST,
    null
  );

  // Vacuity guard — a self-test that asserts nothing must never report a pass.
  if (checked < 13) {
    console.log(`${TOKEN}=INDETERMINATE — only ${checked} assertions ran (expected >= 13)`);
    process.exit(3);
  }
  if (fails.length) {
    console.log(`${TOKEN}=FAIL — self-test ${fails.length}/${checked}: ${fails.join(' | ')}`);
    process.exit(1);
  }
  console.log(`${TOKEN}=PASS — self-test ${checked} assertions (6 must-fire, 7 must-not-fire)`);
  process.exit(0);
}

// ───────────────────────────── main ─────────────────────────────
if (process.argv.includes('--self-test')) selfTest();

let docs, claims;
try {
  claims = loadManifest();
  docs = collectDocs();
} catch (err) {
  console.log(`${TOKEN}=INDETERMINATE — could not load corpus: ${err.message}`);
  process.exit(3);
}

// Fail-CLOSED vacuity guards: "scanned nothing" must never read as "found nothing".
if (!docs.length || !claims?.length) {
  console.log(`${TOKEN}=INDETERMINATE — empty corpus (files=${docs.length} claims=${claims?.length ?? 0})`);
  process.exit(3);
}

const { hits, spansSeen, jsonLdSites, exemptionsApplied } = scan(docs, claims);

if (!spansSeen) {
  console.log(`${TOKEN}=INDETERMINATE — scanned ${docs.length} files but found ZERO data-tr-field spans; the scanner is probably broken, not the corpus clean`);
  process.exit(3);
}

// No silent caps: say out loud what this gate does NOT enforce.
for (const e of exemptionsApplied) console.log(`\u2139 R1 exemption applied: ${e}`);
if (jsonLdSites) {
  console.log(
    `\u2139 ${jsonLdSites} JSON-LD numeric claim site(s) are NOT enforced by R1 (a <span> cannot exist ` +
      'inside a JSON string). Managed separately by the jsonld-* manifest family; the unmanaged ' +
      'additionalProperty "PFE win rate" form is tracked by OPS-JSONLD-PFE-PROPERTYVALUE-MANAGE-W{NEXT}.'
  );
}

if (hits.length) {
  const NAMES = { R1: 'HARDCODED', R2: 'DOUBLE_PCT', R3: 'ARMED_PCT', R4: 'DEAD_HOOK' };
  for (const h of hits) console.log(`  ✗ [${h.rule} ${NAMES[h.rule]}] ${h.file}:${h.line} — ${h.detail}`);
  console.log(`${TOKEN}=FAIL — ${hits.length} violation(s) across ${docs.length} file(s)`);
  process.exit(1);
}

console.log(
  `✓ live numeric claims: ${docs.length} file(s), ${spansSeen} data-tr-field span(s) — no hardcoded ` +
    'HOLD/win-rate literal, no `%%` site, no armed span, no dead hook.'
);
console.log(`${TOKEN}=PASS`);
process.exit(0);
