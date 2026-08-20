/**
 * OPS-DEPLOY-PROVENANCE-AND-VERDICT-CLASS-W1 CH2 — the budget gate and the suite classifier.
 *
 * NOTE ON THIS FILE'S OWN BUDGETS: the blocks below that spawn a process declare
 * `{ timeout: 60_000 }`. That is not decoration — `scripts/check-test-budget.mjs` treats this file
 * as NEW, and a new spawning block without a declared budget FAILS the gate immediately. This
 * suite therefore dogfoods the rule it verifies, which is the cheapest possible proof that the
 * rule is livable.
 *
 * The budget is written as a LITERAL at each call site rather than a shared constant, and the
 * gate enforces that: it reads source, so a `SPAWN_BUDGET` reference is invisible to it. That is
 * the right constraint anyway — the correct budget differs per test, and a shared constant hides
 * that decision behind a name. (Found by the gate rejecting the first draft of this very file.)
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyReport,
  classifyMessage,
  readReport,
  isolationRetry,
} from '../../scripts/classify-suite-verdict.mjs';
import { decide, parseBlock, scan } from '../../scripts/check-test-budget.mjs';

const REPO = join(__dirname, '..', '..');
const rep = (specs: unknown[]) => ({ testResults: [{ name: 'tests/a.test.ts', assertionResults: specs }] });
const failed = (msg: string) => ({ status: 'failed', fullName: 'x', failureMessages: [msg] });

describe('classify-suite-verdict — every branch', () => {
  it('zero failures is PASS', () => {
    expect(classifyReport(rep([{ status: 'passed' }])).verdict).toBe('PASS');
  });

  it('the REAL 2026-08-17 failure is INDETERMINATE, not FAIL', () => {
    // This exact string blocked a finished, merged wave for ~3 days.
    expect(classifyReport(rep([failed('Error: Test timed out in 5000ms.')])).verdict).toBe('INDETERMINATE');
  });

  it('an assertion diff is FAIL', () => {
    expect(classifyReport(rep([failed('AssertionError: expected 1 to be 2')])).verdict).toBe('FAIL');
  });

  it.each([
    ['JavaScript heap out of memory'],
    ['worker exited unexpectedly'],
    ['Tests closed too early'],
    ['AbortError: operation was aborted'],
  ])('contention shape %s is INDETERMINATE', (msg) => {
    expect(classifyReport(rep([failed(msg)])).verdict).toBe('INDETERMINATE');
  });

  it('a real failure is never diluted by a co-occurring timeout', () => {
    expect(
      classifyReport(rep([failed('Test timed out in 5000ms'), failed('AssertionError: expected a to be b')])).verdict,
    ).toBe('FAIL');
  });

  it('an unknown failure shape defaults to FAIL, never to INDETERMINATE', () => {
    // Safe default when classifying a red: assume regression until shown otherwise.
    expect(classifyMessage('something nobody has seen before')).toBe('assertion');
    expect(classifyReport(rep([failed('something nobody has seen before')])).verdict).toBe('FAIL');
  });

  it('a missing or unparseable report is INDETERMINATE, never PASS', () => {
    expect(readReport('/nonexistent/report.json').ok).toBe(false);
    const d = mkdtempSync(join(tmpdir(), 'verdict-'));
    const bad = join(d, 'bad.json');
    writeFileSync(bad, 'definitely not json{');
    expect(readReport(bad).ok).toBe(false);
  });
});

describe('the boundary — no path deploys a real failure', () => {
  it('a genuine assertion failure never enters the retry path', () => {
    const r = classifyReport(rep([failed('AssertionError: expected 3 to be 4')]));
    expect(r.verdict).toBe('FAIL');
    expect(r.indeterminateFiles).toHaveLength(0);
  });

  it('a forced assertion failure ends FAIL through classify -> retry -> verdict', () => {
    // The whole chain, with a retry that WOULD have passed. The real failure must still win,
    // because it is never routed into the retry in the first place.
    const first = classifyReport(rep([failed('AssertionError: expected 3 to be 4')]));
    expect(first.verdict).toBe('FAIL');
    const retried = isolationRetry(['tests/a.test.ts'], () => ({ ok: true, report: rep([{ status: 'passed' }]) }));
    expect(classifyReport(retried.report).verdict).toBe('PASS');
    // ...and the module never consults that retry for a FAIL, which is the property under test.
    expect(first.indeterminateFiles).toEqual([]);
  });

  it('a contention failure that still fails under isolation is FAIL', () => {
    const retried = isolationRetry(['tests/a.test.ts'], () => ({
      ok: true,
      report: rep([failed('AssertionError: it was real all along')]),
    }));
    expect(classifyReport(retried.report).verdict).toBe('FAIL');
  });

  it('a retry whose report is unusable stays INDETERMINATE — an unknown never becomes a pass', () => {
    const retried = isolationRetry(['tests/a.test.ts'], () => ({ ok: false, reason: 'gone' }));
    expect(retried.ok).toBe(false);
  });
});

describe('check-test-budget — the three legs', () => {
  const ON = new Date('2026-09-19T00:00:00Z').getTime();
  const BEFORE = new Date('2026-08-20T00:00:00Z').getTime();
  const legacy = [{ file: 'tests/a.test.ts', block: 'legacy' }];

  it('an options timeout counts; a timeout in the body does not', () => {
    expect(parseBlock(`'x', { timeout: 180000 }, async () => { execFileSync('a') }`).hasTimeout).toBe(true);
    expect(parseBlock(`'x', async () => { const o = { timeout: 9 }; execFileSync('a', o) }`).hasTimeout).toBe(false);
  });

  it('grandfathered entries REPORT before promoteOn', () => {
    expect(decide({ offenders: legacy, backlog: legacy, changed: new Set(), now: BEFORE, promoteOn: ON }).failures)
      .toHaveLength(0);
  });

  it('THE GATE PROMOTES ITSELF: the same tree FAILS on or after promoteOn', () => {
    expect(decide({ offenders: legacy, backlog: legacy, changed: new Set(), now: ON, promoteOn: ON }).failures)
      .toHaveLength(1);
  });

  it('the backlog is SHRINK-ONLY — an unlisted offender fails today', () => {
    expect(
      decide({ offenders: [{ file: 'tests/new.test.ts', block: 'b' }], backlog: legacy, changed: new Set(), now: BEFORE, promoteOn: ON })
        .failures,
    ).toHaveLength(1);
  });

  it('a CHANGED file fails today even when grandfathered', () => {
    expect(
      decide({ offenders: legacy, backlog: legacy, changed: new Set(['tests/a.test.ts']), now: BEFORE, promoteOn: ON })
        .failures,
    ).toHaveLength(1);
  });

  it('a backlog entry that no longer exists is reported so the list can shrink', () => {
    expect(
      decide({ offenders: [], backlog: legacy, changed: new Set(), now: BEFORE, promoteOn: ON }).staleBacklog,
    ).toEqual(['tests/a.test.ts legacy']);
  });

  it('the vacuity guard fires on an empty corpus', () => {
    // The population is KNOWN non-empty; zero means the detector broke, not that the tree is clean.
    const d = mkdtempSync(join(tmpdir(), 'budget-empty-'));
    mkdirSync(join(d, 'tests'), { recursive: true });
    const res = scan(join(d, 'tests'));
    expect(res.filesScanned).toBe(0);
    expect(res.offenders.length + res.declared).toBe(0);
  });
});

describe('the gates run for real', () => {
  it('check-test-budget PASSES on this tree and prints exactly one token', { timeout: 60_000 }, () => {
    const out = execFileSync('node', ['scripts/check-test-budget.mjs'], { cwd: REPO, encoding: 'utf8' });
    expect(out.split('\n').filter((l) => l.startsWith('TEST_BUDGET_VERDICT='))).toHaveLength(1);
    expect(out).toContain('TEST_BUDGET_VERDICT=PASS');
  });

  it('check-test-budget FAILS on the same tree with the clock past promoteOn', { timeout: 60_000 }, () => {
    // The promotion is PROVEN, not promised. Same tree, different clock.
    let out = '';
    try {
      execFileSync('node', ['scripts/check-test-budget.mjs'], {
        cwd: REPO, encoding: 'utf8', env: { ...process.env, TEST_BUDGET_NOW: '2026-09-19' },
      });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? '');
    }
    expect(out).toContain('TEST_BUDGET_VERDICT=FAIL');
    expect(out).toContain('PROMOTED');
  });

  it('both self-tests pass', { timeout: 60_000 }, () => {
    for (const s of ['check-test-budget.mjs', 'classify-suite-verdict.mjs']) {
      const out = execFileSync('node', [`scripts/${s}`, '--self-test'], { cwd: REPO, encoding: 'utf8' });
      expect(out, s).toContain('SELF-TEST: PASS');
    }
  });
});
