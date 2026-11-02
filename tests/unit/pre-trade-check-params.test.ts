/**
 * DECISION-CALL-V1-W2 R4 — `PRE_TRADE_CHECK_PARAM_DECL` is the contract's § Params, and every
 * served surface projects from it.
 */
import { describe, it, expect } from 'vitest';
import {
  PRE_TRADE_CHECK_PARAM_DECL as D,
  PRE_TRADE_SIDES,
  PRE_TRADE_ORDER_TYPES,
  PUBLIC_VENUE_IDS,
  REGIME_TIMEFRAMES,
  PUBLIC_TOOL_ENUM_PARAMS,
} from '../../src/lib/tool-param-schema.js';
import { PRE_TRADE_RULES } from '../../src/lib/pre-trade-rules.js';

describe('PRE_TRADE_CHECK_PARAM_DECL — the contract, once', () => {
  it('declares exactly the six v1 params, then the five v2 scalars and the rules object (DECISION-CALL-V2-W1)', () => {
    expect(Object.keys(D)).toEqual(['coin', 'side', 'sizeUsd', 'holdHours', 'timeframe', 'exchanges',
      'leverage', 'stopPct', 'targetPct', 'equityUsd', 'orderType', 'rules']);
  });
  it('rules: an optional object closed to unknown keys, its properties the rule table\'s params, each optional', () => {
    expect([D.rules.type, D.rules.required, D.rules.additionalProperties]).toEqual(['object', false, false]);
    expect(Object.keys(D.rules.properties)).toEqual(PRE_TRADE_RULES.map((r) => r.id));
    for (const r of PRE_TRADE_RULES) expect(D.rules.properties[r.id], r.id).toEqual({ ...r.param, required: false });
  });
  it('v2 scalars: optional, bounded as the v2 contract states; orderType defaults to market', () => {
    expect(D.leverage).toEqual({ type: 'number', required: false, minimum: 1, maximum: 200 });
    expect(D.stopPct).toEqual({ type: 'number', required: false, minimum: 0.01, maximum: 50 });
    expect(D.targetPct).toEqual({ type: 'number', required: false, minimum: 0.01, maximum: 1000 });
    expect(D.equityUsd).toEqual({ type: 'number', required: false, exclusiveMinimum: 0, maximum: 10_000_000_000 });
    expect(D.orderType.values).toBe(PRE_TRADE_ORDER_TYPES);
    expect([...PRE_TRADE_ORDER_TYPES]).toEqual(['market', 'limit']);
    expect([D.orderType.required, D.orderType.default]).toEqual([false, 'market']);
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
  it('frozen', () => {
    expect(Object.isFrozen(D)).toBe(true);
    for (const p of Object.values(D)) expect(Object.isFrozen(p)).toBe(true);
  });
  // DOCS-PRE-TRADE-CHECK-LISTING-W1 — listed: the /docs enum map holds the declaration's OWN enum rows.
  it('listed: every enum row reaches the public /docs enum map by REFERENCE, in declaration order', () => {
    const projected = PUBLIC_TOOL_ENUM_PARAMS.pre_trade_check;
    expect(Object.keys(projected)).toEqual(['side', 'timeframe', 'exchanges', 'orderType']);
    expect(projected.side).toBe(D.side);
    expect(projected.timeframe).toBe(D.timeframe);
    expect(projected.exchanges).toBe(D.exchanges);
    expect(projected.orderType).toBe(D.orderType);
    expect(Object.isFrozen(projected)).toBe(true);
  });
  it('listed: the projection is selected by shape — every row with `values`, and only those', () => {
    const withValues = Object.entries(D).filter(([, row]) => 'values' in row).map(([k]) => k);
    expect(Object.keys(PUBLIC_TOOL_ENUM_PARAMS.pre_trade_check)).toEqual(withValues);
    for (const k of ['coin', 'sizeUsd', 'holdHours', 'leverage', 'stopPct', 'targetPct', 'equityUsd', 'rules']) {
      expect(PUBLIC_TOOL_ENUM_PARAMS.pre_trade_check, k).not.toHaveProperty(k);
    }
  });
});
