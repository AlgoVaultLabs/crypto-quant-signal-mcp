/**
 * DECISION-CALL-V2-W4 CH1 — the generated no-edge odds calibration table.
 *
 * - AC1.3 seal: src/lib/pre-trade-odds-calibration.ts must hash to the sha256 the study wrote into
 *   tests/fixtures/odds-calibration/generated.sha256. A hand edit of the generated module fails here.
 * - AC1.1 ordering: the module's provenance names the pre-registration sha256 that was sealed into
 *   tests/fixtures/odds-calibration/preregistration.sha256 before any archive was read.
 * - Spec §5.2 parity: the study's σ (ATR(14) → volatilityRatio → sigma_1h) and liquidation-distance code
 *   against the production TypeScript on shared synthetic fixture vectors, |Δ| ≤ 1e-9.
 * - Pre-registration B12: `pass` is derived once in Python from 3-dp comparison values; this file re-derives
 *   it from the emitted values with no further rounding and asserts agreement.
 *
 * INTERNAL ONLY — nothing here is served (spec §0). The module's only consumer is CH2's `noEdgeOdds`.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atr } from '../../src/lib/indicators.js';
import { ATR_RANGE_PER_SIGMA, liquidationDistance, sigma1hFromVolatilityRatio } from '../../src/lib/pre-trade-calc.js';
import { liquidationMaintenanceRate } from '../../src/lib/venue-margin-tiers.js';
import { ODDS_CALIBRATION, ODDS_VERSION } from '../../src/lib/pre-trade-odds-calibration.js';
import type { OddsField, OddsFieldCalibration } from '../../src/lib/pre-trade-odds-calibration.js';

const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'odds-calibration');
const MODULE_PATH = path.join(ROOT, 'src', 'lib', 'pre-trade-odds-calibration.ts');
const TOL = 1e-9;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'SUI', '1000PEPE'];
const ENTRIES_PER_COIN_PER_CELL = 5000;
const SHA256_HEX = /^[0-9a-f]{64}$/;

interface SigmaVector {
  label: string;
  period: number;
  highs: number[];
  lows: number[];
  closes: number[];
  entryPrice: number;
  atr14: number;
  atr14Closed: number;
  volatilityRatio: number;
  sigma1h: number;
  sigmaH: Record<string, number>;
}
interface SigmaFixture { atrRangePerSigma: number; vectors: SigmaVector[] }
interface LiqRow { coin: string; side: 'long' | 'short'; leverage: number; maintenanceRate: number; d: number; dLn: number }
interface LiqFixture { exchange: string; maintenanceRates: Record<string, number>; rows: LiqRow[] }

function sealToken(file: string): string {
  const [token, named] = readFileSync(file, 'utf8').trim().split(/\s+/);
  expect(token).toMatch(SHA256_HEX);
  return `${token.toLowerCase()}|${named ?? ''}`;
}

const FIELDS: readonly OddsField[] = ['timeout', 'target_first', 'liquidation'];
const CELLS_PER_FIELD: Record<OddsField, number> = { timeout: 25, target_first: 25, liquidation: 9 };

describe('pre-trade-odds-calibration — AC1.3 seal and AC1.1 ordering', () => {
  it('the generated module hashes to the sha256 the study sealed (a hand edit fails here)', () => {
    const actual = createHash('sha256').update(readFileSync(MODULE_PATH)).digest('hex');
    const [sealed, named] = sealToken(path.join(FIXTURES, 'generated.sha256')).split('|');
    expect(named).toBe('src/lib/pre-trade-odds-calibration.ts');
    expect(actual).toBe(sealed);
  });

  it('provenance names the pre-registration sha256 sealed before any data read', () => {
    const [sealed, named] = sealToken(path.join(FIXTURES, 'preregistration.sha256')).split('|');
    expect(named).toBe('audits/DECISION-CALL-V2-W4-preregistration.md');
    expect(ODDS_CALIBRATION.provenance.preregistrationSha256).toBe(sealed);
  });

  it('the module header declares itself generated', () => {
    const head = readFileSync(MODULE_PATH, 'utf8').slice(0, 400);
    expect(head).toContain('GENERATED FILE');
    expect(head).toContain('DO NOT EDIT BY HAND');
  });
});

describe('pre-trade-odds-calibration — version and provenance (spec §5.4, B14)', () => {
  const prov = ODDS_CALIBRATION.provenance;

  it("ODDS_VERSION is 'odds-v1' and the provenance repeats it", () => {
    expect(ODDS_VERSION).toBe('odds-v1');
    expect(prov.version).toBe(ODDS_VERSION);
    expect(prov.stage).toBe('holdout');
  });

  it('the fit and hold-out windows are the registered ones (Section A / B13)', () => {
    expect(prov.dataRange).toEqual({ start: '2024-01-01T00:00Z', end: '2026-10-31T23:59Z' });
    expect(prov.fitWindow).toEqual({ start: '2024-01-01T00:00Z', end: '2025-12-31T23:59Z' });
    expect(prov.holdoutWindow).toEqual({ start: '2026-01-01T00:00Z', end: '2026-10-31T23:59Z' });
  });

  it('coins, seed, sample size and estimator constants are the registered ones', () => {
    expect([...prov.coins]).toEqual(COINS);
    expect(prov.seed).toBe(20261105);
    expect(prov.entriesPerCoinPerCell).toBe(ENTRIES_PER_COIN_PER_CELL);
    expect(prov.sigmaBars1h).toBe(168);
    expect(prov.atrPeriod).toBe(14);
    expect(prov.recalBins).toBe(20);
    expect(prov.reliabilityBins).toBe(10);
    for (const c of COINS) expect(prov.maintenanceRates[c]).toBeGreaterThan(0);
  });

  it('every archive is listed with its Binance checksum: 8 coins × 34 months, no duplicates', () => {
    expect(prov.archiveCount).toBe(8 * 34);
    expect(prov.archiveChecksums.length).toBe(prov.archiveCount);
    const files = new Set<string>();
    for (const a of prov.archiveChecksums) {
      expect(a.sha256).toMatch(SHA256_HEX);
      expect(a.file).toMatch(/^(BTC|ETH|SOL|XRP|DOGE|BNB|SUI|1000PEPE)USDT-1m-20(24|25|26)-(0[1-9]|1[0-2])\.zip$/);
      files.add(a.file);
    }
    expect(files.size).toBe(prov.archiveCount);
    expect(prov.archiveManifestSha256).toMatch(SHA256_HEX);
  });
});

describe('pre-trade-odds-calibration — table structure (B9, B11)', () => {
  for (const field of FIELDS) {
    const f: OddsFieldCalibration = ODDS_CALIBRATION.fields[field];

    it(`${field}: ${CELLS_PER_FIELD[field]} cells, each with 8 × 5,000 entries accounted for`, () => {
      expect(f.cells.length).toBe(CELLS_PER_FIELD[field]);
      expect(new Set(f.cells.map((c) => c.cellId)).size).toBe(f.cells.length);
      let scored = 0;
      for (const c of f.cells) {
        expect(c.n + c.nDoubleTouch).toBe(COINS.length * ENTRIES_PER_COIN_PER_CELL);
        if (field === 'liquidation') expect(c.nDoubleTouch).toBe(0);
        for (const v of [c.brierBm, c.brierRecal, c.brierClim, c.brierRecal3, c.brierClim3]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        for (const v of [c.baseRateFit, c.yMeanHoldout, c.pBmMeanHoldout, c.pRecalMeanHoldout]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        expect(c.maxNonOverlappingHolds).toBeGreaterThan(0);
        scored += c.n;
      }
      expect(scored).toBe(f.nHoldoutRows);
    });

    it(`${field}: 20 contiguous equal-count recalibration bins fitted on ${field === 'liquidation' ? 'd/σ_H' : 'the BM value'}`, () => {
      expect(f.recalInput).toBe(field === 'liquidation' ? 'd_over_sigma_h' : 'p_bm');
      expect(f.recalBins.length).toBe(20);
      expect(f.recalBins[0].lo).toBeNull();
      expect(f.recalBins[19].hi).toBeNull();
      let nFit = 0;
      for (let j = 0; j < 20; j++) {
        const b = f.recalBins[j];
        if (j > 0) expect(b.lo).toBe(f.recalBins[j - 1].hi);
        if (b.lo !== null && b.hi !== null) expect(b.hi).toBeGreaterThanOrEqual(b.lo);
        if (b.value !== null) {
          expect(b.value).toBeGreaterThanOrEqual(0);
          expect(b.value).toBeLessThanOrEqual(1);
        } else {
          expect(b.nFit).toBe(0);
        }
        nFit += b.nFit;
      }
      expect(nFit).toBe(f.nFitRows);
      expect(f.nFitRows).toBeGreaterThan(0);
    });

    it(`${field}: every fitted bin is reachable — finite edges strictly increase and consecutive bins share them (class guard)`, () => {
      // A table printed at 6 dp collapsed distinct fitted edges into [0, 0): bins holding fit rows that no
      // lo <= v < hi lookup can return, so the consumer binned rows unlike the hold-out scoring. This pins
      // the class, whatever printed the table: a populated bin is never empty, and no two edges tie.
      const edges = f.recalBins.slice(0, -1).map((b) => b.hi);
      expect(edges.length).toBe(19);
      for (const e of edges) expect(typeof e === 'number' && Number.isFinite(e)).toBe(true);
      for (let j = 1; j < edges.length; j++) expect(edges[j] as number).toBeGreaterThan(edges[j - 1] as number);
      for (let j = 0; j < 20; j++) {
        const b = f.recalBins[j];
        if (j > 0) expect(b.lo).toBe(f.recalBins[j - 1].hi);
        if (b.nFit > 0) expect(b.lo ?? -Infinity).toBeLessThan(b.hi ?? Infinity);
      }
    });

    it(`${field}: 10 equal-count reliability bins over the recalibrated forecast, and the BM copy for information`, () => {
      for (const bins of [f.reliability, f.reliabilityBm]) {
        expect(bins.length).toBe(10);
        let n = 0;
        for (const b of bins) {
          expect(b.pMean).toBeGreaterThanOrEqual(0);
          expect(b.pMean).toBeLessThanOrEqual(1);
          expect(b.yMean).toBeGreaterThanOrEqual(0);
          expect(b.yMean).toBeLessThanOrEqual(1);
          n += b.n;
        }
        expect(n).toBe(f.nHoldoutRows);
        // array_split: the first N mod 10 blocks hold one extra row
        const sizes = bins.map((b) => b.n);
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      }
    });
  }
});

describe('pre-trade-odds-calibration — pass re-derived from the 3-dp values (B12)', () => {
  for (const field of FIELDS) {
    const f = ODDS_CALIBRATION.fields[field];

    it(`${field}: verdict '${f.verdict}' agrees with the three registered clauses`, () => {
      for (const c of f.cells) expect(c.recalLeClim).toBe(c.brierRecal3 <= c.brierClim3);
      if (f.verdict === 'indeterminate') {
        expect(f.pass).toBe(false);
        expect(f.verdictDetail.length).toBeGreaterThan(0);
        return;
      }
      const eceOk = f.ecePp <= 2.0;
      const binsOk = f.reliability.every((b) => b.n < 1000 || Math.abs(b.gapPp) <= 5.0);
      const cellsOk = f.cells.every((c) => c.brierRecal3 <= c.brierClim3);
      const derived = eceOk && binsOk && cellsOk;
      expect(f.pass).toBe(derived);
      expect(f.verdict).toBe(derived ? 'calibrated' : 'uncalibrated');
      if (!derived) expect(f.verdictDetail.length).toBeGreaterThan(0);
    });
  }
});

describe('pre-trade-odds-calibration — σ parity with the production estimator (spec §5.2, B4)', () => {
  const fx: SigmaFixture = JSON.parse(readFileSync(path.join(FIXTURES, 'sigma-vectors.json'), 'utf8'));

  it('the fixture uses the production √(8/π) range-per-sigma constant', () => {
    expect(Math.abs(fx.atrRangePerSigma - ATR_RANGE_PER_SIGMA)).toBeLessThanOrEqual(1e-15);
    expect(fx.vectors.length).toBeGreaterThanOrEqual(5);
  });

  for (const v of fx.vectors) {
    it(`${v.label}: indicators.ts::atr and sigma1hFromVolatilityRatio reproduce the study's values within 1e-9`, () => {
      expect(v.highs.length).toBe(168);
      const a = atr(v.highs, v.lows, v.closes, v.period);
      expect(a).not.toBeNull();
      // the sequential mirror AND the closed-form weights the study applies to every window
      expect(Math.abs((a as number) - v.atr14)).toBeLessThanOrEqual(TOL);
      expect(Math.abs((a as number) - v.atr14Closed)).toBeLessThanOrEqual(TOL);
      const ratio = (a as number) / v.entryPrice;
      expect(Math.abs(ratio - v.volatilityRatio)).toBeLessThanOrEqual(TOL);
      const s = sigma1hFromVolatilityRatio(ratio);
      expect(s).not.toBeNull();
      expect(Math.abs((s as number) - v.sigma1h)).toBeLessThanOrEqual(TOL);
      for (const [hold, sH] of Object.entries(v.sigmaH)) {
        expect(Math.abs((s as number) * Math.sqrt(Number(hold)) - sH)).toBeLessThanOrEqual(TOL);
      }
    });
  }
});

describe('pre-trade-odds-calibration — liquidation parity with pre-trade-calc.ts (spec §5.2, B7)', () => {
  const fx: LiqFixture = JSON.parse(readFileSync(path.join(FIXTURES, 'liquidation-grid.json'), 'utf8'));

  it('Bybit adds nothing to the tier-1 maintenance rate, and the grid rates are the provenance rates', () => {
    expect(fx.exchange).toBe('BYBIT');
    for (const c of COINS) {
      expect(fx.maintenanceRates[c]).toBe(ODDS_CALIBRATION.provenance.maintenanceRates[c]);
      expect(liquidationMaintenanceRate('BYBIT', fx.maintenanceRates[c])).toBe(fx.maintenanceRates[c]);
    }
  });

  it('liquidationDistance reproduces every (side, leverage, m) row within 1e-9, goldens included', () => {
    expect(fx.rows.length).toBe(COINS.length * 3 * 2 + 2);
    for (const r of fx.rows) {
      const side = r.side === 'long' ? 'long' : 'short';
      const d = liquidationDistance(side, r.leverage, liquidationMaintenanceRate('BYBIT', r.maintenanceRate));
      expect(Math.abs(d - r.d)).toBeLessThanOrEqual(TOL);
      const dLn = side === 'long' ? -Math.log1p(-d) : Math.log1p(d);
      expect(Math.abs(dLn - r.dLn)).toBeLessThanOrEqual(TOL);
    }
    const golden = fx.rows.filter((r) => r.coin === 'golden');
    expect(golden.map((r) => Number(r.d.toFixed(6)))).toEqual([0.046185, 0.045817]);
  });
});
