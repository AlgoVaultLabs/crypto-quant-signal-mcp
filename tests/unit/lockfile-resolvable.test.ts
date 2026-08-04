import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REGISTRY,
  parseLock,
  pinSet,
  nameFromResolved,
  nameFromPath,
  structuralFindings,
  loadAttestation,
  unattested,
  evaluateResolvability,
  exitCodeFor,
  sweep,
  // @ts-expect-error — plain-JS gate module, imported for its pure exports
} from '../../scripts/check-lockfile-resolvable.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = 'scripts/check-lockfile-resolvable.mjs';

const run = (args: string[], cwd = ROOT) => {
  try {
    return { code: 0, out: execFileSync('node', [join(cwd, GATE), ...args], { cwd, encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
};

const entry = (name: string, version: string, over: Record<string, unknown> = {}) => ({
  version,
  resolved: `${REGISTRY}${name}/-/${name.split('/').pop()}-${version}.tgz`,
  integrity: 'sha512-fixture',
  ...over,
});

/** A throwaway root laid out like the repo, so the gate's ROOT-relative paths resolve into it. */
function fakeRoot(lock: unknown, attestation?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'lockres-'));
  mkdirSync(join(dir, 'scripts/data'), { recursive: true });
  copyFileSync(join(ROOT, GATE), join(dir, GATE));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
  if (attestation !== undefined) {
    writeFileSync(join(dir, 'scripts/data/lockfile-resolvability.json'), JSON.stringify(attestation));
  }
  return dir;
}

/**
 * OPS-SUPPLY-CHAIN-RESOLVABILITY-W1 · R4.
 *
 * "Can this repo still be built from scratch?" was never an asserted property. `npm ci` installs
 * from pinned `resolved` URLs and keeps working while a tarball is served, so a version can be
 * unpublished from the registry LISTING and only a fresh `npm install` notices — at the moment
 * you need the rebuild. These tests keep the gate that asserts it honest.
 *
 * The gate's own `--self-test` carries the exhaustive logic coverage. This file pins the
 * behaviours that must not be allowed to change quietly: the verdict tokens, the exit-code
 * mapping, and above all that an unverifiable registry can never become a PASS.
 */
describe('lockfile resolvability gate', () => {
  it('self-test passes, and covers both directions', () => {
    const r = run(['--self-test']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('LOCKFILE_RESOLVABLE_VERDICT=PASS');
    expect(r.out).toContain('must-fire');
  });

  it('offline mode passes on the current tree', () => {
    const r = run(['--offline']);
    expect(r.out).toContain('LOCKFILE_RESOLVABLE_VERDICT=PASS');
    expect(r.code).toBe(0);
  });

  it('the committed attestation actually covers the committed lockfile', () => {
    // The invariant, not a count: pin totals move on every dependency change, and a hardcoded
    // number turns a correct bump into a red test — the friction that gets a gate weakened.
    const lock = parseLock(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
    expect(lock.ok).toBe(true);
    const att = loadAttestation(readFileSync(join(ROOT, 'scripts/data/lockfile-resolvability.json'), 'utf8'));
    expect(att.ok).toBe(true);
    expect(unattested(pinSet(lock.entries), att.verified)).toEqual([]);
  });

  it('names are derived from the resolved URL, so an aliased dependency is asked about correctly', () => {
    expect(nameFromResolved(`${REGISTRY}@scope/pkg/-/pkg-0.4.0.tgz`)).toBe('@scope/pkg');
    expect(nameFromResolved('https://npm.example.com/x/-/x-1.0.0.tgz')).toBeNull();
    expect(nameFromPath('node_modules/a/node_modules/@s/b')).toBe('@s/b');
  });

  it('flags every structural defect that breaks a reproducible npm ci', () => {
    const p = parseLock(
      JSON.stringify({
        packages: {
          'node_modules/foreign': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/y.git#abc', integrity: 'sha512-x' },
          'node_modules/nores': { version: '1.0.0' },
          'node_modules/nohash': { version: '1.0.0', resolved: `${REGISTRY}nohash/-/nohash-1.0.0.tgz` },
        },
      }),
    );
    const s = structuralFindings(p.entries);
    expect(s.foreignRegistry).toHaveLength(1);
    expect(s.missingResolved).toHaveLength(1);
    expect(s.missingIntegrity).toHaveLength(1);
  });

  it('a workspace link is not a registry pin and must not be swept', () => {
    const p = parseLock(JSON.stringify({ packages: { '': {}, 'node_modules/w': { link: true, resolved: 'packages/w' } } }));
    expect(p.entries).toHaveLength(0);
  });

  describe('the verdict token is the contract', () => {
    it('maps PASS/FAIL/INDETERMINATE to 0/1/3 — INDETERMINATE must BLOCK, never launder into a pass', () => {
      expect(exitCodeFor('PASS')).toBe(0);
      expect(exitCodeFor('FAIL')).toBe(1);
      expect(exitCodeFor('INDETERMINATE')).toBe(3);
      expect(exitCodeFor('garbage')).not.toBe(0);
    });

    it('an unreachable registry is INDETERMINATE, never a PASS', async () => {
      const down = await sweep(['a'], async () => ({ ok: false, reason: 'simulated outage' }), 1);
      expect(down.listedByName.get('a')).toBeNull();
      const ev = evaluateResolvability(['a@1.0.0'], down.listedByName);
      expect(ev.indeterminate).toHaveLength(1);
      expect(ev.ok).toHaveLength(0);
    });

    it('a 404 packument is an ANSWER — its pins are unresolvable, not unknown', () => {
      const ev = evaluateResolvability(['vanished@1.0.0'], new Map([['vanished', new Set<string>()]]));
      expect(ev.unresolvable).toHaveLength(1);
      expect(ev.indeterminate).toHaveLength(0);
    });

    it('a delisted version is caught while its siblings pass', () => {
      const listed = new Map([['p', new Set(['0.25.0', '0.28.0'])]]);
      const ev = evaluateResolvability(['p@0.16.0', 'p@0.28.0'], listed);
      expect(ev.unresolvable.map((u: { pin: string }) => u.pin)).toEqual(['p@0.16.0']);
      expect(ev.ok).toHaveLength(1);
    });
  });

  describe('the attestation is provenance, and refuses to vouch for what it has not seen', () => {
    it('blocks a pin that has never been live-verified, and names it', () => {
      const dir = fakeRoot(
        { lockfileVersion: 3, packages: { '': {}, 'node_modules/js-yaml': entry('js-yaml', '4.3.1'), 'node_modules/left-pad': entry('left-pad', '1.3.0') } },
        { registry: REGISTRY, verified_pins: ['js-yaml@4.3.1'] },
      );
      try {
        const r = run(['--offline'], dir);
        expect(r.out).toContain('LOCKFILE_RESOLVABLE_VERDICT=FAIL');
        expect(r.code).toBe(1);
        expect(r.out).toContain('left-pad@1.3.0');
        expect(r.out).toContain('--attest');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('tolerates an attestation carrying a since-removed pin, so concurrent worktrees merge cleanly', () => {
      const att = loadAttestation(JSON.stringify({ registry: REGISTRY, verified_pins: ['a@1.0.0', 'removed@9.9.9'] }));
      expect(unattested(['a@1.0.0'], att.verified)).toEqual([]);
    });

    it('a missing attestation is INDETERMINATE, not a pass', () => {
      const dir = fakeRoot({ lockfileVersion: 3, packages: { '': {}, 'node_modules/js-yaml': entry('js-yaml', '4.3.1') } });
      try {
        const r = run(['--offline'], dir);
        expect(r.out).toContain('LOCKFILE_RESOLVABLE_VERDICT=INDETERMINATE');
        expect(r.code).toBe(3);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('refuses an EMPTY, unparseable, or foreign-registry attestation', () => {
      expect(loadAttestation(JSON.stringify({ verified_pins: [] })).ok).toBe(false);
      expect(loadAttestation('{not json').ok).toBe(false);
      expect(loadAttestation(JSON.stringify({ registry: 'https://npm.example.com/', verified_pins: ['a@1'] })).ok).toBe(false);
    });
  });

  it('an unparseable lockfile is INDETERMINATE — it was handed to us, not built by us', () => {
    expect(parseLock('{not json').ok).toBe(false);
    expect(parseLock(JSON.stringify({ name: 'x' })).ok).toBe(false);
  });
});
