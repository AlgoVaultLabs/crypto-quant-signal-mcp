/**
 * OPS-HOST-KERNEL-REBOOT-W6 CH2 — KERNEL_STALENESS projects the harness's RECORD.
 *
 * Measured live (audits/KERNEL_STALENESS-2026-10-22.md): every KERNEL_STALENESS page of the
 * 2026-10-21/22 episode was sent BY kernel-auto-reboot.sh, which ran the canary's paging path bare
 * as its `due` gate. The page left before any reboot gate had decided, said "a GATE REFUSED" from
 * crontab text alone, and on aoe-1 went out two seconds before that same run rebooted the host.
 *
 * Each script's own `--self-test` drives its functions with fixtures. THIS file covers what neither
 * can see alone: the two REAL scripts wired together, through the REAL canary_result_log.py, with
 * only the OS (uname / dpkg-query / hostname), the wrapper and the destructive primitives stubbed —
 * and the PRE-FIX bytes from git, so the regression is proven on the code that shipped it.
 *
 * SPAWN BUDGET: ~14 bash spawns (each harness run spawns the canary and python once more).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const CANARY = path.join(REPO, 'ops/monitoring/kernel-staleness-canary.sh');
const HARNESS = path.join(REPO, 'ops/monitoring/kernel-auto-reboot.sh');
const MONITORING = path.join(REPO, 'ops/monitoring');
const REGISTRY = path.join(REPO, 'ops/scripts/cron-interlock-registry.json');
const ALERT_REGISTRY = path.join(REPO, 'ops/monitoring/alert-registry.json');
/** The last commit carrying the pre-W6 canary + harness bytes (origin/main at R0). */
const PRE_FIX_SHA = 'e3d722c6';

/**
 * A long `--self-test` run ASYNC. A 15 s+ `spawnSync` blocks the worker's event loop, so vitest's own
 * `onTaskUpdate` RPC times out and the run exits 1 with every test passing ("Unhandled Errors").
 */
function spawnAsync(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; status: number | null }> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    c.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    c.stderr.resume();
    c.on('close', (status) => resolve({ stdout, status }));
  });
}

type World = ReturnType<typeof world>;

/** One simulated aoe-1: a stale kernel, an --apply crontab, and every side effect recorded. */
function world() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kstale-e2e-'));
  const mk = (name: string, body: string) => {
    const p = path.join(dir, name);
    writeFileSync(p, body, { mode: 0o755 });
    return p;
  };
  mkdirSync(path.join(dir, 'bin'));
  mkdirSync(path.join(dir, 'dpkg'));
  mkdirSync(path.join(dir, 'peer'));
  mk('bin/uname', '#!/bin/sh\necho 6.8.0-142-generic\n');
  mk('bin/dpkg-query', '#!/bin/sh\nprintf "%s\\n" linux-image-6.8.0-142-generic linux-image-6.8.0-147-generic\n');
  mk('bin/hostname', '#!/bin/sh\necho AlgoVault-AOE\n');
  // Installed 8 days ago: past the 7-day threshold, so the canary decides BREACH.
  const list = path.join(dir, 'dpkg', 'linux-image-6.8.0-147-generic.list');
  writeFileSync(list, '');
  const installedAt = Date.now() / 1000 - 8 * 86400;
  utimesSync(list, installedAt, installedAt);
  const files = {
    canaryPaged: path.join(dir, 'canary-paged'),
    harnessPaged: path.join(dir, 'harness-paged'),
    rebooted: path.join(dir, 'rebooted'),
    results: path.join(dir, 'results.jsonl'),
    marker: path.join(dir, 'peer', 'marker'),
  };
  const env = {
    PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
    PYTHONDONTWRITEBYTECODE: '1',
    MONITORING_HOST_LABELS: '',
    CANARY_RESULT_LOG_PATH: files.results,
    // The canary's seams (pre-fix bytes honour only WRAPPER, LOG and CRONTAB).
    KERNEL_CANARY_WRAPPER: mk('canary-send.sh', `#!/bin/sh\ncat >> ${files.canaryPaged}\necho "ALERT=$1 SEV=$2" >> ${files.canaryPaged}\n`),
    KERNEL_CANARY_LOG: path.join(dir, 'canary.log'),
    KERNEL_CANARY_CRONTAB: mk('crontab.sh', '#!/bin/sh\necho "7 * * * * /opt/algovault-monitoring/kernel-auto-reboot.sh --apply >/dev/null 2>&1"\n'),
    KERNEL_CANARY_DPKG_INFO_DIR: path.join(dir, 'dpkg'),
    KERNEL_CANARY_RESULT_LOG_DIR: MONITORING,
    KERNEL_CANARY_ALERT_REGISTRY: ALERT_REGISTRY,
    KERNEL_CANARY_IDENTITY_FILE: mk('id', 'aoe-1\n'),
    // The harness's seams: every destructive primitive recorded, never performed.
    AUTO_REBOOT_IDENTITY_FILE: path.join(dir, 'id'),
    AUTO_REBOOT_LOG: path.join(dir, 'harness.log'),
    AUTO_REBOOT_STATE: path.join(dir, 'state'),
    AUTO_REBOOT_REQUIRED_FILE: path.join(dir, 'reboot-required'),
    AUTO_REBOOT_BOOT_CONTRACT: mk('bc.sh', '#!/bin/sh\necho "BOOT_CONTRACT_VERDICT=OK"\n'),
    AUTO_REBOOT_REGISTRY: REGISTRY,
    AUTO_REBOOT_WRAPPER: mk('harness-send.sh', `#!/bin/sh\ncat >> ${files.harnessPaged}\necho "ALERT=$1 SEV=$2" >> ${files.harnessPaged}\n`),
    AUTO_REBOOT_REBOOT_CMD: mk('reboot.sh', `#!/bin/sh\necho rebooted >> ${files.rebooted}\n`),
    AUTO_REBOOT_ARM_CMD: mk('arm.sh', '#!/bin/sh\necho PEER_ARM_VERDICT=ARMED\n'),
    AUTO_REBOOT_PS: mk('ps.sh', '#!/bin/sh\nprintf "%s\\n" "/sbin/init" "node dist/index.js"\n'),
    AUTO_REBOOT_CURL: mk('curl.sh', '#!/bin/sh\necho 200\n'),
    AUTO_REBOOT_PEER_ARM_MARKER: files.marker,
    AUTO_REBOOT_NODE: 'bash',
    AUTO_REBOOT_CRONTAB: mk('h-crontab.sh', '#!/bin/sh\necho "17 3 * * * /opt/x.sh"\n'),
    AUTO_REBOOT_SYSTEMCTL: mk('systemctl.sh', '#!/bin/sh\necho cron.service\n'),
    AUTO_REBOOT_NOW_HOUR: '05',
    AUTO_REBOOT_RESULT_LOG_DIR: MONITORING,
  };
  return { dir, files, env };
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const pages = (p: string) => (read(p).match(/^ALERT=KERNEL_STALENESS /gm) || []).length;

/** Run a harness against a canary. `canary` is the script the harness's `due` gate calls. */
function runHarness(w: World, harness: string, canary: string, extra: Record<string, string> = {}) {
  const r = spawnSync('bash', [harness, '--apply'], {
    encoding: 'utf8',
    env: { ...process.env, ...w.env, AUTO_REBOOT_STALENESS: canary, ...extra },
  });
  return { status: r.status, stdout: r.stdout, verdict: (r.stdout.match(/^AUTO_REBOOT_VERDICT=(\w+)$/m) || [])[1] };
}

/** The canary's own hourly cron run (the ONLY path that may page after W6). */
function runCanary(w: World, args: string[] = []) {
  return spawnSync('bash', [CANARY, ...args], { encoding: 'utf8', env: { ...process.env, ...w.env } });
}

function preFix(w: World, file: string) {
  const p = path.join(w.dir, `prefix-${path.basename(file)}`);
  writeFileSync(p, execFileSync('git', ['-C', REPO, 'show', `${PRE_FIX_SHA}:ops/monitoring/${path.basename(file)}`]), { mode: 0o755 });
  return p;
}

describe('W6 — the regression, on the bytes that shipped it', () => {
  it('PRE-FIX: the harness pages KERNEL_STALENESS from inside its due gate, then reboots', { timeout: 60_000 }, () => {
    const w = world();
    const r = runHarness(w, preFix(w, HARNESS), preFix(w, CANARY));
    expect(r.verdict).toBe('REBOOTED');
    // The page left BEFORE any reboot gate decided — and claimed a refusal on a host that rebooted.
    expect(pages(w.files.canaryPaged)).toBe(1);
    expect(read(w.files.canaryPaged)).toContain('a GATE REFUSED');
    expect(existsSync(w.files.rebooted)).toBe(true);
  });

  it('POST-FIX: the same world sends ZERO pages and still issues REBOOTED', { timeout: 60_000 }, () => {
    const w = world();
    const r = runHarness(w, HARNESS, CANARY);
    expect(r.verdict).toBe('REBOOTED');
    expect(pages(w.files.canaryPaged)).toBe(0);
    expect(read(w.files.harnessPaged)).toBe('');
    expect(existsSync(w.files.rebooted)).toBe(true);
    // ...and the record it leaves carries what the page would project.
    const rec = JSON.parse(read(w.files.results).trim().split('\n').pop()!);
    expect(rec).toMatchObject({ host: 'aoe-1', canary: 'kernel-auto-reboot', verdict: 'REBOOTED' });
    expect(rec.metrics).toMatchObject({ decided_by: 'action', kernel_installed: '6.8.0-147-generic', staleness: 'BREACH:8', streak_count: 1 });
    expect(rec.metrics.detail).toMatch(/^AUTO_REBOOT_GATE=action state=/);
  });

  it('the harness never calls the canary without --decide (source pin)', () => {
    const src = readFileSync(HARNESS, 'utf8');
    expect(src).toContain('"$STALENESS" --decide');
    expect(src).not.toMatch(/"\$\(\s*"\$STALENESS"\s*2>/);
  });
});

describe('W6 — the canary pages from the RECORD, on its own cron run', () => {
  it('a FIRST peer_busy deferral is the mutual exclusion working: no page', { timeout: 60_000 }, () => {
    const w = world();
    writeFileSync(w.files.marker, 'armed\n');
    expect(runHarness(w, HARNESS, CANARY).verdict).toBe('DEFERRED');
    const c = runCanary(w);
    expect(c.status).toBe(0);
    expect(pages(w.files.canaryPaged)).toBe(0);
    expect(read(w.env.KERNEL_CANARY_LOG)).toContain('REPORT: not paging');
  });

  it('a SECOND consecutive deferral by the same gate is a refusal: ONE page quoting the harness', { timeout: 60_000 }, () => {
    const w = world();
    writeFileSync(w.files.marker, 'armed\n');
    runHarness(w, HARNESS, CANARY);
    expect(runHarness(w, HARNESS, CANARY).verdict).toBe('DEFERRED');
    runCanary(w);
    const body = read(w.files.canaryPaged);
    expect(pages(w.files.canaryPaged)).toBe(1);
    expect(body).toContain('Host <b>aoe-1</b> (AlgoVault-AOE) is running an out-of-date kernel.');
    expect(body).toContain('has refused 2 consecutive run(s) since');
    expect(body).toContain('DEFERRED by gate peer_busy — AUTO_REBOOT_GATE=peer_busy state=DEFERRED');
    expect(body).not.toContain('a GATE REFUSED');
    expect(body).toContain('ops/monitoring/kernel-auto-reboot.sh');
  });

  it('a covered host with NO harness record is SILENT — the dead-harness page', { timeout: 60_000 }, () => {
    const w = world();
    runCanary(w);
    expect(pages(w.files.canaryPaged)).toBe(1);
    expect(read(w.files.canaryPaged)).toContain('has written no decision since never');
  });
});

describe('W6 — the canary CLI contract', () => {
  it('--decide prints exactly ONE anchored line, writes no log, never pages', { timeout: 60_000 }, () => {
    const w = world();
    const r = runCanary(w, ['--decide']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^KERNEL_STALENESS_DECISION=BREACH running=6\.8\.0-142-generic installed=6\.8\.0-147-generic age_days=8 breach_at=\d+\n$/);
    expect(existsSync(w.env.KERNEL_CANARY_LOG)).toBe(false);
    expect(read(w.files.canaryPaged)).toBe('');
  });

  it('--self-test exits 0 with SELF_TEST_VERDICT=PASS (token AND code)', { timeout: 120_000 }, async () => {
    const r = await spawnAsync('bash', [CANARY, '--self-test'], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    expect(r.stdout).toMatch(/^SELF_TEST_VERDICT=PASS — \d+ assertions/m);
    expect(r.status).toBe(0);
  });

  it('the registry row declares the record the canary reads, and its canary is the harness\'s own', () => {
    const row = JSON.parse(readFileSync(ALERT_REGISTRY, 'utf8')).alerts.find((a: { alert_id: string }) => a.alert_id === 'KERNEL_STALENESS');
    const dr = row.related_automation[0].decision_record;
    expect(dr).toEqual({ canary: 'kernel-auto-reboot', max_age_s: 7200 });
    expect(readFileSync(HARNESS, 'utf8')).toMatch(/^RESULT_CANARY="kernel-auto-reboot"$/m);
  });
});
