/**
 * SIGNAL-SELL-GATE-SYMMETRY-W1 CH1 — the validation protocol's own guards.
 *
 * Spawn budget: NOT APPLICABLE — no block here spawns a process (`ops/test-budget-config.json`
 * `_scope` is "PROCESS SPAWN ONLY — child_process / execFileSync / execSync / spawnSync /
 * spawn("). These are pure-function assertions over the shipped `edgeMetricReport()` and this
 * chapter's two guards; explicit timeouts are declared anyway so the 5,000 ms default is never
 * inherited silently.
 *
 * Each test targets a way this chapter could have produced a confident wrong answer:
 *   1. FDR not actually applied      -> a null cell would qualify
 *   2. holdout leaking into training -> in-sample result reported as out-of-sample
 *   3. silent pooling                -> the exact defect that hid a sign flip for months
 */
import { describe, it, expect } from 'vitest';
import { edgeMetricReport, type EdgeCell } from '../../src/scripts/calibration-audit.js';
import {
  assertSingleTimeframe, holdoutStartIndex, THRESHOLDS, TF_ORDER, BUY_BASE, HOLDOUT_FRAC,
} from '../../src/scripts/sell-gate-validation.js';

const TIMEOUT = 20_000;

/** A cell with NO edge: engine hits exactly match the best fixed direction. */
function nullCell(key: string, n = 400): EdgeCell {
  const up = Math.floor(n * 0.55);
  const split = { n, engineHits: Math.max(up, n - up), upCount: up };
  return { key, full: { ...split }, train: { ...split }, holdout: { ...split } };
}

/** A cell that looks strong IN-SAMPLE but collapses on the holdout — the overfit shape. */
function overfitCell(key: string, n = 400): EdgeCell {
  const up = Math.floor(n * 0.5);
  return {
    key,
    full: { n, engineHits: Math.floor(n * 0.85), upCount: up },
    train: { n, engineHits: Math.floor(n * 0.95), upCount: up },
    holdout: { n, engineHits: Math.floor(n * 0.40), upCount: up },
  };
}

describe('CH1 — FDR correction is actually applied', () => {
  it('a deliberately-inserted null cell does NOT qualify, alone or in a family', { timeout: TIMEOUT }, () => {
    const solo = edgeMetricReport([nullCell('null-solo')], { q: 0.05, minN: 30 });
    expect(solo.validated).toBe(0);
    expect(solo.verdict).toBe('NO-VALIDATED-EDGE');

    // Same null cell buried in a realistic family — must still not qualify.
    const family = [nullCell('null-solo'), ...TF_ORDER.map((tf) => nullCell(`${tf}|sell55`))];
    const rep = edgeMetricReport(family, { q: 0.05, minN: 30 });
    expect(rep.validated).toBe(0);
    expect(rep.cells.every((c) => !c.validated)).toBe(true);
  });

  it('an in-sample-only winner is rejected by the walk-forward leg', { timeout: TIMEOUT }, () => {
    const rep = edgeMetricReport([overfitCell('overfit')], { q: 0.05, minN: 30 });
    // It may or may not clear FDR on the full split, but its holdout excess is negative,
    // so `validated` must be false — that leg is what makes the result out-of-sample.
    expect(rep.cells[0].holdoutExcess).toBeLessThan(0);
    expect(rep.cells[0].validated).toBe(false);
    expect(rep.validated).toBe(0);
  });

  it('the FDR leg can actually FIRE — proving these nulls are not passing vacuously', { timeout: TIMEOUT }, () => {
    // Deliberately construct a cell that SHOULD qualify: large, strongly above the best naive
    // direction, and persistent on the holdout. If this does not validate, the gate is dead and
    // every null above would be meaningless.
    const n = 4000, up = n / 2;
    const strong: EdgeCell = {
      key: 'strong',
      full: { n, engineHits: Math.floor(n * 0.70), upCount: up },
      train: { n, engineHits: Math.floor(n * 0.70), upCount: up },
      holdout: { n, engineHits: Math.floor(n * 0.70), upCount: up },
    };
    const rep = edgeMetricReport([strong], { q: 0.05, minN: 30 });
    expect(rep.validated).toBe(1);
    expect(rep.verdict).toBe('EDGE-FOUND');
  });

  it('low-power cells are EXCLUDED from the family, never counted as negative', { timeout: TIMEOUT }, () => {
    const rep = edgeMetricReport([nullCell('tiny', 10)], { q: 0.05, minN: 30 });
    expect(rep.familySize).toBe(0);
    expect(rep.cells).toHaveLength(0);
  });
});

describe('CH1 — the holdout is forward-only and disjoint', () => {
  it('train and holdout partition the origins with no overlap and no gap', { timeout: TIMEOUT }, () => {
    for (const count of [100, 999, 28_780, 126]) {
      const start = holdoutStartIndex(count);
      const train = Array.from({ length: start }, (_, i) => i);
      const holdout = Array.from({ length: count - start }, (_, i) => start + i);
      expect(train.length + holdout.length).toBe(count);
      expect(new Set([...train, ...holdout]).size).toBe(count);   // disjoint
      // forward-only: every holdout index is strictly later than every train index
      if (train.length && holdout.length) {
        expect(Math.max(...train)).toBeLessThan(Math.min(...holdout));
      }
    }
  });

  it('the holdout is the most RECENT slice, at the pre-registered fraction', { timeout: TIMEOUT }, () => {
    const count = 1000;
    const start = holdoutStartIndex(count);
    expect(start).toBe(800);
    expect((count - start) / count).toBeCloseTo(HOLDOUT_FRAC, 10);
  });

  it('refuses a nonsensical fraction rather than silently clamping', { timeout: TIMEOUT }, () => {
    expect(() => holdoutStartIndex(100, 0)).toThrow(/BAD_HOLDOUT_FRAC/);
    expect(() => holdoutStartIndex(100, 1)).toThrow(/BAD_HOLDOUT_FRAC/);
  });
});

describe('CH1 — a pooled call RAISES rather than silently averaging', () => {
  it('throws when asked to aggregate across timeframes', { timeout: TIMEOUT }, () => {
    expect(() => assertSingleTimeframe([{ tf: '1h' }, { tf: '4h' }]))
      .toThrow(/POOLED_METRIC_REFUSED/);
    expect(() => assertSingleTimeframe([{ tf: '5m' }, { tf: '5m' }, { tf: '1d' }]))
      .toThrow(/POOLED_METRIC_REFUSED/);
  });

  it('permits a single-timeframe collection, so the guard is not merely always-on', { timeout: TIMEOUT }, () => {
    expect(() => assertSingleTimeframe([{ tf: '1h' }, { tf: '1h' }])).not.toThrow();
    expect(() => assertSingleTimeframe([])).not.toThrow();
  });
});

describe('CH1 — the pre-registered grid is what the harness actually runs', () => {
  it('thresholds and timeframes match the frozen pre-registration', { timeout: TIMEOUT }, () => {
    // Frozen 2026-08-22T08:04:08Z. A silent widening here is p-hacking, so it is pinned.
    expect([...THRESHOLDS]).toEqual([55, 54, 50, 45, 40, 35]);
    expect([...TF_ORDER]).toEqual(['5m', '3m', '15m', '30m', '2h', '1h', '4h', '8h', '12h', '1d']);
    expect(TF_ORDER).not.toContain('1m');   // permanently rejected on latency
    expect(THRESHOLDS).toContain(54);       // the far side of the measured cliff — mandatory
    expect(BUY_BASE).toBe(40);              // get-trade-call.ts:173, read not assumed
  });
});
