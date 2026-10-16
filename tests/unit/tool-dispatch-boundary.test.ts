/**
 * ARCH-MCP-CALL-PIPELINE-W1 CH3 — the tool-dispatch boundary gate is WIRED, REGISTERED, and ABLE TO FAIL.
 *
 * The gate itself (scripts/check-tool-dispatch-boundary.mjs) holds the property: every tool call on every
 * channel dispatches through src/lib/tool-call-pipeline.ts, and no other src/ file calls a tool engine or
 * writes a tool request_log row without a reasoned allowlist row. This suite does not re-implement that
 * check. It asserts the three things the gate cannot assert about itself:
 *
 *   1. it is wired where it must run — package scripts, prepublishOnly (self-test THEN check), the shared
 *      pre-push installer, and the shared-state registry row that the reconciler reads;
 *   2. its config is evidence, not intent — every allowlist row names a real file with a real reason, every
 *      engine module exists, and the gate never calls process.exit (the token must survive a pipe);
 *   3. its own --self-test passes HERE, inside the vitest suite the pre-push test-gate already enforces, so
 *      a worktree that lacks the hook block still runs the fixtures and the real-artifact assertions.
 *
 * Behavioural where it spawns: the real script, the real tree. The fixtures live in ONE place — the
 * script's --self-test — so this file cannot drift from them.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
// The repo's ONE comment stripper (ops/strip-comments-consumers.md) — the assertion below is about CODE, and the gate's
// own docblock names the forbidden call in prose.
// @ts-expect-error — plain ESM module without a declaration file
import { stripComments } from '../../scripts/lib/strip-comments.mjs';

const ROOT = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const GATE = 'scripts/check-tool-dispatch-boundary.mjs';
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
const cfg = JSON.parse(read('ops/tool-dispatch-boundary.json')) as {
  pipeline: string;
  registry: string;
  engines: Array<{ symbol: string; module: string }>;
  request_log: { symbol: string; module: string };
  allow: Array<{ file: string; symbol: string; reason: string }>;
};

describe('tool-dispatch boundary gate — wired, registered, and able to fail', () => {
  it('package scripts exist and prepublishOnly runs the self-test BEFORE the check', () => {
    expect(pkg.scripts['tool-dispatch:check']).toBe(`node ${GATE}`);
    expect(pkg.scripts['tool-dispatch:selftest']).toBe(`node ${GATE} --self-test`);
    const pre = pkg.scripts.prepublishOnly;
    const s = pre.indexOf('npm run tool-dispatch:selftest');
    const c = pre.indexOf('npm run tool-dispatch:check');
    expect(s, 'prepublishOnly must run the self-test').toBeGreaterThan(-1);
    expect(c, 'prepublishOnly must run the check after the self-test').toBeGreaterThan(s);
  });

  it('the pre-push installer names the gate script, the block, the wave and the npm script', () => {
    const inst = read('scripts/install_tool_dispatch_hook.sh');
    expect(inst).toContain(`GATE_SCRIPT='${GATE}'`);
    expect(inst).toContain('hook_block_assert_publishable "$GATE_SCRIPT"');
    expect(inst).toContain('hook_block_install pre-push tool-dispatch-boundary ARCH-MCP-CALL-PIPELINE-W1');
    expect(inst).toContain('tool-dispatch:check || exit 1');
  });

  it('the shared-state registry carries the block row and names the installer as a pre-push writer', () => {
    const reg = JSON.parse(read('ops/shared-worktree-state.json')) as { resources: Array<Record<string, unknown>> };
    const row = reg.resources.find((r) => r.id === 'block-tool-dispatch-boundary');
    expect(row).toMatchObject({
      kind: 'hook-block',
      hook: 'pre-push',
      block_name: 'tool-dispatch-boundary',
      script: GATE,
      writers: ['scripts/install_tool_dispatch_hook.sh'],
      severity: 'block',
    });
    const hook = reg.resources.find((r) => r.id === 'hook-pre-push') as { writers: string[] };
    expect(hook.writers).toContain('scripts/install_tool_dispatch_hook.sh');
  });

  it('the config is evidence, not intent — real files, real reasons, the real pipeline and registry', () => {
    expect(existsSync(resolve(ROOT, cfg.pipeline)), cfg.pipeline).toBe(true);
    expect(existsSync(resolve(ROOT, cfg.registry)), cfg.registry).toBe(true);
    expect(existsSync(resolve(ROOT, cfg.request_log.module)), cfg.request_log.module).toBe(true);
    expect(cfg.engines.length).toBeGreaterThan(0);
    for (const e of cfg.engines) expect(existsSync(resolve(ROOT, e.module)), `${e.symbol} ← ${e.module}`).toBe(true);
    expect(cfg.allow.length).toBeGreaterThan(0);
    for (const a of cfg.allow) {
      expect(existsSync(resolve(ROOT, a.file)), `allow row names a missing file: ${a.file}`).toBe(true);
      expect(a.reason.trim().length, `${a.file}#${a.symbol} needs a real reason`).toBeGreaterThanOrEqual(25);
    }
  });

  it('the gate never calls process.exit — the verdict token must survive a pipe', () => {
    const src = stripComments(read(GATE), GATE) as string;
    expect(src).not.toMatch(/process\.exit\s*\x28/); // \x28 = an open paren; a literal one inside a regex unbalances the block splitter of scripts/check-test-budget.mjs
    expect(src).toContain('process.exitCode = EXIT[tok]');
  });

  it('--self-test passes and ends with the PASS token (fixtures + the real artifacts the fixtures bypass)', { timeout: 120_000 }, () => {
    const out = execFileSync('node', [GATE, '--self-test'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toMatch(/✓ self-test: \d+ checks passed/);
    expect(out.trim().split('\n').at(-1)).toBe('TOOL_DISPATCH_BOUNDARY=PASS');
  });

  it('the real gate passes on this tree and prints its positive per-run line', { timeout: 120_000 }, () => {
    const out = execFileSync('node', [GATE], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toMatch(
      /^\[tool-dispatch\] instrument=typescript files=[1-9]\d* engines=[1-9]\d* tool-names=[1-9]\d* pipeline-sites=[1-9]\d* sites=\d+ allowed=\d+ violations=0 stale-rows=0$/m,
    );
    expect(out.trim().split('\n').at(-1)).toBe('TOOL_DISPATCH_BOUNDARY=PASS');
  });
});
