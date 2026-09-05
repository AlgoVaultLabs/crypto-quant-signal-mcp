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
    const m = r.stdout.match(/^SELF-TEST: PASS \((\d+) checks\)$/m);
    expect(m, 'summary line missing').not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(45);
    // The calibration count is printed with its instrument (trials, B, seed) so it can be re-cited.
    expect(r.stdout).toMatch(/^SELF-TEST: calibration fp=\d+\/\d+ rate=[0-9.]+ B=\d+ seed=\d+$/m);
    expect(r.stdout).not.toMatch(/^SELF-TEST: FAIL/m);
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
