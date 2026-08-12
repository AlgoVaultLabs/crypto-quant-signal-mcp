/**
 * OPS-AOE-SEND-TELEGRAM-REPARITY-W1 — the registry must be RESOLVABLE, not merely declarative.
 *
 * THE INCIDENT THIS EXISTS FOR. `send_telegram.sh` diverged between its two hosts for the SECOND
 * time. `OPS-AOE-MONITORING-PARITY-W1` had already added the `installed_at` consumer registry
 * precisely to stop that — and it worked as a DETECTOR (REGISTRY_PARITY named the miss) while
 * failing as a PREVENTATIVE, because nothing ever read the registry to perform an install. So
 * "update the primitive everywhere" stayed an act of memory.
 *
 * Worse, the reason it stayed broken for 12 days was an UNVERIFIED ABSENCE CLAIM. The row's own
 * `pending_reason` read: *"its address is recorded NOWHERE in the repo SoT"*. That was FALSE — the
 * address sat in four committed files, two machine-readable, including
 * `scripts/data/boot-critical-units.json`, a `label -> {address}` map for exactly these two hosts
 * with a live consumer. A single `git grep` would have refuted it. A wave was deferred instead, and
 * the host kept running a resolver already known to be broken.
 *
 * So the load-bearing assertion in this file is the SECOND one: every host label the registry names
 * must resolve to an address. It converts "the address is recorded nowhere" from a claim someone can
 * assert into a claim the build can refute — which is the only durable answer to a wave blocking on
 * an unchecked premise.
 */
import {
  describe, it, expect, beforeEach, afterAll,
} from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'ops/scripts/install-monitoring-artifact.sh');
const INVENTORY = path.join(ROOT, 'ops/monitoring/monitoring-inventory.json');
const HOSTS_SOT = path.join(ROOT, 'scripts/data/boot-critical-units.json');

type Entry = { host?: string; path?: string; install_state?: string };
type Row = {
  id: string; artifact?: string; sha256?: string; kind?: string;
  installed_at?: Entry[];
};
const rows: Row[] = JSON.parse(readFileSync(INVENTORY, 'utf8')).artifacts;

function run(...args: string[]): { out: string; code: number } {
  try {
    return { out: execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8' }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

describe('install-monitoring-artifact — verdict contract', () => {
  it('is committed executable (an operator runs it directly)', () => {
    expect(existsSync(SCRIPT), 'the primitive is missing').toBe(true);
    // eslint-disable-next-line no-bitwise
    expect(statSync(SCRIPT).mode & 0o111, 'not executable').toBeGreaterThan(0);
  });

  it('--self-test passes, is not vacuous, and prints exactly ONE terminal verdict token', () => {
    const { out, code } = run('--self-test');
    const tokens = out.split('\n').filter((l) => l.startsWith('INSTALL_MONITORING_ARTIFACT_VERDICT='));
    expect(tokens, 'exactly one verdict token').toHaveLength(1);
    expect(tokens[0]).toBe('INSTALL_MONITORING_ARTIFACT_VERDICT=PASS');
    expect(code).toBe(0);
    // Non-vacuity: the suite must report a real number of checks, not silently assert nothing.
    const n = /(\d+) checks passed/.exec(out);
    expect(n, 'the self-test did not report a check count').toBeTruthy();
    expect(Number(n![1])).toBeGreaterThanOrEqual(12);
  });

  it('refuses a bare invocation with INDETERMINATE, never a pass over nothing', () => {
    const { out, code } = run();
    expect(out).toContain('INSTALL_MONITORING_ARTIFACT_VERDICT=INDETERMINATE');
    expect(code).toBe(3);
  });
});

describe('every registry host label RESOLVES to an address — the claim the build can refute', () => {
  const hosts: Record<string, { address?: string }> =
    JSON.parse(readFileSync(HOSTS_SOT, 'utf8')).hosts ?? {};

  it('the hosts SoT is a non-empty label -> address map (vacuity guard)', () => {
    // Without this, the assertion below is trivially satisfiable by an empty registry on both
    // sides — the shape that let "recorded nowhere" go unchallenged in the first place.
    const withAddress = Object.entries(hosts).filter(([, v]) => v && v.address);
    expect(withAddress.length, `${HOSTS_SOT} declares no addressable hosts`).toBeGreaterThanOrEqual(2);
  });

  it('no installed_at entry names a host label the SoT cannot resolve', () => {
    const unresolved: string[] = [];
    let entries = 0;
    for (const r of rows) {
      for (const e of r.installed_at ?? []) {
        if (!e.host) continue;
        entries += 1;
        if (!hosts[e.host]?.address) unresolved.push(`${r.id} -> ${e.host}`);
      }
    }
    expect(entries, 'no installed_at entries at all — the registry derivation broke')
      .toBeGreaterThanOrEqual(10);
    expect(
      unresolved,
      'These registry entries name a host label with no address in scripts/data/boot-critical-units.json. '
        + 'Add it there (the ONE address SoT — do not start a second one), because an unresolvable '
        + 'label is what stalls an install and gets recorded as "the address is recorded nowhere":\n  '
        + unresolved.join('\n  '),
    ).toEqual([]);
  });

  it('every installed_at entry carries the host and path an install needs', () => {
    for (const r of rows) {
      for (const e of r.installed_at ?? []) {
        expect(e.host, `${r.id}: an installed_at entry has no host`).toBeTruthy();
        expect(e.path, `${r.id}: installed_at entry for ${e.host} has no path`).toBeTruthy();
      }
    }
  });
});

describe('the primitive is wired to the inventory it installs from', () => {
  const row = rows.find((r) => r.id === 'install-monitoring-artifact');

  it('has an inventory row — an unregistered ops artifact is the class this repo retires', () => {
    expect(row, 'install-monitoring-artifact has no inventory row').toBeTruthy();
    expect(row!.artifact).toBe('ops/scripts/install-monitoring-artifact.sh');
  });

  it('its recorded sha256 matches the committed bytes', () => {
    const actual = createHash('sha256').update(readFileSync(SCRIPT)).digest('hex');
    expect(row!.sha256, 'inventory sha256 is stale — re-stamp it in the same commit as the edit')
      .toBe(actual);
  });

  it('NO cron may invoke it — it moves executable code', () => {
    // The one hard boundary. An unattended privileged install is exactly what CLAUDE.md forbids;
    // this tool is the reviewed human path, and a schedule on it would convert it into the thing
    // it was built to avoid.
    expect(row!.schedule ?? null, 'a schedule on this row would make it an unattended installer')
      .toBeNull();
    expect(String(row!.invoked_by ?? '')).toMatch(/operator/i);
  });

  it('dry run is the DEFAULT — acting requires --apply', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toContain('APPLY=0');
    expect(src).toMatch(/--apply/);
    // The guard that makes a dry run genuinely inert: no ssh mutation before the APPLY check.
    expect(src).toMatch(/if \[ "\$APPLY" != 1 \]; then continue; fi/);
  });

  it('refuses to install a file that disagrees with the row canonical hash', () => {
    // Installing an unstamped file would plant drift by construction, since the row is what
    // HASH_DRIFT and REGISTRY_PARITY compare the live host file against.
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/hash_matches "\$SRC" "\$CANON" \|\| verdict FAIL 1/);
  });
});

/**
 * OPS-INSTALLER-FIRST-INSTALL-BACKUP-W1 — the backup path, which NOTHING tested before.
 *
 * The install body lived inside an `ssh "…"` heredoc, so it was the one code path here that no
 * test could reach: `--self-test` is hermetic and never opens a connection. It moves executable
 * code to production hosts, which is exactly backwards. It is now a pure `build_remote_install`
 * that PRINTS the remote script, so the same text ssh receives is what these fixtures execute
 * against a temp dir — one derivation, and a seam that cannot print a verdict.
 *
 * The defect being pinned: backing up only on overwrite made every FIRST install of a
 * `load-bearing` artifact manufacture the `NO_BACKUP` finding it was supposed to satisfy.
 * Reproduced live on `payment-decline-canary` 2026-08-12, with 26 sibling rows in scope on
 * signal-1 alone.
 */
describe('the remote install script — both backup paths, without a host', () => {
  const TMP = mkdtempSync(path.join(tmpdir(), 'ima-remote-'));
  let box = '';

  beforeEach(() => {
    box = mkdtempSync(path.join(TMP, 'case-'));
  });
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  /** Drive the REAL seam: source the script, print the remote text, run it through `sh`. */
  function runRemote(dest: string, staged: string, canon: string, wave = 'TESTWAVE'): string {
    const r = spawnSync(
      'bash',
      ['-c', `. "${SCRIPT}"; build_remote_install "${dest}" "${staged}" "${canon}" | sh 2>&1 | tail -1`],
      { encoding: 'utf8', env: { ...process.env, INSTALL_ARTIFACT_WAVE: wave } },
    );
    return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  }

  function stage(bytes: string): { file: string; sha: string } {
    const file = path.join(box, 'staged');
    writeFileSync(file, bytes);
    return { file, sha: createHash('sha256').update(bytes).digest('hex') };
  }

  const baks = (dest: string) => readdirSync(path.dirname(dest))
    .filter((f) => f.startsWith(`${path.basename(dest)}.bak.`));

  it('dest ABSENT -> install succeeds and leaves exactly one .bak', () => {
    const dest = path.join(box, 'artifact.py');
    const { file, sha } = stage('#!/usr/bin/env python3\nv1\n');
    const out = runRemote(dest, file, sha);
    expect(out, out).toContain(`OK ${sha}`);
    expect(readFileSync(dest, 'utf8')).toContain('v1');
    expect(baks(dest), 'a first install must still leave a restore point — this IS the defect')
      .toHaveLength(1);
  });

  it('dest PRESENT -> the pre-swap backup holds the OLD bytes, dest holds the new', () => {
    const dest = path.join(box, 'artifact.py');
    writeFileSync(dest, 'OLD\n');
    const { file, sha } = stage('NEW\n');
    const out = runRemote(dest, file, sha);
    expect(out, out).toContain(`OK ${sha}`);
    expect(readFileSync(dest, 'utf8')).toBe('NEW\n');
    const [bak] = baks(dest);
    expect(bak, 'no backup was taken on the overwrite path').toBeTruthy();
    expect(readFileSync(path.join(box, bak), 'utf8'), 'the backup must be the ROLLBACK point')
      .toBe('OLD\n');
  });

  it('install FAILS on a first install -> no .bak is left behind', () => {
    // An unwritable destination directory: `install` cannot succeed, so nothing may be stamped.
    const dir = path.join(box, 'ro');
    mkdirSync(dir);
    const dest = path.join(dir, 'artifact.py');
    const { file, sha } = stage('v1\n');
    execFileSync('chmod', ['500', dir]);
    try {
      const out = runRemote(dest, file, sha);
      expect(out).toContain('INSTALL_FAILED');
      expect(existsSync(dest)).toBe(false);
    } finally {
      execFileSync('chmod', ['700', dir]);
    }
    expect(baks(dest), 'a backup of a failed install asserts a restore point that never existed')
      .toHaveLength(0);
  });

  it('sha verification FAILS -> no .bak stamped, and the run refuses', () => {
    const dest = path.join(box, 'artifact.py');
    const { file } = stage('v1\n');
    const out = runRemote(dest, file, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(out).toMatch(/^SHA_MISMATCH /);
    expect(baks(dest), 'the stamp must land AFTER verification, never before').toHaveLength(0);
  });

  it('the log note reports the path actually taken — first install != overwrite', () => {
    const a = path.join(box, 'a.py');
    const s1 = stage('v1\n');
    const first = runRemote(a, s1.file, s1.sha);
    const s2 = stage('v2\n');
    const over = runRemote(a, s2.file, s2.sha);
    expect(first).toContain('note=first install — .bak stamped after the swap');
    expect(over).toMatch(/note=backup \.bak\.TESTWAVE-/);
    expect(first).not.toBe(over);
  });

  it('sourcing the script does NOT run the installer — no verdict token is emitted', () => {
    // A seam that can print a verdict is a bypass on the instrument every other check reports
    // through. Same assertion the author-identity gate carries for the same reason.
    const r = spawnSync('bash', ['-c', `. "${SCRIPT}"; echo SOURCED_OK`], { encoding: 'utf8' });
    expect(r.stdout).toContain('SOURCED_OK');
    expect(r.stdout).not.toContain('INSTALL_MONITORING_ARTIFACT_VERDICT=');
  });
});

/**
 * A hermetic seam is structurally blind to exactly what it replaces, so the REAL script's text is
 * asserted directly too — the fixtures above run `build_remote_install`'s output, and would stay
 * green if the live `ssh` call stopped using it.
 */
describe('the shipped script really uses the seam, and both installers agree', () => {
  const SIBLING = path.join(ROOT, 'ops/monitoring/declaration-sync.sh');

  it('the ssh call sends build_remote_install output — not a second inline copy', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    expect(src).toMatch(/ssh -n -i "\$SSH_KEY" \$SSH_OPTS[\s\S]{0,60}"\$\(build_remote_install /);
    // The old inline heredoc must be gone, or there would be two derivations of one script.
    expect(src).not.toMatch(/install -m \\"\\\$m\\" \\"\\\$t\\"/);
  });

  it('the first-install stamp is guarded on a flag and lands after verification', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const body = /build_remote_install\(\)[\s\S]*?\nREMOTE\n/.exec(src)?.[0] ?? '';
    expect(body, 'could not locate the generated remote script').toBeTruthy();
    expect(body).toMatch(/first_install=1/);
    expect(body).toMatch(/\[ "\\\$first_install" -eq 1 \]/);
    const verifyAt = body.indexOf('SHA_MISMATCH');
    const stampAt = body.indexOf('-eq 1 ]');
    expect(verifyAt, 'no sha verification in the remote script').toBeGreaterThan(-1);
    expect(stampAt, 'the first-install stamp must come AFTER the sha check').toBeGreaterThan(verifyAt);
  });

  it('no unconditional backup claim survives in the caller log line', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    // The old line claimed `· backup .bak.$WAVE-$STAMP` on BOTH paths, including the first
    // install where no backup had been taken at all.
    expect(src).not.toMatch(/installed \+ verified \([^)]*\) · backup \.bak\./);
    expect(src).toMatch(/\$\{rest#\*note=\}/);
  });

  it('BOTH installers carry a flag-gated first-install stamp — divergence fails here', () => {
    // The same false alarm was produced by two different installers and only one learned. This is
    // what stops the third rediscovery.
    for (const [name, file] of [['installer', SCRIPT], ['declaration-sync', SIBLING]] as const) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${name} lost its first_install flag`).toMatch(/first_install=1/);
      expect(src, `${name} lost its flag-gated post-swap stamp`)
        .toMatch(/first_install(\\)?" -eq 1 \]/);
      expect(src, `${name} lost its paired note`).toMatch(/first install — \.bak stamped after the swap/);
    }
  });
});
