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
  const FIXTURES: Record<string, unknown> = {
    'https://fapi.binance.com/fapi/v1/exchangeInfo': { symbols: [
      { symbol: 'TENCENTUSDT', contractType: 'TRADIFI_PERPETUAL', underlyingType: 'HK_EQUITY' },
      { symbol: 'USDBRLUSDT', contractType: 'TRADIFI_PERPETUAL', underlyingType: 'FX' },
      { symbol: 'BTCUSDT', contractType: 'PERPETUAL', underlyingType: 'COIN' },
      { symbol: 'BTCUSDC', contractType: 'PERPETUAL', underlyingType: 'COIN' },
      { symbol: 'BTCUSDT_261225', contractType: 'CURRENT_QUARTER', underlyingType: 'COIN' },
    ] },
    'https://api.gateio.ws/api/v4/futures/usdt/contracts': [
      { name: 'NASDAQ_USDT', contract_type: 'indices' }, { name: 'XAG_USDT', contract_type: 'metals' },
      { name: 'EUR_USDT', contract_type: 'forex' }, { name: 'BTC_USDT', contract_type: '' },
    ],
    'https://contract.mexc.com/api/v1/contract/detail': { data: [
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
    expect(_getAssetClassLedgerForTest()!.venues.BINANCE).toMatchObject({ tradfi: 2, crypto: 1 }); // USDC + quarterly skipped
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
    expect(_getAssetClassLedgerForTest()!.unmapped).toEqual([]);
  });
});
