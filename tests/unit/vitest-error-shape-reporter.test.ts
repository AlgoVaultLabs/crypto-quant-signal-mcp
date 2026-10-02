/**
 * OPS-SUITE-VERDICT-REPORTER-CHANNEL-W1 — LANDING COMMIT 1 of 2: the PRODUCER.
 *
 * This commit ships the reporter and wires it into CI, and deliberately leaves the classifier on
 * the string channel. The sidecar is written and uploaded and consumed by NOTHING, so the verdict
 * path — the gate every concurrent session's deploy passes through — is byte-identical to before.
 * A defect in a brand-new reporter therefore cannot take that path down. The consumer flip is the
 * next commit, and it lands only after a real CI run has produced a sidecar to read.
 *
 * That ordering is the same "add before you remove" discipline the Data Integrity law already
 * applies to public data, pointed at a gate instead of a dashboard.
 *
 * WHY THERE IS NO "SPAWN VITEST AND CHECK IT WROTE" TEST HERE. That is precisely what commit 1's
 * post-merge CI run proves, on the real runner, which is the only place the claim matters — and a
 * test that spawns vitest to write a shared repo artifact would race any test that reads it under
 * the parallel runner. The reporter's LOGIC is unit-tested below; its EXECUTION is proven by the
 * artifact CI uploads.
 *
 * OPS-SUITE-VERDICT-NESTED-KEY-W1 adds ONE spawning test, and it is not the one ruled out above: it
 * runs vitest with `--root` in a fresh temp dir and writes both reports THERE, so no repo artifact
 * is touched and nothing can race it. It asserts the thing no captured fixture can: that on the
 * vitest INSTALLED NOW, both channels still derive the same identity for a nested test. A captured
 * fixture is frozen at the vitest that captured it; a lockfile bump that changed either channel
 * would leave every fixture green.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import VitestErrorShapeReporter, { SIDECAR_SCHEMA, errorShape, relPath } from '../../scripts/vitest-error-shape-reporter.mjs';
import { normFile } from '../../scripts/lib/vitest-test-identity.mjs';
import { classifyReport, extractFailures, readSidecar } from '../../scripts/classify-suite-verdict.mjs';

const REPO = join(__dirname, '..', '..');

describe('vitest-error-shape-reporter — the record it writes', () => {
  it('captures the fields that distinguish a real failure, and only those', () => {
    expect(errorShape({ name: 'AssertionError', diff: '- 1\n+ 2', expected: '2', actual: '1', message: 'expected 1 to be 2' }))
      .toEqual({ name: 'AssertionError', hasDiff: true, hasExpected: true, hasActual: true, message: 'expected 1 to be 2' });
    expect(errorShape({ name: 'Error', message: 'Test timed out in 250ms.' }))
      .toEqual({ name: 'Error', hasDiff: false, hasExpected: false, hasActual: false, message: 'Test timed out in 250ms.' });
  });

  it('stores the DIFF as a boolean, never the payload', () => {
    // A diff is rendered assertion VALUES. This artifact is committed as a fixture and uploaded as
    // a CI artifact; putting fixture data in it buys nothing for classification and widens what a
    // build artifact carries.
    const shaped = errorShape({ name: 'AssertionError', diff: 'SECRET-LOOKING-VALUE', message: 'm' });
    expect(shaped.hasDiff).toBe(true);
    expect(JSON.stringify(shaped)).not.toContain('SECRET-LOOKING-VALUE');
  });

  it('survives a malformed error object without throwing', () => {
    // A reporter must never take the run down. Null/undefined/garbage all shape cleanly.
    expect(() => errorShape(undefined)).not.toThrow();
    expect(errorShape(undefined)).toEqual({ name: null, hasDiff: false, hasExpected: false, hasActual: false, message: '' });
    expect(errorShape({}).message).toBe('');
    // vitest's suite `state()` throws on a state it does not know. The reporter skips the suite
    // (the classifier then reads that file as a JOIN MISS — loud, never PASS) instead of dying.
    const r = new VitestErrorShapeReporter();
    expect(() => r.onTestSuiteResult({ state: () => { throw new Error('Unknown suite state: x'); }, errors: () => [] })).not.toThrow();
    expect(() => r.onTestSuiteResult(undefined)).not.toThrow();
  });

  it('normalises paths so a committed or uploaded artifact is machine-independent', () => {
    expect(relPath(join(REPO, 'tests/x.test.ts'))).toBe('tests/x.test.ts');
    expect(relPath(undefined)).toBe('<unknown>');
    // ONE function, not two that happen to agree. Two once disagreed (0fed536e).
    expect(relPath).toBe(normFile);
  });

  it('records only FAILED cases — a green run yields an empty, well-formed sidecar', () => {
    const r = new VitestErrorShapeReporter();
    // Shaped like the vitest 3.x reporter API: `result()` accessor, `parent` chain up to the module.
    const module = { type: 'module', moduleId: join(REPO, 'tests/x.test.ts') };
    const outer = { type: 'suite', name: 'outer', parent: module, module };
    const inner = { type: 'suite', name: 'inner', parent: outer, module };
    r.onTestCaseResult({ type: 'test', name: 'ok', parent: inner, module, result: () => ({ state: 'passed', errors: [] }) });
    r.onTestCaseResult({
      type: 'test', name: 'nope', fullName: 'outer > inner > nope', parent: inner, module,
      result: () => ({ state: 'failed', errors: [{ name: 'AssertionError', diff: 'd', message: 'boom' }] }),
    });
    // A suite whose CHILDREN failed is 'failed' with no errors of its own — not a hook failure.
    r.onTestSuiteResult({ ...inner, state: () => 'failed', errors: () => [] });
    // A suite whose own hook threw IS one.
    r.onTestSuiteResult({ ...outer, state: () => 'failed', errors: () => [{ name: 'Error', message: 'setup exploded' }] });
    const out = join(process.env.VITEST_ERROR_SHAPE_OUT_TESTDIR ?? '/tmp', `svrc-reporter-unit-${process.pid}.json`);
    process.env.VITEST_ERROR_SHAPE_OUT = out;
    r.onTestRunEnd();
    delete process.env.VITEST_ERROR_SHAPE_OUT;
    const body = JSON.parse(readFileSync(out, 'utf8'));
    expect(body.schema).toBe(SIDECAR_SCHEMA);
    expect(SIDECAR_SCHEMA).toBe(2);
    expect(body.failures).toHaveLength(2);
    // The identity is the title PATH, never the rendered `fullName` vitest offers.
    expect(body.failures[0]).toMatchObject({ kind: 'test', file: 'tests/x.test.ts', titlePath: ['outer', 'inner', 'nope'] });
    expect(body.failures[1]).toMatchObject({ kind: 'suite', file: 'tests/x.test.ts', titlePath: ['outer'] });
  });
});

describe('the identity both channels key on — measured on the vitest installed NOW', () => {
  it('a nested timeout written by real vitest joins its sidecar entry, and classifies INDETERMINATE', { timeout: 60_000 }, () => {
    // The 2026-10-02 defect, run live: a timeout two `describe`s deep, with a suite name that
    // contains a space so the old " "-join would also have been ambiguous. Both reports land in a
    // temp root; nothing in the repo is written.
    const root = mkdtempSync(join(tmpdir(), 'svrc-live-identity-'));
    try {
      writeFileSync(
        join(root, 'live.test.ts'),
        "describe('outer a b', () => { describe('inner', () => { it('t', async () => { await new Promise((r) => setTimeout(r, 3000)); }, 100); }); });\n",
      );
      const report = join(root, 'report.json');
      const shapes = join(root, 'shapes.json');
      try {
        execFileSync(
          process.execPath,
          [
            join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', '--root', root, '--globals',
            '--reporter=json', `--outputFile=${report}`, `--reporter=${join(REPO, 'scripts/vitest-error-shape-reporter.mjs')}`,
          ],
          { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VITEST_ERROR_SHAPE_OUT: shapes }, timeout: 50_000 },
        );
      } catch {
        // the run fails by design; the two reports are the subject
      }
      const body = JSON.parse(readFileSync(report, 'utf8'));
      const sc = readSidecar(shapes) as { ok: boolean; index?: Map<string, unknown> };
      expect(sc.ok, 'the live sidecar must be usable').toBe(true);
      const failures = extractFailures(body);
      expect(failures).toHaveLength(1);
      expect(failures[0].titlePath).toEqual(['outer a b', 'inner', 't']);
      const res = classifyReport(body, sc.index);
      // Every failure joined (no miss), and every sidecar entry was claimed.
      expect(res.unjoined).toEqual([]);
      expect(res.unmatchedEntries).toEqual([]);
      expect(res.failures[0].channel).toBe('structured');
      expect(res.verdict).toBe('INDETERMINATE');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the reporter is wired where it actually runs', () => {
  it('is registered on the CLI in deploy.yml — NOT in vitest.config.ts', () => {
    // Measured on vitest 3.2.4: a CLI `--reporter` flag REPLACES `test.reporters[]` rather than
    // appending to it, and CI already passes `--reporter=default --reporter=json`. A reporter
    // registered in the config would be green locally, green in its own self-test, and NEVER RUN
    // IN CI. Both halves of that are asserted so neither can drift back.
    const wf = readFileSync(join(REPO, '.github/workflows/deploy.yml'), 'utf8');
    expect(wf).toContain('--reporter=./scripts/vitest-error-shape-reporter.mjs');
    const cfg = readFileSync(join(REPO, 'vitest.config.ts'), 'utf8');
    const live = cfg.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(live, 'a reporters: key here would un-wire CI — see the comment in that file').not.toMatch(/reporters\s*:/);
  });

  it('CI retains the evidence — both artifacts are uploaded even on a red run', () => {
    const wf = readFileSync(join(REPO, '.github/workflows/deploy.yml'), 'utf8');
    expect(wf).toContain('actions/upload-artifact');
    expect(wf).toContain('.vitest-error-shapes.json');
    // `if: always()` — a FAIL/INDETERMINATE run is exactly the one whose artifact you need.
    const upload = wf.slice(wf.indexOf('Upload suite report'));
    expect(upload.slice(0, 400)).toContain('if: always()');
  });

});
