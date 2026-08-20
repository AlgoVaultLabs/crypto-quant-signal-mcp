/**
 * OPS-ALERT-RECOVERY-NOTICE-W1 CH2 — the alert consumer registry.
 *
 * CLAUDE.md: a shared primitive used by >=2 hosts gets a registry naming every installation,
 * because "detection is strictly weaker than enumeration". This test is also the WIRING for
 * scripts/check-alert-registry.mjs — an unwired gate is theatre, and this repo has shipped that
 * exact defect before (check-canaries-wired.mjs exists to fail the build on it).
 *
 * Measured while building the gate, and the reason a hand-reviewed registry beats a derived list:
 *   · 14 alert ids had a LIVE cooldown marker on a host and no discoverable call site;
 *   · 4 more had a call site invoked through a `$WRAPPER` variable and had NEVER fired, so
 *     neither the source scan nor the marker scan saw them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractAlertIds } from '../../scripts/check-alert-registry.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'check-alert-registry.mjs');
const REGISTRY = join(REPO, 'ops', 'monitoring', 'alert-registry.json');

const run = (args = []) => {
  try {
    return { out: execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 };
  }
};

test('the gate passes against the live tree, with exactly one verdict token', () => {
  const { out, code } = run();
  assert.equal(code, 0, `gate failed:\n${out}`);
  const tokens = out.split('\n').filter((l) => /^ALERT_REGISTRY_VERDICT=(PASS|FAIL|INDETERMINATE)$/.test(l));
  assert.equal(tokens.length, 1);
  assert.match(out, /^ALERT_REGISTRY_VERDICT=PASS$/m);
});

test('the gate --self-test passes and is not vacuous', () => {
  const { out, code } = run(['--self-test']);
  assert.equal(code, 0, out);
  const n = Number(out.match(/SELF-TEST: PASS — (\d+) checks/)?.[1] ?? 0);
  assert.ok(n >= 12, `only ${n} checks`);
});

/**
 * The extractor is STRUCTURAL — an alert id is identified by its position in a call, not by its
 * casing. Pinned because the obvious alternative (widen the sibling's SHOUTY_SNAKE regex) was
 * MEASURED to match 2-3x more tokens: shell function names, file basenames, variable names.
 */
test('lowercase and kebab alert ids are caught — casing is not the identifier', () => {
  assert.ok(extractAlertIds('ALERT_ID = "x402-bazaar-delist"').has('x402-bazaar-delist'));
  assert.ok(extractAlertIds('ALERT_ID = "book_liveness_ceiling"').has('book_liveness_ceiling'));
  assert.ok(extractAlertIds('"$WRAP" gate-shadow-cpu CRITICAL_PERSISTENT -').has('gate-shadow-cpu'));
});

test('a call site through a VARIABLE is caught, not just the literal filename', () => {
  // The blind spot the prove-it-can-fail step exposed: the gate reported PASS on an
  // unregistered id added as `| "$TG" ID CRITICAL_PERSISTENT -`.
  assert.ok(extractAlertIds('  | "$TG" SOME_UNREGISTERED CRITICAL_PERSISTENT -').has('SOME_UNREGISTERED'));
});

test('prose is not an emission', () => {
  assert.equal(extractAlertIds('# send_telegram.sh enforces CRITICAL_PERSISTENT + 24h cooldown').size, 0);
});

test('every registry row is complete, and unadopted rows name a templated follow-up', () => {
  const rows = JSON.parse(readFileSync(REGISTRY, 'utf8')).alerts;
  assert.ok(rows.length > 0, 'vacuity: an empty registry would certify anything');
  for (const r of rows) {
    assert.ok(r.alert_id, 'row without an alert_id');
    assert.ok(r.owner, `${r.alert_id} has no owner`);
    if (!r.adopted) assert.ok(r.follow_up_wave, `${r.alert_id} is unadopted and names no follow-up wave`);
    assert.ok(!/-W\d+$/.test(r.follow_up_wave ?? ''), `${r.alert_id} names a LITERAL wave; must be templated W{NEXT}`);
  }
});

/**
 * The law's default, asserted against the DATA rather than the prose. CLAUDE.md holds that
 * recovery chatter is noise and silent recovery is the norm; announcing is opt-in per alert.
 * If this ever inverts, a wave has quietly turned every canary into a chatterbox.
 */
test('announce_resolution is opt-in — the overwhelming majority stay silent', () => {
  const rows = JSON.parse(readFileSync(REGISTRY, 'utf8')).alerts;
  const announced = rows.filter((r) => r.announce_resolution === true);
  assert.ok(announced.length >= 1, 'nothing announces — CH1 would be a dark feature');
  assert.ok(announced.length < rows.length / 2,
    `${announced.length}/${rows.length} announce; silence must remain the default`);
});
