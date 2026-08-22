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
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import VitestErrorShapeReporter, { errorShape, relPath } from '../../scripts/vitest-error-shape-reporter.mjs';

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
  });

  it('normalises paths so a committed or uploaded artifact is machine-independent', () => {
    expect(relPath(join(REPO, 'tests/x.test.ts'))).toBe('tests/x.test.ts');
    expect(relPath(undefined)).toBe('<unknown>');
  });

  it('records only FAILED cases — a green run yields an empty, well-formed sidecar', () => {
    const r = new VitestErrorShapeReporter();
    // `result()` is the vitest 3.x accessor; a passing case must contribute nothing.
    r.onTestCaseResult({ name: 'ok', module: { moduleId: join(REPO, 'tests/x.test.ts') }, result: () => ({ state: 'passed', errors: [] }) });
    r.onTestCaseResult({ name: 'nope', fullName: 'suite > nope', module: { moduleId: join(REPO, 'tests/x.test.ts') }, result: () => ({ state: 'failed', errors: [{ name: 'AssertionError', diff: 'd', message: 'boom' }] }) });
    const out = join(process.env.VITEST_ERROR_SHAPE_OUT_TESTDIR ?? '/tmp', `svrc-reporter-unit-${process.pid}.json`);
    process.env.VITEST_ERROR_SHAPE_OUT = out;
    r.onTestRunEnd();
    delete process.env.VITEST_ERROR_SHAPE_OUT;
    const body = JSON.parse(readFileSync(out, 'utf8'));
    expect(body.schema).toBe(1);
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]).toMatchObject({ file: 'tests/x.test.ts', name: 'suite > nope' });
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

  it('LANDING COMMIT 1 IS PRODUCER-ONLY: the classifier does not yet consume the sidecar', () => {
    // This assertion is deliberately temporary and its removal is the marker of commit 2. It pins
    // the property that makes this landing safe: the verdict path is untouched, so a reporter bug
    // cannot reach the gate.
    const wf = readFileSync(join(REPO, '.github/workflows/deploy.yml'), 'utf8');
    expect(wf, 'commit 2 flips this — and deletes this assertion with it').not.toContain('--sidecar=');
  });
});
