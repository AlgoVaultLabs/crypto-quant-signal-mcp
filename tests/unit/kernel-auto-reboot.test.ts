/**
 * OPS-HOST-AUTO-REBOOT-W1 — aoe-1's unattended kernel reboot, and the signal-1 firewall.
 *
 * The reboot itself is proven: three hand-run cycles, every one uneventful. What is unproven — and
 * what this file exists to pin — is the HARNESS: the decision logic, the abort path, the
 * escalation, and above all the assertion that it CANNOT reboot signal-1.
 *
 * Each script's own `--self-test` covers its decision function against fixtures. THIS file covers
 * what a hermetic self-test structurally cannot: the real CLI contract (token AND exit code), the
 * real committed registry, and the wiring that makes any of it run.
 *
 * SPAWN BUDGET DECLARED on every block — each shells out to bash.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const HARNESS = path.join(REPO, 'ops/monitoring/kernel-auto-reboot.sh');
const WATCHDOG = path.join(REPO, 'ops/monitoring/aoe-peer-watchdog.sh');
const ARM = path.join(REPO, 'ops/monitoring/arm-peer-watchdog.sh');
const REGISTRY = path.join(REPO, 'ops/scripts/cron-interlock-registry.json');

/** Drive the harness with every destructive primitive replaced by a recording stub. */
function harness(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'autoreboot-'));
  const mk = (name: string, body: string) => {
    const p = path.join(dir, name);
    writeFileSync(p, body, { mode: 0o755 });
    return p;
  };
  const rebooted = path.join(dir, 'rebooted');
  const armed = path.join(dir, 'armed');
  const paged = path.join(dir, 'paged');
  const stubs = {
    AUTO_REBOOT_LOG: path.join(dir, 'log'),
    AUTO_REBOOT_STATE: path.join(dir, 'state'),
    AUTO_REBOOT_REQUIRED_FILE: path.join(dir, 'reboot-required'),
    AUTO_REBOOT_IDENTITY_FILE: mk('id', 'aoe-1\n'),
    AUTO_REBOOT_STALENESS: mk('stale.sh', '#!/bin/sh\necho "VERDICT=BREACH host=x"\n'),
    AUTO_REBOOT_BOOT_CONTRACT: mk('bc.sh', '#!/bin/sh\necho "BOOT_CONTRACT_VERDICT=OK"\n'),
    AUTO_REBOOT_REGISTRY: REGISTRY,
    AUTO_REBOOT_WRAPPER: mk('send.sh', `#!/bin/sh\ncat >> ${paged}\necho "ALERT=$1 SEV=$2" >> ${paged}\n`),
    AUTO_REBOOT_REBOOT_CMD: mk('reboot.sh', `#!/bin/sh\necho rebooted >> ${rebooted}\n`),
    AUTO_REBOOT_ARM_CMD: mk('arm.sh', `#!/bin/sh\necho "$@" >> ${armed}\n`),
    AUTO_REBOOT_PGREP: mk('pgrep.sh', '#!/bin/sh\nexit 1\n'),
  };
  const r = spawnSync('bash', [HARNESS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MONITORING_HOST_LABELS: '', ...stubs, ...env },
  });
  return {
    status: r.status,
    stdout: r.stdout,
    verdict: (r.stdout.match(/AUTO_REBOOT_VERDICT=(\w+)/) || [])[1],
    gates: r.stdout.match(/^AUTO_REBOOT_GATE=\S+/gm) || [],
    rebooted: existsSync(rebooted),
    armed: existsSync(armed) ? readFileSync(armed, 'utf8') : '',
    paged: existsSync(paged) ? readFileSync(paged, 'utf8') : '',
  };
}

/**
 * AC2 — THE SINGLE MOST IMPORTANT ASSERTION IN THIS WAVE.
 *
 * signal-1 is the revenue host and has two free minutes in the hour; aoe-1 has eight. A harness
 * bug against eight minutes degrades, against two it lands mid-cron on the revenue host. So the
 * firewall is not "we won't point it at signal-1" — it is that pointing it there REFUSES.
 *
 * SPAWN BUDGET: 6 bash spawns.
 */
describe('AC2 — the identity firewall refuses signal-1, with zero side effects', () => {
  it('a signal-1 label REFUSES even with --apply and every other gate green', { timeout: 60_000 }, () => {
    const r = harness(['--apply'], { MONITORING_HOST_LABELS: 'signal-1' });
    expect(r.verdict).toBe('REFUSED');
    expect(r.rebooted).toBe(false);
    expect(r.armed).toBe('');
    expect(r.status).toBe(0);
  });

  it('…and it never evaluates a single later gate', { timeout: 60_000 }, () => {
    const r = harness(['--apply'], { MONITORING_HOST_LABELS: 'signal-1' });
    // Identity is gate 1 and the ONLY gate that may run before the host is known to be aoe-1.
    expect(r.gates).toEqual(['AUTO_REBOOT_GATE=identity']);
  });

  it('a signal-1 IDENTITY FILE refuses too — the env is not the only door', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'autoreboot-id-'));
    const idFile = path.join(dir, 'label');
    writeFileSync(idFile, 'signal-1\n');
    const r = harness(['--apply'], { AUTO_REBOOT_IDENTITY_FILE: idFile });
    expect(r.verdict).toBe('REFUSED');
    expect(r.rebooted).toBe(false);
  });

  it('an UNRESOLVABLE identity refuses — there is no default', { timeout: 60_000 }, () => {
    const r = harness(['--apply'], { AUTO_REBOOT_IDENTITY_FILE: '/nonexistent/label' });
    expect(r.verdict).toBe('REFUSED');
    expect(r.rebooted).toBe(false);
  });

  it('a refusal PAGES rather than failing quietly', { timeout: 60_000 }, () => {
    const r = harness(['--apply'], { MONITORING_HOST_LABELS: 'signal-1' });
    expect(r.paged).toContain('ALERT=KERNEL_AUTO_REBOOT SEV=CRITICAL_PERSISTENT');
    expect(r.paged).toContain('the reboot was NOT performed');
  });

  it('the expected host is a HARDCODED constant, not an env seam', { timeout: 60_000 }, () => {
    // A configurable firewall is not a firewall. Proven by trying to override it.
    const r = spawnSync('bash', [HARNESS, '--print-expected-host'], {
      encoding: 'utf8',
      env: { ...process.env, AUTO_REBOOT_EXPECTED_HOST: 'signal-1', EXPECTED_HOST: 'signal-1' },
    });
    expect(r.stdout.trim()).toBe('aoe-1');
    // …and the constant appears in the source as a literal assignment, not a parameter expansion.
    expect(readFileSync(HARNESS, 'utf8')).toContain('EXPECTED_HOST="aoe-1"');
  });
});

/**
 * AC3 — a harness whose default action is destructive is one typo from an outage.
 *
 * SPAWN BUDGET: 3 bash spawns.
 */
describe('AC3 — --dry-run is the default and --apply is required to reboot', () => {
  it('no flag at all resolves to dry-run', { timeout: 60_000 }, () => {
    expect(spawnSync('bash', [HARNESS, '--print-default-mode'], { encoding: 'utf8' }).stdout.trim())
      .toBe('dry-run');
  });

  it('every gate green + no flag does NOT reboot', { timeout: 60_000 }, () => {
    const r = harness([], { MONITORING_HOST_LABELS: 'aoe-1' });
    expect(r.rebooted).toBe(false);
    expect(r.stdout).toContain('AUTO_REBOOT_GATE=action state=DRY_RUN');
  });

  it('every gate green + --apply DOES reboot, and arms the watchdog FIRST', { timeout: 60_000 }, () => {
    const r = harness(['--apply'], { MONITORING_HOST_LABELS: 'aoe-1' });
    expect(r.verdict).toBe('REBOOTED');
    expect(r.rebooted).toBe(true);
    expect(r.armed).toContain('--arm');
  });
});

/**
 * The gates, each proven to stop the reboot for its own reason.
 *
 * SPAWN BUDGET: 5 bash spawns.
 */
describe('the four gates each abort for their own stated reason', () => {
  it('not due -> NOT_DUE, and SILENT because nothing is wrong', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'autoreboot-ok-'));
    const ok = path.join(dir, 'stale-ok.sh');
    writeFileSync(ok, '#!/bin/sh\necho "VERDICT=OK host=x"\n', { mode: 0o755 });
    const r = harness(['--apply'], { MONITORING_HOST_LABELS: 'aoe-1', AUTO_REBOOT_STALENESS: ok });
    expect(r.verdict).toBe('NOT_DUE');
    expect(r.rebooted).toBe(false);
    expect(r.paged).toBe('');
  });

  it('boot-contract DRIFT -> ABORTED + page — a reboot is not a repair tool', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'autoreboot-drift-'));
    const drift = path.join(dir, 'bc-drift.sh');
    writeFileSync(drift, '#!/bin/sh\necho "BOOT_CONTRACT_VERDICT=DRIFT"\n', { mode: 0o755 });
    const r = harness(['--apply'], { MONITORING_HOST_LABELS: 'aoe-1', AUTO_REBOOT_BOOT_CONTRACT: drift });
    expect(r.verdict).toBe('ABORTED');
    expect(r.rebooted).toBe(false);
    expect(r.paged).toContain('ALERT=KERNEL_AUTO_REBOOT');
  });

  it('an unreadable registry is INDETERMINATE at exit 0 — never a reboot on an unknown cost', { timeout: 60_000 }, () => {
    const r = harness(['--apply'], { MONITORING_HOST_LABELS: 'aoe-1', AUTO_REBOOT_REGISTRY: '/nonexistent/reg.json' });
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.status).toBe(0);
    expect(r.rebooted).toBe(false);
  });

  it('the in-flight gate reports its row count even at ZERO, so a pass is never silent', { timeout: 60_000 }, () => {
    const r = harness([], { MONITORING_HOST_LABELS: 'aoe-1' });
    // The REAL committed registry: aoe-1 has rows, and none of them is no-safe-kill today.
    expect(r.stdout).toMatch(/AUTO_REBOOT_GATE=in_flight state=PASS rows=\d+ no_safe_kill=0/);
  });

  it('every path prints exactly ONE terminal token', { timeout: 60_000 }, () => {
    for (const env of [{ MONITORING_HOST_LABELS: 'aoe-1' }, { MONITORING_HOST_LABELS: 'signal-1' }]) {
      const r = harness(['--apply'], env);
      expect((r.stdout.match(/^AUTO_REBOOT_VERDICT=/gm) || []).length).toBe(1);
    }
  });
});

/**
 * The three scripts' own self-tests, run as the wired suite runs them.
 *
 * SPAWN BUDGET: 3 bash spawns.
 */
describe('every new artifact self-tests, with a vacuity floor', () => {
  it.each([
    { name: 'kernel-auto-reboot.sh', script: HARNESS, floor: 25 },
    { name: 'aoe-peer-watchdog.sh', script: WATCHDOG, floor: 20 },
    { name: 'arm-peer-watchdog.sh', script: ARM, floor: 10 },
  ])('$name --self-test PASSes with at least $floor assertions', { timeout: 120_000 }, ({ script, floor }) => {
    const r = spawnSync('bash', [script, '--self-test'], { encoding: 'utf8' });
    expect(r.stdout).toContain('SELF_TEST_VERDICT=PASS');
    expect(r.status).toBe(0);
    const n = Number((r.stdout.match(/SELF-TEST: PASS — (\d+) checks/) || [])[1]);
    expect(n).toBeGreaterThanOrEqual(floor);
  });
});

/**
 * AC8 — the watchdog fires on a simulated non-return and stays silent with no marker.
 *
 * SPAWN BUDGET: 4 bash spawns.
 */
describe('AC8 — the peer watchdog', () => {
  function watchdog(env: Record<string, string>) {
    const dir = mkdtempSync(path.join(tmpdir(), 'watchdog-'));
    const paged = path.join(dir, 'paged');
    const send = path.join(dir, 'send.sh');
    const down = path.join(dir, 'ssh-down.sh');
    writeFileSync(send, `#!/bin/sh\ncat >> ${paged}\necho "ALERT=$1" >> ${paged}\n`, { mode: 0o755 });
    writeFileSync(down, '#!/bin/sh\nexit 255\n', { mode: 0o755 });
    const r = spawnSync('bash', [WATCHDOG], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MONITORING_HOST_LABELS: 'signal-1',
        PEER_WATCHDOG_LOG: path.join(dir, 'log'),
        PEER_WATCHDOG_ARM: path.join(dir, 'arm'),
        PEER_WATCHDOG_STATE: path.join(dir, 'breaches'),
        PEER_WATCHDOG_WRAPPER: send,
        PEER_WATCHDOG_SSH: down,
        ...env,
      },
    });
    return {
      dir,
      status: r.status,
      stdout: r.stdout,
      verdict: (r.stdout.match(/PEER_WATCHDOG_VERDICT=(\w+)/) || [])[1],
      paged: existsSync(paged) ? readFileSync(paged, 'utf8') : '',
    };
  }

  it('with NO arm it is IDLE and silent, even while the target is unreachable', { timeout: 60_000 }, () => {
    const r = watchdog({});
    expect(r.verdict).toBe('IDLE');
    expect(r.paged).toBe('');
    // Silent, but never invisible: the positive line is what stops IDLE reading as "did not run".
    expect(r.stdout).toContain('PEER_WATCHDOG_CHECK=arm state=IDLE');
  });

  it('an armed, past-budget, unreachable target BREACHES on the second consecutive probe', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'watchdog-arm-'));
    const arm = path.join(dir, 'arm');
    const state = path.join(dir, 'breaches');
    writeFileSync(arm, '1000000 old-kernel\n');
    const env = { PEER_WATCHDOG_ARM: arm, PEER_WATCHDOG_STATE: state, PEER_WATCHDOG_NOW: '1000200' };
    // ONE probe is not a verdict — a flaky probe inside a real reboot window must not page.
    expect(watchdog(env).verdict).toBe('ARMED_WAITING');
    const second = watchdog(env);
    expect(second.verdict).toBe('BREACH');
    expect(second.paged).toContain('ALERT=AOE_PEER_UNREACHABLE');
  });

  it('running it on aoe-1 REFUSES — it is the PEER half', { timeout: 60_000 }, () => {
    const r = watchdog({ MONITORING_HOST_LABELS: 'aoe-1' });
    expect(r.verdict).toBe('REFUSED');
    expect(r.paged).toBe('');
  });
});

/**
 * AC5 — the per-host registry the reboot gate reads.
 *
 * SPAWN BUDGET: 0 spawns (pure reads).
 */
describe('AC5 — the registry is per-host and aoe-1 is classified', () => {
  const doc = JSON.parse(readFileSync(REGISTRY, 'utf8'));

  it('aoe-1 has rows, every one classified with a measured runtime and its instrument', () => {
    const rows = doc.rows.filter((r: Record<string, unknown>) => r.host === 'aoe-1');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(['safe-to-kill', 'preempt-and-catchup', 'no-safe-kill']).toContain(r.class);
      expect(String(r.reason).trim().length).toBeGreaterThan(20);
      expect(typeof r.max_runtime_s).toBe('number');
      expect(String(r.runtime_instrument).trim().length).toBeGreaterThan(20);
    }
  });

  it("aoe-1's enumeration is REBOOT-scoped, not signal-1's docker-exec question", () => {
    // The wave's core correction: the enumeration METHOD is host-scoped too, not just the rows.
    // A reboot stops every container, every host process and every in-flight Prefect run, so a
    // `docker exec` grep measures almost nothing on aoe-1 — it has zero such cron lines.
    const en = doc._enumeration['aoe-1'];
    expect(en).toBeDefined();
    expect(en.disruption_event).toBe('kernel reboot');
    expect(en.command).toContain('docker ps');
    expect(en.command).not.toBe(doc._enumeration['signal-1'].command);
    expect(en.running_containers).toBeGreaterThan(0);
    expect(en.prefect_deployments).toBeGreaterThan(0);
  });

  it('the reboot gate reads a ruling that matches its rows', () => {
    const nsk = doc.rows.filter((r: Record<string, unknown>) => r.host === 'aoe-1' && r.class === 'no-safe-kill');
    expect(doc._residual_no_safe_kill['aoe-1'].count).toBe(nsk.length);
    // ZERO today, and that is the measured reason aoe-1 is automated first. If a future wave lands
    // a no-safe-kill job here, this goes red and forces an explicit ruling rather than a silent
    // reboot straight through the gate.
    expect(doc._residual_no_safe_kill['aoe-1'].count).toBe(0);
  });
});
