/**
 * OPS-PUBLISH-LANE-PRE-VERIFY-W1 R2 — the rehearsal is STRUCTURALLY INCAPABLE OF PUBLISHING.
 *
 * `.github/workflows/publish-lane-preverify.yml` reproduces the publish lane on an ordinary day so
 * that emergent breakage — the v1.28.2 injector/rebuild ordering case, where every step was
 * individually correct — is discovered before a release depends on it. That is only acceptable if
 * the rehearsal can never become a publish, and "can never" has to be ASSERTED, not intended:
 * the file sits beside a lane that legitimately holds `id-token: write` and a publishing verb, and
 * a copy-paste between the two is exactly the mistake this pins.
 *
 * The three controls, in order of strength:
 *   1. it requests NO `id-token: write` — so even a mistaken edit cannot mint a publishing token;
 *   2. it carries no npm credential and no `registry-url` — so no .npmrc _authToken line is ever
 *      written into the runner;
 *   3. the publishing verb is never invoked.
 *
 * `--dry-run` on the pack is belt-and-braces, not a control, and is deliberately not asserted as
 * one: a control that depends on a flag is one flag away from gone.
 *
 * ── COMMENTS ARE STRIPPED BEFORE EVERY BAN-GREP ─────────────────────────────────────────────
 *
 * Both files EXPLAIN, at length, why they must not publish — so the words "npm publish",
 * "NODE_AUTH_TOKEN" and "id-token: write" all appear in their prose. A naive substring match reads
 * the explanation as the violation and demands the deletion of the most valuable lines in the
 * file. scripts/check-canaries-wired.mjs already strips comments for exactly this reason ("a
 * mention in a comment is not an invocation"); the same rule applies here, and the
 * false-positive direction is asserted alongside the true one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

const ROOT = resolve(__dirname, '..', '..');
const WF = join(ROOT, '.github', 'workflows', 'publish-lane-preverify.yml');
const LANE = join(ROOT, '.github', 'workflows', 'publish-npm.yml');
const GATE = join(ROOT, 'scripts', 'check-publish-lane-preverify.mjs');

/** YAML: drop whole-line comments. A mention in prose is not a setting. */
const stripYamlComments = (s: string) =>
  s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** JS: drop block and line comments. Same rule, different grammar. */
const stripJsComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const WF_SRC = existsSync(WF) ? readFileSync(WF, 'utf8') : '';
const WF_CODE = stripYamlComments(WF_SRC);
const GATE_SRC = existsSync(GATE) ? readFileSync(GATE, 'utf8') : '';
const GATE_CODE = stripJsComments(GATE_SRC);
const doc = (yaml.load(WF_SRC) ?? {}) as Record<string, any>;
// `on:` parses to the YAML 1.1 boolean `true` — a real and well-known footgun.
const on = (doc.on ?? doc[true as unknown as string] ?? doc['true']) as Record<string, any>;
const job = Object.values((doc.jobs ?? {}) as Record<string, any>)[0] as { steps?: any[] } | undefined;
const steps: any[] = job?.steps ?? [];
const runText = steps.map((s) => String(s?.run ?? '')).join('\n');

describe('the rehearsal exists and was actually parsed', () => {
  it('the corpus is non-empty (a vacuous parse must never read as a safe workflow)', () => {
    // WE point at one known file, so empty here is a defect in the test, not a fact about the
    // workflow. REFUSE rather than pass every ban-grep against an empty string.
    expect(existsSync(WF), `${WF} is missing`).toBe(true);
    expect(existsSync(GATE), `${GATE} is missing`).toBe(true);
    expect(WF_CODE.length).toBeGreaterThan(0);
    expect(steps.length, 'the rehearsal job has no steps').toBeGreaterThan(0);
  });
});

describe('structurally incapable of publishing', () => {
  it('requests NO id-token: write — the strongest of the three controls', () => {
    expect(doc.permissions, 'the rehearsal must declare its permissions explicitly').toEqual({ 'contents': 'read' });
    expect(
      /id-token/.test(WF_CODE),
      'the rehearsal must NOT request id-token: write. publish-npm.yml needs it for provenance; ' +
        'this job must not, so even a mistaken edit here cannot mint a publishing token.',
    ).toBe(false);
  });

  it('never invokes the publishing verb (comments stripped)', () => {
    expect(
      /npm\s+publish/.test(WF_CODE),
      'the rehearsal workflow invokes npm publish — it must stop before that line',
    ).toBe(false);
    expect(
      /npm\s+publish/.test(GATE_CODE),
      'the rehearsal gate invokes npm publish — it must stop before that line',
    ).toBe(false);
  });

  it('carries NO npm credential and no registry-url', () => {
    expect(/NODE_AUTH_TOKEN/.test(WF_CODE), 'the rehearsal binds NODE_AUTH_TOKEN').toBe(false);
    expect(/NPM_TOKEN/.test(WF_CODE), 'the rehearsal references an npm token secret').toBe(false);
    expect(
      /registry-url/.test(WF_CODE),
      "setup-node's registry-url is what writes an .npmrc carrying _authToken — the rehearsal has " +
        'no reason to authenticate to a registry, so the line must be absent rather than neutralised.',
    ).toBe(false);
    expect(/secrets\./.test(WF_CODE), 'the rehearsal reads a repository secret').toBe(false);
  });

  it('never commits and never pushes (the injector mutates the tree BY DESIGN)', () => {
    expect(/git\s+(commit|push)/.test(WF_CODE), 'the rehearsal commits or pushes').toBe(false);
    expect(/git\s+(commit|push)/.test(GATE_CODE), 'the rehearsal gate commits or pushes').toBe(false);
  });

  it('the ban-greps are PROVEN not to fire on prose — the false-positive direction', () => {
    // Both files explain at length why they must not publish, so the banned words really are
    // present in their comments. If these ever go false, the stripper stopped stripping and every
    // assertion above became vacuous.
    expect(/npm publish/.test(WF_SRC), 'the workflow really does discuss publishing in prose').toBe(true);
    expect(/id-token/.test(WF_SRC), 'the workflow really does discuss id-token in prose').toBe(true);
    expect(/NODE_AUTH_TOKEN/.test(WF_SRC), 'the workflow really does discuss the token in prose').toBe(true);
    expect(/npm publish/.test(GATE_SRC), 'the gate really does discuss publishing in prose').toBe(true);
  });
});

describe('it mirrors the lane it rehearses', () => {
  const laneSrc = readFileSync(LANE, 'utf8');
  const step = (pred: (s: any) => boolean) => steps.find(pred);

  it('checks out with fetch-depth: 0, like the lane', () => {
    // A depth-1 clone cannot resolve origin/main, so check-test-budget.mjs would answer
    // INDETERMINATE forever and the rehearsal would verify nothing while looking healthy.
    const checkout = step((s) => String(s?.uses ?? '').startsWith('actions/checkout'));
    expect(checkout, 'no actions/checkout step').toBeTruthy();
    expect(Number(checkout.with?.['fetch-depth'])).toBe(0);
  });

  it('runs the same Node major and the same npm pin the lane publishes under', () => {
    const setup = step((s) => String(s?.uses ?? '').startsWith('actions/setup-node'));
    expect(setup, 'no actions/setup-node step').toBeTruthy();
    const laneNode = /node-version:\s*'([^']+)'/.exec(laneSrc)?.[1];
    expect(String(setup.with?.['node-version']), 'Node major must track the lane').toBe(laneNode);

    const lanePin = /npm install -g (npm@[\d.]+)/.exec(laneSrc)?.[1];
    expect(lanePin, 'the lane no longer pins npm — re-point this assertion').toBeTruthy();
    expect(runText, `npm pin must track the lane (${lanePin})`).toContain(`npm install -g ${lanePin}`);
  });

  it('installs and compiles exactly as the lane does', () => {
    expect(runText).toMatch(/^\s*npm ci\s*$/m);
    expect(runText).toMatch(/npm run build/);
  });

  it('reaches the lane through prepublishOnly and then the pack manifest', () => {
    // npm pack runs prepack -> prepare -> postpack and NEVER prepublishOnly, so a rehearsal built
    // on pack alone would silently skip the 23-step chain that has broken twice. The gate runs the
    // literal lifecycle invocation; assert it, not a paraphrase.
    expect(GATE_CODE).toMatch(/'run',\s*'prepublishOnly'/);
    expect(GATE_CODE).toMatch(/'pack',\s*'--dry-run'/);
  });
});

describe('triggers', () => {
  it('is scheduled daily and off the :00 boundary', () => {
    const crons: string[] = (on?.schedule ?? []).map((s: { cron: string }) => s.cron);
    expect(crons.length, 'the rehearsal has no schedule — it would only ever run on a PR touching the lane').toBe(1);
    const minute = crons[0].split(/\s+/)[0];
    expect(Number(minute), 'a :00 cron collides with every other :00 job').not.toBe(0);
  });

  it('can be run by hand', () => {
    expect(Object.keys(on ?? {})).toContain('workflow_dispatch');
  });

  it('LISTS ITS OWN PATH in every paths filter', () => {
    // A paths-filtered workflow that omits its own path never runs on the commit introducing it
    // and can never re-run when the gate itself changes — and its empty run list reads identically
    // to "nothing to check".
    const self = '.github/workflows/publish-lane-preverify.yml';
    for (const trigger of ['pull_request', 'push'] as const) {
      expect(on?.[trigger]?.paths, `${trigger} has no paths filter`).toBeTruthy();
      expect(on[trigger].paths, `${trigger} omits its own path`).toContain(self);
    }
  });

  it('watches every path that can break the lane', () => {
    const required = [
      '.github/workflows/publish-npm.yml',
      'scripts/snapshot-landing-data.mjs',
      'scripts/build_docs.mjs',
      'package.json',
    ];
    for (const trigger of ['pull_request', 'push'] as const) {
      for (const p of required) {
        expect(on[trigger].paths, `${trigger} does not watch ${p}`).toContain(p);
      }
    }
  });
});

describe('the verdict contract', () => {
  it('the workflow branches on the TOKEN, never on the bare exit code', () => {
    expect(runText).toContain('PUBLISH_LANE_PREVERIFY_VERDICT=PASS');
    expect(runText).toContain('PUBLISH_LANE_PREVERIFY_VERDICT=INDETERMINATE');
    // INDETERMINATE must WARN, never red: a third party being down is not our lane breaking, and
    // a gate that reds on someone else's outage is one that gets ignored.
    expect(runText).toMatch(/PUBLISH_LANE_PREVERIFY_VERDICT=INDETERMINATE\)[\s\S]*?::warning::/);
    // …and the catch-all must red, so a FAIL or a missing token is an operator signal.
    expect(runText).toMatch(/\*\)[\s\S]*?::error::[\s\S]*?exit 1/);
  });

  it('runs the classifier self-test BEFORE letting it report on the lane', () => {
    const selfTestIdx = steps.findIndex((s) => /check-publish-lane-preverify\.mjs --self-test/.test(String(s?.run ?? '')));
    const reportIdx = steps.findIndex((s) => /check-publish-lane-preverify\.mjs \|/.test(String(s?.run ?? '')));
    expect(selfTestIdx, 'no self-test step').toBeGreaterThanOrEqual(0);
    expect(reportIdx, 'no rehearsal step').toBeGreaterThanOrEqual(0);
    expect(selfTestIdx < reportIdx, 'a gate whose own logic is broken must never report on the corpus').toBe(true);
  });

  it('the gate deploys 0=PASS / 1=FAIL / 3=INDETERMINATE — the token-law default for a NEW gate', () => {
    expect(GATE_CODE).toMatch(/EXIT\s*=\s*\{\s*PASS:\s*0,\s*FAIL:\s*1,\s*INDETERMINATE:\s*3\s*\}/);
  });

  // Explicit budget in the OPTIONS argument: this block spawns a subprocess, and a test written
  // today may not inherit the 5,000ms default. ~76ms measured; 30s is generous headroom on a
  // loaded runner without letting a hung child stall the suite.
  it('the gate self-test passes and PROVES the classifier both ways', { timeout: 30_000 }, () => {
    const out = execFileSync('node', [GATE, '--self-test'], { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('PUBLISH_LANE_PREVERIFY_VERDICT=PASS');
    expect(out).toMatch(/self-test: (\d+) passed, 0 failed/);
    // Vacuity: a self-test that ran zero assertions must not read as a pass.
    const passed = Number(/self-test: (\d+) passed/.exec(out)?.[1] ?? 0);
    expect(passed, 'the self-test asserted nothing').toBeGreaterThan(0);
    // The two levers that could launder a red into a green are asserted by name.
    expect(out).toContain('a NON-transport content failure is NOT laundered to INDETERMINATE');
    expect(out).toContain('zero verdict tokens is INDETERMINATE even at exit 0');
  });
});

/**
 * The inventory row, and the decision it records.
 *
 * 🛑 ASSERT THE EXEMPTION, DO NOT MERELY DECLARE IT. `owns_row()` in
 * monitoring-inventory-reconcile.py reduces to `entries_for_host()`, which falls back to
 * `row['host'] in labels` — so a hostless row is owned by NO reconciler instance and can never
 * raise HASH_DRIFT / ORPHAN / DARK / NO_BACKUP. Declared, that is a choice; undeclared, it is a row
 * that looks like coverage and is not. Same shape as docs-samples-live-canary, for the same reason.
 */
describe('the inventory row declares why nothing reconciles it', () => {
  const inventory = JSON.parse(readFileSync(join(ROOT, 'ops/monitoring/monitoring-inventory.json'), 'utf8'));
  const row = inventory.artifacts.find((r: { id: string }) => r.id === 'publish-lane-preverify');

  it('exists and points at the committed gate', () => {
    expect(row, 'publish-lane-preverify row is missing from the inventory').toBeTruthy();
    expect(row.artifact).toBe('scripts/check-publish-lane-preverify.mjs');
    expect(row.invoked_by).toContain('github-actions:publish-lane-preverify.yml');
  });

  it('carries a reconcile_exempt_reason — an exemption without a reason gets "fixed" by a later wave', () => {
    expect(typeof row.reconcile_exempt_reason).toBe('string');
    expect(row.reconcile_exempt_reason.length).toBeGreaterThan(80);
    expect(row.reconcile_exempt_reason).toMatch(/not host-installed|no host copy/i);
  });

  it('stays HOSTLESS and ALERT-LESS — adding either must trip this, not silently re-orphan the row', () => {
    expect(row.host, 'row gained a `host`: it is now owned by a reconciler, so the exemption must be removed in the same wave').toBeUndefined();
    expect(row.installed_at).toBeUndefined();
    expect(
      row.alert_ids,
      'row gained alert_ids: alert-registry.json is derived from send_telegram.sh call sites and this ' +
        'inventory, and a CI-only job has no sender — an id here declares an alert nothing can raise',
    ).toBeUndefined();
  });

  it('its schedule is the workflow\'s own cron, so the off-:00 boundary lint can see it', () => {
    const crons: string[] = (on?.schedule ?? []).map((s: { cron: string }) => s.cron);
    expect(row.schedule, 'inventory schedule is stale — it must equal the workflow cron').toBe(crons[0]);
  });

  it('its sha256 matches the committed gate', () => {
    const sha = createHash('sha256').update(readFileSync(GATE)).digest('hex');
    expect(row.sha256, 'inventory sha256 is stale — regenerate it in the same commit as the script').toBe(sha);
  });
});
