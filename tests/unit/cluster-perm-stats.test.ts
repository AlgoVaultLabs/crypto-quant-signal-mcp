/**
 * cluster-perm-stats — the committed attribution instrument, gated in CI.
 *
 * EDGE-SELL-ATTRIBUTION-COLLIDER-CONTROL-W1. Two things this file pins, and why:
 *
 *  1. The known-answer selftest RUNS and PASSES. W1's instrument lived only in a session scratchpad
 *     and its published calibration figure ("7/120 = 0.058") could be produced by no surviving
 *     artifact. Committing the module is not enough — an untested instrument decays into the same
 *     unreproducibility; this test is what keeps it alive.
 *  2. The module is PURE. It sits under `src/` beneath BOTH quarantine firewalls
 *     (counterfactual-quarantine.test.ts, scorer-input-quarantine.test.ts) only because it names
 *     no store, no column and does no I/O. A hermetic selftest is blind to exactly that property,
 *     so it is asserted here from the source text — the bypassed artifact, checked directly.
 *
 * `python3` absent is a FAILURE, not a skip: a gate that skips is a dark guard.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');
const MODULE = path.join(REPO, 'src/scripts/cluster-perm-stats.py');
const SELFTEST = path.join(REPO, 'tests/unit/cluster-perm-stats.selftest.py');
const MUTATION = path.join(REPO, 'tests/unit/cluster-perm-stats.mutation.py');
const TOKEN = 'CLUSTER_PERM_SELFTEST';

/** Every line that IS a terminal verdict token — anchored at column 0. */
function tokenLines(stdout: string): string[] {
  return stdout.split('\n').filter((l) => l.startsWith(`${TOKEN}=`)).map((l) => l.split(' ')[0]);
}

describe('cluster-perm-stats — the committed attribution instrument', () => {
  it('the known-answer selftest emits EXACTLY ONE PASS token and exits 0', { timeout: 180_000 }, () => {
    const r = spawnSync('python3', [SELFTEST], { encoding: 'utf8' });
    expect(r.error, `python3 could not be spawned: ${r.error?.message ?? ''}`).toBeUndefined();
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    expect(tokenLines(r.stdout)).toEqual([`${TOKEN}=PASS`]);
    // A FLOOR on the check count, never an equality: a silent shrink is caught, growth is allowed.
    // 48 (W1 + collider) + 114 (EDGE-SCORER-PREDICTIVE-CEILING-W1 discrimination layer, incl. the 23
    // adversarial-review fixtures that pin the supplementary mutations S1-S15 and the sweep survivors) = 162.
    const m = r.stdout.match(/^SELF-TEST: PASS \((\d+) checks\)$/m);
    expect(m, 'summary line missing').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(162);
    // The calibration count is printed with its instrument (trials, B, seed) so it can be re-cited.
    expect(r.stdout).toMatch(/^SELF-TEST: calibration fp=\d+\/\d+ rate=[0-9.]+ B=\d+ seed=\d+$/m);
    expect(r.stdout).not.toMatch(/^SELF-TEST: FAIL/m);
  });

  // EDGE-SCORER-PREDICTIVE-CEILING-W1. The previous "mutation-proven 14/14" lived in a session
  // scratchpad and could never be re-run. The harness is now committed and RUN here: each of 14
  // load-bearing lines of the discrimination layer (tie weight, orientation, cluster unit, joint
  // draw, within-block pairing, percentile index, Bonferroni, out-of-fold leak, purge, Kish, the
  // decision precedence, ambiguous exclusion, per-arm RNG, side orientation) must turn its designed
  // fixtures red. The supplementary S1-S15 pin registered rules the M-set left open (purge boundary,
  // NOT_ESTIMABLE blocking N, the comparator and level of every family_bounds output, the floor's
  // alpha, ICC source, variance centre, n_required and pass rule, an unevaluated floor, undefined
  // targets in the out-of-fold fit, NaN scores); each read GREEN, or was caught only by a raise,
  // against the fixtures as first committed. A catch must be an ASSERTION failure: a mutant that only
  // makes a group or segment raise is MISSED_RAISE_ONLY. A red baseline, a target that no longer
  // applies, or a survivor fails this test.
  it('the committed mutation harness proves 14/14 registered + 15/15 supplementary mutations turn the selftest red', { timeout: 180_000 }, () => {
    const r = spawnSync('python3', [MUTATION], { encoding: 'utf8' });
    expect(r.error, `python3 could not be spawned: ${r.error?.message ?? ''}`).toBeUndefined();
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/^MUTATION_BASELINE=PASS /m);
    expect(r.stdout).not.toMatch(/^MUTATION_HARNESS_ERROR/m);
    const lines = r.stdout.split('\n');
    expect(lines.filter((l) => l.startsWith('MUTATION_PROOF '))).toEqual(['MUTATION_PROOF caught=14 missed=0']);
    expect(lines.filter((l) => l.startsWith('MUTATION_PROOF_SUPPLEMENTARY '))).toEqual(['MUTATION_PROOF_SUPPLEMENTARY caught=15 missed=0']);
    expect(lines.filter((l) => /^MUTATION M\d+ CAUGHT /.test(l))).toHaveLength(14);
    expect(lines.filter((l) => /^MUTATION S\d+ CAUGHT /.test(l))).toHaveLength(15);
  });

  it('a subset run can never masquerade as the full PASS, and an unknown group is refused', { timeout: 60_000 }, () => {
    const sub = spawnSync('python3', [SELFTEST, '--only', 'KP'], { encoding: 'utf8' });
    expect(sub.status, sub.stdout).toBe(0);
    expect(tokenLines(sub.stdout)).toEqual([]);
    expect(sub.stdout).toMatch(/^CLUSTER_PERM_SELFTEST_SUBSET=PASS failures=0 checks=[1-9]\d* groups=KP$/m);
    expect(sub.stdout).not.toMatch(/^SELF-TEST: PASS \(/m);
    const bad = spawnSync('python3', [SELFTEST, '--only', 'NOPE'], { encoding: 'utf8' });
    expect(bad.status).toBe(3);
    expect(bad.stdout).toMatch(/^CLUSTER_PERM_SELFTEST_SUBSET=INDETERMINATE /m);
  });

  it('the module is PURE: no store, no column, no I/O — the property that lets it live under src/', () => {
    const src = readFileSync(MODULE, 'utf8');
    // The two firewalls' token sets, restated here as a positive assertion on THIS file so the
    // purity claim is pinned by the instrument's own test, not only by the firewalls' scans.
    const FORBIDDEN = [
      /\bhold_decisions\b/, /\bhold_decision_labels\b/, /\bsignal_scorer_inputs\b/, /\bscorer_input_id\b/,
      /\braw0\b/, /\braw_final\b/, /\b(rsi|ema|funding|oi|volume)_score\b/,
      /\b(funding|hurst|squeeze)_delta\b/, /\b(funding|hurst|squeeze)_adjust_code\b/,
      /\bwould_be_side\b/, /\bdirectional_labels\b/, /\bband_signals\b/,
    ];
    for (const re of FORBIDDEN) expect(src, `module names a store/column: ${re}`).not.toMatch(re);
    const IO = [/\bopen\(/, /\bsubprocess\b/, /\bsocket\b/, /\burllib\b/, /\bpsycopg/, /\bsqlite3\b/, /\bsys\.argv\b/, /\bos\.environ\b/];
    for (const re of IO) expect(src, `module does I/O: ${re}`).not.toMatch(re);
    expect(src).toMatch(/^FLOOR_CLUSTERS = 50$/m);
    // The floor is READ, not merely declared — the defect W1 shipped.
    expect(src).toMatch(/def powered_levels\(levels, clusters, floor=FLOOR_CLUSTERS\)/);
  });
});
