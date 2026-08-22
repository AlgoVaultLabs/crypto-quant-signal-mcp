#!/usr/bin/env node
/**
 * monitoring-census.mjs — OPS-MONITORING-SIGNAL-CONTRACT-W1 CH1.
 *
 * SCORES EVERY MONITORING DETECTOR AGAINST THE FOUR `DETECTOR_ENVELOPE` PROPERTIES, SO THE
 * DECISION TO MANDATE A CONTRACT IS A MEASUREMENT AND NOT AN IMPRESSION.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 * `OPS-LABEL-CAPACITY-TRIAGE-W1` found `detectCapacityShortfall` publishing a structural capacity
 * verdict from a run SIGTERM'd at 46.6 of 210 minutes. One defective detector justifies a lane
 * fix, not a contract. This census measures how many detectors share the defect — and it is
 * allowed to CANCEL CH2 by finding fewer than three.
 *
 * ── THIS SCRIPT OBEYS THE CONTRACT IT MEASURES ──────────────────────────────────────────────
 * A census that cannot say "I could not read that" would be committing, one level up, the exact
 * defect it exists to catch. So every property returns one of `pass` / `fail` / `n-a` /
 * `indeterminate`, `indeterminate` is never silently folded into a pass, and the run emits
 * exactly one terminal `MONITORING_CENSUS_VERDICT=PASS|FAIL|INDETERMINATE`.
 *
 * Verdict contract: exactly one terminal MONITORING_CENSUS_VERDICT=PASS|FAIL|INDETERMINATE.
 * Exit 0=PASS / 1=FAIL / 3=INDETERMINATE (3 is the token-law default for a new gate).
 * Callers gate on the TOKEN, never the code.
 *
 *   PASS          every enumerated detector was read and scored on all four properties
 *   FAIL          >=1 inventory-declared detector artifact is ABSENT from the tree, so the
 *                 enumeration is provably incomplete and no census over it can be trusted
 *   INDETERMINATE vacuity — no detectors found, or the inventory / alert-registry is unreadable
 *
 * The SIZING verdict is a SEPARATE line (`CENSUS_SIZING=...`) precisely because "the class is
 * real" is not a health verdict about this repo: overloading one token with two meanings is the
 * defect this whole wave retires.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './check-alert-recommended-wave.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/** Directories that hold host-installed monitoring code. */
export const DETECTOR_DIRS = ['ops/monitoring', 'ops/cron'];
/** Where marker-writing producers live (source S3). */
export const PRODUCER_DIR = 'src/scripts';
const CODE_EXT = /\.(sh|py|mjs|cjs|js)$/i;

/**
 * NOT DETECTORS — the SHORT hand-list, for artifacts the behavioural test below cannot exclude.
 * Exemptions live in DATA with a REASON ON EACH ROW, never in prose — an exemption that lives
 * only in a comment gets "fixed" by a future wave enforcing the contract. Every entry is printed
 * on every run, so an exclusion can never be silent.
 *
 * The `test-*` rows are the ratified definition's own example: a harness pages nobody, and
 * counting the three of them would let the >=3 sizing gate clear on artifacts that cannot page.
 * They need an explicit row precisely BECAUSE they invoke the transport (in test mode), so the
 * behavioural test would otherwise admit them.
 */
export const NOT_A_DETECTOR = new Map([
  ['send_telegram.sh', 'the alert TRANSPORT every detector calls — it emits no verdict of its own'],
  ['test-directional-label-freshness.py', 'test harness for a detector — pages nobody'],
  ['test-registry-conformance-canary.py', 'test harness for a detector — pages nobody'],
  ['test-website-drift-canary.py', 'test harness for a detector — pages nobody'],
]);

/**
 * THE DETECTOR TEST, DERIVED FROM BEHAVIOUR RATHER THAN FROM A HAND-LIST.
 *
 * The ratified definition is "an artifact that emits an operator-visible signal a human acts on",
 * and the only way an artifact in this estate reaches an operator is the Telegram transport. So
 * a detector is code that INVOKES THAT TRANSPORT — the same derivation `check-declaration-
 * coverage.mjs` uses ("a file is a declaration because something reads it, full stop"), and for
 * the same reason: a hand-list inherits whoever maintained it, and this population contains
 * installers, deploy tools, libraries, snapshot producers and inert declarations that no hand-
 * list would reliably separate.
 *
 * Call sites are matched through a VARIABLE too (`$WRAPPER`, `$TG`), because the measured blind
 * spot in `check-alert-registry.mjs` is exactly that shape.
 */
export function emitsAnOperatorSignal(source) {
  // (a) It calls the transport itself. Comments stripped FIRST: a transport named in prose is
  // documentation, not a call — the same lesson `check-alert-registry.mjs` records after a
  // comment manufactured a phantom alert id.
  if (/send_telegram|sendDigest|\$\{?WRAPPER\}?|\$\{?TG\}?\b|CRITICAL_PERSISTENT|LF_WRAPPER/.test(stripComments(source))) return true;
  // (b) OR it signals through a DOCUMENTED multi-state exit contract, and a wrapper pages on it.
  // `postgres-cpu-autopilot.py` is the estate's example (0=silent / 1=escalate / 2=critical-
  // bypass / 3=framework-error): it never touches the transport, and it is unambiguously a
  // detector. Requiring a literal transport call would have dropped it — measured on this
  // script's own second run, which is why the test is a UNION and not the first clause alone.
  return scoreVerdict(source).form === 'exit-code-only';
}

function listFiles(root, rel) {
  const dir = path.join(root, rel);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((n) => ({ name: n, rel: path.join(rel, n), abs: path.join(dir, n) }));
}

function readOrNull(p) {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

/** 1-indexed line of the first match, or null. Used for every `<file>:<line>` citation. */
export function lineOf(source, re) {
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return null;
}

/** A comment line, per language. Prose in a comment is documentation, not behaviour. */
const COMMENT = /^\s*(#|\/\/|\*|\/\*)/;

// ── PROPERTY 1 — `verdict` ────────────────────────────────────────────────────────────────────
/**
 * Can it emit a DISTINGUISHABLE third state?
 *   token          emits `<NAME>_VERDICT=` AND names INDETERMINATE      -> pass, strongest form
 *   exit-code-only documents >=3 distinct exit codes in its own header  -> pass, WEAKER form
 *   missing        neither                                             -> fail
 *
 * `exit-code-only` counts as passing because the manual's property is DISTINGUISHABILITY, not the
 * literal emission of a string. It is scored separately because an exit code is lossy through
 * shell composition (`|| true`, cron wrappers, pipelines) — which is exactly why the law says
 * callers gate on the TOKEN. Recording the distinction stops CH2 laundering the weaker mechanism
 * as equivalent, and hands a future wave the upgrade list.
 */
export function scoreVerdict(source) {
  const emits = /[A-Z][A-Z0-9_]*_VERDICT\s*=/.test(source);
  const names = /INDETERMINATE/.test(source);
  if (emits && names) {
    return { state: 'pass', form: 'token', line: lineOf(source, /[A-Z][A-Z0-9_]*_VERDICT\s*=/), reason: 'emits a verdict token naming INDETERMINATE' };
  }
  if (emits && !names) {
    return { state: 'fail', form: 'token-without-third-state', line: lineOf(source, /[A-Z][A-Z0-9_]*_VERDICT\s*=/), reason: 'emits a verdict token but never names INDETERMINATE — "measured clean" and "measured nothing" share an output' };
  }
  // A documented exit-code contract, in EITHER of the two shapes this estate actually uses:
  //   (a) NAMED constants — `EXIT_ESCALATE = 1`, `EXIT_CRITICAL_BYPASS = 2`, ... ; or
  //   (b) one comment line naming >=3 distinct single-digit codes.
  // Shape (a) was added after the narrow (b)-only version DROPPED `postgres-cpu-autopilot.py`,
  // the estate's canonical exit-code detector and the spec's own worked example. A signal that
  // misses the one artifact a rule was written around is the rule measuring itself.
  const named = new Set([...source.matchAll(/^\s*(EXIT_[A-Z_]+)\s*=\s*(\d+)/gm)].map((m) => m[2]));
  if (named.size >= 3) {
    return { state: 'pass', form: 'exit-code-only', line: lineOf(source, /^\s*EXIT_[A-Z_]+\s*=\s*\d+/),
      reason: `defines ${named.size} distinct named exit codes — distinguishable, but lossy through shell composition` };
  }
  for (const [i, l] of source.split('\n').entries()) {
    if (!COMMENT.test(l) || !/exit/i.test(l)) continue;
    const codes = new Set((l.match(/\b[0-3]\s*=/g) || []).map((m) => m[0]));
    if (codes.size >= 3) {
      return { state: 'pass', form: 'exit-code-only', line: i + 1, reason: `documents ${codes.size} distinct exit codes — distinguishable, but lossy through shell composition` };
    }
  }
  return { state: 'fail', form: 'missing', line: null, reason: 'no verdict token and no documented multi-state exit contract — a fail-open run is indistinguishable from a clean one' };
}

// ── PROPERTY 2 — `run_outcome` ────────────────────────────────────────────────────────────────
/** Does it read a PRODUCER's run at all? If not, there is no run to summarise and P2 is n-a. */
export function summarisesAProducerRun(source) {
  return /\/var\/log\/|subprocess\.run\(|execSync|spawnSync|MAX\(|read_text\(/.test(source);
}
/**
 * Does it read whether that run COMPLETED? This is D1's missing property: the freshness canary
 * forwards a marker without ever asking whether the run that wrote it finished.
 */
export function scoreRunOutcome(source) {
  if (!summarisesAProducerRun(source)) {
    return { state: 'n-a', line: null, reason: 'measures live state directly; it summarises no producer run' };
  }
  const re = /\boutcome\b|returncode|exit_code|exitcode|\bcompleted\b|\bstopped\b|truncat|SIGTERM|\bDONE\b/;
  if (re.test(source)) {
    return { state: 'pass', line: lineOf(source, re), reason: 'reads a completion discriminator of the run it summarises' };
  }
  return { state: 'fail', line: lineOf(source, /\/var\/log\/|subprocess\.run\(|MAX\(/), reason: 'summarises a producer run without reading whether that run completed — a truncated run is scored as a finished one' };
}

// ── PROPERTY 3 — `run_id` + `produced_at` ────────────────────────────────────────────────────
/**
 * Can a consumer tell it is reading THIS run's signal? Requires BOTH a run identity and a
 * production timestamp; either alone cannot bind a signal to a run. This is D3's missing
 * property — a 3h33m-old marker forwarded verbatim as current.
 */
export function scoreRunIdentity(source) {
  const idRe = /run_id|run_started|started_at|\brun_uuid\b/;
  const tsRe = /produced_at|generated_at|\bas_of\b|max_age|MAX_AGE|stale_after/;
  const hasId = idRe.test(source);
  const hasTs = tsRe.test(source);
  if (hasId && hasTs) return { state: 'pass', line: lineOf(source, idRe), reason: 'binds its signal to a run id and a production timestamp' };
  const missing = [!hasId && 'run_id', !hasTs && 'produced_at/max-age'].filter(Boolean).join(' + ');
  return { state: 'fail', line: null, reason: `no ${missing} — a consumer cannot tell this run's signal from an older one` };
}

// ── PROPERTY 4 — `evidence` ───────────────────────────────────────────────────────────────────
/**
 * Does the alert body render MEASURED VALUES, or hardcoded prose about mechanism? This is D2:
 * "SLO-ordered, so majors were served first" describes the inverse of the code and was never true.
 *
 * Signal: a NON-COMMENT string literal of >=8 words carrying ZERO interpolation is mechanism
 * prose. Interpolation is `{...}` (python f-string), `${...}` (js/sh), or `%s`.
 */
export function proseLiterals(source) {
  const out = [];
  for (const [i, l] of source.split('\n').entries()) {
    if (COMMENT.test(l)) continue;
    for (const m of l.matchAll(/"([^"\\]{40,})"|'([^'\\]{40,})'/g)) {
      const lit = m[1] ?? m[2];
      if (/\{[^}]*\}|\$\{|%s/.test(lit)) continue;          // interpolated -> rendered, not prose
      if (lit.split(/\s+/).filter(Boolean).length < 8) continue;
      if (!/[a-z]{3}\s+[a-z]{3}/.test(lit)) continue;        // must read like a sentence
      out.push({ line: i + 1, literal: lit });
    }
  }
  return out;
}
export function scoreEvidence(source) {
  const prose = proseLiterals(source);
  const interpolates = /f"|f'|\$\{|%s|\.format\(/.test(source);
  if (prose.length > 0) {
    return { state: 'fail', line: prose[0].line, reason: `${prose.length} hardcoded mechanism sentence(s) in the emitted body — e.g. "${prose[0].literal.slice(0, 60)}…"` };
  }
  if (!interpolates) {
    return { state: 'fail', line: null, reason: 'emits no interpolated values at all — nothing in its output is a measurement' };
  }
  return { state: 'pass', line: null, reason: 'body is built from interpolated measured values' };
}

// ── ENUMERATION — three sources, unioned, never sampled ──────────────────────────────────────
/**
 * S3: a `src/scripts/*.ts` producer counts when it writes a bracket marker that a host-side
 * consumer actually reads. Derived from CONSUMPTION, not from a hand-list — the same derivation
 * `check-declaration-coverage.mjs` uses, and for the same reason.
 */
export function markerProducers(root, consumerBodies) {
  const out = [];
  for (const f of listFiles(root, PRODUCER_DIR)) {
    if (!/\.ts$/.test(f.name)) continue;
    const src = readOrNull(f.abs);
    if (src === null) continue;
    for (const m of src.matchAll(/`\[([a-z][a-z0-9-]{3,})\]/g)) {
      const marker = `[${m[1]}]`;
      const readers = consumerBodies.filter((b) => b.body.includes(marker)).map((b) => b.name);
      if (readers.length) { out.push({ name: f.name, rel: f.rel, abs: f.abs, marker, readers }); break; }
    }
  }
  return out;
}

export function enumerateDetectors(root) {
  const invRaw = readOrNull(path.join(root, 'ops/monitoring/monitoring-inventory.json'));
  const regRaw = readOrNull(path.join(root, 'ops/monitoring/alert-registry.json'));
  if (invRaw === null) return { fatal: 'monitoring-inventory.json is unreadable' };
  if (regRaw === null) return { fatal: 'alert-registry.json is unreadable' };
  let inv; let reg;
  try { inv = JSON.parse(invRaw).artifacts; } catch { return { fatal: 'monitoring-inventory.json is not parseable JSON' }; }
  try { reg = JSON.parse(regRaw).alerts; } catch { return { fatal: 'alert-registry.json is not parseable JSON' }; }

  // S1 — every executable under the detector dirs.
  const s1 = DETECTOR_DIRS.flatMap((d) => listFiles(root, d)).filter((f) => CODE_EXT.test(f.name));
  const consumerBodies = s1.map((f) => ({ name: f.name, body: readOrNull(f.abs) || '' }));
  // S3 — marker producers whose marker a consumer reads.
  const s3 = markerProducers(root, consumerBodies);

  // S2 — inventory rows. Their `artifact` path is how a row names code.
  //
  // Three classes, and collapsing them is how a census manufactures a false FAIL (measured on
  // this script's own first run — H5 applies to the instrument too):
  //   · inert DATA declarations (.json/.yaml) — not detectors, they page nobody;
  //   · `external:` rows — code owned by ANOTHER repo, absent from this tree BY DESIGN;
  //   · repo-relative CODE that is genuinely absent — the only class that makes the
  //     enumeration provably incomplete, and therefore the only one that may FAIL.
  const invByArtifact = new Map();
  const missingArtifacts = [];
  const outOfTree = [];
  const dataDeclarations = [];
  for (const r of inv) {
    if (!r.artifact) continue;
    // Out of tree = an explicit `external:` marker, OR a path whose top-level directory does not
    // exist in this repo at all (the AOE repo's vendored `monitoring/aoe-host/**`). Both are
    // absent BY DESIGN; scoring them as "missing" manufactures a FAIL out of correct state.
    const top = r.artifact.split('/')[0];
    if (r.artifact.startsWith('external:') || !existsSync(path.join(root, top))) {
      outOfTree.push({ id: r.id, artifact: r.artifact }); continue;
    }
    if (!CODE_EXT.test(r.artifact) && !/\.ts$/.test(r.artifact)) { dataDeclarations.push({ id: r.id, artifact: r.artifact }); continue; }
    invByArtifact.set(path.basename(r.artifact), r);
    if (!existsSync(path.join(root, r.artifact))) missingArtifacts.push({ id: r.id, artifact: r.artifact });
  }

  const alertOwners = new Map();
  for (const a of reg) {
    const k = path.basename(a.owner || '');
    if (!k) continue;
    if (!alertOwners.has(k)) alertOwners.set(k, []);
    alertOwners.get(k).push(a.alert_id);
  }

  const detectors = [];
  const excluded = [];
  for (const f of [...s1, ...s3]) {
    if (NOT_A_DETECTOR.has(f.name)) { excluded.push({ name: f.name, reason: NOT_A_DETECTOR.get(f.name) }); continue; }
    // S3 members qualify by their OWN rule (a marker a host consumer reads reaches the operator
    // through that consumer), so the transport test does not apply to them.
    if (!f.marker) {
      const body = readOrNull(f.abs);
      if (body === null) { excluded.push({ name: f.name, reason: 'unreadable' }); continue; }
      if (!emitsAnOperatorSignal(body)) {
        excluded.push({ name: f.name, reason: 'never invokes the alert transport — a tool, library or producer, not a detector' });
        continue;
      }
    }
    const row = invByArtifact.get(f.name);
    detectors.push({
      name: f.name,
      rel: f.rel,
      abs: f.abs,
      source: f.marker ? 'S3 marker-producer' : (row ? 'S1+S2' : 'S1'),
      marker: f.marker || null,
      readers: f.readers || null,
      criticality: row?.criticality ?? '(no inventory row)',
      inventoryAlertIds: row?.alert_ids ?? [],
      registryAlertIds: alertOwners.get(f.name) ?? [],
    });
  }
  // S2 rows naming an artifact outside the scanned dirs are still part of the population.
  for (const [base, row] of invByArtifact) {
    if (detectors.some((d) => d.name === base) || NOT_A_DETECTOR.has(base)) continue;
    if (!existsSync(path.join(root, row.artifact))) continue;
    const body = readOrNull(path.join(root, row.artifact));
    if (body === null || !emitsAnOperatorSignal(body)) {
      excluded.push({ name: base, reason: 'never invokes the alert transport — a tool, library or producer, not a detector' });
      continue;
    }
    detectors.push({
      name: base, rel: row.artifact, abs: path.join(root, row.artifact),
      source: 'S2 inventory-only', marker: null, readers: null,
      criticality: row.criticality ?? '(unset)',
      inventoryAlertIds: row.alert_ids ?? [], registryAlertIds: alertOwners.get(base) ?? [],
    });
  }
  detectors.sort((a, b) => a.name.localeCompare(b.name));
  const seenEx = new Set();
  const excludedUniq = excluded.filter((x) => (seenEx.has(x.name) ? false : seenEx.add(x.name)));
  excludedUniq.sort((a, b) => a.name.localeCompare(b.name));
  return { detectors, excluded: excludedUniq, missingArtifacts, outOfTree, dataDeclarations, invCount: inv.length, regCount: reg.length, s1: s1.length, s3: s3.length };
}

export function scoreDetector(source) {
  return {
    verdict: scoreVerdict(source),
    run_outcome: scoreRunOutcome(source),
    run_identity: scoreRunIdentity(source),
    evidence: scoreEvidence(source),
  };
}

const PROPS = ['verdict', 'run_outcome', 'run_identity', 'evidence'];

export function evaluate(root) {
  const e = enumerateDetectors(root);
  if (e.fatal) return { verdict: 'INDETERMINATE', reason: e.fatal };
  if (e.detectors.length === 0) {
    return { verdict: 'INDETERMINATE', reason: `no detectors under ${DETECTOR_DIRS.join(', ')}/ — the glob is broken, not the tree` };
  }
  const rows = [];
  const unreadable = [];
  for (const d of e.detectors) {
    const src = readOrNull(d.abs);
    if (src === null) { unreadable.push(d.rel); continue; }
    const scores = scoreDetector(src);
    rows.push({ ...d, scores, fails: PROPS.filter((p) => scores[p].state === 'fail') });
  }
  if (unreadable.length) {
    return { verdict: 'INDETERMINATE', reason: `${unreadable.length} enumerated detector(s) could not be read: ${unreadable.join(', ')}` };
  }
  const failingAll = rows.filter((r) => r.fails.length > 0);
  if (e.missingArtifacts.length) {
    return {
      verdict: 'FAIL', rows, failing: failingAll, classEstablished: failingAll.length >= 3, ...e,
      reason: `${e.missingArtifacts.length} inventory row(s) name an artifact absent from the tree — the enumeration is provably incomplete: `
        + e.missingArtifacts.map((m) => `${m.id} -> ${m.artifact}`).join(', '),
    };
  }
  return { verdict: 'PASS', rows, failing: failingAll, ...e, classEstablished: failingAll.length >= 3 };
}

const GLYPH = { pass: 'PASS', fail: 'FAIL', 'n-a': 'n-a ', indeterminate: 'INDT' };

function emit(r) {
  if (r.verdict === 'INDETERMINATE') {
    console.log(`monitoring-census: INDETERMINATE — ${r.reason}`);
    console.log('MONITORING_CENSUS_VERDICT=INDETERMINATE');
    return 3;
  }
  console.log(`monitoring-census: ${r.rows.length} detector(s) — S1 ${r.s1} file(s) under ${DETECTOR_DIRS.join(' + ')}, `
    + `S2 ${r.invCount} inventory row(s), S3 ${r.s3} marker-producer(s); ${r.regCount} alert-registry row(s)`);
  console.log(`  not scored: ${r.excluded.length} non-detector(s), ${r.dataDeclarations.length} inert data declaration(s), `
    + `${r.outOfTree.length} external: row(s) owned by another repo`);
  console.log('');
  for (const x of r.excluded) console.log(`  · EXCLUDED ${x.name.padEnd(38)} ${x.reason}`);
  console.log('');
  console.log(`  ${'detector'.padEnd(38)} ${'verdict'.padEnd(6)} ${'form'.padEnd(15)} ${'r_out'.padEnd(6)} ${'r_id'.padEnd(6)} ${'evid'.padEnd(6)} criticality`);
  for (const d of r.rows) {
    const s = d.scores;
    console.log(`  ${d.fails.length ? '✗' : '✓'} ${d.name.padEnd(36)} ${GLYPH[s.verdict.state].padEnd(6)} ${s.verdict.form.padEnd(15)} `
      + `${GLYPH[s.run_outcome.state].padEnd(6)} ${GLYPH[s.run_identity.state].padEnd(6)} ${GLYPH[s.evidence.state].padEnd(6)} ${d.criticality}`);
  }
  const lb = r.failing.filter((d) => d.criticality === 'load-bearing').length;
  console.log('');
  console.log(`  ${r.failing.length}/${r.rows.length} detector(s) fail >=1 property (${lb} load-bearing)`);
  console.log(`CENSUS_SIZING=${r.classEstablished ? 'CLASS_ESTABLISHED' : 'CLASS_NOT_ESTABLISHED'}`);
  if (r.verdict === 'FAIL') {
    console.log(`  ✗ ${r.reason}`);
    console.log('MONITORING_CENSUS_VERDICT=FAIL');
    return 1;
  }
  console.log('MONITORING_CENSUS_VERDICT=PASS');
  return 0;
}

/** Two-way self-test: a known-good fixture must PASS and a known-bad one must FAIL, per property. */
function selfTest() {
  let bad = 0;
  const ck = (label, got, want) => {
    const ok = got === want;
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${label} — got ${got}, want ${want}`);
  };
  const GOOD = [
    '# Exit: 0 = evaluated · 3 = INDETERMINATE',
    'run_id = argv[1]; produced_at = utcnow()',
    'r = subprocess.run(cmd); outcome = r.returncode',
    'body = f"lag={lag}h slo={slo}h venues={n}"',
    'print("MY_VERDICT=%s" % ("FAIL" if bad else "PASS"))',
    'print("MY_VERDICT=INDETERMINATE")',
  ].join('\n');
  const BAD = [
    'lines = Path("/var/log/x.log").read_text().splitlines()',
    'marker = next(l for l in lines if "[capacity-shortfall]" in l)',
    'body = "\\n".join([',
    '    "SLO-ordered, so majors were served first; the shortfall is the long-tail overflow.",',
    '    detail])',
    'subprocess.run([wrapper, "MY_ALERT", "CRITICAL_PERSISTENT", "-"], input=body)',
  ].join('\n');
  console.log('monitoring-census --self-test');
  ck('GOOD verdict', scoreVerdict(GOOD).state, 'pass');
  ck('GOOD run_outcome', scoreRunOutcome(GOOD).state, 'pass');
  ck('GOOD run_identity', scoreRunIdentity(GOOD).state, 'pass');
  ck('GOOD evidence', scoreEvidence(GOOD).state, 'pass');
  ck('BAD  verdict', scoreVerdict(BAD).state, 'fail');
  ck('BAD  run_outcome', scoreRunOutcome(BAD).state, 'fail');
  ck('BAD  run_identity', scoreRunIdentity(BAD).state, 'fail');
  ck('BAD  evidence', scoreEvidence(BAD).state, 'fail');
  ck('BAD  is a detector (calls the transport)', emitsAnOperatorSignal(BAD), true);
  // The n-a branch must be REACHABLE, or P2 silently becomes a two-state property.
  ck('live-state detector run_outcome', scoreRunOutcome('x = requests.get(url).status_code').state, 'n-a');
  // exit-code-only must be scored as a DISTINCT form, not laundered as a token.
  ck('exit-code-only form (comment shape)', scoreVerdict('# exit codes 0=silent / 1=escalate / 2=bypass / 3=framework-error').form, 'exit-code-only');
  // The NAMED-constant shape is what postgres-cpu-autopilot.py actually uses; the comment-only
  // signal dropped it, so this case exists to stop that regressing.
  const NAMED = 'EXIT_SILENT = 0\nEXIT_ESCALATE = 1\nEXIT_CRITICAL_BYPASS = 2\nEXIT_FRAMEWORK_ERROR = 3';
  ck('exit-code-only form (named-constant shape)', scoreVerdict(NAMED).form, 'exit-code-only');
  ck('exit-code contract makes it a DETECTOR without a transport call', emitsAnOperatorSignal(NAMED), true);
  // A transport named only in a COMMENT is documentation, not a call.
  ck('transport mentioned in a comment is not a call', emitsAnOperatorSignal('# routes via send_telegram.sh'), false);
  console.log(bad === 0 ? 'MONITORING_CENSUS_VERDICT=PASS' : 'MONITORING_CENSUS_VERDICT=FAIL');
  return bad === 0 ? 0 : 1;
}

function cite(r) {
  if (r.verdict === 'INDETERMINATE') { console.log(`INDETERMINATE — ${r.reason}`); return 3; }
  for (const d of r.rows) {
    for (const p of PROPS) {
      const sc = d.scores[p];
      if (sc.state !== 'fail') continue;
      console.log(`${d.rel}${sc.line ? ':' + sc.line : ''}\t${p}\t${d.criticality}\t${sc.reason}`);
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const mode = process.argv.includes('--self-test') ? selfTest
    : process.argv.includes('--cite') ? () => cite(evaluate(REPO)) : () => emit(evaluate(REPO));
  process.exit(mode());
}
