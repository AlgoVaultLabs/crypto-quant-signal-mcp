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
  classifyShape,
  readReport,
  readSidecar,
  indexSidecar,
  normFile,
  isolationRetry,
} from '../../scripts/classify-suite-verdict.mjs';
import { errorShape, relPath } from '../../scripts/vitest-error-shape-reporter.mjs';
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

// OPS-SUITE-VERDICT-REPORTER-CHANNEL-W1 CH1 — the structured channel, asserted on CAPTURED artifacts.
//
// Every fixture under tests/fixtures/verdict-channel/ was produced by running a real failing test
// through the real reporters (`--reporter=json` + the error-shape reporter), never hand-typed. That
// is the rule this wave adds: a gate's fixture is captured from the channel the gate reads.
//
// REGENERATE (the sources are intentionally not kept in tests/, so they never join the suite):
//   mkdir -p /tmp/cap && cat > /tmp/cap/timeout.test.ts <<'EOF'
//   import { it } from 'vitest';
//   it('a test that exceeds its own budget', async () => { await new Promise(r => setTimeout(r, 5000)); }, 250);
//   EOF
//   VITEST_ERROR_SHAPE_OUT=tests/fixtures/verdict-channel/timeout-only.shapes.json \
//     npx vitest run <file> --reporter=json --outputFile=tests/fixtures/verdict-channel/timeout-only.report.json \
//     --reporter=./scripts/vitest-error-shape-reporter.mjs
describe('the structured channel — captured artifacts, not transcriptions', () => {
  const FX = join(REPO, 'tests/fixtures/verdict-channel');
  const load = (label: string) => {
    const r = readReport(join(FX, `${label}.report.json`)) as { ok: boolean; report?: unknown };
    const sc = readSidecar(join(FX, `${label}.shapes.json`)) as { ok: boolean; index?: Map<string, unknown[]> };
    expect(r.ok, `${label}.report.json must be present and parseable`).toBe(true);
    expect(sc.ok, `${label}.shapes.json must be present and parseable`).toBe(true);
    return { report: r.report, index: sc.index! };
  };

  it('THE FIX: a CAPTURED timeout classifies INDETERMINATE, where the string channel says FAIL', () => {
    const { report, index } = load('timeout-only');
    // The BEFORE-value, pinned. This is what shipped on 2026-08-20 and it is the defect: a real
    // timeout read as a regression, blocking a deploy that had nothing wrong with it.
    expect(classifyReport(report).verdict).toBe('FAIL');
    expect(classifyReport(report, index).verdict).toBe('INDETERMINATE');
  });

  it('the JSON report genuinely cannot carry the distinction — this is not a preference', () => {
    const raw = readFileSync(join(FX, 'timeout-only.report.json'), 'utf8');
    // Measured on vitest 3.2.4: the timeout message is replaced by a placeholder in the JSON
    // reporter. If a future vitest starts preserving it, this assertion fails and the sidecar can
    // be reconsidered — which is the point of asserting it rather than describing it in a comment.
    expect(raw).not.toMatch(/timed out/i);
    expect(raw).toContain('STACK_TRACE_ERROR');
    // ...while the sidecar, reading the source object, has the real thing.
    const shapes = JSON.parse(readFileSync(join(FX, 'timeout-only.shapes.json'), 'utf8'));
    expect(shapes.failures[0].errors[0].message).toMatch(/Test timed out in \d+ms/i);
  });

  it('a CAPTURED assertion failure stays FAIL on both channels', () => {
    const { report, index } = load('assertion-only');
    expect(classifyReport(report).verdict).toBe('FAIL');
    expect(classifyReport(report, index).verdict).toBe('FAIL');
  });

  it('a CAPTURED mixed run stays FAIL — the diff still wins over the timeout', () => {
    const { report, index } = load('mixed');
    expect(classifyReport(report, index).verdict).toBe('FAIL');
  });

  it('the string patterns are NOT redundant: a collection error has no per-test sidecar entry', () => {
    const { report, index } = load('collection-error');
    // Captured, so this is a fact about vitest rather than a claim about it: a file that cannot be
    // collected produces zero per-test results, so the structured channel has nothing to say and
    // the string channel is the only cover. Deleting INDETERMINATE_PATTERNS would blind this case.
    expect(index.size).toBe(0);
    expect(classifyReport(report, index).verdict).toBe('FAIL');
  });

  it('a DECLARED sidecar that is absent or unusable REFUSES — it never degrades quietly', () => {
    expect(readSidecar(join(REPO, 'no/such/sidecar.json')).ok).toBe(false);
    expect(readSidecar(join(REPO, 'README.md')).ok).toBe(false);        // unparseable
    expect(readSidecar(join(REPO, 'package.json')).ok).toBe(false);      // parses, wrong shape
    expect(indexSidecar({ nope: true })).toBeNull();
  });

  it('the structured fields ALONE cannot identify a timeout — the message is load-bearing', () => {
    // A plain `throw new Error('boom')` is byte-identical to a timeout in name/diff/expected/actual.
    // If a future refactor tries to classify on shape alone, this is the assertion that stops it.
    const thrown = { name: 'Error', hasDiff: false, hasExpected: false, hasActual: false, message: 'boom custom' };
    const timeout = { name: 'Error', hasDiff: false, hasExpected: false, hasActual: false, message: 'Test timed out in 250ms.' };
    expect(thrown.name).toBe(timeout.name);
    expect(classifyShape(thrown)).toBe('assertion');
    expect(classifyShape(timeout)).toBe('indeterminate');
    // A real bug with no diff is still a real bug.
    expect(classifyShape({ name: 'TypeError', message: 'Cannot read properties of null' })).toBe('assertion');
    // Positive assertion evidence can never be talked out of by message text.
    expect(classifyShape({ name: 'AssertionError', hasDiff: true, message: 'Test timed out in 250ms.' })).toBe('assertion');
  });

  it('the reporter normalises paths so a committed fixture is machine-independent', () => {
    expect(relPath(join(REPO, 'tests/x.test.ts'))).toBe('tests/x.test.ts');
    expect(normFile(join(REPO, 'tests/x.test.ts'))).toBe('tests/x.test.ts');
    // Both sides of the join agree, which is what makes file+name a usable key.
    expect(normFile(join(REPO, 'tests/x.test.ts'))).toBe(relPath(join(REPO, 'tests/x.test.ts')));
    expect(errorShape({ name: 'AssertionError', diff: '- 1\n+ 2', expected: '2', actual: '1', message: 'm' }))
      .toEqual({ name: 'AssertionError', hasDiff: true, hasExpected: true, hasActual: true, message: 'm' });
  });

  it('the reporter is registered on the CLI in deploy.yml, NOT in vitest.config.ts', () => {
    // The wiring assertion. A CLI --reporter REPLACES the config array on vitest 3.2.4, so a
    // config registration would be dark in CI — and a reporter nothing reads is the
    // check-canaries-wired hazard. Both halves are pinned here.
    const wf = readFileSync(join(REPO, '.github/workflows/deploy.yml'), 'utf8');
    expect(wf).toContain('--reporter=./scripts/vitest-error-shape-reporter.mjs');
    expect(wf).toContain('--sidecar=.vitest-error-shapes.json');
    const cfg = readFileSync(join(REPO, 'vitest.config.ts'), 'utf8');
    const live = cfg.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(live, 'a reporters: key here would un-wire CI — see the comment in that file').not.toMatch(/reporters\s*:/);
  });
});
