/**
 * regime-core-parity.test.ts — SCAN-MARKET-REGIMES-W1-V2 CH1 (AC1.1, single derivation)
 *
 * The byte-identity oracle for the `market-regime-core.ts` extraction.
 *
 * `tests/fixtures/regime-core-parity-inputs.json` freezes REAL Binance windows — the exact
 * `adapter.getCandles(coin, tf, nowMs - CANDLE_COUNTS[tf] * interval)` calls `get_market_regime`
 * makes — for 3 crypto + 4 TradFi coins × {1h, 4h, 1d}, captured live at one `nowMs` (P2, CH1
 * step 0). `tests/fixtures/regime-core-parity-golden.json` was recorded from UNMODIFIED
 * `get-market-regime.ts` (21db1c1e) with `UPDATE_GOLDEN=1`, under BOTH candle bases. Every later
 * change deep-equals against it. The one normalized field is `_algovault.version`, as in
 * `candle-basis-regime-golden.test.ts`.
 *
 * The second half pins the snapshot sampler to the SAME derivation: the pure core, fed the same
 * candles, must reproduce every non-funding field the tool emits. A sampler row and a
 * `get_market_regime` response can then never disagree about one closed bar.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../src/lib/exchange-adapter.js', () => ({ getAdapter: vi.fn() }));
vi.mock('../../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordFunding: vi.fn(),
  recordHoldCount: vi.fn(),
  getFundingZScore: vi.fn().mockReturnValue(null),
  isShortLivedScript: () => false,
  dbQuery: vi.fn().mockResolvedValue([]),
  dbExec: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/lib/tradfi-funding.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/lib/tradfi-funding.js')>();
  return { ...actual, fetchTradFiFundingByVenue: vi.fn() };
});

import { getMarketRegime } from '../../src/tools/get-market-regime.js';
import { computeMarketRegimeCore, regimeFetchWindow, MARKET_REGIME_RULE_VERSION } from '../../src/lib/market-regime-core.js';
import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { fetchTradFiFundingByVenue } from '../../src/lib/tradfi-funding.js';
import { resetLicenseCache } from '../../src/lib/license.js';
import { _clearUnderlyingTypeCache, _setUnderlyingTypeFetcherForTest, type UnderlyingTypeEntry } from '../../src/lib/underlying-type.js';
import type { Candle, ExchangeAdapter, FundingData, MarketRegimeResult } from '../../src/types.js';
import type { VenueFunding } from '../../src/lib/tradfi-funding.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const INPUTS_PATH = join(HERE, '..', 'fixtures', 'regime-core-parity-inputs.json');
const GOLDEN_PATH = join(HERE, '..', 'fixtures', 'regime-core-parity-golden.json');

interface FixtureWindow { coin: string; timeframe: string; startTime: number; bars: number[][] }
interface Fixture {
  nowMs: number;
  exchange: 'BINANCE';
  exchangeInfo: Record<string, UnderlyingTypeEntry>;
  windows: FixtureWindow[];
  predictedFundings: FundingData[];
  tradfiFunding: Record<string, VenueFunding[]>;
}

const FIXTURE = JSON.parse(readFileSync(INPUTS_PATH, 'utf8')) as Fixture;
const BASES = ['closed', 'live'] as const;

const toCandles = (bars: number[][]): Candle[] =>
  bars.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));

function windowFor(coin: string, timeframe: string): FixtureWindow {
  const w = FIXTURE.windows.find((x) => x.coin === coin && x.timeframe === timeframe);
  if (!w) throw new Error(`fixture has no window for ${coin}/${timeframe}`);
  return w;
}

/** A fresh copy per call — the tool sorts its input in place. */
function venueAdapter(): ExchangeAdapter {
  return {
    getName: () => 'Binance',
    getCandles: vi.fn(async (coin: string, timeframe: string, startTime: number) => {
      const w = windowFor(coin, timeframe);
      // The window is part of the oracle: a refactor that moves `startTime` is a different call.
      if (startTime !== w.startTime) throw new Error(`startTime drift for ${coin}/${timeframe}: ${startTime} != ${w.startTime}`);
      return toCandles(w.bars);
    }),
    getAssetContext: vi.fn().mockResolvedValue(null),
    getPredictedFundings: vi.fn().mockResolvedValue([]),
    getFundingHistory: vi.fn().mockResolvedValue([]),
    getCurrentPrice: vi.fn().mockResolvedValue(null),
  } as unknown as ExchangeAdapter;
}

function hlAdapter(): ExchangeAdapter {
  return {
    getName: () => 'Hyperliquid',
    getCandles: vi.fn().mockRejectedValue(new Error('HL candles are never part of this oracle')),
    getAssetContext: vi.fn().mockResolvedValue(null),
    getPredictedFundings: vi.fn(async () => JSON.parse(JSON.stringify(FIXTURE.predictedFundings))),
    getFundingHistory: vi.fn().mockResolvedValue([]),
    getCurrentPrice: vi.fn().mockResolvedValue(null),
  } as unknown as ExchangeAdapter;
}

function normalize(envelope: MarketRegimeResult): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
  const meta = clone._algovault as Record<string, unknown> | undefined;
  if (meta && 'version' in meta) meta.version = '<PKG_VERSION>';
  return clone;
}

/** Envelope or the refusal's class + message: both are the tool's observable output. */
async function runCase(coin: string, timeframe: string): Promise<Record<string, unknown>> {
  resetLicenseCache();
  _clearUnderlyingTypeCache();
  _setUnderlyingTypeFetcherForTest(async () => new Map(Object.entries(FIXTURE.exchangeInfo)));
  vi.mocked(getAdapter).mockImplementation(((id: string) => (id === 'HL' ? hlAdapter() : venueAdapter())) as typeof getAdapter);
  vi.mocked(fetchTradFiFundingByVenue).mockImplementation(async (c: string) =>
    JSON.parse(JSON.stringify(FIXTURE.tradfiFunding[c.toUpperCase()] ?? [])),
  );
  try {
    const r = await getMarketRegime({ coin, timeframe, exchange: FIXTURE.exchange, license: { tier: 'internal', key: null } });
    return { ok: normalize(r) };
  } catch (e) {
    return { error: { name: (e as Error).name, message: (e as Error).message } };
  }
}

const CASES = FIXTURE.windows.map((w) => ({ coin: w.coin, timeframe: w.timeframe }));
const caseKey = (basis: string, coin: string, tf: string) => `${basis}|${coin}|${tf}`;

describe('CH1 AC1.1 — get_market_regime is byte-identical across the core extraction (P2 oracle)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FIXTURE.nowMs);
    vi.clearAllMocks();
    delete process.env.CANDLE_BASIS;
  });
  afterEach(() => {
    vi.useRealTimers();
    _setUnderlyingTypeFetcherForTest(null);
    _clearUnderlyingTypeCache();
    delete process.env.CANDLE_BASIS;
  });

  it('the fixture is non-vacuous: 3 crypto + 4 TradFi coins × 3 timeframes, real windows', () => {
    const coins = new Set(FIXTURE.windows.map((w) => w.coin));
    expect(coins.size).toBeGreaterThanOrEqual(6);
    for (const tf of ['1h', '4h', '1d']) expect(FIXTURE.windows.filter((w) => w.timeframe === tf).length).toBe(coins.size);
    for (const w of FIXTURE.windows) expect(w.bars.length).toBeGreaterThanOrEqual(30);
    const classes = new Set(Object.values(FIXTURE.exchangeInfo).map((e) => e.underlyingType));
    for (const c of ['COIN', 'EQUITY', 'COMMODITY', 'KR_EQUITY']) expect(classes.has(c)).toBe(true);
  });

  it('matches the golden recorded from unmodified code, under both candle bases', async () => {
    const actual: Record<string, unknown> = {};
    for (const basis of BASES) {
      for (const { coin, timeframe } of CASES) {
        if (basis === 'closed') process.env.CANDLE_BASIS = 'closed';
        else delete process.env.CANDLE_BASIS;
        actual[caseKey(basis, coin, timeframe)] = await runCase(coin, timeframe);
      }
    }
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN_PATH, JSON.stringify(actual, null, 1) + '\n');
    expect(existsSync(GOLDEN_PATH), `golden missing at ${GOLDEN_PATH} — record from UNMODIFIED code with UPDATE_GOLDEN=1`).toBe(true);
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
    for (const k of Object.keys(golden)) {
      expect(actual[k], k).toEqual(golden[k]);
      // Byte-identity includes KEY ORDER, which toEqual ignores: the envelope is serialized as-is.
      expect(JSON.stringify(actual[k]), `${k} key order`).toBe(JSON.stringify(golden[k]));
    }
  });

  it('the golden exercises every regime-relevant branch it claims to', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, { ok?: MarketRegimeResult }>;
    const ok = Object.values(golden).filter((v) => v.ok).map((v) => v.ok!);
    expect(ok.length).toBe(Object.keys(golden).length); // no refusal hides a case
    const sessions = new Set(ok.map((r) => r.metrics.underlying_session));
    expect(sessions.size).toBeGreaterThan(1); // crypto 24/7 + at least one TradFi session state
    const sentiments = new Set(ok.map((r) => r.metrics.cross_venue_funding_sentiment));
    expect(sentiments.size).toBeGreaterThan(1);
    expect(new Set(ok.map((r) => r.regime)).size).toBeGreaterThan(1);
  });
});

describe('CH1 — the sampler path IS the tool path (single derivation)', () => {
  const NINE = ['adx', 'adx_interpretation', 'adx_slope', 'adx_slope_interpretation', 'volatility_ratio',
    'volatility_interpretation', 'price_structure', 'pivot_quality', 'trend_strength'] as const;

  it('the core, fed the same frozen window, reproduces every non-funding field of the golden envelope', () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<string, { ok?: MarketRegimeResult }>;
    let compared = 0;
    for (const basis of BASES) {
      for (const { coin, timeframe } of CASES) {
        const env = golden[caseKey(basis, coin, timeframe)].ok!;
        const win = regimeFetchWindow(timeframe, FIXTURE.nowMs);
        expect(win.startTime).toBe(windowFor(coin, timeframe).startTime);
        const core = computeMarketRegimeCore({
          coin, exchange: FIXTURE.exchange, timeframe, candles: toCandles(windowFor(coin, timeframe).bars),
          intervalMs: win.intervalMs, startTime: win.startTime, nowMs: FIXTURE.nowMs, candleBasis: basis,
        });
        expect(core.regime, `${basis}|${coin}|${timeframe}`).toBe(env.regime);
        expect(core.confidence, `${basis}|${coin}|${timeframe}`).toBe(env.confidence);
        const envNine = Object.fromEntries(NINE.map((k) => [k, (env.metrics as unknown as Record<string, unknown>)[k]]));
        expect(JSON.stringify(core.metrics), `${basis}|${coin}|${timeframe}`).toBe(JSON.stringify(envNine));
        compared++;
      }
    }
    expect(compared).toBe(BASES.length * CASES.length);
  });

  it('lastEmittedBarCloseMs is the close of the newest CLOSED bar under the closed basis', () => {
    for (const { coin, timeframe } of CASES) {
      const win = regimeFetchWindow(timeframe, FIXTURE.nowMs);
      const candles = toCandles(windowFor(coin, timeframe).bars);
      const core = computeMarketRegimeCore({
        coin, exchange: FIXTURE.exchange, timeframe, candles, intervalMs: win.intervalMs,
        startTime: win.startTime, nowMs: FIXTURE.nowMs, candleBasis: 'closed',
      });
      const closeMs = core.lastEmittedBarCloseMs!;
      expect(closeMs % win.intervalMs === 0 || timeframe === '1d').toBe(true);
      expect(closeMs).toBeLessThanOrEqual(FIXTURE.nowMs + 2000);
      expect(closeMs + win.intervalMs).toBeGreaterThan(FIXTURE.nowMs); // the NEWEST closed bar, not an older one
    }
  });

  it('versions separately from the scan_trade_calls classifier', () => {
    expect(MARKET_REGIME_RULE_VERSION).toBe(1);
  });
});
