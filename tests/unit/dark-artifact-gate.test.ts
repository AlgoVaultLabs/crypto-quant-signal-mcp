/**
 * OPS-DARK-ARTIFACT-GATE-PROMOTE-W1 R2/R3 — the dark-artifact gate's CI surface.
 *
 * WHY THIS FILE IS THE CI WIRING, AND WHY THERE IS NO NEW HOOK BLOCK OR WORKFLOW
 * -----------------------------------------------------------------------------
 * `check-new-dark-exports.mjs` already has a guarded block in the shared `pre-push` hook, but it
 * had NO CI wiring at all — measured, zero references under `.github/workflows/`. The cheapest
 * correct fix is not a twelfth shared-hook block (installing one into $GIT_COMMON_DIR has twice
 * halted every parallel session on this machine) and not a standalone workflow file. It is a
 * vitest test: `check_test_baseline.sh` already runs vitest on push and CI already runs the
 * suite, so this one file rides BOTH surfaces with zero new wiring. Same argument, same shape as
 * tests/unit/promotion-independence.test.ts.
 *
 * WHAT IT ASSERTS
 * ---------------
 * 1. The instrument is the strong one here. `referenceCounts` degrades to an order-corrected
 *    regex when `typescript` is absent, which is right for a cold worktree but must never be
 *    what CI silently measures with.
 * 2. The R1.5 repair cannot regress — the strip-ordering trap, both directions.
 * 3. Shape A and shape B each PROVE THEY CAN FAIL against synthetic fixtures (R3). A guard never
 *    observed failing is not known to work; shape B's live corpus is zero, so for that shape the
 *    synthetic is the ONLY evidence the detector functions at all.
 * 4. The live tree is clean on both shapes — the promotion precondition.
 * 5. Zero files scanned is INDETERMINATE, never a pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  referenceCounts, exportedDeclarations, srcFiles, isExempt,
  stripOrderCorrected, stripLegacyBuggy, findUnreadFlags, findDarkExports,
  newDeclarations, baseTreeSrcFiles,
  // @ts-expect-error — plain ESM helper module, no type declarations by design
} from '../../scripts/lib/dark-artifacts.mjs';

const ROOT = resolve(__dirname, '../..');
const cfg = JSON.parse(readFileSync(resolve(ROOT, 'ops/dark-exports-config.json'), 'utf8'));

describe('dark-artifact gate — instrument', () => {
  it('CI runs the TypeScript scanner, never the degraded regex', () => {
    const { instrument } = referenceCounts(ROOT, srcFiles(ROOT).slice(0, 5));
    expect(instrument).toBe('typescript');
  });

  it('finds a plausible corpus — a dead declaration regex would make every run vacuously green', () => {
    expect(exportedDeclarations(ROOT).length).toBeGreaterThan(500);
  });

  it('scanning zero files yields an empty count map, which callers must not read as a pass', () => {
    const { counts } = referenceCounts(ROOT, []);
    expect(counts.size).toBe(0);
  });

  it('the degraded fallback is REACHABLE, NAMED, and errs toward missing rather than false-blocking', () => {
    // A fallback nothing ever exercises is itself a dark artifact. Forced deliberately here so
    // the cold-worktree path is proven rather than assumed.
    const files = srcFiles(ROOT);
    const degraded = referenceCounts(ROOT, files, { forceDegraded: true });
    expect(degraded.instrument).toBe('regex-order-corrected');

    // The safety property that makes degrading acceptable for a BLOCKING gate: measured over the
    // whole corpus, the fallback never counts FEWER references than the tokenizer, so it can only
    // MISS a dark export (FN), never manufacture one (FP). 33 false blocks was the R1.5 defect.
    const strong = referenceCounts(ROOT, files);
    expect(strong.instrument).toBe('typescript');
    const manufactured = exportedDeclarations(ROOT, files).filter(
      (d: { symbol: string }) => (degraded.counts.get(d.symbol) ?? 0) <= 1 && (strong.counts.get(d.symbol) ?? 0) > 1,
    );
    expect(manufactured).toEqual([]);
  });
});

describe('dark-artifact gate — R1.5 strip-ordering regression lock', () => {
  // The shipped gate stripped BLOCK comments first, so a `/*` inside a LINE comment opened a
  // block that ran to the next `*/`. src/index.ts:1501 ("// … Caddy routes /integrations/*")
  // swallowed 836 lines and manufactured 33 false positives, every one of them a symbol wired
  // through src/index.ts. Reordering the passes took FP 33 -> 0.
  const trap = '// Caddy routes /integrations/* AND /docs/integrations/*\nwiredCall();\n/* real */\n';

  it('a call after a line comment containing "/*" survives the corrected strip', () => {
    expect(stripOrderCorrected(trap)).toMatch(/\bwiredCall\b/);
  });

  it('the LEGACY order still reproduces the defect — otherwise this lock is vacuous', () => {
    // If this ever passes, the fixture stopped demonstrating the bug and the assertion above
    // proves nothing. Asserting the broken direction is what makes the fixed direction evidence.
    expect(stripLegacyBuggy(trap)).not.toMatch(/\bwiredCall\b/);
  });

  it('a real block comment is still stripped by the corrected order', () => {
    expect(stripOrderCorrected('/* gone */ keptCall();')).toMatch(/\bkeptCall\b/);
    expect(stripOrderCorrected('/* darkSymbol */ keptCall();')).not.toMatch(/\bdarkSymbol\b/);
  });
});

describe('dark-artifact gate — base-tree read covers ALL of src/', () => {
  // Caught in R2 before landing: reading the base tree with the pathspec `src/**/*.ts` matched
  // 309 files where plain `src` matches 313 — it silently dropped the four sitting DIRECTLY under
  // src/, so every symbol declared in src/index.ts and src/tool-descriptions.ts read as
  // absent-at-base and therefore NEW. The gate then reported createSandboxServer, TOP_20_KEYWORDS
  // and resolveSessionCorrelationId as dark on a branch that never touched them. A comment about
  // it is not a control; this is.
  it('sees the files directly under src/, not only nested ones', () => {
    const base = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const files: string[] | null = baseTreeSrcFiles(ROOT, base);
    expect(files).not.toBeNull();
    expect(files).toContain('src/index.ts');
    expect(files!.filter((f) => f.split('/').length === 2).length).toBeGreaterThan(0);
  });

  it('a branch with no new exports has an empty delta', () => {
    const base = execFileSync('git', ['rev-parse', 'origin/main'], { cwd: ROOT, encoding: 'utf8' }).trim();
    expect(newDeclarations(ROOT, base)).toEqual([]);
  });
});

/**
 * A FIXTURE REPO, not a stubbed predicate.
 *
 * The first draft of the two R3 proofs below filtered two hand-built `Set`s and asserted the
 * result. That is the shape this estate has repeatedly recorded as blind: a hermetic self-test
 * cannot see the seam it replaces, so it would have stayed green through any bug in the real
 * `findUnreadFlags` / `referenceCounts` — including the two that R1.5 and R2 actually found. So
 * each proof builds a real directory tree and runs the REAL exported function over it.
 */
function fixtureRoot(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dark-artifact-fixture-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","private":true}');
  return dir;
}

describe('dark-artifact gate — SHAPE A can fail (R3)', () => {
  it('a declaration nothing calls reads dark; adding one real call site clears it', () => {
    const decl = 'export function syntheticDarkExport() { return 1; }\n';
    const dark = fixtureRoot({ 'src/thing.ts': decl });
    try {
      expect(referenceCounts(dark).counts.get('syntheticDarkExport') ?? 0).toBe(1);
    } finally { rmSync(dark, { recursive: true, force: true }); }

    // REVERT-equivalent: the same tree plus one caller must NOT read dark.
    const wired = fixtureRoot({
      'src/thing.ts': decl,
      'src/caller.ts': "import { syntheticDarkExport } from './thing.js';\nsyntheticDarkExport();\n",
    });
    try {
      expect(referenceCounts(wired).counts.get('syntheticDarkExport') ?? 0).toBeGreaterThan(1);
    } finally { rmSync(wired, { recursive: true, force: true }); }
  });

  it('a mention in a COMMENT or a STRING is not a call site', () => {
    // Both halves of the R1.5 defect, on a real tree: the comment half is what produced 33 false
    // positives, the string half is what produced all 5 false negatives.
    const root = fixtureRoot({
      'src/thing.ts':
        'export function syntheticDarkExport() {\n'
        + '  // syntheticDarkExport() is called elsewhere — it is not.\n'
        + '  throw new Error(`syntheticDarkExport: never wired`);\n'
        + '}\n',
    });
    try {
      expect(referenceCounts(root).counts.get('syntheticDarkExport') ?? 0).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('an exemption row explains a symbol without suppressing the class', () => {
    expect(isExempt('_resetSomethingForTest', cfg)).toBeTruthy();
    expect(isExempt('hoursUntilUtcDayReset', cfg)).toBeNull();
  });

  it('an exemption row explains a symbol without suppressing the class', () => {
    expect(isExempt('_resetSomethingForTest', cfg)).toBeTruthy();
    expect(isExempt('hoursUntilUtcDayReset', cfg)).toBeNull();
  });
});

describe('dark-artifact gate — SHAPE B can fail (R3)', () => {
  // This shape's LIVE corpus is zero. That is what a clean baseline looks like, not evidence the
  // detector works — so the synthetic below is the only proof that it can fire at all, and it is
  // mandatory rather than decorative.
  it('reports a flag mentioned in a deploy surface and read by nothing, then clears on a reader', () => {
    const workflow = "        env:\n          ENABLE_SYNTHETIC_SELFTEST_FLAG: '1'\n";
    const unread = fixtureRoot({ '.github/workflows/deploy.yml': workflow, 'src/app.ts': 'export const x = 1;\n' });
    try {
      expect(findUnreadFlags(unread).map((f: { flag: string }) => f.flag))
        .toEqual(['ENABLE_SYNTHETIC_SELFTEST_FLAG']);
    } finally { rmSync(unread, { recursive: true, force: true }); }

    // REVERT-equivalent: give it exactly one reader and the finding must disappear.
    const read = fixtureRoot({
      '.github/workflows/deploy.yml': workflow,
      'src/app.ts': "export const on = process.env.ENABLE_SYNTHETIC_SELFTEST_FLAG === '1';\n",
    });
    try {
      expect(findUnreadFlags(read)).toEqual([]);
    } finally { rmSync(read, { recursive: true, force: true }); }
  });

  it('does NOT report the four measured false-positive classes', () => {
    const flags: Array<{ flag: string }> = findUnreadFlags(ROOT);
    const names = flags.map((f) => f.flag);
    // 1. computed key: process.env[`ENABLE_PERTF_${tf}`] at src/lib/pertf-thresholds.ts:99
    expect(names).not.toContain('ENABLE_PERTF_15M');
    // 2. a grep-read version MARKER, not an env var (check_test_baseline.sh:124)
    expect(names).not.toContain('ALGOVAULT_TEST_GATE_CONTRACT');
    // 3. customer-side vars shown only in docs/landing snippets the CUSTOMER runs
    expect(names).not.toContain('ALGOVAULT_API_KEY');
    expect(names).not.toContain('ALGOVAULT_WEBHOOK_SECRET');
    // 4. cross-repo: read by algovault-bot, which has no checkout here
    expect(names).not.toContain('ALGOVAULT_BOT_CLOSE_GRACE_MIN');
  });
});

describe('dark-artifact gate — the live tree is clean (promotion precondition)', () => {
  it('no env flag is mentioned-but-unread', () => {
    expect(findUnreadFlags(ROOT)).toEqual([]);
  });

  it('this branch adds no dark export', () => {
    let base: string;
    try {
      base = execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
      // Cannot resolve a base => INDETERMINATE, never a silent pass. Skip rather than green.
      expect.unreachable('git merge-base HEAD origin/main is unresolvable — the gate is INDETERMINATE here');
      return;
    }
    const r = findDarkExports(ROOT, base, cfg);
    expect(r, `the base tree at ${base} is unreadable — INDETERMINATE, not a pass`).not.toBeNull();
    expect(r.instrument).toBe('typescript');
    expect(r.dark.map((d: { symbol: string }) => d.symbol)).toEqual([]);
  });
});

describe('dark-artifact gate — config contract', () => {
  it('is promoted to blocking on the delta scope', () => {
    expect(cfg.mode).toBe('block');
    expect(cfg.verdict_token).toBe('DARK_EXPORTS_VERDICT');
    expect(cfg.exit_codes).toEqual({ PASS: 0, FAIL: 1, INDETERMINATE: 3 });
  });

  it('every exemption carries a reason — a blank allowlist entry is the defect wearing a config file', () => {
    for (const e of cfg.name_exemptions) expect(e.reason?.length ?? 0).toBeGreaterThanOrEqual(25);
    for (const e of cfg.symbol_exemptions ?? []) expect(e.reason?.length ?? 0).toBeGreaterThanOrEqual(25);
  });
});
