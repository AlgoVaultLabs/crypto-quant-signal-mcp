// EDGE-ADS1-SCORECARD-W1-V2 CH2 R2 (ruling Q4 = A) — the new `clusterEdgeCompleteWithCi` export in
// dwr-cluster-edge.ts, tested two ways:
//
//  1. DIFFERENTIAL against the untouched Python instrument src/scripts/cluster-perm-stats.py, run through
//     python3 on the SAME inputs: the nearest-rank lower bound (`ci_lower`, applied to the export's own
//     bootstrap replicates), Kish (`kish_eff`, `m_star`), ICC(1) (`icc_anova`) and Spearman (`spearman`).
//     python3 ABSENT = this test FAILS (never a skip): the architect ruled the differential mandatory in
//     the CH2 gate, and a skipped differential is a gate that verified nothing.
//  2. BYTE PIN: everything in dwr-cluster-edge.ts above the new banner — `clusterEdge()` and the digest's
//     decided-basis statistic — is byte-identical to origin/main at 8c449cc4.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { ciLowerNearestRank, clusterEdgeCompleteWithCi, percentileNearestRank } from '../../src/scripts/dwr-cluster-edge.js';
import { iccAnova, kishEffClusters, mStar, toRaceRows, type Ads1Row } from '../../src/scripts/ads1/core.js';
import { spearman } from '../../src/scripts/ads1/rank.js';

const ROOT = path.resolve(__dirname, '../..');
const INSTRUMENT = path.join(ROOT, 'src/scripts/cluster-perm-stats.py');

const PY = [
  'import importlib.util, json, sys',
  'spec = importlib.util.spec_from_file_location("cps", sys.argv[1])',
  'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
  'inp = json.loads(sys.stdin.read())',
  'out = {',
  '  "ci": [m.ci_lower(a, q) for a, q in inp["ci"]],',
  '  "kish": [m.kish_eff(s) for s in inp["sizes"]],',
  '  "mstar": [m.m_star(s) for s in inp["sizes"]],',
  '  "icc": [m.icc_anova(v, c) for v, c in inp["icc"]],',
  '  "sp": [m.spearman(a, b) for a, b in inp["sp"]],',
  '}',
  'print(json.dumps(out))',
].join('\n');

function day(d: number, bu: number, bd: number, su: number, sd: number): Ads1Row[] {
  const out: Ads1Row[] = [];
  const t = 1788220800 + d * 86_400;
  const push = (side: 'BUY' | 'SELL', up: boolean, n: number) => {
    for (let i = 0; i < n; i++) {
      const win = (side === 'BUY') === up;
      out.push({ createdAt: t + out.length, exchange: 'X', coin: 'C', timeframe: '1h', side, confidence: 60, label: win ? 1 : -1, ambiguous: false, barrierPct: 1, expiryRetPct: null });
    }
  };
  push('BUY', true, bu); push('BUY', false, bd); push('SELL', true, su); push('SELL', false, sd);
  return out;
}

describe('clusterEdgeCompleteWithCi — differential vs cluster-perm-stats.py (python3 mandatory)', () => {
  it('nearest-rank CI, Kish, ICC(1) and Spearman agree with the Python instrument', { timeout: 60_000 }, () => {
    const rows: Ads1Row[] = [];
    // 24 days with a varying excess so the bootstrap has spread
    for (let d = 0; d < 24; d++) rows.push(...day(d, 10 + (d % 5), 10 - (d % 5), 8 + (d % 3), 12 - (d % 3)));
    const ce = clusterEdgeCompleteWithCi(toRaceRows(rows), { alpha: 0.05, B: 400, seed: 7, keepReplicates: true });
    expect(ce.verdict).toBe('PER_CLUSTER');
    const reps = ce.replicates as number[];

    const ciCases: Array<[number[], number]> = [
      [Array.from({ length: 100 }, (_, i) => i + 1), 0.025],
      [Array.from({ length: 100 }, (_, i) => i + 1), 0.05],
      [[3, 1, 2, 2, 5, 5, 5, 0.5], 0.3],
      [[7], 0.05],
      [[2, 1], 0.5],
      [reps, 0.05],
    ];
    const sizes = [[40, 40, 40], [3, 10, 57, 1], [1]];
    const iccCases: Array<[number[], string[]]> = [
      [[1, 1, 0, 0, 0, 0], ['a', 'a', 'a', 'b', 'b', 'b']],
      [[1, 0, 1, 1, 0, 0, 1, 0, 1], ['a', 'a', 'b', 'b', 'b', 'c', 'c', 'c', 'c']],
      [[1, 0, 1, 0], ['a', 'a', 'b', 'b']], // negative ICC: reported raw
    ];
    const spCases: Array<[number[], number[]]> = [
      [[1, 2, 3, 4], [2, 2, 3, 1]],
      [[59.5, 72.5, 95.5], [0.6, 0.7, 0.9]],
    ];

    const r = spawnSync('python3', ['-c', PY, INSTRUMENT], {
      input: JSON.stringify({ ci: ciCases, sizes, icc: iccCases, sp: spCases }),
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(r.error, 'python3 must be on PATH — the differential is mandatory, never skipped').toBeUndefined();
    expect(r.status, r.stderr).toBe(0);
    const py = JSON.parse(r.stdout) as { ci: number[]; kish: number[]; mstar: number[]; icc: Array<number | null>; sp: number[] };

    ciCases.forEach(([vals, q], i) => expect(ciLowerNearestRank(vals, q)).toBe(py.ci[i]));
    expect(ce.ciLbPp).toBe(py.ci[ciCases.length - 1]); // the export's own lower bound == Python's ci_lower over its replicates
    sizes.forEach((s, i) => {
      expect(kishEffClusters(s)).toBeCloseTo(py.kish[i], 12);
      expect(mStar(s)).toBeCloseTo(py.mstar[i], 12);
    });
    iccCases.forEach(([v, c], i) => {
      const ts = iccAnova(v, c);
      if (py.icc[i] === null) expect(ts).toBeNull();
      else expect(ts as number).toBeCloseTo(py.icc[i] as number, 12);
    });
    expect(py.icc[2] as number).toBeLessThan(0); // the raw (negative) value survives both ports
    spCases.forEach(([a, b], i) => expect(spearman(a, b)).toBeCloseTo(py.sp[i], 12));
    expect(percentileNearestRank([], 0.05)).toBeNull();
  });
});

describe('dwr-cluster-edge.ts — the digest statistic is untouched', () => {
  it('everything above the ADS-1 banner is byte-identical to origin/main at 8c449cc4', () => {
    const src = readFileSync(path.join(ROOT, 'src/scripts/dwr-cluster-edge.ts'), 'utf8');
    const banner = src.indexOf('// EDGE-ADS1-SCORECARD-W1-V2 CH2 R2');
    expect(banner).toBeGreaterThan(0);
    // the banner is preceded by one blank line and one rule line — strip both to recover the original file
    const ruleStart = src.lastIndexOf('\n// ═', banner - 2);
    const original = src.slice(0, ruleStart); // ends right after the original final "}\n"
    expect(createHash('sha256').update(original).digest('hex')).toBe(
      '356c097dd8680c94b82eae9c828f233cf672001f96323330505f967ccf4c45bd',
    );
  });
});
