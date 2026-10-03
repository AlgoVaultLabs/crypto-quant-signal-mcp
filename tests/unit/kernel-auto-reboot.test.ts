/**
 * OPS-HOST-AUTO-REBOOT-W1 → OPS-HOST-AUTO-REBOOT-SIGNAL1-PROMOTE-W1 — the unattended kernel reboot,
 * now on BOTH hosts, and the allow-list firewall that bounds it.
 *
 * Each script's own `--self-test` covers its decision function against fixtures. THIS file covers
 * what a hermetic self-test structurally cannot: the real CLI contract (token AND exit code), the
 * real committed registry, cross-FILE parity (the arm paths three scripts must agree on), and the
 * wiring that makes any of it run.
 *
 * BUILD RULE 12 of Prompt/OPS-HOST-AUTO-REBOOT-SIGNAL1-PROMOTE-W1.md: this file used to pin "a
 * signal-1 label REFUSES" as the single most important assertion of W1. That invariant was RATIFIED
 * as temporary — "TWO clean unattended aoe-1 cycles AND a live peer watchdog" — and the same
 * ratification, now fired (PROMOTION_CLOCK=2/2, OPS-HOST-KERNEL-REBOOT-W5), retires it. The
 * invariant it is replaced by is the one that was always load-bearing: the hosts this script may
 * reboot are a HARDCODED constant, an UNLISTED host refuses with zero side effects, and no env can
 * widen the list. This is not a weakened gate; do not route around it anywhere else.
 *
 * SPAWN BUDGET DECLARED on every block — each shells out to bash.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  const results = path.join(dir, 'results.jsonl');
  mkdirSync(path.join(dir, 'rl'));
  mkdirSync(path.join(dir, 'peer'));
  writeFileSync(path.join(dir, 'rl', 'canary_result_log.py'),
    'import json, os\ndef append_result(c, v, e, m=None, **k):\n'
    + '    open(os.environ["CANARY_RESULT_LOG_PATH"], "a").write(json.dumps({"host": os.environ.get("MONITORING_HOST_LABEL"), "canary": c, "verdict": v, "metrics": m}) + "\\n")\n'
    + '    return True, "line=1"\n');
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
    AUTO_REBOOT_ARM_CMD: mk('arm.sh', `#!/bin/sh\necho "$@" >> ${armed}\necho PEER_ARM_VERDICT=ARMED\n`),
    AUTO_REBOOT_PS: mk('ps.sh', '#!/bin/sh\nprintf "%s\\n" "/sbin/init" "node dist/index.js"\n'),
    AUTO_REBOOT_CURL: mk('curl.sh', '#!/bin/sh\necho 200\n'),
    AUTO_REBOOT_PEER_ARM_MARKER: path.join(dir, 'peer', 'marker'),
    AUTO_REBOOT_POPULATION_GATE: mk('pop.sh', '#!/bin/sh\necho "CRON_INTERLOCK_COVERAGE_VERDICT=PASS"\n'),
    AUTO_REBOOT_NODE: 'bash',
    AUTO_REBOOT_CRONTAB: mk('crontab.sh', '#!/bin/sh\necho "17 3 * * * /opt/x.sh"\n'),
    AUTO_REBOOT_SYSTEMCTL: mk('systemctl.sh', '#!/bin/sh\necho cron.service\n'),
    AUTO_REBOOT_NOW_HOUR: '05',
    AUTO_REBOOT_RESULT_LOG_DIR: path.join(dir, 'rl'),
    CANARY_RESULT_LOG_PATH: results,
  };
  const r = spawnSync('bash', [HARNESS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MONITORING_HOST_LABELS: '', ...stubs, ...env },
  });
  return {
    dir,
    status: r.status,
    stdout: r.stdout,
    verdict: (r.stdout.match(/AUTO_REBOOT_VERDICT=(\w+)/) || [])[1],
    gates: r.stdout.match(/^AUTO_REBOOT_GATE=\S+ state=\S+/gm) || [],
    rebooted: existsSync(rebooted),
    armed: existsSync(armed) ? readFileSync(armed, 'utf8') : '',
    paged: existsSync(paged) ? readFileSync(paged, 'utf8') : '',
    results: existsSync(results) ? readFileSync(results, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [],
  };
}

/**
 * AC2 (rewritten per Build Rule 12) — the ALLOW-LIST is the firewall.
 *
 * SPAWN BUDGET: 7 bash spawns.
 */
describe('AC2 — the allow-list firewall: an UNLISTED host refuses, with zero side effects', () => {
  it('an unlisted label REFUSES even with --apply and every other gate green', { timeout: 60_000 }, () => {
    const r = harness(['--apply'], { MONITORING_HOST_LABELS: 'mars-1' });
    expect(r.verdict).toBe('REFUSED');
    expect(r.rebooted).toBe(false);
    expect(r.armed).toBe('');
    expect(r.status).toBe(0);
  });

  it('…and it evaluates NO later gate: every one is reported NOT_REACHED', { timeout: 60_000 }, () => {
    const r = harness(['--apply'], { MONITORING_HOST_LABELS: 'mars-1' });
    expect(r.gates[0]).toBe('AUTO_REBOOT_GATE=identity state=REFUSED');
    expect(r.gates.slice(1).every((g) => g.endsWith('state=NOT_REACHED'))).toBe(true);
    expect(r.gates.length).toBe(11);
  });

  it('an unlisted IDENTITY FILE refuses too — the env is not the only door', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'autoreboot-id-'));
    const idFile = path.join(dir, 'id');
    writeFileSync(idFile, 'mars-1\n');
    const r = harness(['--apply'], { AUTO_REBOOT_IDENTITY_FILE: idFile });
    expect(r.verdict).toBe('REFUSED');
    expect(r.rebooted).toBe(false);
  });

  it('an UNRESOLVABLE identity refuses — there is no default', { timeout: 60_000 }, () => {
    const r = harness(['--apply'], { AUTO_REBOOT_IDENTITY_FILE: '/nonexistent' });
    expect(r.verdict).toBe('REFUSED');
    expect(r.rebooted).toBe(false);
  });

  it('a refusal PAGES rather than failing quietly', { timeout: 60_000 }, () => {
    const r = harness(['--apply'], { MONITORING_HOST_LABELS: 'mars-1' });
    expect(r.paged).toContain('ALERT=KERNEL_AUTO_REBOOT SEV=CRITICAL_PERSISTENT');
    expect(r.paged).toContain('the reboot was NOT performed');
  });

  it('the allow-list is a HARDCODED constant — no env can widen it', { timeout: 60_000 }, () => {
    const r = spawnSync('bash', [HARNESS, '--print-allowed-hosts'], {
      encoding: 'utf8',
      env: { ...process.env, ALLOWED_HOSTS: 'mars-1', AUTO_REBOOT_ALLOWED_HOSTS: 'mars-1', EXPECTED_HOST: 'mars-1' },
    });
    expect(r.stdout.trim()).toBe('aoe-1 signal-1');
    const src = readFileSync(HARNESS, 'utf8');
    expect(src).toContain('ALLOWED_HOSTS="aoe-1 signal-1"');
    // The policy table's host labels ARE the allow-list: exactly two, both named.
    const labels = new Set([...src.matchAll(/^\s{4}(\S+?):peer\)/gm)].map((m) => m[1]));
    expect([...labels].sort()).toEqual(['aoe-1', 'signal-1']);
    expect(src).not.toMatch(/ALLOWED_HOSTS="\$\{/);
  });

  it('signal-1 is now ON the list: it reaches the gates and decides', { timeout: 60_000 }, () => {
    const r = harness(['--dry-run'], { MONITORING_HOST_LABELS: 'signal-1' });
    expect(r.verdict).toBe('NOT_DUE');
    expect(r.stdout).toContain('AUTO_REBOOT_GATE=action state=DRY_RUN');
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
    const r = harness([]);
    expect(r.rebooted).toBe(false);
    expect(r.stdout).toContain('AUTO_REBOOT_GATE=action state=DRY_RUN');
  });

  it('every gate green + --apply DOES reboot, and arms the watchdog FIRST', { timeout: 60_000 }, () => {
    const r = harness(['--apply']);
    expect(r.verdict).toBe('REBOOTED');
    expect(r.rebooted).toBe(true);
    expect(r.armed).toContain('--arm');
  });
});

/**
 * The aoe-1 DIFFERENTIAL: every aoe-1 fixture W1 pinned yields the SAME verdict line now.
 *
 * SPAWN BUDGET: 6 bash spawns.
 */
describe('aoe-1 is unchanged — W1 fixtures, byte-identical verdict lines', () => {
  const W1 = [
    { label: 'dry-run, all green', args: ['--dry-run'], env: {}, verdict: 'AUTO_REBOOT_VERDICT=NOT_DUE' },
    { label: '--apply, all green', args: ['--apply'], env: {}, verdict: 'AUTO_REBOOT_VERDICT=REBOOTED' },
    { label: 'staleness verdict unreadable', args: ['--apply'], env: { AUTO_REBOOT_STALENESS: '/bin/echo' }, verdict: 'AUTO_REBOOT_VERDICT=INDETERMINATE' },
    { label: 'unreadable registry', args: ['--apply'], env: { AUTO_REBOOT_REGISTRY: '/nonexistent' }, verdict: 'AUTO_REBOOT_VERDICT=INDETERMINATE' },
    { label: 'aoe-1 is any-hour (20Z)', args: ['--apply'], env: { AUTO_REBOOT_NOW_HOUR: '20' }, verdict: 'AUTO_REBOOT_VERDICT=REBOOTED' },
  ];
  it.each(W1)('$label → $verdict', { timeout: 60_000 }, ({ args, env, verdict }) => {
    const r = harness(args, env as Record<string, string>);
    expect((r.stdout.match(/^AUTO_REBOOT_VERDICT=.*$/m) || [])[0]).toBe(verdict);
  });

  it('a failed arm on aoe-1 is DEGRADED and still reboots (now SEEN — the token is read)', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'autoreboot-armfail-'));
    const armFail = path.join(dir, 'arm.sh');
    writeFileSync(armFail, '#!/bin/sh\necho PEER_ARM_VERDICT=FAILED\n', { mode: 0o755 });
    const r = harness(['--apply'], { AUTO_REBOOT_ARM_CMD: armFail });
    expect(r.verdict).toBe('REBOOTED');
    expect(r.stdout).toContain('AUTO_REBOOT_GATE=arm state=DEGRADED');
  });
});

/**
 * signal-1's stricter per-host policy (PR-1 window, PR-3 arm failure).
 *
 * SPAWN BUDGET: 7 bash spawns.
 */
describe('signal-1 policy — window, arm failure, peer busy, deploy in flight', () => {
  const S = { MONITORING_HOST_LABELS: 'signal-1' };
  it.each([['02', 'NOT_DUE'], ['03', 'REBOOTED'], ['13', 'REBOOTED'], ['14', 'NOT_DUE']])(
    'WINDOW 03:00-13:59Z — hour %s → %s', { timeout: 60_000 }, (hour, want) => {
      const r = harness(['--apply'], { ...S, AUTO_REBOOT_NOW_HOUR: hour });
      expect(r.verdict).toBe(want);
    });

  it('an arm FAILURE defers and never reboots the revenue host unwatched', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'autoreboot-armfail-'));
    const armFail = path.join(dir, 'arm.sh');
    writeFileSync(armFail, '#!/bin/sh\necho PEER_ARM_VERDICT=FAILED\n', { mode: 0o755 });
    const r = harness(['--apply'], { ...S, AUTO_REBOOT_ARM_CMD: armFail });
    expect(r.verdict).toBe('DEFERRED');
    expect(r.rebooted).toBe(false);
    expect(r.paged).toBe('');
  });

  // The REAL registry's REBOOT patterns against the argv shapes observed live on signal-1
  // (R0.4 agents, 2026-10-02) — through the harness's own bracketed-ERE matcher, not a re-derivation.
  it.each([
    ['/bin/sh -c /opt/algovault-bot/scripts/entitlement-drain.sh >> /var/log/algovault-bot/entitlement-drain.log 2>&1', 'ABORTED'],
    ['/opt/algovault-bot/.venv/bin/python -m algovault_bot.alert_engine', 'ABORTED'],
    ['/opt/mcp-intelligence/.venv/bin/python -m components.launch_triggers', 'ABORTED'],
    ['/usr/bin/python3 /usr/lib/apt/apt.systemd.daily install', 'ABORTED'],
    ['/bin/sh -c /opt/crypto-quant-signal-mcp/ops/cron/snapshot-landing-daily.sh', 'ABORTED'],
    ['python -m src.research.carry.retrain', 'DEFERRED'],
    ['/usr/bin/python3 -m algovault_bot.digest', 'DEFERRED'],
    ['python -m src.research.carry.hourly_scorer', 'REBOOTED'],
    ['/usr/bin/python3 /usr/bin/unattended-upgrade-shutdown --wait-for-signal', 'REBOOTED'],
  ])('REAL registry: in flight %s → %s', { timeout: 60_000 }, (argv, want) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'autoreboot-real-'));
    const ps = path.join(dir, 'ps.sh');
    writeFileSync(ps, `#!/bin/sh\nprintf '%s\\n' /sbin/init '${argv}'\n`, { mode: 0o755 });
    const r = harness(['--apply'], { ...S, AUTO_REBOOT_PS: ps });
    expect(r.verdict).toBe(want);
    expect(r.rebooted).toBe(want === 'REBOOTED');
  });

  it('RECHECK: a job that starts between the probe and the reboot aborts it and withdraws the arm', { timeout: 60_000 }, () => {
    // The bot alert engine fires every minute at :10s; the arm is a network round-trip in between.
    const dir = mkdtempSync(path.join(tmpdir(), 'autoreboot-late-'));
    const n = path.join(dir, 'n');
    const ps = path.join(dir, 'ps.sh');
    writeFileSync(ps, `#!/bin/sh\nc=$(cat ${n} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${n}\n`
      + `if [ $c -ge 2 ]; then printf '%s\\n' /sbin/init '/opt/algovault-bot/.venv/bin/python -m algovault_bot.alert_engine'; else printf '%s\\n' /sbin/init; fi\n`, { mode: 0o755 });
    const r = harness(['--apply'], { ...S, AUTO_REBOOT_PS: ps });
    expect(r.verdict).toBe('ABORTED');
    expect(r.stdout).toMatch(/AUTO_REBOOT_GATE=in_flight state=PASS/);
    expect(r.stdout).toMatch(/AUTO_REBOOT_GATE=recheck state=ABORT .*bot-alert-engine/);
    expect(r.armed).toMatch(/^--arm\n--disarm/);
    expect(r.rebooted).toBe(false);
    expect(existsSync(path.join(r.dir, 'state'))).toBe(false);
  });

  it('a peer arm present locally (aoe-1 mid-cycle) defers, with no arm call', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'autoreboot-peer-'));
    const marker = path.join(dir, 'marker');
    writeFileSync(marker, '1790000000 6.8.0-139-generic\n');
    const r = harness(['--apply'], { ...S, AUTO_REBOOT_PEER_ARM_MARKER: marker });
    expect(r.verdict).toBe('DEFERRED');
    expect(r.armed).toBe('');
    expect(r.rebooted).toBe(false);
  });

  it('a live cqsm deploy defers', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'autoreboot-deploy-'));
    const ps = path.join(dir, 'ps.sh');
    writeFileSync(ps, '#!/bin/sh\necho "bash -c cd /opt/crypto-quant-signal-mcp && docker compose up -d --build --force-recreate"\n', { mode: 0o755 });
    const r = harness(['--apply'], { ...S, AUTO_REBOOT_PS: ps });
    expect(r.verdict).toBe('DEFERRED');
    expect(r.stdout).toContain('AUTO_REBOOT_GATE=deploy_in_flight state=DEFERRED');
  });
});

/**
 * The off-host record: ONE per run, carrying the RESOLVED host.
 *
 * SPAWN BUDGET: 2 bash spawns.
 */
describe('every run appends ONE canary_result_log record', () => {
  it('a REFUSED run and a REBOOTED run each record once, under their own host', { timeout: 60_000 }, () => {
    const refused = harness(['--apply'], { MONITORING_HOST_LABELS: 'mars-1' });
    expect(refused.results.length).toBe(1);
    expect(refused.results[0].verdict).toBe('REFUSED');
    const ok = harness(['--apply']);
    expect(ok.results.length).toBe(1);
    expect(ok.results[0]).toMatchObject({ host: 'aoe-1', canary: 'kernel-auto-reboot', verdict: 'REBOOTED' });
    expect(ok.results[0].metrics.decided_by).toBe('action');
  });
});

/**
 * The scripts' own self-tests, run as the wired suite runs them.
 *
 * SPAWN BUDGET: 3 bash spawns.
 */
describe('every artifact self-tests, with a vacuity floor', () => {
  it.each([
    { name: 'kernel-auto-reboot.sh', script: HARNESS, floor: 112 },
    { name: 'aoe-peer-watchdog.sh', script: WATCHDOG, floor: 120 },
    { name: 'arm-peer-watchdog.sh', script: ARM, floor: 21 },
  ])('$name --self-test PASSes with at least $floor assertions', { timeout: 180_000 }, ({ script, floor }) => {
    const r = spawnSync('bash', [script, '--self-test'], { encoding: 'utf8' });
    expect(r.stdout).toContain('SELF_TEST_VERDICT=PASS');
    expect(r.status).toBe(0);
    const n = Number((r.stdout.match(/SELF-TEST: PASS — (\d+) checks/) || [])[1]);
    expect(n).toBeGreaterThanOrEqual(floor);
  });
});

/**
 * Cross-FILE parity — mutual exclusion depends on three scripts naming the SAME arm path per
 * direction. Two copies of a firewall disagree; this pins them to one.
 *
 * SPAWN BUDGET: 0 spawns (pure reads).
 */
describe('the arm paths agree across harness, arm helper and watchdog', () => {
  const pick = (file: string, re: RegExp) => {
    const m = readFileSync(file, 'utf8').match(re);
    expect(m, `${path.basename(file)} ${re}`).toBeTruthy();
    return (m as RegExpMatchArray)[1];
  };
  it('aoe-1 reboots -> its arm lands where signal-1 reads it', () => {
    const armWrites = pick(ARM, /^\s+aoe-1:remote\)\s+echo (\S+) ;;/m);
    const watchdogReads = pick(WATCHDOG, /^\s+signal-1:arm\)\s+echo (\S+) ;;/m);
    const harnessReads = pick(HARNESS, /^\s+signal-1:peer_arm_marker\)\s+echo (\S+) ;;/m);
    expect(new Set([armWrites, watchdogReads, harnessReads]).size).toBe(1);
  });
  it('signal-1 reboots -> its arm lands where aoe-1 reads it', () => {
    const armWrites = pick(ARM, /^\s+signal-1:remote\)\s+echo (\S+) ;;/m);
    const watchdogReads = pick(WATCHDOG, /^\s+aoe-1:arm\)\s+echo (\S+) ;;/m);
    const harnessReads = pick(HARNESS, /^\s+aoe-1:peer_arm_marker\)\s+echo (\S+) ;;/m);
    expect(new Set([armWrites, watchdogReads, harnessReads]).size).toBe(1);
  });
  it('the two directions use DIFFERENT markers (otherwise each host would block itself)', () => {
    expect(pick(ARM, /^\s+aoe-1:remote\)\s+echo (\S+) ;;/m)).not.toBe(pick(ARM, /^\s+signal-1:remote\)\s+echo (\S+) ;;/m));
  });
});

/**
 * AC8 — the peer watchdog, both directions.
 *
 * `opts.curl: 'url'` swaps in a stub that answers per URL — the edge control from ST_CONTROL, the
 * target's /health from ST_HEALTH — because the unarmed half needs two DIFFERENT vantages. The
 * unarmed counter, episode marker and wrapper-marker dir default into the per-call sandbox: a test
 * must never reach /var/lib or /opt on whatever box runs it. `send.sh` models the wrapper's argv:
 * `--clear <id> <reason>` lands in `clears`, a fire reads its body into `paged`.
 */
type WatchdogOpts = { curl?: 'down' | 'url'; tcp?: 'down' | 'up' };
function watchdog(env: Record<string, string>, opts: WatchdogOpts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'watchdog-'));
  const paged = path.join(dir, 'paged');
  const clears = path.join(dir, 'clears');
  const sshArgv = path.join(dir, 'ssh-argv');
  const send = path.join(dir, 'send.sh');
  const down = path.join(dir, 'ssh-down.sh');
  const tcpDown = path.join(dir, 'tcp-down.sh');
  const tcpUp = path.join(dir, 'tcp-up.sh');
  const curlUrl = path.join(dir, 'curl-url.sh');
  writeFileSync(send, `#!/bin/sh\ncase "$1" in --clear\x29 echo "$1 $2|$3" >> ${clears} ;; *\x29 cat >> ${paged}; echo "ALERT=$1" >> ${paged} ;; esac\n`, { mode: 0o755 });
  writeFileSync(down, `#!/bin/sh\necho "$@" >> ${sshArgv}\nexit 255\n`, { mode: 0o755 });
  writeFileSync(tcpDown, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(tcpUp, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(curlUrl, '#!/bin/sh\ncase "$*" in *cdn-cgi/trace*\x29 echo "${ST_CONTROL:-200}" ;; *\x29 echo "${ST_HEALTH:-200}" ;; esac\n', { mode: 0o755 });
  const r = spawnSync('bash', [WATCHDOG], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MONITORING_HOST_LABELS: 'signal-1',
      PEER_WATCHDOG_LOG: path.join(dir, 'log'),
      PEER_WATCHDOG_ARM: path.join(dir, 'arm'),
      PEER_WATCHDOG_STATE: path.join(dir, 'breaches'),
      PEER_WATCHDOG_UNARMED_STATE: path.join(dir, 'ua'),
      PEER_WATCHDOG_UNARMED_EPISODE: path.join(dir, 'ep'),
      PEER_WATCHDOG_ALERT_STATE_DIR: path.join(dir, 'alert-state'),
      PEER_WATCHDOG_WRAPPER: send,
      PEER_WATCHDOG_SSH: down,
      PEER_WATCHDOG_TCP: opts.tcp === 'up' ? tcpUp : tcpDown,
      PEER_WATCHDOG_CURL: opts.curl === 'url' ? curlUrl : tcpDown,
      ...env,
    },
  });
  return {
    status: r.status,
    stdout: r.stdout,
    verdict: (r.stdout.match(/PEER_WATCHDOG_VERDICT=(\w+)/) || [])[1],
    tokens: (r.stdout.match(/^PEER_WATCHDOG_VERDICT=/gm) || []).length,
    paged: existsSync(paged) ? readFileSync(paged, 'utf8') : '',
    clears: existsSync(clears) ? readFileSync(clears, 'utf8') : '',
    sshCalled: existsSync(sshArgv),
  };
}

/** SPAWN BUDGET: 5 bash spawns. */
describe('AC8 — the peer watchdog', () => {
  it('with NO arm and a blind watcher it is WATCHER_BLIND and silent, even while the target is unreachable', { timeout: 60_000 }, () => {
    const r = watchdog({});
    expect(r.verdict).toBe('WATCHER_BLIND');
    expect(r.status).toBe(0);
    expect(r.paged).toBe('');
    expect(r.stdout).toContain('PEER_WATCHDOG_CHECK=arm state=UNARMED');
    expect(r.stdout).toContain('PEER_WATCHDOG_CHECK=control state=WATCHER_BLIND');
  });

  it('an armed, past-budget, unreachable aoe-1 BREACHES on the second consecutive probe', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'watchdog-arm-'));
    const arm = path.join(dir, 'arm');
    const state = path.join(dir, 'breaches');
    writeFileSync(arm, '1000000 old-kernel\n');
    const env = { PEER_WATCHDOG_ARM: arm, PEER_WATCHDOG_STATE: state, PEER_WATCHDOG_NOW: '1000200' };
    expect(watchdog(env).verdict).toBe('ARMED_WAITING');
    const second = watchdog(env);
    expect(second.verdict).toBe('BREACH');
    expect(second.paged).toContain('ALERT=AOE_PEER_UNREACHABLE');
  });

  it('on aoe-1 it watches signal-1 credential-free and pages its OWN alert id', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'watchdog-s1-'));
    const arm = path.join(dir, 'arm');
    const state = path.join(dir, 'breaches');
    writeFileSync(arm, '1000000 old-kernel\n');
    const env = { MONITORING_HOST_LABELS: 'aoe-1', PEER_WATCHDOG_ARM: arm, PEER_WATCHDOG_STATE: state, PEER_WATCHDOG_NOW: '1000200' };
    expect(watchdog(env).verdict).toBe('ARMED_WAITING');
    const second = watchdog(env);
    expect(second.verdict).toBe('BREACH');
    expect(second.paged).toContain('ALERT=SIGNAL1_PEER_UNREACHABLE');
    expect(second.sshCalled).toBe(false);
  });

  it('an UNLISTED watcher REFUSES', { timeout: 60_000 }, () => {
    const r = watchdog({ MONITORING_HOST_LABELS: 'mars-1' });
    expect(r.verdict).toBe('REFUSED');
    expect(r.paged).toBe('');
  });
});

/**
 * OPS-HOST-OUTAGE-WATCHDOG-W1 — the UNARMED half: an unplanned outage pages from the peer, once,
 * classified by two agreeing vantages, and resolves with one --clear. Sequences share their state
 * paths through env, exactly as consecutive cron fires share them on a host.
 *
 * SPAWN BUDGET: 12 bash spawns.
 */
describe('OW-1…OW-5 — unarmed outage liveness', () => {
  const seq = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'watchdog-seq-'));
    return {
      PEER_WATCHDOG_UNARMED_STATE: path.join(d, 'ua'),
      PEER_WATCHDOG_UNARMED_EPISODE: path.join(d, 'ep'),
      PEER_WATCHDOG_ALERT_STATE_DIR: path.join(d, 'alert-state'),
      PEER_WATCHDOG_ARM: path.join(d, 'arm'),
    };
  };

  it('signal-1 pages AOE1_UNREACHABLE on the 2nd consecutive TCP failure, never via ssh', { timeout: 60_000 }, () => {
    const s = seq();
    const first = watchdog({ ...s, PEER_WATCHDOG_NOW: '6000000' }, { curl: 'url' });
    expect(first.verdict).toBe('UNARMED_WAITING');
    expect(first.paged).toBe('');
    const second = watchdog({ ...s, PEER_WATCHDOG_NOW: '6003600' }, { curl: 'url' });
    expect(second.verdict).toBe('UNARMED_BREACH');
    expect(second.paged).toContain('ALERT=AOE1_UNREACHABLE');
    expect(second.paged).toContain('🛑 AOE1_UNREACHABLE — aoe-1 is HOST_DOWN (unplanned: no reboot arm present)');
    expect(second.paged).toContain('HCLOUD_CONTEXT=algovault-mcp hcloud server request-console 127346106');
    expect(second.sshCalled).toBe(false);
    expect(second.tokens).toBe(1);
    expect(second.status).toBe(0);
  });

  it('aoe-1 keeps PATH_ONLY silent and pages SERVING_DOWN with the container remedy', { timeout: 60_000 }, () => {
    const s = { ...seq(), MONITORING_HOST_LABELS: 'aoe-1' };
    const pathOnly = watchdog({ ...s, ST_HEALTH: '200' }, { curl: 'url' });
    expect(pathOnly.verdict).toBe('PATH_ONLY');
    expect(pathOnly.paged).toBe('');
    watchdog({ ...s, ST_HEALTH: '502' }, { curl: 'url', tcp: 'up' });
    const breach = watchdog({ ...s, ST_HEALTH: '502' }, { curl: 'url', tcp: 'up' });
    expect(breach.verdict).toBe('UNARMED_BREACH');
    expect(breach.paged).toContain('🛑 SIGNAL1_UNREACHABLE — signal-1 is SERVING_DOWN (unplanned: no reboot arm present)');
    expect(breach.paged).toContain('check its containers');
    expect(breach.paged).not.toContain('request-console');
  });

  it('one page per episode, then exactly one --clear with the mode flag FIRST', { timeout: 60_000 }, () => {
    const s = { ...seq(), MONITORING_HOST_LABELS: 'aoe-1' };
    const fail = { ...s, ST_HEALTH: '521' };
    watchdog({ ...fail, PEER_WATCHDOG_NOW: '2000000' }, { curl: 'url' });
    const paged = watchdog({ ...fail, PEER_WATCHDOG_NOW: '2000300' }, { curl: 'url' });
    expect(paged.paged).toContain('ALERT=SIGNAL1_UNREACHABLE');
    const third = watchdog({ ...fail, PEER_WATCHDOG_NOW: '2000600' }, { curl: 'url' });
    expect(third.verdict).toBe('UNARMED_BREACH');
    expect(third.paged).toBe('');
    const ok = watchdog({ ...s, PEER_WATCHDOG_NOW: '2001000' }, { curl: 'url', tcp: 'up' });
    expect(ok.verdict).toBe('UNARMED_RESOLVED');
    expect(ok.clears).toBe('--clear SIGNAL1_UNREACHABLE|HOST_DOWN resolved after 16m\n');
    const again = watchdog({ ...s, PEER_WATCHDOG_NOW: '2001300' }, { curl: 'url', tcp: 'up' });
    expect(again.verdict).toBe('UNARMED_OK');
    expect(again.clears).toBe('');
  });

  it('an arm present runs the ARMED logic and leaves the unarmed state untouched', { timeout: 60_000 }, () => {
    const s = { ...seq(), MONITORING_HOST_LABELS: 'aoe-1' };
    writeFileSync(s.PEER_WATCHDOG_UNARMED_STATE, '1 4000000\n');
    writeFileSync(s.PEER_WATCHDOG_ARM, '4000100 some-kernel\n');
    const r = watchdog({ ...s, ST_HEALTH: '521', PEER_WATCHDOG_NOW: '4000110' }, { curl: 'url' });
    expect(r.verdict).toBe('ARMED_WAITING');
    expect(r.stdout).not.toContain('PEER_WATCHDOG_CHECK=control');
    expect(readFileSync(s.PEER_WATCHDOG_UNARMED_STATE, 'utf8')).toBe('1 4000000\n');
  });
});

/**
 * AC5 — the registry the reboot gate reads, per (host, event).
 *
 * SPAWN BUDGET: 0 spawns (pure reads).
 */
describe('AC5 — the registry is per-(host, event) and both hosts have a REBOOT scope', () => {
  const doc = JSON.parse(readFileSync(REGISTRY, 'utf8'));

  it('both hosts declare a reboot event; signal-1 declares deploy too', () => {
    expect(doc._disruption_events['signal-1']).toEqual(['deploy', 'reboot']);
    expect(doc._disruption_events['aoe-1']).toEqual(['reboot']);
  });

  it('every row of a reboot-eligible host is classified for the reboot', () => {
    for (const r of doc.rows) expect(r.events, `row ${r.id}`).toContain('reboot');
  });

  it("aoe-1's REBOOT enumeration is the container+Prefect+cron union, not a docker-exec grep", () => {
    const en = doc._enumeration['aoe-1'].reboot;
    expect(en).toBeDefined();
    expect(en.command).toContain('docker ps');
    expect(en.command).not.toBe(doc._enumeration['signal-1'].deploy.command);
    expect(en.running_containers).toBeGreaterThan(0);
  });

  it('each REBOOT residual matches its rows, and aoe-1 still has ZERO no-safe-kill rows', () => {
    for (const h of ['signal-1', 'aoe-1']) {
      const nsk = doc.rows.filter((r: Record<string, unknown>) => r.host === h && (r.events as string[]).includes('reboot') && r.class === 'no-safe-kill');
      expect(doc._residual_no_safe_kill[h].reboot.count, h).toBe(nsk.length);
    }
    expect(doc._residual_no_safe_kill['aoe-1'].reboot.count).toBe(0);
  });

  it('a preempt-and-catchup row that could block a reboot has a process pattern the harness can probe', () => {
    for (const r of doc.rows.filter((x: Record<string, unknown>) => (x.events as string[]).includes('reboot') && x.class !== 'safe-to-kill')) {
      expect(String(r.process_pattern ?? '').trim().length, `row ${r.id}`).toBeGreaterThan(3);
    }
  });
});
