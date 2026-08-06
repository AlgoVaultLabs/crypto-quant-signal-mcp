#!/usr/bin/env node
/**
 * injector-target-set.mjs — THE single answer to "which paths does the deploy-time injector
 * rewrite?"
 *
 * OPS-CHECKOUT-PARITY-ALLOWLIST-DERIVE-W1.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `scripts/snapshot-landing-manifest.json` already declares that set: the injector
 * (`scripts/snapshot-landing-data.mjs`) builds `claimsByFile` EXCLUSIVELY from
 * `claim.apply_to_files`, so the union of those arrays IS the injector's target set, by
 * construction rather than by convention.
 *
 * `ops/deploy/checkout-parity.conf` used to assert the same fact a SECOND time, by hand. The two
 * drifted, exactly as CLAUDE.md says a duplicated fact always does — three commits across two
 * waves added an injector target and none of them updated the allowlist:
 *
 *   97fc7ef  OPS-AUDIT-REMEDIATION-LOW-W2       added docs-src/template.html
 *   736f257  OPS-AUDIT-REMEDIATION-LOW-W2 SEC-46 expanded it to the served pages
 *   cf84bc3  OPS-JSONLD-PFE-PROPERTYVALUE-MANAGE-W1 added docs-src/partials/*.html
 *
 * The cost was a daily 🛑 CHECKOUT_PARITY_SIGNAL_MCP naming a file that is legitimate, declared
 * generator output. A fourth hand-copied row would only re-arm the trap for the fifth target.
 *
 * ── REUSABILITY CONTRACT (this is the point of the file) ────────────────────
 * "Which paths does the deploy-time injector rewrite" is now ONE importable, testable answer.
 * A future consumer EXECS this (`node scripts/injector-target-set.mjs`) or IMPORTS
 * `deriveTargets()` — it does NOT re-derive the union itself. A second derivation is a second
 * thing that can drift, which is the defect this file retires.
 *
 * Candidate future consumers, named so the next wave does not have to rediscover them.
 * DELIBERATELY UNWIRED here — this wave ships ONE consumer (`ops/cron/checkout-parity.sh`):
 *   · ops/monitoring/website-drift-manifest.yaml — its `bake_producer` rows name injected pages.
 *   · scripts/check-claim-coverage.mjs           — already reads the same manifest for the
 *                                                  inverse question (is every claim SITE covered).
 *
 * ── Verdict contract ────────────────────────────────────────────────────────
 * stdout is DATA ONLY — the sorted, de-duplicated path list, one per line (or a JSON array with
 * --json) — so a caller can pipe it without filtering. Exactly ONE
 * `INJECTOR_TARGET_SET_VERDICT=PASS|FAIL|INDETERMINATE` line goes to STDERR. That split is a
 * deliberate divergence from sibling gates like check-claim-coverage.mjs, which print their token
 * on stdout because their stdout carries no data.
 *
 * Codes: 0=PASS / 1=FAIL / 3=INDETERMINATE. **3 is the token-law default for a NEW gate.** Do NOT
 * "align" it with scripts/check_test_baseline.sh's 2 — that script is 2 only because it already
 * deployed 2, nothing reads both code spaces, and OPS-TEST-GATE-RECONCILE-W1 already litigated
 * and settled this. Recorded here so it is not re-litigated a third time.
 *
 * INDETERMINATE — the corpus could not be OBTAINED, so no honest answer exists:
 *   unreadable file · invalid JSON · `claims` absent or not an array · ZERO resulting targets.
 * The zero case is vacuity: this manifest is a corpus WE author, so empty means we built nothing
 * (the constructed-corpus side of CLAUDE.md's vacuity law) — REFUSE, never report an empty pass.
 *
 * FAIL — the corpus was obtained and parsed but VIOLATES its own contract:
 *   a claim with no `apply_to_files`, a non-array value, or a non-string / empty entry.
 * snapshot-landing-data.mjs iterates `claim.apply_to_files` unguarded, so such a row would throw
 * in the injector too; the answer here would be wrong rather than merely unknown.
 *
 * Fails CLOSED throughout. There is no branch that returns a partial set with a PASS.
 *
 * Usage:
 *   node scripts/injector-target-set.mjs                    # sorted paths, one per line
 *   node scripts/injector-target-set.mjs --json             # JSON array
 *   node scripts/injector-target-set.mjs --manifest <path>  # override the corpus
 *   node scripts/injector-target-set.mjs --self-test        # hermetic, two-way, vacuity-guarded
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const SELF = url.fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
const TOKEN = 'INJECTOR_TARGET_SET_VERDICT';
const DEFAULT_MANIFEST = path.join(REPO_ROOT, 'scripts', 'snapshot-landing-manifest.json');

/** PASS=0 · FAIL=1 · INDETERMINATE=3. See the docblock for why 3 and not 2. */
const CODES = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

/**
 * Emit the ONE terminal token (stderr) and exit. Never called twice in a process.
 * @param {'PASS'|'FAIL'|'INDETERMINATE'} v
 * @param {string} [why]
 */
function verdict(v, why) {
  process.stderr.write(`${TOKEN}=${v}${why ? ` — ${why}` : ''}\n`);
  process.exit(CODES[v]);
}

/**
 * Read + parse the manifest. Separated from derivation so the failure MODE is explicit rather
 * than collapsed into a try/catch that cannot say which half broke.
 * @param {string} file
 * @returns {{ok: true, data: any} | {ok: false, why: string}}
 */
export function loadManifest(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, why: `manifest unreadable at ${file} (${e.code || e.message})` };
  }
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, why: `manifest is not valid JSON at ${file} (${e.message})` };
  }
}

/**
 * The derivation itself — PURE, exported, and the only place the union is computed.
 *
 * Order-independence is a property, not an accident: the output is `sort()`ed, so it is a
 * function of the CLAIM SET and never of iteration order. tests/unit/checkout-parity-allowlist
 * pins that by shuffling `claims[]` and requiring an identical result.
 *
 * @param {any} manifest
 * @returns {{status: 'PASS'|'FAIL'|'INDETERMINATE', targets: string[], why?: string}}
 */
export function deriveTargets(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { status: 'INDETERMINATE', targets: [], why: 'manifest is not an object' };
  }
  const claims = manifest.claims;
  if (!Array.isArray(claims)) {
    return {
      status: 'INDETERMINATE',
      targets: [],
      why: `\`claims\` is ${claims === undefined ? 'absent' : 'not an array'}`,
    };
  }

  const seen = new Set();
  for (const [i, claim] of claims.entries()) {
    const id = (claim && claim.id) || `#${i}`;
    if (!claim || typeof claim !== 'object') {
      return { status: 'FAIL', targets: [], why: `claim ${id} is not an object` };
    }
    const files = claim.apply_to_files;
    // The injector does `for (const file of claim.apply_to_files)` with no guard, so a row that
    // fails here would throw there. Reporting FAIL rather than skipping keeps the two consistent.
    if (!Array.isArray(files)) {
      return {
        status: 'FAIL',
        targets: [],
        why: `claim ${id} has ${files === undefined ? 'no' : 'a non-array'} \`apply_to_files\``,
      };
    }
    for (const f of files) {
      if (typeof f !== 'string' || f.trim() === '') {
        return { status: 'FAIL', targets: [], why: `claim ${id} has a non-string/empty target` };
      }
      seen.add(f);
    }
  }

  const targets = [...seen].sort();
  // Constructed-corpus vacuity: WE author this manifest, so zero targets means we built nothing.
  if (targets.length === 0) {
    return {
      status: 'INDETERMINATE',
      targets: [],
      why: `${claims.length} claim(s) yielded ZERO targets — a corpus we author cannot be empty`,
    };
  }
  return { status: 'PASS', targets };
}

// ───────────────────────────────── self-test ─────────────────────────────────

/**
 * Hermetic + two-way + vacuity-guarded. No network, no host, no repo manifest.
 *
 * Every case runs the REAL CLI in a child process and asserts BOTH the token AND the exit code.
 * Asserting the token alone is not enough — OPS-TEST-GATE-RECONCILE-W1 found a self-test that was
 * fully green while the token→exit-code mapping had been re-coded to 0, because nothing checked
 * the mapping. That is the whole point of a verdict token, so it is the thing to pin.
 */
function selfTest() {
  const fails = [];
  let produce = 0;
  let refuse = 0;
  let map = 0;

  /**
   * The token→code mapping, written as LITERALS. This deliberately duplicates `CODES`, and that
   * duplication is the entire point: an assertion that reads its expectation from the table under
   * test is a tautology. Measured while writing this file — re-coding `CODES.INDETERMINATE` to 0
   * left every assertion GREEN, because `expectVerdict` was comparing the broken table to itself.
   * That is the OPS-TEST-GATE-RECONCILE-W1 shape verbatim ("the self-test asserted verdict tokens
   * but never the token→exit-code mapping"), and it survived here until the prove-it-can-fail step
   * caught it. Anywhere else in this repo a duplicated fact is a defect; here it is the control.
   */
  const EXPECTED_CODES = { PASS: 0, FAIL: 1, INDETERMINATE: 3 };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'injector-target-set.'));
  const write = (name, obj) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
    return p;
  };
  /** Run the real CLI against a fixture. @returns {{token: string, code: number, out: string}} */
  const run = (manifestPath, extra = []) => {
    const r = spawnSync(process.execPath, [SELF, '--manifest', manifestPath, ...extra], {
      encoding: 'utf8',
    });
    const line = (r.stderr || '').split('\n').find((l) => l.startsWith(`${TOKEN}=`)) || '';
    return { token: line.split('=')[1]?.split(' ')[0] || '', code: r.status ?? -1, out: r.stdout || '' };
  };
  const expect = (label, got, want) => {
    if (got !== want) fails.push(`${label}: expected ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  };
  /** Assert token AND code together — a token that maps to the wrong code is a broken gate. */
  const expectVerdict = (label, r, token) => {
    expect(`${label} token`, r.token, token);
    expect(`${label} code`, r.code, EXPECTED_CODES[token]);
  };

  try {
    // ── must-produce ────────────────────────────────────────────────────────
    const good = write('good.json', {
      claims: [
        { id: 'b', apply_to_files: ['landing/b.html', 'README.md'] },
        { id: 'a', apply_to_files: ['docs-src/template.html'] },
      ],
    });
    produce += 1;
    const g = run(good);
    expectVerdict('valid manifest', g, 'PASS');
    expect('valid manifest stdout', g.out, 'README.md\ndocs-src/template.html\nlanding/b.html\n');

    produce += 1;
    const gj = run(good, ['--json']);
    expectVerdict('--json', gj, 'PASS');
    expect('--json stdout', gj.out.trim(), '["README.md","docs-src/template.html","landing/b.html"]');

    // ── must-map ────────────────────────────────────────────────────────────
    // Order-independence: the outcome is a function of OUR rule, not of iteration order.
    map += 1;
    const shuffled = write('shuffled.json', {
      claims: [
        { id: 'a', apply_to_files: ['docs-src/template.html'] },
        { id: 'b', apply_to_files: ['README.md', 'landing/b.html'] },
      ],
    });
    expect('order-independent', run(shuffled).out, g.out);

    map += 1;
    const dupes = write('dupes.json', {
      claims: [
        { id: 'a', apply_to_files: ['README.md', 'README.md'] },
        { id: 'b', apply_to_files: ['README.md'] },
      ],
    });
    expect('duplicates collapse', run(dupes).out, 'README.md\n');

    map += 1;
    expect('deriveTargets is pure/importable', deriveTargets({ claims: [{ id: 'x', apply_to_files: ['z'] }] }).targets.join(), 'z');

    // ── must-refuse: corpus unobtainable ⇒ INDETERMINATE ────────────────────
    refuse += 1;
    expectVerdict('missing file', run(path.join(tmp, 'nope.json')), 'INDETERMINATE');

    refuse += 1;
    expectVerdict('invalid JSON', run(write('bad.json', '{ not json')), 'INDETERMINATE');

    refuse += 1;
    expectVerdict('claims absent', run(write('noclaims.json', { sot_endpoints: {} })), 'INDETERMINATE');

    refuse += 1;
    expectVerdict('claims not an array', run(write('objclaims.json', { claims: {} })), 'INDETERMINATE');

    refuse += 1;
    expectVerdict('claims empty (vacuity)', run(write('empty.json', { claims: [] })), 'INDETERMINATE');

    refuse += 1;
    expectVerdict(
      'zero targets (vacuity)',
      run(write('zero.json', { claims: [{ id: 'a', apply_to_files: [] }] })),
      'INDETERMINATE',
    );

    // ── must-refuse: contract violated ⇒ FAIL ───────────────────────────────
    refuse += 1;
    expectVerdict('claim without apply_to_files', run(write('noapply.json', { claims: [{ id: 'a' }] })), 'FAIL');

    refuse += 1;
    expectVerdict(
      'apply_to_files not an array',
      run(write('strapply.json', { claims: [{ id: 'a', apply_to_files: 'README.md' }] })),
      'FAIL',
    );

    refuse += 1;
    expectVerdict(
      'non-string target',
      run(write('numapply.json', { claims: [{ id: 'a', apply_to_files: [42] }] })),
      'FAIL',
    );

    refuse += 1;
    expectVerdict(
      'empty-string target',
      run(write('blankapply.json', { claims: [{ id: 'a', apply_to_files: ['  '] }] })),
      'FAIL',
    );

    // ── stdout stays DATA ONLY, on every path ───────────────────────────────
    map += 1;
    expect('no token leaks onto stdout', g.out.includes(TOKEN), false);
    map += 1;
    expect('refusals emit no stdout', run(write('empty2.json', { claims: [] })).out, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Vacuity guard: a self-test that built no corpus asserted nothing. REFUSE — here WE are the
  // corpus author, so empty is a defect in the test, not a fact about the world.
  if (produce === 0 || refuse === 0 || map === 0) {
    process.stderr.write(
      `${TOKEN}=INDETERMINATE — self-test VACUOUS: ${produce} must-produce, ${refuse} must-refuse, ${map} must-map\n`,
    );
    process.exit(CODES.INDETERMINATE);
  }
  if (fails.length) {
    process.stderr.write(
      `${TOKEN}=FAIL — self-test ${fails.length} failure(s) across ${produce} must-produce, ${refuse} must-refuse, ${map} must-map: ${fails.join(' | ')}\n`,
    );
    process.exit(CODES.FAIL);
  }
  process.stderr.write(
    `${TOKEN}=PASS — self-test ${produce} must-produce, ${refuse} must-refuse, ${map} must-map\n`,
  );
  process.exit(CODES.PASS);
}

// ────────────────────────────────── main ─────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes('--self-test')) selfTest();

const mIdx = argv.indexOf('--manifest');
if (mIdx !== -1 && !argv[mIdx + 1]) verdict('INDETERMINATE', '--manifest given with no path');
const manifestPath = mIdx === -1 ? DEFAULT_MANIFEST : path.resolve(argv[mIdx + 1]);

const loaded = loadManifest(manifestPath);
if (!loaded.ok) verdict('INDETERMINATE', loaded.why);

const { status, targets, why } = deriveTargets(loaded.data);
if (status !== 'PASS') verdict(status, `${why} (${manifestPath})`);

process.stdout.write(argv.includes('--json') ? `${JSON.stringify(targets)}\n` : `${targets.join('\n')}\n`);
verdict('PASS', `${targets.length} injector target(s) from ${manifestPath}`);
