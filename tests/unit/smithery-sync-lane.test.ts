/**
 * OPS-SMITHERY-PUBLISH-LANE-W1 R5 — pin the Smithery re-scan step's load-bearing properties.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 *
 * Smithery keeps a SNAPSHOT of a server's tool list and never revisits it. For five months the
 * search-ranked listing for `algovault/crypto-quant-signal-mcp` advertised 3 tools and "across 5
 * perp venues" while the origin served 8. The repair is a lane step, not a republish — and a lane
 * step in `publish-npm.yml` runs ONLY during a real publish, so a regression to it is structurally
 * undiscoverable until a release already depends on it. That is what this file is for: it runs in
 * the ordinary suite (pre-push gate, deploy.yml, postgres-lane.yml), so a regression is UNLANDABLE.
 *
 * ── THE REGRESSION THIS IS REALLY BUYING ────────────────────────────────────────────────────
 *
 * Assertion 4. A sibling repo (`algovault-skills`) met this same API's auth quirk with
 * `continue-on-error: true`, and that surface then went stale IN SILENCE — nobody learned it had
 * stopped working until someone looked months later. A fail-open lever is how a verification step
 * becomes decoration, and it is always added in a hurry during a release. Making it unlandable is
 * worth more than the step itself.
 *
 * Assertion 7 is the same law one level down: ONE token cannot carry two meanings. Without a
 * separate `SMITHERY_RESCAN=` line, `exit 0` would encode both "re-scanned, listing agrees" and
 * "could not re-scan, stale listing happens to agree" — and the second would surface only at the
 * next release that CHANGES the tool set, which is the worst possible moment to discover it.
 *
 * ── HOW IT ASSERTS ──────────────────────────────────────────────────────────────────────────
 *
 * Structurally, through ONE `js-yaml` parse, reusing the behaviour-based job selector from
 * `tests/unit/publish-lane-invariants.test.ts`: identify the publishing job BY WHAT IT DOES,
 * never by its key, so a renamed job cannot silently drop every assertion to a vacuous pass.
 *
 * Parsing rather than grepping is load-bearing for assertion 4 specifically. The lane carries a
 * deliberate comment explaining WHY `continue-on-error` is banned, and that explanation is the
 * most valuable line in the block — a substring match would read it as a violation and demand its
 * deletion. Comments do not exist in a parsed step, so the assertion keys on the real binding.
 * The same reasoning is already recorded for `NODE_AUTH_TOKEN` in the sibling file, and the
 * raw-text direction is asserted here too so the stripper-free predicate stays honest.
 *
 * The two-token DECISION MATRIX is not asserted here — it lives in
 * `scripts/check-smithery-sync.mjs` as the exported `decideLaneOutcome()`, where a self-test can
 * actually RUN it. This file asserts that the lane EMITS both tokens; that one asserts what the
 * lane does with them. Two readers of one grammar drift.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const LANE = resolve(__dirname, '..', '..', '.github', 'workflows', 'publish-npm.yml');

interface Step {
  index: number;
  name: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  continueOnError: boolean;
}

interface Lane {
  /** Steps of the job that actually publishes — never "the first job". */
  steps: Step[];
  jobId: string | null;
  /** A job-level `env:` would put the secret in scope of the publish step. */
  jobEnv: Record<string, unknown> | null;
  jobContinueOnError: boolean;
}

function parseLane(src: string): Lane {
  const empty: Lane = { steps: [], jobId: null, jobEnv: null, jobContinueOnError: false };
  let doc: Record<string, unknown> = {};
  try {
    doc = (yaml.load(src) as Record<string, unknown>) ?? {};
  } catch {
    return empty;
  }
  const jobs = (doc.jobs ?? {}) as Record<string, Record<string, unknown>>;

  for (const [jobId, job] of Object.entries(jobs)) {
    const raw = (job?.steps ?? []) as unknown[];
    const steps: Step[] = raw.map((s, index) => {
      const step = (s ?? {}) as Record<string, unknown>;
      return {
        index,
        name: typeof step.name === 'string' ? step.name : '',
        uses: typeof step.uses === 'string' ? step.uses : undefined,
        run: typeof step.run === 'string' ? step.run : undefined,
        env: (step.env ?? undefined) as Record<string, unknown> | undefined,
        continueOnError: 'continue-on-error' in step,
      };
    });
    if (steps.some((s) => /\bnpm publish\b/.test(s.run ?? ''))) {
      return {
        steps,
        jobId,
        jobEnv: (job?.env ?? null) as Record<string, unknown> | null,
        jobContinueOnError: 'continue-on-error' in (job ?? {}),
      };
    }
  }
  return empty;
}

const idx = (lane: Lane, pred: (s: Step) => boolean): number => lane.steps.findIndex(pred);
const find = (lane: Lane, pred: (s: Step) => boolean): Step | undefined => lane.steps.find(pred);

const isPublish = (s: Step) => /\bnpm publish\b/.test(s.run ?? '');
const isSmithery = (s: Step) => /api\.smithery\.ai/.test(s.run ?? '');

const SRC = existsSync(LANE) ? readFileSync(LANE, 'utf8') : '';
const lane = parseLane(SRC);

describe('publish-npm.yml — the Smithery re-scan step', () => {
  it('the corpus is non-empty (a vacuous parse must never read as a clean lane)', () => {
    // WE construct this corpus by pointing at one known file, so empty here means the test read
    // nothing — a defect in the test, not a fact about the lane. REFUSE rather than pass.
    expect(existsSync(LANE), `${LANE} is missing — if the lane was renamed, re-point this test`).toBe(true);
    expect(SRC.length, 'the lane file is empty').toBeGreaterThan(0);
    expect(lane.jobId, 'no job in publish-npm.yml runs `npm publish` — the parser found nothing to assert on').toBeTruthy();
    expect(lane.steps.length, 'the publishing job has no steps').toBeGreaterThan(0);
  });

  it('ASSERTION 1 — a step in the publishing job talks to api.smithery.ai', () => {
    expect(
      find(lane, isSmithery),
      'ASSERTION 1 (the step exists): no step in the publishing job references `api.smithery.ai`. ' +
        'Smithery snapshots the tool list at publish time and never revisits it, so without this ' +
        'step the listing drifts from the origin on every release that changes a tool.',
    ).toBeTruthy();
  });

  it('ASSERTION 2 — that step emits the SMITHERY_SYNC_VERDICT token', () => {
    // Phrased like INVARIANT 2 in publish-lane-invariants.test.ts: callers gate on the TOKEN,
    // never the exit code, so a step that can fail open must print a distinguishable verdict.
    const step = find(lane, isSmithery);
    expect(step, 'ASSERTION 2: no Smithery step to assert on').toBeTruthy();
    expect(
      /SMITHERY_SYNC_VERDICT=/.test(step?.run ?? ''),
      'ASSERTION 2 (verdict token): the Smithery step must emit `SMITHERY_SYNC_VERDICT=` — callers ' +
        'gate on the TOKEN, never the exit code. `exit 0` may never encode both "verified, clean" ' +
        'and "verified nothing".',
    ).toBe(true);
  });

  it('ASSERTION 3 — the secret is bound on THAT STEP, and no job-level env exists', () => {
    const step = find(lane, isSmithery);
    expect(step, 'ASSERTION 3: no Smithery step to assert on').toBeTruthy();
    expect(
      Object.keys(step?.env ?? {}).some((k) => k.toUpperCase() === 'SMITHERY_API_KEY'),
      'ASSERTION 3 (step-scoped secret): the Smithery step must bind SMITHERY_API_KEY through its ' +
        'own `env:` map.',
    ).toBe(true);
    expect(
      lane.jobEnv,
      'ASSERTION 3 (no job-level env): a job-level `env:` puts every secret in scope of the ' +
        'publish step, whose whole invariant (INVARIANT 3 in publish-lane-invariants.test.ts) is ' +
        'that it carries no token env — a present token makes npm skip the OIDC exchange.',
    ).toBeNull();
    expect(
      Object.keys(find(lane, isPublish)?.env ?? {}).length,
      'ASSERTION 3: the publish step must still carry no env bindings at all',
    ).toBe(0);
  });

  it('ASSERTION 4 — NO step in the file carries continue-on-error', () => {
    // THE regression this file is really buying. `algovault-skills` answered this same API's auth
    // quirk with `continue-on-error: true` and the surface went stale in silence.
    const offenders = lane.steps.filter((s) => s.continueOnError).map((s) => s.name || `#${s.index}`);
    expect(
      offenders,
      'ASSERTION 4 (no fail-open): a fail-open lever may downgrade an exit code, but on this lane ' +
        'it converts a verification step into decoration — which is exactly how the sibling repo\'s ' +
        'Smithery surface went stale for months without anyone learning it had stopped working.',
    ).toEqual([]);
    expect(lane.jobContinueOnError, 'ASSERTION 4: the publishing job itself must not continue-on-error').toBe(false);

    // The raw-text direction, so the ban does not depend on a parser alone. A YAML KEY is matched
    // at line start; a `#`-prefixed mention is not — which is why the lane may keep the comment
    // that EXPLAINS the ban. The explanation is the most valuable line in that block.
    const keyBindings = SRC.split('\n').filter((l) => /^\s*continue-on-error\s*:/.test(l));
    expect(keyBindings, 'ASSERTION 4 (raw): no line declares continue-on-error as a YAML key').toEqual([]);
    expect(
      /continue-on-error/.test(SRC),
      'the lane really does mention the banned key in prose — if this goes false the comment ' +
        'explaining WHY it is banned was deleted, and the next release will re-add the lever',
    ).toBe(true);
  });

  it('ASSERTION 5 — the Smithery step runs AFTER the publish step', () => {
    const publish = idx(lane, isPublish);
    const smithery = idx(lane, isSmithery);
    expect(publish, 'ASSERTION 5: no `npm publish` step').toBeGreaterThanOrEqual(0);
    expect(smithery, 'ASSERTION 5: no Smithery step').toBeGreaterThanOrEqual(0);
    expect(
      smithery > publish,
      `ASSERTION 5 (ordering): the Smithery step is at ${smithery} and publish at ${publish}. The ` +
        're-scan asserts what the release SHIPPED, so running it before the publish would scan a ' +
        'version that does not exist yet.',
    ).toBe(true);
  });

  it('ASSERTION 6 — the step polls the origin for the tag version before it scans', () => {
    // The deploy.yml race. deploy.yml (push:main) and this lane (push:tags) run concurrently and
    // this lane finishes first, so a re-scan fired without waiting would snapshot the PREVIOUS
    // build under a FRESH timestamp — which looks repaired and is wrong.
    const run = find(lane, isSmithery)?.run ?? '';
    expect(/health/.test(run), 'ASSERTION 6 (readiness poll): the step must read the origin /health').toBe(true);
    expect(
      /GITHUB_REF_NAME/.test(run),
      'ASSERTION 6 (readiness poll): the target version must be derived from the tag, not assumed',
    ).toBe(true);
  });

  it('ASSERTION 7 — the step emits BOTH tokens, so one exit code never carries two meanings', () => {
    const run = find(lane, isSmithery)?.run ?? '';
    expect(
      /SMITHERY_RESCAN=/.test(run),
      'ASSERTION 7 (two tokens): the step must emit `SMITHERY_RESCAN=` alongside the content ' +
        'verdict. With one token, `exit 0` encodes both "re-scanned, listing agrees" and "could ' +
        'not re-scan, the stale listing happens to agree" — and the second rides silently on an ' +
        'unchanged tool set until the next release that changes one.',
    ).toBe(true);
    expect(/SMITHERY_SYNC_VERDICT=/.test(run), 'ASSERTION 7: the content verdict must also be emitted').toBe(true);
    for (const state of ['OK', 'SKIPPED_NO_CREDENTIAL', 'FAILED', 'NOT_ATTEMPTED']) {
      expect(
        run.includes(state),
        `ASSERTION 7 (two tokens): the step never produces SMITHERY_RESCAN=${state}, so that row ` +
          'of the ratified matrix is unreachable — a state nothing can emit is not a state',
      ).toBe(true);
    }
  });
});

describe('the canary is PROVEN able to fail', () => {
  // Not ceremony. An assertion nobody has watched go red is a hope. Each fixture is the REAL lane
  // source, deliberately broken ONE way, read through the SAME parseLane() — and each mutation
  // asserts it APPLIED first, because a mutation that silently no-ops reads exactly like a weak
  // assertion that can never fail.
  const mutate = (from: string | RegExp, to: string) => {
    const out = SRC.replace(from, to);
    expect(out, `mutation did not apply: ${String(from)}`).not.toBe(SRC);
    return out;
  };

  it('stripping the verdict-token line breaks ASSERTION 2', () => {
    // GLOBAL: the step emits this token from TWO branches — the readiness-timeout exit and the
    // verify phase. A mutation stripping only one leaves the other, which would make this test
    // pass against a lane that still emits nothing useful. Strip every emission site.
    const broken = parseLane(mutate(/\n\s*echo "SMITHERY_SYNC_VERDICT=[^"]*"/g, ''));
    const step = find(broken, isSmithery);
    expect(step, 'the step itself must survive this mutation').toBeTruthy();
    // Only the terminal token line is removed; the `case` still reads SYNC, so a substring match
    // on the whole run body would still find the identifier. Assert on the EMITTED line.
    const emits = (step?.run ?? '').split('\n').some((l) => /echo "SMITHERY_SYNC_VERDICT=/.test(l));
    expect(emits, 'with the echo removed the step emits no verdict token').toBe(false);
  });

  it('stripping the SMITHERY_RESCAN line breaks ASSERTION 7', () => {
    // GLOBAL, for the same reason as the verdict-token mutation above.
    const broken = parseLane(mutate(/\n\s*echo "SMITHERY_RESCAN=[^"]*"/g, ''));
    const step = find(broken, isSmithery);
    expect(step, 'the step itself must survive this mutation').toBeTruthy();
    const emits = (step?.run ?? '').split('\n').some((l) => /echo "SMITHERY_RESCAN=/.test(l));
    expect(emits, 'with the echo removed the lane emits no re-scan state').toBe(false);
  });

  it('injecting continue-on-error breaks ASSERTION 4', () => {
    const broken = parseLane(
      mutate(
        '      - name: Re-scan the Smithery listing and verify it against the live origin\n',
        '      - name: Re-scan the Smithery listing and verify it against the live origin\n        continue-on-error: true\n',
      ),
    );
    expect(broken.steps.filter((s) => s.continueOnError).map((s) => s.name)).toEqual([
      'Re-scan the Smithery listing and verify it against the live origin',
    ]);
  });

  it('a COMMENT mentioning continue-on-error is not mistaken for a binding', () => {
    // The false-positive direction — what would land this test red on a CORRECT lane. The
    // unmutated file carries the comment explaining the ban; assert the clean read directly.
    expect(/continue-on-error/.test(SRC), 'the lane really does mention the key in prose').toBe(true);
    expect(lane.steps.filter((s) => s.continueOnError)).toEqual([]);
  });

  it('moving the secret to job level breaks ASSERTION 3', () => {
    const broken = parseLane(
      mutate(
        '    runs-on: ubuntu-latest\n',
        '    runs-on: ubuntu-latest\n    env:\n      SMITHERY_API_KEY: ${{ secrets.SMITHERY_API_KEY }}\n',
      ),
    );
    expect(broken.jobEnv).not.toBeNull();
    expect(Object.keys(broken.jobEnv ?? {})).toContain('SMITHERY_API_KEY');
  });

  it('moving the Smithery step ABOVE publish breaks ASSERTION 5', () => {
    const block = SRC.match(
      /      - name: Re-scan the Smithery listing and verify it against the live origin[\s\S]*$/,
    )![0];
    const moved = SRC.replace(block, '').replace(
      '      - name: Publish to npm with provenance\n',
      `${block}\n      - name: Publish to npm with provenance\n`,
    );
    expect(moved, 'mutation did not apply').not.toBe(SRC);
    const broken = parseLane(moved);
    expect(idx(broken, isSmithery), 'the step is still present…').toBeGreaterThanOrEqual(0);
    expect(idx(broken, isSmithery) > idx(broken, isPublish), '…but now runs too early').toBe(false);
  });

  it('an UNPARSEABLE lane yields an empty corpus, which the vacuity guard refuses', () => {
    // Input we were HANDED and could not parse is never a pass.
    const broken = parseLane('jobs:\n  publish:\n    steps:\n      - name: [unclosed\n');
    expect(broken.jobId).toBeNull();
    expect(broken.steps.length).toBe(0);
  });
});
