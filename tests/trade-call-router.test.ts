/**
 * TRADE-CALL-ROUTING-RESOLVER-W1 R2 — the shared dispatch glue.
 *
 * `routeTradeCall` is the single-derivation point BOTH get_trade_call and
 * get_equity_call call: it resolves the route once (lazy equity-universe check
 * only in the bare branch) and dispatches to the existing perp or equity engine.
 * This suite locks the dispatch + the lazy-resolution contract (no DB lookup when
 * a venue/timeframe/assetClass is present).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTradeSignal: vi.fn(),
  getEquityCall: vi.fn(),
  isEquityUniverseSymbol: vi.fn(),
}));
vi.mock('../src/tools/get-trade-call.js', () => ({ getTradeSignal: mocks.getTradeSignal }));
vi.mock('../src/lib/equities/equity-tool-formatters.js', () => ({ getEquityCall: mocks.getEquityCall }));
vi.mock('../src/lib/equities/equity-universe-membership.js', () => ({ isEquityUniverseSymbol: mocks.isEquityUniverseSymbol }));

import { routeTradeCall } from '../src/tools/trade-call-router.js';

const LICENSE = { tier: 'free' as const, key: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTradeSignal.mockResolvedValue({ call: 'HOLD', confidence: 20, _algovault: { tool: 'get_trade_call' } });
  mocks.getEquityCall.mockResolvedValue({ call: 'BUY', confidence: 60, _algovault: { tool: 'get_equity_call' } });
  mocks.isEquityUniverseSymbol.mockResolvedValue(false);
});

describe('routeTradeCall — dispatch', () => {
  it('bare + in equity universe → equity engine (perp engine NOT called)', async () => {
    mocks.isEquityUniverseSymbol.mockResolvedValue(true);
    const { route, result } = await routeTradeCall({ coin: 'TSLA', license: LICENSE });
    expect(route).toEqual({ engine: 'equity', timeframe: '1d' });
    expect(mocks.getEquityCall).toHaveBeenCalledWith({ symbol: 'TSLA', license: LICENSE });
    expect(mocks.getTradeSignal).not.toHaveBeenCalled();
    expect(result).toEqual({ call: 'BUY', confidence: 60, _algovault: { tool: 'get_equity_call' } });
  });

  it('bare + NOT in universe → perp BINANCE 15m', async () => {
    mocks.isEquityUniverseSymbol.mockResolvedValue(false);
    const { route } = await routeTradeCall({ coin: 'BTC', license: LICENSE });
    expect(route).toEqual({ engine: 'perp', exchange: 'BINANCE', timeframe: '15m' });
    expect(mocks.getTradeSignal).toHaveBeenCalledWith(
      expect.objectContaining({ coin: 'BTC', exchange: 'BINANCE', timeframe: '15m', license: LICENSE }),
    );
    expect(mocks.getEquityCall).not.toHaveBeenCalled();
  });

  it('named venue → perp on that venue, and the universe check is SKIPPED (lazy)', async () => {
    const { route } = await routeTradeCall({ coin: 'TSLA', exchange: 'BITGET', timeframe: '1h', license: LICENSE });
    expect(route).toEqual({ engine: 'perp', exchange: 'BITGET', timeframe: '1h' });
    expect(mocks.getTradeSignal).toHaveBeenCalledWith(
      expect.objectContaining({ coin: 'TSLA', exchange: 'BITGET', timeframe: '1h' }),
    );
    expect(mocks.isEquityUniverseSymbol).not.toHaveBeenCalled();
  });

  it('named timeframe only → perp BINANCE at that TF, universe check SKIPPED', async () => {
    const { route } = await routeTradeCall({ coin: 'TSLA', timeframe: '1h', license: LICENSE });
    expect(route).toEqual({ engine: 'perp', exchange: 'BINANCE', timeframe: '1h' });
    expect(mocks.isEquityUniverseSymbol).not.toHaveBeenCalled();
  });

  it('assetClass=equity → equity engine, universe check SKIPPED', async () => {
    const { route } = await routeTradeCall({ coin: 'TSLA', assetClass: 'equity', license: LICENSE });
    expect(route.engine).toBe('equity');
    expect(mocks.getEquityCall).toHaveBeenCalledWith({ symbol: 'TSLA', license: LICENSE });
    expect(mocks.isEquityUniverseSymbol).not.toHaveBeenCalled();
  });

  it('assetClass=perp (bare) → perp BINANCE 15m, universe check SKIPPED', async () => {
    const { route } = await routeTradeCall({ coin: 'TSLA', assetClass: 'perp', license: LICENSE });
    expect(route).toEqual({ engine: 'perp', exchange: 'BINANCE', timeframe: '15m' });
    expect(mocks.isEquityUniverseSymbol).not.toHaveBeenCalled();
  });

  it('forwards includeReasoning, defaulting to true when omitted', async () => {
    await routeTradeCall({ coin: 'BTC', exchange: 'BINANCE', license: LICENSE });
    expect(mocks.getTradeSignal).toHaveBeenCalledWith(expect.objectContaining({ includeReasoning: true }));
    await routeTradeCall({ coin: 'BTC', exchange: 'BINANCE', includeReasoning: false, license: LICENSE });
    expect(mocks.getTradeSignal).toHaveBeenLastCalledWith(expect.objectContaining({ includeReasoning: false }));
  });

  it('returns the engine result verbatim', async () => {
    mocks.getTradeSignal.mockResolvedValue({ call: 'SELL', confidence: 71, _algovault: { tool: 'get_trade_call' } });
    const { result } = await routeTradeCall({ coin: 'BTC', exchange: 'BYBIT', timeframe: '5m', license: LICENSE });
    expect(result).toEqual({ call: 'SELL', confidence: 71, _algovault: { tool: 'get_trade_call' } });
  });
});
