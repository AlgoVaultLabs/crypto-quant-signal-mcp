/**
 * OPS-MCP-CHATID-SCRUB-W1 — the chat-id literal gate, wired into the suite and pinned at the hook.
 *
 * `scripts/check-chat-id-literals.mjs` is the real gate (verdict token, its own two-way self-test).
 * These tests make its TREE mode run on every `npm test` — so the pre-push test gate and CI's
 * vitest step both fail on a chat id in an identity context — and they drive the real CLI on
 * throwaway repos, which the self-test's direct function calls cannot reach.
 *
 * NO FIXTURE ID IN THIS FILE IS A LITERAL. Every id-shaped value is built at runtime, so the gate
 * this file enforces never needs an exemption for the file that enforces it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GATE = 'scripts/check-chat-id-literals.mjs';
const INSTALLER = 'scripts/install_chat_id_literals_hook.sh';
const TOKEN = 'CHAT_ID_LITERALS_VERDICT=';
const FAKE_ID = String(6 * 10 ** 9 + 8_421); // id-shaped at runtime only
const MASKED = '…' + FAKE_ID.slice(-4);

// Inside a git hook these point at the REAL repository; a fixture commit must never land there.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => ![
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_QUARANTINE_PATH',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(k)));
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

function runGate(gatePath: string, args: string[], cwd = ROOT) {
  try {
    const out = execFileSync('node', [gatePath, ...args], { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status as number, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}
function git(repo: string, ...args: string[]) {
  return execFileSync('git', [...IDENT, ...args], { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
}
/** A throwaway repo holding a COPY of the gate at the same relative path, so the gate's own
 *  `ROOT = <script>/..` resolves to the fixture: the real CLI, argv to exit code, end to end. */
function fixtureRepo(): { repo: string; gate: string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'chat-id-cli-'));
  const repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  const gate = join(repo, GATE);
  copyFileSync(resolve(ROOT, GATE), gate);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '--', GATE);
  git(repo, 'commit', '-q', '-m', 'base');
  return { repo, gate, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

describe('chat-id literal gate — the real tree', () => {
  it('passes on the current tracked tree', { timeout: 120_000 }, () => {
    const r = runGate(resolve(ROOT, GATE), []);
    expect(r.out, r.out).toContain(`${TOKEN}PASS`);
    expect(r.code).toBe(0);
  });

  it('proves it can FAIL, not merely that it can pass (two-way self-test)', { timeout: 120_000 }, () => {
    const r = runGate(resolve(ROOT, GATE), ['--self-test']);
    expect(r.out, r.out).toContain('SELF-TEST: PASS');
    expect(r.out).toMatch(/\d+ must-fire, \d+ must-not-fire/);
    expect(r.code).toBe(0);
  });

  it('survives the environment git EXPORTS into hooks — GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE', { timeout: 120_000 }, () => {
    // The pre-push block runs this gate inside a hook, where git exports these. The first install
    // refused its own landing push: the self-test's fixture TREE runs inherited GIT_DIR, so
    // `git ls-files` in a throwaway repo listed the REAL index and 5 assertions failed — while the
    // same self-test passed standalone and here. Standalone is not where the block lives.
    const q = (args: string[]) => execFileSync('git', args, { cwd: ROOT, env: GIT_ENV, encoding: 'utf8' }).trim();
    const hookEnv = {
      ...GIT_ENV,
      GIT_DIR: q(['rev-parse', '--absolute-git-dir']),
      GIT_INDEX_FILE: resolve(ROOT, q(['rev-parse', '--git-path', 'index'])),
      GIT_WORK_TREE: ROOT,
    };
    for (const args of [['--self-test'], [], ['--push-range', 'origin']]) {
      let out = '';
      try {
        out = execFileSync('node', [resolve(ROOT, GATE), ...args], { cwd: ROOT, env: hookEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e: any) {
        out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      expect(out, `${args.join(' ') || '(tree)'} under the hook env\n${out}`).toContain(`${TOKEN}PASS`);
    }
  });

  it('emits exactly one verdict token per run, in every mode', { timeout: 120_000 }, () => {
    for (const args of [[], ['--self-test'], ['--push-range', 'origin']]) {
      const r = runGate(resolve(ROOT, GATE), args);
      expect(r.out.split(TOKEN).length - 1, `${args.join(' ')}\n${r.out}`).toBe(1);
    }
  });
});

describe('chat-id literal gate — the real CLI on a fixture repo', () => {
  it('tree mode names the file and never prints the literal', { timeout: 60_000 }, () => {
    const { repo, gate, cleanup } = fixtureRepo();
    try {
      writeFileSync(join(repo, 'probe.sh'), `# pin chat ${FAKE_ID} / ETH / 15m\n`);
      git(repo, 'add', 'probe.sh');
      const r = runGate(gate, [], repo);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(`${TOKEN}FAIL`);
      expect(r.out).toContain(`probe.sh:1: ${MASKED}`);
      expect(r.out.includes(FAKE_ID), 'the gate must never republish what it refused').toBe(false);
    } finally { cleanup(); }
  });

  it('push-range refuses an id that lives ONLY in a commit message — the vector a tree scan cannot see', { timeout: 60_000 }, () => {
    const { repo, gate, cleanup } = fixtureRepo();
    try {
      git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
      writeFileSync(join(repo, 'notes.md'), 'clean content\n');
      git(repo, 'add', 'notes.md');
      git(repo, 'commit', '-q', '-m', `fix(referral): tg identity for chat ${FAKE_ID} was minted twice`);
      expect(runGate(gate, [], repo).code, 'the TREE is clean — only the message carries it').toBe(0);
      const r = runGate(gate, ['--push-range', 'origin'], repo);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(`${TOKEN}FAIL`);
      expect(r.out).toMatch(new RegExp(`\\(message\\):1: ${MASKED}`));
      expect(r.out).toContain('does not help');
      expect(r.out.includes(FAKE_ID)).toBe(false);
    } finally { cleanup(); }
  });

  it('push-range with nothing unpublished is a REPORTED pass', { timeout: 60_000 }, () => {
    const { repo, gate, cleanup } = fixtureRepo();
    try {
      git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
      const r = runGate(gate, ['--push-range', 'origin'], repo);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`${TOKEN}PASS`);
      expect(r.out).toContain('nothing to publish');
    } finally { cleanup(); }
  });

  it('a directory that is not a git checkout is INDETERMINATE, never a pass', { timeout: 60_000 }, () => {
    const tmp = mkdtempSync(join(tmpdir(), 'chat-id-plain-'));
    try {
      mkdirSync(join(tmp, 'scripts'));
      copyFileSync(resolve(ROOT, GATE), join(tmp, GATE));
      const r = runGate(join(tmp, GATE), [], tmp);
      expect(r.code, r.out).toBe(3);
      expect(r.out).toContain(`${TOKEN}INDETERMINATE`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('chat-id literal gate — the pre-push installer', () => {
  const src = () => readFileSync(resolve(ROOT, INSTALLER), 'utf8');

  it('exists and is executable', () => {
    const p = resolve(ROOT, INSTALLER);
    expect(existsSync(p), `${INSTALLER} is missing`).toBe(true);
    expect(statSync(p).mode & 0o111, `${INSTALLER} is not executable`).toBeGreaterThan(0);
  });

  it('registers through the shared emitter behind the publishability precondition, never by hand', () => {
    expect(src()).toMatch(/hook_block_install pre-push chat-id-literals /);
    expect(src()).toMatch(/hook_block_assert_publishable "\$GATE_SCRIPT"/);
  });

  it('runs --push-range with stdin from /dev/null — the push-safety block owns the ref lines', () => {
    expect(src()).toMatch(/--push-range "\$\{1:-origin\}" <\/dev\/null/);
    expect(src()).toMatch(/--self-test >\/dev\/null <\/dev\/null/);
  });

  it('gates on the TOKEN and refuses anything but PASS', () => {
    expect(src()).toMatch(/\^CHAT_ID_LITERALS_VERDICT=\[A-Z\]\+/);
    expect(src()).toMatch(/!= "PASS"/);
  });

  it('carries no warn/override lever', () => {
    expect(src()).not.toMatch(/ALGOVAULT_CHAT_ID[A-Z_]*=?warn|--no-verify/);
  });
});
