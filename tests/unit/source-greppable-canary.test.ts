// OPS-GREPPABLE-SOURCE-GUARD-W1 C2 — keep the greppability canary itself honest.
//
// The canary exists because a raw NUL byte makes grep-class tools skip a whole file
// SILENTLY at exit 0. These tests assert the two things that make such a gate worth
// having: it actually fires on the defect, and it refuses to report a pass when it
// verified nothing. A gate whose logic has rotted into an always-pass is the exact
// dark-guard failure mode this repo has now hit five times.

import { describe, it, expect, vi } from 'vitest';

/**
 * OPS-PARALLEL-SESSION-CAPACITY-W2 / Ch2 — a budget that survives concurrency.
 *
 * Ten tests, each spawning a gate that `git ls-files -z` then reads and UTF-8-validates every
 * tracked file (~1,457 files / ~21.7 MB). Cost grows with the repo — the same argument as
 * 136954a, on a file it never reached.
 *
 * Measured: under 3-5 concurrent gates (89 checkouts share one pre-push hook) every failure
 * in this class was a TIMEOUT, never an assertion — durations of 5.4-19.9 s against 5 s
 * budgets, including a pure-JSON-read test that took 7.15 s. The assertions are right; the
 * budgets were stale. File-level, per 136954a: the per-`it` third argument silently no-ops
 * when placed after the closing paren, and every test here pays the same cost anyway.
 */
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = 'scripts/check-source-greppable.mjs';

const run = (args: string[]) => {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
};

/** A NUL constructed, never typed — authoring a file that bans raw NULs must not plant one. */
const NUL = Buffer.from([0]);

describe('source-greppability canary', () => {
  it('self-test passes both directions', () => {
    const r = run(['--self-test']);
    expect(r.out).toContain('SOURCE_GREPPABLE_VERDICT=PASS');
    expect(r.code).toBe(0);
  });

  it('the live tree is clean', () => {
    const r = run(['--check']);
    expect(r.out).toContain('SOURCE_GREPPABLE_VERDICT=PASS');
    expect(r.code).toBe(0);
  });

  it('emits exactly ONE terminal verdict line (verdict-token law)', () => {
    const r = run(['--check']);
    const lines = r.out.split('\n').filter((l) => l.startsWith('SOURCE_GREPPABLE_VERDICT='));
    expect(lines).toHaveLength(1);
    expect(r.out.trimEnd().endsWith(lines[0])).toBe(true);
  });

  it('prints POSITIVE per-class output — a silent pass is indistinguishable from a vacuous one', () => {
    const r = run(['--check']);
    expect(r.out).toMatch(/R1 no raw NUL bytes:\s+\d+ files/);
    expect(r.out).toMatch(/R2 valid UTF-8:\s+\d+ files/);
    expect(r.out).toMatch(/tracked total \d+ · scanned \d+/);
    // and it verified a non-trivial corpus, not one file
    const scanned = Number(/scanned (\d+)/.exec(r.out)?.[1] ?? 0);
    expect(scanned).toBeGreaterThan(500);
  });
});

describe('detector logic (imported directly — the module must not self-execute)', () => {
  it('flags a raw NUL and names the byte offset + the remediation escape', async () => {
    const { inspectBytes } = await import('../../scripts/check-source-greppable.mjs');
    const buf = Buffer.concat([Buffer.from('const a = `x'), NUL, Buffer.from('y`;\n')]);
    const hit = inspectBytes(buf);
    expect(hit).not.toBeNull();
    expect(hit!.rule).toBe('R1');
    expect(hit!.offset).toBe(12);
    expect(hit!.detail).toContain('u0000');
  });

  it('flags invalid UTF-8', async () => {
    const { inspectBytes } = await import('../../scripts/check-source-greppable.mjs');
    expect(inspectBytes(Buffer.from([0x41, 0xc3, 0x28]))!.rule).toBe('R2');
  });

  it('passes clean text, including prose that merely MENTIONS the defect', async () => {
    const { inspectBytes } = await import('../../scripts/check-source-greppable.mjs');
    // The most valuable line in a file is often the one explaining the historical bug.
    expect(inspectBytes(Buffer.from('// replace the raw NUL with the \\u0000 escape\n'))).toBeNull();
    expect(inspectBytes(Buffer.from('café — ✅\n'))).toBeNull();
    expect(inspectBytes(Buffer.from(''))).toBeNull();
  });

  it('would have caught the 2026-08-01 incident', async () => {
    const { inspectBytes } = await import('../../scripts/check-source-greppable.mjs');
    // Reconstruct the pre-fix shape of performance-db.ts's group key.
    const preFix = Buffer.concat([
      Buffer.from('const key = `${ex}'), NUL,
      Buffer.from('${r.coin}'), NUL,
      Buffer.from('${r.timeframe}'), NUL,
      Buffer.from('${r.signal}`;\n'),
    ]);
    const hit = inspectBytes(preFix);
    expect(hit!.rule).toBe('R1');
    expect(hit!.detail).toContain('3 raw NUL byte(s)');
    // …and the shipped file is clean.
    expect(inspectBytes(readFileSync(join(ROOT, 'src/lib/performance-db.ts')))).toBeNull();
  });
});

describe('allowlist config', () => {
  it('every row carries a reason (an exemption in prose alone gets "fixed" by a later wave)', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'ops/source-greppable-allowlist.json'), 'utf8'));
    expect(Array.isArray(cfg.extensions)).toBe(true);
    expect(Array.isArray(cfg.paths)).toBe(true);
    expect(cfg.extensions.length).toBeGreaterThan(0);
    for (const row of [...cfg.extensions, ...cfg.paths]) {
      expect(typeof row.reason).toBe('string');
      expect(row.reason.length).toBeGreaterThan(10);
    }
  });

  it('exempts only genuinely-binary formats — no source extension may be allowlisted', () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'ops/source-greppable-allowlist.json'), 'utf8'));
    const exts = cfg.extensions.map((e: { ext: string }) => e.ext);
    for (const src of ['.ts', '.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.sh', '.py', '.html', '.css']) {
      expect(exts).not.toContain(src);
    }
  });
});
