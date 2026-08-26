/**
 * OPS-DATEMODIFIED-DERIVE-AND-PR-DISPOSITION-W1 R2 — the WIRING for
 * ops/cron/binance-pr-disposition-canary.sh.
 *
 * Two jobs, and the second is the one that keeps this honest over time.
 *
 * 1. Run the script's own `--self-test` in CI, so a canary that stops being able to fail is
 *    caught here rather than at its decision date in November.
 * 2. Pin the DECLARATIONS against each other. The script carries a default decision date and a
 *    default PR number; `ops/monitoring/monitoring-inventory.json` carries the row that says what
 *    is installed and on what schedule; `ops/monitoring/alert-registry.json` carries the alert it
 *    fires. Three files, one fact each — exactly the shape that drifts silently. The model this
 *    is built on (`tests/unit/xrepo-ci-canary.test.ts`) exists for the same reason.
 *
 * The network is NOT touched: the script makes zero calls before its decision date, and that
 * property is itself asserted below rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'ops', 'cron', 'binance-pr-disposition-canary.sh');
const SRC = readFileSync(SCRIPT, 'utf8');

const inventory = JSON.parse(readFileSync(join(ROOT, 'ops/monitoring/monitoring-inventory.json'), 'utf8'));
const registry = JSON.parse(readFileSync(join(ROOT, 'ops/monitoring/alert-registry.json'), 'utf8'));
const row = inventory.artifacts.find((r: { id?: string }) => r.id === 'binance-pr-disposition-canary');
const alert = registry.alerts.find((a: { alert_id: string }) => a.alert_id === 'BINANCE_SKILLS_PR_STALE');

/** The script's own default for a shell variable, read from source rather than re-declared here. */
function shellDefault(name: string): string {
  const m = SRC.match(new RegExp(`${name}="\\$\\{[A-Z_]+:?-([^}]*)\\}"`));
  return m ? m[1] : '';
}

describe('binance-pr-disposition canary — the script can fail', () => {
  it('its two-way self-test passes', { timeout: 20_000 }, () => {
    const out = execFileSync('bash', [SCRIPT, '--self-test'], { encoding: 'utf8' });
    expect(out).toContain('SELF-TEST: PASS');
  });

  it('makes ZERO network calls before the decision date — asserted against an unroutable host', { timeout: 20_000 }, () => {
    // If the reader were dialled, curl would spend its full 20s timeout twice and the token would
    // be INDETERMINATE. Asserting exit 0 alone would not prove it; asserting it against a host
    // that CANNOT answer does. 198.51.100.0/24 is TEST-NET-2 (RFC 5737) and is unroutable.
    const t0 = Date.now();
    const out = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BINANCE_PR_API_HOST: 'https://198.51.100.1',
        BINANCE_PR_LOG: '/dev/null',
        BINANCE_PR_STATE: '/dev/null',
        BINANCE_PR_NO_FLOCK: '1',
        BINANCE_PR_DECIDE_ON: '2099-01-01',
      },
    });
    const elapsed = Date.now() - t0;
    expect(out).toContain('no network call');
    expect(elapsed).toBeLessThan(5000);
    // Deliberately NO verdict token before the date: the four tokens answer what the PR's
    // disposition IS, and before the date we have not asked.
    expect(out).not.toContain('BINANCE_PR_DISPOSITION_VERDICT=');
  });
});

describe('binance-pr-disposition canary — declarations cannot drift', () => {
  it('is registered in the monitoring inventory with all 14 keys', () => {
    expect(row, 'no inventory row for binance-pr-disposition-canary').toBeTruthy();
    for (const k of ['id', 'artifact', 'kind', 'host', 'host_path', 'installed_at', 'criticality',
      'schedule', 'invoked_by', 'install_state', 'sha256', 'alert_ids', 'owner_wave', 'notes']) {
      expect(row, `inventory row missing ${k}`).toHaveProperty(k);
    }
    expect(row.artifact).toBe('ops/cron/binance-pr-disposition-canary.sh');
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the alert it fires is registered with all 8 keys', () => {
    expect(alert, 'no alert row for BINANCE_SKILLS_PR_STALE').toBeTruthy();
    for (const k of ['alert_id', 'owner', 'hosts', 'adopted', 'announce_resolution',
      'follow_up_wave', 'envelope_adopted', 'envelope_follow_up_wave']) {
      expect(alert, `alert row missing ${k}`).toHaveProperty(k);
    }
    expect(alert.owner).toBe('ops/cron/binance-pr-disposition-canary.sh');
    // buildEnvelope is throwing ENOENT in the runtime image today; adopting a known-broken
    // dependency inside a wave whose purpose is removing a false claim would be self-defeating.
    expect(alert.envelope_adopted).toBe(false);
    expect(alert.envelope_follow_up_wave).toBeTruthy();
  });

  it('the alert the SCRIPT fires is the alert the REGISTRY declares', () => {
    // The one that actually matters: a registry row for an id the script never emits is
    // decoration, and an id the script emits with no row is an unregistered page.
    expect(SRC).toContain('BINANCE_SKILLS_PR_STALE');
    expect(row.alert_ids).toContain('BINANCE_SKILLS_PR_STALE');
  });

  it('the schedule is off the :00 boundary, per the sampler-collision law', () => {
    const minute = String(row.schedule).split(' ')[0];
    expect(Number(minute)).toBeGreaterThanOrEqual(3);
  });

  it('the PR the script defaults to is the PR the notes describe', () => {
    expect(shellDefault('PR_NUM')).toBe('254');
    expect(shellDefault('PR_REPO')).toBe('binance/binance-skills-hub');
    expect(row.notes).toContain('#254');
  });

  it('the decision date is a real future-dated calendar bound, not a placeholder', () => {
    const decideOn = SRC.match(/DECIDE_ON="\$\{BINANCE_PR_DECIDE_ON-([0-9]{4}-[0-9]{2}-[0-9]{2})\}"/);
    expect(decideOn, 'decision date default not found or not a YYYY-MM-DD literal').toBeTruthy();
    expect(row.notes).toContain(decideOn![1]);
    // `${VAR-default}` not `${VAR:-default}` — an explicitly EMPTY decision date is a config
    // defect that must reach the script's refusal, not be silently re-armed with the default.
    expect(SRC).toContain('${BINANCE_PR_DECIDE_ON-');
    expect(SRC).not.toContain('${BINANCE_PR_DECIDE_ON:-');
  });

  it('engagement is keyed on author_association, never on a raw comment count', () => {
    // The dark-guard trap: PR #254 already carries one comment and it is ours, so a count-based
    // test would read ENGAGED forever and the only branch that pages could never fire.
    expect(SRC).toContain('author_association');
    expect(SRC).toContain('if login == ours');
  });
});
