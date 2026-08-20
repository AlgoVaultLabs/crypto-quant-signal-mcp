/**
 * OPS-AOE-PREPUSH-RESTORE-W1 — scripts/check-push-safety.sh.
 *
 * The guard runs in the SHARED pre-push hook, which governs every checkout (75 measured
 * 2026-08-02), so a defect here is a fleet-wide outage. Two properties matter more than the
 * refusals themselves and are asserted first:
 *
 *   · an ordinary fast-forward to a protected ref is NOT blocked — this repo's LAW is
 *     auto-commit + auto-push, and merges land on the default branch as fast-forwards, so
 *     refusing them would halt every wave;
 *   · EMPTY stdin is a PASS — measured, `git push` with nothing to push still runs the hook,
 *     so blocking there would refuse a routine no-op push.
 *
 * Protected refs are proven CONFIG-DRIVEN behaviourally (a fixture ref the script never
 * mentions), not by grepping the script for the absence of a string — a word-grep is fooled by
 * the remediation prose, which must name the branch to be useful.
 */
import { describe, it, expect, vi } from 'vitest';

/**
 * OPS-PARALLEL-SESSION-CAPACITY-W2 / Ch2 — a budget that survives concurrency.
 *
 * Ten tests; `fixture()` spawns 8 git processes and is used by 8 of them, plus the bash guard
 * itself (which runs more git internally). Worst case ~10 processes against a 5 s budget.
 *
 * Measured: under 3-5 concurrent gates (89 checkouts share one pre-push hook) every failure
 * in this class was a TIMEOUT, never an assertion — durations of 5.4-19.9 s against 5 s
 * budgets, including a pure-JSON-read test that took 7.15 s. The assertions are right; the
 * budgets were stale. File-level, per 136954a: the per-`it` third argument silently no-ops
 * when placed after the closing paren, and every test here pays the same cost anyway.
 */
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const GUARD = resolve(__dirname, '..', '..', 'scripts', 'check-push-safety.sh');
const CONFIG = resolve(__dirname, '..', '..', 'ops', 'push-safety-config.json');
const ZERO = '0'.repeat(40);

/** A real repo with a real fork, so ancestry is genuine rather than stubbed. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'push-safety-'));
  const git = (...a: string[]) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(dir, 'f'), 'one\n');
  git('add', 'f');
  git('commit', '-qm', 'one');
  const base = git('rev-parse', 'HEAD').stdout.trim();
  writeFileSync(join(dir, 'f'), 'two\n');
  git('commit', '-qam', 'two');
  const tip = git('rev-parse', 'HEAD').stdout.trim();
  return { dir, base, tip, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeConfig(
  dir: string,
  refs: Array<Record<string, string>>,
  neverPush: Array<Record<string, string>> = [
    { pattern: 'refs/algovault/*', reason: 'fixture: local-only WIP snapshots' },
  ],
) {
  const p = join(dir, 'cfg.json');
  // `never_push_refs` is MANDATORY and defaulted here rather than made optional in the guard.
  // Optional would mean a config that loses the key silently disables the exfiltration check —
  // the guard would still print PASS having stopped checking. Same rule the sibling
  // `protected_refs` already follows: a declaration we author, absent, is INDETERMINATE.
  writeFileSync(p, JSON.stringify({ protected_refs: refs, never_push_refs: neverPush }));
  return p;
}

/** Feed stdin exactly as git does — newline-terminated lines, or genuinely nothing. */
function run(dir: string, cfg: string, stdin: string) {
  const r = spawnSync('bash', [GUARD, '--_evaluate', '--_repo', dir], {
    input: stdin ? `${stdin}\n` : '',
    encoding: 'utf8',
    env: { ...process.env, ALGOVAULT_PUSH_SAFETY_CONFIG: cfg, ALGOVAULT_PUSH_SAFETY: 'block' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const tokens = [...out.matchAll(/PUSH_SAFETY_VERDICT=([A-Z]+)/g)].map((m) => m[1]);
  return { code: r.status, out, tokens, token: tokens[tokens.length - 1] };
}

describe('push-safety guard (OPS-AOE-PREPUSH-RESTORE-W1)', () => {
  it('--self-test passes, is vacuity-guarded, and emits exactly one verdict token', { timeout: 60_000 }, () => {
    const r = spawnSync('bash', [GUARD, '--self-test'], { encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out, out).toMatch(/PUSH_SAFETY_VERDICT=PASS/);
    expect((out.match(/PUSH_SAFETY_VERDICT=/g) ?? []).length).toBe(1);
    expect(r.status).toBe(0);
    // Non-vacuous by construction: the summary must report the case count it actually ran.
    expect(out).toMatch(/self-test: \d+\/\d+ cases/);
  });

  it('does NOT block an ordinary fast-forward to a protected ref (the repo ships this way)', () => {
    const f = fixture();
    try {
      const cfg = writeConfig(f.dir, [{ ref: 'refs/heads/main', reason: 'fixture' }]);
      const r = run(f.dir, cfg, `refs/heads/main ${f.tip} refs/heads/main ${f.base}`);
      expect(r.token, r.out).toBe('PASS');
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/fast-forward/);
    } finally { f.cleanup(); }
  });

  it('empty stdin is a reported PASS, never a block and never silent', () => {
    const f = fixture();
    try {
      const cfg = writeConfig(f.dir, [{ ref: 'refs/heads/main', reason: 'fixture' }]);
      const r = run(f.dir, cfg, '');
      expect(r.token, r.out).toBe('PASS');
      expect(r.code).toBe(0);
      // "never silent" is the actual requirement — assert the positive line, not just the token.
      expect(r.out).toMatch(/no ref updates on stdin/);
    } finally { f.cleanup(); }
  });

  it('refuses a non-fast-forward to a protected ref, printing both SHAs and the revert remedy', () => {
    const f = fixture();
    try {
      const cfg = writeConfig(f.dir, [{ ref: 'refs/heads/main', reason: 'fixture' }]);
      const r = run(f.dir, cfg, `refs/heads/main ${f.base} refs/heads/main ${f.tip}`);
      expect(r.token, r.out).toBe('FAIL');
      expect(r.code).toBe(1);
      expect(r.out).toContain(f.base);
      expect(r.out).toContain(f.tip);
      expect(r.out).toMatch(/revert/i);
      // `reset --hard` may only ever appear as the thing NOT to do. Asserted per LINE, because
      // the remediation legitimately names it ("REVERT-THEN-REAPPLY, never reset --hard") and a
      // whole-output negative match cannot tell prescription from prohibition.
      for (const line of r.out.split('\n').filter((l) => l.includes('reset --hard'))) {
        expect(line, `"reset --hard" must be negated on its own line: ${line}`).toMatch(/never/i);
      }
    } finally { f.cleanup(); }
  });

  it('refuses deletion of a protected ref', () => {
    const f = fixture();
    try {
      const cfg = writeConfig(f.dir, [{ ref: 'refs/heads/main', reason: 'fixture' }]);
      const r = run(f.dir, cfg, `(delete) ${ZERO} refs/heads/main ${f.tip}`);
      expect(r.token, r.out).toBe('FAIL');
      expect(r.code).toBe(1);
    } finally { f.cleanup(); }
  });

  it('allows a force-push to a NON-protected ref, and the first push of a new branch', () => {
    const f = fixture();
    try {
      const cfg = writeConfig(f.dir, [{ ref: 'refs/heads/main', reason: 'fixture' }]);
      const force = run(f.dir, cfg, `refs/heads/feat ${f.base} refs/heads/feat ${f.tip}`);
      expect(force.token, force.out).toBe('PASS');
      const fresh = run(f.dir, cfg, `refs/heads/brand-new ${f.tip} refs/heads/brand-new ${ZERO}`);
      expect(fresh.token, fresh.out).toBe('PASS');
    } finally { f.cleanup(); }
  });

  it('is INDETERMINATE (blocking) on unparseable stdin and on a malformed sha', () => {
    const f = fixture();
    try {
      const cfg = writeConfig(f.dir, [{ ref: 'refs/heads/main', reason: 'fixture' }]);
      const junk = run(f.dir, cfg, 'this is not a ref line');
      expect(junk.token, junk.out).toBe('INDETERMINATE');
      expect(junk.code).toBe(3);
      const badSha = run(f.dir, cfg, `refs/heads/main deadbeef refs/heads/main ${f.tip}`);
      expect(badSha.token, badSha.out).toBe('INDETERMINATE');
      expect(badSha.code).toBe(3);
    } finally { f.cleanup(); }
  });

  // AC5, behaviourally. The fixture ref appears nowhere in the script, so acting on it can only
  // come from the config. A word-grep for the absence of "main" would be fooled by the
  // remediation prose, which must name the branch to be useful.
  it('protection is CONFIG-DRIVEN: a ref acts only while it is declared', () => {
    const f = fixture();
    try {
      const line = `refs/heads/zzz-fixture ${f.base} refs/heads/zzz-fixture ${f.tip}`;
      const declared = run(f.dir, writeConfig(f.dir, [{ ref: 'refs/heads/zzz-fixture', reason: 'fixture' }]), line);
      expect(declared.token, declared.out).toBe('FAIL');

      const notDeclared = run(f.dir, writeConfig(f.dir, [{ ref: 'refs/heads/other', reason: 'fixture' }]), line);
      expect(notDeclared.token, notDeclared.out).toBe('PASS');
      expect(notDeclared.out).toMatch(/not a protected ref/);

      const guardSource = readFileSync(GUARD, 'utf8');
      expect(guardSource).not.toContain('zzz-fixture');
    } finally { f.cleanup(); }
  });

  it('refuses to run on a config row with no reason, or an empty protected set', () => {
    const f = fixture();
    try {
      const line = `refs/heads/main ${f.base} refs/heads/main ${f.tip}`;
      const noReason = run(f.dir, writeConfig(f.dir, [{ ref: 'refs/heads/main' } as never]), line);
      expect(noReason.token, noReason.out).toBe('INDETERMINATE');
      // An empty declaration is CONSTRUCTED vacuity — we wrote it, so empty means we built
      // nothing. Contrast with empty stdin, which git constructs and which is a fact.
      const empty = run(f.dir, writeConfig(f.dir, []), line);
      expect(empty.token, empty.out).toBe('INDETERMINATE');
    } finally { f.cleanup(); }
  });

  it('the committed config declares at least one protected ref, each with a reason', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(Array.isArray(cfg.protected_refs)).toBe(true);
    expect(cfg.protected_refs.length).toBeGreaterThan(0);
    for (const row of cfg.protected_refs) {
      expect(typeof row.ref).toBe('string');
      expect(row.ref.length).toBeGreaterThan(0);
      expect((row.reason ?? '').trim().length).toBeGreaterThan(0);
    }
  });
});

describe('push-safety — local-only namespaces must not leave the machine', () => {
  // OPS-PUSH-SAFETY-WIP-NAMESPACE-W1. `refs/algovault/wip/*` holds auto-preserved snapshots of
  // UNCOMMITTED work, and this repo is PUBLIC. Measured 2026-08-20: `git push --mirror` put
  // those refs in its push plan, and the only thing that stopped them going out was that local
  // main happened to be non-fast-forward — the history check refusing for an unrelated reason.
  // A rented safety property, replaced here by a mechanism.
  const PROT = [{ ref: 'refs/heads/main', reason: 'fixture' }];

  it('REFUSES the mirror shape, even though it is a clean fast-forward', () => {
    const f = fixture();
    try {
      const r = run(f.dir, writeConfig(f.dir, PROT),
        `refs/algovault/wip/r/s/t ${f.tip} refs/algovault/wip/r/s/t ${ZERO}`);
      expect(r.token, r.out).toBe('FAIL');
      // Must not read as a history-destruction refusal: it is a different question, and the
      // operator needs to know the push was clean and the CONTENT is what is disallowed.
      expect(r.out).toContain('local-only namespace');
    } finally { f.cleanup(); }
  });

  it('REFUSES a crafted refspec that renames the namespace on the way out', () => {
    const f = fixture();
    try {
      const r = run(f.dir, writeConfig(f.dir, PROT),
        `refs/algovault/wip/r/s/t ${f.tip} refs/heads/leaked ${ZERO}`);
      expect(r.token, r.out).toBe('FAIL');
    } finally { f.cleanup(); }
  });

  it('MUST NOT FIRE on a branch merely named algovault-* — a prefix, not a substring', () => {
    const f = fixture();
    try {
      const r = run(f.dir, writeConfig(f.dir, PROT),
        `refs/heads/algovault-thing ${f.tip} refs/heads/algovault-thing ${ZERO}`);
      expect(r.token, r.out).toBe('PASS');
    } finally { f.cleanup(); }
  });

  it('an EMPTY never_push_refs is INDETERMINATE — a guard that stopped checking is not a pass', () => {
    const f = fixture();
    try {
      const r = run(f.dir, writeConfig(f.dir, PROT, []),
        `refs/heads/main ${f.tip} refs/heads/main ${f.base}`);
      expect(r.token, r.out).toBe('INDETERMINATE');
    } finally { f.cleanup(); }
  });

  it('a row missing its mandatory reason is INDETERMINATE', () => {
    const f = fixture();
    try {
      const r = run(f.dir, writeConfig(f.dir, PROT, [{ pattern: 'refs/algovault/*' }]),
        `refs/heads/main ${f.tip} refs/heads/main ${f.base}`);
      expect(r.token, r.out).toBe('INDETERMINATE');
    } finally { f.cleanup(); }
  });

  it('an EARLIER refusal must not hide a LATER one — every ref update is judged', () => {
    // The regression that only a real `git push --mirror` could surface. A first version
    // aborted the scan whenever the shared `refused` counter was non-zero, so a non-fast-
    // forward on main stopped the loop before it reached the namespace refs and the guard
    // silently under-reported. Every single-ref case stayed green throughout.
    const f = fixture();
    try {
      const r = run(f.dir, writeConfig(f.dir, PROT),
        `refs/heads/main ${f.base} refs/heads/main ${f.tip}\n`
        + `refs/algovault/wip/r/s/t ${f.tip} refs/algovault/wip/r/s/t ${ZERO}`);
      expect(r.token, r.out).toBe('FAIL');
      expect(r.out, 'the non-fast-forward must be reported').toContain('NON-FAST-FORWARD');
      expect(r.out, 'AND the namespace leak must be reported').toContain('local-only namespace');
      expect(r.out, 'both refusals counted').toMatch(/2 of 2 ref update\(s\) refused/);
    } finally { f.cleanup(); }
  });

  it('the COMMITTED config declares the namespace, with a reason on the row', () => {
    const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
    expect(Array.isArray(cfg.never_push_refs)).toBe(true);
    expect(cfg.never_push_refs.length).toBeGreaterThan(0);
    for (const row of cfg.never_push_refs) {
      expect(typeof row.pattern).toBe('string');
      expect(row.reason?.trim().length, `row ${row.pattern} needs a reason`).toBeGreaterThan(0);
    }
    expect(cfg.never_push_refs.some((r: { pattern: string }) => r.pattern === 'refs/algovault/*')).toBe(true);
  });
});
