/**
 * venue-market-closed.test.ts — OPS-VENUE-MARKET-CLOSED-W1 CH1: a market its venue's own status declares closed is
 * refused, typed, at the `getAdapter` seam (src/lib/exchange-adapter.ts guardClosedMarkets) before any request.
 *
 *   1. The declaration and the pure verdict (src/lib/universe-admission.ts): the declaring venues are exactly {BINGX},
 *      and `closedMarketVerdict` refuses only status 25 under enforce within the circuit.
 *   2. The seam on the real BingX adapter over a mocked transport (AC1.1): status 25 is refused with 0 market-data
 *      requests and one `/contracts` fetch shared by parallel reads; status 1 is byte-identical to the unguarded
 *      adapter; status 0 / 5, an open circuit, mode=legacy, an unavailable or throwing reader, an absent symbol and an
 *      unserved timeframe all go straight through.
 *   3. The in-band closure (AC1.2): 109415 is typed and memoized, so the next read makes 0 requests until the TTL.
 *   4. The canary still matches the suffixed Blocking line the producer now prints (AC1.3).
 *   5. get_trade_call on a closed market (AC1.5): VENUE_MARKET_CLOSED, never billed, never recorded; the MCP payload.
 * Each refusal is paired with the open control that proves the same path serves an open market.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ── the mocked transport: BingX quote endpoints, counted by kind ────────────────────────────────────────────────
const { world, calls } = vi.hoisted(() => ({
  world: {
    /** symbol → status, as `/openApi/swap/v2/quote/contracts` serves it. */
    statuses: new Map<string, number>(),
    contractsFail: false,
    /** A body code every market-data endpoint answers with (in-band refusal), or null for a served answer. */
    marketCode: null as number | null,
  },
  calls: { contracts: 0, market: [] as string[] },
}));

vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
  upstreamFetch: vi.fn(async (_cfg: unknown, req: { url: string }) => {
    const u = new URL(req.url);
    if (u.hostname !== 'open-api.bingx.com') throw new Error(`unmocked upstream ${req.url}`);
    if (u.pathname === '/openApi/swap/v2/quote/contracts') {
      calls.contracts++;
      if (world.contractsFail) throw new Error('BingX API 503: Service Unavailable');
      return { code: 0, msg: '', data: [...world.statuses].map(([symbol, status]) => ({ symbol, status, currency: 'USDT' })) };
    }
    calls.market.push(u.pathname);
    const symbol = u.searchParams.get('symbol') ?? '';
    if (world.marketCode !== null) {
      return { code: world.marketCode, msg: `${symbol} is pause currently, all validted symbols in api:/openApi/swap/v2/quote/contracts`, data: {} };
    }
    if (u.pathname === '/openApi/swap/v2/quote/klines') {
      const step = 3_600_000;
      const forming = Math.floor(Date.now() / step) * step;
      return { code: 0, msg: '', data: Array.from({ length: 120 }, (_, i) => ({ open: '10', high: '11', low: '9', close: '10.5', volume: '100', time: forming - i * step })) };
    }
    if (u.pathname === '/openApi/swap/v2/quote/premiumIndex') {
      return { code: 0, msg: '', data: { symbol, markPrice: '10.5', indexPrice: '10.4', lastFundingRate: '0.0001', nextFundingTime: 0, fundingIntervalHours: 8 } };
    }
    if (u.pathname === '/openApi/swap/v2/quote/openInterest') return { code: 0, msg: '', data: { openInterest: '1000', symbol, time: Date.now() } };
    if (u.pathname === '/openApi/swap/v2/quote/ticker') {
      return { code: 0, msg: '', data: { symbol, lastPrice: '10.5', openPrice: '10', quoteVolume: '5000000', volume: '1000' } };
    }
    throw new Error(`unmocked BingX path ${u.pathname}`);
  }),
}));

// The ONE status reader, spied through, so a test can make it throw (its contract says it never does).
vi.mock('../../src/lib/exchange-universe.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/exchange-universe.js')>();
  return { ...m, venueStatus: vi.fn(m.venueStatus) };
});

// get_trade_call's store, as tests/unit/serving-window-guard.test.ts mocks it (no SQLite).
vi.mock('../../src/lib/performance-db.js', () => ({
  recordSignal: vi.fn(),
  recordFunding: vi.fn(),
  recordHoldCount: vi.fn(),
  getFundingZScore: vi.fn().mockResolvedValue(null),
  getDb: vi.fn(),
  isShortLivedScript: () => false,
  dbQuery: vi.fn().mockResolvedValue([]),
  dbExec: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/lib/license.js', async (orig) => {
  const m = await orig<typeof import('../../src/lib/license.js')>();
  return { ...m, trackCall: vi.fn(m.trackCall) };
});

import { getAdapter } from '../../src/lib/exchange-adapter.js';
import { BingxAdapter } from '../../src/lib/adapters/bingx.js';
import { venueStatus, _resetAdmissionStatusCacheForTest } from '../../src/lib/exchange-universe.js';
import { ADMISSION_SOURCES, closedMarketVerdict, readRefusalOf } from '../../src/lib/universe-admission.js';
import { VenueMarketClosedError, buildVenueMarketClosedPayload, TimeframeUnservedError } from '../../src/lib/errors.js';
import { toMcpToolResult, type ToolCallOutcome } from '../../src/lib/tool-call-pipeline.js';
import { getTradeSignal } from '../../src/tools/get-trade-call.js';
import { recordSignal, recordHoldCount } from '../../src/lib/performance-db.js';
import { trackCall, resetLicenseCache } from '../../src/lib/license.js';
import type { ExchangeId } from '../../src/types.js';

const COIN = 'NCSKCME2USD';
const SYMBOL = 'NCSKCME2USD-USDT';
const START = () => Date.now() - 100 * 3_600_000;

/** A status map shaped like R0's (status 25 = 236 of 1,309): the coin under test plus open filler. */
function setStatuses(coinStatus: number | null, opts: { offFiller?: number; openFiller?: number } = {}): void {
  world.statuses = new Map();
  if (coinStatus !== null) world.statuses.set(SYMBOL, coinStatus);
  for (let i = 0; i < (opts.openFiller ?? 20); i++) world.statuses.set(`OPEN${i}-USDT`, 1);
  for (let i = 0; i < (opts.offFiller ?? 3); i++) world.statuses.set(`NCOFF${i}-USDT`, 25);
}

beforeEach(() => {
  _resetAdmissionStatusCacheForTest();
  world.contractsFail = false;
  world.marketCode = null;
  calls.contracts = 0;
  calls.market = [];
  delete process.env.UNIVERSE_ADMISSION_MODE;
  vi.mocked(venueStatus).mockClear();
});
afterEach(() => {
  delete process.env.UNIVERSE_ADMISSION_MODE;
});
// getAdapter() caches ONE guarded adapter per venue for the process, so its in-band memo outlives a test: every test
// that can leave a memo entry uses its own coin.

// ── 1. the declaration and the pure verdict ──────────────────────────────────────────────────────────────────────
describe('the declaration', () => {
  it('the declaring venues are exactly {BINGX}, refusing only the measured status and code', () => {
    const declaring = (Object.keys(ADMISSION_SOURCES) as ExchangeId[]).filter((v) => readRefusalOf(v) !== null);
    expect(declaring).toEqual(['BINGX']);
    expect(readRefusalOf('BINGX')).toEqual({ statuses: [25], inBandCodes: [109415] });
  });

  it('the BingX adapter names its market in the status key (venueSymbol = toBingxSymbol)', () => {
    expect(new BingxAdapter().venueSymbol(COIN)).toBe(SYMBOL);
  });
});

describe('closedMarketVerdict (pure)', () => {
  const map = (entries: [string, number][]) => new Map(entries.map(([s, status]) => [s, { status }]));
  const v = (status: Map<string, { status: number }> | null, mode: 'enforce' | 'legacy' = 'enforce', venue: ExchangeId = 'BINGX') =>
    closedMarketVerdict({ venue, symbol: SYMBOL, status, mode, nowMs: Date.now() });

  it('status 25 under enforce within the circuit is closed', () => {
    expect(v(map([[SYMBOL, 25], ['A-USDT', 1], ['B-USDT', 1]]))).toEqual({ closed: true, status: 25 });
  });
  it('status 1, 0 and 5 are open: only the measured status refuses', () => {
    for (const s of [1, 0, 5]) expect(v(map([[SYMBOL, s], ['A-USDT', 1]]))).toEqual({ closed: false, reason: 'open' });
  });
  it('every fail-open condition names itself', () => {
    expect(v(map([[SYMBOL, 25]]), 'legacy')).toEqual({ closed: false, reason: 'mode_legacy' });
    expect(v(null)).toEqual({ closed: false, reason: 'status_unavailable' });
    expect(v(map([['A-USDT', 25]]))).toEqual({ closed: false, reason: 'symbol_absent' });
    expect(v(map([[SYMBOL, 25], ['A-USDT', 25], ['B-USDT', 1]]))).toEqual({ closed: false, reason: 'circuit_open' });
    expect(v(map([[SYMBOL, 25]]), 'enforce', 'BINANCE')).toEqual({ closed: false, reason: 'not_declared' });
  });
  it('the circuit boundary: an off-share AT circuitShare (0.5) still refuses; above it opens', () => {
    expect(v(map([[SYMBOL, 25], ['A-USDT', 1]]))).toEqual({ closed: true, status: 25 });
    expect(v(map([[SYMBOL, 25], ['A-USDT', 25], ['B-USDT', 1], ['C-USDT', 1], ['D-USDT', 25]]))).toEqual({ closed: false, reason: 'circuit_open' });
  });
});

// ── 2. the seam (AC1.1) ──────────────────────────────────────────────────────────────────────────────────────────
describe('the getAdapter seam refuses a closed market with zero market-data requests', () => {
  it('status 25: getCandles and getAssetContext are refused typed, with 0 market-data requests', async () => {
    setStatuses(25);
    const a = getAdapter('BINGX');
    const err = await a.getCandles(COIN, '1h', START()).catch((e) => e);
    expect(err).toBeInstanceOf(VenueMarketClosedError);
    expect(err).toMatchObject({ code: 'VENUE_MARKET_CLOSED', venue: 'BINGX', coin: COIN, symbol: SYMBOL, source: 'status', venueCode: 25 });
    await expect(a.getAssetContext(COIN)).rejects.toBeInstanceOf(VenueMarketClosedError);
    expect(calls.market).toEqual([]);
    expect(calls.contracts).toBe(1);
  });

  it('a HISTORY read (endTime given) is refused too: the PFE backfill reads with an endTime', async () => {
    setStatuses(25);
    const end = Date.now() - 3_600_000;
    await expect(getAdapter('BINGX').getCandles(COIN, '1h', START(), undefined, end)).rejects.toBeInstanceOf(VenueMarketClosedError);
    expect(calls.market).toEqual([]);
  });

  it('two parallel reads share ONE /contracts fetch (single-flight), and the TTL serves the next read', async () => {
    setStatuses(25);
    const a = getAdapter('BINGX');
    const r = await Promise.allSettled([a.getCandles(COIN, '1h', START()), a.getAssetContext(COIN)]);
    expect(r.map((x) => x.status)).toEqual(['rejected', 'rejected']);
    expect(calls.contracts).toBe(1);
    await expect(a.getCandles(COIN, '4h', START())).rejects.toBeInstanceOf(VenueMarketClosedError);
    expect(calls.contracts).toBe(1);
    expect(calls.market).toEqual([]);
  });

  it('status 1: byte-identical to the unguarded adapter (same bars, same context, same market requests)', async () => {
    setStatuses(1);
    const start = START();
    const raw = new BingxAdapter();
    const expectedBars = await raw.getCandles(COIN, '1h', start);
    const expectedCtx = await raw.getAssetContext(COIN);
    const rawCalls = [...calls.market];
    calls.market = [];
    const a = getAdapter('BINGX');
    expect(await a.getCandles(COIN, '1h', start)).toEqual(expectedBars);
    expect(await a.getAssetContext(COIN)).toEqual(expectedCtx);
    expect(calls.market).toEqual(rawCalls);
  });

  it.each([
    ['status 0 (offline, not measured)', () => setStatuses(0)],
    ['status 5 (pre-online, not measured)', () => setStatuses(5)],
    ['an open circuit (more than half the map off)', () => setStatuses(25, { offFiller: 30, openFiller: 5 })],
    ['a symbol the map does not hold', () => setStatuses(null)],
    ['an unavailable status endpoint', () => { setStatuses(25); world.contractsFail = true; }],
  ])('fails open on %s: the read goes ahead as today', async (_why, arrange) => {
    arrange();
    const bars = await getAdapter('BINGX').getCandles(COIN, '1h', START());
    expect(bars.length).toBeGreaterThan(0);
    expect(calls.market).toEqual(['/openApi/swap/v2/quote/klines']);
  });

  it('fails open on mode=legacy, without reading the status at all', async () => {
    setStatuses(25);
    process.env.UNIVERSE_ADMISSION_MODE = 'legacy';
    expect((await getAdapter('BINGX').getCandles(COIN, '1h', START())).length).toBeGreaterThan(0);
    expect(calls.contracts).toBe(0);
    expect(venueStatus).not.toHaveBeenCalled();
  });

  it('fails open on a THROWING reader (the seam\'s own try/catch)', async () => {
    setStatuses(25);
    vi.mocked(venueStatus).mockRejectedValueOnce(new Error('reader broke its contract'));
    expect((await getAdapter('BINGX').getCandles(COIN, '1h', START())).length).toBeGreaterThan(0);
    expect(calls.market).toEqual(['/openApi/swap/v2/quote/klines']);
  });

  it('an unserved timeframe goes straight through: the adapter\'s own local refusal answers first, no status read', async () => {
    setStatuses(25);
    await expect(getAdapter('BINGX').getCandles(COIN, '7m', START())).rejects.toBeInstanceOf(TimeframeUnservedError);
    expect(calls.contracts).toBe(0);
    expect(calls.market).toEqual([]);
  });

  it('an undeclared venue is not wrapped: no status read on its reads', async () => {
    const before = vi.mocked(venueStatus).mock.calls.length;
    await getAdapter('BINANCE').getCandles('BTC', '1h', START()).catch(() => undefined);
    expect(vi.mocked(venueStatus).mock.calls.length).toBe(before);
  });
});

// ── 3. the in-band closure (AC1.2) ───────────────────────────────────────────────────────────────────────────────
describe('an in-band closure is typed and memoized', () => {
  it('109415 on a market the (stale) status calls open ⇒ VenueMarketClosedError in_band; the 2nd read makes 0 requests', async () => {
    setStatuses(1);
    world.statuses.set('NCSKKVUE2USD-USDT', 1);
    world.marketCode = 109415;
    const a = getAdapter('BINGX');
    const err = await a.getCandles('NCSKKVUE2USD', '1h', START()).catch((e) => e);
    expect(err).toBeInstanceOf(VenueMarketClosedError);
    expect(err).toMatchObject({ source: 'in_band', venueCode: 109415, symbol: 'NCSKKVUE2USD-USDT', coin: 'NCSKKVUE2USD' });
    expect(err.message).toContain('is pause currently');
    expect(calls.market).toEqual(['/openApi/swap/v2/quote/klines']);
    const before = { contracts: calls.contracts, market: calls.market.length };
    await expect(a.getCandles('NCSKKVUE2USD', '2h', START())).rejects.toBeInstanceOf(VenueMarketClosedError);
    await expect(a.getAssetContext('NCSKKVUE2USD')).rejects.toBeInstanceOf(VenueMarketClosedError);
    expect({ contracts: calls.contracts, market: calls.market.length }).toEqual(before);
  });

  it('the memo lasts the declared TTL, then the venue is asked again (and serves once it reopened)', async () => {
    setStatuses(1);
    world.statuses.set('NCSKSHEL2USD-USDT', 1);
    world.marketCode = 109415;
    const a = getAdapter('BINGX');
    await expect(a.getCandles('NCSKSHEL2USD', '1h', START())).rejects.toBeInstanceOf(VenueMarketClosedError);
    world.marketCode = null;
    const ttl = (ADMISSION_SOURCES.BINGX as { cacheTtlMs: number }).cacheTtlMs;
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + ttl - 1_000);
    try {
      await expect(a.getCandles('NCSKSHEL2USD', '1h', START())).rejects.toBeInstanceOf(VenueMarketClosedError);
      clock.mockReturnValue(now + ttl + 1);
      expect((await a.getCandles('NCSKSHEL2USD', '1h', START())).length).toBeGreaterThan(0);
    } finally {
      clock.mockRestore();
    }
  });

  it('control: an ordinary non-OK envelope keeps its generic error and is not memoized', async () => {
    setStatuses(1);
    world.marketCode = 100400;
    const a = getAdapter('BINGX');
    const err = await a.getCandles('NCSKBUG2USD', '1h', START()).catch((e) => e);
    expect(err).not.toBeInstanceOf(VenueMarketClosedError);
    expect(String(err.message)).toContain('code=100400');
    world.marketCode = null;
    expect((await a.getCandles('NCSKBUG2USD', '1h', START())).length).toBeGreaterThan(0);
  });
});

// ── 4. the canary still reads the producer's Blocking line (AC1.3) ───────────────────────────────────────────────
describe('outcome-backfill-freshness.py last_failure_line matches the suffixed Blocking line', () => {
  const ROOT = path.resolve(__dirname, '..', '..');
  it('renders the template of the producer and feeds it to the function of the canary', { timeout: 30_000 }, () => {
    const src = readFileSync(path.join(ROOT, 'src/scripts/backfill-outcomes.ts'), 'utf8');
    const m = /console\.log\(`(\[\$\{ts\(\)\}\] Blocking \$\{failKey\}[^`]*)`\)/.exec(src);
    expect(m, 'backfill-outcomes.ts must print the Blocking line from one template').toBeTruthy();
    const err = new VenueMarketClosedError({ venue: 'BINGX', coin: COIN, symbol: SYMBOL, source: 'status', venueCode: 25, venueMessage: null });
    const line = m![1]
      .replace('${ts()}', '2026-10-30T10:14:16.988Z')
      .replace('${failKey}', `BINGX:${COIN}`)
      .replace(/\$\{MAX_FAIL_PER_SYMBOL\}/g, '3')
      .replace('${msg}', err.message);
    expect(line).not.toContain('${');
    expect(line).toContain('(last: NCSKCME2USD on BINGX is paused by the venue');
    const py = [
      'import importlib.util, json, sys',
      `spec = importlib.util.spec_from_file_location("obf", ${JSON.stringify(path.join(ROOT, 'ops/monitoring/outcome-backfill-freshness.py'))})`,
      'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
      'lines = json.loads(sys.stdin.read())',
      'print(json.dumps(m.last_failure_line(lines, "BINGX", "NCSKCME2USD")))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', py], { input: JSON.stringify(['[2026-10-30T10:14:15.000Z] other line', line]), encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([line, true]);
  });
});

// ── 5. get_trade_call on a closed market (AC1.5) ─────────────────────────────────────────────────────────────────
describe('get_trade_call on a closed BINGX market', () => {
  beforeEach(() => {
    vi.mocked(recordSignal).mockClear();
    vi.mocked(recordHoldCount).mockClear();
    vi.mocked(trackCall).mockClear();
    resetLicenseCache();
    process.env.CQS_API_KEY = 'test-key';
  });

  it('throws VENUE_MARKET_CLOSED before trackCall, recordSignal or recordHoldCount, with 0 market-data requests', async () => {
    setStatuses(25);
    const err = await getTradeSignal({ coin: COIN, timeframe: '1h', exchange: 'BINGX' }).catch((e) => e);
    expect(err).toBeInstanceOf(VenueMarketClosedError);
    expect(trackCall).not.toHaveBeenCalled();
    expect(recordSignal).not.toHaveBeenCalled();
    expect(recordHoldCount).not.toHaveBeenCalled();
    expect(calls.market).toEqual([]);
  });

  it('MCP renders it in band (isError) with the allow-listed payload', () => {
    const err = new VenueMarketClosedError({ venue: 'BINGX', coin: COIN, symbol: SYMBOL, source: 'in_band', venueCode: 109415, venueMessage: `${SYMBOL} is pause currently` });
    expect(buildVenueMarketClosedPayload(err)).toEqual({
      error: 'VENUE_MARKET_CLOSED',
      error_code: 'VENUE_MARKET_CLOSED',
      message: 'NCSKCME2USD on BINGX is paused by the venue; no market data is served until it reopens',
      coin: COIN,
      exchange: 'BINGX',
      symbol: SYMBOL,
      source: 'in_band',
      venue_code: 109415,
      venue_message: `${SYMBOL} is pause currently`,
      suggested_action: 'Retry when the market reopens, or use a venue that trades it now',
    });
    const outcome = { ok: false, kind: 'threw', tool: 'get_trade_call', input: {}, error: err } as unknown as ToolCallOutcome;
    const r = toMcpToolResult(outcome);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual(buildVenueMarketClosedPayload(err));
  });
});
