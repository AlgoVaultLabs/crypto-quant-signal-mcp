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
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyDrift,
  decideRecovery,
  attemptsFor,
  recordAttempt,
  BEHIND_GRACE_MS,
  BADGE_URL,
  VERDICTS,
  HEALTHY_VERDICTS,
  parsePathsIgnore,
  isNonDeployingDelta,
  matchesPattern,
  renderAlertBody,
  REPOS,
  DEPLOY_KINDS,
  BOT_DEPLOY_COMMAND,
  validateDeployModel,
  deltaCanTriggerDeploy,
  resolveNonDeploying,
  parseManifestPaths,
  touchesDeployPaths,
  parseCommitLog,
  dispatchAlert,
  dispatchClear,
  CQSM_LANE,
  readDeployLaneHealth,
  laneReadOpts,
  laneLogSuffix,
} from '../../ops/monitoring/deploy-drift-canary.mjs';
import {
  readConclusion,
  verdictFor,
  memoryFetch,
  fixtureRow,
  fixturePage,
  badgeUrl,
  actionsUrl,
  parseBadge,
  RECOVER_DEFAULTS,
} from '../../ops/monitoring/gh-run-conclusion.mjs';

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

/** The gha-push model production declares for this repo — REQUIRED by classifyDrift since
 *  OPS-DRIFT-ALERT-GENERATORS-W1, which refuses a behind repo with no declared deploy model. */
const GHA = { deployKind: 'gha-push', workflow: 'Deploy to Hetzner', laneBadge: BADGE_URL };

const graded = (over: Record<string, unknown> = {}) =>
  classifyDrift({
    ...GHA,
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
  const base = { ...GHA, prodSha: 'a'.repeat(40), mainHead: 'b'.repeat(40), failingFiles: [] };

  it('a behind repo with NO declared deploy model refuses — it never borrows a lane', () => {
    const r = classifyDrift({ prodSha: 'a'.repeat(40), mainHead: 'b'.repeat(40), laneHealth: 'unknown' });
    expect(r.verdict).toBe('DRIFT_INDETERMINATE');
    expect(r.cause).toBe('no-deploy-model');
    expect(r.next ?? '').not.toContain('crypto-quant-signal-mcp/actions');
  });

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
  it('no deployKind x laneHealth x nonDeploying x deploySet combination reaches DRIFT_RECOVERABLE', () => {
    const base = { ...GHA, prodSha: 'a'.repeat(40), mainHead: 'b'.repeat(40) };
    let evaluated = 0;
    for (const deployKind of ['gha-push', 'manual-manifest', undefined, 'rsync'])
      for (const laneHealth of [null, 'passing', 'failing', 'unknown', 'something-new'])
        for (const nonDeploying of [null, true, false])
          for (const deploySet of [null, { touched: true, files: ['scripts/x.sh'] }, { touched: false, files: [] }]) {
            evaluated++;
            expect(classifyDrift({ ...base, deployKind, laneHealth, nonDeploying, deploySet }).verdict)
              .not.toBe('DRIFT_RECOVERABLE');
          }
    expect(evaluated).toBe(4 * 5 * 3 * 3); // the enumeration is a property, not a sample
  });

  it('...while the ONE input that can still reach it is honoured for gha-push and refused for manual', () => {
    const base = { ...GHA, prodSha: 'a'.repeat(40), mainHead: 'b'.repeat(40), suiteVerdict: 'PASS' };
    expect(classifyDrift(base).verdict).toBe('DRIFT_RECOVERABLE');
    expect(classifyDrift({ ...base, deployKind: 'manual-manifest', deploySet: { touched: true, files: ['s'] } }).verdict)
      .toBe('DRIFT_MANUAL_DEPLOY_OWED'); // no workflow exists to re-trigger
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
  const base = { ...GHA, prodSha: 'a'.repeat(40), mainHead: 'b'.repeat(40) };
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

  it("the module's badge parser never invents a pass", () => {
    // OPS-XREPO-CI-RED-W1 CH4 retired the canary's private badge parser; the lane reads the module's ONE parser.
    const badgeState = (svg: string) => parseBadge(svg).state ?? 'unknown';
    expect(badgeState('<title>Deploy to Hetzner - passing</title>')).toBe('passing');
    expect(badgeState('<title>Deploy to Hetzner - no status</title>')).toBe('unknown');
    expect(badgeState('')).toBe('unknown');
  });
});

/* ══════════════ OPS-DRIFT-ALERT-GENERATORS-W1 ══════════════
 *
 * DEPLOY_DRIFT paged 2026-09-10..13 about algovault-bot with "deploy lane health unreadable", a
 * `next:` pointing at THIS repo's badge, and every newline rendered as a literal `\n`; on 09-11 it
 * paged about a README writeback that by design can never create a run. Each block below asserts
 * against the REAL artifact the hermetic self-test substitutes — the committed REPOS rows, the
 * workflow that justifies the GITHUB_TOKEN exemption, host-deploy.sh's own manifest parser, and the
 * wrapper transport itself.
 */
const RS = String.fromCharCode(0x1e);
const US = String.fromCharCode(0x1f);
const cqsm = () => REPOS.find((r: any) => r.name === 'crypto-quant-signal-mcp') as any;
const bot = () => REPOS.find((r: any) => r.name === 'algovault-bot') as any;
const MANIFEST_PATH = join(ROOT, 'ops/deploy/algovault-bot.manifest');

describe('THE DEPLOY MODEL — every watched repo declares how a push reaches prod', () => {
  it('every REPOS row carries a model that validates, from the closed kind set', () => {
    expect(REPOS.length).toBeGreaterThan(1);
    for (const r of REPOS as any[]) {
      expect(validateDeployModel(r.deploy), `${r.name}: ${validateDeployModel(r.deploy)}`).toBeNull();
      expect(DEPLOY_KINDS).toContain(r.deploy.kind);
    }
  });

  it('a missing, unknown or incomplete model is refused — never defaulted', () => {
    expect(validateDeployModel(undefined)).toBe('no deploy model declared');
    expect(validateDeployModel({ kind: 'rsync' })).toMatch(/unknown deploy kind/);
    expect(validateDeployModel({ kind: 'gha-push', workflow: 'w', laneBadge: 'b', rawBase: 'r', pathsIgnoreFrom: 'p' }))
      .toMatch(/nonTriggeringCommits/);
    expect(validateDeployModel({ kind: 'manual-manifest', manifest: 'm' })).toMatch(/lacks manifestRemote/);
  });

  it('algovault-bot is manual-manifest, against a manifest that exists', () => {
    expect(bot().deploy.kind).toBe('manual-manifest');
    expect(existsSync(join(ROOT, bot().deploy.manifest)), bot().deploy.manifest).toBe(true);
    expect(bot().deploy.deployCommand).toBe(BOT_DEPLOY_COMMAND);
  });

  it('no row points a lane, a raw read or a command at ANOTHER repo', () => {
    const slug = (remote: string) => /github\.com\/AlgoVaultLabs\/([^/.]+)/.exec(remote)![1];
    const c = cqsm();
    expect(c.deploy.laneBadge).toContain(`/AlgoVaultLabs/${slug(c.remote)}/actions/workflows/`);
    expect(c.deploy.rawBase).toContain(`/AlgoVaultLabs/${slug(c.remote)}`);
    expect(existsSync(join(ROOT, c.deploy.pathsIgnoreFrom))).toBe(true);
    expect(BOT_DEPLOY_COMMAND).toContain(`--repo ~/code/${slug(bot().remote)}`);
    expect(BOT_DEPLOY_COMMAND).not.toContain('badge');
  });
});

describe('the GITHUB_TOKEN exemption is bound to the workflow that earns it', () => {
  const writer = () => cqsm().deploy.nonTriggeringCommits
    .find((w: any) => w.producer === '.github/workflows/readme-snapshot-writeback.yml');
  const WB = readFileSync(join(ROOT, '.github/workflows/readme-snapshot-writeback.yml'), 'utf8');

  it('every declared writer names a producer that exists', () => {
    for (const w of cqsm().deploy.nonTriggeringCommits) expect(existsSync(join(ROOT, w.producer)), w.producer).toBe(true);
    expect(writer()).toBeTruthy();
  });

  it('the producer commits with EXACTLY the declared identity', () => {
    expect(WB).toContain(`git config user.name "${writer().committerName}"`);
    expect(WB).toContain(`git config user.email "${writer().committerEmail}"`);
  });

  it('the producer passes checkout no token — the GITHUB_TOKEN push that creates no run', () => {
    const code = WB.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/^\s*token:/m);
  });

  it('the producer commits ONLY the declared paths, and refuses otherwise', () => {
    expect(writer().paths).toEqual(['README.md']);
    expect(WB).toContain('paths other than README.md are still dirty after the restore');
  });
});

describe('REAL HISTORY — the per-commit leg against the deltas that paged', () => {
  const IGN = parsePathsIgnore(DEPLOY_YML)!;
  const W = () => cqsm().deploy.nonTriggeringCommits;
  const c = (sha: string, who: [string, string], files: string[], parents = 1) =>
    ({ sha: sha.padEnd(40, '0'), parents, committerName: who[0], committerEmail: who[1], files });
  const CI: [string, string] = ['AlgoVault CI', 'ci@algovault.com'];
  const HUMAN: [string, string] = ['AlgoVaultFi', '264139505+AlgoVaultFi@users.noreply.github.com'];

  it('2026-09-14 bdc9a893..6f36664b (inventory + 2 README writebacks, 0 Deploy runs) cannot trigger', () => {
    const r = deltaCanTriggerDeploy([
      c('6f36664b', CI, ['README.md']),
      c('fe4be99c', CI, ['README.md']),
      c('97d7c883', HUMAN, ['ops/monitoring/monitoring-inventory.json']),
    ], IGN, W());
    expect(r.canTrigger).toBe(false);
    expect(r.cause).toContain('readme-snapshot-writeback.yml');
    expect(resolveNonDeploying(isNonDeployingDelta(['README.md', 'ops/monitoring/monitoring-inventory.json'], IGN), r).value)
      .toBe(true);
  });

  it('2026-09-11 1a6cc219..1dc3e0e0 (one writeback — that day\'s MCP page) cannot trigger', () => {
    expect(deltaCanTriggerDeploy([c('1dc3e0e0', CI, ['README.md'])], IGN, W()).canTrigger).toBe(false);
    // ...while the aggregate leg alone calls it deploying — which is exactly the page this retires.
    expect(isNonDeployingDelta(['README.md'], IGN)).toBe(false);
  });

  it('a HUMAN README.md commit still deploys, and so does the writer touching anything else', () => {
    expect(deltaCanTriggerDeploy([c('aaaaaaa', HUMAN, ['README.md'])], IGN, W()).canTrigger).toBe(true);
    expect(deltaCanTriggerDeploy([c('bbbbbbb', CI, ['README.md', 'src/index.ts'])], IGN, W()).canTrigger).toBe(true);
  });

  it('a merge is INCONCLUSIVE, and inconclusive never silences a deploying aggregate', () => {
    const r = deltaCanTriggerDeploy([c('ccccccc', CI, ['README.md'], 2)], IGN, W());
    expect(r.canTrigger).toBeNull();
    expect(resolveNonDeploying(false, r).value).toBe(false);
  });

  it('git log output parses into per-commit facts', () => {
    const out = `${RS}${'a'.repeat(40)}${US}${'1'.repeat(40)}${US}AlgoVault CI${US}ci@algovault.com\n\nREADME.md\n`
      + `${RS}${'b'.repeat(40)}${US}${'1'.repeat(40)} ${'2'.repeat(40)}${US}AlgoVaultFi${US}x@y\n\nsrc/a.ts\nsrc/b.ts\n`;
    expect(parseCommitLog(out)!.map((x: any) => [x.parents, x.committerEmail, x.files]))
      .toEqual([[1, 'ci@algovault.com', ['README.md']], [2, 'x@y', ['src/a.ts', 'src/b.ts']]]);
    expect(parseCommitLog('not a log')).toBeNull();
  });
});

describe('the manual-manifest leg agrees with host-deploy.sh — one deploy set, two readers', () => {
  it('parseManifestPaths equals host-deploy.sh manifest_paths() on the committed manifest', { timeout: 30_000 }, () => {
    const hd = readFileSync(join(ROOT, 'ops/scripts/host-deploy.sh'), 'utf8');
    const fn = /manifest_paths\(\) \{[\s\S]*?\n\}/.exec(hd);
    expect(fn, 'manifest_paths() not found in ops/scripts/host-deploy.sh').toBeTruthy();
    const shell = (verb: string) =>
      execFileSync('bash', ['-c', `${fn![0]}\nmanifest_paths "$1" "$2"`, 'manifest-parity', MANIFEST_PATH, verb], { encoding: 'utf8' })
        .split('\n').filter(Boolean);
    const text = readFileSync(MANIFEST_PATH, 'utf8');
    expect(shell('deploy').length).toBeGreaterThan(0);
    expect(parseManifestPaths(text, 'deploy')).toEqual(shell('deploy'));
    expect(parseManifestPaths(text, 'ignore')).toEqual(shell('ignore'));
  });

  it('REAL HISTORY: c777e73 (scripts/tg-conversion-baseline.sh) is a deploy owed, and the page says how to deploy it', () => {
    const deploy = parseManifestPaths(readFileSync(MANIFEST_PATH, 'utf8'), 'deploy')!;
    const deploySet = touchesDeployPaths(['scripts/tg-conversion-baseline.sh'], deploy)!;
    expect(deploySet.touched).toBe(true);
    const prodSha = '65affdb419c11b3d36467bb00ea7c9d586a5c274';
    const mainHead = 'c777e73c6ae73b615a0f559f9279d4398b2fd983';
    const verdict = classifyDrift({ prodSha, mainHead, deployKind: 'manual-manifest', deployCommand: BOT_DEPLOY_COMMAND, deploySet });
    expect(verdict.verdict).toBe('DRIFT_MANUAL_DEPLOY_OWED');
    const body = renderAlertBody({ repo: 'algovault-bot', verdict, prodSha, mainHead, behindMs: 3_600_000, laneHealth: null });
    expect(body).toContain(`next: ${BOT_DEPLOY_COMMAND}`);
    expect(body).not.toMatch(/deploy lane|crypto-quant-signal-mcp\/actions/);
  });

  it('a delta outside the manifest (docs/, audits/) is not drift', () => {
    const deploy = parseManifestPaths(readFileSync(MANIFEST_PATH, 'utf8'), 'deploy')!;
    expect(touchesDeployPaths(['docs/METERING-DIVERGENCE.md', 'audits/x.md'], deploy)!.touched).toBe(false);
  });

  it('every flag in the deploy command is one host-deploy.sh accepts', () => {
    const hd = readFileSync(join(ROOT, 'ops/scripts/host-deploy.sh'), 'utf8');
    const flags = BOT_DEPLOY_COMMAND.split(/\s+/).filter((x: string) => /^--[a-z-]+$/.test(x));
    expect(flags).toContain('--dry-run');
    for (const f of flags) expect(hd, `host-deploy.sh has no case arm for ${f}`).toContain(`    ${f})`);
  });
});

describe('the TRANSPORT — what reaches the wrapper, not what renderAlertBody returned', () => {
  it('the body arrives byte-for-byte with REAL newlines; --clear goes first with stdin closed', { timeout: 30_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-transport-'));
    try {
      const fake = join(dir, 'wrap.sh');
      writeFileSync(fake, ['#!/bin/sh', 'd=$(dirname "$0")', "printf '%s\\n' \"$@\" > \"$d/argv\"", 'cat > "$d/stdin"', ''].join('\n'),
        { mode: 0o755 });
      const prodSha = 'a'.repeat(40);
      const mainHead = 'b'.repeat(40);
      const body = renderAlertBody({
        repo: 'algovault-bot', prodSha, mainHead, behindMs: 3_600_000, laneHealth: null,
        verdict: classifyDrift({ prodSha, mainHead, deployKind: 'manual-manifest', deployCommand: BOT_DEPLOY_COMMAND,
          deploySet: { touched: true, files: ['scripts/tg-conversion-baseline.sh'] } }),
      });
      expect(dispatchAlert(body, { wrap: fake }).ok).toBe(true);
      const got = readFileSync(join(dir, 'stdin'), 'utf8');
      expect(got).toBe(body);
      expect(got).not.toContain('\\n'); // the delivered defect: a literal backslash-n
      expect(got.split('\n').length).toBeGreaterThan(5);
      expect(readFileSync(join(dir, 'argv'), 'utf8').split('\n').filter(Boolean))
        .toEqual(['DEPLOY_DRIFT', 'CRITICAL_PERSISTENT', '-']);
      expect(dispatchClear('deploy drift verdict=DRIFT_NONE', { wrap: fake }).ok).toBe(true);
      expect(readFileSync(join(dir, 'argv'), 'utf8').split('\n').filter(Boolean))
        .toEqual(['--clear', 'DEPLOY_DRIFT', 'deploy drift verdict=DRIFT_NONE']);
      expect(readFileSync(join(dir, 'stdin'), 'utf8')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('main() dispatches through those functions, and no shell-string transport remains in the code', () => {
    const src = readFileSync(join(ROOT, 'ops/monitoring/deploy-drift-canary.mjs'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'); // a mention is not a use
    const mainBody = code.slice(code.indexOf('function main()'));
    expect(mainBody).toMatch(/dispatchAlert\(body\)/);
    expect(mainBody).toMatch(/dispatchClear\(/);
    expect(code).not.toMatch(/JSON\.stringify\(body\)/);
    expect(code).not.toMatch(/'-c',\s*`printf/);
  });
});

/* ══════════════ OPS-XREPO-CI-RED-W1 CH4 — the deploy lane is a BOUND record ══════════════
 *
 * The lane used to be ONE badge sample through a private <title> parser. The badge carries no run
 * identity and GitHub serves it wrong in short episodes; the module header records prior N1: on
 * 2026-10-02 it read passing for 2h25m while Deploy #1065 (37011492987) had FAILED, and the
 * DEPLOY_DRIFT page called the lane green. The lane is now read through gh-run-conclusion.mjs, which
 * binds the badge to the run's own record. N1 is replayed below on REAL captured markup (the row and
 * the badge, tests/fixtures/gh-run-conclusion/, provenance in each file header) — the canary's
 * hermetic --self-test replays the same ids through the module's synthetic builders, because the host
 * has no fixture directory.
 *
 * Every read here: in-memory transport, no-op clock, pinned host / reads / spacing, EMPTY env. A real
 * clock is 60 s per Recover read, and a vitest timeout cannot interrupt a synchronous sleep.
 */
const GHRC_FX = join(ROOT, 'tests/fixtures/gh-run-conclusion');
const ghrcFx = (f: string) => readFileSync(join(GHRC_FX, f), 'utf8');
const noSleep = () => {};
const LANE = CQSM_LANE as { repo: string; workflow: string; branch: string };
const LANE_NAME = 'Deploy to Hetzner';
const readLane = (seq: Record<string, any[]>) =>
  readConclusion({ ...LANE, cls: 'attribution' }, {
    fetchDoc: memoryFetch(seq), sleep: noSleep, env: {}, host: 'https://github.com',
    reads: RECOVER_DEFAULTS.reads, spacingS: RECOVER_DEFAULTS.spacingS,
  }) as any;
/** The canary's OWN reader: its opts pin host / reads / spacing / env; the test swaps transport + clock only. */
const readLaneViaCanary = (seq: Record<string, any[]>) =>
  readDeployLaneHealth(LANE, { fetchDoc: memoryFetch(seq), sleep: noSleep }) as any;
const laneSeq = (badgeBody: string, page: { body?: string; http?: number }) => ({
  [badgeUrl(LANE)]: [{ body: badgeBody }],
  [actionsUrl(LANE)]: [page],
});
const synthBadge = (status: string) => `<svg xmlns="http://www.w3.org/2000/svg"><title>${LANE_NAME} - ${status}</title></svg>`;
const synthRow = (runId: string, runNumber: number, icon: string, started: string) =>
  fixtureRow({ repo: LANE.repo, runId, runNumber, name: LANE_NAME, icon, started, ref: 'main' });
const BEHIND = { ...GHA, lane: LANE, prodSha: 'a'.repeat(40), mainHead: 'b'.repeat(40) };
const CAVEAT = (lh: string) => `deploy lane (latest run on main, NOT necessarily this sha): ${lh}`;
const bodyFor = (laneHealth: string, record: any) => renderAlertBody({
  repo: 'crypto-quant-signal-mcp', verdict: classifyDrift({ ...BEHIND, laneHealth }),
  prodSha: BEHIND.prodSha, mainHead: BEHIND.mainHead, behindMs: 3_600_000, laneHealth, record,
});
const MODULE_NEXT = `node /opt/algovault-monitoring/gh-run-conclusion.mjs --repo AlgoVaultLabs/crypto-quant-signal-mcp --workflow deploy.yml --branch main --class attribution   # badge: ${BADGE_URL}`;

describe('N1 REPLAY on REAL markup — Deploy #1065 failed while the deploy badge read passing', () => {
  const realSeq = () => laneSeq(ghrcFx('badge-passing-deploy-main.svg'), { body: fixturePage([ghrcFx('row-failure-37011492987.html')]) });

  it('the captured fixtures are what they claim: a passing deploy badge, and #1065 failure', () => {
    expect(parseBadge(ghrcFx('badge-passing-deploy-main.svg'))).toMatchObject({ name: LANE_NAME, state: 'passing' });
    const row = ghrcFx('row-failure-37011492987.html');
    expect(row).toContain('/AlgoVaultLabs/crypto-quant-signal-mcp/actions/runs/37011492987"');
    expect(row).toContain('octicon-x-circle-fill color-fg-danger');
  });

  it('binds BIND_TABLE row 4: DISAGREE, record-confirmed after the full Recover window, attribution failing', () => {
    const rec = readLane(realSeq());
    expect([rec.row, rec.agreement, rec.reason]).toEqual([4, 'DISAGREE', 'badge_passing_record_failure']);
    expect(verdictFor(rec, 'attribution')).toBe('failing');
    expect(rec.reads).toBe(RECOVER_DEFAULTS.reads);
    expect(rec.bound_run).toMatchObject({ run_id: '37011492987', run_number: 1065, name: LANE_NAME, state: 'failure', started_at: '2026-10-02T13:12:46Z' });
    expect(rec.badge.name).toBe(LANE_NAME); // the badge and the row are the same workflow (else row 7)
  });

  it("the canary's own lane reader gives the same answer through its pinned opts", () => {
    const r = readLaneViaCanary(realSeq());
    expect(r.laneHealth).toBe('failing');
    expect([r.record.row, r.record.bound_run.run_id]).toEqual([4, '37011492987']);
  });

  it('classifies lane-red — never green — and the page names #1065, its id, and the disagreement', () => {
    const r = readLaneViaCanary(realSeq());
    expect(classifyDrift({ ...BEHIND, laneHealth: r.laneHealth }).cause).toBe('lane-red');
    const body = bodyFor(r.laneHealth, r.record);
    const lines = body.split('\n');
    expect(lines).toContain(CAVEAT('failing')); // byte-identical caveat
    expect(lines[lines.indexOf(CAVEAT('failing')) + 1])
      .toBe('  bound run: #1065 (37011492987) failure on main — https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/actions/runs/37011492987');
    expect(lines).toContain("  the deploy badge disagrees: it reads passing; the run's own record says failure");
    expect(body).toContain('#1065');
    expect(body).toContain('37011492987');
    expect(body).toContain('disagrees');
    expect(body).not.toMatch(/\b(?:scripts|ops)\//); // alert-copy law: the body cites no repo path
  });
});

describe('row 4 — the other failed Deploy runs (synthetic rows, ids + failure state read off the live Actions page 2026-10-04)', () => {
  it.each([
    ['#1015', '35707619335', 1015, '2026-09-22T08:57:10Z'],
    ['#973', '34229525605', 973, '2026-09-08T13:02:13Z'],
  ])('%s: a passing badge over a failed run is row 4, failing, bound — and pages lane-red', (label, runId, runNumber, started) => {
    const r = readLaneViaCanary(laneSeq(synthBadge('passing'), { body: fixturePage([synthRow(runId as string, runNumber as number, 'failure', started as string)]) }));
    expect([r.laneHealth, r.record.row, r.record.agreement, r.record.reason]).toEqual(['failing', 4, 'DISAGREE', 'badge_passing_record_failure']);
    expect(r.record.bound_run.run_id).toBe(runId);
    expect(classifyDrift({ ...BEHIND, laneHealth: r.laneHealth }).cause).toBe('lane-red');
    expect(bodyFor(r.laneHealth, r.record)).toContain(`  bound run: ${label} (${runId}) failure on main`);
  });
});

describe('the lane reader over the other bind-table rows the canary can meet', () => {
  const ok = (icon: string) => ({ body: fixturePage([synthRow('90000000001', 1, icon, '2026-10-04T00:00:00Z')]) });

  it('row 1 — passing + success: passing, AGREE on the first read, bound; lane-green-prod-behind; no disagreement line', () => {
    const r = readLaneViaCanary(laneSeq(synthBadge('passing'), ok('success')));
    expect([r.laneHealth, r.record.row, r.record.agreement, r.record.reads]).toEqual(['passing', 1, 'AGREE', 1]);
    expect(classifyDrift({ ...BEHIND, laneHealth: r.laneHealth }).cause).toBe('lane-green-prod-behind');
    const body = bodyFor(r.laneHealth, r.record);
    expect(body).toContain('  bound run: #1 (90000000001) success on main');
    expect(body).not.toContain('disagrees');
  });

  it('row 2 — failing + failure: failing, AGREE, bound; lane-red', () => {
    const r = readLaneViaCanary(laneSeq(synthBadge('failing'), ok('failure')));
    expect([r.laneHealth, r.record.row, r.record.agreement]).toEqual(['failing', 2, 'AGREE']);
    expect(r.record.bound_run.run_id).toBe('90000000001');
    expect(classifyDrift({ ...BEHIND, laneHealth: r.laneHealth }).cause).toBe('lane-red');
    expect(bodyFor(r.laneHealth, r.record)).not.toContain('disagrees');
  });

  it('row 3 — failing badge over a run that SUCCEEDED: unknown, unbound, never a red; lane-unknown re-reads via the module', () => {
    const r = readLaneViaCanary(laneSeq(synthBadge('failing'), ok('success')));
    expect([r.laneHealth, r.record.row, r.record.agreement, 'bound_run' in r.record]).toEqual(['unknown', 3, 'DISAGREE', false]);
    const v = classifyDrift({ ...BEHIND, laneHealth: r.laneHealth });
    expect([v.cause, v.next]).toEqual(['lane-unknown', MODULE_NEXT]);
    const body = bodyFor(r.laneHealth, r.record);
    expect(body).not.toContain('bound run:'); // a run is named ONLY from a bound record
    expect(body).toContain("  the deploy badge disagrees: it reads failing; the run's own record says success");
  });

  it('row 6 — passing badge, run record unavailable (HTTP 503): unknown, UNCORROBORATED; lane-unknown', () => {
    const r = readLaneViaCanary(laneSeq(synthBadge('passing'), { http: 503 }));
    expect([r.laneHealth, r.record.row, r.record.agreement]).toEqual(['unknown', 6, 'UNCORROBORATED']);
    expect(classifyDrift({ ...BEHIND, laneHealth: r.laneHealth }).cause).toBe('lane-unknown');
    expect(bodyFor(r.laneHealth, r.record)).not.toMatch(/bound run:|disagrees/);
  });

  it('row 8 — badge "no status": unknown, UNREADABLE; lane-unknown', () => {
    const r = readLaneViaCanary(laneSeq(synthBadge('no status'), ok('success')));
    expect([r.laneHealth, r.record.row, r.record.agreement]).toEqual(['unknown', 8, 'UNREADABLE']);
    expect(classifyDrift({ ...BEHIND, laneHealth: r.laneHealth }).cause).toBe('lane-unknown');
  });

  it('a read that THROWS refuses — laneHealth unknown, record null — it never throws', () => {
    const r = readDeployLaneHealth(LANE, { fetchDoc: () => { throw new Error('transport exploded'); }, sleep: noSleep }) as any;
    expect([r.laneHealth, r.record, r.err]).toEqual(['unknown', null, 'transport exploded']);
    expect(laneLogSuffix(true, r.record)).toBe(' agreement=n-a row=n-a reason=read_threw');
  });
});

describe('Q7 — the lane-unknown next re-reads the lane through the module, never a badge-title grep', () => {
  it('with the lane declared: the module command, naming the badge', () => {
    const next = classifyDrift({ ...BEHIND, laneHealth: 'unknown' }).next;
    expect(next).toBe(MODULE_NEXT);
    expect(next).toContain(BADGE_URL);
    expect(next).not.toContain('<title>');
  });
  it('with only a badge: the URL and nothing else', () => {
    expect(classifyDrift({ ...GHA, prodSha: 'a'.repeat(40), mainHead: 'b'.repeat(40), laneHealth: 'unknown' }).next)
      .toBe(`curl -sS "${BADGE_URL}"`);
  });
  it('the --class flag it prints is one the module CLI accepts', () => {
    const mod = readFileSync(join(ROOT, 'ops/monitoring/gh-run-conclusion.mjs'), 'utf8');
    for (const flag of ['--repo', '--workflow', '--branch', '--class']) expect(mod).toContain(`k === '${flag}'`);
  });
});

describe('ONE lane declaration — what the hermetic self-test cannot see', () => {
  it('BADGE_URL is DERIVED from the lane and byte-identical to the literal it replaced', () => {
    expect(BADGE_URL).toBe('https://github.com/AlgoVaultLabs/crypto-quant-signal-mcp/actions/workflows/deploy.yml/badge.svg?branch=main');
    expect(cqsm().deploy.lane).toEqual(LANE);
    expect(cqsm().deploy.laneBadge).toBe(badgeUrl(cqsm().deploy.lane));
  });
  it('the lane names a workflow FILE that exists, whose display name is the declared workflow (the badge + row name)', () => {
    const yml = readFileSync(join(ROOT, '.github/workflows', LANE.workflow), 'utf8');
    expect(/^name:\s*(.+)$/m.exec(yml)?.[1].trim()).toBe(cqsm().deploy.workflow);
    expect(cqsm().deploy.workflow).toBe(LANE_NAME);
    expect(parseBadge(ghrcFx('badge-passing-deploy-main.svg')).name).toBe(cqsm().deploy.workflow);
  });
  it('a hand-edited laneBadge that drifts from the lane REFUSES; a missing or display-name lane refuses too', () => {
    const d = cqsm().deploy;
    expect(validateDeployModel({ ...d, laneBadge: BADGE_URL.replace('branch=main', 'branch=master') })).toMatch(/not derived from its lane/);
    expect(validateDeployModel({ ...d, lane: undefined })).toMatch(/lacks lane/);
    expect(validateDeployModel({ ...d, lane: { ...LANE, workflow: LANE_NAME } })).toMatch(/lacks lane/);
    expect(validateDeployModel(d)).toBeNull();
  });
});

describe('main() wiring — the live lane read is single, pinned, and where it always was', () => {
  const src = readFileSync(join(ROOT, 'ops/monitoring/deploy-drift-canary.mjs'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n'); // a mention is not a use
  const mainBody = code.slice(code.indexOf('function main()'));

  it('exactly ONE readConclusion call in the canary, and it takes the pinned opts', () => {
    expect(code.match(/\breadConclusion\(/g)).toHaveLength(1);
    expect(code).toContain("readConclusion({ ...lane, cls: 'attribution' }, laneReadOpts(seam))");
  });
  it('the live opts pin host / reads / spacing / env and read through curl; a seam swaps only transport + clock', () => {
    const live = laneReadOpts() as any;
    expect([live.host, live.reads, live.spacingS, live.env, typeof live.fetchDoc, 'sleep' in live])
      .toEqual(['https://github.com', RECOVER_DEFAULTS.reads, RECOVER_DEFAULTS.spacingS, {}, 'function', false]);
    const seamed = laneReadOpts({ fetchDoc: () => ({}), sleep: noSleep }) as any;
    expect([seamed.host, seamed.reads, seamed.spacingS, seamed.env]).toEqual(['https://github.com', RECOVER_DEFAULTS.reads, RECOVER_DEFAULTS.spacingS, {}]);
  });
  it('main() reads the lane ONCE, only on the gha-push branch, passing NO opts (so production cannot be un-pinned)', () => {
    expect(mainBody.match(/readDeployLaneHealth\(/g)).toHaveLength(1);
    expect(mainBody).toContain('readDeployLaneHealth(d.lane);');
    const gha = mainBody.slice(mainBody.indexOf("if (d.kind === 'gha-push') {"), mainBody.indexOf('} else if (!mir.ok) {'));
    expect(gha).toContain('readDeployLaneHealth(d.lane);');
  });
  it('main() hands classifyDrift the lane and renderAlertBody the record', () => {
    expect(mainBody).toMatch(/lane: repo\.deploy\?\.lane \?\? null,/);
    expect(mainBody).toContain('record: laneRecord });');
  });
  it('the log line keeps lane=<state> and APPENDS the record fields at the end', () => {
    expect(mainBody).toContain("lane=${laneHealth ?? 'n-a'} nonDeploying=");
    expect(mainBody).toContain('(${verdict.reason})${laneLogSuffix(laneRead, laneRecord)}`);');
    const rec = readLane(laneSeq(ghrcFx('badge-passing-deploy-main.svg'), { body: fixturePage([ghrcFx('row-failure-37011492987.html')]) }));
    expect(laneLogSuffix(true, rec)).toBe(' agreement=DISAGREE row=4 bound=#1065(37011492987)');
    expect(laneLogSuffix(false, null)).toBe('');
    const unbound = readLane(laneSeq(synthBadge('passing'), { http: 503 }));
    expect(laneLogSuffix(true, unbound)).toBe(' agreement=UNCORROBORATED row=6 reason=http_503');
    // The suffix can never carry a second `lane=` token, so the census regex keeps reading the real one
    // (main()'s source above proves the suffix is appended AFTER it).
    for (const r of [rec, unbound, null]) expect(laneLogSuffix(true, r)).not.toMatch(/\blane=/);
  });
});
