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
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
