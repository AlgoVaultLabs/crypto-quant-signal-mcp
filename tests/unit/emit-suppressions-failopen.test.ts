/**
 * OPS-PFE-METRIC-INTEGRITY-W1 R10 — the C3 counter must be fail-open.
 *
 * R3.3 requires the counter be copied from `rate-limit-events.ts`: zero static imports, lazy
 * `import()`, synchronous `void` return, VITEST offline guard. The reason is blunt — this runs
 * on the emit path of every trade call, so a counter that can throw or block is a counter that
 * can take down `get_trade_call`.
 *
 * These tests assert the PROPERTY (never throws, never blocks, never returns a promise), not
 * the implementation, so a future refactor that keeps the guarantee still passes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { recordEmitSuppression } from '../../src/lib/emit-suppressions.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '../../src/lib/emit-suppressions.ts');
const source = readFileSync(SRC, 'utf8');

afterEach(() => {
  delete process.env.EMIT_SUPPRESSIONS_TEST;
  vi.restoreAllMocks();
});

describe('recordEmitSuppression — fail-open on the emit path', () => {
  it('returns undefined SYNCHRONOUSLY — it must never be awaited into the emit path', () => {
    const r = recordEmitSuppression('ASTER', '1h', 'QQQ');
    // undefined is by definition not a thenable, so a caller cannot await it into the path.
    expect(r).toBeUndefined();
  });

  it('is offline under vitest by default (no DB spin-up from an emit-path test)', () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(() => recordEmitSuppression('ASTER', '1h', 'QQQ')).not.toThrow();
  });

  it('does not throw when the real path is enabled and the backend is unavailable', async () => {
    process.env.EMIT_SUPPRESSIONS_TEST = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => recordEmitSuppression('NOPE', '1h', 'FAKE')).not.toThrow();
    // Let the lazy import + rejection settle; the catch must swallow it.
    await new Promise((r) => setTimeout(r, 50));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('UnhandledPromiseRejection'));
  });

  it('survives hostile inputs without throwing', () => {
    const hostile: Array<[string, string, string]> = [
      ['', '', ''],
      ["'; DROP TABLE signals; --", '1h', 'X'],
      ['A'.repeat(500), '1h', 'B'.repeat(500)],
      [undefined as unknown as string, null as unknown as string, NaN as unknown as string],
    ];
    for (const [ex, tf, coin] of hostile) {
      expect(() => recordEmitSuppression(ex, tf, coin)).not.toThrow();
    }
  });
});

describe('R3.3 — structural guarantees copied from rate-limit-events.ts', () => {
  it('has ZERO static imports (cycle-safety: it cannot be in an import cycle)', () => {
    const staticImports = source
      .split('\n')
      .filter((l) => /^\s*import\s/.test(l) && !/^\s*import\s*\(/.test(l))
      // a type-only import is erased at runtime and cannot close a cycle
      .filter((l) => !/^\s*import\s+type\s/.test(l));
    expect(staticImports, `found static imports: ${staticImports.join(' | ')}`).toHaveLength(0);
  });

  it('uses a LAZY import() for the DB module', () => {
    expect(source).toMatch(/void import\(['"]\.\/performance-db\.js['"]\)/);
  });

  it('attaches a .catch — the rejection must be swallowed, not surfaced', () => {
    expect(source).toMatch(/\.catch\(/);
  });

  it('carries the VITEST offline guard with its named escape hatch', () => {
    expect(source).toMatch(/process\.env\.VITEST/);
    expect(source).toMatch(/EMIT_SUPPRESSIONS_TEST/);
  });

  it('declares a void return type — the signature itself forbids awaiting', () => {
    expect(source).toMatch(/export function recordEmitSuppression\([\s\S]*?\):\s*void\s*\{/);
  });
});
