/**
 * DECISION-CALL-V2-W1 CH2 (AC2.1) — `pre-trade-rules.ts`, the one rule table and the one evaluator.
 *
 * Every rule is held at its boundary from BOTH sides (the value that passes and the nearest that fails),
 * and shown `not_evaluated` with the detail a caller can act on. Then the active set: a number replaces a
 * default and makes it `yours`, `false` switches a boolean default off, and v1's thresholds are the defaults.
 */
import { describe, it, expect } from 'vitest';
import {
  PRE_TRADE_RULES,
  DEFAULT_MAX_FUNDING_BPS,
  DEFAULT_MAX_SIZE_PCT_OF_24H_VOLUME,
  REGIME_AGAINST_MIN_CONFIDENCE,
  VOLATILE_MIN_CONFIDENCE,
  parseRules,
  activeRules,
  activeLimit,
  evaluateRules,
  type PreTradeRuleMetrics,
  type PreTradeRuleId,
  type PreTradeRuleResult,
} from '../../src/lib/pre-trade-rules.js';
import { HIGH_CARRY_BPS, SIZE_MAX_PCT_OF_24H_VOLUME } from '../../src/lib/pre-trade-decision.js';
import { computePreTradeCalc } from '../../src/lib/pre-trade-calc.js';
import { PRE_TRADE_CHECK_PARAM_DECL } from '../../src/lib/tool-param-schema.js';

/** One venue on which every metric is known. Each test moves the one figure its rule reads. */
const M = (over: Partial<PreTradeRuleMetrics> = {}): PreTradeRuleMetrics => ({
  exchange: 'OKX',
  side: 'long',
  sizeUsd: 10_000,
  leverage: 10,
  stop_pct: 2,
  equity_usd: 50_000,
  liq_distance_pct: 9.6386,
  liq_before_stop: false,
  liq_distance_sigma: 5.4378,
  loss_at_stop_pct_equity: 0.42,
  one_sigma_day_pct_equity: 0.614,
  round_trip_bps: 10,
  accuracy_needed_pct: 53.54,
  funding_cost_bps: 1,
  size_pct_of_24h_volume: 0.0001,
  capacity_usd: 10_000_000,
  regime: { label: 'RANGING', confidence: 50, timeframe: '4h' },
  sigma_available: true,
  liq_basis: 'public_tier_table',
  ...over,
});

/** One rule, sent by the caller with `limit`, evaluated on `metrics`. */
function judge(id: PreTradeRuleId, limit: number | boolean, metrics: PreTradeRuleMetrics): PreTradeRuleResult {
  const [r] = evaluateRules(activeRules({ [id]: limit }).filter((x) => x.id === id), metrics);
  return r;
}

describe('the table: ten rules, in the contract\'s order, v1\'s thresholds as the defaults', () => {
  it('ten rows in table order, frozen', () => {
    expect(PRE_TRADE_RULES.map((r) => r.id)).toEqual([
      'maxLeverage', 'noLiqBeforeStop', 'minLiqDistanceSigma', 'maxLossAtStopPctEquity', 'maxDailyMovePctEquity',
      'maxRoundTripBps', 'maxAccuracyNeededPct', 'maxFundingBps', 'maxSizePctOf24hVolume', 'regimeCheck',
    ]);
    expect(Object.isFrozen(PRE_TRADE_RULES)).toBe(true);
    for (const r of PRE_TRADE_RULES) expect(Object.isFrozen(r) && Object.isFrozen(r.param), r.id).toBe(true);
  });

  it('the defaults are v1\'s: funding 10 bps, size 0.1% of 24h volume, the regime check on — and liquidation-before-stop on', () => {
    const defaults = Object.fromEntries(PRE_TRADE_RULES.filter((r) => r.default !== null).map((r) => [r.id, r.default]));
    expect(defaults).toEqual({ noLiqBeforeStop: true, maxFundingBps: 10, maxSizePctOf24hVolume: 0.1, regimeCheck: true });
    expect([DEFAULT_MAX_FUNDING_BPS, HIGH_CARRY_BPS]).toEqual([10, 10]);
    expect(DEFAULT_MAX_SIZE_PCT_OF_24H_VOLUME / 100).toBe(SIZE_MAX_PCT_OF_24H_VOLUME);
    expect(SIZE_MAX_PCT_OF_24H_VOLUME).toBe(0.001);
    expect([REGIME_AGAINST_MIN_CONFIDENCE, VOLATILE_MIN_CONFIDENCE]).toEqual([60, 70]);
  });

  it('the declaration\'s rules.properties are the table\'s params — one source for zod, the Bazaar and the handler', () => {
    const props = PRE_TRADE_CHECK_PARAM_DECL.rules.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props)).toEqual(PRE_TRADE_RULES.map((r) => r.id));
    for (const r of PRE_TRADE_RULES) expect(props[r.id], r.id).toEqual({ ...r.param, required: false });
    expect(PRE_TRADE_CHECK_PARAM_DECL.rules.additionalProperties).toBe(false);
  });
});

describe('AC2.1 — each rule\'s boundary, from both sides', () => {
  it('maxLeverage: at the limit passes, above fails', () => {
    expect(judge('maxLeverage', 10, M({ leverage: 10 }))).toMatchObject({ result: 'pass', value: 10, detail: 'Leverage 10x is within the limit of 10x.' });
    expect(judge('maxLeverage', 10, M({ leverage: 10.01 }))).toMatchObject({ result: 'fail', value: 10.01, detail: 'Leverage 10.01x is above the limit of 10x.' });
  });

  it('noLiqBeforeStop: liquidation AT the stop fails, a hair beyond passes (judged on the shown distance)', () => {
    const at = (stopPct: number) => {
      const c = computePreTradeCalc({ side: 'long', sizeUsd: 10_000, holdHours: 8, sigma1h: null, roundTripBps: 10, leverage: 25, maintenanceRate: 0.004, stopPct, targetPct: null, equityUsd: null });
      return judge('noLiqBeforeStop', true, M({ stop_pct: stopPct, liq_distance_pct: c.liq_distance_pct, liq_before_stop: c.liq_before_stop }));
    };
    expect(at(3.6145)).toMatchObject({ result: 'fail', value: true, detail: 'Isolated liquidation at 3.6145% from entry is at or inside the 3.6145% stop.', failCode: 'LIQUIDATION_BEFORE_STOP' });
    expect(at(3.6144)).toMatchObject({ result: 'pass', value: false, detail: 'Isolated liquidation at 3.6145% from entry is beyond the 3.6144% stop.', failCode: null });
  });

  it('minLiqDistanceSigma: at the minimum passes, below fails', () => {
    expect(judge('minLiqDistanceSigma', 2, M({ liq_distance_sigma: 2 }))).toMatchObject({ result: 'pass', detail: 'Liquidation distance 2 hold-period sigmas is at or above the minimum of 2 hold-period sigmas.' });
    expect(judge('minLiqDistanceSigma', 2, M({ liq_distance_sigma: 1.9999 }))).toMatchObject({ result: 'fail', detail: 'Liquidation distance 1.9999 hold-period sigmas is below the minimum of 2 hold-period sigmas.' });
  });

  it('maxLossAtStopPctEquity: at the limit passes, above fails', () => {
    expect(judge('maxLossAtStopPctEquity', 1, M({ loss_at_stop_pct_equity: 1 })).result).toBe('pass');
    expect(judge('maxLossAtStopPctEquity', 1, M({ loss_at_stop_pct_equity: 1.0001 }))).toMatchObject({ result: 'fail', detail: 'Loss at the stop 1.0001% of equity is above the limit of 1% of equity.' });
  });

  it('maxDailyMovePctEquity: at the limit passes, above fails', () => {
    expect(judge('maxDailyMovePctEquity', 5, M({ one_sigma_day_pct_equity: 5 })).result).toBe('pass');
    expect(judge('maxDailyMovePctEquity', 5, M({ one_sigma_day_pct_equity: 5.0001 })).result).toBe('fail');
  });

  it('maxRoundTripBps: at the limit passes, above fails', () => {
    expect(judge('maxRoundTripBps', 10, M({ round_trip_bps: 10 })).result).toBe('pass');
    expect(judge('maxRoundTripBps', 10, M({ round_trip_bps: 10.0001 }))).toMatchObject({ result: 'fail', detail: 'Round trip 10.0001 bps is above the limit of 10 bps.' });
  });

  it('maxAccuracyNeededPct: at the limit passes, above fails', () => {
    expect(judge('maxAccuracyNeededPct', 55, M({ accuracy_needed_pct: 55 })).result).toBe('pass');
    expect(judge('maxAccuracyNeededPct', 55, M({ accuracy_needed_pct: 55.01 })).result).toBe('fail');
  });

  it('maxFundingBps keeps v1\'s comparison: below passes, AT the limit fails — FUNDING_COST_HIGH as a default', () => {
    expect(judge('maxFundingBps', 10, M({ funding_cost_bps: 9.9999 }))).toMatchObject({ result: 'pass', detail: 'Funding over the hold 9.9999 bps is below the limit of 10 bps.' });
    expect(judge('maxFundingBps', 10, M({ funding_cost_bps: 10 }))).toMatchObject({ result: 'fail', detail: 'Funding over the hold 10 bps is at or above the limit of 10 bps.', failCode: 'FUNDING_COST_HIGH' });
  });

  it('maxSizePctOf24hVolume keeps v1\'s comparison: capacity equal to the order passes, a cent short fails — SIZE_ABOVE_VENUE_LIMIT', () => {
    expect(judge('maxSizePctOf24hVolume', 0.1, M({ capacity_usd: 10_000 }))).toMatchObject({ result: 'pass', value: 0.0001 });
    expect(judge('maxSizePctOf24hVolume', 0.1, M({ capacity_usd: 9_999.99, size_pct_of_24h_volume: 0.1 }))).toMatchObject({
      result: 'fail', value: 0.1, failCode: 'SIZE_ABOVE_VENUE_LIMIT', detail: 'The order is 0.1% of 24h volume, above the limit of 0.1% ($10,000 on OKX).',
    });
  });

  it('regimeCheck keeps v1\'s confidences: against the side from 60, VOLATILE from 70, either side', () => {
    const regime = (label: string, confidence: number, side: 'long' | 'short' = 'long') =>
      judge('regimeCheck', true, M({ side, regime: { label, confidence, timeframe: '4h' } }));
    expect(regime('TRENDING_DOWN', 59)).toMatchObject({ result: 'pass', value: 'TRENDING_DOWN' });
    expect(regime('TRENDING_DOWN', 60)).toMatchObject({ result: 'fail', failCode: 'REGIME_AGAINST_SIDE', detail: 'The 4h regime is TRENDING_DOWN at confidence 60, against a long.' });
    expect(regime('TRENDING_UP', 59, 'short').result).toBe('pass');
    expect(regime('TRENDING_UP', 60, 'short')).toMatchObject({ result: 'fail', failCode: 'REGIME_AGAINST_SIDE' });
    expect(regime('TRENDING_UP', 99).result, 'with the side is never against it').toBe('pass');
    expect(regime('VOLATILE', 69).result).toBe('pass');
    expect(regime('VOLATILE', 70)).toMatchObject({ result: 'fail', failCode: 'REGIME_VOLATILE', detail: 'The 4h regime is VOLATILE at confidence 70.' });
  });

  it('a failed rule of YOURS carries the same failCode — `decide` reads the source, not the code, to tell them apart', () => {
    const [r] = evaluateRules([{ id: 'maxFundingBps', source: 'yours', limit: 1 }], M({ funding_cost_bps: 1 }));
    expect([r.source, r.result, r.failCode]).toEqual(['yours', 'fail', 'FUNDING_COST_HIGH']);
  });
});

describe('AC2.1 — not_evaluated: the metric is null, and the detail says what to send or what is missing', () => {
  const cases: Array<[PreTradeRuleId, number | boolean, Partial<PreTradeRuleMetrics>, string]> = [
    ['maxLeverage', 10, { leverage: null }, 'Send leverage to check this rule.'],
    ['noLiqBeforeStop', true, { leverage: null, stop_pct: null, liq_distance_pct: null, liq_before_stop: null }, 'Send leverage and stopPct to check this rule.'],
    ['noLiqBeforeStop', true, { stop_pct: null, liq_before_stop: null }, 'Send stopPct to check this rule.'],
    ['noLiqBeforeStop', true, { exchange: 'BINANCE', liq_distance_pct: null, liq_before_stop: null, liq_basis: 'tier_table_requires_key' }, 'BINANCE publishes its maintenance tiers only to account holders.'],
    ['noLiqBeforeStop', true, { exchange: 'BITGET', liq_distance_pct: null, liq_before_stop: null, liq_basis: 'tier_unavailable' }, 'BITGET has no readable maintenance tier for this order.'],
    ['minLiqDistanceSigma', 2, { leverage: null, liq_distance_sigma: null }, 'Send leverage to check this rule.'],
    ['minLiqDistanceSigma', 2, { liq_distance_sigma: null, sigma_available: false }, 'No fresh 1h volatility is available.'],
    ['maxLossAtStopPctEquity', 1, { stop_pct: null, equity_usd: null, loss_at_stop_pct_equity: null }, 'Send stopPct and equityUsd to check this rule.'],
    ['maxLossAtStopPctEquity', 1, { equity_usd: null, loss_at_stop_pct_equity: null }, 'Send equityUsd to check this rule.'],
    ['maxDailyMovePctEquity', 5, { one_sigma_day_pct_equity: null, sigma_available: false }, 'No fresh 1h volatility is available.'],
    ['maxRoundTripBps', 10, { round_trip_bps: null }, 'Its figure is unavailable on OKX.'],
    ['maxRoundTripBps', 10, { exchange: null, round_trip_bps: null }, 'No venue can take this order, so it was not checked.'],
    ['maxAccuracyNeededPct', 55, { accuracy_needed_pct: null, sigma_available: false }, 'No fresh 1h volatility is available.'],
    ['maxFundingBps', 10, { exchange: null, funding_cost_bps: null }, 'No venue can take this order, so it was not checked.'],
    ['maxSizePctOf24hVolume', 0.1, { exchange: null, capacity_usd: null, size_pct_of_24h_volume: null }, 'No venue can take this order, so it was not checked.'],
    ['regimeCheck', true, { regime: null }, 'No fresh market regime is available.'],
  ];
  for (const [id, limit, over, detail] of cases) {
    it(`${id}: ${detail}`, () => {
      expect(judge(id, limit, M(over))).toEqual({ id, source: 'yours', limit, value: null, result: 'not_evaluated', detail, failCode: null });
    });
  }

  it('every rule has a not_evaluated case above', () => {
    expect(new Set(cases.map(([id]) => id))).toEqual(new Set(PRE_TRADE_RULES.map((r) => r.id)));
  });
});

describe('AC2.1 — active rules: what the caller sent, and every default not switched off', () => {
  it('nothing sent: the four defaults, source default, in table order', () => {
    expect(activeRules()).toEqual([
      { id: 'noLiqBeforeStop', source: 'default', limit: true },
      { id: 'maxFundingBps', source: 'default', limit: 10 },
      { id: 'maxSizePctOf24hVolume', source: 'default', limit: 0.1 },
      { id: 'regimeCheck', source: 'default', limit: true },
    ]);
  });

  it('a number replaces a default and makes it yours', () => {
    const active = activeRules({ maxFundingBps: 5, maxSizePctOf24hVolume: 0.5 });
    expect(active.find((r) => r.id === 'maxFundingBps')).toEqual({ id: 'maxFundingBps', source: 'yours', limit: 5 });
    expect([activeLimit(active, 'maxFundingBps'), activeLimit(active, 'maxSizePctOf24hVolume')]).toEqual([5, 0.5]);
    expect([activeLimit(activeRules(), 'maxFundingBps'), activeLimit(activeRules(), 'maxSizePctOf24hVolume')]).toEqual([10, 0.1]);
  });

  it('false switches a boolean default off; true makes it yours', () => {
    expect(activeRules({ regimeCheck: false, noLiqBeforeStop: false }).map((r) => r.id)).toEqual(['maxFundingBps', 'maxSizePctOf24hVolume']);
    expect(activeRules({ regimeCheck: true }).find((r) => r.id === 'regimeCheck')).toEqual({ id: 'regimeCheck', source: 'yours', limit: true });
  });

  it('a rule with no default is active only when sent — and in table order, wherever it was sent', () => {
    expect(activeRules({ regimeCheck: true, maxLeverage: 5 }).map((r) => [r.id, r.source])).toEqual([
      ['maxLeverage', 'yours'], ['noLiqBeforeStop', 'default'], ['maxFundingBps', 'default'], ['maxSizePctOf24hVolume', 'default'], ['regimeCheck', 'yours'],
    ]);
  });
});

describe('parseRules — closed to unknown keys; every value held to its rule\'s type and bounds', () => {
  it('absent or null: no rules', () => {
    expect(parseRules(undefined)).toEqual({ ok: true, rules: {} });
    expect(parseRules(null)).toEqual({ ok: true, rules: {} });
    expect(parseRules({ maxLeverage: null })).toEqual({ ok: true, rules: {} });
  });

  it('not an object: param rules', () => {
    for (const raw of ['x', 7, true, [], [{ maxLeverage: 5 }]]) expect(parseRules(raw), JSON.stringify(raw)).toMatchObject({ ok: false, kind: 'not_object', param: 'rules' });
  });

  it('an unknown key: param rules.<key>', () => {
    expect(parseRules({ maxLeverage: 5, foo: 1 })).toEqual({ ok: false, kind: 'unknown_key', param: 'rules.foo', message: 'rules.foo is not a rule.' });
  });

  it('a value outside its type or bounds: param rules.<key>, the bounds named', () => {
    expect(parseRules({ maxLeverage: 0 })).toMatchObject({ ok: false, kind: 'bad_value', param: 'rules.maxLeverage', message: 'rules.maxLeverage must be a number between 1 and 200.' });
    expect(parseRules({ maxSizePctOf24hVolume: 0 })).toMatchObject({ kind: 'bad_value', message: 'rules.maxSizePctOf24hVolume must be a number above 0 and at most 100.' });
    expect(parseRules({ regimeCheck: 1 })).toMatchObject({ kind: 'bad_value', message: 'rules.regimeCheck must be true or false.' });
    expect(parseRules({ maxFundingBps: false })).toMatchObject({ kind: 'bad_value', param: 'rules.maxFundingBps' });
    expect(parseRules({ maxRoundTripBps: Number.NaN })).toMatchObject({ kind: 'bad_value' });
  });

  it('every bound is inclusive where the contract says so, exclusive where it says above', () => {
    expect(parseRules({ maxLeverage: 1, minLiqDistanceSigma: 0, maxAccuracyNeededPct: 50, maxFundingBps: 10_000, maxSizePctOf24hVolume: 100 }).ok).toBe(true);
    expect(parseRules({ maxSizePctOf24hVolume: 0.000001 }).ok).toBe(true);
    expect(parseRules({ maxAccuracyNeededPct: 49.99 }).ok).toBe(false);
    expect(parseRules({ maxRoundTripBps: 1000.01 }).ok).toBe(false);
  });
});
