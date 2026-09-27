// ads1/rank.ts — EDGE-ADS1-SCORECARD-W1-V2 CH2 R1. Midranks + Spearman, ported verbatim from
// src/scripts/cluster-perm-stats.py (`midranks`, `spearman`) so the two languages share one convention;
// tests/unit/ads1-cluster-ci-differential.test.ts runs both on the same inputs. PURE.

/** Midranks with ties (1-indexed) — the Spearman convention. */
export function midranks(vals: number[]): number[] {
  const order = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b] || a - b);
  const out = new Array<number>(vals.length).fill(0);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && vals[order[j + 1]] === vals[order[i]]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[order[k]] = r;
    i = j + 1;
  }
  return out;
}

/** Spearman's rank correlation; NaN when either side is constant. */
export function spearman(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('spearman: inputs differ in length');
  const n = a.length;
  if (n === 0) return NaN;
  const ra = midranks(a);
  const rb = midranks(b);
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / (Math.sqrt(da) * Math.sqrt(db)) : NaN;
}
