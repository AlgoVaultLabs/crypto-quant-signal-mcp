/**
 * DECISION-CALL-V1-W1 R1 — the `scan_funding_arb` golden, recorded from the UNCHANGED code
 * (origin/main 36ae9552) before any src edit of the wave.
 *
 * WHAT IT PINS. The path R2 moves into `src/lib/venue-market-state.ts`: the per-adapter predicted-
 * funding fetch + merge, the per-leg liquidity map built from `fetchVenueUniverse` (this test does
 * NOT set `_setLiquidityOverrideForTest`, so the live-prefetch branch runs against the mocked
 * universe), the interval rule, and the scan-shared liquidity floor that reads the same universe.
 * Mocks sit at module boundaries the refactor does not move (`exchange-adapter`, `exchange-universe`,
 * `venue-store`, the carry reader's own seam), so the golden is an oracle for the refactor rather
 * than a copy of it.
 *
 * Inputs exercise every branch the move carries: ≥ 12 coins; one coin quoted on 6 venue-strings; a
 * venue-string emitted by two feeds (the merge keeps one); a GatePerp row with `intervalHours: 4`
 * and one with `intervalHours: 0`; a NaN rate; a throwing KUCOIN feed; ASTER universe rows that are
 * volume proxies; a throwing OKX universe; an empty KUCOIN universe; a coin below MIN_LIQUIDITY_USD
 * on one venue. The BINANCE / BYBIT / BITGET adapters are mocked too: the unchanged code never calls
 * them, and R3 (own feeds) does — R6 re-captures against these same inputs.
 *
 * The fixture records `__PKG_VERSION__` / `__COMPATIBLE_WITH__` (the `tests/scan-market-regimes.test.ts`
 * pattern) so a release cannot turn it red. A mismatch writes the actual output — placeholders
 * re-inserted — to a temp path for diagnosis; that write never makes the test pass.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
import { scanFundingArb, _resetScanFundingArbCaches } from '../../src/tools/scan-funding-arb.js';
import { applyLiquidityFloor, _setLiquidityMapForTest } from '../../src/lib/scan-shared.js';
import { _setCarryScoresForTest } from '../../src/lib/carry-rank-reader.js';
import { _resetCallTrackersForTest, resetLicenseCache } from '../../src/lib/license.js';
import { PKG_VERSION } from '../../src/lib/pkg-version.js';
import { compatibleWith } from '../../src/lib/primitive-projection.js';
import type { ExchangeAdapter, ExchangeId, FundingData, LicenseInfo } from '../../src/types.js';

const GOLDEN_NOW = Date.parse('2026-10-30T12:00:00.000Z');
const MIN = 60_000;
const HR = 3_600_000;
const FIXTURE = join(__dirname, '..', 'fixtures', 'scan-funding-arb-golden-2026-10-30.json');

type Row = FundingData['venues'][number];
const r = (venue: string, fundingRate: number, nextInMin: number, intervalHours?: number): Row =>
  intervalHours === undefined
    ? { venue, fundingRate, nextFundingTime: GOLDEN_NOW + nextInMin * MIN }
    : { venue, fundingRate, nextFundingTime: GOLDEN_NOW + nextInMin * MIN, intervalHours };

/** Each adapter's predicted-funding feed. KUCOIN throws (see `adapterFor`). */
const FEEDS: Partial<Record<ExchangeId, FundingData[]>> = {
  // HL's feed is the cross-venue aggregate the unchanged code reads Binance + Bybit from.
  HL: [
    { coin: 'BTC',  venues: [r('HlPerp', 0.0000125, 20), r('BinPerp', 0.0001, 240), r('BybitPerp', 0.00012, 240)] },
    { coin: 'ETH',  venues: [r('HlPerp', -0.00002, 20), r('BinPerp', 0.0001, 240), r('BybitPerp', 0.00008, 240)] },
    { coin: 'SOL',  venues: [r('HlPerp', 0.00005, 20), r('BinPerp', -0.0002, 240), r('BybitPerp', 0.0001, 240)] },
    { coin: 'DOGE', venues: [r('HlPerp', 0.0008, 20), r('BinPerp', 0.0008, 240), r('BybitPerp', 0.0006, 240)] },
    { coin: 'XRP',  venues: [r('HlPerp', 0.00001, 20), r('BinPerp', 0.0001, 240)] },
    { coin: 'LINK', venues: [r('HlPerp', 0.00003, 20)] },
    { coin: 'AVAX', venues: [r('HlPerp', 0.00002, 20), r('BybitPerp', 0.0003, 240)] },
    { coin: 'SUI',  venues: [r('HlPerp', 0.00004, 20), r('BinPerp', 0.0005, 240), r('BybitPerp', 0.0004, 240)] },
    { coin: 'WIF',  venues: [r('HlPerp', 0.0002, 20), r('BinPerp', 0.001, 240)] },
    { coin: 'PEPE', venues: [r('HlPerp', 0.00001, 20), r('BinPerp', 0.0002, 240), r('BybitPerp', 0.00025, 240)] },
    { coin: 'TIA',  venues: [r('HlPerp', -0.0001, 20)] },
    { coin: 'THIN', venues: [r('HlPerp', 0.0005, 20), r('BinPerp', 0.004, 240)] },
    { coin: 'ARB',  venues: [r('HlPerp', 0.00001, 20), r('BinPerp', 0, 240)] },
    { coin: 'OP',   venues: [r('HlPerp', 0.00002, 20)] },
  ],
  GATE: [
    { coin: 'BTC',  venues: [r('GatePerp', 0.00011, 240)] },
    { coin: 'LINK', venues: [r('GatePerp', 0.004, 120, 4), r('HlPerp', 0.009, 20)] }, // HlPerp here: a venue-string a second feed also emits
    { coin: 'SOL',  venues: [r('GatePerp', 0.0003, 240, 0)] },                          // invalid interval → row self-skips
    { coin: 'TIA',  venues: [r('GatePerp', 0.0002, 120, 4)] },
    { coin: 'AVAX', venues: [r('GatePerp', 0.0001, 240)] },
  ],
  ASTER: [
    { coin: 'BTC',  venues: [r('AsterPerp', 0.00009, 240)] },
    { coin: 'ETH',  venues: [r('AsterPerp', 0.00015, 240)] },
    { coin: 'DOGE', venues: [r('AsterPerp', 0.0002, 240)] },
    { coin: 'OP',   venues: [r('AsterPerp', NaN, 240)] },                               // NaN rate
    { coin: 'WIF',  venues: [r('AsterPerp', 0.0003, 240)] },
  ],
  OKX: [
    { coin: 'BTC',  venues: [r('OKXPerp', 0.0001, 240, 8)] },
    { coin: 'ETH',  venues: [r('OKXPerp', 0.00012, 240, 8)] },
    { coin: 'SOL',  venues: [r('OKXPerp', 0.0001, 240, 8)] },
  ],
  // Own feeds — read only once R3 points BinPerp / BybitPerp at their own adapters and adds Bitget.
  BINANCE: [
    { coin: 'BTC',   venues: [r('BinPerp', 0.0001, 240, 8)] },
    { coin: 'ETH',   venues: [r('BinPerp', 0.0001, 240, 8)] },
    { coin: 'SOL',   venues: [r('BinPerp', -0.0002, 240, 8)] },
    { coin: 'DOGE',  venues: [r('BinPerp', 0.0008, 240, 8)] },
    { coin: 'XRP',   venues: [r('BinPerp', 0.0001, 240, 8)] },
    { coin: 'SUI',   venues: [r('BinPerp', 0.0005, 120, 4)] },
    { coin: 'WIF',   venues: [r('BinPerp', 0.001, 120, 4)] },
    { coin: 'PEPE',  venues: [r('BinPerp', 0.0002, 240, 8)] },
    { coin: 'THIN',  venues: [r('BinPerp', 0.004, 240, 8)] },
    { coin: 'ARB',   venues: [r('BinPerp', 0, 240, 8)] },
    { coin: 'EIGEN', venues: [r('BinPerp', 0.0003, 120, 4)] },
  ],
  BYBIT: [
    { coin: 'BTC',   venues: [r('BybitPerp', 0.00012, 240, 8)] },
    { coin: 'ETH',   venues: [r('BybitPerp', 0.00008, 240, 8)] },
    { coin: 'SOL',   venues: [r('BybitPerp', 0.0001, 240, 8)] },
    { coin: 'DOGE',  venues: [r('BybitPerp', 0.0006, 240, 8)] },
    { coin: 'AVAX',  venues: [r('BybitPerp', 0.0003, 120, 4)] },
    { coin: 'SUI',   venues: [r('BybitPerp', 0.0004, 240, 8)] },
    { coin: 'PEPE',  venues: [r('BybitPerp', 0.00025, 240, 8)] },
    { coin: 'EIGEN', venues: [r('BybitPerp', 0.0001, 120, 4)] },
  ],
  BITGET: [
    { coin: 'BTC',  venues: [r('BitgetPerp', 0.0001, 240, 8)] },
    { coin: 'DOGE', venues: [r('BitgetPerp', 0.0004, 240, 8)] },
    { coin: 'SUI',  venues: [r('BitgetPerp', 0.0002, 240, 8)] },
    { coin: 'LINK', venues: [r('BitgetPerp', 0.0001, 240, 8)] },
  ],
};

const asset = (coin: string, notionalOI_usd: number, volume24h_usd: number, oiIsProxy?: boolean): ExchangeAsset =>
  (oiIsProxy ? { coin, notionalOI_usd, volume24h_usd, oiIsProxy } : { coin, notionalOI_usd, volume24h_usd }) as ExchangeAsset;
const COINS = ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'LINK', 'AVAX', 'SUI', 'WIF', 'PEPE', 'TIA', 'THIN', 'ARB', 'OP', 'EIGEN'];

/** Each venue's universe. OKX throws (see `universeFor`); KUCOIN reads empty. */
const UNIVERSE: Partial<Record<ExchangeId, ExchangeAsset[]>> = {
  HL:      COINS.map((c) => asset(c, c === 'THIN' ? 6e6 : 50e6, 10e6)),
  BINANCE: COINS.map((c) => asset(c, c === 'THIN' ? 1e6 : 100e6, c === 'THIN' ? 1e6 : 100e6, true)), // THIN below the floor here
  BYBIT:   COINS.map((c) => asset(c, 80e6, 20e6)),
  GATE:    COINS.map((c) => asset(c, 30e6, 5e6)),
  KUCOIN:  [],
  ASTER:   COINS.map((c) => asset(c, 1, 40e6, true)),                                       // volume proxy: OI is not the liquidity
  BITGET:  COINS.map((c) => asset(c, 60e6, 15e6)),
};

const HISTORY: Record<string, { time: number; fundingRate: number }[]> = {
  DOGE: Array.from({ length: 24 }, (_, i) => ({ time: GOLDEN_NOW - (24 - i) * HR, fundingRate: 0.0006 + (i % 3) * 0.0001 })),
  LINK: Array.from({ length: 24 }, (_, i) => ({ time: GOLDEN_NOW - (24 - i) * HR, fundingRate: (i % 2 ? 1 : -1) * 0.00003 })),
  BTC:  Array.from({ length: 12 }, (_, i) => ({ time: GOLDEN_NOW - (12 - i) * HR, fundingRate: 0.0000125 })),
};

function adapterFor(id: ExchangeId): ExchangeAdapter {
  return {
    getName: () => `golden-${id}`,
    getCandles: vi.fn(async () => []),
    getAssetContext: vi.fn(async () => { throw new Error('not used'); }),
    getPredictedFundings: vi.fn(async () => {
      if (id === 'KUCOIN') throw new Error('kucoin feed down');
      const feed = FEEDS[id];
      if (!feed) throw new Error(`no golden feed for ${id}`);
      return structuredClone(feed);
    }),
    getFundingHistory: vi.fn(async (coin: string) => {
      if (id !== 'HL') throw new Error('history is read from HL only');
      if (coin === 'WIF') throw new Error('history down');
      return structuredClone(HISTORY[coin] ?? []);
    }),
    getCurrentPrice: vi.fn(async () => null),
  } as unknown as ExchangeAdapter;
}

async function universeFor(id: ExchangeId): Promise<ExchangeAsset[]> {
  if (id === 'OKX') throw new Error('okx universe down');
  return structuredClone(UNIVERSE[id] ?? []);
}

/** Wire form with the release-owned values replaced by their placeholders. */
function placeholderize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, v) => {
    if (key === '_algovault' && v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.version === PKG_VERSION) o.version = '__PKG_VERSION__';
      if (JSON.stringify(o.compatible_with) === JSON.stringify(compatibleWith())) o.compatible_with = '__COMPATIBLE_WITH__';
    }
    return v;
  });
}

const INTERNAL: LicenseInfo = { tier: 'internal', key: null, outcome: 'RESOLVED' } as LicenseInfo;
const KEYLESS: LicenseInfo = { tier: 'free', key: null, outcome: 'ABSENT' } as LicenseInfo;

/** Every capture the golden pins, in one object (key order is part of the pin). */
async function captureGolden(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  _resetCallTrackersForTest(); resetLicenseCache(); _resetScanFundingArbCaches(); _setLiquidityMapForTest(null);
  out.wideInternal = await scanFundingArb({ minSpreadBps: 0.1, limit: 50, license: INTERNAL });

  _resetCallTrackersForTest(); resetLicenseCache(); _resetScanFundingArbCaches(); _setLiquidityMapForTest(null);
  out.defaultKeyless = await scanFundingArb({ license: KEYLESS });

  _setLiquidityMapForTest(null);
  out.floorBinance = await applyLiquidityFloor('BINANCE', ['BTC', 'THIN', 'NOPE', 'ETH'], 5_000_000);
  out.floorAster = await applyLiquidityFloor('ASTER', ['BTC', 'NOPE'], 5_000_000);
  out.floorOkxThrows = await applyLiquidityFloor('OKX', ['BTC', 'ETH'], 1);
  out.floorKucoinEmpty = await applyLiquidityFloor('KUCOIN', ['BTC'], 1);

  return placeholderize(out) as Record<string, unknown>;
}

function readGolden(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(GOLDEN_NOW));
  vi.mocked(getAdapter).mockImplementation((id: ExchangeId) => adapterFor(id));
  vi.mocked(fetchVenueUniverse).mockImplementation(universeFor as typeof fetchVenueUniverse);
  _setCarryScoresForTest(null); // carry ordering OFF: no fresh scores → legacy order
});
afterEach(() => {
  _setCarryScoresForTest(undefined);
  vi.useRealTimers();
});

describe('DECISION-CALL-V1-W1 R1 — scan_funding_arb golden', () => {
  it('the scan, the per-leg liquidity map and the scan-shared floor are byte-identical to the recording', async () => {
    const actual = await captureGolden();
    const expected = existsSync(FIXTURE) ? readGolden(FIXTURE) : null;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const dump = join(tmpdir(), 'scan-funding-arb-golden.actual.json');
      writeFileSync(dump, `${JSON.stringify(actual, null, 2)}\n`);
      console.error(`[golden] mismatch — actual written to ${dump}`);
    }
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected)); // key ORDER included — byte-identical on the wire
  });

  it('the recording is non-vacuous: it holds opportunities on ≥ 5 venue-strings and both floor outcomes', () => {
    const g = readGolden(FIXTURE) as { wideInternal: { opportunities: { rates: Record<string, number> }[]; scannedPairs: number }; floorBinance: string[]; floorOkxThrows: string[] };
    const legs = new Set(g.wideInternal.opportunities.flatMap((o) => Object.keys(o.rates)));
    expect(g.wideInternal.opportunities.length).toBeGreaterThanOrEqual(8);
    expect(legs.size).toBeGreaterThanOrEqual(5);
    expect(g.wideInternal.scannedPairs).toBeGreaterThanOrEqual(12);
    expect(g.floorBinance.length).toBeGreaterThan(0);
    expect(g.floorOkxThrows).toEqual([]);
  });
});
