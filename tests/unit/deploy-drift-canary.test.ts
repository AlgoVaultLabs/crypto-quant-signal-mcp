/**
 * OPS-DEPLOY-PROVENANCE-AND-VERDICT-CLASS-W1 CH4 — the blame classifier, graded against the one
 * case whose answer we actually know, plus the recovery guards.
 *
 * The graded case is NOT hand-authored: it was GENERATED from the real DAG and committed as
 * tests/fixtures/blame-classifier-graded-case.json, and a live cross-check re-derives it from git
 * whenever the clone is deep enough — so it grades against history, not against my recollection,
 * and cannot go stale silently.
 *
 * It reads from a committed fixture rather than from git directly because the first version did
 * read git directly: it passed locally and BLOCKED THE DEPLOY in CI, where the checkout is shallow
 * and the graded range does not exist. A graded test that only works on a full clone is not graded
 * where it matters.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyDrift,
  decideRecovery,
  attemptsFor,
  recordAttempt,
  BEHIND_GRACE_MS,
  BADGE_URL,
  VERDICTS,
  HEALTHY_VERDICTS,
  parseBadgeTitle,
  parsePathsIgnore,
  isNonDeployingDelta,
  matchesPattern,
  renderAlertBody,
} from '../../ops/monitoring/deploy-drift-canary.mjs';

const REPO = join(__dirname, '..', '..');

/**
 * The graded case, GENERATED from real history and committed — see the fixture's own _comment.
 *
 * It is committed because CI checks out SHALLOW: the first version of this test read the range
 * straight from git, passed locally, and failed the deploy in CI with "unknown revision". A graded
 * test that only works on a full clone is not graded where it matters.
 */
const FX = JSON.parse(
  readFileSync(join(REPO, 'tests/fixtures/blame-classifier-graded-case.json'), 'utf8'),
) as {
  last_green: string; delta_head: string; failing_graph: string[];
  graph_touchers_oldest_first: string[]; expected_owner_commit: string;
  expected_owner_wave: string; spec_graded_owner: string; session_commits: string[];
};

/** True only in a clone deep enough to contain the graded range. */
function hasDeepHistory(): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${FX.delta_head}^{commit}`], { cwd: REPO, stdio: 'ignore' });
    execFileSync('git', ['cat-file', '-e', `${FX.last_green}^{commit}`], { cwd: REPO, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function liveGraphTouchers(): string[] {
  return execFileSync(
    'git',
    // --abbrev=7 is REQUIRED, not stylistic. `%h` honours core.abbrev, which defaults to `auto`
    // and scales with the repository's object count — so the SAME commit renders 7 chars in a
    // developer clone and 8 in CI's fully-packed one. The fixture below pins 7-char shas, so
    // without this the comparison comes down to how the repo happens to be packed.
    //
    // It went unnoticed because this test SKIPPED itself on CI's shallow checkout; giving the
    // Postgres lane full history (OPS-TEST-BUDGET-CI-REF-W1) ran it for the first time and it
    // failed on `['cf2992cf'] !== ['cf2992c']` — a latent defect surfaced, not a new one. Pinning
    // the abbreviation length is the same rule as recording an instrument beside a measurement.
    ['log', '--abbrev=7', '--format=%h', '--reverse', `${FX.last_green}..${FX.delta_head}`, '--', ...FX.failing_graph],
    { cwd: REPO, encoding: 'utf8' },
  )
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
}

const graded = (over: Record<string, unknown> = {}) =>
  classifyDrift({
    prodSha: 'a'.repeat(40),
    mainHead: 'b'.repeat(40),
    suiteVerdict: 'FAIL',
    failingFiles: [FX.failing_graph[0]],
    graphTouchers: FX.graph_touchers_oldest_first,
    sessionCommits: FX.session_commits,
    ...over,
  });

describe('THE GRADED CASE — 2026-08-17, prod at 9f44c72, main red', () => {
  it('names another wave as the owner, not the deploying session', () => {
    const r = graded();
    expect(r.verdict).toBe('DRIFT_BLOCKED_OWNED');
    expect(r.owner).toBe(FX.expected_owner_commit);
  });

  it('the owner resolves to OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1', () => {
    // The wave attribution is the operator-actionable output, and it is what status.md asserted by
    // hand on the day. This is the assertion that must hold.
    expect(FX.expected_owner_wave).toBe('OPS-QUOTA-METER-SURFACE-CONFORMANCE-W1');
  });

  it('THE SPEC GRADE AND THE SPEC RULE DISAGREE, and the rule is the one implemented', () => {
    // The chapter grades this case as owner=08edfd1. But 08edfd1 touches NEITHER file in the
    // failing graph, while cf2992c modifies both (+28 in the module, +81 in the test) — and the
    // eventual fix was "the compile-lock test must own its time budget", i.e. the test outgrew it.
    // 08edfd1 is the commit whose deploy RUN failed at 06:47, a weaker criterion than the rule the
    // chapter itself states. Both resolve to the same WAVE. Pinned so the divergence is a recorded
    // decision rather than a silent one.
    expect(FX.graph_touchers_oldest_first).toContain('cf2992c');
    expect(FX.graph_touchers_oldest_first).not.toContain(FX.spec_graded_owner);
  });

  it('the fixture still matches real history (skipped on a shallow clone)', { timeout: 60_000 }, () => {
    if (!hasDeepHistory()) {
      // CI checks out shallow. Asserting here would fail for a reason that says nothing about the
      // classifier — and silently REGENERATING would defeat the point of pinning it.
      expect(FX.graph_touchers_oldest_first.length).toBeGreaterThan(0);
      return;
    }
    expect(liveGraphTouchers()).toEqual(FX.graph_touchers_oldest_first);
    const subject = execFileSync('git', ['log', '--format=%s', '-1', FX.expected_owner_commit], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(subject).toContain(FX.expected_owner_wave);
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

/* ══════════════ OPS-DEPLOY-DRIFT-VERDICT-LEG-W1 ══════════════
 *
 * The --self-test is hermetic: it feeds classifyDrift a hand-written 3-pattern list. It is
 * therefore structurally blind to exactly what its own seam replaces — the REAL deploy.yml.
 * Everything below reads the committed file, so a paths-ignore edit, a workflow rename, or a
 * pattern shape the matcher does not implement fails HERE rather than going dark on the host.
 */
const ROOT = join(__dirname, '../..');
const DEPLOY_YML = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');

describe('the safety property — a branch-latest signal can never authorise recovery', () => {
  it('no laneHealth x nonDeploying combination reaches DRIFT_RECOVERABLE', () => {
    const base = { prodSha: 'a'.repeat(40), mainHead: 'b'.repeat(40) };
    for (const laneHealth of [null, 'passing', 'failing', 'unknown', 'something-new'])
      for (const nonDeploying of [null, true, false])
        expect(classifyDrift({ ...base, laneHealth, nonDeploying }).verdict).not.toBe('DRIFT_RECOVERABLE');
  });

  it('production never supplies the ONE input that could — suiteVerdict is pinned null in main()', () => {
    const src = readFileSync(join(ROOT, 'ops/monitoring/deploy-drift-canary.mjs'), 'utf8');
    const mainBody = src.slice(src.indexOf('function main()'));
    expect(mainBody).toMatch(/suiteVerdict:\s*null,/);
    // If a future edit reintroduces a per-SHA reader, it must re-argue this property.
    expect(mainBody).not.toMatch(/suiteVerdict:\s*read/);
  });

  it('every declared verdict is either healthy or pages — no third, silent category', () => {
    for (const v of VERDICTS) expect(typeof HEALTHY_VERDICTS.has(v)).toBe('boolean');
    expect([...HEALTHY_VERDICTS].every((v) => (VERDICTS as readonly string[]).includes(v))).toBe(true);
  });
});

describe('the REAL deploy.yml — what the hermetic self-test cannot see', () => {
  it('paths-ignore parses out of the committed workflow, and is not empty', () => {
    const got = parsePathsIgnore(DEPLOY_YML);
    expect(got).not.toBeNull();
    expect(got!.length).toBeGreaterThan(0);
    expect(got).toContain('ops/monitoring/**');
  });

  it('every committed pattern is one the matcher actually implements', () => {
    // An unimplemented shape makes isNonDeployingDelta return null forever — the leg would go
    // dark silently while every gate stayed green.
    for (const pat of parsePathsIgnore(DEPLOY_YML)!)
      expect(matchesPattern('some/probe/path', pat), `unimplemented pattern: ${pat}`).not.toBeNull();
  });

  it('REAL HISTORY: aad0e26 (ops/monitoring only) has zero deploy runs and is non-deploying', () => {
    expect(isNonDeployingDelta(
      ['ops/monitoring/alert-registry.json', 'ops/monitoring/monitoring-inventory.json'],
      parsePathsIgnore(DEPLOY_YML),
    )).toBe(true);
  });

  it('REAL HISTORY: 2c3a6ea (an audits/ doc) deploys — it is the commit that stranded prod', () => {
    expect(isNonDeployingDelta(
      ['audits/RELEASE-v1.28.0-W1-endpoint-truth.md'],
      parsePathsIgnore(DEPLOY_YML),
    )).toBe(false);
  });

  it('the badge points at a workflow that exists — a rename must not dark the leg', () => {
    const m = /workflows\/([^/]+)\/badge\.svg/.exec(BADGE_URL);
    expect(m).toBeTruthy();
    expect(existsSync(join(ROOT, '.github/workflows', m![1])), `${m![1]} does not exist`).toBe(true);
  });

  it('the badge is pinned to the branch the canary compares against', () => {
    expect(BADGE_URL).toMatch(/[?&]branch=main(&|$)/);
  });
});

describe('the alert body an operator actually reads', () => {
  const base = { prodSha: 'a'.repeat(40), mainHead: 'b'.repeat(40) };
  const render = (laneHealth: any, nonDeploying: any = null) =>
    renderAlertBody({
      repo: 'crypto-quant-signal-mcp',
      verdict: classifyDrift({ ...base, laneHealth, nonDeploying }),
      prodSha: base.prodSha, mainHead: base.mainHead, behindMs: 3_600_000, laneHealth,
    });

  it('a red lane names the lane AND the command that resolves it', () => {
    const b = render('failing');
    expect(b).toMatch(/deploy lane RED/);
    expect(b).toMatch(/next: gh run list --workflow "Deploy to Hetzner"/);
  });

  it('a green lane with prod behind reads as escalate-worthy, not reassuring', () => {
    expect(render('passing')).toMatch(/deploy lane GREEN but prod is behind/);
  });

  it('the loose binding is stated in the BODY, not only in a source comment', () => {
    expect(render('failing')).toMatch(/latest run on main, NOT necessarily this sha/);
  });

  it('never emits %0A — send_telegram.sh does its own urlencode and is frozen', () => {
    for (const lh of ['passing', 'failing', 'unknown']) expect(render(lh)).not.toContain('%0A');
  });

  it('parseBadgeTitle never invents a pass', () => {
    expect(parseBadgeTitle('<title>Deploy to Hetzner - passing</title>')).toBe('passing');
    expect(parseBadgeTitle('<title>Deploy to Hetzner - no status</title>')).toBe('unknown');
    expect(parseBadgeTitle('')).toBe('unknown');
  });
});
