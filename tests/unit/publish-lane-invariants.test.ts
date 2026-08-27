/**
 * OPS-PUBLISH-LANE-PRE-VERIFY-W1 R1 — pin `publish-npm.yml`'s hard-won properties PRE-MERGE.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────
 *
 * `publish-npm.yml` is the only lane in this repo with no pre-merge exercise. Its steps run
 * exclusively during a real publish, and a publish happens only AFTER `scripts/land.sh` has
 * landed, the tag is cut, the GitHub Release is published and prod is deployed. So a defect there
 * is structurally undiscoverable until a release already depends on it, and every fix becomes a
 * mid-flight repair with the version public on three surfaces and npm behind. Three occurrences
 * in three releases, all real, none caught by review:
 *
 *   v1.28.0  `actions/checkout@v4` carried no `fetch-depth`, so `check-test-budget.mjs` could not
 *            resolve `origin/main` from a tag checkout → INDETERMINATE/3 → `prepublishOnly` died.
 *   v1.28.2  `snapshot-landing-data.mjs` rewrites `landing/docs.html` AND `docs-src/template.html`;
 *            `build_docs --check` (prepublishOnly step 11) then failed on that mutation. Purely an
 *            ORDERING defect — every step involved was individually correct.
 *   v1.23.3  a `NODE_AUTH_TOKEN` env on the publish step made npm authenticate with the token and
 *   /v1.24.0 silently SKIP the OIDC exchange. Nothing failed; the wrong auth path just won.
 *
 * This is a STATIC test, deliberately. It cannot see emergent breakage — the rehearsal job
 * (`.github/workflows/publish-lane-preverify.yml`) owns that. What it can do is make a regression
 * to these four properties UNLANDABLE, because it runs in the normal suite: the `pre-push` test
 * gate, `deploy.yml` and `postgres-lane.yml`.
 *
 * ── OVERLAP WITH THE INCUMBENT, STATED RATHER THAN DISCOVERED LATER ─────────────────────────
 *
 * `tests/unit/ci-git-context.test.ts` ALREADY pins two of these four, and this file does not
 * pretend otherwise:
 *
 *   • invariant 1 — it asserts every checkout in a suite-running, off-main workflow has
 *     `fetch-depth: 0`, with `publish-npm.yml` named explicitly. Its subject is the GENERIC
 *     property "a suite run off main must see main"; the publish lane is one instance of it.
 *   • invariant 2 — it asserts the raw source matches `merge-base --is-ancestor` and
 *     `PUBLISH_ANCESTRY_VERDICT=` whenever `workflow_dispatch` is present. A RAW-TEXT match with
 *     no notion of steps, so it cannot see WHERE the guard sits.
 *
 * What this file adds is STRUCTURE: the four invariants are asserted over the parsed STEP LIST of
 * the job that actually publishes — so invariant 1 is scoped to that job's own checkout rather
 * than to "every checkout in the file", and invariant 2 gains the clause the incumbent cannot
 * express at all, namely that the guard RUNS BEFORE install and publish. Invariants 3 and 4 were
 * pinned nowhere: measured at authoring time, `NODE_AUTH_TOKEN` appeared in zero files under
 * `tests/` or `scripts/`, and no test read the injector/rebuild/publish ordering.
 *
 * `tests/unit/release-tag-order.test.ts` owns the `--follow-tags` ban and the land-then-tag
 * ordering. Not repeated here.
 *
 * ── ONE PARSER, NOT TWO ─────────────────────────────────────────────────────────────────────
 *
 * Every assertion below — the real file and every prove-it-can-fail fixture — goes through the
 * SAME `parseLane()`. Two readers of one grammar drift, and the bug returns in whichever copy
 * nobody is watching.
 *
 * It parses with `js-yaml` rather than grepping, and that choice is load-bearing for invariant 3
 * specifically: `publish-npm.yml` mentions `NODE_AUTH_TOKEN` on FOUR comment lines, one of them
 * sitting immediately above the publish step. A substring match reads that explanation as a
 * violation and lands red on a correct lane — so the assertion keys on an `env:` BINDING in the
 * parsed step, where comments do not exist by construction.
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
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface Lane {
  /** Steps of the job that actually publishes — never "the first job". */
  steps: Step[];
  jobId: string | null;
}

/** Structural read of the publishing job's step list. Comments are gone by construction. */
function parseLane(src: string): Lane {
  let doc: Record<string, unknown> = {};
  try {
    doc = (yaml.load(src) as Record<string, unknown>) ?? {};
  } catch {
    return { steps: [], jobId: null };
  }
  const jobs = (doc.jobs ?? {}) as Record<string, { steps?: unknown[] }>;

  // Identify the publishing job BY WHAT IT DOES, never by its key. A job renamed from `publish`
  // must not silently drop every assertion below to a vacuous pass.
  for (const [jobId, job] of Object.entries(jobs)) {
    const raw = job?.steps ?? [];
    const steps: Step[] = raw.map((s, index) => {
      const step = (s ?? {}) as Record<string, unknown>;
      return {
        index,
        name: typeof step.name === 'string' ? step.name : '',
        uses: typeof step.uses === 'string' ? step.uses : undefined,
        run: typeof step.run === 'string' ? step.run : undefined,
        with: (step.with ?? undefined) as Record<string, unknown> | undefined,
        env: (step.env ?? undefined) as Record<string, unknown> | undefined,
      };
    });
    if (steps.some((s) => /\bnpm publish\b/.test(s.run ?? ''))) return { steps, jobId };
  }
  return { steps: [], jobId: null };
}

const find = (lane: Lane, pred: (s: Step) => boolean): Step | undefined => lane.steps.find(pred);
const idx = (lane: Lane, pred: (s: Step) => boolean): number => lane.steps.findIndex(pred);

const isCheckout = (s: Step) => (s.uses ?? '').startsWith('actions/checkout');
const isAncestorGuard = (s: Step) => /merge-base\s+--is-ancestor/.test(s.run ?? '');
const isInstall = (s: Step) => /(^|\s)npm ci(\s|$)/m.test(s.run ?? '');
const isInjector = (s: Step) => /scripts\/snapshot-landing-data\.mjs/.test(s.run ?? '');
const isDocsRebuild = (s: Step) => /scripts\/build_docs\.mjs/.test(s.run ?? '');
const isPublish = (s: Step) => /\bnpm publish\b/.test(s.run ?? '');

/** Every place a step can bind an environment variable — the `env:` map is the only real one. */
function bindsAuthToken(s: Step | undefined): boolean {
  if (!s) return false;
  return Object.keys(s.env ?? {}).some((k) => k.toUpperCase() === 'NODE_AUTH_TOKEN');
}

const SRC = existsSync(LANE) ? readFileSync(LANE, 'utf8') : '';
const lane = parseLane(SRC);

describe('publish-npm.yml — the lane invariants, asserted over its parsed step list', () => {
  it('the corpus is non-empty (a vacuous parse must never read as a clean lane)', () => {
    // WE construct this corpus by pointing at one known file, so empty here means the test read
    // nothing — a defect in the test, not a fact about the lane. REFUSE rather than pass.
    expect(existsSync(LANE), `${LANE} is missing — if the lane was renamed, re-point this test`).toBe(true);
    expect(SRC.length, 'the lane file is empty').toBeGreaterThan(0);
    expect(lane.jobId, 'no job in publish-npm.yml runs `npm publish` — the parser found nothing to assert on').toBeTruthy();
    expect(lane.steps.length, 'the publishing job has no steps').toBeGreaterThan(0);
  });

  it('INVARIANT 1 — the publishing job checks out with fetch-depth: 0', () => {
    // The v1.28.0 defect. A shallow tag checkout cannot resolve `origin/main`, so any gate that
    // compares against it degrades to INDETERMINATE — which is the honest verdict, and it blocks.
    // Scoped to THIS job's checkout, which is what the incumbent generic assertion cannot express.
    const checkout = find(lane, isCheckout);
    expect(checkout, 'INVARIANT 1 (fetch-depth): the publishing job has no actions/checkout step').toBeTruthy();
    expect(
      Number(checkout!.with?.['fetch-depth']),
      'INVARIANT 1 (fetch-depth): the publishing job must check out with `fetch-depth: 0`. A depth-1 ' +
        'checkout of a TAG fetches only that tag, refs/remotes/origin/main never exists, and every ' +
        'gate comparing against it answers INDETERMINATE and blocks the publish (v1.28.0).',
    ).toBe(0);
  });

  it('INVARIANT 2 — the ancestor guard exists and runs BEFORE install and publish', () => {
    // Guards the `workflow_dispatch` door: without it a manual run can publish a tree that never
    // landed. The ORDERING clause is the part no incumbent test can see — a guard that runs after
    // install has already paid for the thing it was meant to refuse, and one that runs after
    // publish is decoration.
    const guard = idx(lane, isAncestorGuard);
    const install = idx(lane, isInstall);
    const publish = idx(lane, isPublish);

    expect(
      guard,
      'INVARIANT 2 (ancestor guard): no step runs `git merge-base --is-ancestor`. A publish must ' +
        'materialize a commit that landed on origin/main — the same rule ops/scripts/host-deploy.sh ' +
        'enforces for deploys.',
    ).toBeGreaterThanOrEqual(0);
    expect(
      find(lane, isAncestorGuard)!.run,
      'INVARIANT 2 (ancestor guard): the guard must emit its verdict token — callers gate on the TOKEN, never the exit code.',
    ).toMatch(/PUBLISH_ANCESTRY_VERDICT=/);
    expect(install, 'INVARIANT 2 (ancestor guard): no `npm ci` step found to order against').toBeGreaterThanOrEqual(0);
    expect(
      guard < install,
      `INVARIANT 2 (ancestor guard): the guard is at step ${guard} but install is at ${install} — a ` +
        'bad ref must cost nothing and reach nothing, so the refusal runs before install.',
    ).toBe(true);
    expect(
      guard < publish,
      `INVARIANT 2 (ancestor guard): the guard is at step ${guard} but publish is at ${publish} — a ` +
        'guard that runs after the publish it exists to refuse is decoration.',
    ).toBe(true);
  });

  it('INVARIANT 3 — the publish step carries NO NODE_AUTH_TOKEN env binding', () => {
    // The measured v1.23.3 / v1.24.0 failure. `setup-node`'s `registry-url` writes an .npmrc with
    // `_authToken=${NODE_AUTH_TOKEN}`; with that env SET on the publish step npm authenticates
    // with the token and NEVER performs the OIDC exchange. Nothing fails — the wrong auth path
    // just wins, silently. A "keep the token as a fallback" model is therefore INVALID.
    //
    // Keyed on the parsed `env:` map, NOT on the token name appearing in the file: four COMMENT
    // lines mention it, one immediately beside the publish step, and a substring match would read
    // the explanation as the violation.
    const publish = find(lane, isPublish);
    expect(publish, 'INVARIANT 3 (no auth token): no `npm publish` step found').toBeTruthy();
    expect(
      bindsAuthToken(publish),
      'INVARIANT 3 (no auth token): the publish step binds NODE_AUTH_TOKEN. A present token makes ' +
        'npm skip the OIDC exchange entirely and publish under the token instead — measured on ' +
        'v1.23.3 and v1.24.0. OIDC trusted publishing requires NO token env on this step.',
    ).toBe(false);
  });

  it('INVARIANT 4 — ordering is injector → docs rebuild → publish', () => {
    // The v1.28.2 defect was PURELY ordering; every step involved was individually correct.
    // `snapshot-landing-data.mjs` rewrites landing/docs.html AND docs-src/template.html, so
    // prepublishOnly's `build_docs --check` then compares a freshly-injected artifact against a
    // regeneration from a freshly-injected template and they disagree. Rebuilding AFTER the
    // injector restores self-consistency; rebuilding BEFORE it restores nothing.
    const injector = idx(lane, isInjector);
    const rebuild = idx(lane, isDocsRebuild);
    const publish = idx(lane, isPublish);

    expect(injector, 'INVARIANT 4 (ordering): no `scripts/snapshot-landing-data.mjs` step').toBeGreaterThanOrEqual(0);
    expect(rebuild, 'INVARIANT 4 (ordering): no `scripts/build_docs.mjs` rebuild step').toBeGreaterThanOrEqual(0);
    expect(publish, 'INVARIANT 4 (ordering): no `npm publish` step').toBeGreaterThanOrEqual(0);
    expect(
      injector < rebuild,
      `INVARIANT 4 (ordering): the injector is at step ${injector} and the docs rebuild at ${rebuild}. ` +
        'The rebuild must run AFTER the injector — reversed, prepublishOnly\'s `build_docs --check` ' +
        'fails on the injector\'s own mutation (v1.28.2, publish run 32980710335, step 11 of 23).',
    ).toBe(true);
    expect(
      rebuild < publish,
      `INVARIANT 4 (ordering): the docs rebuild is at step ${rebuild} and publish at ${publish} — a ` +
        'rebuild after the publish cannot keep prepublishOnly self-consistent.',
    ).toBe(true);
  });
});

describe('the canary is PROVEN able to fail', () => {
  // Not ceremony. An assertion nobody has watched go red is a hope. Each fixture below is the REAL
  // lane source, deliberately broken ONE way, read through the SAME parseLane() the cases above
  // use — and each mutation asserts it APPLIED before it asserts the invariant breaks, because a
  // mutation that silently no-ops reads exactly like a weak assertion.
  const mutate = (from: string | RegExp, to: string) => {
    const out = SRC.replace(from, to);
    expect(out, `mutation did not apply: ${String(from)}`).not.toBe(SRC);
    return out;
  };

  it('removing fetch-depth breaks INVARIANT 1 and nothing else', () => {
    const broken = parseLane(mutate(/\n\s*with:\n\s*fetch-depth: 0\n/, '\n'));
    expect(Number(find(broken, isCheckout)?.with?.['fetch-depth'])).not.toBe(0);
    // The other three still hold — a mutation that reds everything proves nothing about which
    // assertion is load-bearing.
    expect(bindsAuthToken(find(broken, isPublish))).toBe(false);
    expect(idx(broken, isInjector)).toBeLessThan(idx(broken, isDocsRebuild));
  });

  it('deleting the ancestor-guard step breaks INVARIANT 2', () => {
    const broken = parseLane(
      mutate(
        /      - name: Refuse a tree that is not an ancestor of origin\/main[\s\S]*?(?=      - name: Setup Node)/,
        '',
      ),
    );
    expect(idx(broken, isAncestorGuard)).toBe(-1);
    expect(Number(find(broken, isCheckout)?.with?.['fetch-depth'])).toBe(0); // 1 survives
  });

  it('moving the ancestor guard AFTER install breaks INVARIANT 2\'s ordering clause', () => {
    // The guard still EXISTS, so the incumbent raw-text assertion in ci-git-context.test.ts stays
    // green on this mutation. That gap is the reason the ordering clause is expressed here.
    const guardBlock = SRC.match(
      /      - name: Refuse a tree that is not an ancestor of origin\/main[\s\S]*?(?=      - name: Setup Node)/,
    )![0];
    const moved = SRC.replace(guardBlock, '').replace(
      '      - name: Compile TS\n',
      `${guardBlock}      - name: Compile TS\n`,
    );
    expect(moved).not.toBe(SRC);
    const broken = parseLane(moved);
    expect(idx(broken, isAncestorGuard)).toBeGreaterThanOrEqual(0); // still present…
    expect(idx(broken, isAncestorGuard) < idx(broken, isInstall)).toBe(false); // …but too late
  });

  it('binding NODE_AUTH_TOKEN on the publish step breaks INVARIANT 3', () => {
    const broken = parseLane(
      mutate(
        '      - name: Publish to npm with provenance\n        run: npm publish --provenance',
        '      - name: Publish to npm with provenance\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n        run: npm publish --provenance',
      ),
    );
    expect(bindsAuthToken(find(broken, isPublish))).toBe(true);
  });

  it('a COMMENT mentioning NODE_AUTH_TOKEN is not mistaken for a binding', () => {
    // The false-positive direction, which is what would have landed this test red on a correct
    // lane. The unmutated file already carries four such comments; assert the clean read directly.
    expect(/NODE_AUTH_TOKEN/.test(SRC), 'the lane really does mention the token in prose').toBe(true);
    expect(bindsAuthToken(find(lane, isPublish))).toBe(false);
  });

  it('moving the rebuild ABOVE the injector breaks INVARIANT 4', () => {
    const swapped = SRC.replace('node scripts/snapshot-landing-data.mjs', '__PLACEHOLDER__')
      .replace('node scripts/build_docs.mjs', 'node scripts/snapshot-landing-data.mjs')
      .replace('__PLACEHOLDER__', 'node scripts/build_docs.mjs');
    expect(swapped).not.toBe(SRC);
    const broken = parseLane(swapped);
    expect(idx(broken, isInjector)).toBeGreaterThan(idx(broken, isDocsRebuild));
    expect(idx(broken, isInjector) < idx(broken, isDocsRebuild)).toBe(false);
  });

  it('an UNPARSEABLE lane yields an empty corpus, which the vacuity guard refuses', () => {
    // Input we were HANDED and could not parse is never a pass. parseLane() returns an empty
    // corpus, and the first case above is what turns that into a refusal.
    const broken = parseLane('jobs:\n  publish:\n    steps:\n      - name: [unclosed\n');
    expect(broken.jobId).toBeNull();
    expect(broken.steps.length).toBe(0);
  });
});
