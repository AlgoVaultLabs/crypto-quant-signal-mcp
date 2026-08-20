/**
 * OPS-DEPLOY-PROVENANCE-AND-VERDICT-CLASS-W1 CH4 — the blame classifier, graded against the one
 * case whose answer we actually know, plus the recovery guards.
 *
 * The graded case is NOT a hand-typed fixture. `graphTouchers` is computed by running git over the
 * real DAG at test time, so the test grades the classifier against history rather than against my
 * recollection of it. If someone rewrites that history, this test should notice.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  classifyDrift,
  decideRecovery,
  attemptsFor,
  recordAttempt,
  BEHIND_GRACE_MS,
} from '../../ops/monitoring/deploy-drift-canary.mjs';

const REPO = join(__dirname, '..', '..');

/** The last green deploy before the 2026-08-17 red, and the head of the delta that contained it. */
const LAST_GREEN = '9f44c72';
const DELTA_HEAD = 'dcdf9f6';
/** The failing test on 2026-08-17 and its module. This wave must not WRITE these; reading is fine. */
const FAILING_GRAPH = ['tests/x402-nudge.test.ts', 'src/lib/x402-nudge.ts'];

function realGraphTouchers(): string[] {
  return execFileSync(
    'git',
    ['log', '--format=%h', '--reverse', `${LAST_GREEN}..${DELTA_HEAD}`, '--', ...FAILING_GRAPH],
    { cwd: REPO, encoding: 'utf8' },
  )
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

describe('THE GRADED CASE — 2026-08-17, prod at 9f44c72, main red', () => {
  it('names another wave as the owner, not the deploying session', { timeout: 60_000 }, () => {
    const r = classifyDrift({
      prodSha: 'a'.repeat(40),
      mainHead: 'b'.repeat(40),
      suiteVerdict: 'FAIL',
      failingFiles: ['tests/x402-nudge.test.ts'],
      graphTouchers: realGraphTouchers(),
      // PRICING-BOT-DELIVERY-METERING-W1's own commit — the session that was blocked.
      sessionCommits: ['dcdf9f6'],
    });
    expect(r.verdict).toBe('DRIFT_BLOCKED_OWNED');
    expect(r.owner).toBeTruthy();
  });

  it('the owner resolves to OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1', { timeout: 60_000 }, () => {
    // The wave attribution is the operator-actionable output, and it is what status.md asserted
    // by hand on the day. This is the assertion that must hold.
    const owner = classifyDrift({
      prodSha: 'a'.repeat(40),
      mainHead: 'b'.repeat(40),
      suiteVerdict: 'FAIL',
      failingFiles: ['tests/x402-nudge.test.ts'],
      graphTouchers: realGraphTouchers(),
      sessionCommits: ['dcdf9f6'],
    }).owner as string;
    const subject = execFileSync('git', ['log', '--format=%s', '-1', owner], { cwd: REPO, encoding: 'utf8' });
    expect(subject).toContain('OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1');
  });

  it('THE SPEC GRADE AND THE SPEC RULE DISAGREE, and the rule is the one implemented', { timeout: 60_000 }, () => {
    // The chapter grades this case as owner=08edfd1. But 08edfd1 touches NEITHER file in the
    // failing graph, while cf2992c modifies both (+28 in the module, +81 in the test) — and the
    // eventual fix was "the compile-lock test must own its time budget", i.e. the test outgrew it.
    //
    // 08edfd1 is simply the commit whose deploy RUN failed at 06:47, which is how it got named in
    // status.md. That is a weaker criterion than the rule the chapter itself states ("owner = first
    // commit touching that graph after the last green"). Both resolve to the same WAVE, which is
    // the output an operator acts on. Pinned here so the divergence is a recorded decision rather
    // than a silent one.
    const touchers = realGraphTouchers();
    expect(touchers).toContain('cf2992c');
    expect(touchers).not.toContain('08edfd1');

    const touchedBy08 = execFileSync(
      'git',
      ['show', '--stat', '--format=', '08edfd1', '--', ...FAILING_GRAPH],
      { cwd: REPO, encoding: 'utf8' },
    ).trim();
    expect(touchedBy08).toBe('');
  });
});

describe('the classifier refuses to guess', () => {
  const base = { prodSha: 'a'.repeat(40), mainHead: 'b'.repeat(40), failingFiles: [] };

  it('unreadable provenance is INDETERMINATE, never "in sync"', () => {
    expect(classifyDrift({ ...base, prodSha: null }).verdict).toBe('DRIFT_INDETERMINATE');
    expect(classifyDrift({ ...base, mainHead: null }).verdict).toBe('DRIFT_INDETERMINATE');
  });

  it('a red that nothing in the delta explains names NOBODY', () => {
    // Flake, infra, or an upstream dependency. Inventing a culprit here would be worse than
    // saying "I do not know" — someone would be sent to fix a commit that is not the cause.
    const r = classifyDrift({ ...base, suiteVerdict: 'FAIL', graphTouchers: [] });
    expect(r.verdict).toBe('DRIFT_INDETERMINATE');
    expect(r.owner).toBeUndefined();
  });

  it('a session that merely deployed after someone else owns nothing', () => {
    expect(
      classifyDrift({ ...base, suiteVerdict: 'FAIL', graphTouchers: ['aaa', 'bbb'], sessionCommits: ['bbb'] }).verdict,
    ).toBe('DRIFT_BLOCKED_OWNED');
  });

  it('but a session whose own commits are the whole graph owns it', () => {
    expect(
      classifyDrift({ ...base, suiteVerdict: 'FAIL', graphTouchers: ['bbb'], sessionCommits: ['bbb'] }).verdict,
    ).toBe('DRIFT_BLOCKED_MINE');
  });
});

describe('bounded recovery — the negative paths are the point', () => {
  const ok = {
    verdict: 'DRIFT_RECOVERABLE',
    suiteVerdict: 'PASS',
    isAncestor: true,
    differs: true,
    behindMs: BEHIND_GRACE_MS + 1,
    attemptsToday: 0,
    msSinceLastAttempt: Infinity,
  };

  it('acts only when EVERY guard holds', () => {
    expect(decideRecovery(ok).act).toBe(true);
  });

  it.each([
    ['a blocked verdict', { verdict: 'DRIFT_BLOCKED_OWNED' }],
    ['my own blocked verdict', { verdict: 'DRIFT_BLOCKED_MINE' }],
    ['an indeterminate verdict', { verdict: 'DRIFT_INDETERMINATE' }],
    ['a red suite', { suiteVerdict: 'FAIL' }],
    ['an indeterminate suite', { suiteVerdict: 'INDETERMINATE' }],
    ['a non-ancestor prod sha', { isAncestor: false }],
    ['no actual difference', { differs: false }],
    ['still inside the 30m grace', { behindMs: 60_000 }],
    ['the daily attempt budget spent', { attemptsToday: 2 }],
    ['inside the attempt cooldown', { msSinceLastAttempt: 60_000 }],
  ])('REFUSES on %s', (_label, override) => {
    const d = decideRecovery({ ...ok, ...override });
    expect(d.act).toBe(false);
    expect(d.reason).toBeTruthy(); // a refusal that does not say why is unauditable
  });

  it('the attempt budget is per UTC day and per repo', () => {
    const now = Date.parse('2026-08-20T23:50:00Z');
    let led = recordAttempt({}, 'signal', now);
    led = recordAttempt(led, 'signal', now);
    expect(attemptsFor(led, 'signal', now).attemptsToday).toBe(2);
    // A different repo is unaffected...
    expect(attemptsFor(led, 'bot', now).attemptsToday).toBe(0);
    // ...and the next UTC day resets, 20 minutes later across the boundary.
    expect(attemptsFor(led, 'signal', now + 20 * 60 * 1000).attemptsToday).toBe(0);
  });

  it('an exhausted budget blocks even a perfectly healthy recovery', () => {
    const now = Date.parse('2026-08-20T12:00:00Z');
    let led = recordAttempt({}, 'signal', now);
    led = recordAttempt(led, 'signal', now + ATTEMPT_GAP);
    const { attemptsToday, msSinceLastAttempt } = attemptsFor(led, 'signal', now + 2 * ATTEMPT_GAP);
    expect(decideRecovery({ ...ok, attemptsToday, msSinceLastAttempt }).act).toBe(false);
  });
});

const ATTEMPT_GAP = 30 * 60 * 1000;

describe('the canary self-test runs and does not leak a verdict token', () => {
  it('passes, and prints no DRIFT_VERDICT=', { timeout: 60_000 }, () => {
    const out = execFileSync('node', ['ops/monitoring/deploy-drift-canary.mjs', '--self-test'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(out).toContain('SELF-TEST: PASS');
    expect(out).not.toContain('DRIFT_VERDICT=');
  });
});
