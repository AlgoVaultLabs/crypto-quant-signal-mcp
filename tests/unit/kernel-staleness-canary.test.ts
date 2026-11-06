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
 * and the PRE-FIX bytes as sha-pinned fixtures, so the regression is proven on the code that shipped it.
 *
 * SPAWN BUDGET: ~14 bash spawns (each harness run spawns the canary and python once more).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const FLOOR_HELPER = path.join(REPO, 'ops/monitoring/kernel-cve-floor.py');
const FLOORS = path.join(REPO, 'ops/monitoring/kernel-cve-floors.json');
/**
 * The PRE-W6 bytes, pinned as fixtures — never `git show <sha>:`, because CI checks out shallow and
 * has no history (measured: deploy run 39763287192, `fatal: invalid object name`). Each is pinned
 * to the sha256 R0 measured LIVE on both hosts, which equals its inventory row at `e3d722c6`.
 */
const PRE_FIX = {
  'kernel-auto-reboot.sh': { fixture: 'kernel-auto-reboot.pre-w6.sh.txt', sha256: '4a4b0439384c4d06d05f4a310911446298d867b98bb5c666eed183e9d3851c28' },
  'kernel-staleness-canary.sh': { fixture: 'kernel-staleness-canary.pre-w6.sh.txt', sha256: '0ff59c5260687a4fa7e6da21698f5d51ada21b212773b1ef49cba8098858f7d6' },
} as const;

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

/**
 * OPS-CVE-2026-98432-INTERIM-W1 CH2: the world also wires the REAL kernel-cve-floor.py against the
 * REAL declared floors (noble/generic 6.8.0-149.149), with only its OS reads and nft stubbed. The
 * defaults keep every pre-CH2 world BELOW_FIX_ABSENT (nothing at 149 on disk), so a stale kernel stays
 * the BREACH it always was.
 */
type WorldOpts = {
  running?: string;
  /** [kernel release, package version], newest LAST — its .list is the one aged by ageDays. */
  kernels?: Array<[string, string]>;
  ageDays?: number;
  nft?: 'present' | 'absent';
};

/** One simulated aoe-1: a stale kernel, an --apply crontab, and every side effect recorded. */
function world(o: WorldOpts = {}) {
  const running = o.running ?? '6.8.0-142-generic';
  const kernels = o.kernels ?? [['6.8.0-142-generic', '6.8.0-142.142'], ['6.8.0-147-generic', '6.8.0-147.147']];
  const dir = mkdtempSync(path.join(tmpdir(), 'kstale-e2e-'));
  const mk = (name: string, body: string) => {
    const p = path.join(dir, name);
    writeFileSync(p, body, { mode: 0o755 });
    return p;
  };
  mkdirSync(path.join(dir, 'bin'));
  mkdirSync(path.join(dir, 'dpkg'));
  mkdirSync(path.join(dir, 'peer'));
  mk('bin/uname', `#!/bin/sh\necho ${running}\n`);
  mk('bin/dpkg-query', `#!/bin/sh\nprintf "%s\\n" ${kernels.map(([k]) => `linux-image-${k}`).join(' ')}\n`);
  mk('bin/hostname', '#!/bin/sh\necho AlgoVault-AOE\n');
  // Default: installed 8 days ago — past the 7-day threshold, so the canary decides BREACH.
  const list = path.join(dir, 'dpkg', `linux-image-${kernels[kernels.length - 1][0]}.list`);
  writeFileSync(list, '');
  const installedAt = Date.now() / 1000 - (o.ageDays ?? 8) * 86400;
  utimesSync(list, installedAt, installedAt);
  // The floor helper's own OS reads. Plain strings, never template literals: `${Version}` is dpkg's.
  const versionCases = kernels.map(([k, v]) => '    linux-image-' + k + ") printf '" + v + "' ;;\n").join('');
  const listing = kernels.map(([k, v]) => 'linux-image-' + k + '\\t' + v + '\\tii \\n').join('');
  const kcfQuery = mk('kcf-dpkg-query',
    '#!/bin/sh\n' +
    "if [ \"$2\" = '-f=${Version}' ]; then\n  case \"$3\" in\n" + versionCases + '    *) exit 1 ;;\n  esac\n  exit 0\nfi\n' +
    "printf '" + listing + "'\n");
  const files = {
    canaryPaged: path.join(dir, 'canary-paged'),
    harnessPaged: path.join(dir, 'harness-paged'),
    rebooted: path.join(dir, 'rebooted'),
    results: path.join(dir, 'results.jsonl'),
    marker: path.join(dir, 'peer', 'marker'),
    nftArgv: path.join(dir, 'nft-argv'),
  };
  const nft = mk('nft', o.nft === 'absent'
    ? `#!/bin/sh\necho "$*" >> ${files.nftArgv}\necho "Error: No such file or directory" >&2\nexit 1\n`
    : `#!/bin/sh\necho "$*" >> ${files.nftArgv}\nprintf 'table inet cve_2026_98432 {\\n\\tchain prerouting {\\n\\t\\ttype filter hook prerouting priority raw - 10; policy accept;\\n\\t\\tip protocol tcp ip hdrlength > 5 counter packets 0 bytes 0 drop comment "CVE-2026-98432 IPv4 TCP with IP options"\\n\\t}\\n}\\n'\n`);
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
    // CH2: the REAL floor helper and the REAL declared floors; only its OS reads and nft are stubbed.
    KERNEL_CANARY_FLOOR_HELPER: FLOOR_HELPER,
    KERNEL_CVE_FLOORS: FLOORS,
    KERNEL_CVE_OS_RELEASE: mk('os-release', 'NAME="Ubuntu"\nVERSION_CODENAME=noble\n'),
    KERNEL_CVE_UNAME: path.join(dir, 'bin', 'uname'),
    KERNEL_CVE_DPKG_QUERY: kcfQuery,
    KERNEL_CVE_DPKG: mk('kcf-dpkg', '#!/usr/bin/env python3\nimport re, sys\na = sys.argv[1:]\nkey = lambda v: [int(x) for x in re.findall(r"\\d+", v.split("~")[0])]\nsys.exit(0 if key(a[1]) >= key(a[3]) else 1)\n'),
    KERNEL_CVE_NFT: nft,
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
  const pin = PRE_FIX[path.basename(file) as keyof typeof PRE_FIX];
  const bytes = readFileSync(path.join(REPO, 'tests/fixtures', pin.fixture));
  // A fixture that drifted from the shipped bytes would prove nothing about the regression.
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.sha256);
  const p = path.join(w.dir, `prefix-${path.basename(file)}`);
  writeFileSync(p, bytes, { mode: 0o755 });
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
    expect(r.stdout).toMatch(/^KERNEL_STALENESS_DECISION=BREACH running=6\.8\.0-142-generic installed=6\.8\.0-147-generic age_days=8 breach_at=\d+ cve_floor=BELOW_FIX_ABSENT\n$/);
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

/**
 * OPS-CVE-2026-98432-INTERIM-W1 CH2 — the floor, wired through the REAL canary, the REAL helper, the
 * REAL declared floors and the REAL harness. Architect ruling Q4: a CVE-fixed kernel installed but not
 * running makes the reboot due at once, not after the 7-day threshold.
 */
describe('CH2 — the kernel-CVE floor, end to end', () => {
  const FIXED: Array<[string, string]> = [['6.8.0-147-generic', '6.8.0-147.147'], ['6.8.0-149-generic', '6.8.0-149.149']];

  it('a CVE-fixed kernel installed ONE day ago is due now: the harness REBOOTS', { timeout: 60_000 }, () => {
    const w = world({ running: '6.8.0-147-generic', kernels: FIXED, ageDays: 1 });
    const d = runCanary(w, ['--decide']);
    expect(d.stdout).toMatch(/^KERNEL_STALENESS_DECISION=BREACH running=6\.8\.0-147-generic installed=6\.8\.0-149-generic age_days=1 breach_at=\d+ cve_floor=BELOW_FIX_INSTALLED\n$/);
    const r = runHarness(w, HARNESS, CANARY);
    expect(r.verdict).toBe('REBOOTED');
    expect(existsSync(w.files.rebooted)).toBe(true);
    const rec = JSON.parse(read(w.files.results).trim().split('\n').pop()!);
    expect(rec.metrics).toMatchObject({ kernel_installed: '6.8.0-149-generic', staleness: 'BREACH:1' });
  });

  it('the control: the same 1-day-old kernel WITHOUT the fix is NOT_DUE, and nothing reboots', { timeout: 60_000 }, () => {
    const w = world({ running: '6.8.0-142-generic', ageDays: 1 });
    const d = runCanary(w, ['--decide']);
    expect(d.stdout).toMatch(/^KERNEL_STALENESS_DECISION=REPORT .* age_days=1 breach_at=\d+ cve_floor=BELOW_FIX_ABSENT\n$/);
    expect(runHarness(w, HARNESS, CANARY).verdict).toBe('NOT_DUE');
    expect(existsSync(w.files.rebooted)).toBe(false);
  });

  it('the live path: a missing interim table pages KERNEL_CVE_MITIGATION once, and nft is only ever LISTED', { timeout: 60_000 }, () => {
    const w = world({ running: '6.8.0-147-generic', kernels: [['6.8.0-147-generic', '6.8.0-147.147']], nft: 'absent' });
    expect(runCanary(w).status).toBe(0);
    const body = read(w.files.canaryPaged);
    expect((body.match(/^ALERT=KERNEL_CVE_MITIGATION SEV=CRITICAL_PERSISTENT$/gm) || []).length).toBe(1);
    expect(pages(w.files.canaryPaged)).toBe(0); // the newest kernel, below the floor: REPORT, no staleness page
    expect(body).toContain('state=MISSING table=inet/cve_2026_98432 unit=cve-2026-98432-nft.service');
    expect(read(w.env.KERNEL_CANARY_LOG)).toContain('cve_mitigation=MISSING host=aoe-1');
    expect(read(w.files.nftArgv).trim().split('\n')).toEqual(['list table inet cve_2026_98432']);
  });

  it('the live path: a loaded interim table is a positive PRESENT line and no page', { timeout: 60_000 }, () => {
    const w = world({ running: '6.8.0-147-generic', kernels: [['6.8.0-147-generic', '6.8.0-147.147']] });
    runCanary(w);
    expect(read(w.files.canaryPaged)).toBe('');
    expect(read(w.env.KERNEL_CANARY_LOG)).toMatch(/VERDICT=REPORT host=aoe-1 .*cve_floor=BELOW_FIX_ABSENT/);
    expect(read(w.env.KERNEL_CANARY_LOG)).toContain('cve_mitigation=PRESENT host=aoe-1');
  });
});
