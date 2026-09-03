/**
 * tests/unit/seed-signals-fetchers.test.ts — OPS-SHADOW-PIPELINE-W1 / C2.
 *
 * Each shadow-venue universe fetcher is tested against its REAL endpoint JSON
 * shape (captured live from the prod host in Plan-Mode Step-0): correct
 * canonical-coin mapping, USDT-perpetual filtering, top-N ranking by 24h
 * volume / OI, and fail-soft ([] on HTTP/parse/network error — never throws).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchAsterCoins, fetchGateCoins, fetchMexcCoins, fetchKucoinCoins,
  fetchBingxCoins, fetchHtxCoins, fetchWeexCoins, fetchBitmartCoins,
  fetchWhitebitCoins, fetchXtCoins, fetchEdgexCoins, fetchPhemexCoins,
} from '../../src/scripts/seed-signals.js';

function resp(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as Response;
}
function mockFetch(...jsons: unknown[]) {
  const spy = vi.spyOn(globalThis, 'fetch');
  for (const j of jsons) spy.mockResolvedValueOnce(resp(j));
  return spy;
}

afterEach(() => vi.restoreAllMocks());

describe('C2 shadow universe-fetchers — shape mapping + ranking + filters', () => {
  it('ASTER: USDT-filter, 1000-prefix override, quoteVolume ranking', async () => {
    mockFetch([
      { symbol: 'BTCUSDT', quoteVolume: '1000' },
      { symbol: '1000PEPEUSDT', quoteVolume: '5000' },
      { symbol: 'ETHUSDC', quoteVolume: '9999' }, // non-USDT → excluded
    ]);
    expect(await fetchAsterCoins(5)).toEqual(['PEPE', 'BTC']);
  });

  // OPS-SCAN-UNIVERSE-EXPAND-W1 (S2): GATE / MEXC / KUCOIN / HTX / PHEMEX universe fetchers now DELEGATE
  // to the rich scan SoT (getVenueUniverse). Their OI-ranked shape-mapping is covered directly in
  // tests/unit/exchange-universe-fetchers.test.ts; here we only pin the delegate is wired + fail-soft.
  // (ASTER / BingX stay volume-ranked proxies and are exercised above — they double as the delegate
  // e2e path through fetchVenueUniverse → the rich fetcher.)
  it('real-OI new venues delegate to the rich SoT and stay fail-soft ([] on error)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    for (const f of [fetchGateCoins, fetchMexcCoins, fetchKucoinCoins, fetchHtxCoins, fetchPhemexCoins]) {
      expect(await f(5)).toEqual([]);
    }
  });

  it('BINGX: symbol "-USDT" strip, quoteVolume ranking', async () => {
    mockFetch({ data: [
      { symbol: 'BTC-USDT', quoteVolume: '100' },
      { symbol: 'ETH-USDT', quoteVolume: '200' },
    ] });
    expect(await fetchBingxCoins(5)).toEqual(['ETH', 'BTC']);
  });

  // OPS-WEEX-PROMOTION-READINESS-W1 CH2 — migrated to /capi/v3/market/ticker/24hr.
  // V3 dropped the cmt_ prefix and uppercased symbols, so the V2-era fixture is no
  // longer the venue's shape; the ranking field is quoteVolume (see the trap below).
  it('WEEX: USDT suffix strip + uppercase, quoteVolume ranking', async () => {
    mockFetch([
      { symbol: 'BTCUSDT', quoteVolume: '100' },
      { symbol: 'ETHUSDT', quoteVolume: '200' },
    ]);
    expect(await fetchWeexCoins(5)).toEqual(['ETH', 'BTC']);
  });

  // THE TRAP THIS FETCHER IS MOST EXPOSED TO. V2 `volume_24h` was QUOTE volume; V3's
  // same-named `volume` is BASE. Because the deflation factor is each coin's own price,
  // reading `volume` does not rescale the ranking — it REORDERS it. Here BTC has the
  // larger quote volume but the smaller base volume, so a name-match mapping silently
  // inverts the top-N that WEEX's entire seed lane is drawn from.
  it('ranks on quoteVolume, NOT the same-named base `volume` (a name-match REORDERS)', async () => {
    mockFetch([
      { symbol: 'BTCUSDT', quoteVolume: '1794119177', volume: '23227.69' },
      { symbol: 'ETHUSDT', quoteVolume: '900000000', volume: '374000.0' },
    ]);
    expect(await fetchWeexCoins(5)).toEqual(['BTC', 'ETH']);
  });

  it('WEEX: reverses the TradFi aliases a bare suffix-strip would miss (XAG → SILVER)', async () => {
    mockFetch([
      { symbol: 'XAGUSDT', quoteVolume: '300' },
      { symbol: 'CLUSDT', quoteVolume: '200' },
      { symbol: 'BTCUSDT', quoteVolume: '100' },
    ]);
    expect(await fetchWeexCoins(5)).toEqual(['SILVER', 'USOIL', 'BTC']);
  });

  it('BITMART: product_type==1 + USDT filter, open_interest ranking', async () => {
    mockFetch({ data: { symbols: [
      { symbol: 'BTCUSDT', base_currency: 'BTC', quote_currency: 'USDT', product_type: 1, open_interest: '100' },
      { symbol: 'ETHUSDT', base_currency: 'ETH', quote_currency: 'USDT', product_type: 1, open_interest: '200' },
      { symbol: 'XYZUSD', base_currency: 'XYZ', quote_currency: 'USD', product_type: 2, open_interest: '9999' }, // excl
    ] } });
    expect(await fetchBitmartCoins(5)).toEqual(['ETH', 'BTC']);
  });

  it('WHITEBIT: money_currency==USDT filter, stock_currency coin, stock_volume ranking', async () => {
    mockFetch({ result: [
      { ticker_id: 'BTC_PERP', stock_currency: 'BTC', money_currency: 'USDT', stock_volume: '100' },
      { ticker_id: 'ETH_PERP', stock_currency: 'ETH', money_currency: 'USDT', stock_volume: '200' },
      { ticker_id: 'X_PERP', stock_currency: 'X', money_currency: 'BTC', stock_volume: '9999' }, // non-USDT → excl
    ] });
    expect(await fetchWhitebitCoins(5)).toEqual(['ETH', 'BTC']);
  });

  it('XT: PERPETUAL filter (excludes quarterly), agg-tickers volume join', async () => {
    mockFetch(
      { result: [
        { symbol: 'btc_usdt', baseCoin: 'btc', contractType: 'PERPETUAL', state: 0 },
        { symbol: 'eth_usdt', baseCoin: 'eth', contractType: 'PERPETUAL', state: 0 },
        { symbol: 'btc_usdt_240927', baseCoin: 'btc', contractType: 'CURRENT_QUARTER', state: 0 }, // dated → excl
      ] },
      { result: [
        { s: 'btc_usdt', a: '100' },
        { s: 'eth_usdt', a: '200' },
        { s: 'btc_usdt_240927', a: '9999' }, // not in perp set → ignored
      ] },
    );
    expect(await fetchXtCoins(5)).toEqual(['ETH', 'BTC']);
  });

  it('EDGEX: contractName USD strip (unranked top-N)', async () => {
    mockFetch({ data: { contractList: [
      { contractName: 'BTCUSD' },
      { contractName: 'ETHUSD' },
    ] } });
    expect((await fetchEdgexCoins(5)).sort()).toEqual(['BTC', 'ETH']);
  });
});

describe('C2 fetchers — fail-soft (no throw)', () => {
  it('HTTP 500 → []', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 500 } as Response);
    expect(await fetchGateCoins(5)).toEqual([]);
    expect(await fetchBitmartCoins(5)).toEqual([]);
  });

  it('network reject → []', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    expect(await fetchWhitebitCoins(5)).toEqual([]);
    expect(await fetchXtCoins(5)).toEqual([]);
  });

  it('top-N caps the result length', async () => {
    mockFetch([
      { contract: 'A_USDT', volume_24h_quote: '5' },
      { contract: 'B_USDT', volume_24h_quote: '4' },
      { contract: 'C_USDT', volume_24h_quote: '3' },
    ]);
    expect(await fetchGateCoins(2)).toEqual(['A', 'B']);
  });
});
