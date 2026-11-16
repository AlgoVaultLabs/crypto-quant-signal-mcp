// regime-diag/prims.ts — EDGE-REGIME-DIAG-W1: the pinned statistics primitives, called through the Python bridge.
//
// Bounds, seeds, effective clusters, Benjamini–Hochberg, the permutation test and the attainable bound are the
// functions of src/scripts/cluster-perm-stats.py and ops/monitoring/population_comparison.py, never a port.
// A failed call throws: an absent python3, a non-zero exit and a malformed reply are failures, never a skip.
//
// EDGE-REGIME-DIAG-BRIDGE-W1: the request carries its own length and every call is bounded. `--bytes <n>` is the
// request's exact UTF-8 length, so `prims.py` reads n bytes and answers without waiting for end-of-input (a
// `bounds` child once blocked in `read()` for an hour waiting for one). Each call is bounded by its longest op's
// timeout; a call that times out is re-issued once, identically — the ops are pure and `perm` carries its own
// seed, so the re-issue returns the same bytes — and a second timeout throws.
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

export type OpName = Op['op'];
export type BridgeTimeouts = Readonly<Record<OpName, number>>;

/**
 * The bound on one call, per op, in ms. `perm` is the one long op; every other op is a sort, a hash or a sum
 * (W2's largest took seconds). A parameter of `prims`, so a test can shrink it; never read from the environment.
 */
export const BRIDGE_TIMEOUT_MS: BridgeTimeouts = Object.freeze({ seeds: 300_000, bounds: 300_000, kish: 300_000, bh: 300_000, attainable: 300_000, perm: 3_600_000, floor: 300_000 });

/** A batch takes its longest op's timeout. An op the table does not name takes the table's longest. */
export function callTimeoutMs(ops: readonly Op[], timeouts: BridgeTimeouts = BRIDGE_TIMEOUT_MS): number {
  const all = Object.values(timeouts);
  if (!all.length || !all.every((t) => Number.isInteger(t) && t > 0)) throw new Error('regime-diag: a bridge timeout must be a positive whole number of ms');
  const longest = Math.max(...all);
  return ops.length ? Math.max(...ops.map((o) => (timeouts as Record<string, number>)[o.op] ?? longest)) : longest;
}

const timedOut = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === 'ETIMEDOUT';

/**
 * One process, many ops. `python3 -I`: isolated from the environment and the working directory. The request is
 * framed by `--bytes`; node still closes stdin after writing it. A timeout re-issues the identical request once,
 * with one stderr line; a second timeout throws. Any other failure throws at once, before the reply is parsed.
 */
export function prims(ops: Op[], repo = REPO, timeouts: BridgeTimeouts = BRIDGE_TIMEOUT_MS): unknown[] {
  const body = Buffer.from(JSON.stringify({ ops }), 'utf8');
  const timeout = callTimeoutMs(ops, timeouts);
  const names = ops.map((o) => o.op).join(',');
  const call = (): string => execFileSync('python3', ['-I', path.join(repo, PRIMS_PY), '--bytes', String(body.length)],
    { input: body, encoding: 'utf8', maxBuffer: 1 << 30, timeout, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'] });
  let raw: string;
  const t0 = Date.now();
  try {
    raw = call();
  } catch (e) {
    if (!timedOut(e)) throw e;
    process.stderr.write(`regime-diag: bridge re-issued ${names} after ${Date.now() - t0} ms\n`);
    try {
      raw = call();
    } catch (e2) {
      if (timedOut(e2)) throw new Error(`regime-diag: the primitives bridge timed out twice (${names})`, { cause: e2 });
      throw e2;
    }
  }
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
