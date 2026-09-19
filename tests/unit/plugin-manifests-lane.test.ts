import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = '.github/workflows/deploy.yml';

/**
 * OPS-PLUGIN-MANIFESTS-GATE-WIRE-W1 — pin the deploy-lane step's load-bearing properties.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `scripts/check-plugin-manifests.mjs` is now invoked from a step in `deploy.yml`, and a step in a
 * workflow runs ONLY during a deploy. A regression to it — a dropped `set +e`, a `continue-on-error`
 * added in a hurry, an INDETERMINATE branch quietly promoted to a pass — is therefore structurally
 * undiscoverable until a deploy already depends on it, and the failure mode is silence rather than
 * a red. This file runs in the ordinary suite (pre-push gate, CI, `deploy.yml`'s own vitest step),
 * which is what makes such a regression UNLANDABLE instead of merely unlikely.
 *
 * That is the same reasoning `tests/unit/smithery-sync-lane.test.ts` records for the publish lane.
 * The estate has already paid for the alternative: a sibling repo met an auth quirk with
 * `continue-on-error: true` and that surface went stale IN SILENCE for months.
 *
 * ── HOW IT SELECTS THE STEP ─────────────────────────────────────────────────
 * Structurally, through ONE `js-yaml` parse, and it identifies the step BY WHAT IT RUNS rather
 * than by its `name` — the selector convention `publish-lane-invariants.test.ts` established. A
 * renamed step must not silently drop every assertion below to a vacuous pass, which is exactly
 * what a name-keyed lookup would do.
 *
 * Parsing rather than grepping is load-bearing: the step carries a long comment block explaining
 * WHY it is fail-open on transport and why it needs no health-wait, and that explanation is the
 * most valuable thing in it. Comments do not survive into a parsed step, so the assertions key on
 * the real bindings. The raw-text direction is asserted separately, once, where it belongs.
 */

interface Step {
  index: number;
  name: string;
  run?: string;
  continueOnError?: unknown;
}

function laneStep(): { step: Step; jobId: string; stepCount: number } {
  const doc = yaml.load(readFileSync(resolve(ROOT, WORKFLOW), 'utf8')) as {
    jobs?: Record<string, { steps?: unknown[] }>;
  };
  const jobs = doc?.jobs ?? {};
  for (const [jobId, job] of Object.entries(jobs)) {
    const steps: Step[] = (job?.steps ?? []).map((s, index) => {
      const step = (s ?? {}) as Record<string, unknown>;
      return {
        index,
        name: typeof step.name === 'string' ? step.name : '',
        run: typeof step.run === 'string' ? step.run : undefined,
        continueOnError: step['continue-on-error'],
      };
    });
    // BY WHAT IT RUNS, never by its key or its name.
    const step = steps.find((s) => /scripts\/check-plugin-manifests\.mjs/.test(s.run ?? ''));
    if (step) return { step, jobId, stepCount: steps.length };
  }
  throw new Error(`no step in ${WORKFLOW} invokes scripts/check-plugin-manifests.mjs`);
}

describe('deploy.yml wires the plugin-manifest gate, and wires it correctly', () => {
  const { step, jobId, stepCount } = laneStep();

  it('the corpus is non-empty (vacuity guard, at construction)', () => {
    // A workflow that parsed to zero steps would make every assertion below pass having read
    // nothing — the shape this repo has been bitten by more than once.
    expect(stepCount, `${WORKFLOW} job "${jobId}" parsed to ZERO steps`).toBeGreaterThan(0);
    expect(step.run, 'the lane step has no run block').toBeTruthy();
  });

  it('invokes the gate script', () => {
    expect(step.run!).toMatch(/node\s+scripts\/check-plugin-manifests\.mjs/);
  });

  it('gates on the TOKEN, never on the bare exit code', () => {
    // `set +e` is what lets the token be read at all: without it the step dies on the script's
    // non-zero exit and the case statement below never runs, so INDETERMINATE would red the
    // deploy exactly as FAIL does — the one distinction the token law exists to preserve.
    expect(step.run!, 'the step must not die on the script exit code before reading the token').toMatch(/set \+e/);
    expect(step.run!).toMatch(/grep -oE 'PLUGIN_MANIFESTS_VERDICT=\[A-Z\]\+'/);
    expect(step.run!, 'the token must be read from the LAST occurrence').toMatch(/\|\s*tail -1/);
  });

  it('INDETERMINATE warns and does not fail the deploy', () => {
    // Two of this gate's inputs come from agent-plugins.org, which is not ours. A gate that reds
    // the deploy on a third party's outage is one that gets disabled.
    expect(step.run!).toMatch(/PLUGIN_MANIFESTS_VERDICT=INDETERMINATE\)\s*echo "::warning::/);
    const indeterminateBranch = step.run!.split('PLUGIN_MANIFESTS_VERDICT=INDETERMINATE)')[1]?.split(';;')[0] ?? '';
    expect(indeterminateBranch, 'the INDETERMINATE branch must not exit non-zero').not.toMatch(/exit [1-9]/);
  });

  it('FAIL and an UNRECOGNISED token both red the deploy — a missing token is never a pass', () => {
    // The wildcard arm is what catches NO_TOKEN_EMITTED. A gate that died before printing its
    // token has verified nothing, and reading that as success is the exact fail-open the token
    // law forbids.
    const wildcard = step.run!.split(/\n\s*\*\)/)[1] ?? '';
    expect(wildcard, 'there must be a catch-all arm').toBeTruthy();
    expect(wildcard).toMatch(/::error::/);
    expect(wildcard).toMatch(/exit 1/);
  });

  it('PASS does not exit non-zero', () => {
    const passBranch = step.run!.split('PLUGIN_MANIFESTS_VERDICT=PASS)')[1]?.split(';;')[0] ?? '';
    expect(passBranch).toBeTruthy();
    expect(passBranch).not.toMatch(/exit [1-9]/);
  });

  it('carries NO `continue-on-error` — the fail-open lever is the TOKEN, never a YAML lever', () => {
    // A YAML lever downgrades the step unconditionally and invisibly, including on a real FAIL.
    // The token already distinguishes "could not verify" from "diverged"; a second, coarser lever
    // on top of it can only destroy that distinction.
    expect(step.continueOnError, 'continue-on-error turns a real divergence into a green deploy').toBeUndefined();
  });

  it('runs AFTER the deploy, because its origin leg is a claim about the deployed origin', () => {
    // The gate asserts that the url in mcp.json answers MCP with a non-empty tool list. Placed
    // before the deploy it would be testing the PREVIOUS release, which is a different claim that
    // happens to pass most of the time — the worst kind of wrong.
    //
    // The deploy step is found BY WHAT IT DOES, like the lane step itself: it is the step that
    // opens an SSH session to the host and brings the container up. Keying on its name ("Deploy
    // via SSH") would let a rename turn this ordering assertion into a vacuous pass, and keying
    // on `run` finds nothing at all — the deploy is an `appleboy/ssh-action` whose work lives in
    // `with.script`, which is exactly the shape a first guess at this predicate missed.
    const doc = yaml.load(readFileSync(resolve(ROOT, WORKFLOW), 'utf8')) as {
      jobs?: Record<string, { steps?: Array<Record<string, unknown>> }>;
    };
    const steps = doc!.jobs![jobId]!.steps!;
    const body = (s: Record<string, unknown>) =>
      `${String(s.run ?? '')}\n${String(((s.with ?? {}) as Record<string, unknown>).script ?? '')}`;
    const deployIdx = steps.findIndex(
      (s) => /ssh-action/.test(String(s.uses ?? '')) && /docker\s+compose\b[\s\S]*\bup\s+-d\b/.test(body(s)),
    );
    expect(deployIdx, 'could not locate the deploy step — the ordering assertion would be vacuous').toBeGreaterThanOrEqual(0);
    expect(step.index).toBeGreaterThan(deployIdx);
  });
});

describe('the gate script the lane depends on still honours its half of the contract', () => {
  const src = readFileSync(resolve(ROOT, 'scripts/check-plugin-manifests.mjs'), 'utf8');

  it('prints the token on the unhandled path, so the lane can never read silence as success', () => {
    // The one outcome the token law forbids is dying with no token at all. The lane's catch-all
    // arm is the backstop; this is the thing it is backstopping.
    const tail = src.split('main().then(')[1] ?? '';
    expect(tail, 'the main() tail is missing').toBeTruthy();
    expect(tail).toMatch(/TOKEN\}=INDETERMINATE/);
  });

  it('still deploys 0/1/3, the mapping the lane arms assume', () => {
    expect(src).toMatch(/EXIT = \{ PASS: 0, FAIL: 1, INDETERMINATE: 3 \}/);
  });
});
