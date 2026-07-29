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

test('every registry row committed here matches its ONE canonical sha256', () => {
  const mismatches = [];
  for (const r of rows) {
    if (!r.installed_at || !r.sha256 || !ownedHere(r) || r.repo_resident) continue;
    const p = path.join(REPO, r.artifact);
    if (!existsSync(p)) {
      mismatches.push(`${r.id}: artifact missing at ${r.artifact}`);
      continue;
    }
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
    'A shared primitive changed without its canonical hash being re-recorded. Every installation ' +
      'listed in `installed_at` is asserted against that ONE hash, so a stale row silently ' +
      'disarms REGISTRY_PARITY on every host:\n  ' + mismatches.join('\n  '),
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
