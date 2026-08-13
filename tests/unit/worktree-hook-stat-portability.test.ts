/**
 * OPS-NUMERIC-PROBE-VALIDATION-W1 Part A — the last enumerated `stat`-into-arithmetic site.
 *
 * `OPS-MAP-GATE-STAT-PORTABILITY-W1` retired the class "unvalidated command output reaching an
 * arithmetic context" and enumerated the estate. Four of five sites were safe. The fifth was
 * `scripts/worktree-create-hook.sh`, whose fallback was `echo 0` rather than a second `stat` —
 * same class, different shape, and left behind. Leaving one known instance of a class you just
 * spent a wave retiring is how the class comes back.
 *
 * ── WHAT THE PRE-FIX SHAPE ACTUALLY DID, MEASURED END-TO-END (2026-08-13) ───────────────────
 * Measured by restoring the `||` chain on a scratch copy and driving the REAL hook with a
 * GNU-shaped `stat` stub on PATH and a deliberately-failing `git fetch`:
 *
 *     stderr : broken-hook.sh: line 250: File: unbound variable
 *     exit   : 0
 *     stdout : 0 bytes
 *
 * That is NOT the non-zero abort the dispatching spec predicted, and the difference matters.
 * `exit 0` means Claude Code does NOT abort creation; 0 bytes of stdout means there is no path
 * to parse. The hook's own header (D3) names that outcome the SILENT HANG. So the pre-fix
 * failure mode is strictly worse than an abort, because an abort at least surfaces.
 *
 * (An isolated `bash -c` harness running the same expression exits 127 instead. The harness and
 * the subject disagree on the CODE — which is exactly why these tests drive the real script
 * rather than a re-typed fragment of it. `check-system-map-stripping.test.ts`'s docblock records
 * the gate's own variant as "exit 1, EMPTY stdout"; the empty stdout is the invariant, the code
 * is not.)
 *
 * ── WHY THE HOOK DEGRADES WHERE THE GATE BLOCKS ────────────────────────────────────────────
 * `check_system_map.sh` REFUSES on an unreadable mtime because it is a gate, and a gate that
 * cannot determine freshness must never pass. This is a human-readable age string in a hook:
 * refusing to create a worktree because a FETCH_HEAD mtime was unreadable would be a far worse
 * outcome than a vague message. Same probe, opposite failure posture, deliberately.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');
const HOOK = path.join(SCRIPTS, 'worktree-create-hook.sh');
const GATE = path.join(SCRIPTS, 'check_system_map.sh');

/** A `stat` stub shaped like GNU coreutils: `-c` is the format flag, `-f` is --file-system. */
const GNU_STUB = (epoch: number) => `#!/bin/sh
case "$1" in
  -c) shift; [ "$1" = "%Y" ] && { echo ${epoch}; exit 0; }; exit 1 ;;
  -f) shift
      echo "stat: cannot read file system information for '$1': No such file or directory" >&2
      shift
      echo "  File: \\"$1\\""
      echo "    ID: 203215e1c1b5430e Namelen: 255     Type: ext2/ext3"
      echo "Block size: 4096       Fundamental block size: 4096"
      exit 1 ;;
esac
exit 1
`;

/** A `stat` stub shaped like BSD/macOS: `-c` is invalid, `-f` takes a format. */
const BSD_STUB = (epoch: number) => `#!/bin/sh
case "$1" in
  -c) exit 1 ;;
  -f) shift; [ "$1" = "%m" ] && { echo ${epoch}; exit 0; }; exit 1 ;;
esac
exit 1
`;

/** Both forms "succeed" while printing garbage — the shape that must degrade, not assume. */
const GARBAGE_STUB = `#!/bin/sh
echo "  File: nonsense"
exit 0
`;

interface Run { code: number | null; stdout: string; log: string }

/**
 * Drive the REAL hook to the fetch-failure branch, with `stat` stubbed on PATH.
 *
 * `origin` deliberately points at a path that does not exist, so `git fetch` fails FAST and
 * offline — the branch carrying the age probe is otherwise unreachable, and a test that never
 * reaches its subject is the vacuity this estate keeps retiring.
 */
function runHook(stub: string, hookPath = HOOK): Run {
  const dir = mkdtempSync(path.join(tmpdir(), 'wt-stat-'));
  try {
    const repo = path.join(dir, 'repo');
    const bin = path.join(dir, 'bin');
    const art = path.join(dir, 'art');
    for (const d of [repo, bin, art, path.join(dir, 'root')]) mkdirSync(d, { recursive: true });

    const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    git('init', '-q', '.');
    git('remote', 'add', 'origin', path.join(dir, 'no-such-remote.git'));
    writeFileSync(path.join(repo, '.git', 'FETCH_HEAD'), 'deadbeef\t\tbranch main of nowhere\n');

    writeFileSync(path.join(bin, 'stat'), stub);
    chmodSync(path.join(bin, 'stat'), 0o755);

    const sot = path.join(dir, 'sot.json');
    writeFileSync(sot, JSON.stringify({
      worktree_roots: { worktree_root: path.join(dir, 'root'), repo_root: { path: dir } },
    }));

    const r = spawnSync('bash', [hookPath], {
      input: JSON.stringify({ cwd: repo, name: 'statprobe' }),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ALGOVAULT_HOOK_ARTIFACTS: art,
        ALGOVAULT_WORKTREE_SOT: sot,
      },
    });
    let log = '';
    try { log = readFileSync(path.join(art, 'hook.log'), 'utf8'); } catch { /* absent = empty */ }
    return { code: r.status, stdout: r.stdout ?? '', log };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ageOf = (log: string) => /age: ([^)]*)\)/.exec(log)?.[1];

describe('worktree-create-hook: the FETCH_HEAD age probe is flavour-validated', () => {
  // The epoch is fixed so the assertion is on a COMPUTED age, not on "some number appeared".
  // A stub returning a live mtime would pass even if the arithmetic were dropped entirely.
  const EPOCH = 1786500000;

  it('GNU flavour (the platform that BREAKS the old form) produces a correct age', () => {
    const r = runHook(GNU_STUB(EPOCH));
    const age = ageOf(r.log);
    expect(age, 'the fetch-failure branch must have been reached').toBeDefined();
    expect(age).toMatch(/^\d+ min$/);
    // Same clock the hook used, so this cannot drift: floor((now - EPOCH)/60), +-1 for the second
    // that may tick between the hook's `date +%s` and this line.
    const expected = Math.floor((Date.now() / 1000 - EPOCH) / 60);
    expect(Math.abs(Number(age!.replace(' min', '')) - expected)).toBeLessThanOrEqual(1);
    expect(r.code, 'the hook must still succeed').toBe(0);
    expect(r.stdout.trim().length, 'stdout must carry a path').toBeGreaterThan(0);
  });

  it('BSD flavour produces the SAME age — the other flavour is simulated, not assumed', () => {
    // Without a stub this case would be a silent no-op on Linux CI and the GNU case a silent
    // no-op on the macOS workstation. Simulating both means neither platform skips its half.
    const r = runHook(BSD_STUB(EPOCH));
    const age = ageOf(r.log);
    expect(age).toMatch(/^\d+ min$/);
    const expected = Math.floor((Date.now() / 1000 - EPOCH) / 60);
    expect(Math.abs(Number(age!.replace(' min', '')) - expected)).toBeLessThanOrEqual(1);
    expect(r.code).toBe(0);
  });

  it('a NON-INTEGER probe yields `unknown` and the hook COMPLETES — degrade, never refuse', () => {
    const r = runHook(GARBAGE_STUB);
    expect(ageOf(r.log), 'an undeterminable mtime must not invent a number').toBe('unknown');
    expect(r.code, 'a hook is not a gate: it must not refuse to create a worktree').toBe(0);
    expect(r.stdout.trim().length, 'and it must still emit a path — empty stdout IS the silent hang')
      .toBeGreaterThan(0);
    // Falling through to epoch 0 would render a ~30-million-minute age: confidently wrong beats
    // nothing, which is the failure mode the gate's sibling assertion also pins.
    expect(r.log).not.toMatch(/age: \d{7,} min/);
  });
});

describe('both sites use the validated-flavour idiom — enforcement without runtime coupling', () => {
  // A shared runtime lib is forbidden here (scripts/lib/hook-block.sh design decision #1: a
  // worktree predating the lib fails to source it and breaks every operation there). So the
  // copies are pinned by a TEST instead. This is the 2nd instance; at a 3rd, the extraction
  // target is this test growing a row — never a sourced dependency.
  const SITES: Array<[string, string]> = [
    ['check_system_map.sh', GATE],
    ['worktree-create-hook.sh', HOOK],
  ];

  it.each(SITES)('%s detects the flavour ONCE, explicitly', (_name, file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/if stat -c %Y \. >\/dev\/null 2>&1; then STAT_FLAVOUR=gnu; else STAT_FLAVOUR=bsd; fi/);
  });

  it.each(SITES)('%s chains no stat with a fallback — the chain IS the hazard', (_name, file) => {
    const src = readFileSync(file, 'utf8');
    // Two shapes, because the two sites failed differently: the gate chained a second `stat`,
    // this hook chained `echo 0`. Both presume a failing stat prints nothing; GNU disproves it.
    expect(src, 'a chained stat probe re-introduces the poisoning')
      .not.toMatch(/stat -[cf] [^\n]*\|\|[^\n]*stat -[fc] /);
    expect(src, 'an `echo`/literal fallback poisons the substitution exactly the same way')
      .not.toMatch(/stat -[cf] [^\n]*\|\|[^\n]*echo /);
  });

  it.each(SITES)('%s validates the probe result before any arithmetic', (_name, file) => {
    const src = readFileSync(file, 'utf8');
    expect(src, "the shipped guard shape: case \"$X\" in ''|*[!0-9]*)")
      .toMatch(/''\|\*\[!0-9\]\*\)/);
  });
});
