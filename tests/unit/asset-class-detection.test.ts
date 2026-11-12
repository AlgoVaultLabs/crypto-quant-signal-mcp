/**
 * Unit tests for the asset-class engine (OPS-TIER-CLASSIFIER-XVENUE-W1, rebuilt by
 * OPS-ASSET-CLASS-TOTALITY-W1 CH1). All offline + deterministic:
 *  1. symbol forms — deToken / refineForms (refinement + the query-side TradFi form);
 *  2. records — the flag is the venue's own, from the one tag table;
 *  3. the engine over injected records — exact-first through the adapter's own mapper, the
 *     union's crypto-wins rule, refinement, never-dropped tags, the ledger;
 *  4. degradation — cold seed floor, per-venue fail-open, stale-on-empty;
 *  5. every REAL detector's field parsing through a mocked `upstreamFetch`.
 * The live-census assertions (E1, Bitget refinement, OKX codes…) are in asset-class-census.test.ts.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/lib/adapters/_upstream-fetch.js', () => ({
  VENUE_FETCH_CONFIGS: new Proxy({} as Record<string, unknown>, {
    get: () => ({ venueName: 'test', exchangeId: 'TEST', banStatuses: [], timeoutMs: 1, transientRetries: 0 }),
  }),
  upstreamFetch: vi.fn(),
  safeUpstreamNum: (v: unknown) => (typeof v === 'number' ? v : Number(v)),
}));

import {
  deToken,
  refineForms,
  venueRecord,
  getAssetClass,
  getTradFiClass,
  _getAssetClassLedgerForTest,
  warmAssetClasses,
  _warmForTest,
  _setDetectorsForTest,
  _loadVenueRecordsForTest,
  _clearAssetClassCache,
  _getAssetClassState,
} from '../../src/lib/asset-class-detection.js';
import { upstreamFetch } from '../../src/lib/adapters/_upstream-fetch.js';

beforeEach(() => {
  _clearAssetClassCache();
  (upstreamFetch as unknown as Mock).mockReset();
});

describe('symbol forms', () => {
  it('deToken: tokenized stock → underlying; crypto majors ending in X stay intact', () => {
    expect(deToken('AAPLX')).toBe('AAPL');
    expect(deToken('MSTRX')).toBe('MSTR');
    expect(deToken('AMDSTOCK')).toBe('AMD');
    for (const c of ['DYDX', 'AVAX', 'FLUX', 'IMX', 'GMX', 'QNTX']) expect(deToken(c)).toBe(c);
  });

  it('refineForms: de-token, the BingX NC wrapper, Bitget HKD, a USD leg — never the bare itself', () => {
    expect(refineForms('TSLAX')).toEqual(['TSLA']);
    expect(refineForms('NCSKTSLA2USD')).toEqual(['TSLA']);
    expect(refineForms('NCSINIKKEI2252USD')).toEqual(['NIKKEI225']);
    expect(refineForms('TENCENTHKD')).toEqual(['TENCENT']);
    expect(refineForms('JP225USD')).toEqual(['JP225']);
    expect(refineForms('BTC')).toEqual([]);
  });
});

describe('records — the flag is the venue’s own (one tag table)', () => {
  it('a crypto tag is crypto evidence; any other tag is TradFi; the bare strips the quote ONCE', () => {
    expect(venueRecord('BINANCE', 'BTCUSDT', 'PERPETUAL')).toEqual({ native: 'BTCUSDT', bare: 'BTC', flag: 'CRYPTO', tag: 'PERPETUAL' });
    expect(venueRecord('BINANCE', 'TENCENTUSDT', 'HK_EQUITY').flag).toBe('TRADFI');
    expect(venueRecord('BINANCE', 'FOOUSDT', 'JP_EQUITY').flag).toBe('TRADFI'); // unmapped tag: still TradFi
    expect(venueRecord('BYBIT', 'EURUSDUSDT', 'forex').bare).toBe('EURUSD');   // not double-stripped to EUR
    expect(venueRecord('BINGX', 'NCSKCVX2USD-USDT', 'NCSK').bare).toBe('NCSKCVX2USD'); // not unwound to CVX
    expect(venueRecord('BINGX', 'CVX-USDT', '').flag).toBe('CRYPTO');
    expect(venueRecord('HL', 'xyz:TSLA', 'xyz')).toMatchObject({ bare: 'TSLA', flag: 'TRADFI' });
    expect(venueRecord('OKX', 'BB-USDT-SWAP', '3')).toMatchObject({ bare: 'BB', flag: 'TRADFI' });
    expect(venueRecord('OKX', 'BTC-USDT-SWAP', '1').flag).toBe('CRYPTO');
  });
});

describe('engine — exact-first through the venue’s own record', () => {
  beforeEach(() => _loadVenueRecordsForTest({
    BINANCE: [['CVXUSDT', 'PERPETUAL'], ['BBUSDT', 'PERPETUAL'], ['QNTUSDT', 'PERPETUAL'], ['1000CATUSDT', 'PERPETUAL'],
      ['CATUSDT', 'EQUITY'], ['XAUUSDT', 'COMMODITY'], ['USDEXUSDT', 'EQUITY'], ['TENCENTUSDT', 'HK_EQUITY']],
    OKX: [['BB-USDT-SWAP', '3'], ['QNT-USDT-SWAP', '3'], ['BTC-USDT-SWAP', '1']],
    BINGX: [['NCSKCVX2USD-USDT', 'NCSK'], ['CVX-USDT', ''], ['XAUT-USDT', '']],
    BITGET: [['CVXSTOCKUSDT', 'isRwa'], ['XAUUSDT', 'isRwa'], ['TENCENTHKDUSDT', 'isRwa']],
    GATE: [['USDC_USDT', 'forex'], ['ASML_USDT', 'stocks'], ['TSLAX_USDT', 'stocks']],
  }));

  it('a ticker clash resolves per venue: BB is a stock on OKX and crypto on Binance (E5)', () => {
    expect(getAssetClass('BB', 'OKX')).toBe('EQUITY');
    expect(getAssetClass('BB', 'BINANCE')).toBe('CRYPTO');
    expect(getAssetClass('CVX', 'BINANCE')).toBe('CRYPTO');
    expect(getAssetClass('CVX', 'BINGX')).toBe('CRYPTO');            // CVX-USDT, not the NCSK wrapper
    expect(getAssetClass('NCSKCVX2USD', 'BINGX')).toBe('EQUITY');
    expect(getTradFiClass('CVXSTOCK', 'BITGET')).toBe('EQUITY');
  });

  it('the adapter’s own forward mapper picks the instrument (CAT = 1000CAT; GOLD = XAU)', () => {
    expect(getAssetClass('CAT', 'BINANCE')).toBe('CRYPTO');   // toBinanceSymbol('CAT') = 1000CATUSDT
    expect(getAssetClass('GOLD', 'BINANCE')).toBe('COMMODITY'); // toBinanceSymbol('GOLD') = XAUUSDT
    expect(_getAssetClassLedgerForTest()!.venues.BINANCE).toMatchObject({ shadowed: 1, lost: 0, collisions: 0 });
  });

  it('no own record: an exact crypto listing anywhere beats TradFi (QNT); then exact TradFi; then the query form', () => {
    expect(getAssetClass('QNT', 'ASTER')).toBe('CRYPTO');
    expect(_getAssetClassLedgerForTest()!.conflicts.some((c) => c.key === 'QNT' && c.kind === 'crypto-vs-tradfi')).toBe(true);
    expect(getAssetClass('ASML', 'KUCOIN')).toBe('EQUITY');
    expect(getAssetClass('TSLAX', 'XT')).toBe('EQUITY');    // exact union (Gate)
    expect(getAssetClass('ASMLX', 'XT')).toBe('EQUITY');    // query form ASML (Gate) — no exact crypto ASMLX
    expect(getAssetClass('FOOBARX', 'XT')).toBeNull();      // nothing knows it
  });

  it('storage-side form expansion is retired: Bitget MOONSTOCK does not make bare MOON TradFi', () => {
    _loadVenueRecordsForTest({ BITGET: [['MOONSTOCKUSDT', 'isRwa']] });
    expect(getTradFiClass('MOONSTOCK', 'KUCOIN')).toBe('EQUITY');
    expect(getTradFiClass('MOON', 'KUCOIN')).toBeNull();
    expect(getTradFiClass('MOON')).toBeNull();
  });

  it('refinement: a level-0 tag borrows a level-2 class (exact, then forms); the deny-list is exact', () => {
    expect(getAssetClass('XAU', 'BITGET')).toBe('COMMODITY');         // Binance XAUUSDT
    expect(getAssetClass('TENCENTHKD', 'BITGET')).toBe('HK_EQUITY');  // HKD form → Binance TENCENT
    expect(getAssetClass('USDC', 'GATE')).toBe('CRYPTO');             // stablecoin under a forex tag
    expect(getAssetClass('XAUT', 'BINGX')).toBe('CRYPTO');
    expect(getAssetClass('USDEX', 'BINANCE')).toBe('EQUITY');         // a FORM of USDE is not denied
  });
});

describe('engine — never dropped, refinement guards, the ledger', () => {
  it('an unmapped tag lands via TAG_PATTERNS and is listed in the ledger', () => {
    _loadVenueRecordsForTest({ BINANCE: [['TOYOTAUSDT', 'JP_EQUITY'], ['BTCUSDT', 'PERPETUAL']], OKX: [['FOO-USDT-SWAP', '7']] });
    expect(getAssetClass('TOYOTA', 'BINANCE')).toBe('EQUITY');
    expect(getAssetClass('FOO', 'OKX')).toBe('EQUITY'); // no pattern matches '7' → level 0, default EQUITY
    const L = _getAssetClassLedgerForTest()!;
    expect(L.unmapped).toEqual([
      { venue: 'BINANCE', tag: 'JP_EQUITY', natives: ['TOYOTAUSDT'] },
      { venue: 'OKX', tag: '7', natives: ['FOO-USDT-SWAP'] },
    ]);
    expect(L.lost).toEqual([]);
  });

  it('a level-1 tag refines only within its family; a level-0 tag takes any level-2 class', () => {
    _loadVenueRecordsForTest({
      BINANCE: [['FOOUSDT', 'COMMODITY'], ['SAMSUNGUSDT', 'KR_EQUITY']],
      BYBIT: [['FOOUSDT', 'stock'], ['SAMSUNGUSDT', 'stock']],
      BITGET: [['FOOUSDT', 'isRwa']],
    });
    expect(getAssetClass('FOO', 'BYBIT')).toBe('EQUITY');        // family EQUITY; COMMODITY refused
    expect(getAssetClass('SAMSUNG', 'BYBIT')).toBe('KR_EQUITY');
    expect(getAssetClass('FOO', 'BITGET')).toBe('COMMODITY');
  });

  it('a level-2 clash keeps the own record and records a conflict', () => {
    _loadVenueRecordsForTest({ BINANCE: [['SPYUSDT', 'EQUITY']], GATE: [['SPY_USDT', 'indices']] });
    expect(getAssetClass('SPY', 'BINANCE')).toBe('EQUITY');
    expect(getAssetClass('SPY', 'GATE')).toBe('INDEX');
    expect(_getAssetClassLedgerForTest()!.conflicts.find((c) => c.kind === 'level2')?.key).toBe('SPY');
  });

  it('a bare two instruments share on one venue is a collision, and the loser is lost', () => {
    _loadVenueRecordsForTest({ HL: [['FOO', 'main'], ['xyz:FOO', 'xyz']] });
    const L = _getAssetClassLedgerForTest()!;
    expect(L.collisions).toEqual([{ venue: 'HL', bare: 'FOO', natives: ['FOO', 'xyz:FOO'] }]);
    expect(L.venues.HL).toMatchObject({ collisions: 1, lost: 1 });
  });
});

describe('engine — degradation', () => {
  it('cold: the STATIC seed floor; the deny-list still applies', () => {
    expect(_getAssetClassState().warm).toBe(false);
    expect(getTradFiClass('TSLA')).toBe('EQUITY');
    expect(getTradFiClass('GLW')).toBe('EQUITY');
    expect(getAssetClass('ANTHROPIC', 'BINANCE')).toBe('PREMARKET');
    expect(getAssetClass('NOTATHING')).toBeNull();
    expect(getAssetClass('USDC')).toBe('CRYPTO');
  });

  it('one detector failing does not block the others; it is listed as failed', async () => {
    _setDetectorsForTest({
      GATE: async () => [venueRecord('GATE', 'SNDK_USDT', 'stocks')],
      MEXC: async () => { throw new Error('MEXC 503'); },
    });
    await expect(warmAssetClasses()).resolves.toBeUndefined();
    expect(getAssetClass('SNDK', 'GATE')).toBe('EQUITY');
    expect(_getAssetClassLedgerForTest()!.failed).toEqual(['MEXC']);
  });
});

describe('detectors — every venue’s own field, parsed (mocked upstreamFetch)', () => {
  const PHEMEX_URL = 'https://api.phemex.com/public/products';
  const phemexProducts = (rows: string[][]) => ({ code: 0, msg: '', data: { products: [], perpProductsV2: rows.map(
    ([symbol, status, quoteCurrency, perpProductSubType, perpProductSubGroup]) => (
      { symbol, status, quoteCurrency, perpProductSubType, ...(perpProductSubGroup ? { perpProductSubGroup } : {}) })) } });
  const URLS = {
    ASTER: 'https://fapi.asterdex.com/fapi/v1/exchangeInfo',
    KUCOIN: 'https://api-futures.kucoin.com/api/v1/contracts/active',
    WEEX: 'https://api-contract.weex.com/capi/v3/market/exchangeInfo',
  };
  const asterPerp = (symbol: string, symbolType: number, underlyingSubType: string[]) => (
    { symbol, contractType: 'PERPETUAL', quoteAsset: 'USDT', underlyingType: 'COIN', symbolType, underlyingSubType });
  const kucoinPerp = (symbol: string, assetClass: string, subMarketType: string | null, marketStage = 'NORMAL') => (
    { symbol, type: 'FFWCSX', quoteCurrency: 'USDT', assetClass, subMarketType, marketStage });
  const weexPerp = (symbol: string, contractType: string, underlyingType: string) => ({ symbol, contractType, underlyingType });
  const FIXTURES: Record<string, unknown> = {
    'https://fapi.binance.com/fapi/v1/exchangeInfo': { symbols: [
      { symbol: 'TENCENTUSDT', contractType: 'TRADIFI_PERPETUAL', underlyingType: 'HK_EQUITY' },
      { symbol: 'USDBRLUSDT', contractType: 'TRADIFI_PERPETUAL', underlyingType: 'FX' },
      { symbol: 'SPYUSDT', contractType: 'TRADIFI_PERPETUAL', underlyingType: 'EQUITY' },
      { symbol: 'BTCUSDT', contractType: 'PERPETUAL', underlyingType: 'COIN' },
      { symbol: 'BTCUSDC', contractType: 'PERPETUAL', underlyingType: 'COIN' },
      { symbol: 'BTCUSDT_261225', contractType: 'CURRENT_QUARTER', underlyingType: 'COIN' },
    ] },
    'https://api.gateio.ws/api/v4/futures/usdt/contracts': [
      { name: 'NASDAQ_USDT', contract_type: 'indices' }, { name: 'XAG_USDT', contract_type: 'metals' },
      { name: 'EUR_USDT', contract_type: 'forex' }, { name: 'BTC_USDT', contract_type: '' },
      { name: 'CAT_USDT', contract_type: '' }, // a crypto CAT: XT's CAT (Caterpillar) must not borrow it
      { name: 'SPX500_USDT', contract_type: 'indices' },
      { name: 'RTX_USDT', contract_type: 'stocks' }, // Raytheon; Aster's RTX is a token
      { name: 'US30_USDT', contract_type: 'indices' },
    ],
    'https://contract.mexc.com/api/v1/contract/detail': { data: [
      { symbol: 'VOOSTOCK_USDT', typeLabel: 2, conceptPlate: ['mc-trade-zone-usstocks', 'mc-trade-zone-tradfi'] },
      { symbol: 'TENCENTSTOCK_USDT', typeLabel: 2, conceptPlate: ['mc-trade-zone-Stock', 'mc-trade-zone-hkstocks', 'mc-trade-zone-tradfi'] },
      { symbol: 'QQQSTOCK_USDT', typeLabel: 2, conceptPlate: ['mc-trade-zone-ETF', 'mc-trade-zone-Stock', 'mc-trade-zone-stockindex', 'mc-trade-zone-tradfi'] },
      { symbol: 'USOIL_USDT', typeLabel: 0, conceptPlate: ['mc-trade-zone-Commodities', 'mc-trade-zone-tradfi'] },
      { symbol: 'SOL_USDT', typeLabel: 0, conceptPlate: ['mc-trade-zone-layer1'] },
      { symbol: 'SOL_USDC', typeLabel: 0, conceptPlate: [] },
    ] },
    'https://api.bitget.com/api/v2/mix/market/contracts?productType=usdt-futures': { data: [
      { symbol: 'VRTUSDT', isRwa: 'YES' }, { symbol: 'QNTUSDT', isRwa: 'NO' },
    ] },
    'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000': { result: { list: [
      { symbol: 'IWMUSDT', symbolType: 'ETF', contractType: 'LinearPerpetual', quoteCoin: 'USDT' },
      { symbol: 'USDJPYUSDT', symbolType: 'forex', contractType: 'LinearPerpetual', quoteCoin: 'USDT' },
      { symbol: 'BTCPERP', symbolType: '', contractType: 'LinearPerpetual', quoteCoin: 'USDC' },
      { symbol: 'BTC-26DEC25', symbolType: '', contractType: 'LinearFutures', quoteCoin: 'USDT' },
    ], nextPageCursor: '' } },
    'https://whitebit.com/api/v4/public/markets': [
      { name: 'AAPL_PERP', isTradFiFutures: true }, { name: 'BTC_PERP', isTradFiFutures: false }, { name: 'BTC_USDT' },
    ],
    'https://open-api.bingx.com/openApi/swap/v2/quote/contracts': { data: [
      { symbol: 'NCFXEUR2USD-USDT' }, { symbol: 'BTC-USDT' }, { symbol: 'BTC-USDC' },
    ] },
    'https://api.hyperliquid.xyz/info': [
      { universe: [{ name: 'BTC' }, { name: 'SPX' }, { name: 'OLDCOIN', isDelisted: true }] },
      { universe: [{ name: 'xyz:TSLA' }, { name: 'xyz:GOLD' }, { name: 'xyz:OLDX', isDelisted: true }] },
      { universe: [{ name: 'flx:NVDA' }] }, // a builder dex the adapter does not serve: not a record
    ],
    'https://www.okx.com/api/v5/public/instruments?instType=SWAP': { data: [
      { instId: 'AAPL-USDT-SWAP', instCategory: '3', ruleType: 'normal' },
      { instId: 'XAU-USDT-SWAP', instCategory: '4', ruleType: 'normal' },
      { instId: 'OPENAI-USDT-SWAP', instCategory: '3', ruleType: 'pre_market' },
      { instId: 'BTC-USDT-SWAP', instCategory: '1', ruleType: 'normal' },
      { instId: 'BTC-USD-SWAP', instCategory: '1', ruleType: 'normal' },
    ] },
    // XT `tags`, shapes as served 2026-11-12 (OPS-ASSET-CLASS-XT-DECODE-W1).
    'https://fapi.xt.com/future/market/v1/public/symbol/list': { returnCode: 0, msgInfo: 'success', error: null, result: [
      { symbol: 'usdtry_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: ['FOREX'] },
      { symbol: 'de30eur_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: ['INDEX'] },
      { symbol: 'voo_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: ['INDEX'] }, // an ETF XT tags INDEX
      { symbol: 'xpt_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: ['METAL'] },
      { symbol: 'paxg_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: ['METAL'] },
      { symbol: 'openai_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: ['STOCK', 'Pre-M'] },
      { symbol: 'cat_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: ['STOCK'] },
      { symbol: 'clsk_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: null }, // a stock XT has not tagged yet
      { symbol: 'btc_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: null },
      { symbol: 'btc_usdt_230630', contractType: 'CURRENT_QUARTER', quoteCoin: 'usdt', tags: null },
    ] },
    // HTX class words in `tradfi_labels` and `labels`, records as served 2026-11-12 (OPS-ASSET-CLASS-HTX-DECODE-W1).
    'https://api.hbdm.com/linear-swap-api/v1/swap_contract_info': { status: 'ok', ts: 1794484904064, data: [
      ['NASDAQ100-USDT', ['tradfi', 'indices', 'new', 'common'], ['Indices']],
      ['SPY-USDT', ['tradfi', 'indices', 'new', 'common'], ['Indices']], // an ETF HTX files under Indices
      ['OPENAI-USDT', ['tradfi', 'stock'], ['Stocks']],
      ['PURR-USDT', ['tradfi', 'stock'], ['Stocks']],
      ['BKNG-USDT', ['stock'], []], // the class named in `labels` only
      ['USOIL-USDT', ['tradfi', 'commodities', 'new', 'common'], ['Commodities']],
      ['XAU-USDT', ['tradfi', 'commodities', 'common'], ['Metals']],
      ['PAXG-USDT', ['tradfi', 'commodities', 'common'], ['Metals']],
      ['CMCSA-USDT', [], []], // a stock HTX leaves unlabeled
      ['BTC-USDT', ['hot', 'common'], []],
    ].map(([code, labels, tradfi_labels]) => ({
      symbol: (code as string).replace(/-USDT$/, ''), contract_code: code, business_type: 'swap', contract_status: 1, labels, tradfi_labels })) },
    // Phemex `perpProductSubType` + `perpProductSubGroup`, records as served 2026-11-12 (OPS-ASSET-CLASS-PHEMEX-DECODE-W1).
    [PHEMEX_URL]: phemexProducts([
      ['XTIUSDT', 'Listed', 'USDT', 'TradFi', 'Commodities'], // WTI crude
      ['XAUUSDT', 'Listed', 'USDT', 'TradFi', 'Metals'],
      ['PAXGUSDT', 'Listed', 'USDT', 'TradFi', 'Metals'],
      ['MUXUSDT', 'Listed', 'USDT', 'TradFi', 'Stocks'],
      ['CATXUSDT', 'Delisted', 'USDT', 'TradFi', 'Stocks'], // delisted: Phemex keeps it, so does the track record
      ['SPX500USDT', 'Delisted', 'USDT', 'TradFi', 'Stocks'], // the S&P 500, filed under Stocks
      ['SPYXUSDT', 'Listed', 'USDT', 'TradFi', 'Indices'],
      ['OPENAIUSDT', 'Listed', 'USDT', 'PreMarket'],
      ['BTCUSDT', 'Listed', 'USDT', 'Normal'],
      ['NEWUSDT', 'Delisted', 'USDT', 'Pilot'],
      ['BTCUSDC', 'Listed', 'USDC', 'Normal'],
    ]),
    // OPS-TIER-CLASSIFIER-DECODE-W2 — shapes as served 2026-11-12T17:08Z.
    // Aster `symbolType` + `underlyingSubType`:
    [URLS.ASTER]: { symbols: [
      asterPerp('RTXUSDT', 0, []), // a 0.22 USDT token: crypto evidence, not Gate's Raytheon
      asterPerp('PREDICTUSDT', 0, ['pre-launch']), // a crypto pre-launch token
      asterPerp('OPENAIUSDT', 1, ['pre-launch', 'STOCK']),
      asterPerp('QQQUSDT', 1, ['STOCK', 'ETF']),
      asterPerp('TENCENTUSDT', 1, ['STOCK']),
      asterPerp('XAUUSDT', 1, ['Commodities']),
      { ...asterPerp('MOONSHOTUSD1', 1, ['pre-launch', 'STOCK', 'USD1-RWA']), quoteAsset: 'USD1' }, // not USDT
      { ...asterPerp('SMSNUSDT', 1, ['STOCK']), contractType: '' }, // not a perpetual yet
    ] },
    // KuCoin `assetClass` + `subMarketType` + `marketStage`:
    [URLS.KUCOIN]: { code: '200000', data: [
      kucoinPerp('ACNXUSDTM', 'STOCK', 'US.STOCK'),
      kucoinPerp('SHEINHKDUSDTM', 'STOCK', 'HK.STOCK'),
      kucoinPerp('SAMSUNGUSDTM', 'STOCK', 'KR.STOCK'),
      kucoinPerp('KIOXIAUSDTM', 'STOCK', 'JP.STOCK'),
      kucoinPerp('OPENAIUSDTM', 'STOCK', 'US.STOCK', 'PRE_MARKET'),
      kucoinPerp('XAUTUSDTM', 'METAL', null), // the adapter's GOLD
      kucoinPerp('CLUSDTM', 'COMMODITY', null),
      kucoinPerp('XBTUSDTM', 'CRYPTO', null), // the adapter's BTC
      kucoinPerp('BPUSDTM', 'CRYPTO', null, 'PRE_MARKET'), // a pre-launch token
      { ...kucoinPerp('XBTUSDM', 'CRYPTO', null), quoteCurrency: 'USD' }, // inverse
      { ...kucoinPerp('XBTMZ26', 'CRYPTO', null), type: 'FFICSX', quoteCurrency: 'USD' }, // a delivery future
    ] },
    // WEEX `contractType` + `underlyingType`:
    [URLS.WEEX]: { symbols: [
      weexPerp('KKRUSDT', 'TRADIFI_PERPETUAL', 'Stocks'),
      weexPerp('US30USDT', 'TRADIFI_PERPETUAL', 'Stocks'), // the Dow, filed under Stocks
      weexPerp('SPYUSDT', 'TRADIFI_PERPETUAL', 'Indices'), // an ETF, filed under Indices
      weexPerp('EURUSDT', 'TRADIFI_PERPETUAL', 'Forex'),
      weexPerp('YMTCUSDT', 'TRADIFI_PERPETUAL', 'Pre-IPO'),
      weexPerp('GLDUSDT', 'TRADIFI_PERPETUAL', 'Metals'),
      weexPerp('ALLUSDT', 'TRADIFI_PERPETUAL', 'Indices'), // Allora, a token: the deny-list decides
      weexPerp('JP225USDT', 'PERPETUAL', 'COIN'), // the Nikkei, filed as a COIN perpetual: not crypto evidence
      weexPerp('BTCUSDT', 'PERPETUAL', 'COIN'),
    ] },
  };

  it('parses each venue end-to-end into records the engine classes', async () => {
    _setDetectorsForTest(null); // the REAL detector registry
    const hlBodies: string[] = [];
    (upstreamFetch as unknown as Mock).mockImplementation(async (_cfg: unknown, req: { url: string; body?: string }) => {
      if (req.url === 'https://api.hyperliquid.xyz/info') hlBodies.push(req.body ?? '');
      if (!(req.url in FIXTURES)) throw new Error(`unmocked ${req.url}`);
      return FIXTURES[req.url];
    });
    await _warmForTest();

    expect(_getAssetClassLedgerForTest()!.failed.sort()).toEqual(['BITMART', 'EDGEX']); // unmocked = retired, failing open
    expect(getAssetClass('TENCENT', 'BINANCE')).toBe('HK_EQUITY');
    expect(getAssetClass('USDBRL', 'BINANCE')).toBe('FX');
    expect(getAssetClass('BTC', 'BINANCE')).toBe('CRYPTO');
    expect(_getAssetClassLedgerForTest()!.venues.BINANCE).toMatchObject({ tradfi: 3, crypto: 1 }); // USDC + quarterly skipped
    expect(getAssetClass('NASDAQ', 'GATE')).toBe('INDEX');
    expect(getAssetClass('XAG', 'GATE')).toBe('COMMODITY');
    expect(getAssetClass('EUR', 'GATE')).toBe('FX');
    expect(getAssetClass('TENCENTSTOCK', 'MEXC')).toBe('HK_EQUITY');
    expect(getAssetClass('QQQSTOCK', 'MEXC')).toBe('INDEX');
    expect(getAssetClass('USOIL', 'MEXC')).toBe('COMMODITY');  // a tradfi zone without typeLabel 2
    expect(getAssetClass('SOL', 'MEXC')).toBe('CRYPTO');
    expect(getAssetClass('VRT', 'BITGET')).toBe('EQUITY');
    expect(getAssetClass('QNT', 'BITGET')).toBe('CRYPTO');
    expect(getAssetClass('IWM', 'BYBIT')).toBe('EQUITY');
    expect(getAssetClass('USDJPY', 'BYBIT')).toBe('FX');
    expect(_getAssetClassLedgerForTest()!.venues.BYBIT).toMatchObject({ tradfi: 2, crypto: 0 });
    expect(getAssetClass('AAPL', 'WHITEBIT')).toBe('EQUITY');
    expect(getAssetClass('BTC', 'WHITEBIT')).toBe('CRYPTO');
    expect(getAssetClass('NCFXEUR2USD', 'BINGX')).toBe('FX');
    expect(getAssetClass('SPX', 'HL')).toBe('CRYPTO');
    expect(getAssetClass('TSLA', 'HL')).toBe('EQUITY');       // xyz, refined from STATIC
    expect(getAssetClass('GOLD', 'HL')).toBe('COMMODITY');
    expect(getAssetClass('OLDCOIN', 'HL')).toBeNull();        // delisted: not a record
    expect(getAssetClass('NVDA', 'HL')).toBe('EQUITY');       // flx: not a record; NVDA from the STATIC floor
    expect(_getAssetClassLedgerForTest()!.venues.HL).toMatchObject({ tradfi: 2, crypto: 2 });
    // The sampler's ≤ 1 HL call per run rests on THIS detector (the sampler test injects its own HL).
    expect(hlBodies).toEqual([JSON.stringify({ type: 'allPerpMetas' })]);
    expect(getAssetClass('AAPL', 'OKX')).toBe('EQUITY');
    expect(getAssetClass('XAU', 'OKX')).toBe('COMMODITY');
    expect(getAssetClass('OPENAI', 'OKX')).toBe('PREMARKET');
    expect(getAssetClass('BTC', 'OKX')).toBe('CRYPTO');
    expect(_getAssetClassLedgerForTest()!.venues.OKX).toMatchObject({ tradfi: 3, crypto: 1 }); // inverse swap skipped
    // XT: its own `tags` decide; an untagged contract is no record (the union decides it); quarterlies skipped.
    expect(getAssetClass('USDTRY', 'XT')).toBe('FX');
    expect(getAssetClass('DE30EUR', 'XT')).toBe('INDEX');     // level 0, nothing refines it: XT's own INDEX
    expect(getAssetClass('VOO', 'XT')).toBe('EQUITY');        // level 0 INDEX refined by MEXC's level-2 usstocks
    expect(getAssetClass('PLATINUM', 'XT')).toBe('COMMODITY'); // the adapter's alias → xpt_usdt
    expect(getAssetClass('XPT', 'XT')).toBe('COMMODITY');
    expect(getAssetClass('PAXG', 'XT')).toBe('CRYPTO');       // the deny-list, whatever XT tags it
    expect(getAssetClass('OPENAI', 'XT')).toBe('PREMARKET');  // Pre-M wins over STOCK
    expect(getAssetClass('CAT', 'XT')).toBe('EQUITY');        // XT's own record beats Gate's crypto CAT…
    expect(getAssetClass('CAT', 'GATE')).toBe('CRYPTO');      // …which still decides on Gate
    expect(getAssetClass('CLSK', 'XT')).toBeNull();
    expect(getAssetClass('BTC', 'XT')).toBe('CRYPTO');        // untagged: the union's crypto evidence
    expect(_getAssetClassLedgerForTest()!.venues.XT).toMatchObject({ tradfi: 7, crypto: 0, denied: 1, lost: 0 });
    // HTX: its class words in either field decide; a contract with none is no record (the union decides it).
    expect(getAssetClass('NASDAQ100', 'HTX')).toBe('INDEX');   // level 0, nothing refines it: HTX's own INDEX
    expect(getAssetClass('SPY', 'HTX')).toBe('EQUITY');        // level 0 `indices` refined by Binance's level-2 EQUITY
    expect(getAssetClass('OPENAI', 'HTX')).toBe('PREMARKET');  // level 0 `stocks` refined by OKX's pre_market
    expect(getAssetClass('PURR', 'HTX')).toBe('EQUITY');
    expect(getAssetClass('BKNG', 'HTX')).toBe('EQUITY');
    expect(getAssetClass('USOIL', 'HTX')).toBe('COMMODITY');
    expect(getAssetClass('GOLD', 'HTX')).toBe('COMMODITY');    // the adapter's alias → XAU-USDT
    expect(getAssetClass('PAXG', 'HTX')).toBe('CRYPTO');       // the deny-list, whatever HTX labels it
    expect(getAssetClass('CMCSA', 'HTX')).toBeNull();
    expect(getAssetClass('BTC', 'HTX')).toBe('CRYPTO');        // unlabeled: the union's crypto evidence
    expect(_getAssetClassLedgerForTest()!.venues.HTX).toMatchObject({ tradfi: 8, crypto: 0, denied: 1, lost: 0 });
    // Phemex: a TradFi contract's group, or PreMarket, decides; Normal and Pilot are no record (the union decides them).
    expect(getAssetClass('XTI', 'PHEMEX')).toBe('COMMODITY');
    expect(getAssetClass('GOLD', 'PHEMEX')).toBe('COMMODITY');  // the adapter's alias → XAUUSDT
    expect(getAssetClass('XAU', 'PHEMEX')).toBe('COMMODITY');
    expect(getAssetClass('PAXG', 'PHEMEX')).toBe('CRYPTO');     // the deny-list, whatever Phemex groups it under
    expect(getAssetClass('MUX', 'PHEMEX')).toBe('EQUITY');      // level 0, nothing refines it: Phemex's own EQUITY
    expect(getAssetClass('CATX', 'PHEMEX')).toBe('EQUITY');     // delisted, still Phemex's record
    expect(getAssetClass('SPX500', 'PHEMEX')).toBe('INDEX');    // level 0 Stocks refined by Gate's level-2 indices
    expect(getAssetClass('SPYX', 'PHEMEX')).toBe('INDEX');
    expect(getAssetClass('OPENAI', 'PHEMEX')).toBe('PREMARKET');
    expect(getAssetClass('BTC', 'PHEMEX')).toBe('CRYPTO');      // Normal: the union's crypto evidence
    expect(getAssetClass('NEW', 'PHEMEX')).toBeNull();          // Pilot: no record, and no venue lists it
    expect(_getAssetClassLedgerForTest()!.venues.PHEMEX).toMatchObject({ tradfi: 8, crypto: 0, denied: 1, lost: 0 });
    // Aster: symbolType 0 is crypto evidence; symbolType 1's class word decides (pre-launch before STOCK).
    expect(getAssetClass('RTX', 'ASTER')).toBe('CRYPTO');        // Aster's own record beats Gate's Raytheon…
    expect(getAssetClass('RTX', 'GATE')).toBe('EQUITY');         // …which still decides on Gate
    expect(getAssetClass('PREDICT', 'ASTER')).toBe('CRYPTO');    // pre-launch on a symbolType-0 contract: a token
    expect(getAssetClass('OPENAI', 'ASTER')).toBe('PREMARKET');
    expect(getAssetClass('QQQ', 'ASTER')).toBe('EQUITY');        // level-1 ETF: no equity-family level-2 hit, so EQUITY
    expect(getAssetClass('TENCENT', 'ASTER')).toBe('HK_EQUITY'); // level-1 STOCK refined by Binance's level-2 HK_EQUITY
    expect(getAssetClass('XAU', 'ASTER')).toBe('COMMODITY');
    expect(_getAssetClassLedgerForTest()!.venues.ASTER).toMatchObject({ tradfi: 4, crypto: 2, lost: 0 }); // USD1 + non-perp skipped
    // KuCoin: assetClass, then the stock's market or PRE_MARKET.
    expect(getAssetClass('ACNX', 'KUCOIN')).toBe('EQUITY');
    expect(getAssetClass('SHEINHKD', 'KUCOIN')).toBe('HK_EQUITY');
    expect(getAssetClass('SAMSUNG', 'KUCOIN')).toBe('KR_EQUITY');
    expect(getAssetClass('KIOXIA', 'KUCOIN')).toBe('KR_EQUITY'); // JP is level 1 (no Japanese class): the STATIC seed's market fills it
    expect(getAssetClass('OPENAI', 'KUCOIN')).toBe('PREMARKET');
    expect(getAssetClass('GOLD', 'KUCOIN')).toBe('COMMODITY');   // the adapter's alias → XAUTUSDTM
    expect(getAssetClass('XAUT', 'KUCOIN')).toBe('CRYPTO');      // the deny-list
    expect(getAssetClass('CL', 'KUCOIN')).toBe('COMMODITY');
    expect(getAssetClass('BTC', 'KUCOIN')).toBe('CRYPTO');       // the adapter's XBT
    expect(getAssetClass('BP', 'KUCOIN')).toBe('CRYPTO');        // a pre-market token, not BP plc
    expect(_getAssetClassLedgerForTest()!.venues.KUCOIN).toMatchObject({ tradfi: 7, crypto: 2, denied: 1, lost: 0 }); // inverse + delivery skipped
    // WEEX: TRADIFI_PERPETUAL's underlyingType decides; a PERPETUAL is no record (the union decides it).
    expect(getAssetClass('KKR', 'WEEX')).toBe('EQUITY');
    expect(getAssetClass('US30', 'WEEX')).toBe('INDEX');         // level-0 Stocks refined by Gate's level-2 indices
    expect(getAssetClass('SPY', 'WEEX')).toBe('EQUITY');         // level-0 Indices refined by Binance's level-2 EQUITY
    expect(getAssetClass('EUR', 'WEEX')).toBe('FX');
    expect(getAssetClass('YMTC', 'WEEX')).toBe('PREMARKET');
    expect(getAssetClass('GLD', 'WEEX')).toBe('COMMODITY');
    expect(getAssetClass('ALL', 'WEEX')).toBe('CRYPTO');         // the deny-list, whatever WEEX files it under
    expect(getAssetClass('BTC', 'WEEX')).toBe('CRYPTO');         // no record: the union's crypto evidence
    expect(_getAssetClassLedgerForTest()!.venues.WEEX).toMatchObject({ tradfi: 7, crypto: 0, denied: 1, lost: 0 });
    expect(_getAssetClassLedgerForTest()!.unmapped).toEqual([]);
  });

  it('Aster, KuCoin and WEEX: an unknown class lands TradFi and is announced; a list without the field is a failed fetch', async () => {
    _setDetectorsForTest(null); // the REAL detector registry; every other venue fails open
    let payloads: Record<string, unknown> = {
      [URLS.ASTER]: { symbols: [asterPerp('NEWUSDT', 2, ['STOCK'])] },
      [URLS.KUCOIN]: { data: [kucoinPerp('EURUSDTM', 'FOREX', null)] },
      [URLS.WEEX]: { symbols: [weexPerp('BUNDUSDT', 'TRADIFI_PERPETUAL', 'Bonds')] },
    };
    (upstreamFetch as unknown as Mock).mockImplementation(async (_cfg: unknown, req: { url: string }) => {
      if (req.url in payloads) return payloads[req.url];
      throw new Error(`unmocked ${req.url}`);
    });
    await _warmForTest();
    expect(getAssetClass('EUR', 'KUCOIN')).toBe('FX'); // TAG_PATTERNS
    expect(_getAssetClassLedgerForTest()!.unmapped).toEqual([
      { venue: 'ASTER', tag: 'symbolType:2', natives: ['NEWUSDT'] },
      { venue: 'KUCOIN', tag: 'FOREX', natives: ['EURUSDTM'] },
      { venue: 'WEEX', tag: 'Bonds', natives: ['BUNDUSDT'] },
    ]);
    for (const v of ['ASTER', 'KUCOIN', 'WEEX']) expect(_getAssetClassLedgerForTest()!.failed).not.toContain(v);

    _clearAssetClassCache();
    payloads = {
      [URLS.ASTER]: { symbols: [{ symbol: 'BTCUSDT', contractType: 'PERPETUAL', quoteAsset: 'USDT' }] },
      [URLS.KUCOIN]: { data: [{ symbol: 'XBTUSDTM', type: 'FFWCSX', quoteCurrency: 'USDT' }] },
      [URLS.WEEX]: { symbols: [{ symbol: 'BTCUSDT' }] },
    };
    await _warmForTest();
    expect(_getAssetClassLedgerForTest()!.failed).toEqual(expect.arrayContaining(['ASTER', 'KUCOIN', 'WEEX']));
  });

  it('Phemex: an unknown subtype lands TradFi and is announced; a list with no subtype at all is a failed fetch', async () => {
    _setDetectorsForTest(null); // the REAL detector registry; every other venue fails open
    let payload = phemexProducts([['EURUSDUSDT', 'Listed', 'USDT', 'Forex'], ['BTCUSDT', 'Listed', 'USDT', 'Normal']]);
    (upstreamFetch as unknown as Mock).mockImplementation(async (_cfg: unknown, req: { url: string }) => {
      if (req.url === PHEMEX_URL) return payload;
      throw new Error(`unmocked ${req.url}`);
    });
    await _warmForTest();
    expect(getAssetClass('EURUSD', 'PHEMEX')).toBe('FX'); // TAG_PATTERNS
    expect(_getAssetClassLedgerForTest()!.unmapped).toEqual([{ venue: 'PHEMEX', tag: 'Forex', natives: ['EURUSDUSDT'] }]);
    expect(_getAssetClassLedgerForTest()!.failed).not.toContain('PHEMEX');

    _clearAssetClassCache();
    payload = { code: 0, msg: '', data: { products: [], perpProductsV2: [{ symbol: 'XTIUSDT', status: 'Listed', quoteCurrency: 'USDT' }] } } as typeof payload;
    await _warmForTest();
    expect(_getAssetClassLedgerForTest()!.failed).toContain('PHEMEX');
  });
});
