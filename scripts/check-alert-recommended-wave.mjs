#!/usr/bin/env node
/**
 * check-alert-recommended-wave.mjs — OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W1 R3
 *
 * ONE ALERT ID, ONE REMEDY.
 *
 * On 2026-08-01 a correct detector fired and told the operator to run the wave that would have
 * RATIFIED the fault it had just detected. `CLOSEDBAR_DISPATCH_RATCHET_REGRESSION` had inherited
 * the `recommended_wave` of the READINESS alert (`CANDLE_BASIS_FLIP_READY`) — one wave shared by
 * two alerts whose remedies are opposites. A detector that points at the wrong action is worse
 * than no detector, because the operator acts on it.
 *
 * This is the same class CLAUDE.md already codifies for alert BODIES ("an entity ID in an alert
 * body carries its entity noun"): the alert rendered correctly and still misled. So the check is
 * structural, not cosmetic.
 *
 * ── What it asserts, per alert-emitting artifact ─────────────────────────────
 *   1. Every `recommended_wave` is TEMPLATED (`W{NEXT}`), never a literal wave number.
 *   2. No two DISTINCT alert ids resolve to the SAME wave, unless the sharing line carries an
 *      explicit `alert-wave-exempt:` comment saying why.
 *
 * Verdict token contract (CLAUDE.md): exactly one terminal
 * `ALERT_WAVE_VERDICT=PASS|FAIL|INDETERMINATE` line, and callers gate on the TOKEN. Codes are
 * 0=PASS / 1=FAIL / 3=INDETERMINATE — 3 is the token-law default for a NEW gate (only
 * check_test_baseline.sh is 2, because it already deployed 2 for that meaning).
 *
 * `--self-test` is hermetic, two-way and vacuity-guarded.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

/** Artifacts that emit operator-facing alerts and therefore carry a recommended wave. */
const SCANNED = [
  'ops/monitoring/closedbar-w1-liveness.sh',
  'ops/cron/candle-basis-shadow-report.sh',
  'ops/cron/bot-deploy-parity.sh',
];

const WAVE_RE = /\b(?:OPS|SIGNAL|RELEASE|DEV|TG|GEO)-[A-Z0-9-]*?-W(?:\{NEXT\}|\d+)/g;
const LITERAL_WAVE_RE = /\b(?:OPS|SIGNAL|RELEASE|DEV|TG|GEO)-[A-Z0-9-]*?-W\d+\b/;
const EXEMPT_RE = /alert-wave-exempt:/;

/**
 * Alert ids are SHOUTY_SNAKE tokens that appear as a send_telegram.sh argument or as the alert's
 * headline. Comment lines are stripped first — a mention in prose is not an emission, the same
 * reason `check-canaries-wired.mjs` strips comments before its own grep.
 */
export function stripComments(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const ID_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/g;

/**
 * Pair each alert id with the wave it RECOMMENDS. Two extractors, because there are two real
 * shapes and a line-proximity heuristic gets both wrong:
 *
 *   (a) INLINE — `printf '🛑 SOME_ALERT_ID … Action: dispatch OPS-X-W{NEXT}'`. Only a wave
 *       following `Action: dispatch` counts. A `Rollback: see status.md SIGNAL-…-W1` on the
 *       same line is a documentation pointer, NOT a recommendation; an earlier draft of this
 *       check paired it with `OFFSET_PCT` (from `OFFSET_PCT=75` in the same printf) and
 *       reported a violation that did not exist.
 *
 *   (b) CASE-MAPPED — `alert_id_for()` and `recommended_wave_for()` are two `case` statements
 *       keyed by the SAME verdict tokens. The pairing is the shared key, so they are joined on
 *       it rather than guessed at from adjacency.
 */
export function extractPairs(text) {
  const body = stripComments(text);
  const out = [];

  // (a) inline emissions
  body.split('\n').forEach((raw, i) => {
    const m = raw.match(/Action:\s*dispatch\s+((?:OPS|SIGNAL|RELEASE|DEV|TG|GEO)-[A-Z0-9-]*?-W(?:\{NEXT\}|\d+))/);
    if (!m) return;
    const ids = raw.match(ID_RE) ?? [];
    // The alert id is the headline token — the first SHOUTY token that is not part of the wave.
    const id = ids.find((t) => !m[1].includes(t));
    if (id) out.push({ id, wave: m[1], line: i + 1, raw });
  });

  // (b) case-mapped emissions, joined on the shared case key
  const caseMap = (fnName) => {
    const fn = new RegExp(`${fnName}\\s*\\(\\)\\s*\\{\\n([\\s\\S]*?)\\n\\}`, 'm').exec(body);
    const map = new Map();
    if (!fn) return map;
    for (const line of fn[1].split('\n')) {
      const k = line.match(/^\s*([A-Z_]+)\)\s*printf\s+'([^']+)'/);
      if (k) map.set(k[1], k[2]);
    }
    return map;
  };
  const ids = caseMap('alert_id_for');
  const waves = caseMap('recommended_wave_for');
  for (const [key, wave] of waves) {
    // Two real shapes, both in this tree:
    //   (i)  an `alert_id_for` case keyed by the same verdict token — join on the key
    //        (closedbar-w1-liveness.sh: RATCHET -> CLOSEDBAR_DISPATCH_RATCHET_REGRESSION)
    //   (ii) no `alert_id_for` at all, because the case KEY already IS the alert id
    //        (bot-deploy-parity.sh: BOT_DEPLOY_TREE_DIVERGED -> …)
    // Requiring (i) would silently scan zero pairs in (ii) and report a vacuous PASS.
    const id = ids.get(key) ?? key;
    out.push({ id, wave, line: 0, raw: `${fnKeyLine(body, key)}` });
  }
  return out;
}

/** The source line for a case key, so an exemption comment on it is still honoured. */
function fnKeyLine(body, key) {
  const line = body.split('\n').find((l) => new RegExp(`^\\s*${key}\\)`).test(l));
  return line ?? '';
}

/**
 * A mapping is a `Map<waveTemplate, Set<alertId>>` built from the id->wave function bodies.
 * Two DISTINCT ids sharing one wave is the defect, unless the line is explicitly exempted.
 */
export function findViolations(pairs) {
  const violations = [];

  for (const p of pairs) {
    if (LITERAL_WAVE_RE.test(p.wave) && !EXEMPT_RE.test(p.raw)) {
      violations.push({ kind: 'LITERAL_WAVE', id: p.id, wave: p.wave, line: p.line });
    }
  }

  const byWave = new Map();
  for (const p of pairs) {
    if (EXEMPT_RE.test(p.raw)) continue;
    if (!byWave.has(p.wave)) byWave.set(p.wave, new Set());
    byWave.get(p.wave).add(p.id);
  }
  for (const [wave, ids] of byWave) {
    if (ids.size > 1) {
      violations.push({ kind: 'SHARED_WAVE', wave, ids: [...ids].sort() });
    }
  }
  return violations;
}

function verdict(token, code) {
  console.log(`ALERT_WAVE_VERDICT=${token}`);
  process.exit(code);
}

function selfTest() {
  let pass = 0, mustFire = 0, mustNotFire = 0, mustMap = 0, failures = 0;
  const check = (label, expected, actual) => {
    if (JSON.stringify(expected) === JSON.stringify(actual)) pass += 1;
    else { console.log(`  FAIL ${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`); failures += 1; }
  };

  // must-map — comment stripping and pair extraction
  mustMap += 1;
  check('comments stripped', '', stripComments('# ALERT_ONE OPS-A-W{NEXT}').trim());
  mustMap += 1;
  check('pair extracted', [{ id: 'ALERT_ONE', wave: 'OPS-A-W{NEXT}' }],
    extractPairs(`printf 'ALERT_ONE ... Action: dispatch OPS-A-W{NEXT}'`).map(({ id, wave }) => ({ id, wave })));

  // must-fire — the exact 2026-08-01 defect: two ids, one wave
  const shared = extractPairs(
    `printf 'ALERT_ONE Action: dispatch OPS-SAME-W{NEXT}'\nprintf 'ALERT_TWO Action: dispatch OPS-SAME-W{NEXT}'`);
  mustFire += 1;
  check('shared wave fires', ['SHARED_WAVE'], findViolations(shared).map((v) => v.kind));
  mustFire += 1;
  check('literal wave fires', ['LITERAL_WAVE'],
    findViolations(extractPairs(`printf 'ALERT_ONE Action: dispatch OPS-THING-W3'`)).map((v) => v.kind));

  // must-not-fire — distinct waves, and an explicitly exempted share
  mustNotFire += 1;
  check('distinct waves clean', [],
    findViolations(extractPairs(
      `printf 'ALERT_ONE Action: dispatch OPS-A-W{NEXT}'\nprintf 'ALERT_TWO Action: dispatch OPS-B-W{NEXT}'`)));
  mustNotFire += 1;
  check('exempted share clean', [],
    findViolations(extractPairs(
      `printf 'ALERT_ONE Action: dispatch OPS-SAME-W{NEXT}' alert-wave-exempt: by design\n` +
      `printf 'ALERT_TWO Action: dispatch OPS-SAME-W{NEXT}' alert-wave-exempt: by design`)));

  // The false positive an earlier draft of this check produced: a `Rollback: see …-W1`
  // pointer plus an `OFFSET_PCT=75` token in the same printf were paired into a phantom
  // LITERAL_WAVE violation. Only `Action: dispatch` counts.
  mustNotFire += 1;
  check('rollback reference is not a recommendation', [],
    findViolations(extractPairs(
      `printf 'ALERT_ONE (OFFSET_PCT=75) Rollback: see status.md SIGNAL-CLOSEDBAR-SHADOW-W1 CH6 Action: dispatch OPS-A-W{NEXT}'`)));

  if (mustFire === 0 || mustNotFire === 0 || mustMap === 0) {
    console.log(`self-test VACUOUS: ${mustFire} must-fire, ${mustNotFire} must-not-fire, ${mustMap} must-map`);
    return 1;
  }
  if (failures > 0) {
    console.log(`self-test FAILED: ${failures} failure(s) across ${mustFire} must-fire, ${mustNotFire} must-not-fire, ${mustMap} must-map`);
    return 1;
  }
  console.log(`self-test passed: ${mustFire} must-fire, ${mustNotFire} must-not-fire, ${mustMap} must-map (${pass} assertions)`);
  return 0;
}

if (process.argv.includes('--self-test')) process.exit(selfTest());

const missing = SCANNED.filter((f) => !existsSync(join(REPO, f)));
if (missing.length > 0) {
  // A scanned artifact that vanished means this gate verified LESS than it claims — that is
  // INDETERMINATE, never a pass. It is exactly how the probe went ancestor-less in the first place.
  console.log(`scanned artifact(s) missing: ${missing.join(', ')}`);
  verdict('INDETERMINATE', 3);
}

let allPairs = [];
for (const rel of SCANNED) {
  const pairs = extractPairs(readFileSync(join(REPO, rel), 'utf8'));
  console.log(`  ${basename(rel)}: ${pairs.length} (alert id -> wave) pair(s)`);
  allPairs = allPairs.concat(pairs);
}
if (allPairs.length === 0) {
  console.log('no (alert id -> wave) pairs found across any scanned artifact — nothing was verified');
  verdict('INDETERMINATE', 3);
}

const violations = findViolations(allPairs);
for (const v of violations) {
  if (v.kind === 'SHARED_WAVE') {
    console.log(`  FAIL SHARED_WAVE: ${v.ids.join(' + ')} both resolve to ${v.wave}`);
  } else {
    console.log(`  FAIL LITERAL_WAVE: ${v.id} -> ${v.wave} (must be templated W{NEXT})`);
  }
}
const uniqueWaves = new Set(allPairs.map((p) => p.wave)).size;
console.log(`  ${allPairs.length} pair(s), ${uniqueWaves} distinct wave(s), ${violations.length} violation(s)`);
verdict(violations.length === 0 ? 'PASS' : 'FAIL', violations.length === 0 ? 0 : 1);
