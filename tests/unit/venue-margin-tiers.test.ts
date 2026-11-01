/**
 * DECISION-CALL-V2-W1 CH1 AC1.2 — `venue-margin-tiers.ts`, the one tier lookup.
 *
 * The fixtures are the venues' own replies, trimmed to the first three tiers of the R0 captures for BTC
 * (measured 2026-11-01): Bybit `/v5/market/risk-limit`, OKX `/api/v5/public/position-tiers` (isolated) +
 * `/api/v5/public/instruments`, Bitget `/api/v2/mix/market/query-position-lever`. They are served through
 * each REAL adapter with only `globalThis.fetch` replaced, so symbol checks, units and sorting are exercised
 * along with the lookup. Binance's table is USER_DATA (signed): `tier_table_requires_key`, zero requests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createMarginTierLookup,
  marginTierAt,
  tierRateAt,
  _resetMarginTierCacheForTest,
  MARGIN_TIER_TTL_MS,
  type MarginTierReader,
} from '../../src/lib/venue-margin-tiers.js';
import { BybitAdapter } from '../../src/lib/adapters/bybit.js';
import { OKXAdapter } from '../../src/lib/adapters/okx.js';
import { BitgetAdapter } from '../../src/lib/adapters/bitget.js';
import type { ExchangeId } from '../../src/types.js';

// ── §1-shaped replies (R0, BTC, 2026-11-01; first three tiers) ───────────────────────────────────

const BYBIT_RISK_LIMIT = {
  retCode: 0, retMsg: 'OK', retExtInfo: {}, time: 1761980000000,
  result: {
    category: 'linear', nextPageCursor: '',
    list: [
      { id: 1, symbol: 'BTCUSDT', riskLimitValue: '300000', maintenanceMargin: '0.0033', initialMargin: '0.0066', isLowestRisk: 1, maxLeverage: '150.00', mmDeduction: '' },
      { id: 2, symbol: 'BTCUSDT', riskLimitValue: '2000000', maintenanceMargin: '0.005', initialMargin: '0.01', isLowestRisk: 0, maxLeverage: '100.00', mmDeduction: '510' },
      { id: 3, symbol: 'BTCUSDT', riskLimitValue: '2600000', maintenanceMargin: '0.0056', initialMargin: '0.0111', isLowestRisk: 0, maxLeverage: '90.00', mmDeduction: '1710' },
    ],
  },
};
const okxTier = (tier: string, minSz: string, maxSz: string, mmr: string, imr: string, maxLever: string) =>
  ({ baseMaxLoan: '', imr, instFamily: 'BTC-USDT', instId: '', maxLever, maxSz, minSz, mmr, optMgnFactor: '0', quoteMaxLoan: '', tier, uly: 'BTC-USDT' });
const OKX_TIERS = {
  code: '0', msg: '',
  data: [okxTier('1', '0', '1000', '0.004', '0.01', '100'), okxTier('2', '1000.01', '5000', '0.005', '0.015', '66.66'), okxTier('3', '5000.01', '20000', '0.0075', '0.02', '50')],
};
const OKX_INSTRUMENT = { code: '0', msg: '', data: [{ instId: 'BTC-USDT-SWAP', instFamily: 'BTC-USDT', ctVal: '0.01', ctValCcy: 'BTC', ctType: 'linear', settleCcy: 'USDT' }] };
const BITGET_TIERS = {
  code: '00000', msg: 'success', requestTime: 1761980000000,
  data: [
    { symbol: 'BTCUSDT', level: '1', startUnit: '0', endUnit: '200000', leverage: '150', keepMarginRate: '0.0040' },
    { symbol: 'BTCUSDT', level: '2', startUnit: '200000', endUnit: '1000000', leverage: '100', keepMarginRate: '0.0050' },
    { symbol: 'BTCUSDT', level: '3', startUnit: '1000000', endUnit: '5000000', leverage: '75', keepMarginRate: '0.0070' },
  ],
};

// ── The network edge ─────────────────────────────────────────────────────────────────────────────

let replies: Map<string, unknown>;
let fetchCalls: string[];
let originalFetch: typeof fetch;

function fakeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push(url);
    for (const [path, body] of replies) {
      if (url.includes(path)) {
        return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
      }
    }
    throw new Error(`[fake-fetch] unhandled URL: ${url}`);
  }) as typeof fetch;
}
const hits = (path: string) => fetchCalls.filter((u) => u.includes(path)).length;

beforeEach(() => {
  replies = new Map<string, unknown>([
    ['/v5/market/risk-limit', BYBIT_RISK_LIMIT],
    ['/api/v5/public/position-tiers', OKX_TIERS],
    ['/api/v5/public/instruments', OKX_INSTRUMENT],
    ['/api/v2/mix/market/query-position-lever', BITGET_TIERS],
  ]);
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  _resetMarginTierCacheForTest();
});

/** A lookup over the real adapters, counting every adapter read per (venue, coin). */
function lookup(now?: () => number) {
  const adapters: Partial<Record<string, MarginTierReader>> = { BYBIT: new BybitAdapter(), OKX: new OKXAdapter(), BITGET: new BitgetAdapter(), BINANCE: {} };
  const reads = new Map<string, number>();
  const l = createMarginTierLookup({
    now,
    reader: (exchange: ExchangeId) => {
      const a = adapters[exchange] ?? {};
      return {
        getMarginTiers: a.getMarginTiers
          ? (coin: string) => { reads.set(`${exchange}:${coin}`, (reads.get(`${exchange}:${coin}`) ?? 0) + 1); return a.getMarginTiers!.call(a, coin); }
          : undefined,
      };
    },
  });
  return { ...l, reads };
}

describe('notional → the venue\'s published maintenance rate', () => {
  it('Bybit, bands in USDT: inside tier 1, and an edge taking the higher rate', async () => {
    const l = lookup();
    expect(await l.marginTierAt('BYBIT', 'BTC', 100_000)).toEqual({ rate: 0.0033, basis: 'public_tier_table' });
    expect(await l.marginTierAt('BYBIT', 'BTC', 300_000)).toEqual({ rate: 0.005, basis: 'public_tier_table' });
    expect(await l.marginTierAt('BYBIT', 'BTC', 2_000_000)).toEqual({ rate: 0.0056, basis: 'public_tier_table' });
    expect(await l.marginTierAt('BYBIT', 'BTC', 300_001)).toEqual({ rate: 0.005, basis: 'public_tier_table' });
  });

  it('Bitget, bands in USDT: the published keepMarginRate (its taker fee is added only by the liquidation formula)', async () => {
    const l = lookup();
    expect(await l.marginTierAt('BITGET', 'BTC', 100_000)).toEqual({ rate: 0.004, basis: 'public_tier_table' });
    expect(await l.marginTierAt('BITGET', 'BTC', 200_000)).toEqual({ rate: 0.005, basis: 'public_tier_table' });
    expect(await l.marginTierAt('BITGET', 'BTC', 1_000_000)).toEqual({ rate: 0.007, basis: 'public_tier_table' });
  });

  it('OKX, bands in CONTRACTS: USD → contracts by ctVal x price; an edge and the 1000 → 1000.01 gap take the higher rate', async () => {
    const l = lookup();
    const px = 100_000; // one contract = 0.01 BTC = $1,000
    expect(await l.marginTierAt('OKX', 'BTC', 500_000, px)).toEqual({ rate: 0.004, basis: 'public_tier_table' });
    expect(await l.marginTierAt('OKX', 'BTC', 1_000_000, px)).toEqual({ rate: 0.005, basis: 'public_tier_table' });
    expect(await l.marginTierAt('OKX', 'BTC', 1_000_005, px)).toEqual({ rate: 0.005, basis: 'public_tier_table' });
    expect(await l.marginTierAt('OKX', 'BTC', 5_000_000, px)).toEqual({ rate: 0.0075, basis: 'public_tier_table' });
    expect(await l.marginTierAt('OKX', 'BTC', 500_000, 200_000)).toEqual({ rate: 0.004, basis: 'public_tier_table' });
    expect(await l.marginTierAt('OKX', 'BTC', 2_500_000, 200_000)).toEqual({ rate: 0.005, basis: 'public_tier_table' });
  });

  it('OKX with no usable price cannot place the notional: tier_unavailable, never a guess', async () => {
    const l = lookup();
    expect(await l.marginTierAt('OKX', 'BTC', 500_000)).toEqual({ rate: null, basis: 'tier_unavailable' });
    expect(await l.marginTierAt('OKX', 'BTC', 500_000, 0)).toEqual({ rate: null, basis: 'tier_unavailable' });
  });

  it('a notional beyond the last published band has no rate: tier_unavailable', async () => {
    const l = lookup();
    expect(await l.marginTierAt('BYBIT', 'BTC', 2_600_001)).toEqual({ rate: null, basis: 'tier_unavailable' });
  });

  it('every adapter asks for the coin\'s own symbol, with the documented query', async () => {
    const l = lookup();
    await Promise.all([l.marginTierAt('BYBIT', 'BTC', 1), l.marginTierAt('OKX', 'BTC', 1, 100_000), l.marginTierAt('BITGET', 'BTC', 1)]);
    const qs = (path: string) => Object.fromEntries(new URL(fetchCalls.find((u) => u.includes(path)) as string).searchParams);
    expect(qs('/v5/market/risk-limit')).toEqual({ category: 'linear', symbol: 'BTCUSDT' });
    expect(qs('/api/v5/public/position-tiers')).toEqual({ instType: 'SWAP', tdMode: 'isolated', instFamily: 'BTC-USDT' });
    expect(qs('/api/v5/public/instruments')).toEqual({ instType: 'SWAP', instId: 'BTC-USDT-SWAP' });
    expect(qs('/api/v2/mix/market/query-position-lever')).toEqual({ symbol: 'BTCUSDT', productType: 'USDT-FUTURES' });
  });
});

describe('Binance and unreadable tables', () => {
  it('Binance → tier_table_requires_key with ZERO requests', async () => {
    const l = lookup();
    expect(await l.marginTierAt('BINANCE', 'BTC', 100_000, 100_000)).toEqual({ rate: null, basis: 'tier_table_requires_key' });
    expect(fetchCalls).toEqual([]);
    expect(l.reads.size).toBe(0);
  });

  it('a failed, empty or wrong-symbol read → tier_unavailable (never another symbol\'s rate)', async () => {
    replies.set('/v5/market/risk-limit', { ...BYBIT_RISK_LIMIT, result: { ...BYBIT_RISK_LIMIT.result, list: [] } });
    replies.set('/api/v2/mix/market/query-position-lever', { ...BITGET_TIERS, data: BITGET_TIERS.data.map((r) => ({ ...r, symbol: 'ETHUSDT' })) });
    replies.set('/api/v5/public/instruments', { code: '51001', msg: 'Instrument ID does not exist', data: [] });
    const l = lookup();
    expect(await l.marginTierAt('BYBIT', 'BTC', 100_000)).toEqual({ rate: null, basis: 'tier_unavailable' });
    expect(await l.marginTierAt('BITGET', 'BTC', 100_000)).toEqual({ rate: null, basis: 'tier_unavailable' });
    expect(await l.marginTierAt('OKX', 'BTC', 100_000, 100_000)).toEqual({ rate: null, basis: 'tier_unavailable' });
  });

  it('a venue with no tier source answers tier_unavailable without a read', async () => {
    const l = lookup();
    expect(await l.marginTierAt('HL', 'BTC', 100_000)).toEqual({ rate: null, basis: 'tier_unavailable' });
    expect(fetchCalls).toEqual([]);
  });

  it('tierRateAt refuses a non-positive notional', () => {
    const t = { unit: 'usd' as const, contractValue: null, bands: [{ upTo: 10, rate: 0.01 }] };
    expect([tierRateAt(t, 0, null), tierRateAt(t, -1, null), tierRateAt(t, 10, null)]).toEqual([null, null, 0.01]);
  });
});

describe('one read per (venue, coin) — single-flight, 24 h', () => {
  it('50 concurrent calls → at most 1 read per venue and coin', async () => {
    const l = lookup();
    const venues = ['BYBIT', 'OKX', 'BITGET', 'BINANCE'] as const;
    const out = await Promise.all(Array.from({ length: 50 }, (_, i) => l.marginTierAt(venues[i % 4], 'BTC', 100_000, 100_000)));
    expect(out.filter((r) => r.basis === 'public_tier_table')).toHaveLength(38);
    expect(Object.fromEntries(l.reads)).toEqual({ 'BYBIT:BTC': 1, 'OKX:BTC': 1, 'BITGET:BTC': 1 });
    // One read = one request on Bybit and Bitget; OKX's read is two (tiers, then ctVal).
    expect([hits('/v5/market/risk-limit'), hits('/api/v2/mix/market/query-position-lever'), hits('/api/v5/public/position-tiers'), hits('/api/v5/public/instruments')])
      .toEqual([1, 1, 1, 1]);
  });

  it('the table is kept 24 h, then read again', async () => {
    let t = 1_761_980_000_000;
    const l = lookup(() => t);
    await l.marginTierAt('BYBIT', 'BTC', 100_000);
    t += MARGIN_TIER_TTL_MS - 1;
    await l.marginTierAt('BYBIT', 'BTC', 100_000);
    expect(l.reads.get('BYBIT:BTC')).toBe(1);
    t += 2;
    await l.marginTierAt('BYBIT', 'BTC', 100_000);
    expect(l.reads.get('BYBIT:BTC')).toBe(2);
  });

  it('the production lookup reads through getAdapter: the wrapped adapter keeps its tier read', async () => {
    expect(await marginTierAt('BYBIT', 'BTC', 100_000)).toEqual({ rate: 0.0033, basis: 'public_tier_table' });
    expect(await marginTierAt('BYBIT', 'BTC', 250_000)).toEqual({ rate: 0.0033, basis: 'public_tier_table' });
    expect(hits('/v5/market/risk-limit')).toBe(1);
  });
});
