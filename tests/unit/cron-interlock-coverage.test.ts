/**
 * OPS-DEPLOY-INTERLOCK-CRON-DEFER-W1 — the cron-interlock coverage gate.
 *
 * scripts/check-cron-interlock-coverage.mjs is what makes "unprotected by default" into
 * "unbuildable by default": an ops/cron/*.sh that gains a command-position `docker exec` with no
 * row in ops/scripts/cron-interlock-registry.json fails the BUILD.
 *
 * Its own --self-test covers the decision function against fixture trees. THIS file covers the
 * things a hermetic self-test structurally cannot: the real repo, the real registry, the real CLI
 * contract (token AND exit code), and the wiring that makes the gate run at all. A gate nobody
 * runs is theatre, and `check-canaries-wired.mjs` only proves SOMETHING mentions it.
 *
 * SPAWN BUDGET DECLARED on every block — each shells out to node.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const GATE = path.join(REPO, 'scripts/check-cron-interlock-coverage.mjs');
const REGISTRY = path.join(REPO, 'ops/scripts/cron-interlock-registry.json');
const PKG = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));

function runGate(args: string[] = []) {
  const r = spawnSync('node', [GATE, ...args], { encoding: 'utf8', cwd: REPO });
  return {
    status: r.status,
    stdout: r.stdout,
    verdict: (r.stdout.match(/CRON_INTERLOCK_COVERAGE_VERDICT=(\w+)/) || [])[1],
  };
}

describe('the gate decides the REAL tree, and says so with one token', () => {
  it('the committed tree PASSES at exit 0', { timeout: 60_000 }, () => {
    const r = runGate();
    expect(r.verdict).toBe('PASS');
    expect(r.status).toBe(0);
  });

  it('exactly ONE terminal verdict line is printed', { timeout: 60_000 }, () => {
    const r = runGate();
    expect((r.stdout.match(/^CRON_INTERLOCK_COVERAGE_VERDICT=/gm) || []).length).toBe(1);
  });

  it('every committed ops/cron wrapper gets a POSITIVE line, including the ones that do not exec',
    { timeout: 60_000 }, () => {
      const r = runGate();
      // A wrapper silently skipped must never read like one that passed. Three states, all named.
      expect(r.stdout).toMatch(/ops\/cron\/hold-decision-labeler\.sh\s+registered/);
      expect(r.stdout).toMatch(/ops\/cron\/checkout-parity\.sh\s+no docker exec/);
      // The two prose-only mentions must land in "no docker exec", not "registered" — a mention
      // is not an invocation, and counting them would grow the registry two phantom rows.
      expect(r.stdout).toMatch(/ops\/cron\/analytics-drift-canary\.sh\s+no docker exec/);
      expect(r.stdout).toMatch(/ops\/cron\/nav-drift-canary\.sh\s+no docker exec/);
    });

  it('BOTH hosts are evaluated, each with its own positive block', { timeout: 60_000 }, () => {
    const r = runGate();
    expect(r.stdout).toContain('cron-interlock-coverage [signal-1]:');
    expect(r.stdout).toContain('cron-interlock-coverage [aoe-1]:');
    // aoe-1 has no repo-side cron tree, and saying so positively is the honest answer — not a
    // vacuity INDETERMINATE, because nobody was ever supposed to fill that corpus for this host.
    expect(r.stdout).toMatch(/\[aoe-1\][\s\S]*repo cron corpus: none/);
  });

  it('--host narrows to one host and still prints exactly one token', { timeout: 60_000 }, () => {
    const r = runGate(['--host', 'aoe-1']);
    expect(r.verdict).toBe('PASS');
    expect(r.stdout).toContain('cron-interlock-coverage [aoe-1]:');
    expect(r.stdout).not.toContain('cron-interlock-coverage [signal-1]:');
    expect((r.stdout.match(/^CRON_INTERLOCK_COVERAGE_VERDICT=/gm) || []).length).toBe(1);
  });

  it('an UNKNOWN host is INDETERMINATE at exit 3, never an empty PASS', { timeout: 60_000 }, () => {
    const r = runGate(['--host', 'mars-1']);
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.status).toBe(3);
  });

  it('the DECLARED limitation is printed, not buried in a header nobody reads', { timeout: 60_000 }, () => {
    const r = runGate();
    expect(r.stdout).toContain('a build-time gate cannot see host-only crons');
    expect(r.stdout).toContain('OPS-CRON-INTERLOCK-HOST-CANARY-W1');
  });

  it('--self-test PASSES and prints the same token', { timeout: 60_000 }, () => {
    const r = runGate(['--self-test']);
    expect(r.verdict).toBe('PASS');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SELF-TEST: PASS');
  });
});

/**
 * The vacuity guard, PROVEN rather than described — pointed at a real empty tree.
 *
 * SPAWN BUDGET: 3 node spawns.
 */
describe('vacuity: an empty or broken corpus is INDETERMINATE, never PASS', () => {
  const evaluateIn = async (spec: Record<string, string>) => {
    const root = mkdtempSync(path.join(tmpdir(), 'croncov-vt-'));
    mkdirSync(path.join(root, 'ops/cron'), { recursive: true });
    mkdirSync(path.join(root, 'ops/scripts'), { recursive: true });
    for (const [rel, body] of Object.entries(spec)) {
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    const mod = await import(path.join(REPO, 'scripts/check-cron-interlock-coverage.mjs'));
    return mod.evaluate(root);
  };

  it('an EMPTY ops/cron tree is INDETERMINATE — the glob is broken, not the tree', { timeout: 60_000 }, async () => {
    const r = await evaluateIn({ 'ops/scripts/cron-interlock-registry.json': '{"rows":[{"id":"a","host":"signal-1","script":"s","class":"safe-to-kill","reason":"r"}],"_enumeration":{"signal-1":{"command":"fixture"}},"_residual_no_safe_kill":{"signal-1":{"count":0,"ids":[]}}}' });
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.reason).toContain('the glob is broken, not the tree');
  });

  it('a MISSING registry is INDETERMINATE, never "nothing is registered"', { timeout: 60_000 }, async () => {
    const r = await evaluateIn({ 'ops/cron/a.sh': '#!/usr/bin/env bash\ndocker exec ctr node x.js\n' });
    expect(r.verdict).toBe('INDETERMINATE');
  });

  it('wrappers that exist but NEVER exec are INDETERMINATE — the matcher broke', { timeout: 60_000 }, async () => {
    const r = await evaluateIn({
      'ops/cron/a.sh': '#!/usr/bin/env bash\necho hi\n',
      'ops/scripts/cron-interlock-registry.json': '{"rows":[{"id":"a","host":"signal-1","script":"s","class":"safe-to-kill","reason":"r"}],"_enumeration":{"signal-1":{"command":"fixture"}},"_residual_no_safe_kill":{"signal-1":{"count":0,"ids":[]}}}',
    });
    expect(r.verdict).toBe('INDETERMINATE');
    expect(r.reason).toContain('the matcher is broken, not the tree');
  });
});

/**
 * The registry is the wave's deliverable, so its SHAPE is asserted here rather than trusted.
 *
 * SPAWN BUDGET: 0 spawns (pure reads).
 */
describe('the registry is complete, classified, and carries its instruments', () => {
  const doc = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const rows: Array<Record<string, unknown>> = doc.rows;

  it('every row declares one of the three classes with a NON-EMPTY reason', () => {
    const classes = new Set(['safe-to-kill', 'preempt-and-catchup', 'no-safe-kill']);
    for (const r of rows) {
      expect(classes.has(r.class as string), `row ${r.id} class=${r.class}`).toBe(true);
      expect(String(r.reason ?? '').trim().length, `row ${r.id} reason`).toBeGreaterThan(20);
    }
  });

  it('every row carries a MEASURED runtime with the instrument recorded beside it', () => {
    // A measured baseline is meaningless without its instrument. This is the assertion that stops
    // a future row from being filled in with a plausible-looking estimate.
    for (const r of rows) {
      expect(typeof r.max_runtime_s, `row ${r.id}`).toBe('number');
      expect(String(r.runtime_instrument ?? '').trim().length, `row ${r.id} instrument`).toBeGreaterThan(20);
    }
  });

  it('every row declares its SOURCE, and a host-only row carries no repo path claim', () => {
    for (const r of rows) expect(['repo', 'host-only']).toContain(r.source);
  });

  it('every exclusion carries a reason AND a re-derivation command', () => {
    // An exclusion that cannot be re-derived by someone who did not run the original enumeration
    // is folklore with better formatting — precisely the thing this wave exists to retire.
    expect(Array.isArray(doc.exclusions)).toBe(true);
    expect(doc.exclusions.length).toBeGreaterThan(0);
    for (const e of doc.exclusions) {
      expect(String(e.reason ?? '').trim().length, `exclusion ${e.id}`).toBeGreaterThan(20);
      expect(String(e.re_derivation_command ?? '').trim().length, `exclusion ${e.id}`).toBeGreaterThan(5);
    }
  });

  it('EVERY row declares its host — a hostless row is invisible to every per-host consumer', () => {
    // OPS-HOST-AUTO-REBOOT-W1. The whole point of the per-host split is that a consumer reads only
    // the rows for the host it is acting on; a row with no host would be read by nobody, silently.
    for (const r of rows) expect(String(r.host ?? '').trim().length, `row ${r.id}`).toBeGreaterThan(0);
    expect([...new Set(rows.map((r) => r.host))].sort()).toEqual(['aoe-1', 'signal-1']);
  });

  it('the enumeration is reproducible per host, and each host records its OWN command', () => {
    for (const h of ['signal-1', 'aoe-1']) {
      const covered = rows.filter((r) => r.host === h).reduce((a, r) => a + (r.cron_lines as number), 0);
      const en = doc._enumeration[h];
      expect(en, `enumeration for ${h}`).toBeDefined();
      expect(String(en.command ?? '').trim().length, `${h} command`).toBeGreaterThan(20);
      expect(covered).toBeLessThanOrEqual(en.active_cron_lines);
    }
    // The two commands must DIFFER: signal-1's disruption event is a container recreate (a
    // `docker exec` question) and aoe-1's is a reboot (strictly larger). Inheriting one command
    // for both is the wrong-instrument defect this wave's R1 exists to fix.
    expect(doc._enumeration['signal-1'].command).not.toBe(doc._enumeration['aoe-1'].command);
  });

  it('the residual no-safe-kill ruling matches the rows PER HOST, so no control drifts from its evidence', () => {
    // If a future wave reclassifies the last no-safe-kill row without updating the ruling, the
    // deploy-free window (signal-1) or the reboot gate (aoe-1) would keep being justified by a row
    // that no longer says so. The gate asserts this too; this pins it at the data layer.
    for (const h of ['signal-1', 'aoe-1']) {
      const actual = rows.filter((r) => r.host === h && r.class === 'no-safe-kill');
      expect(doc._residual_no_safe_kill[h].count, h).toBe(actual.length);
      expect([...doc._residual_no_safe_kill[h].ids].sort(), h).toEqual(actual.map((r) => r.id).sort());
    }
    // aoe-1 having ZERO is the measured reason it is the host automated first — assert it, so a
    // future no-safe-kill row on aoe-1 cannot land without this test going red and forcing a ruling.
    expect(doc._residual_no_safe_kill['aoe-1'].count).toBe(0);
  });
});

/**
 * WIRING. A gate that runs nowhere protects nothing.
 *
 * SPAWN BUDGET: 0 spawns (pure reads).
 */
describe('the gate is wired into the publish lane', () => {
  it('prepublishOnly invokes it DIRECTLY, matching the chain\'s form', () => {
    // The chain calls `node scripts/<gate>.mjs`, never the npm alias — so an alias-only wiring
    // would read as covered and run nowhere.
    expect(PKG.scripts.prepublishOnly).toContain('node scripts/check-cron-interlock-coverage.mjs');
  });

  it('it runs AFTER the boot-contract parity check, where this wave placed it', () => {
    const chain: string = PKG.scripts.prepublishOnly;
    const boot = chain.indexOf('node scripts/check-boot-contract-parity.mjs --check');
    const ours = chain.indexOf('node scripts/check-cron-interlock-coverage.mjs');
    expect(boot).toBeGreaterThan(-1);
    expect(ours).toBeGreaterThan(boot);
  });

  it('the gate file exists where check-canaries-wired.mjs discovers gates', () => {
    // Discovery is `^scripts/(check[-_][^/]+|[^/]*canary[^/]*)\.(mjs|js|cjs|sh|ts)$` — a gate
    // living anywhere else is invisible to the meta-canary and can rot unnoticed.
    expect(existsSync(GATE)).toBe(true);
    expect(/^check[-_][^/]+\.mjs$/.test(path.basename(GATE))).toBe(true);
  });
});
