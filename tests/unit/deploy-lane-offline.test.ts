/**
 * OPS-DEPLOY-LANE-NETWORK-FREE-W1 — the deploy lane is network-free, and this file is what makes
 * that a pre-land fact rather than a deploy-time surprise.
 *
 * What runs where:
 *   · deploy.yml's lane_close step runs the RUNTIME half on every deploy (the ledger: did any gate
 *     in the window read the network).
 *   · THIS file runs the STRUCTURAL half against the real deploy.yml inside the suite, so it runs
 *     in the pre-push test gate and in land.sh — a commit that adds a pre-deploy step outside the
 *     window, or gives a window step its own `shell:`, is refused before it reaches main.
 *
 * The reproduction below runs the REAL primitive-resolution gate both ways through the REAL
 * wrapper, preload and shim. Pre-fix shape (its live leg inside the window) → refused, recorded,
 * judged FAIL. Post-fix shape (self-test only inside the window) → judged PASS. No real network
 * connection is made in either direction: the guard refuses before connect.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  checkStructure,
  judgeLedger,
  loadWorkflow,
  selfTest,
  OPEN_ID,
  CLOSE_ID,
  BOUNDARY,
} from '../../scripts/check-deploy-lane-offline.mjs';

const ROOT = process.cwd();
const WORKFLOW = join(ROOT, '.github', 'workflows', 'deploy.yml');

/** Run one step body through the real job shell with the window open; return the ledger. */
function inWindow(stepBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-lane-test-'));
  try {
    const ledger = join(dir, 'ledger');
    writeFileSync(ledger, 'OPEN\ttest\n');
    const step = join(dir, 'step.sh');
    writeFileSync(step, `${stepBody}\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, DEPLOY_LANE_OFFLINE: '1', DEPLOY_LANE_OFFLINE_LEDGER: ledger, GITHUB_ACTION: 'unit' };
    delete env.NODE_OPTIONS;
    spawnSync('bash', [join(ROOT, 'scripts', 'ci', 'deploy-lane-shell.sh'), step], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    return readFileSync(ledger, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('deploy-lane-offline — the gate and its proof', () => {
  it("the gate's own two-way self-test passes (it drives the real wrapper, preload and shim)", { timeout: 60_000 }, () => {
    expect(selfTest()).toBe(true);
  });
});

describe('deploy-lane-offline — the real deploy.yml', () => {
  const loaded = loadWorkflow(WORKFLOW);
  const doc = loaded.doc as { jobs: { deploy: { steps: Array<Record<string, unknown>> } } };

  it('parses', () => {
    expect(loaded.error).toBeUndefined();
  });

  it('passes the structural check', () => {
    const s = checkStructure(doc);
    expect(s.problems).toEqual([]);
    expect(s.verdict).toBe('PASS');
  });

  it('guards every run step between lane_open and lane_close, plus lane_close itself', () => {
    const steps = doc.jobs.deploy.steps;
    const o = steps.findIndex((x) => x.id === OPEN_ID);
    const c = steps.findIndex((x) => x.id === CLOSE_ID);
    expect(o).toBeGreaterThan(0);
    expect(steps[c + 1]?.name).toBe(BOUNDARY);
    expect(checkStructure(doc).expectedSteps).toBe(c - o);
    expect(c - o).toBeGreaterThan(50); // the gate block is ~60 steps; a collapse to a handful is a broken parse
  });

  it('runs NO live primitive-resolution read before the deploy, and runs it after', () => {
    const steps = doc.jobs.deploy.steps;
    const deployAt = steps.findIndex((x) => x.name === BOUNDARY);
    const invocations = steps.flatMap((x, i) =>
      String(x.run ?? '')
        .split('\n')
        .filter((l) => /check-primitive-resolution\.mjs/.test(l) && !/^\s*#/.test(l))
        .map((l) => ({ i, live: !/--self-test|--show-config/.test(l) })),
    );
    expect(invocations.filter((v) => v.i < deployAt && v.live)).toEqual([]);
    expect(invocations.some((v) => v.i < deployAt && !v.live)).toBe(true);
    const post = invocations.filter((v) => v.i > deployAt && v.live);
    expect(post.length).toBe(1);
    const postStep = String(steps[post[0].i].run);
    expect(postStep).toMatch(/PRIMITIVE_RESOLUTION_VERDICT=PASS\)/);
    expect(postStep).toMatch(/PRIMITIVE_RESOLUTION_VERDICT=INDETERMINATE\) echo "::warning::/);
    expect(postStep).toMatch(/\*\) echo "::error::[^\n]*exit 1/);
  });

  it('a pre-deploy step added outside the window is refused BEFORE it reaches main', () => {
    const mutated = yaml.load(readFileSync(WORKFLOW, 'utf8')) as typeof doc;
    const steps = mutated.jobs.deploy.steps;
    steps.splice(steps.findIndex((x) => x.id === OPEN_ID), 0, { name: 'Live registry check (fail-closed)', run: 'node scripts/check-live-thing.mjs' });
    expect(checkStructure(mutated).verdict).toBe('FAIL');
  });

  it('a window step that brings its own shell is refused', () => {
    const mutated = yaml.load(readFileSync(WORKFLOW, 'utf8')) as typeof doc;
    const steps = mutated.jobs.deploy.steps;
    steps[steps.findIndex((x) => x.id === OPEN_ID) + 1].shell = 'bash';
    expect(checkStructure(mutated).verdict).toBe('FAIL');
  });
});

describe('deploy-lane-offline — reproduction on the gate that caused the drift', () => {
  it('PRE-FIX shape: the live primitive-resolution leg inside the window is refused, recorded and judged FAIL', { timeout: 60_000 }, () => {
    const ledger = inWindow('node scripts/check-primitive-resolution.mjs || true');
    expect(ledger).toMatch(/^ATTEMPT\tcurl\thttps:\/\/(api\.algovault\.com\/mcp|registry\.npmjs\.org\/)/m);
    expect(ledger).toMatch(/^ATTEMPT\t[^\n]*check-primitive-resolution\.mjs/m);
    expect(judgeLedger(ledger, 1).verdict).toBe('FAIL');
  });

  it('POST-FIX shape: the offline self-test inside the window reads nothing and is judged PASS', { timeout: 60_000 }, () => {
    const ledger = inWindow('node scripts/check-primitive-resolution.mjs --self-test');
    expect(ledger).not.toMatch(/^ATTEMPT/m);
    expect(ledger).toMatch(/^LOADED\tnode\t-\tscripts\/check-primitive-resolution\.mjs/m);
    expect(judgeLedger(ledger, 1).verdict).toBe('PASS');
  });
});
