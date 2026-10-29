/**
 * OPS-ASSET-CLASS-TOTALITY-W1 CH2 — a call's tier follows the venue it was called on.
 *
 * `classifyAsset(coin, top20, venue)` takes the venue; the rollups tier every call on its own venue
 * and give a coin the majority tier of its calls (tie → lower). The AC cases run on the live census
 * (`tests/fixtures/asset-class-census.json`). HALT-B3: re-tiering may move ONLY tier fields — every
 * other aggregate is byte-identical under two classifiers (the census engine vs the cold STATIC floor).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyAsset, majorityTier, type AssetTier } from '../../src/lib/asset-tiers.js';
import { _clearAssetClassCache, _loadVenueRecordsForTest } from '../../src/lib/asset-class-detection.js';
import { aggregateRowsInJs, rollupStats, canonicalizeForCompare, _computeStatsOracle } from '../../src/lib/performance-db.js';
import type { FieldVenue } from '../../src/lib/market-sessions-constants.js';
import type { PerformanceStats, SignalRecord } from '../../src/types.js';

const CENSUS = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'asset-class-census.json'), 'utf8')) as {
  venues: Partial<Record<FieldVenue, Array<[string, string]>>>;
};
const loadCensus = () => _loadVenueRecordsForTest(CENSUS.venues);

let _id = 1;
function mkRow(coin: string, exchange: string, signal: SignalRecord['signal'] = 'BUY', pfe: number | null = 1): SignalRecord {
  _id++;
  return {
    id: _id, coin, signal, timeframe: '1h', confidence: 75, price_at_signal: 100,
    price_after_15m: null, price_after_1h: null, price_after_4h: null, price_after_24h: null,
    return_pct_15m: null, return_pct_1h: null, return_pct_4h: null, return_pct_24h: null,
    outcome_price: null, outcome_return_pct: null, pfe_return_pct: signal === 'HOLD' ? null : pfe,
    mae_return_pct: null, pfe_price: null, mae_price: null, pfe_candles: null, return_1candle: null,
    created_at: 1_700_000_000 + _id, exchange,
  };
}
const top20Recent = (rows: SignalRecord[]) => [...rows].sort((a, b) => (b.created_at - a.created_at) || ((b.id ?? 0) - (a.id ?? 0))).slice(0, 20);
const rollup = (rows: SignalRecord[]): PerformanceStats => {
  const { groups, period } = aggregateRowsInJs(rows);
  return rollupStats(groups, period, null, top20Recent(rows), null);
};
const canon = (o: unknown) => JSON.stringify(canonicalizeForCompare(o));

describe('classifyAsset — Tier 3 from the venue the call was made on (AC, live census)', () => {
  beforeEach(() => { _clearAssetClassCache(); loadCensus(); });
  afterEach(() => _clearAssetClassCache());

  it('CVX@BINANCE ≠ 3 · CVXSTOCK@BITGET = 3 · BB@OKX = 3 · BB@BINANCE ≠ 3', () => {
    expect(classifyAsset('CVX', null, 'BINANCE')).not.toBe(3);
    expect(classifyAsset('CVXSTOCK', null, 'BITGET')).toBe(3);
    expect(classifyAsset('BB', null, 'OKX')).toBe(3);
    expect(classifyAsset('BB', null, 'BINANCE')).not.toBe(3);
  });

  it('E6 coins are not Tier 3 on the venue that lists them as crypto; SPX is no longer seeded TradFi (Q2)', () => {
    for (const c of ['CVX', 'STX', 'QNT', 'FORM']) expect(classifyAsset(c, null, 'BINANCE'), c).not.toBe(3);
    expect(classifyAsset('SPX', null, 'HL')).not.toBe(3);
    expect(classifyAsset('TSLA', null, 'HL')).toBe(3); // xyz:TSLA — HL's own TradFi record
  });

  it('venue-less (a holds-only coin): exact crypto evidence anywhere wins; a query form may decide TradFi', () => {
    expect(classifyAsset('CVX', null, null)).not.toBe(3);
    expect(classifyAsset('TSLAX', null, null)).toBe(3); // TSLAX → TSLA (Q3)
  });
});

describe('majorityTier — the headline tier of a coin called on several venues', () => {
  it('most calls wins; a tie goes to the lower tier number; empty → null', () => {
    expect(majorityTier(new Map<AssetTier, number>([[4, 5], [3, 2]]))).toBe(4);
    expect(majorityTier(new Map<AssetTier, number>([[4, 5], [3, 5]]))).toBe(3);
    expect(majorityTier(new Map<AssetTier, number>([[3, 5], [4, 5]]))).toBe(3);
    expect(majorityTier(new Map())).toBeNull();
  });
});

describe('the rollups tier each call on its own venue (Q4)', () => {
  // BB: 3 OKX calls (a stock) + 2 Binance calls (a token); TIE: 2 + 2; BTC on HL.
  const ROWS = [
    mkRow('BB', 'OKX'), mkRow('BB', 'OKX'), mkRow('BB', 'OKX', 'SELL', -1),
    mkRow('BB', 'BINANCE'), mkRow('BB', 'BINANCE', 'HOLD'),
    mkRow('ON', 'OKX'), mkRow('ON', 'OKX'), mkRow('ON', 'BINANCE'), mkRow('ON', 'BINANCE'),
    mkRow('BTC', 'HL'), mkRow('CVX', 'BINANCE', 'SELL', 0.5),
  ];
  beforeEach(() => { _clearAssetClassCache(); loadCensus(); });
  afterEach(() => _clearAssetClassCache());

  it('per-venue tier fields, the majority headline, and byTier counts each call at its own tier', () => {
    const s = rollup(ROWS);
    expect(s.byExchange.OKX.byAsset.BB.tier).toBe(3);
    expect(s.byExchange.BINANCE.byAsset.BB.tier).toBe(4);
    expect(s.byAsset.BB.tier).toBe(3);   // 3 OKX calls vs 2 Binance calls
    expect(s.byAsset.ON.tier).toBe(3);   // 2 vs 2 → the lower tier
    expect(s.byAsset.CVX.tier).toBe(4);
    expect(s.byExchange.OKX.byTier.tier3.count).toBe(5);     // BB ×3 + ON ×2, nonHold
    expect(s.byExchange.BINANCE.byTier.tier3.count).toBe(0);
    expect(s.byTier.tier3.count).toBe(5);
    expect(s.byTier.tier3.assets).toEqual(['BB', 'ON']);
    expect(s.byTier.tier4.assets).toEqual(['BB', 'CVX', 'ON']); // the same ticker, a different instrument
    const recent = new Map(s.recentSignals.map((r) => [r.id, r.tier]));
    for (const r of ROWS) if (recent.has(r.id!)) expect(recent.get(r.id!), `${r.coin}@${r.exchange}`).toBe(classifyAsset(r.coin, null, r.exchange as never));
  });

  it('the scan path (computeStats) and the SQL-pushdown path (rollupStats) agree', () => {
    const oracle = _computeStatsOracle([...ROWS].reverse(), null, null); // the loader's created_at DESC order
    const { recentSignals: _a, ...o } = oracle;
    const { recentSignals: _b, ...r } = rollup(ROWS);
    expect(canon(r)).toBe(canon(o));
    expect(oracle.recentSignals.map((x) => x.tier)).toEqual(rollup(ROWS).recentSignals.map((x) => x.tier));
  });

  it('HALT-B3: only tier fields move — everything else byte-identical under two classifiers', () => {
    const a = rollup(ROWS);
    _clearAssetClassCache(); // the cold STATIC floor: nothing knows BB/ON as stocks
    const b = rollup(ROWS);
    expect(a.byExchange.OKX.byAsset.BB.tier).not.toBe(b.byExchange.OKX.byAsset.BB.tier); // the classifiers DO differ
    const pick = (s: PerformanceStats) => ({ overall: s.overall, totalCalls: s.totalCalls, byCallType: s.byCallType, byTimeframe: s.byTimeframe, period: s.period });
    expect(canon(pick(a))).toBe(canon(pick(b)));
    const exNoTier = (s: PerformanceStats) => Object.fromEntries(Object.entries(s.byExchange).map(([k, e]) => {
      const { byTier: _t, byAsset, ...rest } = e;
      return [k, { ...rest, byAsset: Object.fromEntries(Object.entries(byAsset).map(([c, x]) => [c, { count: x.count, pfeWinRate: x.pfeWinRate }])) }];
    }));
    expect(canon(exNoTier(a))).toBe(canon(exNoTier(b)));
  });
});
