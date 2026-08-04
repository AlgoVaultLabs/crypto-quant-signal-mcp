#!/usr/bin/env node
// @ts-check
/**
 * check-shape-snapshot-integrity.mjs — a malformed shape snapshot must not publish a meaningless
 * contract to the PUBLIC knowledge bundle.
 *
 * OPS-SHAPE-SNAPSHOT-INTEGRITY-W1.
 *
 * WHY THIS EXISTS. `scripts/build-knowledge-json.mjs` projects every
 * `audits/*-shape-snapshot-*.json` into `dist/knowledge/latest.json` — the artifact AI agents and
 * answer-engines read to learn what this API returns. That projection is TOTAL, with a per-field
 * fallback, so a snapshot that names its date `as_of` instead of `snapshot_date` does not fail the
 * build: it publishes `snapshot_date: "unknown"`. Measured before this wave, on a green build:
 *
 *     20 of 46 shapes published snapshot_date "unknown"
 *     22 of 46 published allowed_keys []   — a contract asserting NOTHING
 *     20 of 46 published the FILENAME as the endpoint
 *
 * On the product whose entire pitch is verifiability. A fallback is not a kindness when the
 * output is a public contract; it is a silent lie with a green checkmark.
 *
 * THREE FAILURE MODES IT CATCHES, all measured in the corpus:
 *   1. WRONG KEY NAME  — `as_of` / `date` / `captured_at` where the builder reads `snapshot_date`.
 *   2. WRONG TYPE      — `cache_contract` as a string, or `allowed_keys` as a nested OBJECT.
 *      The object case is the nastiest: the file looks fully populated to a human and projects an
 *      EMPTY array, because the builder tests `Array.isArray`.
 *   3. WRONG FILENAME  — the builder selects on `/-shape-snapshot-.*\.json$/`, so
 *      `referral-shape-snapshots-…` (plural) has NEVER appeared in the bundle. A typo silently
 *      excludes a declared contract.
 *
 * DATA INTEGRITY. No `allowed_keys` anywhere may contain `outcome_return_pct` or `outcome_price`,
 * and no key may appear in its own snapshot's `forbidden_keys`. The law covers the field NAMES on
 * a public surface, not merely their values.
 *
 * RATCHET, not fail-closed-over-a-dirty-corpus. Snapshots that legitimately cannot carry an
 * allow-list (rendered HTML pages; conditional MCP responses whose complete surface needs the
 * exported public formatter enumerated) declare `allowed_keys_exempt` WITH a reason. Everything
 * else must be clean. A baseline file is deliberately NOT used: Ch1 repaired the corpus, so the
 * gate blocks outright — shipping a ratchet over an already-clean corpus would be theatre.
 *
 * Verdict: exactly one terminal `SHAPE_SNAPSHOT_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (token-law default for a NEW gate).
 * FAIL-CLOSED: an unreadable corpus, or ZERO snapshots found, is INDETERMINATE — the corpus is one
 * WE author, so empty means the scan broke, never that everything is fine.
 *
 * Usage:
 *   node scripts/check-shape-snapshot-integrity.mjs --self-test
 *   node scripts/check-shape-snapshot-integrity.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUDITS = join(ROOT, 'audits');
const argv = process.argv.slice(2);

/** The builder's own selector. A file that looks like a snapshot but does not match is INVISIBLE. */
const BUILDER_SELECTOR = /-shape-snapshot-.*\.json$/;
/** Anything a human would call a snapshot — used only to catch near-miss filenames. */
const LOOKS_LIKE_SNAPSHOT = /shape-snapshot/;
/** Field names the Data Integrity law forbids on any public surface. */
const FORBIDDEN_NAMES = ['outcome_return_pct', 'outcome_price'];

/**
 * Validate one snapshot exactly as the builder consumes it.
 * @param {string} name @param {any} d
 * @returns {string[]} findings (empty = clean)
 */
export function validate(name, d) {
  const out = [];
  if (typeof d.superseded_by === 'string' && d.superseded_by) {
    // A superseded row is not projected; it only needs to say WHY.
    if (!d.superseded_reason) out.push('superseded_by without superseded_reason — an exemption in prose gets "fixed" by a future wave');
    return out;
  }
  if (typeof d.endpoint !== 'string' || !d.endpoint.trim()) {
    out.push('endpoint missing/not-a-string — the builder would publish the FILENAME as the endpoint');
  } else if (BUILDER_SELECTOR.test(d.endpoint)) {
    out.push(`endpoint is a snapshot FILENAME ("${d.endpoint}") — that is the fallback, not a contract`);
  }
  if (typeof d.snapshot_date !== 'string' || !d.snapshot_date.trim()) {
    out.push('snapshot_date missing/not-a-string — the builder would publish "unknown" (it does NOT read as_of/date/captured_at)');
  }
  if (d.cache_contract !== undefined && (typeof d.cache_contract !== 'object' || d.cache_contract === null || Array.isArray(d.cache_contract))) {
    out.push('cache_contract must be an OBJECT — the builder drops any other type silently');
  }
  const ak = d.allowed_keys;
  if (ak !== undefined && !Array.isArray(ak)) {
    out.push('allowed_keys must be an ARRAY — a nested object looks populated to a reader and projects as EMPTY (Array.isArray)');
  } else if (!Array.isArray(ak) || ak.length === 0) {
    if (!d.allowed_keys_exempt) {
      out.push('allowed_keys is empty and not exempt — this publishes a contract asserting NOTHING');
    } else if (!d.allowed_keys_exempt_reason) {
      out.push('allowed_keys_exempt without allowed_keys_exempt_reason — a reason on the ROW, never prose');
    }
  }
  for (const k of Array.isArray(ak) ? ak : []) {
    if (FORBIDDEN_NAMES.some((f) => String(k) === f)) {
      out.push(`allowed_keys contains "${k}" — Data Integrity covers the field NAME on a public surface`);
    }
    if ((d.forbidden_keys || []).includes(k)) {
      out.push(`allowed_keys and forbidden_keys both contain "${k}"`);
    }
  }
  return out;
}

function corpus() {
  const all = readdirSync(AUDITS);
  return {
    selected: all.filter((f) => BUILDER_SELECTOR.test(f)).sort(),
    nearMiss: all.filter((f) => LOOKS_LIKE_SNAPSHOT.test(f) && f.endsWith('.json') && !BUILDER_SELECTOR.test(f)).sort(),
  };
}

export function selfTest() {
  const fails = [];
  const clean = { endpoint: 'GET /api/x', snapshot_date: '2026-01-01', allowed_keys: ['a', 'b'], consumers: ['x'], drift_check_command: 'true' };
  if (validate('c.json', clean).length) fails.push('a clean snapshot was reported dirty');
  // each failure mode must FIRE
  const cases = [
    ['missing snapshot_date', { ...clean, snapshot_date: undefined }, /snapshot_date/],
    ['date under the wrong key', { ...clean, snapshot_date: undefined, as_of: '2026-01-01' }, /snapshot_date/],
    ['filename as endpoint', { ...clean, endpoint: 'foo-shape-snapshot-2026-01-01.json' }, /FILENAME/],
    ['cache_contract as string', { ...clean, cache_contract: 'ttl 60s' }, /OBJECT/],
    ['allowed_keys as object', { ...clean, allowed_keys: { top: ['a'] } }, /ARRAY/],
    ['empty allowed_keys, not exempt', { ...clean, allowed_keys: [] }, /asserting NOTHING/],
    ['exempt without a reason', { ...clean, allowed_keys: [], allowed_keys_exempt: true }, /exempt_reason/],
    ['forbidden field NAME published', { ...clean, allowed_keys: ['a', 'outcome_return_pct'] }, /Data Integrity/],
    ['allow and forbid the same key', { ...clean, allowed_keys: ['a'], forbidden_keys: ['a'] }, /both contain/],
    ['superseded without a reason', { superseded_by: 'other.json' }, /superseded_reason/],
  ];
  for (const [label, doc, rx] of cases) {
    const f = validate('t.json', doc);
    if (!f.some((x) => rx.test(x))) fails.push(`did NOT fire on: ${label}`);
  }
  // a superseded row WITH a reason is clean, and is not held to the projected-field rules
  if (validate('s.json', { superseded_by: 'o.json', superseded_reason: 'because' }).length) {
    fails.push('a properly superseded row was reported dirty');
  }
  // the builder's selector must reject the plural near-miss that has never been projected
  if (BUILDER_SELECTOR.test('referral-shape-snapshots-2026-06-20.json')) {
    fails.push('selector wrongly accepts the plural near-miss filename');
  }
  if (!BUILDER_SELECTOR.test('api-x-shape-snapshot-2026-01-01.json')) fails.push('selector rejects a valid snapshot name');
  return fails;
}

const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
function emit(v, why) {
  if (why) console.log(`\n${v === 'FAIL' ? '✖' : 'ℹ'} ${why}`);
  console.log(`SHAPE_SNAPSHOT_VERDICT=${v}`);
  process.exit(v === 'PASS' ? 0 : v === 'FAIL' ? 1 : 3);
}

if (IS_MAIN) {
  if (argv.includes('--self-test')) {
    const f = selfTest();
    if (f.length) { console.error('✖ shape-snapshot self-test FAILED:'); f.forEach((x) => console.error('   - ' + x)); process.exit(1); }
    console.log('✓ shape-snapshot self-test passed (10 failure modes fire; clean and superseded rows pass; selector rejects the plural near-miss)');
    process.exit(0);
  }
  const st = selfTest();
  if (st.length) { st.forEach((x) => console.error('   - ' + x)); emit('INDETERMINATE', 'self-test failure'); }
  if (!existsSync(AUDITS)) emit('INDETERMINATE', 'audits/ unreadable');

  const { selected, nearMiss } = corpus();
  if (!selected.length) emit('INDETERMINATE', 'ZERO snapshots matched the builder selector — the corpus is one WE author, so empty means the scan broke');

  const findings = [];
  for (const f of nearMiss) {
    findings.push([f, `filename does not match the builder selector /-shape-snapshot-.*\\.json$/ — this file has NEVER appeared in the public bundle. Rename it.`]);
  }
  for (const f of selected) {
    let d;
    try { d = JSON.parse(readFileSync(join(AUDITS, f), 'utf8')); }
    catch (e) { findings.push([f, `unparseable JSON: ${e.message}`]); continue; }
    for (const x of validate(f, d)) findings.push([f, x]);
  }

  if (findings.length) {
    console.error(`✖ ${findings.length} shape-snapshot integrity finding(s) across ${selected.length} snapshot(s):`);
    for (const [f, m] of findings) console.error(`   - ${f}: ${m}`);
    console.error('\n  These do not fail the build today — build-knowledge-json.mjs falls back per field, so a');
    console.error('  malformed snapshot publishes "unknown" / [] / the filename to the PUBLIC bundle with a');
    console.error('  green build. That is what this gate exists to stop.');
    emit('FAIL', `${findings.length} finding(s)`);
  }
  console.log(`✓ shape-snapshot integrity: ${selected.length} snapshot(s) declare a real contract (0 near-miss filenames, 0 wrong-typed fields, 0 unexempted empty allow-lists, 0 forbidden field names published).`);
  emit('PASS');
}
