/**
 * OPS-ALERT-REGISTRY-DECLARE-W1 CH2 — the consumption-derived declaration corpus.
 *
 * This file is also the WIRING for scripts/check-declaration-coverage.mjs. An unwired gate is
 * theatre, and this repo has shipped that exact defect before — `check-canaries-wired.mjs` exists
 * to fail the build on it.
 *
 * The gate it wires retires: "a gate derives its corpus from a hand-maintained list, so it is
 * structurally blind to exactly the omission it was built to catch — and reports PASS while
 * asserting less than it claims." Measured instance: tests/unit/declaration-sync.test.ts derives
 * its corpus from monitoring-inventory.json, so a row that expressed its host copy through
 * `installed_at[].path` instead of `host_path` was classified `'no host copy exists'` and the
 * SIXTH silent omission shipped green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluate, declarationCandidates, consumerFiles, declaredSet, NOT_A_CONSUMER,
} from '../../scripts/check-declaration-coverage.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'check-declaration-coverage.mjs');

const run = (args = []) => {
  try {
    return { out: execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
};

/** A throwaway copy of the real ops/ tree, so a mutation proof never touches the checkout. */
function scratchTree() {
  const root = mkdtempSync(join(tmpdir(), 'declcov-test-'));
  mkdirSync(join(root, 'ops'), { recursive: true });
  cpSync(join(REPO, 'ops/monitoring'), join(root, 'ops/monitoring'), { recursive: true });
  cpSync(join(REPO, 'ops/cron'), join(root, 'ops/cron'), { recursive: true });
  return root;
}

test('the gate passes against the live tree, with exactly one verdict token', () => {
  const { out, code } = run();
  assert.equal(code, 0, `gate failed:\n${out}`);
  const tokens = out.split('\n').filter((l) => /^DECLARATION_COVERAGE_VERDICT=(PASS|FAIL|INDETERMINATE)$/.test(l));
  assert.equal(tokens.length, 1, 'exactly one terminal verdict token');
  assert.match(out, /^DECLARATION_COVERAGE_VERDICT=PASS$/m);
});

test('the gate --self-test passes and is not vacuous', () => {
  const { out, code } = run(['--self-test']);
  assert.equal(code, 0, out);
  const n = Number(out.match(/SELF-TEST: PASS — (\d+) checks/)?.[1] ?? 0);
  assert.ok(n >= 15, `self-test ran only ${n} checks — a shrinking self-test is a silent narrowing`);
});

test('it emits POSITIVE per-candidate output — a skipped file must not read like a passing one', () => {
  const { out } = run();
  for (const name of declarationCandidates(REPO)) {
    assert.ok(out.includes(name), `${name} has no line of its own in the gate output`);
  }
});

test('REMOVING the registry row from a scratch copy turns it FAIL — the day-one catch', () => {
  const root = scratchTree();
  try {
    assert.equal(evaluate(root).verdict, 'PASS', 'control: the untouched scratch copy must pass');
    const p = join(root, 'ops/monitoring/declaration-sync.sh');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/^\s*"alert-registry\.json\|.*\n/m, ''));
    const after = evaluate(root);
    assert.equal(after.verdict, 'FAIL');
    assert.deepEqual(after.violations.map((v) => v.file), ['alert-registry.json']);
    // The failure must name the CONSUMER, not just the file — a bare assertion is not actionable.
    assert.ok(after.violations[0].readers.includes('send_telegram.sh'));
    assert.ok(after.violations[0].readers.includes('monitoring-inventory-reconcile.py'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('it would have caught ALL FIVE historical omissions, not only the sixth', () => {
  // OPS-DECLARATION-SYNC-YAML-W1 found five host-consumed declarations with no sync path. Remove
  // them from a scratch copy and the consumption scan must surface every one — that is the claim
  // "it would have caught them on day one", asserted rather than asserted-in-prose.
  const HISTORICAL = [
    'website-drift-manifest.yaml', 'postgres-cpu-autopilot-registry.yaml',
    'recommendation-drift-manifest.yaml', 'venue-slo-tiers.json',
    'OPS-SEED-ORCHESTRATOR-W1-baseline.json',
  ];
  const root = scratchTree();
  try {
    const p = join(root, 'ops/monitoring/declaration-sync.sh');
    let src = readFileSync(p, 'utf8');
    for (const name of HISTORICAL) {
      src = src.replace(new RegExp(`^\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\|.*\n`, 'm'), '');
    }
    writeFileSync(p, src);
    const after = evaluate(root);
    assert.equal(after.verdict, 'FAIL');
    assert.deepEqual(after.violations.map((v) => v.file).sort(), [...HISTORICAL].sort());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('declaration-sync.sh is excluded from the consumer set — else the check is circular', () => {
  assert.equal(NOT_A_CONSUMER.has('declaration-sync.sh'), true);
  assert.equal(consumerFiles(REPO).some((c) => c.name === 'declaration-sync.sh'), false);
});

test('the derived corpus covers the declared set — no declared file lacks a real reader', () => {
  // The reverse direction. A declared file nothing reads is a file this repo pushes to two hosts
  // for no consumer — which is what ORPHAN exists to catch on the host side, caught here first.
  const r = evaluate(REPO);
  assert.equal(r.verdict, 'PASS');
  const declared = declaredSet(REPO);
  assert.ok(Array.isArray(declared) && declared.length >= 8);
  for (const name of declared) {
    assert.ok(r.derived.includes(name), `${name} is DECLARED but nothing under ops/ reads it`);
  }
});

test('the gate is wired into package.json and the prepublishOnly chain', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['declaration:coverage:check'] ?? '', /check-declaration-coverage\.mjs/);
  assert.match(pkg.scripts['declaration:coverage:selftest'] ?? '', /--self-test/);
  // Assert the SCRIPT, not the alias — the substantive claim is "the gate runs before publish",
  // and the chain invokes some entries directly and some through `npm run`.
  assert.match(pkg.scripts.prepublishOnly ?? '', /check-declaration-coverage\.mjs/);
});
