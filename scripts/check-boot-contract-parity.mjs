#!/usr/bin/env node
// @ts-check
/**
 * check-boot-contract-parity.mjs — project the boot contract to where a HOST can read it, and
 * keep the projection provably identical to its source.
 *
 * OPS-HOST-KERNEL-REBOOT-W3 / CH1A.
 *
 * ── WHY A PROJECTION EXISTS AT ALL ──────────────────────────────────────────────────────────
 * `scripts/data/boot-critical-units.json` is the SoT for the boot-survival contract. CH1's
 * `ops/monitoring/boot-contract-canary.sh` has to evaluate that contract ON EACH HOST, and
 * measured 2026-08-27: aoe-1 has NO `crypto-quant-signal-mcp` checkout and no copy of the file
 * anywhere. The only mechanism that flows a committed declaration to both hosts is
 * `ops/monitoring/declaration-sync.sh`, whose `BASE_URL` is pinned to `.../main/ops/monitoring`
 * and whose DECLARATIONS entries are BASENAMES used for both the fetch URL and the destination
 * filename. It cannot reach `scripts/data/`.
 *
 * ── WHY NOT TEACH THE SYNC A PATH (the obvious fix, and the one that is REFUSED) ─────────────
 * Measured against the live tree by importing `check-declaration-coverage.mjs`'s own exported
 * functions: today it returns PASS with 12 candidates / 12 declared / 12 derived and
 * `missingFromDerived = []`. Declaring a name that is NOT under `ops/monitoring/` leaves it
 * permanently outside `derived` (that gate pins `DECLARATION_DIR = 'ops/monitoring'`), so
 * `missingFromDerived = ['boot-critical-units.json']` while `derived.every(d => declared.has(d))`
 * stays true — which is exactly VACUITY GUARD 3, and the gate returns
 * `DECLARATION_COVERAGE_VERDICT=INDETERMINATE`, exit 3. That breaks `prepublishOnly`. So the
 * sync's entry format, its four `IFS='|' read` call sites, its self-test, its unit test and the
 * coverage gate are ALL left untouched, and the contract is projected INTO `ops/monitoring/`
 * instead, where it is an ordinary declaration with an ordinary reader.
 *
 * ── WHY A GATE AND NOT A CONVENTION ─────────────────────────────────────────────────────────
 * A second copy of a fact goes stale; that is this repo's most-repeated lesson. The projection is
 * therefore never hand-edited and never authoritative: `projectContract()` is the ONE derivation,
 * `--write` emits it, `--check` re-derives and compares, and any divergence FAILS. The host copy
 * is a pure function of the SoT or the build stops.
 *
 * WHAT IS PROJECTED, and what is deliberately dropped: the host canary decides on
 * `hosts{} -> {address, units[], containers[]}`, `acceptable_restart_policies`,
 * `postgres_stop_budget_seconds_min`, the activation semantics, and the revisit date. The SoT's
 * prose (`why`, `_comment`, `compose_exemption_reason`, `_restart_policy_note`) is NOT projected:
 * it explains the contract to a reader of the repo and is not a decision input, and every field
 * carried is a field that can drift.
 *
 * Verdict: exactly one terminal `BOOT_CONTRACT_PARITY_VERDICT=PASS|FAIL|INDETERMINATE`.
 * Exit 0=PASS / 1=FAIL / 3=INDETERMINATE (3 is the token-law default for a NEW gate).
 * Callers gate on the TOKEN, never the code.
 *
 * Usage:
 *   node scripts/check-boot-contract-parity.mjs              # same as --check
 *   node scripts/check-boot-contract-parity.mjs --check
 *   node scripts/check-boot-contract-parity.mjs --write      # regenerate the projection
 *   node scripts/check-boot-contract-parity.mjs --self-test
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

export const SOT_REL = 'scripts/data/boot-critical-units.json';
export const PROJECTION_REL = 'ops/monitoring/boot-contract.json';

/** A contract that declares fewer than this many hosts is a truncation, not a contract. */
export const MIN_HOSTS = 2;

/**
 * THE ONE DERIVATION. Pure: takes the parsed SoT, returns the projected object. Both `--write`
 * and `--check` call this and nothing else re-implements it — a second derivation of one fact is
 * how the copy this gate exists to police would start drifting again.
 *
 * Throws `TypeError` with a specific message on a shape it cannot project. The caller turns that
 * into INDETERMINATE: input we were HANDED and could not parse is never a FAIL.
 */
export function projectContract(sot) {
  if (!sot || typeof sot !== 'object' || Array.isArray(sot)) {
    throw new TypeError('SoT is not a JSON object');
  }
  const hosts = sot.hosts;
  if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) {
    throw new TypeError('SoT has no `hosts` object');
  }
  const policies = sot.acceptable_restart_policies;
  if (!Array.isArray(policies) || policies.length === 0) {
    throw new TypeError('SoT has no non-empty `acceptable_restart_policies` array');
  }
  const budget = sot.postgres_stop_budget_seconds_min;
  if (typeof budget !== 'number' || !Number.isFinite(budget)) {
    throw new TypeError('SoT has no numeric `postgres_stop_budget_seconds_min`');
  }
  const semantics = sot._activation_semantics;
  if (!semantics || typeof semantics !== 'object' || Array.isArray(semantics)) {
    throw new TypeError('SoT has no `_activation_semantics` object');
  }

  /** @type {Record<string, unknown>} */
  const projectedHosts = {};
  for (const label of Object.keys(hosts).sort()) {
    const h = hosts[label];
    if (!h || typeof h !== 'object') throw new TypeError(`host ${label} is not an object`);
    if (typeof h.address !== 'string' || h.address.length === 0) {
      throw new TypeError(`host ${label} has no \`address\``);
    }
    if (!Array.isArray(h.units) || h.units.length === 0) {
      throw new TypeError(`host ${label} has no non-empty \`units\` array`);
    }
    if (!Array.isArray(h.containers)) {
      throw new TypeError(`host ${label} has no \`containers\` array`);
    }
    projectedHosts[label] = {
      address: h.address,
      // `via` is omitted rather than nulled when absent: the canary branches on `activation`, and
      // an explicit null would make an `enabled` row look like a socket/timer row with a missing
      // carrier. Absent means "not applicable", which is what the SoT means.
      units: h.units.map((u) => {
        if (!u || typeof u.unit !== 'string' || typeof u.activation !== 'string') {
          throw new TypeError(`host ${label} has a unit row without \`unit\`/\`activation\``);
        }
        if (!Object.prototype.hasOwnProperty.call(semantics, u.activation)) {
          throw new TypeError(`host ${label} unit ${u.unit} declares activation "${u.activation}", which _activation_semantics does not define`);
        }
        return typeof u.via === 'string' ? { unit: u.unit, activation: u.activation, via: u.via } : { unit: u.unit, activation: u.activation };
      }),
      containers: [...h.containers],
    };
  }

  return {
    schema_version: 1,
    _comment:
      'GENERATED — do not edit. Projection of scripts/data/boot-critical-units.json for host-side '
      + 'consumption by ops/monitoring/boot-contract-canary.sh. Regenerate with '
      + '`node scripts/check-boot-contract-parity.mjs --write`; parity is asserted by the same '
      + 'script in --check mode, which is wired into prepublishOnly.',
    generated_from: SOT_REL,
    generator: 'scripts/check-boot-contract-parity.mjs',
    probed_at: typeof sot.probed_at === 'string' ? sot.probed_at : null,
    revisit_by: typeof sot._TODO_revisit_by === 'string' ? sot._TODO_revisit_by : null,
    activation_semantics: { ...semantics },
    acceptable_restart_policies: [...policies],
    postgres_stop_budget_seconds_min: budget,
    hosts: projectedHosts,
  };
}

/** The ONE serializer. A byte comparison is only meaningful if both sides used this. */
export function serialize(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** Read + parse a JSON file. Returns a tagged result so the caller can tell absent from garbage. */
export function readJson(abs) {
  if (!existsSync(abs)) return { ok: false, kind: 'absent' };
  let raw;
  try { raw = readFileSync(abs, 'utf8'); } catch (e) { return { ok: false, kind: 'unreadable', detail: String(e && e.message) }; }
  try { return { ok: true, value: JSON.parse(raw), raw }; } catch (e) { return { ok: false, kind: 'unparseable', detail: String(e && e.message) }; }
}

/**
 * The whole decision, as data. Separated from I/O so the self-test can drive it over a fixture
 * pair and so a caller can see WHY, not only WHAT.
 *
 * VACUITY: the SoT is a config WE author, so an absent/garbage/under-populated one is our defect
 * and REFUSES (INDETERMINATE) rather than reporting a clean tree. The projection is the artifact
 * this gate governs, so an absent one is an honest FAIL with a printed remediation.
 */
export function evaluate(sotRead, projRead) {
  if (!sotRead.ok) {
    return { verdict: 'INDETERMINATE', reason: `SoT ${SOT_REL} is ${sotRead.kind}${sotRead.detail ? ` — ${sotRead.detail}` : ''}` };
  }
  let expected;
  try {
    expected = projectContract(sotRead.value);
  } catch (e) {
    return { verdict: 'INDETERMINATE', reason: `SoT ${SOT_REL} cannot be projected — ${e instanceof Error ? e.message : String(e)}` };
  }
  const hostCount = Object.keys(expected.hosts).length;
  if (hostCount < MIN_HOSTS) {
    return { verdict: 'INDETERMINATE', reason: `SoT declares ${hostCount} host(s), below the floor of ${MIN_HOSTS} — a truncated contract is not a contract` };
  }

  const wanted = serialize(expected);
  if (!projRead.ok && projRead.kind === 'absent') {
    return { verdict: 'FAIL', reason: `${PROJECTION_REL} does not exist`, expected, wanted, hostCount };
  }
  if (!projRead.ok) {
    return { verdict: 'INDETERMINATE', reason: `${PROJECTION_REL} is ${projRead.kind}${projRead.detail ? ` — ${projRead.detail}` : ''}` };
  }
  if (projRead.raw !== wanted) {
    const got = serialize(projRead.value);
    const reason = got === wanted
      ? `${PROJECTION_REL} has the right content but not the canonical formatting`
      : `${PROJECTION_REL} diverges from its source`;
    return { verdict: 'FAIL', reason, expected, wanted, hostCount, drift: firstDivergence(projRead.raw, wanted) };
  }
  return { verdict: 'PASS', expected, wanted, hostCount };
}

/** First differing line, so a FAIL names the drift instead of just asserting it. */
export function firstDivergence(got, want) {
  const a = got.split('\n');
  const b = want.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] !== b[i]) return { line: i + 1, got: a[i] ?? '<end of file>', want: b[i] ?? '<end of file>' };
  }
  return null;
}

function emit(r) {
  if (r.verdict === 'INDETERMINATE') {
    console.log(`boot-contract-parity: INDETERMINATE — ${r.reason}`);
    console.log('BOOT_CONTRACT_PARITY_VERDICT=INDETERMINATE');
    return 3;
  }
  // POSITIVE per-host output on EVERY path: a host silently skipped by a shape error must never
  // read like a host that was checked and matched.
  console.log(`boot-contract-parity: ${SOT_REL} -> ${PROJECTION_REL}, ${r.hostCount} host(s)`);
  for (const [label, h] of Object.entries(r.expected.hosts)) {
    console.log(`  · ${label.padEnd(10)} address=${h.address}  units=${h.units.length}  containers=${h.containers.length}`);
  }
  console.log(`  · policies=${r.expected.acceptable_restart_policies.join('|')}  pg_stop_budget=${r.expected.postgres_stop_budget_seconds_min}s  revisit_by=${r.expected.revisit_by ?? '<none>'}`);
  if (r.verdict === 'FAIL') {
    console.log('');
    console.log(`  ✗ ${r.reason}`);
    if (r.drift) {
      console.log(`    line ${r.drift.line}:`);
      console.log(`      got  ${r.drift.got}`);
      console.log(`      want ${r.drift.want}`);
    }
    console.log('    remediation: node scripts/check-boot-contract-parity.mjs --write   (then commit the projection)');
    console.log('BOOT_CONTRACT_PARITY_VERDICT=FAIL');
    return 1;
  }
  console.log('  ✓ projection is byte-identical to its derivation');
  console.log('BOOT_CONTRACT_PARITY_VERDICT=PASS');
  return 0;
}

export function runCheck(root) {
  const sotRead = readJson(path.join(root, SOT_REL));
  const projRead = readJson(path.join(root, PROJECTION_REL));
  return emit(evaluate(sotRead, projRead));
}

export function runWrite(root) {
  const sotRead = readJson(path.join(root, SOT_REL));
  if (!sotRead.ok) {
    console.log(`boot-contract-parity: INDETERMINATE — SoT ${SOT_REL} is ${sotRead.kind}`);
    console.log('BOOT_CONTRACT_PARITY_VERDICT=INDETERMINATE');
    return 3;
  }
  let projected;
  try {
    projected = projectContract(sotRead.value);
  } catch (e) {
    console.log(`boot-contract-parity: INDETERMINATE — ${e instanceof Error ? e.message : String(e)}`);
    console.log('BOOT_CONTRACT_PARITY_VERDICT=INDETERMINATE');
    return 3;
  }
  const hostCount = Object.keys(projected.hosts).length;
  if (hostCount < MIN_HOSTS) {
    console.log(`boot-contract-parity: INDETERMINATE — SoT declares ${hostCount} host(s), below the floor of ${MIN_HOSTS}`);
    console.log('BOOT_CONTRACT_PARITY_VERDICT=INDETERMINATE');
    return 3;
  }
  writeFileSync(path.join(root, PROJECTION_REL), serialize(projected));
  console.log(`boot-contract-parity: wrote ${PROJECTION_REL} (${hostCount} hosts)`);
  // Re-read and re-compare through the SAME path --check uses, so `--write` can never claim a
  // success it did not achieve.
  return runCheck(root);
}

// ─────────────────────────────── self-test ───────────────────────────────

/**
 * Two-way, vacuity-guarded. NOTE what this suite deliberately does NOT stub: the last block reads
 * the REAL SoT through the REAL `readJson` and projects it. A hermetic suite is structurally blind
 * to exactly what its own seam replaces, and here the seam would be the reader and the shape of
 * the file actually shipped — the two things a fixture can always be made to agree with.
 */
function selfTest() {
  const fails = [];
  let checked = 0;
  const ck = (label, got, want) => {
    checked += 1;
    if (got === want) { console.log(`  ✓ ${label}`); return; }
    console.log(`  ✗ ${label} — expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    fails.push(label);
  };

  const goodSot = {
    _activation_semantics: { enabled: 'e', socket: 's', timer: 't' },
    _TODO_revisit_by: '2027-02-28',
    probed_at: '2026-07-31',
    hosts: {
      'signal-1': {
        address: '10.0.0.1',
        units: [
          { unit: 'ssh.service', activation: 'socket', via: 'ssh.socket', why: 'prose that must NOT be projected' },
          { unit: 'docker.service', activation: 'enabled' },
        ],
        containers: ['c1', 'c2'],
      },
      'aoe-1': { address: '10.0.0.2', units: [{ unit: 'cron.service', activation: 'enabled' }], containers: [] },
    },
    acceptable_restart_policies: ['always', 'unless-stopped'],
    postgres_stop_budget_seconds_min: 30,
  };

  console.log('--- projection shape ---');
  const p = projectContract(goodSot);
  ck('hosts are emitted in sorted order (stable bytes)', Object.keys(p.hosts).join(','), 'aoe-1,signal-1');
  ck('prose `why` is dropped', JSON.stringify(p.hosts['signal-1'].units[0]), JSON.stringify({ unit: 'ssh.service', activation: 'socket', via: 'ssh.socket' }));
  ck('`via` is omitted, never nulled, when not applicable', Object.prototype.hasOwnProperty.call(p.hosts['signal-1'].units[1], 'via'), false);
  // Added after a deliberate break (`containers: []`) left every other assertion GREEN while
  // --check went RED: the shape block asserted units and forgot the other half of the contract.
  ck('containers survive the projection, per host', `${p.hosts['signal-1'].containers.join('|')}/${p.hosts['aoe-1'].containers.length}`, 'c1|c2/0');
  ck('units survive the projection, per host', `${p.hosts['signal-1'].units.length}/${p.hosts['aoe-1'].units.length}`, '2/1');
  // The serializer is a SEAM every other assertion agrees with by construction — a compact
  // serializer round-trips just as happily as a canonical one. Pin the bytes, not the round-trip.
  ck('serialize() emits 2-space canonical JSON with a trailing newline', serialize({ a: 1 }), '{\n  "a": 1\n}\n');
  ck('decision inputs are carried, not re-declared', `${p.acceptable_restart_policies.join('|')}/${p.postgres_stop_budget_seconds_min}/${p.revisit_by}`, 'always|unless-stopped/30/2027-02-28');

  console.log('--- refusals (shapes we author, so empty is OUR defect) ---');
  const refuses = (label, mutate) => {
    const bad = JSON.parse(JSON.stringify(goodSot));
    mutate(bad);
    let verdict;
    try { projectContract(bad); verdict = 'projected'; } catch { verdict = 'threw'; }
    ck(label, verdict, 'threw');
  };
  refuses('a host with no address', (s) => { delete s.hosts['aoe-1'].address; });
  refuses('a host with an empty units array', (s) => { s.hosts['aoe-1'].units = []; });
  refuses('an activation kind the semantics do not define', (s) => { s.hosts['aoe-1'].units[0].activation = 'wishful'; });
  refuses('a missing restart-policy list', (s) => { delete s.acceptable_restart_policies; });
  refuses('a non-numeric stop budget', (s) => { s.postgres_stop_budget_seconds_min = 'thirty'; });

  console.log('--- verdicts ---');
  const sotOk = { ok: true, value: goodSot, raw: '{}' };
  const wanted = serialize(projectContract(goodSot));
  ck('matching projection -> PASS', evaluate(sotOk, { ok: true, value: JSON.parse(wanted), raw: wanted }).verdict, 'PASS');
  ck('absent projection -> FAIL', evaluate(sotOk, { ok: false, kind: 'absent' }).verdict, 'FAIL');
  const drifted = wanted.replace('10.0.0.2', '10.0.0.9');
  const dr = evaluate(sotOk, { ok: true, value: JSON.parse(drifted), raw: drifted });
  ck('drifted projection -> FAIL', dr.verdict, 'FAIL');
  ck('  and the FAIL names the drifting line', Boolean(dr.drift && dr.drift.got.includes('10.0.0.9')), true);
  const reformatted = `${JSON.stringify(JSON.parse(wanted))}\n`;
  ck('content-equal but non-canonical bytes -> FAIL', evaluate(sotOk, { ok: true, value: JSON.parse(reformatted), raw: reformatted }).verdict, 'FAIL');
  ck('unparseable projection -> INDETERMINATE', evaluate(sotOk, { ok: false, kind: 'unparseable', detail: 'x' }).verdict, 'INDETERMINATE');
  ck('absent SoT -> INDETERMINATE', evaluate({ ok: false, kind: 'absent' }, { ok: false, kind: 'absent' }).verdict, 'INDETERMINATE');
  const oneHost = { ok: true, value: { ...goodSot, hosts: { 'signal-1': goodSot.hosts['signal-1'] } }, raw: '{}' };
  ck(`a ${MIN_HOSTS - 1}-host contract -> INDETERMINATE (truncation, not a pass)`, evaluate(oneHost, { ok: false, kind: 'absent' }).verdict, 'INDETERMINATE');

  console.log('--- token -> exit-code mapping (asserted, not assumed) ---');
  const silence = () => { const orig = console.log; console.log = () => {}; return () => { console.log = orig; }; };
  for (const [verdict, code] of [['PASS', 0], ['FAIL', 1], ['INDETERMINATE', 3]]) {
    const restore = silence();
    const got = emit(verdict === 'INDETERMINATE'
      ? { verdict, reason: 'fixture' }
      : { verdict, reason: 'fixture', expected: p, wanted, hostCount: 2, drift: null });
    restore();
    ck(`${verdict} -> exit ${code}`, got, code);
  }

  console.log('--- the seam this suite would otherwise never exercise ---');
  // The REAL file, through the REAL reader. Every block above agrees with a fixture I wrote; this
  // is the only one that can disagree with what actually ships.
  const liveRead = readJson(path.join(REPO, SOT_REL));
  ck('the committed SoT parses through the real reader', liveRead.ok, true);
  let liveProjected = null;
  try { liveProjected = liveRead.ok ? projectContract(liveRead.value) : null; } catch { liveProjected = null; }
  ck('the committed SoT projects without throwing', liveProjected !== null, true);
  ck(`the committed SoT declares >= ${MIN_HOSTS} hosts`, liveProjected ? Object.keys(liveProjected.hosts).length >= MIN_HOSTS : false, true);
  ck('serialize() round-trips to identical bytes', liveProjected ? serialize(JSON.parse(serialize(liveProjected))) === serialize(liveProjected) : false, true);

  // Vacuity guard: this suite BUILDS its own corpus, so "nothing ran" is a defect in the test.
  const MIN_ASSERTIONS = 25;
  if (checked < MIN_ASSERTIONS) {
    console.log(`SELF_TEST_VERDICT=INDETERMINATE — only ${checked} assertions ran (expected >= ${MIN_ASSERTIONS})`);
    console.log('BOOT_CONTRACT_PARITY_VERDICT=INDETERMINATE');
    return 3;
  }
  if (fails.length) {
    console.log(`SELF_TEST_VERDICT=FAIL — ${fails.length}/${checked}: ${fails.join(', ')}`);
    console.log('BOOT_CONTRACT_PARITY_VERDICT=FAIL');
    return 1;
  }
  console.log(`SELF_TEST_VERDICT=PASS — ${checked} assertions (7 shape, 5 must-refuse, 8 verdict, 3 token-map, 4 live-seam)`);
  console.log('BOOT_CONTRACT_PARITY_VERDICT=PASS');
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return process.exit(selfTest());
  if (argv.includes('--write')) return process.exit(runWrite(REPO));
  return process.exit(runCheck(REPO));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
