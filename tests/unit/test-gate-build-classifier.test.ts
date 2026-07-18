/**
 * OPS-TEST-GATE-FAILOPEN-VISIBILITY-W1 (2026-07-18) — build-failure classifier.
 *
 * scripts/check_test_baseline.sh may fail OPEN (allow the push, run nothing) so
 * tooling breakage never blocks a legit push. That is correct for a GENUINE
 * compile error — it surfaces via build/deploy, not this gate — but it was also
 * swallowing "stale node_modules", which is not a code defect at all. Result:
 * the primary checkout pushed UNGATED for 17 days (found 2026-07-18; `npm run
 * build` failed with 4 × TS2307 for three declared-but-uninstalled packages).
 *
 * The gate now classifies the build log before deciding, and RECOVERS the
 * recoverable class with one `npm ci`. This suite pins the decision boundary:
 * misclassifying a real compile error as RECOVERABLE would trigger a pointless
 * reinstall, and misclassifying stale deps as COMPILE_ERROR restores the silent
 * skip this wave exists to remove.
 *
 * Drives the script's `--classify-build-log` entrypoint against fixture logs and
 * a fixture manifest/node_modules (TEST_GATE_MANIFEST / TEST_GATE_NODE_MODULES),
 * so it never depends on the real repo's install state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../scripts/check_test_baseline.sh');

// jq is a hard dependency of the classifier (manifest lookup). Present on dev
// machines and GitHub runners; skip rather than false-fail if it is not.
function hasJq(): boolean {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const SKIP = !hasJq() || !fs.existsSync(SCRIPT);

let fixtureDir: string;
let manifest: string;
let nodeModules: string;
let fixtureSeq = 0;

function runClassifier(logPath: string): string {
  return execFileSync('bash', [SCRIPT, '--classify-build-log', logPath], {
    encoding: 'utf8',
    env: { ...process.env, TEST_GATE_MANIFEST: manifest, TEST_GATE_NODE_MODULES: nodeModules },
  }).trim();
}

function classify(logBody: string): string {
  const log = path.join(fixtureDir, `build-${++fixtureSeq}.log`);
  fs.writeFileSync(log, logBody);
  return runClassifier(log);
}

const TS2307 = (spec: string) =>
  `src/lib/foo.ts(3,20): error TS2307: Cannot find module '${spec}' or its corresponding type declarations.\n`;

describe.skipIf(SKIP)('test-gate build-failure classifier', () => {
  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-gate-classifier-'));
    manifest = path.join(fixtureDir, 'package.json');
    nodeModules = path.join(fixtureDir, 'node_modules');
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        dependencies: { '@scope/declared-missing': '^1.0.0', 'declared-missing': '^2.0.0' },
        devDependencies: { 'declared-installed': '^3.0.0' },
      }),
    );
    // Only `declared-installed` is actually on disk.
    fs.mkdirSync(path.join(nodeModules, 'declared-installed'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  // ── RECOVERABLE: stale node_modules, nothing for a human to fix ──

  it('declared-but-uninstalled package → RECOVERABLE', () => {
    expect(classify(TS2307('declared-missing'))).toBe('RECOVERABLE');
  });

  it('scoped declared-but-uninstalled package → RECOVERABLE', () => {
    expect(classify(TS2307('@scope/declared-missing'))).toBe('RECOVERABLE');
  });

  it('SUBPATH import of a declared-but-uninstalled package → RECOVERABLE', () => {
    // The real failure used subpaths ('@circle-fin/x402-batching/server',
    // '@okxweb3/x402-evm/exact/server') — the specifier must be reduced to the
    // package name before the manifest lookup, scope-aware.
    expect(classify(TS2307('@scope/declared-missing/server'))).toBe('RECOVERABLE');
    expect(classify(TS2307('declared-missing/sub/deep'))).toBe('RECOVERABLE');
  });

  it('several declared-but-uninstalled packages together → RECOVERABLE', () => {
    expect(
      classify(TS2307('declared-missing') + TS2307('@scope/declared-missing/server')),
    ).toBe('RECOVERABLE');
  });

  // ── COMPILE_ERROR: keep the documented fail-open policy ──

  it('a non-TS2307 error → COMPILE_ERROR', () => {
    expect(
      classify("src/lib/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable.\n"),
    ).toBe('COMPILE_ERROR');
  });

  it('MIXED — one recoverable TS2307 plus a real error → COMPILE_ERROR', () => {
    // The dangerous case: a genuine defect must never be masked by reinstalling.
    expect(
      classify(TS2307('declared-missing') + "src/lib/foo.ts(10,5): error TS2345: nope.\n"),
    ).toBe('COMPILE_ERROR');
  });

  it('unresolvable RELATIVE import → COMPILE_ERROR (a real code defect)', () => {
    expect(classify(TS2307('./missing-local.js'))).toBe('COMPILE_ERROR');
  });

  it('undeclared package → COMPILE_ERROR (missing dependency entry, not a stale install)', () => {
    expect(classify(TS2307('totally-undeclared-pkg'))).toBe('COMPILE_ERROR');
  });

  it('declared AND installed yet unresolvable → COMPILE_ERROR (npm ci would not help)', () => {
    expect(classify(TS2307('declared-installed'))).toBe('COMPILE_ERROR');
  });

  it('build failed with NO TS errors at all (OOM / tsc crash) → COMPILE_ERROR', () => {
    expect(classify('FATAL ERROR: JavaScript heap out of memory\n')).toBe('COMPILE_ERROR');
  });

  it('missing log file → COMPILE_ERROR (never guess RECOVERABLE)', () => {
    expect(runClassifier(path.join(fixtureDir, 'does-not-exist.log'))).toBe('COMPILE_ERROR');
  });
});
