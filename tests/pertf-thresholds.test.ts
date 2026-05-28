import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  PERTF_THRESHOLDS,
  PERTF_BUY_BASE_THRESHOLD,
  PERTF_SELL_THRESHOLD_GATED,
  PERTF_CONFIDENCE_BAND,
  getThresholdForTF,
} from '../src/lib/pertf-thresholds.js';

/**
 * OPS-TRADE-CALL-CLUSTER-W1 CH1 — vitest seam for the per-TF
 * threshold data module + 2-flag-firewall helper.
 *
 * Contract:
 *   1. Data module loads all 11 evaluated TFs from W1 audit.
 *   2. Helper returns fallback when ENABLE_PERTF_THRESHOLDS unset.
 *   3. Helper returns fallback when outer set + inner unset.
 *   4. Helper returns per-TF recommendation when both flags set.
 *   5. Helper accepts both uppercase + lowercase TF input.
 *   6. Helper returns fallback when audit's recommendation is null (DEFER).
 */
describe('pertf-thresholds', () => {
  const originalOuter = process.env.ENABLE_PERTF_THRESHOLDS;
  const originalInners: Record<string, string | undefined> = {};
  const innerKeys = ['1M', '3M', '5M', '15M', '30M', '1H', '2H', '4H', '8H', '12H', '1D'];

  beforeEach(() => {
    for (const k of innerKeys) {
      originalInners[k] = process.env[`ENABLE_PERTF_${k}`];
      delete process.env[`ENABLE_PERTF_${k}`];
    }
    delete process.env.ENABLE_PERTF_THRESHOLDS;
  });

  afterEach(() => {
    if (originalOuter === undefined) {
      delete process.env.ENABLE_PERTF_THRESHOLDS;
    } else {
      process.env.ENABLE_PERTF_THRESHOLDS = originalOuter;
    }
    for (const k of innerKeys) {
      if (originalInners[k] === undefined) {
        delete process.env[`ENABLE_PERTF_${k}`];
      } else {
        process.env[`ENABLE_PERTF_${k}`] = originalInners[k];
      }
    }
  });

  it('data module loads all 11 evaluated TFs from W1 audit', () => {
    const expectedTfs = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d'];
    expect(Object.keys(PERTF_THRESHOLDS).sort()).toEqual([...expectedTfs].sort());
    // Companion maps mirror the same keys
    expect(Object.keys(PERTF_BUY_BASE_THRESHOLD).sort()).toEqual([...expectedTfs].sort());
    expect(Object.keys(PERTF_SELL_THRESHOLD_GATED).sort()).toEqual([...expectedTfs].sort());
    expect(Object.keys(PERTF_CONFIDENCE_BAND).sort()).toEqual([...expectedTfs].sort());
    // Spot-check known W1 audit values
    expect(PERTF_THRESHOLDS['1m'].buy_base).toBe(45);
    expect(PERTF_THRESHOLDS['4h'].buy_base).toBe(49);
    expect(PERTF_THRESHOLDS['12h'].buy_base).toBe(62);
    expect(PERTF_THRESHOLDS['1m'].sell_gated).toBe(null); // audit DEFERRED 1m SELL
    expect(PERTF_THRESHOLDS['5m'].sell_gated).toBe(53);
  });

  it('helper returns fallback when ENABLE_PERTF_THRESHOLDS unset', () => {
    // outer flag unset, inner flag set — still falls back
    process.env.ENABLE_PERTF_1M = '1';
    expect(getThresholdForTF('1m', 'buy', 40)).toBe(40);
    expect(getThresholdForTF('1m', 'sell', 55)).toBe(55);
  });

  it('helper returns fallback when outer flag set + inner flag unset', () => {
    process.env.ENABLE_PERTF_THRESHOLDS = '1';
    // No ENABLE_PERTF_1M set
    expect(getThresholdForTF('1m', 'buy', 40)).toBe(40);
    expect(getThresholdForTF('4h', 'buy', 40)).toBe(40);
  });

  it('helper returns per-TF recommendation when BOTH flags set', () => {
    process.env.ENABLE_PERTF_THRESHOLDS = '1';
    process.env.ENABLE_PERTF_1M = '1';
    process.env.ENABLE_PERTF_4H = '1';
    process.env.ENABLE_PERTF_12H = '1';
    expect(getThresholdForTF('1m', 'buy', 40)).toBe(45);
    expect(getThresholdForTF('4h', 'buy', 40)).toBe(49);
    expect(getThresholdForTF('12h', 'buy', 40)).toBe(62);
  });

  it('helper accepts uppercase + lowercase TF input', () => {
    process.env.ENABLE_PERTF_THRESHOLDS = '1';
    process.env.ENABLE_PERTF_5M = '1';
    expect(getThresholdForTF('5m', 'buy', 40)).toBe(45);
    expect(getThresholdForTF('5M', 'buy', 40)).toBe(45);
    expect(getThresholdForTF('5m', 'sell', 55)).toBe(53);
    expect(getThresholdForTF('5M', 'sell', 55)).toBe(53);
  });

  it('helper returns fallback when audit recommendation is null (DEFER)', () => {
    process.env.ENABLE_PERTF_THRESHOLDS = '1';
    process.env.ENABLE_PERTF_1M = '1';
    process.env.ENABLE_PERTF_3M = '1';
    process.env.ENABLE_PERTF_8H = '1';
    process.env.ENABLE_PERTF_1D = '1';
    // All these TFs have sell_gated = null in the audit
    expect(getThresholdForTF('1m', 'sell', 55)).toBe(55);
    expect(getThresholdForTF('3m', 'sell', 55)).toBe(55);
    expect(getThresholdForTF('8h', 'sell', 55)).toBe(55);
    expect(getThresholdForTF('1d', 'sell', 55)).toBe(55);
    // BUY thresholds still come from the data module
    expect(getThresholdForTF('1m', 'buy', 40)).toBe(45);
    expect(getThresholdForTF('1d', 'buy', 40)).toBe(45);
  });
});
