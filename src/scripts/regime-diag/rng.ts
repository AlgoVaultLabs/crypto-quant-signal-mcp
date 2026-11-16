// regime-diag/rng.ts — EDGE-REGIME-DIAG-W1: the one random stream of the harness (§4.2, §4.6).
//
// mulberry32. An entry draw is seeded from the first four bytes of sha256("20261116|<window>|P<nn>"); every other
// stream from arm_seed('20261116', '<window>|<statistic id>|<purpose>') of src/scripts/cluster-perm-stats.py.
import crypto from 'node:crypto';

export type Rnd = () => number;

export function mulberry32(seed: number): Rnd {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The first four bytes of sha256(key), big-endian. */
export const seedOf = (key: string): number => crypto.createHash('sha256').update(key).digest().readUInt32BE(0);
export const rngFor = (key: string): Rnd => mulberry32(seedOf(key));

/** `n` of `pool` without replacement (partial Fisher–Yates), returned in ascending order. Uniform over the pool. */
export function sampleWithoutReplacement(pool: Int32Array, n: number, rnd: Rnd): Int32Array {
  const a = Int32Array.from(pool);
  const m = Math.min(n, a.length);
  for (let i = 0; i < m; i++) {
    const j = i + Math.floor(rnd() * (a.length - i));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a.slice(0, m).sort();
}

/** A uniform permutation of 0 … n−1 (Fisher–Yates), written into `out`. */
export function permute(n: number, rnd: Rnd, out: Int32Array): Int32Array {
  for (let i = 0; i < n; i++) out[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out;
}
