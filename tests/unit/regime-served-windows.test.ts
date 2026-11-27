/**
 * regime-served-windows.test.ts — REGIME-15M-SERVE-W1 CH1 (T1).
 *
 * get_market_regime serves 15m from live 15m candles, with 1h, 4h and 1d byte-identical. The windows the tool
 * serves come from a registry of their own (`src/lib/regime-served-windows.ts`, data only), because the files
 * that declare the pinned windows (`serving-windows.ts`, `market-regime-core.ts`) are sha256-pinned by T9's
 * registration and stay call-only. The fetch (`src/lib/regime-served-fetch.ts`) DELEGATES to the pinned
 * `regimeFetchWindow` for every timeframe it declares, so 1h, 4h and 1d are identical by construction; 15m is the
 * same formula on `intervalMsFor('15m')` and 100 bars.
 *
 * Sections: the registry · the fetch · the 15m window is a span contract-suite S already serves · every channel's
 * admission (zod via the declaration, the pipeline row, the x402 Bazaar schema + AJV) · the tool asks every
 * promoted venue for exactly that window · a paid x402 15m call that errors is never settled.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CANDLE_COUNTS, servingSpans } from '../../src/lib/serving-windows.js';
import { intervalMsFor } from '../../src/lib/candle-guard.js';
import { regimeFetchWindow } from '../../src/lib/market-regime-core.js';
import { REGIME_SERVED_WINDOWS, REGIME_SERVED_TIMEFRAMES } from '../../src/lib/regime-served-windows.js';
import { regimeServedFetchWindow } from '../../src/lib/regime-served-fetch.js';
import { REGIME_TIMEFRAMES, REGIME_TIMEFRAME_DEFAULT, PUBLIC_TOOL_ENUM_PARAMS, PUBLIC_VENUE_IDS } from '../../src/lib/tool-param-schema.js';
import { BAZAAR_ROUTES } from '../../src/lib/x402-bazaar.js';
import { validateToolInput } from '../../src/lib/x402-http-routes.js';
import type { Candle, ExchangeAdapter } from '../../src/types.js';

const MIN15 = 900_000;
/** Several instants: the epoch, a real capture clock (the parity fixture's), a non-aligned ms, a far future. */
const NOWS = [0, 1_792_400_836_667, 1_792_400_836_667 + 123_457, 4_102_444_800_001];

// ─────────────────────────────── the registry ───────────────────────────────

describe('REGIME_SERVED_WINDOWS — CANDLE_COUNTS plus 15m at 100 bars, ordered by duration', () => {
  it('holds every CANDLE_COUNTS entry, value for value, and 15m at 100 — nothing else', () => {
    for (const [tf, bars] of Object.entries(CANDLE_COUNTS)) expect(REGIME_SERVED_WINDOWS[tf], tf).toBe(bars);
    expect(REGIME_SERVED_WINDOWS['15m']).toBe(100);
    expect(Object.keys(REGIME_SERVED_WINDOWS).sort()).toEqual([...Object.keys(CANDLE_COUNTS), '15m'].sort());
  });

  it('is ordered by bar duration, finest first', () => {
    const ms = Object.keys(REGIME_SERVED_WINDOWS).map((tf) => intervalMsFor(tf));
    for (const m of ms) expect(m).not.toBeNull();
    expect(ms).toEqual([...ms].sort((a, b) => a! - b!));
  });

  it('is frozen; lookups are own keys only', () => {
    expect(Object.isFrozen(REGIME_SERVED_WINDOWS)).toBe(true);
    expect(Object.isFrozen(REGIME_SERVED_TIMEFRAMES)).toBe(true);
    expect(Object.hasOwn(REGIME_SERVED_WINDOWS, 'constructor')).toBe(false);
  });

  it('REGIME_SERVED_TIMEFRAMES is its keys, and get_market_regime\'s REGIME_TIMEFRAMES IS that array', () => {
    expect([...REGIME_SERVED_TIMEFRAMES]).toEqual(Object.keys(REGIME_SERVED_WINDOWS));
    expect(REGIME_TIMEFRAMES).toBe(REGIME_SERVED_TIMEFRAMES);
    expect([...REGIME_TIMEFRAMES]).toEqual(['15m', '1h', '4h', '1d']);
    expect(REGIME_TIMEFRAMES).toContain(REGIME_TIMEFRAME_DEFAULT);
  });
});

// ─────────────────────────────── the fetch ───────────────────────────────

describe('regimeServedFetchWindow — the pinned window for 1h/4h/1d, the same formula for 15m', () => {
  it('deep-equals regimeFetchWindow for every timeframe regimeFetchWindow declares, at several instants', () => {
    expect(Object.keys(CANDLE_COUNTS)).toEqual(['1h', '4h', '1d']);
    for (const tf of Object.keys(CANDLE_COUNTS)) {
      for (const now of NOWS) expect(regimeServedFetchWindow(tf, now), `${tf}@${now}`).toEqual(regimeFetchWindow(tf, now));
    }
  });

  it('15m: 100 bars of 15 minutes back from now', () => {
    for (const now of NOWS) {
      expect(regimeServedFetchWindow('15m', now)).toEqual({ candleCount: 100, intervalMs: MIN15, startTime: now - 100 * MIN15 });
    }
  });

  it('every other value throws exactly as regimeFetchWindow does', () => {
    for (const tf of ['2h', '30m', '5m', '7h', 'constructor', 'toString', '']) {
      let expected = '';
      try { regimeFetchWindow(tf, NOWS[1]); } catch (e) { expected = (e as Error).message; }
      expect(expected, tf).toMatch(/has no declared market_regime serving window/);
      expect(() => regimeServedFetchWindow(tf, NOWS[1]), tf).toThrow(expected);
    }
  });
});

// ─────────────────────────────── the span contract-suite S already covers ───────────────────────────────

describe('the 15m window spans exactly a window the product already serves (trade_call 15m @ 100)', () => {
  it('servingSpans(15m) holds a span equal to the regime 15m span, and it is trade_call@100\'s', () => {
    const step = intervalMsFor('15m')!;
    const regimeSpan = REGIME_SERVED_WINDOWS['15m'] * step;
    const hit = servingSpans('15m', null, step).find((s) => s.spanMs === regimeSpan);
    expect(hit, 'no served 15m span equals the regime window — contract suite S does not cover it').toBeDefined();
    expect(hit!.label.split('+')).toContain('trade_call@100');
  });
});

// ─────────────────────────────── admission on every channel ───────────────────────────────

describe('every channel admits 15m for get_market_regime', () => {
  it('the declaration the zod enum and the docs row project from', () => {
    expect(PUBLIC_TOOL_ENUM_PARAMS.get_market_regime.timeframe.values).toBe(REGIME_TIMEFRAMES);
  });

  // The pipeline admission row is proved behaviourally below: a 15m call through callTool reaches the tool ('ok'),
  // where a timeframe outside the row is refused before dispatch ('refused').

  it('the x402 Bazaar declared schema projects REGIME_TIMEFRAMES', () => {
    const tf = (BAZAAR_ROUTES.get_market_regime.inputSchema as { properties: { timeframe: { enum: string[] } } }).properties.timeframe;
    expect(tf.enum).toEqual([...REGIME_TIMEFRAMES]);
  });

  it('the x402 HTTP twin\'s AJV validator admits 15m and still refuses an unserved timeframe', () => {
    expect(validateToolInput('get_market_regime', { coin: 'BTC', timeframe: '15m', exchange: 'BINANCE' }, { 'content-type': 'application/json' }).ok).toBe(true);
    const r = validateToolInput('get_market_regime', { coin: 'BTC', timeframe: '2h' }, { 'content-type': 'application/json' });
    expect(r.ok).toBe(false);
    const rej = (r as { rejection: { errors: Array<{ keyword: string; instancePath: string; params: { allowedValues?: string[] } }> } }).rejection;
    expect(rej.errors.find((x) => x.keyword === 'enum' && x.instancePath === '/timeframe')?.params.allowedValues).toEqual(['15m', '1h', '4h', '1d']);
  });
});

// ─────────────────────────────── the tool asks every promoted venue for exactly that window ───────────────────────────────

describe('getMarketRegime(15m) fetches 100 × 15m on every promoted venue and answers timeframe 15m', () => {
  const NOW = 1_792_400_836_667;
  const MOCKED = ['../../src/lib/exchange-adapter.js', '../../src/lib/performance-db.js', '../../src/lib/tradfi-funding.js'];

  /** 101 ascending 15m bars, the newest in progress at NOW, on a gentle uptrend (a real classifier input). */
  const bars = (): Candle[] => {
    const newest = Math.floor(NOW / MIN15) * MIN15;
    return Array.from({ length: 101 }, (_, i) => {
      const c = 100 + i * 0.3 + Math.sin(i / 3);
      return { time: newest - (100 - i) * MIN15, open: c - 0.2, high: c + 0.6, low: c - 0.6, close: c, volume: 10 + i };
    });
  };

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const m of MOCKED) vi.doUnmock(m);
    vi.resetModules();
  });

  it('one call per promoted venue: getCandles(coin, 15m, NOW − 100 × 15m), envelope timeframe 15m', async () => {
    const calls: Array<{ venue: string; tf: string; startTime: number }> = [];
    const adapter = (venue: string): ExchangeAdapter => ({
      getName: () => venue,
      getCandles: vi.fn(async (_coin: string, tf: string, startTime: number) => { calls.push({ venue, tf, startTime }); return bars(); }),
      getAssetContext: vi.fn().mockResolvedValue(null),
      getPredictedFundings: vi.fn().mockResolvedValue([]),
      getFundingHistory: vi.fn().mockResolvedValue([]),
      getCurrentPrice: vi.fn().mockResolvedValue(null),
    }) as unknown as ExchangeAdapter;
    vi.doMock('../../src/lib/exchange-adapter.js', () => ({ getAdapter: (id: string) => adapter(id) }));
    vi.doMock('../../src/lib/performance-db.js', () => ({
      recordSignal: vi.fn(), recordFunding: vi.fn(), recordHoldCount: vi.fn(), getFundingZScore: vi.fn().mockReturnValue(null),
      isShortLivedScript: () => false, dbQuery: vi.fn().mockResolvedValue([]), dbExec: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../../src/lib/tradfi-funding.js', async (orig) => ({
      ...(await orig<typeof import('../../src/lib/tradfi-funding.js')>()),
      fetchTradFiFundingByVenue: vi.fn().mockResolvedValue([]),
    }));
    const { getMarketRegime } = await import('../../src/tools/get-market-regime.js');
    const { _loadVenueRecordsForTest } = await import('../../src/lib/asset-class-detection.js');
    expect(PUBLIC_VENUE_IDS.length).toBe(15);
    for (const venue of PUBLIC_VENUE_IDS) {
      _loadVenueRecordsForTest({ [venue]: [['BTCUSDT', 'PERPETUAL'], ['BTC', 'PERPETUAL']] } as never);
      const r = await getMarketRegime({ coin: 'BTC', timeframe: '15m', exchange: venue, license: { tier: 'internal', key: null } as never });
      expect(r.timeframe, venue).toBe('15m');
      expect(typeof r.regime, venue).toBe('string');
    }
    const venueCalls = calls.filter((c) => c.tf === '15m');
    expect(venueCalls.map((c) => c.venue).sort()).toEqual([...PUBLIC_VENUE_IDS].sort());
    for (const c of venueCalls) expect(c.startTime, c.venue).toBe(NOW - 100 * MIN15);
  });
});

// ─────────────────────────────── x402: a paid 15m call that errors is never settled ───────────────────────────────

describe('x402 — a 15m get_market_regime call that errors is stamped unserved, so the claim never settles', () => {
  const MOCKED = ['../../src/tools/get-market-regime.js', '../../src/lib/analytics.js'];
  const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATABASE_URL: process.env.DATABASE_URL };
  let regime: () => unknown = () => ({ regime: 'RANGING', confidence: 50, coin: 'BTC' });
  let home = '';

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cqs-r15-settle-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    vi.resetModules();
    regime = () => ({ regime: 'RANGING', confidence: 50, coin: 'BTC' });
    vi.doMock('../../src/tools/get-market-regime.js', async (orig) => ({
      ...(await orig<typeof import('../../src/tools/get-market-regime.js')>()),
      getMarketRegime: async () => regime(),
    }));
    vi.doMock('../../src/lib/analytics.js', async (orig) => ({
      ...(await orig<typeof import('../../src/lib/analytics.js')>()),
      logRequest: () => {},
    }));
  });
  afterEach(async () => {
    for (const m of MOCKED) vi.doUnmock(m);
    const { closeDb } = await import('../../src/lib/performance-db.js');
    closeDb();
    vi.resetModules();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    for (const [k, v] of Object.entries(ORIG)) {
      if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else (process.env as Record<string, string | undefined>)[k] = v;
    }
  });

  /** One `callTool` inside a request context — the shape the /mcp POST layer and the x402 route read after dispatch. */
  async function stamped(timeframe: string): Promise<string | undefined> {
    const { requestContext, getRequestToolOutcome } = await import('../../src/lib/license.js');
    const { callTool } = await import('../../src/lib/tool-call-pipeline.js');
    const INTERNAL = { tier: 'internal', key: null, outcome: 'RESOLVED' } as const;
    return requestContext.run({ license: INTERNAL } as never, async () => {
      await callTool({ tool: 'get_market_regime', input: { coin: 'BTC', timeframe, exchange: 'BINANCE' } as never, license: INTERNAL as never, channel: 'httpX402' });
      return getRequestToolOutcome();
    });
  }

  it('15m reaches the tool (admitted, not refused); served → settle', async () => {
    const { x402SettlementAction } = await import('../../src/lib/x402.js');
    const out = await stamped('15m');
    expect(out).toBe('ok');
    expect(x402SettlementAction(out as never)).toBe('settle');
  });

  it('15m that throws → threw → unserved (the claim-after-success order: no settle)', async () => {
    regime = () => { throw new Error('upstream down'); };
    const { x402SettlementAction } = await import('../../src/lib/x402.js');
    const out = await stamped('15m');
    expect(out).toBe('threw');
    expect(x402SettlementAction(out as never)).toBe('unserved');
  });
});
