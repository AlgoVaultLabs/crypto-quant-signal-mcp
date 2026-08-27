/**
 * OPS-PUBLISH-LANE-PRE-VERIFY-W1 R3 — the tag-vs-HEAD divergence question, answered by a command.
 *
 * NPM-PUBLISH-v1.28.2-W1 answered it by hand, mid-release, with a bespoke `npm pack --dry-run`
 * analysis at the last possible moment. The answer was 24 `dist/scripts/` entries — build outputs
 * of six operator scripts, none on the MCP server path — so the divergence was declarable and the
 * release proceeded. What this pins is that the DISTINCTION which made that safe is computed
 * rather than re-reasoned every release, and that the real case still resolves the same way.
 *
 * It deliberately does NOT re-implement the gate's own logic: the gate carries a 22-assertion
 * two-way `--self-test` covering the tsc emit contract, the server-path predicate, all three
 * verdicts and the token→exit MAPPING. This file runs that self-test (so it cannot rot unnoticed
 * in the normal suite), asserts the historical case end-to-end against real git objects, and
 * asserts the wiring — the three things a self-test structurally cannot see about itself.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const GATE = join(ROOT, 'scripts', 'check-shipped-set-divergence.mjs');

/** Run the gate, tolerating a non-zero exit — the verdict is the TOKEN, never the code. */
function runGate(args: string[]): { out: string; code: number } {
  const r = spawnSync('node', [GATE, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? 1 };
}

const token = (out: string) => /SHIPPED_SET_DIVERGENCE_VERDICT=([A-Z_]+)/.exec(out)?.[1] ?? null;

describe('the gate proves itself', () => {
  // Spawns a subprocess, so the budget sits in the OPTIONS argument rather than inheriting the
  // 5,000ms default.
  it('--self-test passes and asserts all three verdicts plus the exit MAPPING', { timeout: 30_000 }, () => {
    const { out, code } = runGate(['--self-test']);
    expect(code).toBe(0);
    expect(out).toMatch(/self-test: (\d+) passed, 0 failed/);
    const passed = Number(/self-test: (\d+) passed/.exec(out)?.[1] ?? 0);
    expect(passed, 'the self-test asserted nothing — a vacuous run must never read as a pass').toBeGreaterThan(0);
    // Asserting tokens alone once left a gate green after its INDETERMINATE mapping was re-coded
    // to 0. The mapping is part of the contract, so its assertion is named here too.
    expect(out).toContain('IDENTICAL and DIVERGENT_NON_SERVER SHARE exit 0');
    expect(out).toContain('DIVERGENT_SERVER_PATH exits 1');
    expect(out).toContain('INDETERMINATE exits 3');
  });
});

describe('the real v1.28.2 case, against real git objects', () => {
  const HAVE_REFS = (() => {
    const r = spawnSync('git', ['rev-parse', '--quiet', '--verify', '44dd28d^{commit}'], { cwd: ROOT });
    const s = spawnSync('git', ['rev-parse', '--quiet', '--verify', '756f8c6^{commit}'], { cwd: ROOT });
    return r.status === 0 && s.status === 0;
  })();

  // A shallow clone genuinely cannot see these objects. Skipping is honest there; silently
  // passing would not be, so the reason is stated rather than the case quietly disappearing.
  it.skipIf(!HAVE_REFS)(
    '44dd28d vs 756f8c6 is DIVERGENT_NON_SERVER, naming 24 dist/scripts entries',
    { timeout: 30_000 },
    () => {
      const { out, code } = runGate(['--from', '44dd28d', '--to', '756f8c6']);
      expect(token(out)).toBe('DIVERGENT_NON_SERVER');
      expect(code, 'divergence outside the server path is a declarable FACT, not a failure').toBe(0);

      const distEntries = [...out.matchAll(/^\s+[AMD] (dist\/\S+)$/gm)].map((m) => m[1]);
      expect(distEntries.length, 'the historical case is exactly 24 shipped entries').toBe(24);
      expect(distEntries.every((p) => p.startsWith('dist/scripts/'))).toBe(true);
      expect(new Set(distEntries).size, 'no entry may be listed twice').toBe(24);

      // Mapped back to the six sources that produce them — the half a raw tarball diff cannot give.
      for (const src of [
        'calibration-audit', 'directional-labeler', 'dwr-baseline-report',
        'dwr-baseline-snapshot', 'dwr-baseline', 'edge-stats',
      ]) {
        expect(out, `dist entries must name their src/ producer (${src})`).toContain(`src/scripts/${src}.ts`);
      }
      expect(out).toMatch(/MCP SERVER PATH[^\n]*: 0/);
    },
  );

  it.skipIf(!HAVE_REFS)('a ref compared against itself is IDENTICAL', { timeout: 30_000 }, () => {
    const { out, code } = runGate(['--from', '44dd28d', '--to', '44dd28d']);
    expect(token(out)).toBe('IDENTICAL');
    expect(code).toBe(0);
  });

  it('an unresolvable ref is INDETERMINATE, never a silent pass', { timeout: 30_000 }, () => {
    // Input we were HANDED and could not parse is always INDETERMINATE. The gate must not die
    // without a token — process death with no verdict is the one outcome the token law forbids.
    const { out, code } = runGate(['--from', 'no-such-ref-deadbeef', '--to', 'HEAD']);
    expect(token(out)).toBe('INDETERMINATE');
    expect(code).toBe(3);
  });
});

describe('wiring', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  it('is INVOKED from package.json, not merely mentioned', () => {
    // check-canaries-wired.mjs discovers `scripts/check-*` from git ls-files and fails the build
    // if nothing invokes them. A comment naming the file is not an invocation.
    expect(pkg.scripts['release:divergence']).toContain('scripts/check-shipped-set-divergence.mjs');
    expect(pkg.scripts['release:divergence:selftest']).toContain('--self-test');
  });

  it('is NOT wired into prepublishOnly or any schedule', () => {
    // main legitimately runs ahead of the last tag between releases, so a scheduled divergence
    // alarm would fire on almost every ordinary day — that is how a guard earns the reputation
    // that gets it ignored. And it must never gate a publish: divergence is a question a release
    // ASKS, not a precondition of one.
    expect(pkg.scripts.prepublishOnly).not.toContain('check-shipped-set-divergence');
    const { out } = { out: readFileSync(join(ROOT, '.github/workflows/publish-lane-preverify.yml'), 'utf8') };
    expect(out).not.toContain('check-shipped-set-divergence');
  });

  it('check-canaries-wired sees it (the gate that owns this question)', { timeout: 120_000 }, () => {
    const out = execFileSync('node', [join(ROOT, 'scripts/check-canaries-wired.mjs')], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    expect(out).toContain('scripts/check-shipped-set-divergence.mjs');
  });
});
