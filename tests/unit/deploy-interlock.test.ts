/**
 * OPS-DEPLOY-LABELER-WINDOW-W1 CH2 — the deploy/labeler interlock policy.
 *
 * The MECHANISM already shipped (OPS-LABEL-FRESHNESS-W1 R2). What changed here is the POLICY:
 * a derived wait, a third outcome, and an SLO-gated catch-up. The logic was moved out of inline
 * workflow bash precisely so it could be asserted — inline bash in a YAML file is untestable, and
 * an interlock nobody can test is an interlock nobody can trust.
 *
 * Two properties are load-bearing and are asserted here rather than intended:
 *   · A HOTFIX IS NEVER BLOCKED. The hatch is total; it downgrades the outcome only.
 *   · THE PROBE FAILS OPEN. A deploy interlock that fails CLOSED can block every deploy on the
 *     strength of its own bug, which is categorically worse than the disease it treats.
 *
 * SPAWN BUDGET DECLARED on every block — each shells out to bash.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const SH = path.join(REPO, 'ops/scripts/deploy-labeler-interlock.sh');
const WORKFLOW = path.join(REPO, '.github/workflows/deploy.yml');

/** Run one subcommand with a scratch ledger/marker and a stubbed `docker`. */
function run(cmd: string, opts: { dockerRc?: number; hotfix?: boolean; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'interlock-'));
  const ledger = path.join(dir, 'ledger');
  const marker = path.join(dir, 'marker');
  const docker = path.join(dir, 'docker');
  writeFileSync(docker, `#!/bin/sh\nexit ${opts.dockerRc ?? 1}\n`, { mode: 0o755 });
  if (opts.env?.PRESEED_MARKER) writeFileSync(marker, '2026-08-22T03:19:30Z\n');
  const r = spawnSync('bash', [SH, cmd], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INTERLOCK_LEDGER: ledger,
      INTERLOCK_MARKER: marker,
      INTERLOCK_DOCKER: docker,
      INTERLOCK_WAIT_S: '2',
      INTERLOCK_TIERS: path.join(dir, 'tiers.json'),
      ...(opts.hotfix ? { DEPLOY_HOTFIX: '1' } : {}),
      ...(opts.env ?? {}),
    },
  });
  return {
    verdict: (r.stdout.match(/INTERLOCK_VERDICT=(\w+)/) || [])[1],
    status: r.status,
    ledger: existsSync(ledger) ? readFileSync(ledger, 'utf8') : '',
    markerExists: existsSync(marker),
  };
}

describe('CH2 — all four policy paths, each writing a record', () => {
  it('in flight + interruptible → DEFERRED, and it is recorded', { timeout: 40_000 }, () => {
    const r = run('preempt', { dockerRc: 0 });
    expect(r.verdict).toBe('DEFERRED');
    expect(r.ledger).toContain('interlock=DEFERRED');
  });

  it('nothing in flight → PROCEED, and it is recorded', { timeout: 40_000 }, () => {
    const r = run('preempt', { dockerRc: 1 });
    expect(r.verdict).toBe('PROCEED');
    expect(r.ledger).toContain('reason=no-labeler-in-flight');
  });

  it('probe indeterminate → INDETERMINATE, and it is recorded with the rc', { timeout: 40_000 }, () => {
    const r = run('preempt', { dockerRc: 7 });
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.ledger).toContain('docker_exec_rc=7');
  });

  it('hotfix → BYPASSED, and the bypass is LEDGERED not laundered', { timeout: 40_000 }, () => {
    const r = run('preempt', { hotfix: true });
    expect(r.verdict).toBe('BYPASSED');
    expect(r.ledger).toContain('interlock=BYPASSED');
    expect(r.ledger).toContain('reason=hotfix');
  });

  it('NO path is silent — every outcome writes a ledger row', { timeout: 40_000 }, () => {
    for (const r of [
      run('preempt', { dockerRc: 0 }), run('preempt', { dockerRc: 1 }),
      run('preempt', { dockerRc: 7 }), run('preempt', { hotfix: true }),
    ]) expect(r.ledger.trim().length).toBeGreaterThan(0);
  });
});

/**
 * OPS-DEPLOY-CATCHUP-DETACH-W1 — the catch-up must not hold the deploy's SSH session open.
 *
 * The backfill is budgeted up to 125 minutes and used to run in the FOREGROUND of that session,
 * whose action times out at ~10 minutes — so a deploy that had already fully succeeded (containers
 * recreated, host GIT_SHA advanced) reported FAILURE. Measured on runs 32616428011 and
 * 32619577958. A red badge meaning "deployed fine" trains an operator to ignore deploy failures.
 *
 * The shell --self-test asserts this too; it is ALSO asserted here because this file is what the
 * wired suite and the pre-push gate actually run.
 *
 * SPAWN BUDGET: 2 bash spawns.
 */
describe('OPS-DEPLOY-CATCHUP-DETACH-W1 — the catch-up is launched, not awaited', () => {
  it('returns immediately even though the child runs far past the SSH timeout', { timeout: 40_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'interlock-detach-'));
    const ledger = path.join(dir, 'ledger');
    const marker = path.join(dir, 'marker');
    const docker = path.join(dir, 'docker');
    // 30s stands in for the 125-minute backfill: comfortably past the 5s bound below, so a
    // regression to a foreground call cannot pass by being merely quick.
    writeFileSync(docker, '#!/bin/sh\nsleep 30\nexit 0\n', { mode: 0o755 });
    writeFileSync(marker, '2026-08-23T05:00:00Z\n');
    // Drive the REAL (setsid) branch, not the degraded one. `setsid` is util-linux and is ABSENT
    // on macOS, so without this the test silently takes the no-setsid fallback — which carries its
    // OWN `&` and therefore stays fast even if the production branch loses its detach entirely.
    // Measured: removing `&` from the setsid branch left this test GREEN until the seam was
    // injected here. A test that cannot reach the branch that ships is not covering it.
    const detach = path.join(dir, 'detach');
    writeFileSync(detach, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    const t0 = Date.now();
    const r = spawnSync('bash', [SH, 'catchup'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        INTERLOCK_LEDGER: ledger,
        INTERLOCK_MARKER: marker,
        INTERLOCK_DOCKER: docker,
        INTERLOCK_TIERS: path.join(dir, 'tiers.json'),
        INTERLOCK_WORST_OVERRIDE: '140',   // past SLO, so the catch-up is warranted
        INTERLOCK_REMAINING_OVERRIDE: '99',
        INTERLOCK_CARRY_LOG: path.join(dir, 'carry.log'),
        INTERLOCK_RUNNER_LOG: path.join(dir, 'runner.log'),
        INTERLOCK_DETACH: detach,
      },
    });
    const elapsedMs = Date.now() - t0;
    expect(r.status).toBe(0);
    expect((r.stdout.match(/INTERLOCK_VERDICT=(\w+)/) || [])[1]).toBe('DEFERRED');
    expect(elapsedMs).toBeLessThan(5_000);
    const led = readFileSync(ledger, 'utf8');
    // LAUNCHED, not "running" — the record must be true at the moment it is written.
    expect(led).toContain('catchup=launched');
    expect(led).not.toContain('catchup=running');
    // The detach mode is recorded, so a host without setsid degrades LOUDLY instead of
    // failing the launch into a discarded background job and skipping the work in silence.
    expect(led).toMatch(/detach=\S+/);
    // …and specifically NOT the degraded fallback, or this covers the wrong branch.
    expect(led).not.toContain('detach=degraded');
  });

  it('the runner records a TERMINAL outcome, so "launched" is always answered', { timeout: 40_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'interlock-runner-'));
    const ledger = path.join(dir, 'ledger');
    const docker = path.join(dir, 'docker');
    const flock = path.join(dir, 'flock');
    writeFileSync(docker, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    // `flock -n <lock> <cmd...>` — drop our own two args and exec the command.
    writeFileSync(flock, '#!/bin/sh\nshift 2\nexec "$@"\n', { mode: 0o755 });
    const r = spawnSync('bash', [SH, '--catchup-runner', '5'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        INTERLOCK_LEDGER: ledger,
        INTERLOCK_DOCKER: docker,
        INTERLOCK_FLOCK: flock,
        INTERLOCK_CARRY_LOG: path.join(dir, 'carry.log'),
      },
    });
    expect(r.status).toBe(0);
    const led = readFileSync(ledger, 'utf8');
    // The rc that caused it, carried — the old inline call ended in `|| true` and lost it.
    expect(led).toContain('catchup=failed rc=7');
    expect(led).not.toContain('catchup=finished');
  });
});

describe('AC2.4 — a hotfix ALWAYS proceeds, whatever the probe would have said', () => {
  it.each([0, 1, 7, 125])('proceeds with docker rc=%i', { timeout: 40_000 }, (rc) => {
    // The hatch must be TOTAL. A hatch that fails when it is most needed gets replaced by
    // someone doing the thing manually, which writes no record at all.
    const r = run('preempt', { dockerRc: rc, hotfix: true });
    expect(r.verdict).toBe('BYPASSED');
    expect(r.status).toBe(0);
  });

  it('a hotfix also skips the catch-up, and says so', { timeout: 40_000 }, () => {
    const r = run('catchup', { dockerRc: 0, hotfix: true, env: { PRESEED_MARKER: '1' } });
    expect(r.verdict).toBe('BYPASSED');
    expect(r.ledger).toContain('catchup=skipped');
  });
});

describe('AC2.5 — probe failure fails OPEN, never closed', () => {
  it.each([2, 7, 125, 126, 127])('rc=%i yields INDETERMINATE and exit 0', { timeout: 40_000 }, (rc) => {
    const r = run('preempt', { dockerRc: rc });
    expect(r.verdict).toBe('INDETERMINATE');
    // Exit 0 is the fail-OPEN half: a deploy must never be blocked by this script's own bugs.
    expect(r.status).toBe(0);
  });

  it('an unreachable probe is NEVER reported as clean', { timeout: 40_000 }, () => {
    const r = run('preempt', { dockerRc: 7 });
    expect(r.ledger).not.toContain('interlock=PROCEED');
    expect(r.verdict).not.toBe('PROCEED');
  });
});

describe('AC2.6 — the bounded wait expires rather than hanging', () => {
  it('returns within its budget when the labeler never exits', { timeout: 40_000 }, () => {
    const t0 = Date.now();
    const r = run('preempt', { dockerRc: 0 });   // pkill -0 always succeeds => never exits
    const elapsed = (Date.now() - t0) / 1000;
    expect(r.verdict).toBe('DEFERRED');
    expect(elapsed).toBeLessThan(20);
    expect(r.ledger).toContain('wait-expired');
  });

  it('the SHIPPED wait is the DERIVED value, not the old 30s', { timeout: 40_000 }, () => {
    // 57.194s max in-flight batch sleep (n=400) + 38.32s worst per-group (n=466) = 95.5s, +25%.
    // A single in-flight sleep used to outlast the entire 30s budget.
    const w = spawnSync('bash', [SH, '--print-wait'], { encoding: 'utf8' }).stdout.trim();
    expect(Number(w)).toBe(120);
    expect(Number(w)).toBeGreaterThan(57.194 + 38.32);
  });
});

describe('CH2 — the SLO gate decides whether a catch-up is owed at all', () => {
  it('SKIPS when the worst projected lag is inside SLO', { timeout: 40_000 }, () => {
    const r = run('catchup', { dockerRc: 0, env: { PRESEED_MARKER: '1', INTERLOCK_WORST_OVERRIDE: '80' } });
    expect(r.verdict).toBe('PROCEED');
    expect(r.ledger).toContain('reason=within-slo');
    expect(r.markerExists).toBe(false);
  });

  it('SKIPS when the original run has no budget left', { timeout: 40_000 }, () => {
    const r = run('catchup', {
      dockerRc: 0,
      env: { PRESEED_MARKER: '1', INTERLOCK_WORST_OVERRIDE: '140', INTERLOCK_REMAINING_OVERRIDE: '0' },
    });
    expect(r.verdict).toBe('PROCEED');
    expect(r.ledger).toContain('no-budget-remaining');
  });

  it('does nothing when no preemption happened this deploy', { timeout: 40_000 }, () => {
    const r = run('catchup', { dockerRc: 0 });
    expect(r.verdict).toBe('PROCEED');
    expect(r.ledger).toContain('no-preemption-this-deploy');
  });

  it('an UNEVALUABLE SLO gate is INDETERMINATE — never a silent catch-up, never a silent skip',
    { timeout: 40_000 }, () => {
      const r = run('catchup', { dockerRc: 0, env: { PRESEED_MARKER: '1', INTERLOCK_TIERS: '/nonexistent' } });
      expect(r.verdict).toBe('INDETERMINATE');
      expect(r.ledger).toContain('slo-gate-unevaluable');
    });
});

describe('Q6 — the pattern is pinned to the REAL script, and the workflow really calls it', () => {
  it('the interlock pattern matches a script that exists on disk', { timeout: 40_000 }, () => {
    // A rename of the labeler would otherwise silently stop matching, with nothing red — the
    // registry's real generator value, kept at 1% of its cost.
    const pattern = spawnSync('bash', [SH, '--print-pattern'], { encoding: 'utf8' }).stdout.trim();
    const rel = spawnSync('bash', [SH, '--print-script'], { encoding: 'utf8' }).stdout.trim();
    expect(existsSync(path.join(REPO, rel))).toBe(true);
    expect(rel).toContain(path.basename(pattern));
  });

  it('AC2.7 — the same pattern also matches the docker-exec RECOVERY invocation', { timeout: 40_000 }, () => {
    // The recovery lane runs `node dist/scripts/backfill-directional-labels.js --venue X`, so one
    // pattern covers both the nightly and the recovery. That is why the exit=137 class is in scope.
    const pattern = spawnSync('bash', [SH, '--print-pattern'], { encoding: 'utf8' }).stdout.trim();
    const recovery = 'node dist/scripts/backfill-directional-labels.js --venue BYBIT --lookback-days 21';
    expect(recovery).toContain(pattern);
  });

  it('deploy.yml actually invokes BOTH subcommands — a script nothing calls is dead', { timeout: 40_000 }, () => {
    const wf = readFileSync(WORKFLOW, 'utf8');
    expect(wf).toContain('deploy-labeler-interlock.sh preempt');
    expect(wf).toContain('deploy-labeler-interlock.sh catchup');
    // The old inline literal must be GONE, or two interlocks would race.
    expect(wf).not.toContain("pkill -TERM -f 'dist/scripts/backfill-directional-labels'");
  });

  it('the script self-test passes', { timeout: 40_000 }, () => {
    const r = spawnSync('bash', [SH, '--self-test'], { encoding: 'utf8' });
    expect(r.stdout).toContain('SELF-TEST: PASS');
    expect(r.status).toBe(0);
  });
});

describe('AC2.9 — zero firewall or inbound network mutations', () => {
  it('the interlock never touches a network rule', { timeout: 40_000 }, () => {
    const src = readFileSync(SH, 'utf8');
    for (const bad of ['iptables', 'ufw ', 'firewall-cmd', 'nft ']) expect(src).not.toContain(bad);
  });
});
