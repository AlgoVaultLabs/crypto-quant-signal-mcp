/**
 * OPS-ALARM-SINGLE-DERIVATION-W1 CH1 — the class gate: an alarm ratio reaches a verdict comparison
 * ONLY through `ops/monitoring/population_rate.py`.
 *
 * THE CLASS (counted by root cause at R0, ≥ 5 instances): a ratio or instrument over the wrong
 * population — `@{upstream}`, CF-origin and liveness-band in `verification-gates.md`; the retired
 * book-liveness `SUPPRESSION_CEILING_PCT`; GEO-probe 429s in a denominator; HEADROOM's "counts only
 * the load you are adding"; and now the regime canary's 203 / 3,920 and book-liveness's
 * "29 of the last 28 days". The prose laws already existed and failed as prose, so this is a GATE.
 *
 * `scripts/check-ratio-derivation.py` parses every `ops/monitoring/*.py` whose inventory row has
 * alert ids (AST, never a text grep). It FAILS a NEW division that reaches a comparison without the
 * rate module (unless its line carries `# ratio-exempt: <reason>`), and any `PopulationCounts(`
 * built outside the module. Existing sites live in a committed SHRINK-ONLY baseline.
 *
 * This suite proves the acceptance behaviourally (spec AC4): the gate PASSES the fixed tree, FAILS
 * a planted copy of the pre-fix shape (`build_rate_sql` + `throws*100.0/calls`), and its self-test
 * is proven able to fail by mutation.
 *
 * SPAWN BUDGET DECLARED in every block's OPTIONS argument (`scripts/check-test-budget.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const GATE = path.join(REPO, 'scripts/check-ratio-derivation.py');
const INVENTORY = path.join(REPO, 'ops/monitoring/monitoring-inventory.json');
const BASELINE = path.join(REPO, 'ops/ratio-derivation-baseline.json');
const PRE_FIX = path.join(REPO, 'tests/fixtures/regime-budget-starvation-canary.pre-alarm-single-derivation.py.txt');
const TOKEN = 'RATIO_DERIVATION_VERDICT';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tokenLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => l.startsWith(`${TOKEN}=`));
}

function run(args: string[], gate = GATE) {
  return spawnSync('python3', [gate, ...args], { encoding: 'utf8' });
}

/**
 * A temp tree that is the REAL tree for everything in scope, with one file replaced — so the planted
 * case differs from the passing case by exactly the planted bytes.
 */
function plantedTree(relPath: string, content: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ratio-gate-'));
  tmpDirs.push(root);
  const inv = JSON.parse(readFileSync(INVENTORY, 'utf8')) as { artifacts: { artifact?: string; alert_ids?: string[] }[] };
  mkdirSync(path.join(root, 'ops/monitoring'), { recursive: true });
  for (const a of inv.artifacts) {
    const rel = a.artifact ?? '';
    if (!/^ops\/monitoring\/[^/]+\.py$/.test(rel) || !(a.alert_ids ?? []).length) continue;
    copyFileSync(path.join(REPO, rel), path.join(root, rel));
  }
  copyFileSync(INVENTORY, path.join(root, 'ops/monitoring/monitoring-inventory.json'));
  copyFileSync(BASELINE, path.join(root, 'ops/ratio-derivation-baseline.json'));
  writeFileSync(path.join(root, relPath), content);
  return root;
}

describe('the gate on the real tree', () => {
  it('PASSES the fixed tree with one token, a non-empty scope and exit 0', { timeout: 60_000 }, () => {
    const r = run([]);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.status).toBe(0);
    const scope = /scope: (\d+) files/.exec(r.stdout);
    expect(scope).not.toBeNull();
    expect(Number(scope![1])).toBeGreaterThan(10);
  });

  it('the rebuilt regime canary contributes no baseline row — it computes no raw ratio', { timeout: 60_000 }, () => {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { sites: { file: string }[] };
    expect(baseline.sites.filter((s) => s.file.endsWith('regime-budget-starvation-canary.py'))).toEqual([]);
    for (const s of baseline.sites as { file: string; site: string; reason: string; owner: string }[]) {
      expect(s.reason.length).toBeGreaterThan(10);
      expect(s.owner).toMatch(/\S/);
    }
  });
});

describe('the planted pre-fix shape (spec AC4)', () => {
  it('FAILS on the pre-change regime canary: throws*100.0/calls reaching a comparison', { timeout: 60_000 }, () => {
    const root = plantedTree('ops/monitoring/regime-budget-starvation-canary.py', readFileSync(PRE_FIX, 'utf8'));
    const r = run(['--root', root]);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('regime-budget-starvation-canary.py');
    expect(r.stdout).toContain('throws * 100.0 / calls');
  });

  it('FAILS a PopulationCounts built by hand outside the module', { timeout: 60_000 }, () => {
    const src = readFileSync(path.join(REPO, 'ops/monitoring/regime-budget-starvation-canary.py'), 'utf8')
      + '\n\ndef _forged():\n    return pr.PopulationCounts("x", (), 0, 5000)\n';
    const root = plantedTree('ops/monitoring/regime-budget-starvation-canary.py', src);
    const r = run(['--root', root]);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
    expect(r.stdout).toContain('PopulationCounts');
  });

  it('honours a reasoned exemption on the ratio line, and refuses an empty one', { timeout: 60_000 }, () => {
    const base = readFileSync(path.join(REPO, 'ops/monitoring/regime-budget-starvation-canary.py'), 'utf8');
    const exempt = base + '\n\ndef _age_hours(age, cap):\n    h = age / cap  # ratio-exempt: display-only unit ratio, not a population rate\n    return h > 2\n';
    const bare = base + '\n\ndef _age_hours(age, cap):\n    h = age / cap  # ratio-exempt:\n    return h > 2\n';
    const ok = run(['--root', plantedTree('ops/monitoring/regime-budget-starvation-canary.py', exempt)]);
    expect(tokenLines(ok.stdout)).toEqual([`${TOKEN}=PASS`]);
    const bad = run(['--root', plantedTree('ops/monitoring/regime-budget-starvation-canary.py', bare)]);
    expect(tokenLines(bad.stdout)).toEqual([`${TOKEN}=FAIL`]);
  });

  it('is INDETERMINATE — never PASS — on a scoped file it cannot parse', { timeout: 60_000 }, () => {
    const root = plantedTree('ops/monitoring/regime-budget-starvation-canary.py', 'def broken(:\n');
    const r = run(['--root', root]);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=INDETERMINATE`]);
    expect(r.status).toBe(3);
  });
});

describe('--self-test — hermetic, two-way, and PROVEN able to fail', () => {
  it('PASSES with exactly one token', { timeout: 60_000 }, () => {
    const r = run(['--self-test']);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    expect(r.status).toBe(0);
  });

  const src = readFileSync(GATE, 'utf8');
  const MUTATIONS: { name: string; from: string; to: string }[] = [
    { name: 'division detection removed', from: 'isinstance(node.op, ast.Div)', to: 'isinstance(node.op, ast.FloorDiv)' },
    { name: 'comparison reachability ignored (every division flagged)', from: 'if not reaches_compare:', to: 'if False:' },
    { name: 'exemption reason no longer required', from: 'len(exempt_reason.strip()) >= MIN_EXEMPT_REASON', to: 'True' },
    { name: 'hand-built PopulationCounts no longer checked', from: "_call_name(node) == 'PopulationCounts'", to: "_call_name(node) == 'NeverMatches'" },
    { name: 'empty scope reads as PASS', from: '    if not scoped:\n        return INDET', to: '    if False:\n        return INDET' },
    { name: 'unit conversions (division by a constant) flagged as ratios', from: '    if _is_constant_expr(node.right):\n        return False', to: '    if False:\n        return False' },
  ];
  for (const m of MUTATIONS) {
    it(`catches: ${m.name}`, { timeout: 60_000 }, () => {
      expect(src.includes(m.from)).toBe(true);
      const dir = mkdtempSync(path.join(tmpdir(), 'ratio-gate-mut-'));
      tmpDirs.push(dir);
      const file = path.join(dir, 'check-ratio-derivation.py');
      writeFileSync(file, src.replace(m.from, m.to));
      const r = run(['--self-test'], file);
      expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=FAIL`]);
      expect(r.status).toBe(1);
    });
  }
});
