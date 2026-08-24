/**
 * script-lifecycle-stdout-drain.test.ts — EDGE-DWR-REFRESH-W1 (side-fix regression).
 *
 * ## The bug
 *
 * `runScript()` ends in `await drainWithTimeout(...)` then `process.exit(code)`. The drain waited
 * on `closeDbAsync()` ONLY — despite its own docblock promising "in-flight writes" — so a pending
 * asynchronous stdout write was truncated by the exit.
 *
 * A write to a FILE is synchronous and always lands whole; a write to a PIPE turns asynchronous
 * past the pipe buffer (64 KB on Linux). So the defect was invisible everywhere except the one
 * invocation that matters operationally: piping a report out of a container.
 *
 * MEASURED 2026-08-24 on `dist/scripts/dwr-baseline-report.js`, same run, same corpus:
 *   docker exec … > host-file   (pipe) → 65,536 bytes, exit 0
 *   docker exec sh -c "… > file" (file) → 303,280 bytes, exit 0
 * The only symptom was a JSON parse error at the cut. A job that silently emits a partial artifact
 * and reports success is the dark-guard shape, in an artifact rather than a gate.
 *
 * ## Why this test spawns a real child
 *
 * The defect lives in the interaction between an OS pipe buffer and `process.exit()`. Nothing
 * hermetic can observe it: mock the stream and the truncation disappears with the pipe. So the
 * test writes a fixture, runs it under the REAL `runScript`, and reads what actually survived the
 * exit through a REAL pipe. It needs `dist/` — same as the repo's other compiled-artifact tests;
 * a missing build FAILS loudly here rather than skipping, because a skip on this file would be
 * indistinguishable from a pass.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIFECYCLE = join(REPO_ROOT, 'dist', 'lib', 'script-lifecycle.js');

/** Comfortably past the 64 KB pipe buffer, and not a multiple of it. */
const PAYLOAD_BYTES = 300_000;

let dir: string;

function fixture(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe('runScript — stdout survives the exit (OPS-SCRIPT-EXIT-LIFECYCLE-W1 side-fix)', () => {
  beforeAll(() => {
    if (!existsSync(LIFECYCLE)) {
      throw new Error(
        `dist/lib/script-lifecycle.js missing — run \`npm run build\` first. ` +
        `This test observes a real pipe + real process.exit and cannot be made hermetic.`,
      );
    }
    dir = mkdtempSync(join(tmpdir(), 'script-lifecycle-drain-'));
  });

  it(`delivers a ${PAYLOAD_BYTES}-byte stdout payload through a PIPE, whole`, { timeout: 30_000 }, () => {
    const script = fixture('big-stdout.cjs', `
      const { runScript } = require(${JSON.stringify(LIFECYCLE)});
      runScript('drain-fixture', async () => {
        process.stdout.write('x'.repeat(${PAYLOAD_BYTES}));
      });
    `);
    // execFileSync gives the child a PIPE for stdout — the exact shape docker exec/ssh produce.
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(out.length).toBe(PAYLOAD_BYTES);
  });

  it('a payload BELOW the pipe buffer was never affected — proves the test targets the right seam', { timeout: 30_000 }, () => {
    const small = 1024;
    const script = fixture('small-stdout.cjs', `
      const { runScript } = require(${JSON.stringify(LIFECYCLE)});
      runScript('drain-fixture-small', async () => { process.stdout.write('y'.repeat(${small})); });
    `);
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8' });
    expect(out.length).toBe(small);
  });

  it('still exits non-zero on failure, and still flushes what was written first', { timeout: 30_000 }, () => {
    const script = fixture('fail-after-write.cjs', `
      const { runScript } = require(${JSON.stringify(LIFECYCLE)});
      runScript('drain-fixture-fail', async () => {
        process.stdout.write('z'.repeat(${PAYLOAD_BYTES}));
        throw new Error('deliberate');
      });
    `);
    let code = 0;
    let out = '';
    try {
      out = execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      code = err.status ?? -1;
      out = err.stdout ?? '';
    }
    expect(code).toBe(1);
    expect(out.length).toBe(PAYLOAD_BYTES);
  });

  it('an exit code returned by main is still honoured (the drain must not swallow it)', { timeout: 30_000 }, () => {
    const script = fixture('exit-code.cjs', `
      const { runScript } = require(${JSON.stringify(LIFECYCLE)});
      runScript('drain-fixture-code', async () => { process.stdout.write('ok'); return 3; });
    `);
    let code = 0;
    try {
      execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    expect(code).toBe(3);
  });

  it('cleans up its fixtures', () => {
    rmSync(dir, { recursive: true, force: true });
    expect(existsSync(dir)).toBe(false);
  });
});
