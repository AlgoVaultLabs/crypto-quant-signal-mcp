#!/usr/bin/env node
/**
 * check-audit-cadence-schema.mjs — the BUILD-TIME contract for ops/monitoring/audit-cadence.json.
 *
 * OPS-AUDIT-CADENCE-CANARY-W1 CH1.
 *
 * ─── WHAT THIS GUARDS ───────────────────────────────────────────────────────────────────────
 * The cadence ledger is the corpus a daily host canary reads to decide whether a security audit
 * is DUE or OVERDUE. A canary with no committed, schema-valid corpus is a canary that fails open
 * on its first bad parse — so the corpus gets a gate at the point it is CONSTRUCTED.
 *
 * ─── WHY THE VACUITY GUARD LIVES HERE AND NOT IN THE CANARY ─────────────────────────────────
 * CLAUDE.md: "A vacuity guard belongs where the corpus is CONSTRUCTED, not where it is OBSERVED.
 * Empty input is only vacuity when YOU were supposed to fill it."
 *
 *   BUILD time (here)   — WE author `audits[]`. Empty means we built nothing. That is a defect in
 *                         the thing we wrote, so an empty `audits[]` is FAIL, never a pass.
 *   CANARY time (CH2)   — the WORLD hands the canary a file. Missing/unparseable/empty is a FACT
 *                         it could not evaluate, so it is INDETERMINATE, never PASS.
 *
 * Same file, two lifecycle points, two correct-but-different verdicts. Do not "align" them.
 *
 * ─── EXIT CODES — 0/1/3, AND DELIBERATELY NOT THE CANARY'S 0/0/0/3 ──────────────────────────
 * This is a BUILD gate wired into `prepublishOnly`: a FAIL must fail the build, so FAIL=1.
 * CH2's canary is a PAGING canary whose channel is Telegram: it must NOT non-zero on a real
 * OVERDUE, or cron mails an operator who already has a page. One meaning, one exit code, chosen
 * LOCALLY. The divergence is a decision, not drift — do not reconcile them.
 *
 * INDETERMINATE = 3, the token-law default for a new gate.
 *
 * ─── THE TOKEN IS THE VERDICT, NEVER THE EXIT CODE ──────────────────────────────────────────
 * Exactly one terminal `AUDIT_CADENCE_SCHEMA_VERDICT=PASS|FAIL|INDETERMINATE` line. Callers gate
 * on the TOKEN. `exit 0` may never encode both "verified, clean" and "verified nothing".
 *
 * Usage:
 *   node scripts/check-audit-cadence-schema.mjs              # validate the committed ledger
 *   node scripts/check-audit-cadence-schema.mjs --self-test  # two-way break-suite
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LEDGER_PATH = path.join(REPO, 'ops/monitoring/audit-cadence.json');

/**
 * The ALLOW-LIST is the disclosure control, and it is STRUCTURAL rather than conventional.
 *
 * This file is world-readable on GitHub. It carries dates, SHAs, wave ids and repo scope — and
 * nothing else. No severity counts, no finding ids, no open/closed remediation state, no host
 * paths. A deny-list would need updating every time someone invents a new forbidden key; an
 * allow-list makes the forbidden key UNWRITABLE by construction. That is why `severity_counts`
 * is one of the six deliberate breaks: the guard must be proven to reject it, not assumed to.
 */
export const TOP_KEYS = ['schema_version', 'cadence_days', 'warn_lead_days', 'rotation', 'rotation_slot', 'audits'];
export const AUDIT_KEYS = ['wave_id', 'completed_utc', 'baseline_sha', 'head_sha', 'scope'];

/**
 * The token → exit-code mapping, as DATA and derived ONCE.
 *
 * It lives here rather than as three scattered `return 0/1/3` literals because the self-test has
 * to be able to assert it. Measured precedent in this repo: a sibling gate's self-test asserted
 * its verdict TOKENS but never the token→exit-code association, so re-coding INDETERMINATE to 0
 * left the whole suite green while the gate silently stopped blocking. Asserting the map is what
 * closes that hole.
 */
export const EXIT_FOR = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

const SHA40 = /^[0-9a-f]{40}$/;
/** RFC-3339 UTC instant, `Z` only — a local-offset stamp is not an instant we can compare. */
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const isPosInt = (v) => Number.isInteger(v) && v > 0;

/**
 * The whole decision, as data, over an already-parsed document. Pure: no I/O, no clock of its
 * own. `nowMs` is INJECTED so the self-test can drive the future-timestamp rule deterministically
 * instead of sleeping or mutating the machine clock.
 *
 * Returns { verdict, failures[] } and NEVER throws — a validator that throws on malformed input
 * converts "proven able to fail" into "crashes", which is not a verdict.
 */
export function validate(doc, nowMs) {
  const f = [];
  const bad = (m) => f.push(m);

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { verdict: 'FAIL', failures: ['root is not a JSON object'] };
  }

  // ── allow-list, top level ────────────────────────────────────────────────────────────────
  for (const k of Object.keys(doc)) {
    if (!TOP_KEYS.includes(k)) bad(`forbidden top-level key '${k}' — the ledger is dates/SHAs/wave-ids/scope ONLY (allow-list: ${TOP_KEYS.join(', ')})`);
  }
  for (const k of TOP_KEYS) {
    if (!(k in doc)) bad(`missing required top-level key '${k}'`);
  }

  if (doc.schema_version !== 1) bad(`schema_version must be exactly 1, got ${JSON.stringify(doc.schema_version)}`);
  if (!isPosInt(doc.cadence_days)) bad(`cadence_days must be a positive integer, got ${JSON.stringify(doc.cadence_days)}`);
  if (!isPosInt(doc.warn_lead_days)) bad(`warn_lead_days must be a positive integer, got ${JSON.stringify(doc.warn_lead_days)}`);
  if (isPosInt(doc.cadence_days) && isPosInt(doc.warn_lead_days) && !(doc.warn_lead_days < doc.cadence_days)) {
    // A warn lead >= the cadence makes the DUE window swallow PASS entirely: the canary would be
    // permanently DUE from the moment an audit closes, i.e. a guard that cries wolf on day zero.
    bad(`warn_lead_days (${doc.warn_lead_days}) must be < cadence_days (${doc.cadence_days}) — otherwise DUE swallows PASS and the alarm is permanently on`);
  }

  // ── rotation ─────────────────────────────────────────────────────────────────────────────
  if (!Array.isArray(doc.rotation) || doc.rotation.length === 0) {
    bad('rotation must be a non-empty array');
  } else if (!doc.rotation.every((r) => typeof r === 'string' && r.length > 0)) {
    bad('every rotation entry must be a non-empty string');
  } else if (!Number.isInteger(doc.rotation_slot) || doc.rotation_slot < 0 || doc.rotation_slot >= doc.rotation.length) {
    bad(`rotation_slot ${JSON.stringify(doc.rotation_slot)} is not a valid index into rotation[${doc.rotation.length}]`);
  }

  // ── audits[] — the VACUITY GUARD, at the point of construction ───────────────────────────
  if (!Array.isArray(doc.audits)) {
    bad('audits must be an array');
    return { verdict: 'FAIL', failures: f };
  }
  if (doc.audits.length === 0) {
    bad('audits[] is EMPTY — at build time WE author this corpus, so empty means we built nothing (vacuity). The canary\'s empty-corpus case is INDETERMINATE; this one is FAIL.');
  }

  const seen = new Map();
  let prevMs = -Infinity;
  doc.audits.forEach((a, i) => {
    const at = `audits[${i}]`;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) { bad(`${at} is not an object`); return; }

    for (const k of Object.keys(a)) {
      if (!AUDIT_KEYS.includes(k)) bad(`${at}: forbidden key '${k}' (allow-list: ${AUDIT_KEYS.join(', ')})`);
    }
    for (const k of AUDIT_KEYS) {
      if (!(k in a)) bad(`${at}: missing required key '${k}'`);
    }

    if (typeof a.wave_id !== 'string' || a.wave_id.length === 0) {
      bad(`${at}: wave_id must be a non-empty string`);
    } else if (seen.has(a.wave_id)) {
      bad(`${at}: duplicate wave_id '${a.wave_id}' (first seen at audits[${seen.get(a.wave_id)}])`);
    } else {
      seen.set(a.wave_id, i);
    }

    for (const k of ['baseline_sha', 'head_sha']) {
      if (typeof a[k] !== 'string' || !SHA40.test(a[k])) {
        bad(`${at}: ${k} must be 40 lowercase hex chars, got ${JSON.stringify(a[k])}${typeof a[k] === 'string' ? ` (len ${a[k].length})` : ''}`);
      }
    }

    if (!Array.isArray(a.scope) || a.scope.length === 0 || !a.scope.every((s) => typeof s === 'string' && s.length > 0)) {
      bad(`${at}: scope must be a non-empty array of non-empty strings`);
    }

    if (typeof a.completed_utc !== 'string' || !RFC3339_UTC.test(a.completed_utc)) {
      bad(`${at}: completed_utc must be an RFC-3339 UTC instant (YYYY-MM-DDTHH:MM:SSZ), got ${JSON.stringify(a.completed_utc)}`);
      return;
    }
    const ms = Date.parse(a.completed_utc);
    if (!Number.isFinite(ms)) { bad(`${at}: completed_utc '${a.completed_utc}' is not a parseable instant`); return; }
    if (ms > nowMs) {
      // A future stamp is how a ledger silences the canary forever: max(completed_utc) in the
      // future makes age negative, so it never reaches DUE. Refuse it at construction.
      bad(`${at}: completed_utc '${a.completed_utc}' is in the FUTURE against the build clock — a future stamp makes age negative and the canary can never fire`);
    }
    if (ms < prevMs) bad(`${at}: completed_utc '${a.completed_utc}' is out of order — audits[] must ascend by completed_utc`);
    prevMs = Math.max(prevMs, ms);
  });

  return { verdict: f.length ? 'FAIL' : 'PASS', failures: f };
}

/** Read + parse. Separated so `validate` stays pure and the seam is the only I/O. */
export function loadLedger(p = LEDGER_PATH) {
  if (!existsSync(p)) return { ok: false, reason: `ledger absent at ${p}` };
  let raw;
  try { raw = readFileSync(p, 'utf8'); } catch (e) { return { ok: false, reason: `unreadable: ${e.message}` }; }
  try { return { ok: true, doc: JSON.parse(raw) }; } catch (e) { return { ok: false, reason: `unparseable JSON: ${e.message}` }; }
}

function runCheck() {
  const L = loadLedger();
  if (!L.ok) {
    // Handed a file we could not parse => INDETERMINATE, never FAIL and never PASS. "Empty vs
    // unparseable" is the line: empty we authored (FAIL, above); unparseable we were handed.
    console.log(`audit-cadence-schema: INDETERMINATE — ${L.reason}`);
    console.log('AUDIT_CADENCE_SCHEMA_VERDICT=INDETERMINATE');
    return EXIT_FOR.INDETERMINATE;
  }
  const r = validate(L.doc, Date.now());
  const d = L.doc;
  // POSITIVE per-check output: a gate that prints nothing on success is indistinguishable from
  // one that skipped the file entirely.
  console.log(`audit-cadence-schema: ${Array.isArray(d.audits) ? d.audits.length : 0} audit entr(ies), `
    + `cadence_days=${d.cadence_days} warn_lead_days=${d.warn_lead_days}, `
    + `rotation[${Array.isArray(d.rotation) ? d.rotation.length : 0}] slot=${d.rotation_slot}`);
  if (Array.isArray(d.audits)) {
    for (const a of d.audits) {
      console.log(`  · ${String(a?.wave_id).padEnd(28)} ${a?.completed_utc}  ${String(a?.baseline_sha).slice(0, 8)}..${String(a?.head_sha).slice(0, 8)}  scope: ${(a?.scope || []).join(', ')}`);
    }
  }
  if (r.verdict === 'FAIL') {
    console.log('');
    for (const m of r.failures) console.log(`  ✗ ${m}`);
    console.log('AUDIT_CADENCE_SCHEMA_VERDICT=FAIL');
    return EXIT_FOR.FAIL;
  }
  console.log('AUDIT_CADENCE_SCHEMA_VERDICT=PASS');
  return EXIT_FOR.PASS;
}

/**
 * ─── SELF-TEST ──────────────────────────────────────────────────────────────────────────────
 * Fixtures are built by MUTATING A DEEP CLONE OF THE REAL LEDGER, never hand-written. A
 * hand-written fixture can carry a shape the real file has never had, and then the suite passes
 * for a reason unrelated to the artifact it claims to guard — this repo has already paid for
 * that once (a self-test asserting `codes: [2]` against an extractor that only ever emitted
 * objects, which made the whole assertion vacuous).
 *
 * Every assertion is WRAPPED: a raising subject reports FAIL. An assertion that raises is not an
 * assertion — it aborts the suite and reads as a crash rather than a verdict.
 */
function selfTest() {
  const L = loadLedger();
  if (!L.ok) {
    console.log(`SELF-TEST: cannot build fixtures — ${L.reason}`);
    console.log('AUDIT_CADENCE_SCHEMA_VERDICT=INDETERMINATE');
    return EXIT_FOR.INDETERMINATE;
  }
  const NOW = Date.parse('2026-09-02T12:00:00Z');
  const base = () => JSON.parse(JSON.stringify(L.doc));
  const results = [];
  const ck = (name, fn, want) => {
    let got, err = null;
    try { got = fn(); } catch (e) { err = e; }
    const ok = err ? false : got === want;
    results.push({ name, ok, detail: err ? `RAISED ${err.message}` : `got ${got}, want ${want}` });
  };

  // ── vacuity guard on the FIXTURE CORPUS itself ───────────────────────────────────────────
  // If the real ledger were empty we would be mutating nothing, and every "break" below would
  // trivially still FAIL — a green suite proving nothing. Refuse rather than report a pass.
  if (!Array.isArray(L.doc.audits) || L.doc.audits.length === 0) {
    console.log('SELF-TEST: REFUSING — the real ledger has an empty audits[], so every mutation fixture would be vacuous');
    console.log('AUDIT_CADENCE_SCHEMA_VERDICT=INDETERMINATE');
    return EXIT_FOR.INDETERMINATE;
  }

  // The positive direction. Without it the suite could pass by rejecting EVERYTHING.
  ck('the real committed ledger PASSES', () => validate(base(), NOW).verdict, 'PASS');

  // ── the six mandated deliberate breaks (AC 2) ────────────────────────────────────────────
  ck('BREAK 1 — empty audits[] is vacuity at build time', () => {
    const d = base(); d.audits = []; return validate(d, NOW).verdict;
  }, 'FAIL');

  ck('BREAK 2 — a future completed_utc is refused', () => {
    const d = base(); d.audits[d.audits.length - 1].completed_utc = '2027-01-01T00:00:00Z';
    return validate(d, NOW).verdict;
  }, 'FAIL');

  ck('BREAK 3 — a duplicate wave_id is refused', () => {
    const d = base(); d.audits[1].wave_id = d.audits[0].wave_id; return validate(d, NOW).verdict;
  }, 'FAIL');

  ck('BREAK 4 — a 39-char head_sha is refused', () => {
    const d = base(); const h = d.audits[0].head_sha; d.audits[0].head_sha = h.slice(0, 39);
    return validate(d, NOW).verdict;
  }, 'FAIL');

  ck('BREAK 5 — rotation_slot out of range is refused', () => {
    const d = base(); d.rotation_slot = d.rotation.length; return validate(d, NOW).verdict;
  }, 'FAIL');

  ck('BREAK 6 — an added severity_counts key is refused (the disclosure guard)', () => {
    const d = base(); d.severity_counts = { critical: 0, high: 0 }; return validate(d, NOW).verdict;
  }, 'FAIL');

  // ── the allow-list must reject a forbidden key on a NESTED object too, not just the root ──
  ck('BREAK 6b — a forbidden key inside an audits[] entry is refused', () => {
    const d = base(); d.audits[0].finding_ids = ['SEC-01']; return validate(d, NOW).verdict;
  }, 'FAIL');

  // ── further contract legs ────────────────────────────────────────────────────────────────
  ck('warn_lead_days >= cadence_days is refused', () => {
    const d = base(); d.warn_lead_days = d.cadence_days; return validate(d, NOW).verdict;
  }, 'FAIL');

  ck('out-of-order audits[] is refused', () => {
    const d = base(); d.audits.reverse(); return validate(d, NOW).verdict;
  }, 'FAIL');

  ck('a non-UTC (offset) completed_utc is refused', () => {
    const d = base(); d.audits[0].completed_utc = '2026-07-28T10:54:00+08:00';
    return validate(d, NOW).verdict;
  }, 'FAIL');

  ck('a malformed root (array) does not throw, it FAILs', () => validate([], NOW).verdict, 'FAIL');
  ck('a null root does not throw, it FAILs', () => validate(null, NOW).verdict, 'FAIL');

  // ── prove the ALLOW-LIST is the control, by construction ─────────────────────────────────
  ck('the top-level allow-list is exactly the 6 declared keys', () => TOP_KEYS.join(','),
    'schema_version,cadence_days,warn_lead_days,rotation,rotation_slot,audits');
  ck('the audits[] allow-list is exactly the 5 declared keys', () => AUDIT_KEYS.join(','),
    'wave_id,completed_utc,baseline_sha,head_sha,scope');

  // ── the token -> EXIT CODE mapping, asserted rather than observed ────────────────────────
  // A gate whose self-test checks only the token is blind to its own exit code being re-coded,
  // which is how a blocking gate silently stops blocking. FAIL=1 because this is a BUILD gate
  // wired into prepublishOnly; the CH2 canary deliberately maps FAIL-equivalents to 0 because
  // its channel is Telegram. One meaning, one code, chosen locally — do NOT align them.
  ck('mapping PASS -> exit 0', () => EXIT_FOR.PASS, 0);
  ck('mapping FAIL -> exit 1 (a build gate must fail the build)', () => EXIT_FOR.FAIL, 1);
  ck('mapping INDETERMINATE -> exit 3 (token-law default for a new gate)', () => EXIT_FOR.INDETERMINATE, 3);
  ck('the mapping has exactly the three verdicts, no fourth state', () => Object.keys(EXIT_FOR).sort().join(','),
    'FAIL,INDETERMINATE,PASS');

  const fails = results.filter((r) => !r.ok);
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  [${r.detail}]`}`);
  if (fails.length) {
    console.log(`SELF-TEST: FAIL (${fails.length} of ${results.length})`);
    console.log('AUDIT_CADENCE_SCHEMA_VERDICT=FAIL');
    return EXIT_FOR.FAIL;
  }
  // The count the CH1 gate reads. `>= 6` there; this suite carries the six mandated breaks plus
  // eight further legs, and the number is printed rather than asserted so the gate sees growth.
  console.log(`SCHEMA_SELFTEST: PASS (${results.length})`);
  console.log('AUDIT_CADENCE_SCHEMA_VERDICT=PASS');
  return EXIT_FOR.PASS;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exit(process.argv.includes('--self-test') ? selfTest() : runCheck());
}
