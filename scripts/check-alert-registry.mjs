#!/usr/bin/env node
/**
 * check-alert-registry.mjs — OPS-ALERT-RECOVERY-NOTICE-W1 CH2.
 *
 * EVERY ALERT ID IS ENUMERATED, NOT MERELY DETECTABLE.
 *
 * CLAUDE.md: a shared primitive used by >=2 hosts gets a CONSUMER REGISTRY naming every
 * installation, because "detection is strictly weaker than enumeration" — detection only tells
 * you the miss already happened. An `alert_id` firing from a canary nobody listed is exactly
 * what `ops/monitoring/alert-registry.json` exists to make impossible.
 *
 * Measured at authoring time: 14 of 42 alert ids had a LIVE cooldown marker on a host and no
 * discoverable call site in this repo, while others had a call site and had never fired. Neither
 * source is complete alone, which is the argument for a hand-reviewed registry rather than a
 * derived list.
 *
 * ── WHY THE EXTRACTOR IS STRUCTURAL, NOT CASING-BASED ───────────────────────────────────────
 * The obvious move is to reuse `check-alert-recommended-wave.mjs`'s SHOUTY_SNAKE `ID_RE` and
 * widen it to catch the lowercase ids (`x402-bazaar-delist`, `book_liveness_ceiling`,
 * `xrepo_ci_dark`). MEASURED: a widened identifier regex matches 2-3x more tokens in the same
 * files — shell function names (`emit_verdict`, `breach_bump`), file basenames
 * (`algovault-monitoring`, `send_telegram`), variable names (`alert_id`). Feeding those to the
 * sibling gate would manufacture false violations, and feeding them here would demand ~60 bogus
 * registry rows. So an alert id is identified by its POSITION in a call, not by its shape:
 *
 *   1. `ALERT_ID = "..."` / `ALERT_ID="..."`         (shell + python)
 *   2. `send_telegram.sh <ID> CRITICAL_PERSISTENT`   (positional)
 *   3. `[TG, "<ID>", "CRITICAL_PERSISTENT"`          (python list form)
 *
 * Position is casing-agnostic, so the lowercase ids are caught for free and nothing else is.
 * `stripComments` IS reused from the sibling — a mention in prose is not an emission, and that
 * is the one piece of the problem both gates genuinely share. (Verified: the string
 * "send_telegram.sh enforces CRITICAL_PERSISTENT + 24h cooldown" in a comment matched shape 2
 * and produced a phantom id named `enforces` until comments were stripped.)
 *
 * Verdict contract: exactly one terminal ALERT_REGISTRY_VERDICT=PASS|FAIL|INDETERMINATE.
 * Exit 0=PASS / 1=FAIL / 3=INDETERMINATE (3 is the token-law default for a new gate).
 * Callers gate on the TOKEN, never the code.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './check-alert-recommended-wave.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const REGISTRY = join(REPO, 'ops', 'monitoring', 'alert-registry.json');
const INVENTORY = join(REPO, 'ops', 'monitoring', 'monitoring-inventory.json');
const SCAN_DIRS = ['ops', 'scripts'];
const SCAN_EXT = /\.(sh|py|mjs)$/;
/**
 * NOT-A-CALLER exclusions. Both are structural, not convenience — and the list is asserted to
 * stay at exactly these two, because an exclusion list is the obvious place to quietly hide a
 * real caller.
 *   - send_telegram.sh is the WRAPPER. It delivers alerts; it never raises one. Its `--self-test`
 *     mode sets ALERT_ID="SELF_TEST" as a dispatch sentinel, which is not an alert id.
 *   - this gate's own file carries deliberately-fake ids (FOO_BAR_BAZ, MY_ALERT, and the
 *     `enforces` phantom) as self-test FIXTURES. A gate that fails on its own fixtures is
 *     asserting nothing about the tree.
 */
const NOT_A_CALLER = new Set(['ops/monitoring/send_telegram.sh', 'scripts/check-alert-registry.mjs']);

const SHAPES = [
  /^[^\n]*?\bALERT_ID\s*=\s*"?([A-Za-z][A-Za-z0-9_-]{3,})"?/gm,
  // The token IMMEDIATELY PRECEDING the severity is the alert id, by the wrapper's own signature
  // (`send_telegram.sh <alert_id> <severity>`). Anchoring on the literal `send_telegram.sh`
  // instead was a MEASURED blind spot: real call sites invoke it through a variable
  // (`| "$TG" MY_ID CRITICAL_PERSISTENT -`), so an unregistered id added that way was invisible
  // and the gate reported PASS. Found by the prove-it-can-fail step, which is the whole reason
  // that step exists — the gate looked correct against the tree it already agreed with.
  /["'\s]([A-Za-z][A-Za-z0-9_-]{3,})["']?\s+["']?CRITICAL_PERSISTENT/g,
  /\[\s*TG\s*,\s*"([A-Za-z][A-Za-z0-9_-]{3,})"\s*,\s*"CRITICAL_PERSISTENT/g,
];

export function extractAlertIds(text) {
  const body = stripComments(text);
  const out = new Set();
  for (const re of SHAPES) {
    re.lastIndex = 0;
    let m;
    // `SEVERITY`/`severity` immediately before the constant is an assignment or a parameter
    // name, never an id; same for the constant echoing itself.
    const NOT_IDS = new Set(['ALERT_ID', 'SEVERITY', 'severity', 'CRITICAL_PERSISTENT', 'severity_gate']);
    while ((m = re.exec(body)) !== null) if (!NOT_IDS.has(m[1])) out.add(m[1]);
  }
  return out;
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (SCAN_EXT.test(e)) acc.push(p);
  }
  return acc;
}

/**
 * OPS-MONITORING-SIGNAL-CONTRACT-W1 CH2 — THE SECOND SOURCE.
 *
 * This gate derived its corpus from CALL SITES alone, and call-site matching is DETECTION.
 * Detection is strictly weaker than enumeration, and the measured cost was exact: 14 of the 49
 * alert ids the inventory declares were invisible here — including
 * `DIRECTIONAL_LABEL_CAPACITY_SHORTFALL`, the alert whose false page commissioned this very wave.
 * `directional-label-freshness.py` raises it through a Python `subprocess.run([...])` argv list,
 * a shape none of the three SHAPES above match.
 *
 * THE FIX IS NOT A FOURTH REGEX. A fourth shape would close this hole and leave the next one open
 * exactly as silently. The corpus is the UNION of what we can detect and what the inventory
 * DECLARES, and where the two sources disagree that disagreement is REPORTED under its own
 * verdict — never silently resolved to whichever set is smaller. The registry's own header
 * already conceded the principle: "NEITHER SOURCE IS COMPLETE ALONE."
 */
export function inventoryAlertIds(raw) {
  const doc = JSON.parse(raw);
  const rows = Array.isArray(doc.artifacts) ? doc.artifacts : [];
  const ids = new Set();
  for (const r of rows) for (const id of (r.alert_ids || [])) if (id) ids.add(id);
  return ids;
}

/**
 * The two derivations, compared. `registered` must be the UNION's superset — an id known to
 * either source and absent from the registry is exactly the miss this pair exists to make
 * impossible.
 */
export function sourceDelta(detected, declared, registered) {
  const onlyDetected = [...detected].filter((id) => !declared.has(id)).sort();
  const onlyDeclared = [...declared].filter((id) => !detected.has(id)).sort();
  const union = new Set([...detected, ...declared]);
  const unregistered = [...union].filter((id) => !registered.has(id)).sort();
  return { onlyDetected, onlyDeclared, union, unregistered, agree: onlyDetected.length === 0 && onlyDeclared.length === 0 };
}

/**
 * AC2.7 — a row that has NOT adopted the envelope must name the wave that will migrate it.
 * `adopted` / `announce_resolution` stay exactly as they were: they answer "does the owner call
 * --clear" and "is that clear announced", which are different questions from "does this alert
 * carry a DETECTOR_ENVELOPE". Overloading one boolean with two meanings is the defect this wave
 * is named after, so conformance gets its own column following the SAME pattern — default false,
 * a named follow-up wave, and unadopted rows behaving byte-identically to before.
 */
export function envelopeViolations(rows) {
  const out = [];
  for (const r of rows) {
    const adopted = r.envelope_adopted === true;
    if (!adopted && !r.envelope_follow_up_wave) {
      out.push({ id: r.alert_id, why: 'envelope_adopted is not true and no envelope_follow_up_wave names who will migrate it' });
    }
    if (adopted && r.envelope_follow_up_wave) {
      out.push({ id: r.alert_id, why: 'envelope_adopted is true but it still carries an envelope_follow_up_wave — a closed migration must not keep a pending owner' });
    }
  }
  return out;
}

export function findUnregistered(raisedByFile, registered) {
  const out = [];
  for (const [file, ids] of raisedByFile) {
    for (const id of ids) if (!registered.has(id)) out.push({ id, file });
  }
  return out;
}

function run() {
  if (!existsSync(REGISTRY)) {
    console.log(`  registry not found at ${relative(REPO, REGISTRY)}`);
    console.log('ALERT_REGISTRY_VERDICT=INDETERMINATE');
    process.exit(3);
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  } catch (e) {
    console.log(`  registry is unparseable: ${e.message}`);
    console.log('ALERT_REGISTRY_VERDICT=INDETERMINATE');
    process.exit(3);
  }
  const rows = Array.isArray(doc.alerts) ? doc.alerts : [];
  // VACUITY GUARD 1 — an empty registry must never read as "everything is registered".
  if (rows.length === 0) {
    console.log('  registry contains ZERO alerts — it would certify anything');
    console.log('ALERT_REGISTRY_VERDICT=INDETERMINATE');
    process.exit(3);
  }
  const registered = new Set(rows.map((r) => r.alert_id).filter(Boolean));

  const raisedByFile = new Map();
  let total = 0;
  for (const d of SCAN_DIRS) {
    for (const f of walk(join(REPO, d))) {
      let ids;
      try { ids = extractAlertIds(readFileSync(f, 'utf8')); } catch { continue; }
      const rel = relative(REPO, f);
      if (NOT_A_CALLER.has(rel)) continue;
      if (ids.size) { raisedByFile.set(rel, ids); total += ids.size; }
    }
  }
  // VACUITY GUARD 2 — if the extractor finds nothing, it is broken, not the tree.
  if (total === 0) {
    console.log('  scanned the tree and found ZERO raised alert ids — the extractor is broken');
    console.log('ALERT_REGISTRY_VERDICT=INDETERMINATE');
    process.exit(3);
  }
  // VACUITY GUARD 3 — a registry that intersects nothing it scanned is not describing this repo.
  const raisedAll = new Set([...raisedByFile.values()].flatMap((s) => [...s]));
  const overlap = [...raisedAll].filter((id) => registered.has(id)).length;
  if (overlap === 0) {
    console.log(`  registry has ${registered.size} rows but matches NONE of the ${raisedAll.size} raised ids`);
    console.log('ALERT_REGISTRY_VERDICT=INDETERMINATE');
    process.exit(3);
  }

  // ── SECOND SOURCE (CH2) — the inventory's DECLARED ids, unioned with what we can detect. ───
  let declared;
  try {
    declared = inventoryAlertIds(readFileSync(INVENTORY, 'utf8'));
  } catch (e) {
    // A source we cannot read is INDETERMINATE, never "the other source is enough". Falling back
    // to the call-site set alone is exactly the silent narrowing this pair exists to prevent.
    console.log(`  monitoring-inventory.json unreadable (${e.message}) — cannot form the union`);
    console.log('ALERT_SOURCE_DELTA_VERDICT=INDETERMINATE');
    console.log('ALERT_REGISTRY_VERDICT=INDETERMINATE');
    process.exit(3);
  }
  // VACUITY GUARD 4 — an inventory that declares no alert ids is a broken read, not a clean tree.
  if (declared.size === 0) {
    console.log('  monitoring-inventory.json declares ZERO alert ids — the second source is broken');
    console.log('ALERT_SOURCE_DELTA_VERDICT=INDETERMINATE');
    console.log('ALERT_REGISTRY_VERDICT=INDETERMINATE');
    process.exit(3);
  }

  const delta = sourceDelta(raisedAll, declared, registered);
  console.log(`  scanned ${raisedByFile.size} file(s); ${raisedAll.size} alert id(s) DETECTED at call sites; `
    + `${declared.size} DECLARED in monitoring-inventory.json; union ${delta.union.size}; ${registered.size} registered; ${overlap} matched`);
  const announced = rows.filter((r) => r.announce_resolution === true).length;
  console.log(`  adopted: ${rows.filter((r) => r.adopted === true).length} · announce_resolution: ${announced} (the rest resolve SILENTLY, which is the law's default)`);
  console.log(`  envelope_adopted: ${rows.filter((r) => r.envelope_adopted === true).length} of ${rows.length}`);

  // The delta is PRINTED whether or not it is a violation — a disagreement nobody sees is a
  // disagreement silently resolved.
  console.log(`  source delta: ${delta.onlyDetected.length} detected-only, ${delta.onlyDeclared.length} declared-only`);
  for (const id of delta.onlyDetected) console.log(`    · ${id} — raised at a call site, not declared on any inventory row`);
  for (const id of delta.onlyDeclared) console.log(`    · ${id} — declared on an inventory row, invisible to call-site detection`);

  // The delta's OWN verdict, with its own meaning: is the registry the UNION of both sources?
  // Distinct from ALERT_REGISTRY_VERDICT, which asks whether every raised id is registered.
  const deltaBad = delta.unregistered.length > 0;
  for (const id of delta.unregistered) console.log(`  ✗ ${id} is known to a source but ABSENT from the registry`);
  console.log(`ALERT_SOURCE_DELTA_VERDICT=${deltaBad ? 'FAIL' : 'PASS'}`);

  const missing = findUnregistered(raisedByFile, registered);
  const envBad = envelopeViolations(rows);
  for (const m of missing) console.log(`  ✗ ${m.id} raised in ${m.file} but ABSENT from the registry`);
  for (const v of envBad) console.log(`  ✗ ${v.id}: ${v.why}`);
  if (missing.length || envBad.length || deltaBad) {
    console.log('  add each to ops/monitoring/alert-registry.json with owner, hosts, adopted, follow_up_wave,');
    console.log('  and either envelope_adopted:true or an envelope_follow_up_wave naming the migrating wave');
    console.log('ALERT_REGISTRY_VERDICT=FAIL');
    process.exit(1);
  }
  console.log('ALERT_REGISTRY_VERDICT=PASS');
  process.exit(0);
}

function selfTest() {
  let fails = 0, checks = 0;
  const ck = (name, got, want) => { checks++; if (String(got) !== String(want)) { console.log(`  ✗ ${name} (got '${got}' want '${want}')`); fails++; } };

  ck('SHOUTY id from an assignment', [...extractAlertIds('ALERT_ID="FOO_BAR_BAZ"')][0], 'FOO_BAR_BAZ');
  ck('lowercase-kebab id is caught (x402-bazaar-delist class)', [...extractAlertIds('ALERT_ID = "x402-bazaar-delist"')][0], 'x402-bazaar-delist');
  ck('lowercase-snake id is caught (book_liveness_ceiling class)', [...extractAlertIds('ALERT_ID = "book_liveness_ceiling"')][0], 'book_liveness_ceiling');
  ck('positional shell call site', [...extractAlertIds('| "$SELF_DIR/send_telegram.sh" MY_ALERT CRITICAL_PERSISTENT -')][0], 'MY_ALERT');
  ck('python list form', [...extractAlertIds('subprocess.run([TG, "book_liveness_ceiling", "CRITICAL_PERSISTENT", "-"],')][0], 'book_liveness_ceiling');
  // The blind spot the prove-it-can-fail step found: invocation through a VARIABLE.
  ck('call site via a variable, not the literal filename', [...extractAlertIds('  | "$TG" TOTALLY_UNREGISTERED CRITICAL_PERSISTENT -')][0], 'TOTALLY_UNREGISTERED');
  ck('a severity ASSIGNMENT is not an id', extractAlertIds('SEVERITY="CRITICAL_PERSISTENT"').size, 0);
  ck('a bare severity mention is not an id', extractAlertIds('severity CRITICAL_PERSISTENT').size, 0);
  // The phantom this gate actually produced before comments were stripped.
  ck('a COMMENT mention is not an emission', extractAlertIds('  # DRIFT -> page (send_telegram.sh enforces CRITICAL_PERSISTENT + 24h cooldown').size, 0);
  ck('a function name is NOT an alert id', extractAlertIds('emit_verdict() {\n  breach_bump\n}').size, 0);
  ck('a file basename is NOT an alert id', extractAlertIds('WRAPPER=/opt/algovault-monitoring/send_telegram.sh').size, 0);

  const reg = new Set(['A_B']);
  ck('an unregistered id is reported', findUnregistered(new Map([['f.sh', new Set(['A_B', 'C_D'])]]), reg).length, 1);
  ck('a registered id is not reported', findUnregistered(new Map([['f.sh', new Set(['A_B'])]]), reg).length, 0);

  // ── OPS-MONITORING-SIGNAL-CONTRACT-W1 CH2 — the SECOND SOURCE and its own verdict. ─────────
  const INV = JSON.stringify({ artifacts: [
    { id: 'a', alert_ids: ['DETECTED_AND_DECLARED', 'DECLARED_ONLY'] },
    { id: 'b', alert_ids: [] },
    { id: 'c' },
  ] });
  ck('inventory ids are extracted from every row', inventoryAlertIds(INV).size, 2);
  ck('a row with no alert_ids contributes nothing', inventoryAlertIds(INV).has(undefined), false);

  const detected = new Set(['DETECTED_AND_DECLARED', 'DETECTED_ONLY']);
  const declaredSet = inventoryAlertIds(INV);
  const dAll = sourceDelta(detected, declaredSet, new Set(['DETECTED_AND_DECLARED', 'DETECTED_ONLY', 'DECLARED_ONLY']));
  ck('the union is BOTH sources, not the smaller one', dAll.union.size, 3);
  ck('a detected-only id is named', dAll.onlyDetected.join(','), 'DETECTED_ONLY');
  ck('a declared-only id is named', dAll.onlyDeclared.join(','), 'DECLARED_ONLY');
  ck('sources that differ are reported as NOT agreeing', dAll.agree, false);
  ck('a fully-registered union leaves nothing unregistered', dAll.unregistered.length, 0);
  // THE MEASURED MISS, as a fixture: an id only the inventory knows, absent from the registry.
  // Before the union this was invisible and the gate reported PASS — it is what let
  // DIRECTIONAL_LABEL_CAPACITY_SHORTFALL go unregistered while the wave it commissioned ran.
  const dMiss = sourceDelta(detected, declaredSet, new Set(['DETECTED_AND_DECLARED', 'DETECTED_ONLY']));
  ck('a declared-only id missing from the registry IS caught', dMiss.unregistered.join(','), 'DECLARED_ONLY');
  ck('identical sources agree', sourceDelta(new Set(['X_Y']), new Set(['X_Y']), new Set(['X_Y'])).agree, true);

  ck('an unadopted row with no follow-up wave is a violation',
    envelopeViolations([{ alert_id: 'A_B', envelope_adopted: false }]).length, 1);
  ck('an unadopted row that NAMES its migrating wave is fine',
    envelopeViolations([{ alert_id: 'A_B', envelope_adopted: false, envelope_follow_up_wave: 'OPS-X-W{NEXT}' }]).length, 0);
  ck('an adopted row is fine', envelopeViolations([{ alert_id: 'A_B', envelope_adopted: true }]).length, 0);
  ck('an adopted row still carrying a pending owner is a violation',
    envelopeViolations([{ alert_id: 'A_B', envelope_adopted: true, envelope_follow_up_wave: 'OPS-X-W{NEXT}' }]).length, 1);
  ck('a MISSING envelope_adopted is treated as not-adopted, never as adopted',
    envelopeViolations([{ alert_id: 'A_B' }]).length, 1);

  // The real registry must be present, non-empty and cover the live tree — a self-test that
  // passes against fixtures while the real corpus is broken is the vacuity this repo keeps
  // retiring, so assert the ARTIFACT too, not just the functions.
  checks++;
  if (!existsSync(REGISTRY)) { console.log('  ✗ the real registry file is missing'); fails++; }
  else {
    const rows = JSON.parse(readFileSync(REGISTRY, 'utf8')).alerts ?? [];
    ck('the real registry is non-empty', rows.length > 0, true);
    ck('every row carries an alert_id', rows.every((r) => typeof r.alert_id === 'string' && r.alert_id), true);
    ck('every row carries an owner', rows.every((r) => typeof r.owner === 'string' && r.owner), true);
    ck('every unadopted row names a follow-up wave', rows.filter((r) => !r.adopted).every((r) => typeof r.follow_up_wave === 'string'), true);
    ck('announce_resolution defaults to false', rows.filter((r) => r.announce_resolution === true).length < rows.length, true);
    ck('a templated follow-up wave, never a literal W<n>', rows.filter((r) => r.follow_up_wave && /-W\d+$/.test(r.follow_up_wave)).length, 0);
  }
  ck('the not-a-caller exclusion list stays at exactly 2', NOT_A_CALLER.size, 2);
  ck('the wrapper itself is excluded (it delivers, never raises)', NOT_A_CALLER.has('ops/monitoring/send_telegram.sh'), true);
  checks++;
  if (checks < 12) { console.log(`  ✗ only ${checks} checks — vacuity guard`); fails++; }

  if (fails) { console.log(`SELF-TEST: FAIL — ${fails} of ${checks}`); console.log('ALERT_REGISTRY_VERDICT=FAIL'); process.exit(1); }
  console.log(`SELF-TEST: PASS — ${checks} checks (structural extraction incl. lowercase ids, comment/function/basename rejection, registry shape, vacuity guards)`);
  console.log('ALERT_REGISTRY_VERDICT=PASS');
  process.exit(0);
}

// MAIN GUARD. Without it, `import { extractAlertIds } from './check-alert-registry.mjs'` executes
// run() at load and exits the importing process — the importer's own tests never run and the file
// reports green on 1 test instead of 8. That is not hypothetical: it is the defect this wave found
// in check-alert-recommended-wave.mjs (where it had hidden 5 of 6 tests, one of them RED), and it
// was reproduced here verbatim within the hour. An exported-for-reuse module with a bare
// top-level side effect is the trap; the guard is the whole fix.
const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (IS_MAIN) {
  if (process.argv.includes('--self-test')) selfTest();
  else run();
}
