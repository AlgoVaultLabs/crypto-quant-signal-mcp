/**
 * population-comparison.test.mjs — EDGE-POPULATION-COMPARISON-W1.
 *
 * node:test, deliberately — this is how the gate reaches the PRE-PUSH stack. A `.mjs` canary is run
 * by `scripts/check_test_baseline.sh` alongside vitest, and vitest excludes it. Wiring it here
 * rather than only in CI is the difference between a gate that blocks a push and one that reports
 * after the fact.
 *
 * What it pins:
 *   1. the derivation reproduces the 2026-09-02 incident from COUNTS;
 *   2. the identifiability REFUSAL fires on that incident's real shape;
 *   3. the refusal is not blanket;
 *   4. both self-tests are green — and both are proven able to fail elsewhere in the wave.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function run(cmd, args) {
  try {
    return { out: execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
}

test('the python derivation self-test is green and prints its verdict token', () => {
  const { out, code } = run('python3', ['ops/monitoring/population_comparison.py']);
  assert.match(out, /POPULATION_COMPARISON_VERDICT=PASS/, out.slice(-900));
  assert.equal(code, 0);
});

test('the gate self-test is green and prints its verdict token', () => {
  const { out, code } = run('node', ['scripts/check-population-comparison.mjs', '--self-test']);
  assert.match(out, /POPULATION_COMPARISON_GATE_VERDICT=PASS/, out.slice(-900));
  assert.equal(code, 0);
});

test('the live gate passes: every banned-comparator site is declared', () => {
  const { out } = run('node', ['scripts/check-population-comparison.mjs']);
  assert.match(out, /POPULATION_COMPARISON_GATE_VERDICT=PASS/, out.slice(-1200));
  // Vacuity guard: a sweep that searched nothing is indistinguishable from a clean one.
  const m = out.match(/scanned (\d+) tracked files/);
  assert.ok(m && Number(m[1]) > 100, `sweep corpus too small: ${out.slice(0, 400)}`);
});

test('the registry enumerates what the sweep provably cannot reach', () => {
  // edge-stats.ts carries the banned comparator ONLY in a docstring; its `naiveBest` value arrives
  // from a caller, so the pattern sweep cannot see it. That is not a hole to be patched — it is the
  // reason the ledger exists, and this test pins the claim so a future wave cannot quietly decide
  // the lint alone is sufficient.
  const reg = JSON.parse(readFileSync(join(ROOT, 'ops/monitoring/population-comparison.registry.json'), 'utf8'));
  const ids = reg.sites.map(s => s.id);
  assert.ok(ids.includes('edge-stats:naiveBest'), 'edge-stats must be declared');
  const es = reg.sites.find(s => s.id === 'edge-stats:naiveBest');
  assert.equal(es.status, 'UNMIGRATED');
  assert.ok(es.migration_wave, 'declared debt must name who will pay it');

  const src = readFileSync(join(ROOT, 'src/scripts/edge-stats.ts'), 'utf8');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/Math\.max\([^)]*always/i.test(codeOnly),
    'if edge-stats gains a literal banned comparator, the sweep now reaches it and this note is stale');
});

test('every UNMIGRATED site names a migration wave, and the ratchet is numeric', () => {
  const reg = JSON.parse(readFileSync(join(ROOT, 'ops/monitoring/population-comparison.registry.json'), 'utf8'));
  const unmigrated = reg.sites.filter(s => s.status === 'UNMIGRATED');
  assert.ok(unmigrated.length > 0, 'a zero-debt registry here would be a false claim, not a clean tree');
  for (const s of unmigrated) assert.ok(s.migration_wave, `${s.id} names no migration_wave`);
  assert.equal(typeof reg.unmigrated_baseline, 'number');
  assert.ok(unmigrated.length <= reg.unmigrated_baseline,
    `ratchet breached: ${unmigrated.length} > ${reg.unmigrated_baseline}`);
});

test('the schema bans MAX_NAIVE and never lists it as a legal basis', () => {
  const s = JSON.parse(readFileSync(join(ROOT, 'ops/monitoring/population-comparison.schema.json'), 'utf8'));
  assert.ok(s.banned_basis.includes('MAX_NAIVE'));
  assert.equal(s.basis_values.filter(b => s.banned_basis.includes(b)).length, 0);
  assert.equal(s.denominator_convention, 'ALL_SCORED');
});
