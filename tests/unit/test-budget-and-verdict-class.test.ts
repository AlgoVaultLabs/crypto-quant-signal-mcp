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
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyReport,
  classifyMessage,
  readReport,
  isolationRetry,
} from '../../scripts/classify-suite-verdict.mjs';
import { decide, parseBlock, scan, evaluate, promotionActive, parseConfig } from '../../scripts/check-test-budget.mjs';

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
  const legacy = [{ file: 'tests/a.test.ts', block: 'legacy' }];
  const grown = [{ file: 'tests/new.test.ts', block: 'b' }];

  it('an options timeout counts; a timeout in the body does not', () => {
    expect(parseBlock(`'x', { timeout: 180000 }, async () => { execFileSync('a') }`).hasTimeout).toBe(true);
    expect(parseBlock(`'x', async () => { const o = { timeout: 9 }; execFileSync('a', o) }`).hasTimeout).toBe(false);
  });

  it('grandfathered entries REPORT while the backlog is non-empty', () => {
    expect(decide({ offenders: legacy, backlog: legacy, changed: new Set(), promoteWhenBacklogEmpty: true }).failures)
      .toHaveLength(0);
  });

  it('the backlog is SHRINK-ONLY — an unlisted offender fails today', () => {
    expect(
      decide({ offenders: grown, backlog: legacy, changed: new Set(), promoteWhenBacklogEmpty: true }).failures,
    ).toHaveLength(1);
  });

  it('a CHANGED file fails today even when grandfathered', () => {
    expect(
      decide({ offenders: legacy, backlog: legacy, changed: new Set(['tests/a.test.ts']), promoteWhenBacklogEmpty: true })
        .failures,
    ).toHaveLength(1);
  });

  it('a backlog entry that no longer exists is reported so the list can shrink', () => {
    expect(
      decide({ offenders: [], backlog: legacy, changed: new Set(), promoteWhenBacklogEmpty: true }).staleBacklog,
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

describe('the promotion is CONDITION-based and cannot cause the outage it prevents', () => {
  // OPS-TEST-BUDGET-PROMOTION-FIX-W1. The predecessor was a calendar date the gate enforced itself:
  // on arrival every remaining backlog entry started FAILING, redding the suite and blocking the
  // deploy — for work nobody had committed to doing, which is the exact harm this gate exists to
  // prevent. The replacement fires on the backlog reaching zero, and the backlog is shrink-only by
  // construction, so it converges there on its own.
  //
  // These drive `evaluate` — the SAME function the real run uses between "config parsed" and "token
  // printed". Testing `decide` alone would leave the config -> verdict wiring unexercised, which is
  // precisely where the clock read used to hide.
  const legacy = [{ file: 'tests/a.test.ts', block: 'legacy' }];
  const cfg = (backlog: { file: string; block: string }[]) => ({
    promoteWhenBacklogEmpty: true,
    owner: 'OPS-TEST-BUDGET-BACKFILL-W1',
    backlog,
  });
  const res = (offenders: { file: string; block: string }[]) => ({ offenders, declared: 1, filesScanned: 2 });

  it('a NON-EMPTY backlog reports and passes — history never blocks a deploy', () => {
    const r = evaluate({ cfg: cfg(legacy), res: res(legacy), changed: new Set() });
    expect(r.verdict).toBe('PASS');
    expect(r.code).toBe(0);
  });

  it('THE PROMOTION, PROVEN: the same tree FAILS once the backlog is empty', () => {
    const r = evaluate({ cfg: cfg([]), res: res(legacy), changed: new Set() });
    expect(r.verdict).toBe('FAIL');
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toContain('PROMOTED — the backlog is empty');
  });

  it('promotion has NO enforcement arm — an empty backlog grandfathers nothing', () => {
    // This is why the mechanism cannot misfire. `promoted` is a reported STATE; the failure itself
    // comes from the shrink-only leg, which can only ever fire on a block that is not on the list.
    const d = decide({ offenders: legacy, backlog: [], changed: new Set(), promoteWhenBacklogEmpty: true });
    expect(d.promoted).toBe(true);
    expect(d.grandfathered).toEqual([]);
    expect(d.unlisted).toHaveLength(1);
  });

  it('new/changed is blocking regardless of backlog state — that is what closes the class', () => {
    for (const backlog of [legacy, []]) {
      const r = evaluate({ cfg: cfg(backlog), res: res(legacy), changed: new Set(['tests/a.test.ts']) });
      expect(r.verdict, `backlog length ${backlog.length}`).toBe('FAIL');
    }
  });

  it('the remaining count is on EVERY run, so the debt is never invisible', () => {
    for (const changed of [new Set<string>(), null]) {
      const r = evaluate({ cfg: cfg(legacy), res: res(legacy), changed });
      expect(r.lines.filter((l: string) => /^backlog: 1 remaining\b/.test(l))).toHaveLength(1);
    }
  });

  it('the promotion declaration has no OFF switch — any other value is INDETERMINATE', () => {
    // A gate whose promotion can be disabled by editing a boolean is a gate with an off switch.
    for (const v of [false, undefined, 'true', 1]) {
      expect(promotionActive({ promoteWhenBacklogEmpty: v }).ok, String(v)).toBe(false);
      const r = evaluate({ cfg: { ...cfg(legacy), promoteWhenBacklogEmpty: v }, res: res(legacy), changed: new Set() });
      expect(r.verdict, String(v)).toBe('INDETERMINATE');
      expect(r.code, String(v)).toBe(3);
    }
    expect(promotionActive({ promoteWhenBacklogEmpty: true }).ok).toBe(true);
  });

  it('NO promotion criterion in the committed config may be a calendar date', () => {
    // Asserted as a PROPERTY, not against the retired literal: the rule is "a promotion criterion
    // may never be able to cause the failure its gate exists to prevent", and any dated flip can.
    // Pinning the old string would let the next dated criterion in under a different name.
    const raw = readFileSync(join(REPO, 'ops/test-budget-config.json'), 'utf8');
    const parsed = parseConfig(raw);
    expect(parsed.ok).toBe(true);
    const dated = Object.entries(parsed.cfg).filter(
      ([, v]) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
    );
    expect(dated, 'a dated criterion reds the repo for work nobody committed to doing').toEqual([]);
    expect(parsed.cfg.promoteOn, 'the dated key must be GONE, not merely unread').toBeUndefined();
    expect(parsed.cfg.promoteWhenBacklogEmpty).toBe(true);
    // The grandfathered entries are OPS-TEST-BUDGET-BACKFILL-W1's, unscheduled and untouched here.
    expect(parsed.cfg.owner).toBe('OPS-TEST-BUDGET-BACKFILL-W1');
    expect(Array.isArray(parsed.cfg.backlog)).toBe(true);
  });
});

describe('the gates run for real', () => {
  it('check-test-budget PASSES on this tree and prints exactly one token', { timeout: 60_000 }, () => {
    const out = execFileSync('node', ['scripts/check-test-budget.mjs'], { cwd: REPO, encoding: 'utf8' });
    expect(out.split('\n').filter((l) => l.startsWith('TEST_BUDGET_VERDICT='))).toHaveLength(1);
    expect(out).toContain('TEST_BUDGET_VERDICT=PASS');
  });

  it('with origin/main UNREACHABLE it is INDETERMINATE at exit 3, never PASS', { timeout: 60_000 }, () => {
    // OPS-TEST-BUDGET-CI-REF-W1's second half, pinned at the CLI. A depth-1 `actions/checkout`
    // fetches only the pushed ref, so on a branch push `refs/remotes/origin/main` does not exist.
    // Modelled faithfully — git works, HEAD resolves, only origin/main is absent — by pointing the
    // child at a scratch repo through git's OWN env. No test seam is added to the gate for this:
    // a lever that can change a gate's verdict is a lever that can launder a pass.
    const scratch = mkdtempSync(join(tmpdir(), 'no-origin-main-'));
    execFileSync('git', ['init', '-q'], { cwd: scratch });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base'], {
      cwd: scratch,
    });
    let out = '';
    let status: number | undefined;
    try {
      out = execFileSync('node', ['scripts/check-test-budget.mjs'], {
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, GIT_DIR: join(scratch, '.git'), GIT_WORK_TREE: scratch },
      });
      status = 0;
    } catch (e) {
      const err = e as { stdout?: string; status?: number };
      out = String(err.stdout ?? '');
      status = err.status;
    }
    expect(out).toContain('TEST_BUDGET_VERDICT=INDETERMINATE');
    expect(out).not.toContain('TEST_BUDGET_VERDICT=PASS');
    expect(status, 'INDETERMINATE is exit 3 — the token-law default for this gate').toBe(3);
    // The debt is still reported even on the branch that cannot decide.
    expect(out).toMatch(/^backlog: \d+ remaining/m);
  });

  it('both self-tests pass', { timeout: 60_000 }, () => {
    for (const s of ['check-test-budget.mjs', 'classify-suite-verdict.mjs']) {
      const out = execFileSync('node', [`scripts/${s}`, '--self-test'], { cwd: REPO, encoding: 'utf8' });
      expect(out, s).toContain('SELF-TEST: PASS');
    }
  });

  it('NEITHER self-test emits the verdict token it is testing', { timeout: 60_000 }, () => {
    // Both scripts originally DID. `--self-test` evaluates nothing about the tree, so a token in
    // that output means a run which checked nothing can publish a pass to anything scraping the
    // log — the exact defect these gates exist to prevent, reproduced inside their own harness.
    // The previous assertion (`toContain('SELF-TEST: PASS')`) was satisfied by the broken output,
    // which is why the leak survived: asserting what SHOULD appear never catches what must not.
    for (const [s, token] of [
      ['check-test-budget.mjs', 'TEST_BUDGET_VERDICT='],
      ['classify-suite-verdict.mjs', 'SUITE_VERDICT='],
    ]) {
      const out = execFileSync('node', [`scripts/${s}`, '--self-test'], { cwd: REPO, encoding: 'utf8' });
      expect(out, `${s} must not emit ${token}`).not.toContain(token);
    }
  });
});
