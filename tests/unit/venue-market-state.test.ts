/**
 * DECISION-CALL-V1-W1 R2 — src/lib/venue-market-state.ts, the shared venue universe + funding snapshot.
 *
 * Pins: one `fetchVenueUniverse` call per venue per TTL across BOTH projections (the arb's per-leg
 * gate and the scan-shared floor) and a direct reader; single-flight on concurrent cold reads; a
 * thrown and an empty universe read are both `failed` and cached for the TTL; the funding feed is
 * fetched once per adapter per TTL, a failed feed is not cached, a throwing or empty feed marks the
 * venues it supplies as failed, a retired venue is never fetched; and every `normalizeVenueFunding`
 * branch, including `hourlyRate` equal to the arb's old arithmetic bit for bit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/exchange-adapter.js', () => ({ getAdapter: vi.fn() }));
vi.mock('../../src/lib/exchange-universe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/exchange-universe.js')>();
  return { ...actual, fetchVenueUniverse: vi.fn() };
});
vi.mock('../../src/lib/venue-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/venue-store.js')>();
  return { ...actual, getRetiredVenueSet: vi.fn(async () => new Set<string>()) };
});

import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { fetchVenueUniverse, type ExchangeAsset } from '../../src/lib/exchange-universe.js';
import {
  getVenueUniverseState,
  getMergedFundingSnapshot,
  normalizeVenueFunding,
  _resetVenueMarketStateCaches,
} from '../../src/lib/venue-market-state.js';
import { getVenueLiquidityUsd, _setLiquidityMapForTest } from '../../src/lib/scan-shared.js';
import { scanFundingArb } from '../../src/tools/scan-funding-arb.js';
import { _setCarryScoresForTest } from '../../src/lib/carry-rank-reader.js';
import { annualizeFunding } from '../../src/lib/rank-constants.js';
import { FUNDING_VENUE_META, FUNDING_ARB_FETCH_ADAPTERS } from '../../src/lib/funding-venues.js';
import type { ExchangeAdapter, ExchangeId, FundingData, LicenseInfo } from '../../src/types.js';

const T0 = Date.parse('2026-10-30T12:00:00.000Z');
const INTERNAL = { tier: 'internal', key: null, outcome: 'RESOLVED' } as LicenseInfo;
const universe = vi.mocked(fetchVenueUniverse);

const assets = (...coins: string[]): ExchangeAsset[] =>
  coins.map((coin) => ({ coin, notionalOI_usd: 50e6, volume24h_usd: 50e6 }) as ExchangeAsset);

function adapterWith(feed: () => Promise<FundingData[]>): ExchangeAdapter {
  return {
    getName: () => 'mock',
    getCandles: vi.fn(),
    getAssetContext: vi.fn(),
    getPredictedFundings: vi.fn(feed),
    getFundingHistory: vi.fn(async () => []),
    getCurrentPrice: vi.fn(),
  } as unknown as ExchangeAdapter;
}

/** One adapter object per venue, so call counts are per venue. */
function installAdapters(feeds: Partial<Record<ExchangeId, () => Promise<FundingData[]>>>): Map<ExchangeId, ExchangeAdapter> {
  const made = new Map<ExchangeId, ExchangeAdapter>();
  vi.mocked(getAdapter).mockImplementation((id: ExchangeId) => {
    if (!made.has(id)) made.set(id, adapterWith(feeds[id] ?? (async () => [])));
    return made.get(id)!;
  });
  return made;
}

const fundingOf = (venue: string, coin = 'BTC', fundingRate = 0.0001): FundingData => ({
  coin, venues: [{ venue, fundingRate, nextFundingTime: T0 + 3_600_000 }],
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
  vi.mocked(getAdapter).mockReset();
  universe.mockReset();
  _setLiquidityMapForTest(null);
  _resetVenueMarketStateCaches();
  _setCarryScoresForTest(null);
});
afterEach(() => {
  _setCarryScoresForTest(undefined);
  vi.useRealTimers();
});

describe('getVenueUniverseState — the ONE universe cache', () => {
  it('one fetch per venue per TTL across the arb gate, the scan-shared floor and a direct reader', async () => {
    universe.mockImplementation(async () => assets('BTC', 'ETH'));
    installAdapters({});
    await scanFundingArb({ license: INTERNAL });                 // projection 1 (every META venue)
    await getVenueLiquidityUsd('BINANCE');                       // projection 2
    const direct = await getVenueUniverseState('BINANCE');      // direct reader
    expect(direct).toEqual({ rows: assets('BTC', 'ETH'), failed: false });
    const venues = new Set(Object.values(FUNDING_VENUE_META).map((m) => m.exchangeId));
    expect(universe).toHaveBeenCalledTimes(venues.size);
    expect(universe.mock.calls.filter(([v]) => v === 'BINANCE')).toHaveLength(1);

    vi.setSystemTime(new Date(T0 + 59_999));
    await getVenueLiquidityUsd('BINANCE');
    expect(universe.mock.calls.filter(([v]) => v === 'BINANCE')).toHaveLength(1); // still fresh
    vi.setSystemTime(new Date(T0 + 60_000));
    await getVenueLiquidityUsd('BINANCE');
    expect(universe.mock.calls.filter(([v]) => v === 'BINANCE')).toHaveLength(2); // TTL elapsed → one re-fetch
  });

  it('two concurrent cold reads share one fetch (single-flight)', async () => {
    let release!: (rows: ExchangeAsset[]) => void;
    universe.mockImplementation(() => new Promise<ExchangeAsset[]>((res) => { release = res; }));
    const a = getVenueUniverseState('BYBIT');
    const b = getVenueLiquidityUsd('BYBIT');
    await Promise.resolve();
    release(assets('SOL'));
    expect(await a).toEqual({ rows: assets('SOL'), failed: false });
    expect([...(await b).keys()]).toEqual(['SOL']);
    expect(universe).toHaveBeenCalledTimes(1);
  });

  it('a thrown read is failed (rows empty) and cached for the TTL — the floor denies all', async () => {
    universe.mockRejectedValue(new Error('venue down'));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(await getVenueUniverseState('OKX')).toEqual({ rows: [], failed: true });
    expect((await getVenueLiquidityUsd('OKX')).size).toBe(0);
    expect(universe).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(T0 + 60_000));
    await getVenueUniverseState('OKX');
    expect(universe).toHaveBeenCalledTimes(2);
    debug.mockRestore();
  });

  it('an empty successful read is failed too, and cached for the TTL', async () => {
    universe.mockResolvedValue([]);
    expect(await getVenueUniverseState('KUCOIN')).toEqual({ rows: [], failed: true });
    await getVenueUniverseState('KUCOIN');
    expect(universe).toHaveBeenCalledTimes(1);
  });

  it('the scan-shared override seam still bypasses the cache and resets it', async () => {
    universe.mockResolvedValue(assets('BTC'));
    await getVenueUniverseState('BINANCE');
    _setLiquidityMapForTest(() => new Map([['X', 1]]));
    expect([...(await getVenueLiquidityUsd('BINANCE')).keys()]).toEqual(['X']);
    _setLiquidityMapForTest(null);
    await getVenueLiquidityUsd('BINANCE');
    expect(universe).toHaveBeenCalledTimes(2); // the seam reset the cached read
  });
});

describe('getMergedFundingSnapshot — the shared funding snapshot', () => {
  it('fetches each non-retired fetch adapter once per 30 s TTL (single-flight per adapter)', async () => {
    const made = installAdapters(Object.fromEntries(FUNDING_ARB_FETCH_ADAPTERS.map((id) => [id, async () => [fundingOf('HlPerp')]])));
    await Promise.all([getMergedFundingSnapshot(new Set()), getMergedFundingSnapshot(new Set())]);
    for (const id of FUNDING_ARB_FETCH_ADAPTERS) expect(made.get(id)!.getPredictedFundings).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(T0 + 30_000));
    await getMergedFundingSnapshot(new Set());
    for (const id of FUNDING_ARB_FETCH_ADAPTERS) expect(made.get(id)!.getPredictedFundings).toHaveBeenCalledTimes(2);
  });

  it('a throwing adapter marks every venue fetched via it as failed; the other feeds still merge', async () => {
    installAdapters({
      HL: async () => { throw new Error('hl down'); },
      GATE: async () => [fundingOf('GatePerp', 'BTC')],
      OKX: async () => [fundingOf('OKXPerp', 'BTC'), fundingOf('OKXPerp', 'ETH')],
    });
    const snap = await getMergedFundingSnapshot(new Set());
    const viaHl = Object.values(FUNDING_VENUE_META).filter((m) => m.fetchedVia === 'HL').map((m) => m.exchangeId);
    for (const v of viaHl) expect(snap.failedVenues.has(v)).toBe(true);
    expect(snap.failedVenues.has('GATE')).toBe(false);
    expect(snap.failedVenues.has('OKX')).toBe(false);
    expect(snap.byCoin.get('BTC')!.map((r) => r.venue)).toEqual(['GatePerp', 'OKXPerp']);
    expect(snap.byCoin.get('ETH')!.map((r) => r.venue)).toEqual(['OKXPerp']);
  });

  it('a feed returning [] is a failed feed (Gate and KuCoin turn their errors into [])', async () => {
    installAdapters({ HL: async () => [fundingOf('HlPerp')], GATE: async () => [] });
    const snap = await getMergedFundingSnapshot(new Set());
    expect(snap.failedVenues.has('GATE')).toBe(true);
    expect(snap.failedVenues.has('HL')).toBe(false);
  });

  it('a failed feed is not cached — the next snapshot retries it', async () => {
    let calls = 0;
    const made = installAdapters({ ASTER: async () => { calls++; if (calls === 1) throw new Error('blip'); return [fundingOf('AsterPerp')]; } });
    expect((await getMergedFundingSnapshot(new Set())).failedVenues.has('ASTER')).toBe(true);
    expect((await getMergedFundingSnapshot(new Set())).failedVenues.has('ASTER')).toBe(false);
    expect(made.get('ASTER')!.getPredictedFundings).toHaveBeenCalledTimes(2);
  });

  it('a retired venue is never fetched', async () => {
    const made = installAdapters({});
    await getMergedFundingSnapshot(new Set(['OKX', 'KUCOIN']));
    expect(made.has('OKX')).toBe(false);
    expect(made.has('KUCOIN')).toBe(false);
    expect(made.has('GATE')).toBe(true);
  });
});

describe('normalizeVenueFunding — the funding-row rule', () => {
  const row = (venue: string, fundingRate: number, intervalHours?: number) =>
    intervalHours === undefined
      ? { venue, fundingRate, nextFundingTime: T0 }
      : { venue, fundingRate, nextFundingTime: T0, intervalHours };

  it('an unknown venue-string → null (never guess its interval)', () => {
    expect(normalizeVenueFunding(row('MexcPerp', 0.0001))).toBeNull();
  });

  it('a NaN rate → null', () => {
    expect(normalizeVenueFunding(row('GatePerp', NaN))).toBeNull();
  });

  it('a published but invalid interval → null (the row self-skips)', () => {
    for (const bad of [0, -4, NaN, Infinity]) expect(normalizeVenueFunding(row('GatePerp', 0.0001, bad))).toBeNull();
  });

  it('an absent interval → the declared cadence, basis "declared"', () => {
    expect(normalizeVenueFunding(row('AsterPerp', 0.0001))).toEqual({
      venue: 'AsterPerp', exchangeId: 'ASTER', rate: 0.0001, intervalHours: FUNDING_VENUE_META.AsterPerp.intervalHours,
      intervalBasis: 'declared', nextFundingTime: T0, hourlyRate: annualizeFunding(0.0001, 8)! / 8760,
    });
  });

  it('a published interval → that interval, basis "contract"', () => {
    const n = normalizeVenueFunding(row('GatePerp', 0.0002, 4))!;
    expect(n.intervalHours).toBe(4);
    expect(n.intervalBasis).toBe('contract');
  });

  it('a 0 rate is a rate, not a missing one', () => {
    expect(normalizeVenueFunding(row('OKXPerp', 0, 8))!.hourlyRate).toBe(0);
  });

  it('hourlyRate equals the arb\'s pre-extraction arithmetic bit for bit on 1 h, 4 h and 8 h rows', () => {
    for (const [venue, rate, h] of [['HlPerp', 0.0000137, undefined], ['GatePerp', -0.00031, 4], ['OKXPerp', 0.00011, 8], ['BinPerp', 0.000123456789, undefined]] as const) {
      const n = normalizeVenueFunding(row(venue, rate, h))!;
      const interval = h ?? FUNDING_VENUE_META[venue].intervalHours;
      expect(n.hourlyRate).toBe(annualizeFunding(rate, interval)! / 8760);
    }
  });
});
