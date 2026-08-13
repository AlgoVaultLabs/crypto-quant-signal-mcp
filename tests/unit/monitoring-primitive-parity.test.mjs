/**
 * OPS-AOE-MONITORING-PARITY-W1 — the signal-repo half of the shared-primitive parity contract.
 *
 * A monitoring artifact installed on more than one host is a SHARED PRIMITIVE. Its inventory row
 * must enumerate every installation (`installed_at`), and the committed bytes must match the ONE
 * canonical `sha256` that every installation is asserted against.
 *
 * Why this class of test exists: `send_telegram.sh` on the AOE host was never a fork — it was
 * byte-identical to this host's own PRE-TEST-CONTEXT-GATE backup, i.e. a pure unmodified
 * ancestor. Two waves updated the primitive at ONE call site because nothing recorded that a
 * second host was also a consumer. Divergence DETECTION would only have told us afterwards; the
 * registry is what makes an update unable to miss a host.
 *
 * Runtime cross-host parity is `monitoring-inventory-reconcile.py`'s REGISTRY_PARITY check.
 * This file guards the repo side: the committed hash, the registry's existence and shape, and
 * the public-repo label discipline. Run by the pre-push test-gate (node --test).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INVENTORY = path.join(REPO, 'ops/monitoring/monitoring-inventory.json');
const doc = JSON.parse(readFileSync(INVENTORY, 'utf8'));
const rows = doc.artifacts;

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
/** Rows whose artifact lives in THIS repo (a `repo` field names a different owner). */
const ownedHere = (r) => !r.repo;

/**
 * WIDENED 2026-08-10 by OPS-MONITORING-PATHSIGNORE-PARITY-W1 — 8 rows -> 54 of 58.
 *
 * `row.sha256` is the ONE canonical hash, and `monitoring-inventory-reconcile.py`'s HASH_DRIFT
 * check compares the LIVE HOST FILE against it — labelling that field `"repo"` in its own output.
 * So the whole host-parity chain is:
 *
 *     committed repo file  --[THIS TEST]-->  row.sha256  --[HASH_DRIFT, daily]-->  live host file
 *
 * The middle link was never asserted. That made `row.sha256` an unanchored number, and HASH_DRIFT
 * a comparison against a value that might match neither side — which is exactly what happened:
 * `website-drift-manifest.yaml`'s row recorded a hash matching NEITHER the host copy nor the
 * committed one, so `HOMEPAGE_HOLD_RATE_DTRF_BAND` sat retired-in-repo but live-on-host for 5 days
 * and the drift signal that should have caught it was indistinguishable from noise.
 * (HOLD-DEEMPHASIS-SWEEP-W1, 2026-08-10.)
 *
 * THE DEFECT WAS THE SCAN SET, NOT THE ASSERTION. This test already made the right comparison and
 * PASSED — over 8 of 58 rows, because `!r.installed_at` skipped 39 (that field is the multi-host
 * consumer registry, so the predicate silently narrowed a universal invariant to the shared
 * primitives its authoring wave happened to care about) and `r.repo_resident` skipped 13 more.
 * Widening it caught 3 real, previously-invisible violations on the first run.
 *
 * The exclusions that REMAIN are structural — derived from the data, never a maintained list, so
 * an artifact cannot be quietly dropped from coverage by adding its name somewhere:
 *   - `repo` names another repo   -> the file is not in this checkout, so it cannot be hashed here
 *   - `artifact` is `external:…`  -> same, marked explicitly
 *   - no `sha256`                 -> only the inventory's OWN row, which cannot contain its own
 *                                    hash; SOT_PARITY covers that file instead
 * `repo_resident` is deliberately NOT an exclusion any more: those artifacts are consumed from the
 * host's git checkout, so HASH_DRIFT rightly skips them — which makes THIS the only assertion that
 * can keep their recorded hash honest, not a reason to skip them too.
 */
const hashableHere = (r) =>
  Boolean(r.sha256) && ownedHere(r) && !String(r.artifact ?? '').startsWith('external:');

/** The floor is the point of this test. See COVERAGE_FLOOR below. */
const COVERAGE_FLOOR = 50;

test('every registry row committed here matches its ONE canonical sha256', () => {
  const mismatches = [];
  let checked = 0;
  for (const r of rows) {
    if (!hashableHere(r)) continue;
    const p = path.join(REPO, r.artifact);
    if (!existsSync(p)) {
      // A RETIRED row may legitimately have had its artifact deleted — retirement can remove
      // the file, and the reconciler already skips retired rows in check_hash_drift (its own
      // self-test pins "retired rows are not hash-checked"). Asserting presence here would be
      // STRICTER than the authority this test exists to keep honest, and would make deleting a
      // retired artifact impossible without also deleting its row — which this file's
      // zero-deletion policy forbids, since a retired row is how you prove something was
      // intentionally stopped rather than silently lost.
      //
      // Scoped deliberately to MISSING-and-retired only: a retired row whose artifact is still
      // present keeps its full hash assertion below, which is every incumbent retired row
      // (equity-launch-readiness, equity-verdict-watch, shadow-cpu-gate-48h,
      // seed-orchestrator-gate-48h, seed-orchestrator-baseline). So this removes no coverage
      // that existed before it — the first retired row with a DELETED artifact arrived with
      // OPS-RECALIBRATE-HARNESS-RETIRE-W1, which is why the case had never come up.
      if (r.install_state === 'retired') continue;
      mismatches.push(`${r.id}: artifact missing at ${r.artifact}`);
      continue;
    }
    checked += 1;
    const actual = sha256(p);
    if (actual !== r.sha256) {
      mismatches.push(
        `${r.id}: committed ${actual.slice(0, 12)} != row.sha256 ${r.sha256.slice(0, 12)} ` +
          `(${r.artifact})`,
      );
    }
  }
  assert.deepEqual(
    mismatches,
    [],
    'An inventory artifact changed without its canonical hash being re-recorded. HASH_DRIFT and ' +
      'REGISTRY_PARITY both compare the live host file against that ONE hash, so a stale row ' +
      'silently disarms them on every host. Re-stamp it in the SAME commit as the edit:\n  ' +
      mismatches.join('\n  '),
  );
  // POSITIVE output: a count, not just an absence. Silence here used to mean "8 rows agreed".
  console.log(`  monitoring-inventory hash parity: ${checked} rows checked, 0 mismatched`);
});

test('the hash check covers the WHOLE inventory, not the slice one wave cared about', () => {
  // THE GENERATOR FIX, and the reason this test exists as a separate assertion: the bug above was
  // never a wrong comparison, it was a PASSING comparison over 14% of the rows. A zero-mismatch
  // result is only meaningful alongside the breadth it was computed over, so the breadth is
  // asserted too — a future predicate change that re-narrows the scan set fails HERE rather than
  // reporting green over a handful of rows for months.
  const hashable = rows.filter(hashableHere);
  assert.ok(
    hashable.length >= COVERAGE_FLOOR,
    `hash-parity coverage collapsed to ${hashable.length} rows (floor ${COVERAGE_FLOOR}). Either ` +
      'the inventory shrank, or a predicate change re-narrowed the scan set — which is the exact ' +
      'defect OPS-MONITORING-PATHSIGNORE-PARITY-W1 retired. Raise the floor when rows are added; ' +
      'never lower it to make a change pass.',
  );
  // A FLOOR, never equality: rows get added, and pinning the count would make that a build break.
  // But the excluded set must stay SMALL and explainable, or the floor is satisfied while coverage
  // rots — so the complement is bounded too, and every exclusion must be structural.
  const excluded = rows.filter((r) => !hashableHere(r));
  for (const r of excluded) {
    const why = !r.sha256
      ? 'no sha256 (self-referential inventory row)'
      : r.repo
        ? `owned by repo=${r.repo}`
        : 'external: artifact';
    assert.ok(
      !r.sha256 || r.repo || String(r.artifact ?? '').startsWith('external:'),
      `${r.id} is excluded from hash parity for no structural reason (${why})`,
    );
  }
  assert.ok(
    excluded.length <= 6,
    `${excluded.length} rows are excluded from hash parity — that set must stay small and ` +
      'structural. Growth here means coverage is being lost quietly.',
  );
  console.log(
    `  hash-parity scan set: ${hashable.length} of ${rows.length} rows ` +
      `(${excluded.length} structurally excluded)`,
  );
});

test('shared primitives declare a multi-host registry', () => {
  for (const id of ['send-telegram-wrapper', 'monitoring-inventory-reconcile']) {
    const row = rows.find((r) => r.id === id);
    assert.ok(row, `${id} row is missing from the inventory`);
    const hosts = new Set((row.installed_at ?? []).map((e) => e.host));
    assert.ok(
      hosts.size >= 2,
      `${id} is installed on more than one host but declares ${hosts.size} registry entr(y/ies). ` +
        'Dropping the registry restores the single-call-site blindness this wave retired.',
    );
  }
});

test('registry entries carry a host and a path, and no literal address (this repo is PUBLIC)', () => {
  const IPV4 = /\b\d{1,3}(\.\d{1,3}){3}\b/;
  for (const r of rows) {
    for (const e of r.installed_at ?? []) {
      assert.ok(e.host, `${r.id}: a registry entry has no host label`);
      assert.ok(e.path, `${r.id}: registry entry ${e.host} has no path`);
      assert.ok(
        !IPV4.test(e.host),
        `${r.id}: registry entry host "${e.host}" is a literal address. Use an opaque label ` +
          '(signal-1 / aoe-1); label→address resolution belongs in ssh config or host env, ' +
          'never in this committed JSON.',
      );
    }
  }
});

test('contract exemptions are machine-recorded with a reason, not left in prose', () => {
  const wrapper = rows.find((r) => r.id === 'send-telegram-wrapper');
  assert.ok(wrapper.exempt_consumers?.length, 'the wrapper row must record its ADR exemption');
  for (const e of wrapper.exempt_consumers) {
    for (const k of ['path', 'reason', 'kind']) {
      assert.ok(e[k], `exempt_consumers entry is missing "${k}" — an exemption without a ` +
        'recorded reason gets "fixed" by a future wave enforcing the contract');
    }
  }
});

test('the canonical wrapper still carries both behaviours whose absence was the defect', () => {
  // A hash check alone cannot catch a re-vendor from a stale source that re-records the hash.
  const src = readFileSync(path.join(REPO, 'ops/monitoring/send_telegram.sh'), 'utf8');
  const logDefs = src.split('\n').filter((l) => l.trimStart().startsWith('log()'));
  assert.equal(logDefs.length, 1, 'expected exactly one log() definition');
  assert.match(logDefs[0], /\|\| true/,
    'log() lost its fail-open — a logging failure can abort the wrapper and swallow an alert ' +
    '[OPS-AUTOPUB-FULL-REVIEW-FIX-W1 C5]');
  for (const tok of ['ALGOVAULT_TG_TEST_INERT', 'NODE_TEST_CONTEXT', 'VITEST', 'SUPPRESSED_TEST_CONTEXT']) {
    assert.ok(src.includes(tok),
      `test-context gate is missing "${tok}" — ALGOVAULT_TG_TEST_INERT=1 becomes a no-op and a ` +
      'gate run pages the operator then self-suppresses for 24h [OPS-AUTOPUB-TEST-ALERT-LEAK-W1]');
  }
  assert.ok(src.indexOf('ALGOVAULT_TG_TEST_INERT') < src.indexOf('SUPPRESSED_COOLDOWN'),
    'the test gate must precede the cooldown gate, or a test run mutates production alert state');
});

test('self-check: the detectors fire on a known-bad fixture (both directions)', () => {
  const ancestor = 'set -euo pipefail\nlog() { echo "$*" >> "$LOG"; }\nlog "SUPPRESSED_COOLDOWN"\n';
  const defs = ancestor.split('\n').filter((l) => l.trimStart().startsWith('log()'));
  assert.ok(defs.length === 1 && !/\|\| true/.test(defs[0]), 'fail-open detector would not fire');
  assert.ok(!ancestor.includes('ALGOVAULT_TG_TEST_INERT'), 'gate detector would not fire');
  // RFC-5737 documentation address on purpose: the fixture must exercise the regex without
  // adding a fresh occurrence of a real host address to a PUBLIC repo.
  assert.ok(/\b\d{1,3}(\.\d{1,3}){3}\b/.test('192.0.2.1'), 'address detector would not fire');
});
