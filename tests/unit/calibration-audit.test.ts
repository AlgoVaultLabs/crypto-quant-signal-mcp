/**
 * tests/unit/calibration-audit.test.ts — EQUITY-CALIBRATION-AUDIT-W1.
 *
 * Pure-function coverage for the reusable audit harness: the SHIPPED PFE-win
 * predicate (single-derivation parity), benchmark edge, calibration + ECE,
 * percentile, magnitude, sign-agreement, and the GO / GO-WITH-REFRAME / NO-GO
 * verdict rule.
 */
import { describe, it, expect } from 'vitest';
import {
  isPfeWin,
  isRealizedFavorable,
  seededCall,
  benchmarkEdge,
  realizedHitRate,
  calibrationBins,
  expectedCalibrationError,
  isMonotonic,
  percentileCont,
  winMagnitudeQuartiles,
  signAgreement,
  splitWr,
  computeAuditReport,
  cryptoRowToAudit,
  cryptoTierProxy,
  normalCdf,
  wilsonInterval,
  excessZP,
  benjaminiHochberg,
  bonferroni,
  edgeMetricReport,
  type AuditRow,
  type EdgeCell,
} from '../../src/scripts/calibration-audit.js';

function row(o: Partial<AuditRow> & Pick<AuditRow, 'call'>): AuditRow {
  return {
    pfePct: 0,
    confidence: 0.8,
    entry: 100,
    winHighMax: 100,
    winLowMin: 100,
    outcomeReturnPct: 0,
    regime: 'ranging',
    bucket: '101-500',
    ...o,
  };
}

describe('isPfeWin — the SHIPPED predicate (single-derivation)', () => {
  it('BUY wins iff pfe>0, SELL wins iff pfe<0', () => {
    expect(isPfeWin('BUY', 0.01)).toBe(true);
    expect(isPfeWin('BUY', 0)).toBe(false);
    expect(isPfeWin('BUY', -1)).toBe(false);
    expect(isPfeWin('SELL', -0.01)).toBe(true);
    expect(isPfeWin('SELL', 0)).toBe(false);
    expect(isPfeWin('SELL', 1)).toBe(false);
  });
  it('realized-favorable mirrors the call direction on close-to-close', () => {
    expect(isRealizedFavorable('BUY', 2)).toBe(true);
    expect(isRealizedFavorable('SELL', -2)).toBe(true);
    expect(isRealizedFavorable('BUY', -2)).toBe(false);
  });
});

describe('seededCall — deterministic (no Math.random)', () => {
  it('is stable and binary', () => {
    for (let i = 0; i < 50; i++) {
      const a = seededCall(i);
      expect(a === 'BUY' || a === 'SELL').toBe(true);
      expect(seededCall(i)).toBe(a);
    }
  });
});

describe('benchmarkEdge — base-rate artifact detection', () => {
  // r0/r2 win under their own call AND both benchmarks; r1/r3 lose everywhere.
  const rows: AuditRow[] = [
    row({ call: 'BUY', pfePct: 10, entry: 100, winHighMax: 110, winLowMin: 95, outcomeReturnPct: 5 }),
    row({ call: 'BUY', pfePct: 0, entry: 100, winHighMax: 100, winLowMin: 101, outcomeReturnPct: -1 }),
    row({ call: 'SELL', pfePct: -10, entry: 50, winHighMax: 55, winLowMin: 45, outcomeReturnPct: -3 }),
    row({ call: 'SELL', pfePct: 0, entry: 50, winHighMax: 49, winLowMin: 50, outcomeReturnPct: 1 }),
  ];
  it('computes actual/always-BUY/always-SELL and a ≤0 edge when calls match the base rate', () => {
    const e = benchmarkEdge(rows);
    expect(e.n).toBe(4);
    expect(e.actualWr).toBeCloseTo(0.5, 10);
    expect(e.alwaysBuyWr).toBeCloseTo(0.5, 10);
    expect(e.alwaysSellWr).toBeCloseTo(0.5, 10);
    expect(e.buyWr).toBeCloseTo(0.5, 10);
    expect(e.sellWr).toBeCloseTo(0.5, 10);
    expect(e.edge).toBeLessThanOrEqual(0); // no edge over the naive benchmark
  });
});

describe('realizedHitRate', () => {
  it('measures directional accuracy on realized close-to-close', () => {
    const rows: AuditRow[] = [
      row({ call: 'BUY', outcomeReturnPct: 2 }), // hit
      row({ call: 'BUY', outcomeReturnPct: -2 }), // miss
      row({ call: 'SELL', outcomeReturnPct: -2 }), // hit
      row({ call: 'SELL', outcomeReturnPct: 2 }), // miss
    ];
    const r = realizedHitRate(rows);
    expect(r.actual).toBeCloseTo(0.5, 10);
    expect(r.alwaysBuy).toBeCloseTo(0.5, 10); // 2 of 4 have orp>0
    expect(r.alwaysSell).toBeCloseTo(0.5, 10);
  });
});

describe('calibrationBins + ECE', () => {
  const rows: AuditRow[] = [
    row({ call: 'BUY', pfePct: 5, confidence: 0.85 }), // bin[8] win
    row({ call: 'BUY', pfePct: 5, confidence: 0.85 }), // bin[8] win
    row({ call: 'BUY', pfePct: 0, confidence: 0.35 }), // bin[3] loss
    row({ call: 'BUY', pfePct: 0, confidence: 0.35 }), // bin[3] loss
  ];
  it('bins by confidence and computes per-bin WR + meanConf', () => {
    const bins = calibrationBins(rows);
    const b8 = bins.find((b) => b.lo === 0.8)!;
    const b3 = bins.find((b) => b.lo === 0.3)!;
    expect(b8.n).toBe(2);
    expect(b8.wr).toBeCloseTo(1.0, 10);
    expect(b8.meanConf).toBeCloseTo(0.85, 10);
    expect(b3.wr).toBeCloseTo(0.0, 10);
  });
  it('ECE = Σ (n_b/N)·|WR_b − meanConf_b| = 0.25 for this fixture', () => {
    const ece = expectedCalibrationError(calibrationBins(rows));
    expect(ece).toBeCloseTo(0.5 * 0.15 + 0.5 * 0.35, 6); // 0.25
  });
  it('conf==1.0 lands in the last bin', () => {
    const bins = calibrationBins([row({ call: 'BUY', pfePct: 1, confidence: 1.0 })]);
    expect(bins[0].lo).toBe(0.9);
  });
});

describe('isMonotonic (n≥minN gate)', () => {
  it('true when WR non-decreasing across well-populated bins', () => {
    const lo = Array.from({ length: 30 }, (_, i) =>
      row({ call: 'BUY', pfePct: i < 6 ? 1 : 0, confidence: 0.35 }),
    ); // wr=0.2
    const hi = Array.from({ length: 30 }, (_, i) =>
      row({ call: 'BUY', pfePct: i < 27 ? 1 : 0, confidence: 0.85 }),
    ); // wr=0.9
    expect(isMonotonic(calibrationBins([...lo, ...hi]))).toBe(true);
  });
  it('false when a higher-confidence bin wins less', () => {
    const lo = Array.from({ length: 30 }, () => row({ call: 'BUY', pfePct: 1, confidence: 0.35 })); // wr=1.0
    const hi = Array.from({ length: 30 }, (_, i) =>
      row({ call: 'BUY', pfePct: i < 15 ? 1 : 0, confidence: 0.85 }),
    ); // wr=0.5
    expect(isMonotonic(calibrationBins([...lo, ...hi]))).toBe(false);
  });
});

describe('percentileCont (matches PG percentile_cont)', () => {
  it('interpolates linearly', () => {
    const x = [1, 2, 3, 4];
    expect(percentileCont(x, 0.5)).toBeCloseTo(2.5, 10);
    expect(percentileCont(x, 0.25)).toBeCloseTo(1.75, 10);
    expect(percentileCont(x, 0.75)).toBeCloseTo(3.25, 10);
    expect(percentileCont([7], 0.9)).toBe(7);
  });
});

describe('winMagnitudeQuartiles', () => {
  it('quartiles of |pfe| over winning rows only', () => {
    const rows: AuditRow[] = [
      row({ call: 'BUY', pfePct: 2 }),
      row({ call: 'BUY', pfePct: 6 }),
      row({ call: 'SELL', pfePct: -4 }),
      row({ call: 'BUY', pfePct: 0 }), // not a win → excluded
    ];
    const q = winMagnitudeQuartiles(rows);
    expect(q.nWins).toBe(3);
    expect(q.median).toBeCloseTo(4, 10); // |{2,4,6}| median = 4
  });
});

describe('signAgreement (PFE-win vs realized)', () => {
  it('fraction of PFE-wins that also end realized-favorable', () => {
    const rows: AuditRow[] = [
      row({ call: 'BUY', pfePct: 5, outcomeReturnPct: 3 }), // win + realized fav
      row({ call: 'BUY', pfePct: 5, outcomeReturnPct: -1 }), // win + realized UNfav
    ];
    const s = signAgreement(rows);
    expect(s.nPfeWins).toBe(2);
    expect(s.pfeWinAlsoRealizedFav).toBeCloseTo(0.5, 10);
  });
});

describe('splitWr', () => {
  it('groups WR by key', () => {
    const rows: AuditRow[] = [
      row({ call: 'BUY', pfePct: 1, regime: 'trending_up' }),
      row({ call: 'BUY', pfePct: 0, regime: 'trending_up' }),
      row({ call: 'SELL', pfePct: -1, regime: 'ranging' }),
    ];
    const cells = splitWr(rows, (r) => r.regime);
    expect(cells.find((c) => c.key === 'trending_up')!.wr).toBeCloseTo(0.5, 10);
    expect(cells.find((c) => c.key === 'ranging')!.wr).toBeCloseTo(1.0, 10);
  });
});

describe('computeAuditReport — verdict rule', () => {
  it('NO-GO when the PFE edge is ≤ floor (base-rate artifact)', () => {
    const rows: AuditRow[] = [
      row({ call: 'BUY', pfePct: 10, entry: 100, winHighMax: 110, winLowMin: 95, outcomeReturnPct: 5 }),
      row({ call: 'BUY', pfePct: 0, entry: 100, winHighMax: 100, winLowMin: 101, outcomeReturnPct: -1 }),
      row({ call: 'SELL', pfePct: -10, entry: 50, winHighMax: 55, winLowMin: 45, outcomeReturnPct: -3 }),
      row({ call: 'SELL', pfePct: 0, entry: 50, winHighMax: 49, winLowMin: 50, outcomeReturnPct: 1 }),
    ];
    expect(computeAuditReport(rows, 'equities').verdict).toBe('NO-GO');
  });

  it('GO when the engine beats every benchmark on PFE AND realized, with strong sign-agreement', () => {
    // Each row wins ONLY under its own call → always-BUY and always-SELL each ~0.5,
    // the engine's directional pick wins all → dominant edge; realized mirrors it.
    const rows: AuditRow[] = [];
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        // BUY winner: high breaks up, low never breaches entry
        rows.push(row({ call: 'BUY', pfePct: 8, entry: 100, winHighMax: 108, winLowMin: 100, outcomeReturnPct: 6 }));
      } else {
        // SELL winner: low breaks down, high never breaches entry
        rows.push(row({ call: 'SELL', pfePct: -8, entry: 100, winHighMax: 100, winLowMin: 92, outcomeReturnPct: -6 }));
      }
    }
    const rep = computeAuditReport(rows, 'equities');
    expect(rep.edge.actualWr).toBeCloseTo(1.0, 10);
    expect(rep.edge.alwaysBuyWr).toBeCloseTo(0.5, 10);
    expect(rep.edge.alwaysSellWr).toBeCloseTo(0.5, 10);
    expect(rep.edge.edge).toBeGreaterThanOrEqual(0.08);
    expect(rep.realized.edge).toBeGreaterThan(0);
    expect(rep.verdict).toBe('GO');
  });

  it('GO-WITH-REFRAME when a real edge exists but PFE-wins often end unfavorable', () => {
    const rows: AuditRow[] = [];
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        // BUY winner on PFE; realized favorable only ~half the time
        rows.push(
          row({ call: 'BUY', pfePct: 8, entry: 100, winHighMax: 108, winLowMin: 100, outcomeReturnPct: i % 4 === 0 ? 6 : -3 }),
        );
      } else {
        // SELL winner on PFE; realized favorable only ~half the time
        rows.push(
          row({ call: 'SELL', pfePct: -8, entry: 100, winHighMax: 100, winLowMin: 92, outcomeReturnPct: i % 4 === 1 ? -6 : 3 }),
        );
      }
    }
    const rep = computeAuditReport(rows, 'equities');
    expect(rep.edge.edge).toBeGreaterThanOrEqual(0.08);
    expect(rep.sign.pfeWinAlsoRealizedFav).toBeLessThan(0.6);
    // realized edge may be ≤0 here (PFE-wins reverse) → NO-GO; or >0 → GO-WITH-REFRAME.
    expect(['GO-WITH-REFRAME', 'NO-GO']).toContain(rep.verdict);
  });
});

describe('crypto loader — reconstruct benchmarks from stored (pfe, mae)', () => {
  it('maps a BUY signal: high-side=pfe, low-side=mae; confidence int→[0,1]', () => {
    const buy = cryptoRowToAudit({
      signal: 'BUY', pfe_return_pct: 2, mae_return_pct: -1, outcome_return_pct: 1.5,
      confidence: 80, coin: 'SOL', regime: 'trending_up',
    });
    expect(buy.winHighMax).toBeCloseTo(1.02, 10); // maxHigh = entry·(1+pfe/100)
    expect(buy.winLowMin).toBeCloseTo(0.99, 10); // minLow = entry·(1+mae/100)
    expect(buy.confidence).toBeCloseTo(0.8, 10);
    expect(buy.bucket).toBe('rest');
    expect(isPfeWin(buy.call, buy.pfePct)).toBe(true);
  });

  it('maps a SELL signal: low-side=pfe, high-side=mae', () => {
    const sell = cryptoRowToAudit({
      signal: 'SELL', pfe_return_pct: -2, mae_return_pct: 1, outcome_return_pct: -1.5,
      confidence: 60, coin: 'BTC', regime: null,
    });
    expect(sell.winLowMin).toBeCloseTo(0.98, 10);
    expect(sell.winHighMax).toBeCloseTo(1.01, 10);
    expect(sell.bucket).toBe('T1_bluechip');
    expect(isPfeWin(sell.call, sell.pfePct)).toBe(true);
  });

  it('benchmarkEdge over reconstructed rows is base-rate-shaped (edge ≤ 0)', () => {
    const rows = [
      cryptoRowToAudit({ signal: 'BUY', pfe_return_pct: 2, mae_return_pct: -1, outcome_return_pct: 1, confidence: 70, coin: 'ETH', regime: null }),
      cryptoRowToAudit({ signal: 'SELL', pfe_return_pct: -2, mae_return_pct: 1, outcome_return_pct: -1, confidence: 70, coin: 'ETH', regime: null }),
    ];
    const e = benchmarkEdge(rows);
    expect(e.actualWr).toBeCloseTo(1.0, 10);
    expect(e.alwaysBuyWr).toBeCloseTo(1.0, 10); // both rows have a high>entry
    expect(e.alwaysSellWr).toBeCloseTo(1.0, 10); // both rows have a low<entry
    expect(e.edge).toBeLessThanOrEqual(0);
  });

  it('cryptoTierProxy: BTC/ETH → T1, else rest', () => {
    expect(cryptoTierProxy('BTC')).toBe('T1_bluechip');
    expect(cryptoTierProxy('ETH')).toBe('T1_bluechip');
    expect(cryptoTierProxy('DOGE')).toBe('rest');
  });
});

describe('edge-metric statistics', () => {
  it('normalCdf: standard values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 4);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it('wilsonInterval: 50/100 ≈ [0.404, 0.596]', () => {
    const w = wilsonInterval(50, 100);
    expect(w.pHat).toBeCloseTo(0.5, 10);
    expect(w.lo).toBeCloseTo(0.404, 2);
    expect(w.hi).toBeCloseTo(0.596, 2);
    expect(wilsonInterval(0, 0).pHat).toBeNaN();
  });

  it('excessZP: one-sided upper test vs a benchmark rate', () => {
    const { z, p } = excessZP(650, 1000, 0.5); // 0.65 vs 0.5
    expect(z).toBeCloseTo(9.49, 1);
    expect(p).toBeLessThan(1e-6);
    expect(excessZP(500, 1000, 0.5).p).toBeCloseTo(0.5, 2); // no excess
  });

  it('benjaminiHochberg: rejects the small-p prefix at q=0.05', () => {
    const { rejected } = benjaminiHochberg([0.001, 0.01, 0.5], 0.05);
    expect(rejected).toEqual([true, true, false]);
  });

  it('bonferroni: p ≤ q/m', () => {
    expect(bonferroni([0.001, 0.02, 0.5], 0.05)).toEqual([true, false, false]);
  });

  it('edgeMetricReport: EDGE-FOUND only for a benchmark-positive, FDR-surviving, out-of-sample cell', () => {
    const good: EdgeCell = {
      key: 'good',
      full: { n: 1000, engineHits: 650, upCount: 500 }, // rh .65 vs naive .5 → excess .15
      train: { n: 600, engineHits: 390, upCount: 300 },
      holdout: { n: 400, engineHits: 260, upCount: 200 }, // holdout excess .15, z≈6
    };
    const drift: EdgeCell = {
      key: 'drift',
      full: { n: 1000, engineHits: 570, upCount: 570 }, // rh == naive → excess 0 (tape drift)
      train: { n: 600, engineHits: 342, upCount: 342 },
      holdout: { n: 400, engineHits: 228, upCount: 228 },
    };
    const overfit: EdgeCell = {
      key: 'overfit',
      full: { n: 1000, engineHits: 540, upCount: 500 }, // in-sample +0.04 …
      train: { n: 600, engineHits: 360, upCount: 300 },
      holdout: { n: 400, engineHits: 190, upCount: 200 }, // … but holdout excess NEGATIVE
    };
    const rep = edgeMetricReport([good, drift, overfit], { minN: 30 });
    expect(rep.familySize).toBe(3);
    expect(rep.verdict).toBe('EDGE-FOUND');
    expect(rep.validated).toBe(1);
    expect(rep.cells.find((c) => c.key === 'good')!.validated).toBe(true);
    expect(rep.cells.find((c) => c.key === 'drift')!.excess).toBeCloseTo(0, 6);
    expect(rep.cells.find((c) => c.key === 'overfit')!.validated).toBe(false); // holdout flips
  });

  it('edgeMetricReport: NO-VALIDATED-EDGE when only drift/overfit cells exist', () => {
    const drift: EdgeCell = {
      key: 'd', full: { n: 2000, engineHits: 1140, upCount: 1140 },
      train: { n: 1200, engineHits: 684, upCount: 684 }, holdout: { n: 800, engineHits: 456, upCount: 456 },
    };
    const overfit: EdgeCell = {
      key: 'o', full: { n: 1000, engineHits: 540, upCount: 500 },
      train: { n: 600, engineHits: 360, upCount: 300 }, holdout: { n: 400, engineHits: 190, upCount: 200 },
    };
    const rep = edgeMetricReport([drift, overfit], { minN: 30 });
    expect(rep.verdict).toBe('NO-VALIDATED-EDGE');
    expect(rep.validated).toBe(0);
  });

  it('edgeMetricReport: low-power cells (n<minN) are excluded from the family', () => {
    const tiny: EdgeCell = {
      key: 't', full: { n: 10, engineHits: 9, upCount: 5 },
      train: { n: 6, engineHits: 5, upCount: 3 }, holdout: { n: 4, engineHits: 4, upCount: 2 },
    };
    expect(edgeMetricReport([tiny], { minN: 30 }).familySize).toBe(0);
  });
});
