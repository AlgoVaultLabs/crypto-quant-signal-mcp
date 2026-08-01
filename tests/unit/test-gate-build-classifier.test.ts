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

// Writes a fixture install. `version === null` = the directory exists but carries no
// readable package.json, which is a real (if odd) on-disk state the classifier must
// not guess about.
function install(name: string, version: string | null): void {
  const dir = path.join(nodeModules, ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  if (version !== null) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  }
}

describe.skipIf(SKIP)('test-gate build-failure classifier', () => {
  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-gate-classifier-'));
    manifest = path.join(fixtureDir, 'package.json');
    nodeModules = path.join(fixtureDir, 'node_modules');
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        dependencies: {
          '@scope/declared-missing': '^1.0.0',
          'declared-missing': '^2.0.0',
          // Installed at 2.9.0 — BELOW the range. Both spellings of the numeric-vs-
          // lexical trap live here: "9" sorts ABOVE "20" as a string.
          'version-stale': '~2.20.0',
          '@scope/version-stale': '~2.20.0',
          // Installed at 1.10.0 — INSIDE the range, and the same trap mirrored:
          // "1.10.0" sorts BELOW "1.2.0" as a string.
          'version-ok': '^1.2.0',
        },
        devDependencies: {
          'declared-installed': '^3.0.0',
          'version-unreadable': '^1.0.0',
          // A range grammar the classifier does not decide (alias/URL/dist-tag).
          'range-exotic': 'npm:some-alias@^1.0.0',
        },
      }),
    );
    // `declared-missing` / `@scope/declared-missing` are deliberately NOT on disk.
    install('declared-installed', '3.1.0');
    install('version-stale', '2.9.0');
    install('@scope/version-stale', '2.9.0');
    install('version-ok', '1.10.0');
    install('range-exotic', '1.0.0');
    install('version-unreadable', null);
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

  // ── RECOVERABLE: installed, but at a version the manifest no longer allows ──
  //
  // OPS-TEST-GATE-VERSION-MISMATCH-W1 (2026-07-31). "Is it installed?" is not the
  // same question as "is the RIGHT one installed?", and the gap between them is a
  // whole third state the classifier used to have no name for.
  //
  // Observed during OPS-X402-SCHEME-REGISTRATION-INVARIANT-W1: package.json wanted
  // `@x402/extensions@~2.20.0` (bumped by OPS-BASE-BUILDER-CODE-W1) while the
  // checkout still held 2.9.0, which ships no `builder-code` subpath —
  //   src/lib/builder-code-constants.ts(34,8): error TS2307: Cannot find module
  //   '@x402/extensions/builder-code' or its corresponding type declarations.
  // `pkg_of_specifier` reduced the subpath correctly and the package WAS declared
  // and WAS on disk, so the old presence check answered "yes, installed" and the
  // log was filed as a genuine compile error. Auto-recovery never fired and the
  // operator ran `npm ci` by hand — which is precisely the recovery the classifier
  // exists to choose. (The gate itself behaved: INDETERMINATE/exit 2 blocked the
  // push. Only the classification was wrong.)

  it('declared + installed BELOW the declared range → RECOVERABLE', () => {
    // `version-stale` is the live pair: installed 2.9.0 against a required ~2.20.0.
    expect(classify(TS2307('version-stale'))).toBe('RECOVERABLE');
  });

  it('scoped declared + installed below the declared range → RECOVERABLE', () => {
    expect(classify(TS2307('@scope/version-stale'))).toBe('RECOVERABLE');
  });

  it('SUBPATH import against an out-of-range install → RECOVERABLE (the live shape)', () => {
    // Verbatim shape of the observed failure: a subpath that only exists in the
    // required version, against an older install of the same package.
    expect(classify(TS2307('version-stale/builder-code'))).toBe('RECOVERABLE');
  });

  // ── COMPILE_ERROR: installed at a version that IS allowed ──

  it('declared + installed + version satisfies + missing SUBPATH → COMPILE_ERROR', () => {
    // The mirror of the case above and the reason it must be a version compare and
    // not "reinstall whenever a subpath is missing": the correct version is on disk,
    // so `npm ci` changes nothing and a missing subpath is a genuine code defect.
    expect(classify(TS2307('version-ok/no-such-subpath'))).toBe('COMPILE_ERROR');
  });

  it('a satisfying install is not called stale by a LEXICAL compare — 1.10.0 satisfies ^1.2.0', () => {
    // THE numeric-vs-lexical guard, and note which direction actually catches it.
    // "1.10.0" sorts BELOW "1.2.0" as a string, so a lexical comparator declares a
    // healthy install out-of-range and reinstalls on every build — this case flips.
    // The live 2.9.0-vs-~2.20.0 pair does NOT flip under a lexical compare (it lands
    // on RECOVERABLE either way, by luck), so it cannot carry this guard; verified by
    // mutating ver_cmp to a string compare and re-running the suite.
    expect(classify(TS2307('version-ok'))).toBe('COMPILE_ERROR');
  });

  it('installed version UNREADABLE → COMPILE_ERROR (never guess a mismatch)', () => {
    // Directory on disk with no package.json. "Cannot tell" is not "stale":
    // RECOVERABLE is claimed only on a PROVEN range violation.
    expect(classify(TS2307('version-unreadable'))).toBe('COMPILE_ERROR');
  });

  it('range grammar the classifier does not decide → COMPILE_ERROR', () => {
    // `npm:`/git/file aliases, dist-tags and compound ranges are deliberately
    // undecided rather than guessed. Undecided keeps the settled behaviour.
    expect(classify(TS2307('range-exotic'))).toBe('COMPILE_ERROR');
  });

  it('MIXED — one out-of-range package plus one genuinely broken → COMPILE_ERROR', () => {
    // A real defect must never be masked by a reinstall, even when a stale-version
    // error sits next to it in the same log.
    expect(classify(TS2307('version-stale') + TS2307('version-ok/no-such-subpath'))).toBe(
      'COMPILE_ERROR',
    );
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
