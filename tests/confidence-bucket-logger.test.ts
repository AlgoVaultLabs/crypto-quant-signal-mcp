import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logConfidenceBucket } from '../src/lib/confidence-bucket-logger.js';

/**
 * OPS-TRADE-CALL-CALIBRATION-AUDIT-W1 R5 — vitest seam for the
 * confidence-bucket observability logger.
 *
 * Contract:
 *   1. Emits a single prefixed JSON line via console.log when
 *      ENABLE_CONFIDENCE_BUCKET_LOGGING === '1'.
 *   2. Emits NOTHING when the env var is unset or set to any other value.
 *   3. Emitted JSON contains all 8 required fields verbatim
 *      (coin / tf / regime / exchange / rawScore / confidence / signal /
 *      thresholdUsed) plus ts + prefix.
 */
describe('confidence-bucket-logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalEnv = process.env.ENABLE_CONFIDENCE_BUCKET_LOGGING;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (originalEnv === undefined) {
      delete process.env.ENABLE_CONFIDENCE_BUCKET_LOGGING;
    } else {
      process.env.ENABLE_CONFIDENCE_BUCKET_LOGGING = originalEnv;
    }
  });

  it('emits a single prefixed JSON line when ENABLE_CONFIDENCE_BUCKET_LOGGING=1', () => {
    process.env.ENABLE_CONFIDENCE_BUCKET_LOGGING = '1';
    logConfidenceBucket({
      coin: 'BTC',
      tf: '1m',
      regime: 'TRENDING_UP',
      exchange: 'BINANCE',
      rawScore: 42.5,
      confidence: 48,
      signal: 'BUY',
      thresholdUsed: 40,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.prefix).toBe('[seed-confidence-bucket]');
    expect(parsed.coin).toBe('BTC');
    expect(parsed.tf).toBe('1m');
    expect(parsed.regime).toBe('TRENDING_UP');
    expect(parsed.exchange).toBe('BINANCE');
    expect(parsed.rawScore).toBe(42.5);
    expect(parsed.confidence).toBe(48);
    expect(parsed.signal).toBe('BUY');
    expect(parsed.thresholdUsed).toBe(40);
    expect(typeof parsed.ts).toBe('number');
  });

  it('emits NOTHING when ENABLE_CONFIDENCE_BUCKET_LOGGING is unset', () => {
    delete process.env.ENABLE_CONFIDENCE_BUCKET_LOGGING;
    logConfidenceBucket({
      coin: 'BTC',
      tf: '1m',
      regime: 'TRENDING_UP',
      exchange: 'BINANCE',
      rawScore: 42.5,
      confidence: 48,
      signal: 'BUY',
      thresholdUsed: 40,
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('emits NOTHING when ENABLE_CONFIDENCE_BUCKET_LOGGING=0', () => {
    process.env.ENABLE_CONFIDENCE_BUCKET_LOGGING = '0';
    logConfidenceBucket({
      coin: 'BTC',
      tf: '1m',
      regime: 'TRENDING_UP',
      exchange: 'BINANCE',
      rawScore: 42.5,
      confidence: 48,
      signal: 'BUY',
      thresholdUsed: 40,
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('preserves thresholdUsed=null verbatim for HOLD verdicts', () => {
    process.env.ENABLE_CONFIDENCE_BUCKET_LOGGING = '1';
    logConfidenceBucket({
      coin: 'BNB',
      tf: '4h',
      regime: 'RANGING',
      exchange: 'BINANCE',
      rawScore: 10,
      confidence: 11,
      signal: 'HOLD',
      thresholdUsed: null,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(parsed.signal).toBe('HOLD');
    expect(parsed.thresholdUsed).toBe(null);
  });
});
