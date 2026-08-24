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

// ─────────── EXTERNAL-SURFACE-PARITY-W1 CH1: data-tr-field span coverage ───────────
//
// The PCT scan above answers "is every PERCENTAGE claim site managed?". COV-1/2/3 below answer the
// structurally different question this wave exists for: "is every `data-tr-field` SPAN managed?".
// They live in this file, under this file's ONE token, deliberately — a rival
// SNAPSHOT_COVERAGE_VERDICT would be a second token for one meaning, which CLAUDE.md forbids.
const ORPHANS = path.join(REPO_ROOT, 'scripts', 'data', 'claim-coverage-orphans.json');
const PROXY_JS = path.join(REPO_ROOT, 'landing', 'js', 'track-record-proxy.js');
/** Corpus for the span checks: served landing HTML + the docs generator source. */
const SPAN_DIRS = [{ dir: 'landing', exts: ['.html'] }];
const SPAN_FILES = ['docs-src/template.html'];
/** Excluded outright: its literal `data-tr-field="KEY"` is a template placeholder, not a claim. */
const SPAN_EXCLUDED = new Set(['landing/_templates/answer-page.template.html']);
/** Pre-load placeholders. Excluded from COV-3 EQUALITY only — never from COV-1 coverage, or a
 *  stale field could hide behind a sentinel forever. */
const SENTINELS = new Set(['&mdash;', '\u2014', '']);
const SPAN_RX = /data-tr-field="([A-Za-z_]+)"[^>]*>([^<]{0,120})</g;
const FIELD_IN_PATTERN = /data-tr-field="([A-Za-z_]+)"/;

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

/** Field names the SHARED populator drives. Parsed from the producer, never hand-listed. */
export function proxyFieldSet(proxyText) {
  return new Set([...String(proxyText).matchAll(/setField\(\s*'([A-Za-z_]+)'/g)].map((m) => m[1]));
}

/** Every (file, field) span occurrence in the span corpus. */
export function collectSpans(docs) {
  const out = [];
  for (const d of docs) {
    if (SPAN_EXCLUDED.has(d.file)) continue;
    const clean = stripComments(d.text);
    for (const m of clean.matchAll(SPAN_RX)) {
      out.push({ file: d.file, field: m[1], literal: m[2].trim(), line: lineOf(clean, m.index) });
    }
  }
  return out;
}

/**
 * Which (file, field) pairs a manifest claim will REWRITE at bake time.
 * Listing a file is not coverage — the pattern must actually match, or it is a silent no-op.
 */
export function claimCoveredPairs(docs, claims) {
  const byFile = new Map(docs.map((d) => [d.file, d.text]));
  const covered = new Set();
  for (const c of claims) {
    const fm = FIELD_IN_PATTERN.exec(c.find_pattern || '');
    if (!fm) continue;
    let rx;
    try { rx = new RegExp(c.find_pattern); } catch { continue; }
    for (const f of c.apply_to_files || []) {
      const t = byFile.get(f);
      if (t && rx.test(t)) covered.add(`${f}\u0000${fm[1]}`);
    }
  }
  return covered;
}

/** COV-1 — a span with no producer at all. Three valid sources, checked in order. */
export function cov1Orphans(docs, spans, covered, proxyFields) {
  const byFile = new Map(docs.map((d) => [d.file, d.text]));
  const seen = new Set();
  const orphans = [];
  for (const s of spans) {
    const key = `${s.file}\u0000${s.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (covered.has(key)) continue;                                  // (i) manifest claim
    const text = byFile.get(s.file) || '';
    if (proxyFields.has(s.field) && text.includes('track-record-proxy')) continue; // (ii) shared proxy
    if (text.includes(`[data-tr-field="${s.field}"]`)) continue;      // (iii) same-file inline
    orphans.push({ file: s.file, field: s.field, literal: s.literal, line: s.line });
  }
  return orphans;
}

/** COV-2 — a (claim, file) pairing that matches nothing is a silent no-op wearing coverage's clothes. */
export function cov2Vacuous(docs, claims) {
  const byFile = new Map(docs.map((d) => [d.file, d.text]));
  const zero = [];
  for (const c of claims) {
    let rx;
    try { rx = new RegExp(c.find_pattern); } catch { continue; }
    for (const f of c.apply_to_files || []) {
      const t = byFile.get(f);
      if (t === undefined) { zero.push({ id: c.id, file: f, why: 'FILE_MISSING' }); continue; }
      if (!rx.test(t)) zero.push({ id: c.id, file: f, why: 'ZERO_MATCH' });
    }
  }
  return zero;
}

/**
 * COV-3 — one field name may not carry two meanings.
 *
 * Compares EFFECTIVE values, not committed bytes. A claim-covered span's committed literal is
 * pre-bake noise the injector overwrites, so comparing it would red the gate on every healthy
 * page. What is a real defect is a field that is LIVE on some pages and FROZEN on others (MIXED),
 * or frozen at several different values with no claim anywhere (FROZEN_DIVERGENT).
 *
 * COV-3a — two different values for one field on ONE page. Never allowlistable: no intent
 * explains it, and it is the single fact that proves the defect without argument.
 */
export function cov3Findings(spans, covered) {
  const byField = new Map();
  const byFilePair = new Map();
  for (const s of spans) {
    const key = `${s.file}\u0000${s.field}`;
    if (!byField.has(s.field)) byField.set(s.field, new Map());
    const m = byField.get(s.field);
    if (!m.has(s.file)) m.set(s.file, new Set());
    m.get(s.file).add(s.literal);
    if (!byFilePair.has(key)) byFilePair.set(key, new Set());
    byFilePair.get(key).add(s.literal);
  }
  const real = (set) => [...set].filter((v) => !SENTINELS.has(v));

  const samePage = [];
  for (const [key, vals] of byFilePair) {
    const [file, field] = key.split('\u0000');
    if (covered.has(key)) continue;
    const r = real(vals);
    if (new Set(r).size > 1) samePage.push({ file, field, values: [...new Set(r)].sort() });
  }

  const crossPage = [];
  for (const [field, files] of byField) {
    const cov = [...files.keys()].filter((f) => covered.has(`${f}\u0000${field}`));
    const unc = [...files.keys()].filter((f) => !covered.has(`${f}\u0000${field}`));
    const uncVals = [...new Set(unc.flatMap((f) => real(files.get(f))))].sort();
    if (cov.length && unc.length) {
      crossPage.push({ field, kind: 'MIXED', covered: cov.length, uncovered: unc, values: uncVals });
    } else if (!cov.length && uncVals.length > 1) {
      crossPage.push({ field, kind: 'FROZEN_DIVERGENT', covered: 0, uncovered: unc, values: uncVals });
    }
  }
  return { samePage, crossPage };
}

/**
 * The ratchet. Orphans that cannot be closed yet are ENUMERATED here with owner and revisit date;
 * anything NOT listed fails today, so regressions are blocked from day one while the backlog
 * drains. `max_rows` may only be lowered — that is what makes it a ratchet rather than warn-mode.
 */
export function loadAllowlist(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(j.rows)) throw new Error('allowlist has no rows[] array');
  if (!Number.isInteger(j.max_rows)) throw new Error('allowlist has no integer max_rows');
  for (const r of j.rows) {
    for (const k of ['kind', 'reason', 'owner', 'revisit']) {
      if (!r[k]) throw new Error(`allowlist row ${JSON.stringify(r)} missing "${k}"`);
    }
  }
  return j;
}
export const allowKey = (r) => (r.kind === 'cov3' ? `cov3\u0000${r.field}` : `cov1\u0000${r.file}\u0000${r.field}`);

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

  // ─── COV-1 / COV-2 / COV-3 (EXTERNAL-SURFACE-PARITY-W1 CH1) ───
  // Wrapped so a broken subject reports FAIL rather than ABORTING the suite: an assertion that
  // raises is not an assertion (CLAUDE.md).
  const safe = (fn) => { try { return fn(); } catch (err) { return `THREW:${err.message}`; } };
  const eq = (label, got, want) => {
    checked++;
    if (got === want) console.log(`  ✓ ${label} ⇒ ${JSON.stringify(got)}`);
    else { fails.push(label); console.log(`  ✗ ${label} ⇒ expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); }
  };
  const DOC = (file, text) => ({ file, text });
  const PROXY_FIX = "setField('call_count', x); setField('pfe_wr', y);";
  const CLAIM_CC = { id: 'c', find_pattern: '(data-tr-field="call_count"[^>]*>)[^<]+(<)', apply_to_files: ['a.html'] };

  console.log('--- COV-0 the shared populator is parsed from the PRODUCER ---');
  eq('setField names are extracted, not hand-listed', safe(() => [...proxyFieldSet(PROXY_FIX)].sort().join(',')), 'call_count,pfe_wr');
  eq('a populator that parses to zero fields is detectable', safe(() => proxyFieldSet('no populator here').size), 0);

  console.log('--- COV-1 must-FAIL ---');
  eq('a span with no claim, no proxy and no inline populator is an orphan', safe(() => {
    const d = [DOC('z.html', '<span data-tr-field="batch_count">45</span>')];
    return cov1Orphans(d, collectSpans(d), new Set(), proxyFieldSet(PROXY_FIX)).length;
  }), 1);
  eq('the proxy does NOT cover a page that never loads it', safe(() => {
    const d = [DOC('z.html', '<span data-tr-field="call_count">45</span>')];
    return cov1Orphans(d, collectSpans(d), new Set(), proxyFieldSet(PROXY_FIX)).length;
  }), 1);
  eq('a sentinel value is NOT coverage — it must not hide a producerless field', safe(() => {
    const d = [DOC('z.html', '<span data-tr-field="batch_count">&mdash;</span>')];
    return cov1Orphans(d, collectSpans(d), new Set(), proxyFieldSet(PROXY_FIX)).length;
  }), 1);

  console.log('--- COV-1 must-PASS (each of the three sources, separately) ---');
  eq('(i) a manifest claim that MATCHES covers the span', safe(() => {
    const d = [DOC('a.html', '<span data-tr-field="call_count">45</span>')];
    return cov1Orphans(d, collectSpans(d), claimCoveredPairs(d, [CLAIM_CC]), new Set()).length;
  }), 0);
  eq('(ii) the shared proxy covers it when the page LOADS the proxy', safe(() => {
    const d = [DOC('z.html', '<script src="/js/track-record-proxy.js"></script><span data-tr-field="call_count">45</span>')];
    return cov1Orphans(d, collectSpans(d), new Set(), proxyFieldSet(PROXY_FIX)).length;
  }), 0);
  eq('(iii) a same-file inline populator covers it', safe(() => {
    const d = [DOC('z.html', '<span data-tr-field="batch_count">45</span><script>document.querySelectorAll(\'[data-tr-field="batch_count"]\')</script>')];
    return cov1Orphans(d, collectSpans(d), new Set(), new Set()).length;
  }), 0);
  eq('listing a file whose pattern matches NOTHING is not coverage', safe(() => {
    const d = [DOC('a.html', '<span data-tr-field="asset_count">45</span>')];
    return claimCoveredPairs(d, [CLAIM_CC]).size;
  }), 0);

  console.log('--- COV-2 ---');
  eq('a claim listed on a file it does not match is a zero-match', safe(() => cov2Vacuous([DOC('a.html', '<p>nothing</p>')], [CLAIM_CC]).length), 1);
  eq('a claim listed on a file that does not exist is reported too', safe(() => cov2Vacuous([], [CLAIM_CC])[0].why), 'FILE_MISSING');
  eq('a matching pairing is not reported', safe(() => cov2Vacuous([DOC('a.html', '<span data-tr-field="call_count">1</span>')], [CLAIM_CC]).length), 0);

  console.log('--- COV-3 must-FAIL ---');
  eq('THE HEADLINE: one page rendering one field as two values', safe(() => {
    const d = [DOC('faq.html', '<span data-tr-field="asset_count">730</span><span data-tr-field="asset_count">729</span>')];
    return cov3Findings(collectSpans(d), new Set()).samePage.length;
  }), 1);
  eq('MIXED: a field live via a claim on one page and frozen on another', safe(() => {
    const d = [DOC('a.html', '<span data-tr-field="call_count">1</span>'), DOC('z.html', '<span data-tr-field="call_count">79,527</span>')];
    const r = cov3Findings(collectSpans(d), claimCoveredPairs(d, [CLAIM_CC]));
    return r.crossPage.length === 1 ? r.crossPage[0].kind : `n=${r.crossPage.length}`;
  }), 'MIXED');
  eq('FROZEN_DIVERGENT: no claim anywhere and the values differ', safe(() => {
    const d = [DOC('y.html', '<span data-tr-field="batch_count">45</span>'), DOC('z.html', '<span data-tr-field="batch_count">121</span>')];
    const r = cov3Findings(collectSpans(d), new Set());
    return r.crossPage.length === 1 ? r.crossPage[0].kind : `n=${r.crossPage.length}`;
  }), 'FROZEN_DIVERGENT');

  console.log('--- COV-3 must-PASS ---');
  eq('a fully claim-covered field is uniform by construction post-bake', safe(() => {
    const d = [DOC('a.html', '<span data-tr-field="call_count">1</span>'), DOC('a2.html', '<span data-tr-field="call_count">999</span>')];
    const claims = [{ ...CLAIM_CC, apply_to_files: ['a.html', 'a2.html'] }];
    return cov3Findings(collectSpans(d), claimCoveredPairs(d, claims)).crossPage.length;
  }), 0);
  eq('the sentinel is excluded from EQUALITY, so a placeholder is not a contradiction', safe(() => {
    const d = [DOC('z.html', '<span data-tr-field="batch_count">&mdash;</span><span data-tr-field="batch_count">45</span>')];
    return cov3Findings(collectSpans(d), new Set()).samePage.length;
  }), 0);
  eq('the declared template exclusion removes its placeholder from the corpus', safe(() => collectSpans([DOC('landing/_templates/answer-page.template.html', '<span data-tr-field="KEY">fallback</span>')]).length), 0);

  console.log('--- the ratchet ---');
  eq('a row missing an owner REFUSES', safe(() => {
    const f = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ccov.')), 'o.json');
    fs.writeFileSync(f, JSON.stringify({ max_rows: 1, rows: [{ kind: 'cov1', file: 'a', field: 'b', reason: 'r', revisit: '2026-01-01' }] }));
    try { loadAllowlist(f); return 'ACCEPTED'; } catch { return 'REFUSED'; }
  }), 'REFUSED');
  eq('an allowlist with no max_rows REFUSES', safe(() => {
    const f = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ccov.')), 'o.json');
    fs.writeFileSync(f, JSON.stringify({ rows: [] }));
    try { loadAllowlist(f); return 'ACCEPTED'; } catch { return 'REFUSED'; }
  }), 'REFUSED');
  eq('the committed allowlist loads and is within its own ratchet', safe(() => {
    const a = loadAllowlist(ORPHANS);
    return a.rows.length <= a.max_rows ? 'WITHIN' : 'GREW';
  }), 'WITHIN');
  eq('cov1 and cov3 rows key into different namespaces', safe(() => allowKey({ kind: 'cov3', field: 'x' }) === allowKey({ kind: 'cov1', file: 'x', field: 'x' })), false);

  // Vacuity guard: a self-test that asserts nothing must never report a pass.
  if (checked < 33) {
    console.log(`${TOKEN}=INDETERMINATE — only ${checked} assertions ran (expected >= 33)`);
    process.exit(3);
  }
  if (fails.length) {
    console.log(`${TOKEN}=FAIL — self-test ${fails.length}/${checked}: ${fails.join(' | ')}`);
    process.exit(1);
  }
  console.log(`${TOKEN}=PASS — self-test ${checked} assertions (pct: 4 must-fail, 7 must-pass, 1 stale-exemption; span: COV-0 ×2, COV-1 3 must-fail + 4 must-pass, COV-2 ×3, COV-3 3 must-fail + 3 must-pass, ratchet ×4)`);
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

// ─── failures accumulate into ONE terminal token: PCT scan + COV-1 + COV-2 + COV-3 ───
const failures = [];

if (uncovered.length) {
  for (const u of uncovered) {
    console.log(`  ✗ UNCOVERED ${u.file}:${u.line} — "${u.literal}" is a public numeric claim that no manifest claim injects.`);
    console.log(`      …${u.ctx}…`);
  }
  failures.push(
    `${uncovered.length} uncovered of ${sites} percentage claim site(s) — add a manifest row, or an ` +
    'exemption WITH A REASON to scripts/data/claim-coverage-exemptions.json'
  );
}
console.log(
  `✓ pct claim coverage: ${sites} numeric claim site(s) across ${docs.length} file(s) — ` +
    `${managed} manifest-managed, ${[...exemptUsed.values()].reduce((a, b) => a + b, 0)} explicitly exempted.`
);

// ─────────────── COV-1 / COV-2 / COV-3: data-tr-field span coverage ───────────────
const IGNORE_ALLOWLIST = process.argv.includes('--ignore-allowlist');
let allow;
try {
  allow = loadAllowlist(ORPHANS);
} catch (err) {
  console.log(`${TOKEN}=INDETERMINATE — orphan allowlist unusable: ${err.message}`);
  process.exit(3);
}
if (allow.rows.length > allow.max_rows) {
  console.log(`${TOKEN}=FAIL — the orphan allowlist GREW: ${allow.rows.length} rows against max_rows=${allow.max_rows}. It is a ratchet; it may only shrink.`);
  process.exit(1);
}
const allowed = IGNORE_ALLOWLIST ? new Set() : new Set(allow.rows.map(allowKey));
if (IGNORE_ALLOWLIST) console.log('… --ignore-allowlist: measuring against a PRISTINE tree. This flag can only make the gate STRICTER; it can never turn a FAIL into a PASS.');

let spanDocs = [];
try {
  for (const { dir, exts } of SPAN_DIRS) {
    for (const f of walk(path.join(REPO_ROOT, dir), exts)) {
      spanDocs.push({ file: path.relative(REPO_ROOT, f), text: fs.readFileSync(f, 'utf8') });
    }
  }
  for (const rel of SPAN_FILES) {
    const f = path.join(REPO_ROOT, rel);
    if (fs.existsSync(f)) spanDocs.push({ file: rel, text: fs.readFileSync(f, 'utf8') });
  }
} catch (err) {
  console.log(`${TOKEN}=INDETERMINATE — could not read the span corpus: ${err.message}`);
  process.exit(3);
}

let proxyFields;
try {
  proxyFields = proxyFieldSet(fs.readFileSync(PROXY_JS, 'utf8'));
} catch (err) {
  console.log(`${TOKEN}=INDETERMINATE — could not read the shared populator ${path.relative(REPO_ROOT, PROXY_JS)}: ${err.message}`);
  process.exit(3);
}
if (!proxyFields.size) {
  console.log(`${TOKEN}=INDETERMINATE — the shared populator parsed to ZERO fields; the extractor is broken, not the page uncovered`);
  process.exit(3);
}

const spans = collectSpans(spanDocs);
const spanPairs = new Set(spans.map((s) => `${s.file}\u0000${s.field}`));
if (!spans.length) {
  console.log(`${TOKEN}=INDETERMINATE — scanned ${spanDocs.length} file(s) and found ZERO data-tr-field spans; the scanner is broken, not the tree clean`);
  process.exit(3);
}
const covered = claimCoveredPairs(spanDocs, claims);
// No silent caps: the corpus size is printed beside every result, so a zero can never read as clean.
const nExcluded = [...SPAN_EXCLUDED].filter((f) => spanDocs.some((d) => d.file === f)).length;
console.log(
  `ℹ span corpus: ${spanDocs.length} file(s) discovered, ${nExcluded} excluded by declaration → ` +
  `${spanDocs.length - nExcluded} scanned · ${spanPairs.size} (file,field) pair(s) · ${spans.length} span(s) · ` +
  `${covered.size} claim-covered · proxy drives ${proxyFields.size} field(s) · ` +
  `allowlist ${allow.rows.length}/${allow.max_rows} row(s)`
);
for (const f of SPAN_EXCLUDED) if (spanDocs.some((d) => d.file === f)) console.log(`ℹ excluded: ${f} — its literal data-tr-field="KEY" is a template placeholder, not a claim`);

const orphans = cov1Orphans(spanDocs, spans, covered, proxyFields);
const liveOrphans = orphans.filter((o) => !allowed.has(`cov1\u0000${o.file}\u0000${o.field}`));
for (const o of orphans) {
  const held = allowed.has(`cov1\u0000${o.file}\u0000${o.field}`);
  console.log(`  ${held ? '◦ HELD' : '✗ COV-1'} ${o.file} · ${o.field} · "${o.literal}"${held ? ' (on the frozen list)' : ' — no manifest claim, not in the shared populator, no inline populator'}`);
}
if (liveOrphans.length) failures.push(`COV-1: ${liveOrphans.length} span(s) with no producer and no frozen-list row`);

// Full doc corpus, not spanDocs: claims legitimately target README.md, which carries no spans.
const vacuous = cov2Vacuous(docs, claims);
for (const z of vacuous) console.log(`  ◦ COV-2 ${z.id} → ${z.file} (${z.why})`);
const GRANDFATHERED_ZERO = 7;
if (vacuous.length > GRANDFATHERED_ZERO) {
  failures.push(`COV-2: ${vacuous.length} zero-match (claim,file) pairing(s) against ${GRANDFATHERED_ZERO} grandfathered — a NEW zero-match is a silent no-op and may not join the list`);
} else {
  console.log(`✓ COV-2: ${vacuous.length} zero-match pairing(s), all within the ${GRANDFATHERED_ZERO} grandfathered rows`);
}

const { samePage, crossPage } = cov3Findings(spans, covered);
for (const f of samePage) {
  console.log(`  ✗ COV-3a ${f.file} · ${f.field} renders ${f.values.length} DIFFERENT values on ONE page: ${f.values.join(' vs ')}`);
}
if (samePage.length) failures.push(`COV-3a: ${samePage.length} page(s) render one field as two different values — never allowlistable`);

const liveCross = crossPage.filter((f) => !allowed.has(`cov3\u0000${f.field}`));
for (const f of crossPage) {
  const held = allowed.has(`cov3\u0000${f.field}`);
  console.log(`  ${held ? '◦ HELD' : '✗ COV-3'} ${f.field} [${f.kind}] — ${f.covered} page(s) live via a claim, ${f.uncovered.length} frozen at ${JSON.stringify(f.values)}${held ? ' (on the frozen list)' : ''}`);
  if (!held) for (const u of f.uncovered.slice(0, 12)) console.log(`        · ${u}`);
  if (!held && f.uncovered.length > 12) console.log(`        · … and ${f.uncovered.length - 12} more file(s) — full set is the frozen list's work order`);
}
if (liveCross.length) failures.push(`COV-3: ${liveCross.length} field(s) carry more than one meaning across the corpus`);

// A frozen row that no longer matches anything is a guard quietly narrowing — report so it shrinks.
for (const r of allow.rows) {
  const stillReal = r.kind === 'cov3'
    ? crossPage.some((f) => f.field === r.field)
    : orphans.some((o) => o.file === r.file && o.field === r.field);
  if (!stillReal) console.log(`⚠ STALE frozen row — the defect is gone, SHRINK it: ${JSON.stringify(r.kind === 'cov3' ? r.field : `${r.file} · ${r.field}`)} (owner ${r.owner})`);
}

if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`${TOKEN}=FAIL — ${failures.length} check(s) failed. Widen scripts/snapshot-landing-manifest.json so the daily re-baker owns the literal, or add a row WITH AN OWNER AND REVISIT DATE to scripts/data/claim-coverage-orphans.json.`);
  process.exit(1);
}
console.log(`✓ span coverage: every one of ${spanPairs.size} (file,field) pair(s) has a producer, no field carries two meanings.`);
console.log(`${TOKEN}=PASS`);
process.exit(0);
