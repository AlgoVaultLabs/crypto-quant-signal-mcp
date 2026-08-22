/**
 * OPS-TEST-BUDGET-CI-REF-W1 — a workflow that runs the suite off `main` must fetch git history.
 *
 * ─── THE DEFECT THIS PINS ───────────────────────────────────────────────────────────────────
 * `actions/checkout` defaults to `fetch-depth: 1` and fetches ONLY the pushed ref. Measured from
 * a real run's own log:
 *
 *   fetch --no-tags --prune --depth=1 origin +602449c…:refs/remotes/origin/<branch>
 *
 * So on a BRANCH push `refs/remotes/origin/main` does not exist in the runner. Any test that asks
 * git a question relative to the default branch then gets an error rather than an answer.
 * `check-test-budget.mjs` does exactly that — `git merge-base HEAD origin/main` — and on failure
 * `changedTestFiles()` returns null, so the gate answers TEST_BUDGET_VERDICT=INDETERMINATE. That
 * is the CORRECT verdict: it refuses to assume nothing changed. The gate was never wrong; it was
 * being run somewhere it could not see.
 *
 * The tell was that ONE sha produced TWO verdicts — `602449c` passed on `main` and failed on its
 * own branch. Identical tree, so the differing input was the REF. Worth stating plainly because
 * the first reading of that evidence was "my commits broke it", which compared a main run against
 * branch runs — two different quantities, which is the instrument error this repo already records.
 *
 * ─── WHY A TEST AND NOT A COMMENT ───────────────────────────────────────────────────────────
 * The one-line fix is trivial to drop while "tidying" a workflow, and its absence is INVISIBLE on
 * `main` — the only place most people watch. It reappears only as a red on branch pushes, which
 * is precisely the signal people learn to ignore. Prose has already failed this class once in
 * this repo; a rule that has failed as prose becomes a gate.
 *
 * ─── THE PREDICATE IS DELIBERATELY NARROW ───────────────────────────────────────────────────
 * Only workflows that run the suite AND can trigger on a non-`main` ref need full history.
 * `deploy.yml` runs solely on push-to-main, where the pushed ref IS main and the reference
 * resolves for free; requiring depth 0 there would slow every deploy to fix a problem it cannot
 * have. A guard that over-reaches gets softened, and a softened guard protects nothing.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

const WF_DIR = resolve(__dirname, '..', '..', '.github', 'workflows');

interface Workflow {
  name: string;
  runsSuite: boolean;
  onlyMain: boolean;
  fetchDepths: unknown[];
}

/**
 * True when the workflow reaches a gate that needs git history — DIRECTLY or through one hop of
 * package-lifecycle indirection.
 *
 * The `npm publish` clause is the second half, and it was added because its absence cost a
 * release. RELEASE-v1.28.0-AND-README-LINK-GATE-W1: `publish-npm.yml` ran a depth-1 checkout of a
 * TAG, `check-test-budget.mjs` could not resolve `origin/main`, and it correctly answered
 * INDETERMINATE — failing `prepublishOnly` at step 19 of 23 and blocking the publish entirely.
 *
 * This detector could not see it. The suite is never named in that workflow's own `run:` steps:
 * it is reached as `npm publish` → `prepublishOnly` → `npm run test:budget:check`, one hop away in
 * `package.json`. A detector that reads only a workflow's own text is blind to every gate wired
 * through a lifecycle script — and `prepublishOnly` runs ONLY on publish, so the blind spot's
 * first exercise is always a release.
 *
 * `npm publish` is therefore treated as running the suite, because in this repo it does. If
 * `prepublishOnly` ever stops invoking a git-dependent gate, delete this clause deliberately
 * rather than letting it rot — an over-broad predicate here costs one `fetch-depth: 0`, while an
 * under-broad one costs a release.
 */
function runsSuite(raw: string): boolean {
  return (
    /(^|\s)(npx\s+)?vitest\b/.test(raw) ||
    /npm\s+(run\s+)?test\b/.test(raw) ||
    /npm\s+publish\b/.test(raw)
  );
}

/**
 * True when every push/pull_request trigger is confined to `main`.
 * Conservative by design: anything we cannot positively confirm as main-only is treated as
 * able to run off main, so an unrecognised trigger shape fails CLOSED into "needs history".
 */
function onlyMain(doc: Record<string, unknown>): boolean {
  // `on` is the YAML 1.1 boolean `true` once parsed — a real and well-known footgun.
  const on = (doc.on ?? (doc as Record<string, unknown>)['true']) as Record<string, unknown> | undefined;
  if (!on || typeof on !== 'object') return false;
  const keys = Object.keys(on);
  const offMainTriggers = keys.filter((k) => k !== 'push' && k !== 'workflow_dispatch');
  if (offMainTriggers.length > 0) return false; // pull_request, schedule, etc. → can run off main
  const push = on.push as Record<string, unknown> | undefined;
  if (!push || typeof push !== 'object') return false;
  const branches = push.branches as string[] | undefined;
  return Array.isArray(branches) && branches.length > 0 && branches.every((b) => b === 'main');
}

function loadWorkflows(): Workflow[] {
  if (!existsSync(WF_DIR)) return [];
  return readdirSync(WF_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => {
      const raw = readFileSync(join(WF_DIR, f), 'utf8');
      let doc: Record<string, unknown> = {};
      try {
        doc = (yaml.load(raw) as Record<string, unknown>) ?? {};
      } catch {
        doc = {};
      }
      const fetchDepths: unknown[] = [];
      for (const job of Object.values((doc.jobs ?? {}) as Record<string, { steps?: unknown[] }>)) {
        for (const step of job?.steps ?? []) {
          const s = step as { uses?: string; with?: Record<string, unknown> };
          if (typeof s?.uses === 'string' && s.uses.startsWith('actions/checkout')) {
            fetchDepths.push(s.with?.['fetch-depth']);
          }
        }
      }
      return { name: f, runsSuite: runsSuite(raw), onlyMain: onlyMain(doc), fetchDepths };
    });
}

describe('CI git context — a suite run off main must be able to see main', () => {
  const workflows = loadWorkflows();

  it('the detector actually found workflows that run the suite', () => {
    // Vacuity guard, at the point the corpus is CONSTRUCTED. Zero matches would make every
    // assertion below pass having checked nothing — the shape this repo has been bitten by.
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows.filter((w) => w.runsSuite).length).toBeGreaterThan(0);
  });

  it('every suite-running workflow that can trigger off main fetches full history', () => {
    const offenders = workflows
      .filter((w) => w.runsSuite && !w.onlyMain)
      .filter((w) => w.fetchDepths.length === 0 || !w.fetchDepths.every((d) => Number(d) === 0));

    expect(
      offenders.map((o) => `${o.name} (fetch-depth: ${JSON.stringify(o.fetchDepths)})`),
      'A depth-1 checkout fetches ONLY the pushed ref, so refs/remotes/origin/main does not exist ' +
        'on a branch push. check-test-budget.mjs asks `git merge-base HEAD origin/main` and then ' +
        'correctly answers INDETERMINATE. Add `with: { fetch-depth: 0 }` to the checkout step.',
    ).toEqual([]);
  });

  it('the lane that surfaced this keeps its full-history checkout', () => {
    // Named explicitly so deleting the fix from THIS file is a red with a reason, not just a
    // count going down in the generic assertion above.
    const lane = workflows.find((w) => w.name === 'postgres-lane.yml');
    expect(lane, 'postgres-lane.yml is missing — if it was renamed, re-point this test').toBeTruthy();
    expect(lane!.runsSuite).toBe(true);
    expect(lane!.fetchDepths.length).toBeGreaterThan(0);
    expect(lane!.fetchDepths.every((d) => Number(d) === 0)).toBe(true);
  });

  it('the publish lane keeps its full-history checkout', () => {
    // Named explicitly, for the same reason postgres-lane.yml is: the generic assertion above
    // would only show a count going down. This one says which lane and why.
    //
    // publish-npm.yml triggers on tags and on workflow_dispatch, so `onlyMain` is false and it
    // needs full history — and it reaches check-test-budget.mjs through prepublishOnly, where a
    // missing origin/main is a blocked RELEASE rather than a slow CI run.
    const publish = workflows.find((w) => w.name === 'publish-npm.yml');
    expect(publish, 'publish-npm.yml is missing — if it was renamed, re-point this test').toBeTruthy();
    expect(publish!.runsSuite, 'npm publish runs prepublishOnly, which runs the budget gate').toBe(true);
    expect(publish!.onlyMain, 'it triggers on tags, so it can run off main').toBe(false);
    expect(publish!.fetchDepths.length).toBeGreaterThan(0);
    expect(publish!.fetchDepths.every((d) => Number(d) === 0)).toBe(true);
  });

  it('a manual publish door cannot ship a tree that never landed', () => {
    // workflow_dispatch makes publish-npm.yml runnable against an arbitrary ref. That is only
    // acceptable with the ancestor guard, so the two are pinned together: adding the door without
    // the guard, or deleting the guard while the door stands, is a red here.
    const raw = readFileSync(join(WF_DIR, 'publish-npm.yml'), 'utf8');
    if (/workflow_dispatch/.test(raw)) {
      expect(raw, 'workflow_dispatch without an ancestor-of-main guard can publish an unlanded tree')
        .toMatch(/merge-base\s+--is-ancestor/);
      expect(raw, 'the ancestry guard must emit a verdict token, per the token law').toMatch(
        /PUBLISH_ANCESTRY_VERDICT=/,
      );
    }
  });

  it('does NOT force full history on a workflow that only ever runs on main', () => {
    // The narrow predicate is itself asserted, so a future "simplification" that drops the
    // onlyMain carve-out and slows every deploy shows up here rather than in a build-time bill.
    const deploy = workflows.find((w) => w.name === 'deploy.yml');
    if (deploy) expect(deploy.onlyMain).toBe(true);
  });
});
