/**
 * OPS-DEPLOY-LABELER-WINDOW-W1 CH2 -> OPS-DEPLOY-INTERLOCK-CRON-DEFER-W1 — the deploy/cron
 * interlock policy.
 *
 * The MECHANISM already shipped (OPS-LABEL-FRESHNESS-W1 R2). What CH2 changed was the POLICY:
 * a derived wait, a third outcome, and an SLO-gated catch-up. The logic was moved out of inline
 * workflow bash precisely so it could be asserted — inline bash in a YAML file is untestable, and
 * an interlock nobody can test is an interlock nobody can trust.
 *
 * OPS-DEPLOY-INTERLOCK-CRON-DEFER-W1 then made the protected SET data
 * (ops/scripts/cron-interlock-registry.json) and renamed the script, because a name that lies is
 * the defect OPS-HOST-KERNEL-REBOOT-W3 CH3 retired for alert copy.
 *
 * Three properties are load-bearing and are asserted here rather than intended:
 *   · A HOTFIX IS NEVER BLOCKED. The hatch is total; it downgrades the outcome only.
 *   · THE PROBE FAILS OPEN. A deploy interlock that fails CLOSED can block every deploy on the
 *     strength of its own bug, which is categorically worse than the disease it treats.
 *   · CARRY-LABELER BEHAVIOUR DID NOT CHANGE when its policy moved into a registry row.
 *
 * SPAWN BUDGET DECLARED on every block — each shells out to bash.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const SH = path.join(REPO, 'ops/scripts/deploy-cron-interlock.sh');
const REGISTRY = path.join(REPO, 'ops/scripts/cron-interlock-registry.json');
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
    verdict: (r.stdout.match(/INTERLOCK_VERDICT=(\w+)/g) || []).slice(-1)[0]?.split('=')[1],
    jobLines: (r.stdout.match(/^INTERLOCK_JOB=.*$/gm) || []),
    stdout: r.stdout,
    status: r.status,
    ledger: existsSync(ledger) ? readFileSync(ledger, 'utf8') : '',
    markerExists: existsSync(marker),
  };
}

/** A single-row registry, so a dispatch case is driven without the real 20-row corpus. */
function oneRowRegistry(dir: string, row: Record<string, unknown>) {
  const p = path.join(dir, 'reg.json');
  writeFileSync(p, JSON.stringify({ schema_version: 1, rows: [row] }));
  return p;
}

const LABELER_ROW = {
  id: 'carry-labeler',
  script: 'src/scripts/backfill-directional-labels.ts',
  container: 'ctr',
  process_pattern: 'dist/scripts/backfill-directional-labels',
  class: 'preempt-and-catchup',
  reason: 'checkpoint-resumable but SLO-sensitive',
};

describe('CH2 — all four policy paths, each writing a record', () => {
  it('in flight + interruptible → DEFERRED, and it is recorded', { timeout: 60_000 }, () => {
    const r = run('preempt', { dockerRc: 0 });
    expect(r.verdict).toBe('DEFERRED');
    expect(r.ledger).toContain('interlock=DEFERRED');
  });

  it('nothing in flight → PROCEED, and it is recorded', { timeout: 60_000 }, () => {
    const r = run('preempt', { dockerRc: 1 });
    expect(r.verdict).toBe('PROCEED');
    expect(r.ledger).toContain('reason=no-labeler-in-flight');
  });

  it('probe indeterminate → INDETERMINATE, and it is recorded with the rc', { timeout: 60_000 }, () => {
    const r = run('preempt', { dockerRc: 7 });
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.ledger).toContain('docker_exec_rc=7');
  });

  it('hotfix → BYPASSED, and the bypass is LEDGERED not laundered', { timeout: 60_000 }, () => {
    const r = run('preempt', { hotfix: true });
    expect(r.verdict).toBe('BYPASSED');
    expect(r.ledger).toContain('interlock=BYPASSED');
    expect(r.ledger).toContain('reason=hotfix');
  });

  it('NO path is silent — every outcome writes a ledger row', { timeout: 60_000 }, () => {
    for (const r of [
      run('preempt', { dockerRc: 0 }), run('preempt', { dockerRc: 1 }),
      run('preempt', { dockerRc: 7 }), run('preempt', { hotfix: true }),
    ]) expect(r.ledger.trim().length).toBeGreaterThan(0);
  });
});

/**
 * OPS-DEPLOY-INTERLOCK-CRON-DEFER-W1 — AC7.
 *
 * CARRY-LABELER BEHAVIOUR IS UNCHANGED, PROVEN BY FIXTURE RATHER THAN BY INSPECTION.
 *
 * The golden strings below are the OUTPUT OF THE PRE-RENAME SCRIPT, captured 2026-08-29 by
 * running `git show origin/main:ops/scripts/deploy-labeler-interlock.sh` over these five
 * scenarios with identical seams. They are literals rather than a live `git show` on purpose: a
 * test that reads a remote ref is a test that fails on a shallow CI checkout, and the point of a
 * golden fixture is that it does not move when the thing it pins moves.
 *
 * ONE DECLARED DIFFERENCE: every record now carries a leading `job=<id>` field. With more than
 * one job in scope a ledger row that cannot say WHICH job it describes is unreadable, and nothing
 * machine-parses that log (grepped 2026-08-29 across the repo and /opt/algovault-monitoring: zero
 * consumers). Everything after that field is byte-identical, which is what these assertions pin.
 *
 * SPAWN BUDGET: 5 bash spawns.
 */
describe('AC7 — the registry-driven path reproduces the hardcoded carry-labeler behaviour', () => {
  const GOLDEN: Array<{ label: string; cmd: string; opts: Parameters<typeof run>[1]; token: string; record: string }> = [
    { label: 'hotfix', cmd: 'preempt', opts: { hotfix: true }, token: 'BYPASSED',
      record: 'interlock=BYPASSED reason=hotfix pattern=dist/scripts/backfill-directional-labels' },
    { label: 'in flight', cmd: 'preempt', opts: { dockerRc: 0 }, token: 'DEFERRED',
      record: 'interlock=DEFERRED outcome=wait-expired waited_s=2 budget_s=2' },
    { label: 'not in flight', cmd: 'preempt', opts: { dockerRc: 1 }, token: 'PROCEED',
      record: 'interlock=PROCEED reason=no-labeler-in-flight' },
    { label: 'probe failed', cmd: 'preempt', opts: { dockerRc: 7 }, token: 'INDETERMINATE',
      record: 'interlock=INDETERMINATE reason=probe-failed docker_exec_rc=7' },
    { label: 'catch-up with no marker', cmd: 'catchup', opts: { dockerRc: 0 }, token: 'PROCEED',
      record: 'interlock=PROCEED catchup=skipped reason=no-preemption-this-deploy' },
  ];

  it.each(GOLDEN)('$label reproduces the pre-rename record and token', { timeout: 60_000 }, (g) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'interlock-ac7-'));
    const reg = oneRowRegistry(dir, LABELER_ROW);
    const r = run(g.cmd, { ...g.opts, env: { ...(g.opts?.env ?? {}), INTERLOCK_REGISTRY: reg } });
    expect(r.verdict).toBe(g.token);
    // Strip the ISO timestamp and the one declared new field; everything else must match exactly.
    const rows = r.ledger.trim().split('\n')
      .map((l) => l.replace(/^\S+Z /, '').replace(/ ?\bjob=\S+ ?/, ' ').replace(/^ | $/g, ''));
    expect(rows).toContain(g.record);
  });
});

/**
 * OPS-DEPLOY-INTERLOCK-CRON-DEFER-W1 — the registry IS the protected set.
 *
 * SPAWN BUDGET: 6 bash spawns.
 */
describe('the protected set is DATA, and an unusable row is never a silent pass', () => {
  it('a safe-to-kill row is not probed, and still prints a positive per-job line', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'interlock-reg-'));
    const reg = oneRowRegistry(dir, {
      id: 'seed-signals', script: 'src/scripts/seed-signals.ts', container: 'ctr',
      process_pattern: 'dist/scripts/seed-signals', class: 'safe-to-kill',
      reason: 'idempotent on next fire, flock-guarded',
    });
    // dockerRc 0 would DEFER if the row were probed at all — so PROCEED is the assertion.
    const r = run('preempt', { dockerRc: 0, env: { INTERLOCK_REGISTRY: reg } });
    expect(r.verdict).toBe('PROCEED');
    expect(r.jobLines).toContain('INTERLOCK_JOB=seed-signals class=safe-to-kill outcome=none classified safe to kill; the deploy does not probe or wait');
  });

  it('a no-safe-kill row NEVER sends a SIGTERM — the kill is the harm', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'interlock-nsk-'));
    const argv = path.join(dir, 'argv');
    const docker = path.join(dir, 'docker');
    writeFileSync(docker, `#!/bin/sh\necho "$@" >> ${argv}\nexit 0\n`, { mode: 0o755 });
    const reg = oneRowRegistry(dir, {
      id: 'publish-merkle-batch', script: 'src/scripts/publish-merkle-batch.ts', container: 'ctr',
      process_pattern: 'dist/scripts/publish-merkle-batch', class: 'no-safe-kill',
      reason: 'on-chain tx then DB write; a kill between them orphans a Merkle root',
    });
    const r = spawnSync('bash', [SH, 'preempt'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        INTERLOCK_LEDGER: path.join(dir, 'led'), INTERLOCK_MARKER: path.join(dir, 'mk'),
        INTERLOCK_DOCKER: docker, INTERLOCK_WAIT_S: '2', INTERLOCK_REGISTRY: reg,
      },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('INTERLOCK_VERDICT=DEFERRED');
    // The whole point of the class: the deploy waits, then proceeds — it never signals.
    expect(readFileSync(argv, 'utf8')).not.toContain('-TERM');
    expect(readFileSync(path.join(dir, 'led'), 'utf8')).toContain('outcome=no-safe-kill-wait-expired');
  });

  it('an EMPTY reason is INDETERMINATE, never a silent safe-to-kill', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'interlock-noreason-'));
    const reg = oneRowRegistry(dir, {
      id: 'unreasoned', script: 'x', container: 'ctr', process_pattern: 'p',
      class: 'safe-to-kill', reason: '   ',
    });
    const r = run('preempt', { dockerRc: 1, env: { INTERLOCK_REGISTRY: reg } });
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.ledger).toContain('job=unreasoned reason=unclassifiable-row');
  });

  it('an unloadable registry is INDETERMINATE at EXIT 0 — fail open, never closed', { timeout: 60_000 }, () => {
    const r = run('preempt', { dockerRc: 1, env: { INTERLOCK_REGISTRY: '/nonexistent/registry.json' } });
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.status).toBe(0);
    expect(r.ledger).toContain('reason=registry-unloadable');
  });

  it('the aggregate precedence is BYPASSED > INDETERMINATE > DEFERRED > PROCEED', { timeout: 60_000 }, () => {
    // The real registry carries all three classes, so one docker stub exercises the whole ladder.
    expect(run('preempt', { dockerRc: 1 }).verdict).toBe('PROCEED');        // every row clean
    expect(run('preempt', { dockerRc: 0 }).verdict).toBe('DEFERRED');       // >=1 deferred
    expect(run('preempt', { dockerRc: 7 }).verdict).toBe('INDETERMINATE');  // >=1 indeterminate
    expect(run('preempt', { dockerRc: 7, hotfix: true }).verdict).toBe('BYPASSED');
  });

  it('exactly ONE terminal INTERLOCK_VERDICT line is printed, however many rows ran', { timeout: 60_000 }, () => {
    const r = run('preempt', { dockerRc: 7 });
    expect((r.stdout.match(/^INTERLOCK_VERDICT=/gm) || []).length).toBe(1);
    // …and every row still spoke for itself.
    expect(r.jobLines.length).toBeGreaterThanOrEqual(3);
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
  it('returns immediately even though the child runs far past the SSH timeout', { timeout: 60_000 }, () => {
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
    const reg = oneRowRegistry(dir, LABELER_ROW);
    const t0 = Date.now();
    const r = spawnSync('bash', [SH, 'catchup'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        INTERLOCK_LEDGER: ledger,
        INTERLOCK_MARKER: marker,
        INTERLOCK_DOCKER: docker,
        INTERLOCK_REGISTRY: reg,
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

  it('the runner records a TERMINAL outcome, so "launched" is always answered', { timeout: 60_000 }, () => {
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
  it.each([0, 1, 7, 125])('proceeds with docker rc=%i', { timeout: 60_000 }, (rc) => {
    // The hatch must be TOTAL. A hatch that fails when it is most needed gets replaced by
    // someone doing the thing manually, which writes no record at all.
    const r = run('preempt', { dockerRc: rc, hotfix: true });
    expect(r.verdict).toBe('BYPASSED');
    expect(r.status).toBe(0);
  });

  it('the hatch does not even LOAD the registry', { timeout: 60_000 }, () => {
    const r = run('preempt', { dockerRc: 0, hotfix: true, env: { INTERLOCK_REGISTRY: '/nonexistent.json' } });
    expect(r.verdict).toBe('BYPASSED');
    expect(r.ledger).not.toContain('registry-unloadable');
  });

  it('a hotfix also skips the catch-up, and says so', { timeout: 60_000 }, () => {
    const r = run('catchup', { dockerRc: 0, hotfix: true, env: { PRESEED_MARKER: '1' } });
    expect(r.verdict).toBe('BYPASSED');
    expect(r.ledger).toContain('catchup=skipped');
  });
});

describe('AC2.5 — probe failure fails OPEN, never closed', () => {
  it.each([2, 7, 125, 126, 127])('rc=%i yields INDETERMINATE and exit 0', { timeout: 60_000 }, (rc) => {
    const r = run('preempt', { dockerRc: rc });
    expect(r.verdict).toBe('INDETERMINATE');
    // Exit 0 is the fail-OPEN half: a deploy must never be blocked by this script's own bugs.
    expect(r.status).toBe(0);
  });

  it('an unreachable probe is NEVER reported as clean FOR THE PROBED ROW', { timeout: 60_000 }, () => {
    const r = run('preempt', { dockerRc: 7 });
    // Scoped to the probed rows on purpose. Since the registry landed, a run also emits ONE
    // `interlock=PROCEED job=* class=safe-to-kill` summary for the rows that are not probed at
    // all — that row is a true statement about a different set, and a blanket
    // `not.toContain('interlock=PROCEED')` would now be asserting the wrong thing.
    expect(r.ledger).not.toContain('job=carry-labeler reason=no-labeler-in-flight');
    expect(r.ledger).toContain('job=carry-labeler reason=probe-failed');
    expect(r.verdict).not.toBe('PROCEED');
  });
});

describe('AC2.6 — the bounded wait expires rather than hanging', () => {
  it('returns within its budget when the labeler never exits', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'interlock-wait-'));
    const reg = oneRowRegistry(dir, LABELER_ROW);
    const t0 = Date.now();
    const r = run('preempt', { dockerRc: 0, env: { INTERLOCK_REGISTRY: reg } });   // pkill -0 always succeeds
    const elapsed = (Date.now() - t0) / 1000;
    expect(r.verdict).toBe('DEFERRED');
    expect(elapsed).toBeLessThan(20);
    expect(r.ledger).toContain('wait-expired');
  });

  it('the SHIPPED wait is the DERIVED value, not the old 30s', { timeout: 60_000 }, () => {
    // 57.194s max in-flight batch sleep (n=400) + 38.32s worst per-group (n=466) = 95.5s, +25%.
    // A single in-flight sleep used to outlast the entire 30s budget.
    const w = spawnSync('bash', [SH, '--print-wait'], { encoding: 'utf8' }).stdout.trim();
    expect(Number(w)).toBe(120);
    expect(Number(w)).toBeGreaterThan(57.194 + 38.32);
  });
});

describe('CH2 — the SLO gate decides whether a catch-up is owed at all', () => {
  it('SKIPS when the worst projected lag is inside SLO', { timeout: 60_000 }, () => {
    const r = run('catchup', { dockerRc: 0, env: { PRESEED_MARKER: '1', INTERLOCK_WORST_OVERRIDE: '80' } });
    expect(r.verdict).toBe('PROCEED');
    expect(r.ledger).toContain('reason=within-slo');
    expect(r.markerExists).toBe(false);
  });

  it('SKIPS when the original run has no budget left', { timeout: 60_000 }, () => {
    const r = run('catchup', {
      dockerRc: 0,
      env: { PRESEED_MARKER: '1', INTERLOCK_WORST_OVERRIDE: '140', INTERLOCK_REMAINING_OVERRIDE: '0' },
    });
    expect(r.verdict).toBe('PROCEED');
    expect(r.ledger).toContain('no-budget-remaining');
  });

  it('does nothing when no preemption happened this deploy', { timeout: 60_000 }, () => {
    const r = run('catchup', { dockerRc: 0 });
    expect(r.verdict).toBe('PROCEED');
    expect(r.ledger).toContain('no-preemption-this-deploy');
  });

  it('an UNEVALUABLE SLO gate is INDETERMINATE — never a silent catch-up, never a silent skip',
    { timeout: 60_000 }, () => {
      const r = run('catchup', { dockerRc: 0, env: { PRESEED_MARKER: '1', INTERLOCK_TIERS: '/nonexistent' } });
      expect(r.verdict).toBe('INDETERMINATE');
      expect(r.ledger).toContain('slo-gate-unevaluable');
    });
});

describe('Q6 — the pattern is pinned to the REAL script, and the workflow really calls it', () => {
  it('the interlock pattern matches a script that exists on disk', { timeout: 60_000 }, () => {
    // A rename of the labeler would otherwise silently stop matching, with nothing red — the
    // registry's real generator value, kept at 1% of its cost.
    const pattern = spawnSync('bash', [SH, '--print-pattern'], { encoding: 'utf8' }).stdout.trim();
    const rel = spawnSync('bash', [SH, '--print-script'], { encoding: 'utf8' }).stdout.trim();
    expect(existsSync(path.join(REPO, rel))).toBe(true);
    expect(rel).toContain(path.basename(pattern));
  });

  it('AC2.7 — the same pattern also matches the docker-exec RECOVERY invocation', { timeout: 60_000 }, () => {
    // The recovery lane runs `node dist/scripts/backfill-directional-labels.js --venue X`, so one
    // pattern covers both the nightly and the recovery. That is why the exit=137 class is in scope.
    const pattern = spawnSync('bash', [SH, '--print-pattern'], { encoding: 'utf8' }).stdout.trim();
    const recovery = 'node dist/scripts/backfill-directional-labels.js --venue BYBIT --lookback-days 21';
    expect(recovery).toContain(pattern);
  });

  it('the registry AGREES with the pattern this script hardcodes', { timeout: 60_000 }, () => {
    // Two declarations of one identity. If they drift, the registry silently stops protecting the
    // one job that was already protected — and nothing else in the tree would notice.
    const pattern = spawnSync('bash', [SH, '--print-pattern'], { encoding: 'utf8' }).stdout.trim();
    const rows = JSON.parse(readFileSync(REGISTRY, 'utf8')).rows as Array<Record<string, string>>;
    const labeler = rows.find((r) => r.id === 'carry-labeler');
    expect(labeler).toBeDefined();
    expect(labeler!.process_pattern).toBe(pattern);
    expect(labeler!.class).toBe('preempt-and-catchup');
  });

  it('--print-registry resolves beside this script, so the deploy checkout is self-contained',
    { timeout: 60_000 }, () => {
      const p = spawnSync('bash', [SH, '--print-registry'], { encoding: 'utf8' }).stdout.trim();
      expect(p).toBe(REGISTRY);
      expect(existsSync(p)).toBe(true);
    });

  it('deploy.yml actually invokes BOTH subcommands — a script nothing calls is dead', { timeout: 60_000 }, () => {
    const wf = readFileSync(WORKFLOW, 'utf8');
    expect(wf).toContain('deploy-cron-interlock.sh preempt');
    expect(wf).toContain('deploy-cron-interlock.sh catchup');
    // The OLD name must be gone from the workflow, or the deploy would call a path that the
    // rename deleted — the bootstrap gap this wave had to prove does not exist.
    expect(wf).not.toContain('deploy-labeler-interlock');
    // The old inline literal must be GONE, or two interlocks would race.
    expect(wf).not.toContain("pkill -TERM -f 'dist/scripts/backfill-directional-labels'");
  });

  it('the script self-test passes and emits its own verdict token', { timeout: 120_000 }, () => {
    const r = spawnSync('bash', [SH, '--self-test'], { encoding: 'utf8' });
    expect(r.stdout).toContain('SELF-TEST: PASS');
    expect(r.stdout).toContain('SELF_TEST_VERDICT=PASS');
    expect(r.status).toBe(0);
    // AC3's floor: never fewer checks than the 33 this file carried before the generalization.
    const n = Number((r.stdout.match(/SELF-TEST: PASS — (\d+) checks/) || [])[1]);
    expect(n).toBeGreaterThanOrEqual(33);
  });
});

describe('AC2.9 — zero firewall or inbound network mutations', () => {
  it('the interlock never touches a network rule', { timeout: 60_000 }, () => {
    const src = readFileSync(SH, 'utf8');
    for (const bad of ['iptables', 'ufw ', 'firewall-cmd', 'nft ']) expect(src).not.toContain(bad);
  });
});
