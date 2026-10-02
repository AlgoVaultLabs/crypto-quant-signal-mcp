/**
 * ads1-frechet-parity.test.ts — EDGE-ADS1-SCORECARD-W1-V3 R8.
 *
 * DISCHARGES the IDENTIFIABILITY-GATE follow-up (status.md, 2026-10-01 14:38 UTC):
 *   "unpinned TS twin of attainable_pp at src/scripts/ads1/core.ts:292 (frechetAttainablePp),
 *    no parity test — Owner: EDGE-ADS1-SCORECARD-W1"
 *
 * WHAT IS PINNED. `frechetAttainablePp(shareBuy, pLong)` is a TypeScript port of
 * `Arm.attainable_pp`, and ADS-1's identifiability verdict reads it. The ONE formula for its bound is
 * `attainable_bound_from_share` in ops/monitoring/population_comparison.py, reached here by subprocess
 * through its `--declarations` CLI — the entry point the pre-registration gate and
 * scripts/check-population-comparison.mjs already call. There is NO second copy of the formula in
 * this file: every bound below is python's `bound_pp`, read back, never computed in TypeScript.
 *
 * TWO DIRECTIONS, because either one alone is vacuous:
 *   1. UPPER BOUND — ts ≤ bound + 1e-9 at every (share × always-BUY) grid point. Catches a twin that
 *      GREW: ADS-1 would then call a floor reachable that python's declaration gate refuses.
 *   2. EQUALITY ATTAINED — for every share, |ts − bound| ≤ 1e-9 at SOME always-BUY value on the grid.
 *      Catches a twin that SHRANK (e.g. 0.99× the width), which leg 1 passes silently: ADS-1 would
 *      then refuse floors python accepts.
 *
 * INPUT HANDLING, MEASURED 2026-10-02 (python3 3.9.6), not assumed: `--declarations` accepts the
 * boundary shares 0 and 1 (bound_pp 0.0, exit 0), and is symmetric in q ↔ 1−q (0.3 → 60.0,
 * 0.7 → 60.00000000000001), so the BUY share is passed RAW — no minority normalisation is needed or
 * applied. The CLI contract requires a floor; `floor_pp: 0` is within every bound, so the verdict
 * carries no information here and only `bound_pp` is read.
 *
 * GRID. 1,001 shares (i/1000, i = 0…1000 — built by exact division, never cumulative addition, so
 * both boundaries are exactly 0 and 1) × 11 always-BUY win rates (j/10, j = 0…10). The vacuity guard
 * sits where the corpus is CONSTRUCTED: the grid's own size and boundaries, and python's answer —
 * exactly 1,001 results, in declaration order, every one with a finite numeric bound_pp.
 *
 * SPAWN BUDGET DECLARED on the describe and on every it() — each it() can reach python3 through the
 * memoised `pyResults()`, and scripts/check-test-budget.mjs reads `timeout:` from the options
 * argument (a cold python3 start can blow vitest's 5,000ms default on a loaded CI runner).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { frechetAttainablePp } from '../../src/scripts/ads1/core.js';

const REPO_ROOT = join(__dirname, '..', '..');
const PY_DERIVATION = join(REPO_ROOT, 'ops/monitoring/population_comparison.py');

/** Float tolerance, pp — the same 1e-9 python's own DECLARATION_EPS_PP uses at equality. */
const EPS_PP = 1e-9;

const N_SHARES = 1001;
const N_ALWAYS_BUY = 11;
const SHARES: readonly number[] = Array.from({ length: N_SHARES }, (_, i) => i / 1000);
const ALWAYS_BUY: readonly number[] = Array.from({ length: N_ALWAYS_BUY }, (_, j) => j / 10);

const idOf = (i: number): string => `share#${i}`;

interface PyResult { id: string; verdict: string; reason: string; bound_pp: number | null }

let cached: PyResult[] | undefined;

/** ONE batched `--declarations` call for the whole share axis, memoised for the file. */
function pyResults(): PyResult[] {
  if (cached) return cached;
  const decls = SHARES.map((s, i) => ({ id: idOf(i), floor_pp: 0, shares: [s] }));
  const r = spawnSync('python3', [PY_DERIVATION, '--declarations'], {
    input: JSON.stringify({ declarations: decls }), encoding: 'utf8', timeout: 30_000,
  });
  if (r.error) throw new Error(`python3 --declarations could not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`python3 --declarations failed, status ${r.status}: ${r.stderr || r.stdout}`);
  const doc = JSON.parse(r.stdout);
  if (!Array.isArray(doc?.results)) {
    throw new Error(`python3 --declarations returned no results list: ${r.stdout.slice(0, 300)}`);
  }
  cached = doc.results as PyResult[];
  return cached;
}

/** Every reason the python answer is unusable as a bound per share — empty when usable. */
function resultProblems(res: PyResult[]): string[] {
  const problems: string[] = [];
  if (res.length !== N_SHARES) problems.push(`returned ${res.length} result(s) for ${N_SHARES} declaration(s)`);
  res.forEach((r, i) => {
    if (r?.id !== idOf(i)) problems.push(`result ${i} has id ${JSON.stringify(r?.id)}, expected ${idOf(i)}`);
    if (typeof r?.bound_pp !== 'number' || !Number.isFinite(r.bound_pp)) {
      problems.push(`${idOf(i)} (share ${SHARES[i]}): bound_pp ${JSON.stringify(r?.bound_pp)} — ${r?.verdict}: ${r?.reason}`);
    }
  });
  return problems;
}

/** Python's bound per share, index-aligned with SHARES — or a thrown reason. A parity check over a
 *  partial or mis-ordered result set would certify points python never answered. */
function pyBounds(): number[] {
  const res = pyResults();
  const problems = resultProblems(res);
  if (problems.length) {
    throw new Error(`python --declarations answer unusable (${problems.length} problem(s)): ${problems.slice(0, 5).join(' | ')}`);
  }
  return res.map((r) => r.bound_pp as number);
}

describe('frechetAttainablePp ↔ population_comparison.py attainable_bound_from_share (parity, by subprocess)', { timeout: 60_000 }, () => {
  it('vacuity: the grid is 1,001 shares × 11 always-BUY rates with both boundaries, and python answered all 1,001 with a numeric bound_pp', { timeout: 60_000 }, () => {
    expect(SHARES).toHaveLength(N_SHARES);
    expect(SHARES[0]).toBe(0);
    expect(SHARES[N_SHARES - 1]).toBe(1);
    expect(new Set(SHARES).size).toBe(N_SHARES);
    expect(ALWAYS_BUY).toHaveLength(N_ALWAYS_BUY);
    expect(ALWAYS_BUY[0]).toBe(0);
    expect(ALWAYS_BUY[N_ALWAYS_BUY - 1]).toBe(1);

    const res = pyResults();
    expect(res).toHaveLength(N_SHARES);
    const problems = resultProblems(res);
    expect(problems.length, `python answer unusable: ${problems.slice(0, 5).join(' | ')}`).toBe(0);
    expect(res.every((r) => typeof r.bound_pp === 'number' && Number.isFinite(r.bound_pp))).toBe(true);
  });

  it('upper bound: frechetAttainablePp(share, alwaysBuy) ≤ python bound(share) + 1e-9 at every one of the 11,011 grid points', { timeout: 60_000 }, () => {
    const bounds = pyBounds();
    const exceed: string[] = [];
    let points = 0;
    SHARES.forEach((share, i) => {
      for (const alwaysBuy of ALWAYS_BUY) {
        points++;
        const ts = frechetAttainablePp(share, alwaysBuy);
        // `!(a <= b)` rather than `a > b`, so a NaN from the TS side counts as a violation.
        if (!(ts <= bounds[i] + EPS_PP)) {
          exceed.push(`share ${share} alwaysBuy ${alwaysBuy}: TS ${ts} > python bound ${bounds[i]}`);
        }
      }
    });
    expect(points).toBe(N_SHARES * N_ALWAYS_BUY);
    expect(
      exceed.length,
      `TS twin EXCEEDS the python bound at ${exceed.length} of ${points} points — first: ${exceed.slice(0, 5).join(' | ')}`,
    ).toBe(0);
  });

  it('equality attained: for every one of the 1,001 shares, |TS − python bound| ≤ 1e-9 at some always-BUY value of the grid', { timeout: 60_000 }, () => {
    const bounds = pyBounds();
    const missed: string[] = [];
    let sharesChecked = 0;
    SHARES.forEach((share, i) => {
      sharesChecked++;
      let closest = { gap: Infinity, alwaysBuy: NaN, ts: NaN };
      for (const alwaysBuy of ALWAYS_BUY) {
        const ts = frechetAttainablePp(share, alwaysBuy);
        const gap = Math.abs(ts - bounds[i]);
        if (gap < closest.gap) closest = { gap, alwaysBuy, ts };
      }
      // `!(gap <= EPS)` so a NaN gap (TS returned NaN everywhere) is a miss, never a silent pass.
      if (!(closest.gap <= EPS_PP)) {
        missed.push(`share ${share}: python bound ${bounds[i]}, closest TS ${closest.ts} at alwaysBuy ${closest.alwaysBuy} (gap ${closest.gap})`);
      }
    });
    expect(sharesChecked).toBe(N_SHARES);
    expect(
      missed.length,
      `TS twin never ATTAINS the python bound for ${missed.length} of ${sharesChecked} shares — first: ${missed.slice(0, 5).join(' | ')}`,
    ).toBe(0);
  });
});

/**
 * THIRD LEG — pointwise identity with the python FUNCTION itself (`Arm.attainable_pp`), not only its maximum.
 * Legs 1–2 pin the bound and that it is attained; a twin that ignored `pLong` and returned the bound, or one
 * that was wrong everywhere except at the attaining point, passed both (the adversarial verifier's two
 * surviving mutants). Here python builds one `Arm` per grid point from integer counts — scored 1000,
 * buy_side i (q = i/1000), long_wins 100·j (p_long = j/10) — and returns its `attainable_pp` property; the TS twin must
 * equal it within 1e-9 at all 11,011 points. Still ONE formula: python's, by subprocess; nothing is
 * recomputed in TypeScript.
 */
describe('frechetAttainablePp ↔ population_comparison.py Arm.attainable_pp (pointwise, by subprocess)', { timeout: 60_000 }, () => {
  it('equals python at every one of the 11,011 grid points', { timeout: 60_000 }, () => {
    const prog = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(join(REPO_ROOT, 'ops/monitoring'))})`,
      'from population_comparison import Arm',
      `print(json.dumps([[Arm("g", 1000, 0, 100 * j, 0, i).attainable_pp for j in range(${N_ALWAYS_BUY})] for i in range(${N_SHARES})]))`,
    ].join('\n');
    const r = spawnSync('python3', ['-c', prog], { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    if (r.error) throw new Error(`python3 could not run: ${r.error.message}`);
    expect(r.status, r.stderr).toBe(0);
    const py = JSON.parse(r.stdout) as number[][];
    expect(py).toHaveLength(N_SHARES); // vacuity: python answered the whole grid
    const off: string[] = [];
    let points = 0;
    SHARES.forEach((share, i) => {
      expect(py[i]).toHaveLength(N_ALWAYS_BUY);
      ALWAYS_BUY.forEach((alwaysBuy, j) => {
        points++;
        const ts = frechetAttainablePp(share, alwaysBuy);
        if (!(Math.abs(ts - py[i][j]) <= EPS_PP)) off.push(`share ${share} alwaysBuy ${alwaysBuy}: TS ${ts} ≠ python ${py[i][j]}`);
      });
    });
    expect(points).toBe(N_SHARES * N_ALWAYS_BUY);
    expect(off.length, `TS twin differs from Arm.attainable_pp at ${off.length} of ${points} points — first: ${off.slice(0, 5).join(' | ')}`).toBe(0);
  });
});
