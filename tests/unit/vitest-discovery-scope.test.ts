/**
 * OPS-ANALYTICS-EXT-PARALLEL-FLAKE-W1 (2026-07-18) — vitest discovery-scope canary.
 *
 * WHY THIS EXISTS
 * vitest's default `include` (`**\/*.{test,spec}.?(c|m)[jt]s?(x)`) is an unanchored
 * walk from the repo root, and vitest does NOT honor .gitignore. This repo's
 * worktree-first workflow (CLAUDE.md makes one worktree per parallel session LAW)
 * puts FULL checkouts under `.claude/worktrees/<session>/` via native `claude -w`.
 * They are gitignored (.gitignore:14) but still on disk.
 *
 * Measured from the primary checkout on 2026-07-18 BEFORE the fix: **1779 test
 * files discovered, 1480 of them (83%) stale duplicates from 5 nested worktrees** —
 * including 5 extra copies of tests/analytics-external-only.test.ts. All the copies
 * wrote the SAME sentinel rows to the SAME shared ~/.crypto-quant-signal/
 * performance.db, and each copy's beforeEach DELETEd the others' rows, so the suite
 * produced both over-counts (`expected 4 to be 2`) and under-counts (`expected +0 to
 * be 1`). The pre-push gate was therefore nondeterministic by construction, and it
 * silently executed other branches' code.
 *
 * WHAT THIS GUARDS
 * `vitest.config.ts` must keep discovery ANCHORED at `tests/`. That is what makes
 * the leak structurally impossible rather than merely absent: a nested checkout's
 * path (`.claude/worktrees/X/tests/foo.test.ts`) cannot match a pattern rooted at
 * `tests/`, so a NEW nesting location cannot reintroduce it. Deleting or widening
 * the `include` (e.g. back to the default, or to `**\/*.test.ts`) fails here.
 *
 * Deliberately dependency-free — it asserts the config, not the filesystem, so it
 * is deterministic on CI where no nested worktree exists (a filesystem probe would
 * be vacuously green there, which is exactly when the guard must still hold).
 */
import { describe, expect, it } from 'vitest';
import vitestConfig from '../../vitest.config.js';

const cfg = vitestConfig as { test?: { include?: string[]; exclude?: string[] } };

describe('vitest discovery scope — nested worktrees must never be collected', () => {
  it('declares an explicit include (never falls back to the unanchored default)', () => {
    expect(cfg.test).toBeDefined();
    expect(Array.isArray(cfg.test?.include)).toBe(true);
    expect(cfg.test!.include!.length).toBeGreaterThan(0);
  });

  it('anchors every include pattern at tests/ so a nested checkout cannot match', () => {
    for (const pattern of cfg.test!.include!) {
      expect(
        pattern.startsWith('tests/'),
        `include pattern must be rooted at tests/ (got "${pattern}") — an unanchored ` +
          'pattern re-opens the .claude/worktrees/** duplicate-collection leak',
      ).toBe(true);
    }
  });

  it('keeps the nested-worktree exclude backstop', () => {
    expect(Array.isArray(cfg.test?.exclude)).toBe(true);
    expect(
      cfg.test!.exclude!.some((p) => p.includes('.claude/worktrees')),
      'the `**/.claude/worktrees/**` exclude backstop must stay, so widening `include` ' +
        'cannot silently re-open the leak',
    ).toBe(true);
  });
});
