/**
 * CANCEL-PATH-CSP-FORM-ACTION-W1 CH2 — scripts/check-form-action-conformance.mjs.
 *
 * Spawns the REAL gate (no import seam) and pins, per fixture, both the verdict TOKEN and the
 * token → exit-code mapping — the gate law is that callers read the token, and a self-test that
 * asserts tokens but not codes let a re-coded INDETERMINATE ship green once already.
 *
 * Also pins a defect found while building it: invoked through a SYMLINKED path (macOS `/var` →
 * `/private/var`, or a symlinked checkout), a string-compare main-guard silently skipped `main`
 * and exited 0 with NO token — a dark gate that reads as healthy. The guard compares real paths.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const GATE = path.join(ROOT, 'scripts/check-form-action-conformance.mjs');
const FIX = (d: string) => path.join(ROOT, 'tests/fixtures/form-action', d);
const TOKEN_RE = /FORM_ACTION_CONFORMANCE_VERDICT=[A-Z]+/g;

function run(args: string[], script = GATE): { out: string; status: number } {
  try {
    const out = execFileSync('node', [script, ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { out, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, status: e.status ?? -1 };
  }
}

function expectVerdict(r: { out: string; status: number }, verdict: 'PASS' | 'FAIL' | 'INDETERMINATE') {
  expect(r.out.match(TOKEN_RE)).toEqual([`FORM_ACTION_CONFORMANCE_VERDICT=${verdict}`]);
  expect(r.status).toBe({ PASS: 0, FAIL: 1, INDETERMINATE: 3 }[verdict]);
}

describe('form-action conformance gate', () => {
  it('--self-test passes, two-way over the committed fixtures', { timeout: 60_000 }, () => {
    const r = run(['--self-test']);
    expect(r.out).toMatch(/SELF-TEST: PASS \(\d+ passed, 0 failed\)/);
    expectVerdict(r, 'PASS');
  });

  it('the live tree is conformant (--check is a real, parsed alias)', { timeout: 60_000 }, () => {
    const r = run(['--check']);
    expectVerdict(r, 'PASS');
    // Both policies are evaluated separately, and the portal form is among the verified.
    expect(r.out).toContain("policy express: form-action 'self'");
    expect(r.out).toContain("policy apex-static: form-action 'self'");
    expect(r.out).toMatch(/✓ src\/lib\/account-handlers\.ts:\d+ POST \/account\/portal → accountPortalHandler/);
  });

  it('a form POST answered by a non-literal cross-origin 3xx → FAIL, naming it', { timeout: 60_000 }, () => {
    const r = run(['--root', FIX('cross-origin-3xx')]);
    expectVerdict(r, 'FAIL');
    // A const-resolved target names the variable the author wrote AND what it resolved to, on one line.
    expect(r.out).toMatch(/✗ \S+ POST \/pay — \S+ 303: target `portalUrl` → target `await mintSession\(\)` is not provably same-origin/);
  });

  it('same-origin 200 hand-offs, relative redirects, template + uppercase forms → PASS', { timeout: 60_000 }, () => {
    const r = run(['--root', FIX('same-origin-200')]);
    expectVerdict(r, 'PASS');
    expect(r.out).toContain('SAME_DOCUMENT');
  });

  it('the FAIL matrix: every declared check fires on its own row', { timeout: 60_000 }, () => {
    const r = run(['--root', FIX('fail-matrix')]);
    expectVerdict(r, 'FAIL');
    for (const route of ['/f/abs-literal', '/f/location', '/f/setheader', '/f/writehead', '/f/set-object', '/f/wrapped', '/f/rettype',
      '/f/concise', '/f/two-hop', '/f/next', '/f/mw', '/f/regex', '/F/Case', 'https://checkout.stripe.com/pay',
      'https://checkout.stripe.com/const', '/f/btn', '/f/unquoted', '/apx',
      // round-2 shapes: lexical scope, middleware, helpers, hole semantics, response aliases, hop methods
      '/f/mw-local', '/f/use-prefix', '/f/shadow', '/f/param-shadow', '/f/hop-apex', '/f/helper', '/f/route-chain', '/f/slash-hole',
      '/f/append', '/f/writehead-var', '/f/alias', '/f/bind', '/f/elem', '/f/call', '/f/star-hop', '/f/hole${…}', '/f/legacy-order', '/f/methods']) {
      expect(r.out, route).toMatch(new RegExp(`✗ \\S+ POST ${route.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\s|$)`));
    }
    expect(r.out).toMatch(/✓ \S+ POST \/f\/ok\s/);
  });

  it('the PASS matrix: correct code never FAILs (a false FAIL blocks every checkout)', { timeout: 60_000 }, () => {
    const r = run(['--root', FIX('pass-matrix')]);
    expectVerdict(r, 'PASS');
    expect(r.out).not.toContain('✗');
    // A GET form to a path no Express registration serves is REPORTED (a static page), never failed.
    expect(r.out).toContain('GET /verify — no Express registration serves it');
    expect(r.out).toContain('method=dialog');
    expect(r.out).not.toContain('/p/commented');
  });

  it('the INDETERMINATE matrix: each per-form reason is distinct and reachable', { timeout: 60_000 }, () => {
    const r = run(['--root', FIX('indeterminate-matrix')]);
    expectVerdict(r, 'INDETERMINATE');
    for (const reason of ['FORM_UNROUTED', 'SAME_DOCUMENT_POST', 'ACTION_ORIGIN_UNRESOLVED', 'ACTION_UNRESOLVED', 'HANDLER_UNRESOLVED', 'FORM_UNPARSED',
      'FORM_ATTRS_INTERPOLATED', 'FORM_NO_SERVING_ORIGIN']) {
      expect(r.out, reason).toMatch(new RegExp(`\\? \\S+ .*${reason}`));
    }
  });

  it('a chain crossing into the sibling own origin is followed there, with self bound to the page', { timeout: 60_000 }, () => {
    const r = run(['--root', FIX('cross-own-origin')]);
    expectVerdict(r, 'FAIL');
    expect(r.out).toMatch(/✗ \S+ POST https:\/\/algovault\.com\/x\/start — .*→ https:\/\/api\.algovault\.com\/x\/mid → /);
    expect(r.out).toMatch(/✗ \S+ POST https:\/\/algovault\.com\/x\/loop /);
    expect(r.out).toMatch(/✓ \S+ POST https:\/\/algovault\.com\/x\/back .*2 own-origin hop\(s\) followed/);
  });

  for (const [dir, reason] of [
    ['empty-corpus', 'NO_FORMS'],
    ['no-form-action-directive', 'NO_FORM_ACTION_DIRECTIVE'],
    ['no-routes', 'NO_ROUTES'],
    ['unresolved-handler', 'NO_MAPPED_HANDLERS'],
    ['no-express-csp', 'NO_EXPRESS_CSP'],
    ['no-apex-csp', 'NO_APEX_CSP'],
    ['apex-csp-ambiguous', 'APEX_CSP_AMBIGUOUS'],
    ['apex-no-form-action', 'NO_FORM_ACTION_DIRECTIVE'],
    ['apex-no-proxy-map', 'NO_APEX_PROXY_MAP'],
  ] as const) {
    it(`${dir} → INDETERMINATE (exit 3) with the distinct reason ${reason}`, { timeout: 60_000 }, () => {
      const r = run(['--root', FIX(dir)]);
      expectVerdict(r, 'INDETERMINATE');
      expect(r.out).toContain(`INDETERMINATE: ${reason}`);
    });
  }

  it('a bad invocation is INDETERMINATE, never a silent pass on the wrong tree', { timeout: 60_000 }, () => {
    for (const args of [['--no-such-flag'], ['stray-positional'], ['-x'], ['--root'], ['--root', ''], ['--root', '/definitely/not/a/dir']]) {
      expectVerdict(run(args), 'INDETERMINATE');
    }
  });

  it('invoked through a SYMLINK it still prints exactly one token (no dark exit 0)', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fa-link-'));
    try {
      const link = path.join(dir, 'gate.mjs');
      symlinkSync(GATE, link);
      expectVerdict(run(['--check'], link), 'PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
