/**
 * DECISION-CALL-V1-W2 R4 — `PRE_TRADE_CHECK_PARAM_DECL` is the contract's § Params, and every
 * served surface projects from it.
 */
import { describe, it, expect } from 'vitest';
import {
  PRE_TRADE_CHECK_PARAM_DECL as D,
  PRE_TRADE_SIDES,
  PUBLIC_VENUE_IDS,
  REGIME_TIMEFRAMES,
  PUBLIC_TOOL_ENUM_PARAMS,
} from '../../src/lib/tool-param-schema.js';

describe('PRE_TRADE_CHECK_PARAM_DECL — the contract, once', () => {
  it('declares exactly the six contract params', () => {
    expect(Object.keys(D)).toEqual(['coin', 'side', 'sizeUsd', 'holdHours', 'timeframe', 'exchanges']);
  });
  it('coin: required string 1-20, upper-cased', () => {
    expect(D.coin).toEqual({ type: 'string', required: true, minLength: 1, maxLength: 20, upperCased: true });
  });
  it('side: required long | short', () => {
    expect(D.side.values).toBe(PRE_TRADE_SIDES);
    expect([...PRE_TRADE_SIDES]).toEqual(['long', 'short']);
    expect(D.side.required).toBe(true);
  });
  it('sizeUsd: required, > 0, ≤ 100,000,000', () => {
    expect(D.sizeUsd).toEqual({ type: 'number', required: true, exclusiveMinimum: 0, maximum: 100_000_000 });
  });
  it('holdHours: 0.25-720, default 8', () => {
    expect(D.holdHours).toEqual({ type: 'number', required: false, minimum: 0.25, maximum: 720, default: 8 });
  });
  it('timeframe: the regime timeframes by reference, default 4h', () => {
    expect(D.timeframe.values).toBe(REGIME_TIMEFRAMES);
    expect(D.timeframe.default).toBe('4h');
  });
  it('exchanges: 1-15 unique public venues, and NO default anywhere', () => {
    expect(D.exchanges.values).toBe(PUBLIC_VENUE_IDS);
    expect([D.exchanges.minItems, D.exchanges.maxItems, D.exchanges.uniqueItems]).toEqual([1, 15, true]);
    expect('default' in D.exchanges).toBe(false);
  });
  it('frozen, and unlisted: not projected into the public /docs enum map', () => {
    expect(Object.isFrozen(D)).toBe(true);
    for (const p of Object.values(D)) expect(Object.isFrozen(p)).toBe(true);
    expect(Object.keys(PUBLIC_TOOL_ENUM_PARAMS)).not.toContain('pre_trade_check');
  });
});
