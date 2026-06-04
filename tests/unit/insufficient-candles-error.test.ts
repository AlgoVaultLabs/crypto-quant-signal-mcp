/**
 * Unit tests for the structured INSUFFICIENT_CANDLES error + its wire payload
 * (TRADIFI-SIGNAL-HARDENING-W1, R5/R7).
 */
import { describe, it, expect } from 'vitest';
import {
  InsufficientCandlesError,
  buildInsufficientCandlesPayload,
} from '../../src/lib/errors.js';

function makeError() {
  return new InsufficientCandlesError({
    coin: 'ANTHROPIC',
    exchange: 'BINANCE',
    timeframe: '4h',
    candlesAvailable: 12,
    candlesRequired: 30,
    suggestedTimeframes: ['1h', '30m', '15m'],
    suggestedAction: 'Retry with timeframe=1h',
  });
}

describe('InsufficientCandlesError', () => {
  it('carries the stable code "INSUFFICIENT_CANDLES" and all fields', () => {
    const e = makeError();
    expect(e.code).toBe('INSUFFICIENT_CANDLES');
    expect(e.coin).toBe('ANTHROPIC');
    expect(e.exchange).toBe('BINANCE');
    expect(e.timeframe).toBe('4h');
    expect(e.candlesAvailable).toBe(12);
    expect(e.candlesRequired).toBe(30);
    expect(e.suggestedTimeframes).toEqual(['1h', '30m', '15m']);
    expect(e.suggestedAction).toBe('Retry with timeframe=1h');
  });

  it('message names the symbol/venue/timeframe and counts', () => {
    expect(makeError().message).toBe('ANTHROPIC on BINANCE 4h has 12 candles; 30 required.');
  });

  it('survives instanceof after transpile (CJS prototype chain)', () => {
    const e = makeError();
    expect(e instanceof Error).toBe(true);
    expect(e instanceof InsufficientCandlesError).toBe(true);
  });
});

describe('buildInsufficientCandlesPayload — wire shape', () => {
  it('emits exactly the R5 contract keys', () => {
    const payload = buildInsufficientCandlesPayload(makeError());
    expect(payload).toEqual({
      error: 'INSUFFICIENT_CANDLES',
      error_code: 'INSUFFICIENT_CANDLES',
      message: 'ANTHROPIC on BINANCE 4h has 12 candles; 30 required.',
      candles_available: 12,
      candles_required: 30,
      suggested_timeframes: ['1h', '30m', '15m'],
      suggested_action: 'Retry with timeframe=1h',
    });
  });
});
