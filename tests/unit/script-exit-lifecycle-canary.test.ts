/**
 * OPS-SCRIPT-EXIT-LIFECYCLE-W1 structural canary (2026-07-21).
 *
 * Locks the rule that makes the zombie-process bug class UNREPRESENTABLE:
 * every `src/scripts/*` entrypoint terminates through `runScript()`.
 *
 * ## The bug this exists to prevent
 *
 * Script tails were `.catch()`-only — cleanup (`closeDb()`) and `process.exit()`
 * wired EXCLUSIVELY to the failure branch:
 *
 *     main().catch((err) => { console.error('Fatal:', err); closeDb(); process.exit(1); });
 *
 * Because `buildPoolConfig` deliberately leaves `allowExitOnIdle` unset (setting
 * it true once dropped ~90% of seed signals), an explicit close is the ONLY exit
 * path — so crashes exited cleanly and SUCCESSES hung forever. On 2026-07-21 prod
 * held 86 finished-but-hung `dist/scripts/*` processes (oldest 1d06h at 0:00 CPU),
 * each pinning 1-2 Postgres connections, saturating `max_connections=100`
 * (4,455 `FATAL: sorry, too many clients` in 48h).
 *
 * A prior wave (OPS-SCRIPT-POOL-MAX-W1) treated the same alert by shrinking pools
 * 12->2 — headroom, not a fix; it recurred ~6 weeks later. Hence a STRUCTURAL gate
 * rather than a third point fix.
 *
 * ## Two rules
 *
 *   R1  a file with a `require.main === module` guard MUST call `runScript(`.
 *   R2  no file may invoke a bare top-level `main();` (monitor.ts did — no guard,
 *       no cleanup, no exit, 720 fires/day, and it made the module non-importable
 *       for tests, which is why `agent-activity-format.ts` had to be extracted).
 *
 * Both predicates are self-tested in BOTH directions below, so this canary cannot
 * silently stop matching (the failure mode that let a stale "5 perp venues" ship —
 * see tool-description-forward-stability.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename_ = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename_), '..', '..');
const SCRIPTS_DIR = join(REPO_ROOT, 'src', 'scripts');

/** A CJS script entrypoint guard. */
const ENTRYPOINT_RE = /require\.main\s*===\s*module/;
/** Terminating through the shared lifecycle wrapper. */
const RUNSCRIPT_RE = /\brunScript\s*\(/;
/** A bare top-level `main();` — an entrypoint with no guard and no lifecycle. */
const BARE_MAIN_RE = /^\s*main\s*\(\s*\)\s*;?\s*$/m;

function scriptFiles(): string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .sort();
}

describe('script exit lifecycle — structural canary', () => {
  it('self-test: predicates match the shapes they are meant to match', () => {
    // R1 detector: catches a guarded entrypoint, and recognises runScript.
    expect(ENTRYPOINT_RE.test('if (require.main === module) {')).toBe(true);
    expect(ENTRYPOINT_RE.test('export function main() {}')).toBe(false);
    expect(RUNSCRIPT_RE.test("void runScript('seed-signals', main);")).toBe(true);
    // The exact legacy tail this canary exists to reject.
    expect(
      RUNSCRIPT_RE.test("main().catch((err) => { closeDb(); process.exit(1); });"),
    ).toBe(false);

    // R2 detector: catches a bare top-level call, not a guarded or nested one.
    expect(BARE_MAIN_RE.test('\nmain();\n')).toBe(true);
    expect(BARE_MAIN_RE.test('\nmain()\n')).toBe(true);
    expect(BARE_MAIN_RE.test('\n  void runScript("x", main);\n')).toBe(false);
    expect(BARE_MAIN_RE.test('\nawait main();\n')).toBe(false);
  });

  it('every guarded src/scripts entrypoint terminates through runScript()', () => {
    const offenders: string[] = [];
    for (const file of scriptFiles()) {
      const src = readFileSync(join(SCRIPTS_DIR, file), 'utf-8');
      if (!ENTRYPOINT_RE.test(src)) continue;
      if (!RUNSCRIPT_RE.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      `These entrypoints do not use runScript() — a successful run will hang and pin a ` +
        `Postgres connection forever (OPS-SCRIPT-EXIT-LIFECYCLE-W1). Replace the tail with:\n` +
        `  if (require.main === module) { void runScript('<label>', main); }\n` +
        `Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('no src/scripts file invokes a bare top-level main()', () => {
    const offenders: string[] = [];
    for (const file of scriptFiles()) {
      const src = readFileSync(join(SCRIPTS_DIR, file), 'utf-8');
      if (BARE_MAIN_RE.test(src)) offenders.push(file);
    }
    expect(
      offenders,
      `A bare top-level main() runs on IMPORT (breaking test-importability) and never ` +
        `drains or exits. Wrap it: if (require.main === module) { void runScript('<label>', main); }\n` +
        `Offenders: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the lifecycle module itself exposes the contract', () => {
    const src = readFileSync(join(REPO_ROOT, 'src', 'lib', 'script-lifecycle.ts'), 'utf-8');
    // Drain must be awaited before exit — the whole point (closeDb() is fire-and-forget,
    // so exiting without awaiting would silently drop in-flight INSERTs).
    expect(src).toMatch(/await\s+drainWithTimeout/);
    // The watchdog is what bounds a process whose leaked handle we never identified.
    expect(src).toMatch(/EXIT_WATCHDOG/);
    expect(src).toMatch(/watchdog\.unref\?\.\(\)/);
  });
});
