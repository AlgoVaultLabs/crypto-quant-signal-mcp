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

  it('GATE: contract "_USDT" strip, volume_24h_quote ranking', async () => {
    mockFetch([
      { contract: 'BTC_USDT', volume_24h_quote: '100' },
      { contract: 'ETH_USDT', volume_24h_quote: '200' },
    ]);
    expect(await fetchGateCoins(5)).toEqual(['ETH', 'BTC']);
  });

  it('MEXC: symbol "_USDT" strip, amount24 ranking', async () => {
    mockFetch({ data: [
      { symbol: 'BTC_USDT', amount24: 100 },
      { symbol: 'ETH_USDT', amount24: 200 },
    ] });
    expect(await fetchMexcCoins(5)).toEqual(['ETH', 'BTC']);
  });

  it('KUCOIN: XBT→BTC, FFWCSX+USDT filter, turnoverOf24h ranking', async () => {
    mockFetch({ data: [
      { symbol: 'XBTUSDTM', baseCurrency: 'XBT', quoteCurrency: 'USDT', type: 'FFWCSX', turnoverOf24h: 500 },
      { symbol: 'ETHUSDTM', baseCurrency: 'ETH', quoteCurrency: 'USDT', type: 'FFWCSX', turnoverOf24h: 100 },
      { symbol: 'XBTUSDCM', baseCurrency: 'XBT', quoteCurrency: 'USDC', type: 'FFWCSX', turnoverOf24h: 9999 }, // USDC → excl
    ] });
    expect(await fetchKucoinCoins(5)).toEqual(['BTC', 'ETH']);
  });

  it('BINGX: symbol "-USDT" strip, quoteVolume ranking', async () => {
    mockFetch({ data: [
      { symbol: 'BTC-USDT', quoteVolume: '100' },
      { symbol: 'ETH-USDT', quoteVolume: '200' },
    ] });
    expect(await fetchBingxCoins(5)).toEqual(['ETH', 'BTC']);
  });

  it('HTX: contract_code "-USDT" strip, trade_turnover ranking', async () => {
    mockFetch({ ticks: [
      { contract_code: 'BTC-USDT', trade_turnover: '100' },
      { contract_code: 'ETH-USDT', trade_turnover: '200' },
    ] });
    expect(await fetchHtxCoins(5)).toEqual(['ETH', 'BTC']);
  });

  it('WEEX: cmt_ prefix + usdt suffix strip + uppercase, volume_24h ranking', async () => {
    mockFetch([
      { symbol: 'cmt_btcusdt', volume_24h: '100' },
      { symbol: 'cmt_ethusdt', volume_24h: '200' },
    ]);
    expect(await fetchWeexCoins(5)).toEqual(['ETH', 'BTC']);
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

  it('PHEMEX: perpProductsV2 USDT+Listed filter (excludes USDC)', async () => {
    mockFetch({ data: { perpProductsV2: [
      { baseCurrency: 'BTC', quoteCurrency: 'USDT', status: 'Listed' },
      { baseCurrency: 'ETH', quoteCurrency: 'USDT', status: 'Listed' },
      { baseCurrency: 'SOL', quoteCurrency: 'USDC', status: 'Listed' }, // USDC → excl
    ] } });
    expect((await fetchPhemexCoins(5)).sort()).toEqual(['BTC', 'ETH']);
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
