// regime-diag/prims.ts — EDGE-REGIME-DIAG-W1: the pinned statistics primitives, called through the Python bridge.
//
// Bounds, seeds, effective clusters, Benjamini–Hochberg, the permutation test and the attainable bound are the
// functions of src/scripts/cluster-perm-stats.py and ops/monitoring/population_comparison.py, never a port.
// A failed call throws: an absent python3, a non-zero exit and a malformed reply are failures, never a skip.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { SEED } from './diag-spec.js';

export const REPO = path.resolve(__dirname, '../../..');
export const PRIMS_PY = 'scripts/regime-diag/prims.py';

export type Op =
  | { op: 'seeds'; label: string; arms: string[] }
  | { op: 'bounds'; alpha: number; series: number[][] }
  | { op: 'kish'; sizes: number[][] }
  | { op: 'bh'; q: number; pvals: number[] }
  | { op: 'attainable'; shares: number[] }
  | { op: 'perm'; levels: number[]; wins: number[]; clusters: number[]; B: number; seed: number }
  | { op: 'floor' };

/** One process, many ops. `python3 -I`: isolated from the environment and the working directory. */
export function prims(ops: Op[], repo = REPO): unknown[] {
  const raw = execFileSync('python3', ['-I', path.join(repo, PRIMS_PY)], { input: JSON.stringify({ ops }), encoding: 'utf8', maxBuffer: 1 << 30, timeout: 3_600_000, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = (JSON.parse(raw) as { out: unknown[] }).out;
  if (!Array.isArray(out) || out.length !== ops.length) throw new Error('regime-diag: the primitives bridge returned a malformed reply');
  return out;
}

/** `arm_seed('20261116', arm)` for each arm. */
export const seedsFor = (arms: string[], repo = REPO): number[] => (arms.length ? (prims([{ op: 'seeds', label: SEED, arms }], repo)[0] as number[]) : []);
/** `[ci_lower(values, alpha), ci_upper(values, alpha)]` per series. */
export const boundsOf = (series: number[][], alpha: number, repo = REPO): Array<[number, number]> =>
  (series.length ? (prims([{ op: 'bounds', alpha, series }], repo)[0] as Array<[number, number]>) : []);
export const kishOf = (sizes: number[][], repo = REPO): number[] => (sizes.length ? (prims([{ op: 'kish', sizes }], repo)[0] as number[]) : []);
export const bhOf = (pvals: number[], q: number, repo = REPO): boolean[] => (pvals.length ? (prims([{ op: 'bh', q, pvals }], repo)[0] as boolean[]) : []);
export const attainableOf = (shares: number[], repo = REPO): Array<number | null> => (shares.length ? (prims([{ op: 'attainable', shares }], repo)[0] as Array<number | null>) : []);
export const floorClusters = (repo = REPO): number => prims([{ op: 'floor' }], repo)[0] as number;
