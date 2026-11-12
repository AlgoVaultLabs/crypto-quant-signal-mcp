/**
 * Unit tests for the underlying-type resolver (TRADIFI-SIGNAL-HARDENING-W1, R2/R7).
 *
 * OPS-ASSET-CLASS-TOTALITY-W1: `resolveAssetClass` is a pure projection of the asset-class engine
 * on every venue — Binance included (its second exchangeInfo read is retired). These pin the
 * projection and the floor (engine silent → UNKNOWN for a known TradFi symbol, else CRYPTO),
 * offline through the engine's own record seam.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

// Only `upstreamFetch` is replaced (every other export stays real): the venue-decode blocks drive the
// REAL detector registry over the venue's own payload. The other blocks never fetch (records are loaded directly).
vi.mock('../../src/lib/adapters/_upstream-fetch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/adapters/_upstream-fetch.js')>()),
  upstreamFetch: vi.fn(),
}));

import { resolveAssetClass } from '../../src/lib/underlying-type.js';
import {
  _clearAssetClassCache,
  _loadVenueRecordsForTest,
  _setDetectorsForTest,
  _warmForTest,
} from '../../src/lib/asset-class-detection.js';
import { upstreamFetch } from '../../src/lib/adapters/_upstream-fetch.js';

describe('resolveAssetClass — a projection of the engine on every venue', () => {
  beforeEach(() => _clearAssetClassCache());
  afterEach(() => _clearAssetClassCache());

  it('Binance classes come from its own records, through the one tag table (E1: HK/CN/FX no longer dropped)', async () => {
    _loadVenueRecordsForTest({ BINANCE: [
      ['BTCUSDT', 'PERPETUAL'], ['TSLAUSDT', 'EQUITY'], ['ANTHROPICUSDT', 'PREMARKET'], ['XAUUSDT', 'COMMODITY'],
      ['SAMSUNGUSDT', 'KR_EQUITY'], ['TENCENTUSDT', 'HK_EQUITY'], ['CXMTUSDT', 'CN_EQUITY'], ['USDBRLUSDT', 'FX'],
    ] });
    expect(await resolveAssetClass('BTC', 'BINANCE')).toBe('CRYPTO');
    expect(await resolveAssetClass('TSLA', 'BINANCE')).toBe('EQUITY');
    expect(await resolveAssetClass('ANTHROPIC', 'BINANCE')).toBe('PREMARKET');
    expect(await resolveAssetClass('GOLD', 'BINANCE')).toBe('COMMODITY'); // alias GOLD → XAUUSDT
    expect(await resolveAssetClass('SAMSUNG', 'BINANCE')).toBe('KR_EQUITY');
    expect(await resolveAssetClass('TENCENT', 'BINANCE')).toBe('HK_EQUITY');
    expect(await resolveAssetClass('CXMT', 'BINANCE')).toBe('CN_EQUITY');
    expect(await resolveAssetClass('USDBRL', 'BINANCE')).toBe('FX');
  });

  it('other venues read the same engine (own record, then the union)', async () => {
    _loadVenueRecordsForTest({ BINANCE: [['TSLAUSDT', 'EQUITY']], OKX: [['BB-USDT-SWAP', '3']] });
    expect(await resolveAssetClass('BB', 'OKX')).toBe('EQUITY');
    expect(await resolveAssetClass('TSLA', 'KUCOIN')).toBe('EQUITY');
    expect(await resolveAssetClass('BTC', 'HL')).toBe('CRYPTO'); // nothing knows BTC here; not TradFi
  });

  it('the engine silent: STATIC seed, else UNKNOWN for a known TradFi symbol, else CRYPTO', async () => {
    // No records, no warm (VITEST guard): the engine's cold STATIC floor.
    expect(await resolveAssetClass('TSLA', 'BINANCE')).toBe('EQUITY');
    expect(await resolveAssetClass('ANTHROPIC', 'BINANCE')).toBe('PREMARKET');
    expect(await resolveAssetClass('BTC', 'BINANCE')).toBe('CRYPTO');
    // DXY is in asset-tiers TRADFI_FALLBACK (isKnownTradFi) but intentionally NOT in
    // STATIC_ASSET_CLASS_MAP (FX, no confident session) → UNKNOWN.
    expect(await resolveAssetClass('DXY', 'BINANCE')).toBe('UNKNOWN');
  });
});

describe('OPS-ASSET-CLASS-XT-DECODE-W1 — XT books resolve through XT’s own record', () => {
  // XT's own symbol list, as served 2026-11-12T09:49Z (fields the detector reads, verbatim).
  // Measured defect: no field venue lists USDTRY / USDNOK / NZDUSD / DE30EUR, so while XT sat in the
  // union these four fell to the floor and resolved CRYPTO (AUD resolved only because MEXC lists it).
  const XT_URL = 'https://fapi.xt.com/future/market/v1/public/symbol/list';
  const XT_PAYLOAD = { returnCode: 0, msgInfo: 'success', error: null, result: [
    { symbol: 'usdtry_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: ['FOREX'], labels: ['FOREX'] },
    { symbol: 'usdnok_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: ['FOREX'], labels: ['FOREX'] },
    { symbol: 'nzdusd_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: ['FOREX'], labels: ['FOREX'] },
    { symbol: 'de30eur_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: ['INDEX'], labels: ['INDEX'] },
    { symbol: 'aud_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: ['FOREX'], labels: ['FOREX'] },
    { symbol: 'btc_usdt', contractType: 'PERPETUAL', quoteCoin: 'usdt', tags: null, labels: ['HOT'] },
  ] };

  beforeEach(() => {
    _clearAssetClassCache();
    (upstreamFetch as unknown as Mock).mockReset();
    (upstreamFetch as unknown as Mock).mockImplementation(async (_cfg: unknown, req: { url: string }) => {
      if (req.url === XT_URL) return XT_PAYLOAD;
      throw new Error(`unmocked ${req.url}`); // every other venue fails open: XT's record alone decides
    });
  });
  afterEach(() => _clearAssetClassCache());

  it('XT FX and index books resolve to their TradFi class, never the CRYPTO floor', async () => {
    _setDetectorsForTest(null); // the REAL detector registry
    await _warmForTest();
    expect(await resolveAssetClass('USDTRY', 'XT')).toBe('FX');
    expect(await resolveAssetClass('USDNOK', 'XT')).toBe('FX');
    expect(await resolveAssetClass('NZDUSD', 'XT')).toBe('FX');
    expect(await resolveAssetClass('DE30EUR', 'XT')).toBe('INDEX');
    expect(await resolveAssetClass('AUD', 'XT')).toBe('FX');
    expect(await resolveAssetClass('BTC', 'XT')).toBe('CRYPTO');
  });
});

describe('OPS-ASSET-CLASS-HTX-DECODE-W1 — HTX books resolve through HTX’s own record', () => {
  // HTX's own contract list, as served 2026-11-12T12:01Z (fields the detector reads, verbatim).
  // Measured defect: no field venue lists NASDAQ100 (Gate lists NASDAQ), so while HTX sat in the
  // union it fell to the floor and resolved CRYPTO: Tier 4 in the public track record (121 calls).
  const HTX_URL = 'https://api.hbdm.com/linear-swap-api/v1/swap_contract_info';
  const swap = (code: string, labels: string[], tradfi_labels: string[]) => (
    { symbol: code.replace(/-USDT$/, ''), contract_code: code, business_type: 'swap', contract_status: 1, labels, tradfi_labels });
  const HTX_PAYLOAD = { status: 'ok', data: [
    swap('NASDAQ100-USDT', ['tradfi', 'indices', 'new', 'common'], ['Indices']),
    swap('USOIL-USDT', ['tradfi', 'commodities', 'new', 'common'], ['Commodities']),
    swap('PURR-USDT', ['tradfi', 'stock'], ['Stocks']),
    swap('BKNG-USDT', ['stock'], []), // HTX names the class only in `labels` on 86 contracts
    swap('XAU-USDT', ['tradfi', 'commodities', 'common'], ['Metals']),
    swap('BTC-USDT', ['hot', 'common'], []),
  ], ts: 1794484904064 };

  beforeEach(() => {
    _clearAssetClassCache();
    (upstreamFetch as unknown as Mock).mockReset();
    (upstreamFetch as unknown as Mock).mockImplementation(async (_cfg: unknown, req: { url: string }) => {
      if (req.url === HTX_URL) return HTX_PAYLOAD;
      throw new Error(`unmocked ${req.url}`); // every other venue fails open: HTX's record alone decides
    });
  });
  afterEach(() => _clearAssetClassCache());

  it('HTX index, commodity and stock books resolve to their TradFi class, never the CRYPTO floor', async () => {
    _setDetectorsForTest(null); // the REAL detector registry
    await _warmForTest();
    expect(await resolveAssetClass('NASDAQ100', 'HTX')).toBe('INDEX');
    expect(await resolveAssetClass('USOIL', 'HTX')).toBe('COMMODITY');
    expect(await resolveAssetClass('PURR', 'HTX')).toBe('EQUITY'); // Hyperliquid Strategies Inc.; PURR@HL is the token
    expect(await resolveAssetClass('BKNG', 'HTX')).toBe('EQUITY');
    expect(await resolveAssetClass('GOLD', 'HTX')).toBe('COMMODITY'); // adapter alias GOLD → XAU-USDT
    expect(await resolveAssetClass('BTC', 'HTX')).toBe('CRYPTO');
  });
});

describe('OPS-ASSET-CLASS-PHEMEX-DECODE-W1 — Phemex books resolve through Phemex’s own record', () => {
  // Phemex's own product list, as served 2026-11-12T15:17Z (fields the detector reads, verbatim).
  // Measured defect: no field venue lists XTI, XBR, MUX, SPYX or CATX, so while Phemex sat in the
  // union they fell to the floor and resolved CRYPTO: Tier 4 in the public track record (716 calls).
  const PHEMEX_URL = 'https://api.phemex.com/public/products';
  const perp = (symbol: string, status: string, perpProductSubType: string, perpProductSubGroup?: string) => (
    { symbol, status, quoteCurrency: 'USDT', perpProductSubType, ...(perpProductSubGroup ? { perpProductSubGroup } : {}) });
  const PHEMEX_PAYLOAD = { code: 0, msg: '', data: { perpProductsV2: [
    perp('XTIUSDT', 'Listed', 'TradFi', 'Commodities'), // WTI crude
    perp('XBRUSDT', 'Listed', 'TradFi', 'Commodities'), // Brent crude
    perp('MUXUSDT', 'Listed', 'TradFi', 'Stocks'),
    perp('SPYXUSDT', 'Listed', 'TradFi', 'Indices'),
    perp('CATXUSDT', 'Delisted', 'TradFi', 'Stocks'), // delisted, still in the public track record
    perp('XAUUSDT', 'Listed', 'TradFi', 'Metals'),
    perp('OPENAIUSDT', 'Listed', 'PreMarket'),
    perp('BTCUSDT', 'Listed', 'Normal'),
  ] } };

  beforeEach(() => {
    _clearAssetClassCache();
    (upstreamFetch as unknown as Mock).mockReset();
    (upstreamFetch as unknown as Mock).mockImplementation(async (_cfg: unknown, req: { url: string }) => {
      if (req.url === PHEMEX_URL) return PHEMEX_PAYLOAD;
      throw new Error(`unmocked ${req.url}`); // every other venue fails open: Phemex's record alone decides
    });
  });
  afterEach(() => _clearAssetClassCache());

  it('Phemex commodity, stock and index books resolve to their TradFi class, never the CRYPTO floor', async () => {
    _setDetectorsForTest(null); // the REAL detector registry
    await _warmForTest();
    expect(await resolveAssetClass('XTI', 'PHEMEX')).toBe('COMMODITY');
    expect(await resolveAssetClass('XBR', 'PHEMEX')).toBe('COMMODITY');
    expect(await resolveAssetClass('MUX', 'PHEMEX')).toBe('EQUITY');
    expect(await resolveAssetClass('SPYX', 'PHEMEX')).toBe('INDEX');
    expect(await resolveAssetClass('CATX', 'PHEMEX')).toBe('EQUITY');
    expect(await resolveAssetClass('GOLD', 'PHEMEX')).toBe('COMMODITY'); // adapter alias GOLD → XAUUSDT
    expect(await resolveAssetClass('OPENAI', 'PHEMEX')).toBe('PREMARKET');
    expect(await resolveAssetClass('BTC', 'PHEMEX')).toBe('CRYPTO');
  });
});

describe('OPS-TIER-CLASSIFIER-DECODE-W2 — Aster, KuCoin and WEEX books resolve through their own record', () => {
  // Each venue's own list, shapes as served 2026-11-12T17:08Z (fields the detectors read, verbatim), plus
  // Gate's RTX and US30 records. Measured defects:
  // - KUCOIN ACNX (assetClass STOCK, 251.76 USDT) and WEEX KKR (TRADIFI_PERPETUAL Stocks) are listed by
  //   no other venue, so they fell to the CRYPTO floor (Tier 4).
  // - ASTER RTX is a 0.22 USDT token (symbolType 0), but the union read it as Gate's Raytheon (Tier 3, 126 calls).
  const URLS = {
    ASTER: 'https://fapi.asterdex.com/fapi/v1/exchangeInfo',
    KUCOIN: 'https://api-futures.kucoin.com/api/v1/contracts/active',
    WEEX: 'https://api-contract.weex.com/capi/v3/market/exchangeInfo',
    GATE: 'https://api.gateio.ws/api/v4/futures/usdt/contracts',
  };
  const aster = (symbol: string, symbolType: number, underlyingSubType: string[]) => (
    { symbol, contractType: 'PERPETUAL', quoteAsset: 'USDT', underlyingType: 'COIN', symbolType, underlyingSubType });
  const kucoin = (symbol: string, assetClass: string, subMarketType: string | null, marketStage = 'NORMAL') => (
    { symbol, type: 'FFWCSX', quoteCurrency: 'USDT', assetClass, subMarketType, marketStage });
  const weex = (symbol: string, contractType: string, underlyingType: string) => (
    { symbol, contractType, underlyingType, quoteAsset: 'USDT' });
  const PAYLOADS: Record<string, unknown> = {
    [URLS.ASTER]: { symbols: [
      aster('RTXUSDT', 0, []), // a token; Gate's RTX is Raytheon
      aster('OPENAIUSDT', 1, ['pre-launch', 'STOCK']),
      aster('CLUSDT', 1, ['Commodities']),
      aster('BTCUSDT', 0, ['Top']),
    ] },
    [URLS.KUCOIN]: { code: '200000', data: [
      kucoin('ACNXUSDTM', 'STOCK', 'US.STOCK'),
      kucoin('SHEINHKDUSDTM', 'STOCK', 'HK.STOCK'),
      kucoin('MOONSHOTUSDTM', 'STOCK', 'HK.STOCK', 'PRE_MARKET'),
      kucoin('XAUTUSDTM', 'METAL', null), // the adapter's GOLD
      kucoin('XBTUSDTM', 'CRYPTO', null), // the adapter's BTC
    ] },
    [URLS.WEEX]: { symbols: [
      weex('KKRUSDT', 'TRADIFI_PERPETUAL', 'Stocks'),
      weex('US30USDT', 'TRADIFI_PERPETUAL', 'Stocks'), // the Dow, filed under Stocks
      weex('EURUSDT', 'TRADIFI_PERPETUAL', 'Forex'),
      weex('YMTCUSDT', 'TRADIFI_PERPETUAL', 'Pre-IPO'),
      weex('ALLUSDT', 'TRADIFI_PERPETUAL', 'Indices'), // Allora, a 0.50 USDT token WEEX files under Indices
      weex('ETHUSDT', 'PERPETUAL', 'COIN'),
    ] },
    [URLS.GATE]: [{ name: 'RTX_USDT', contract_type: 'stocks' }, { name: 'US30_USDT', contract_type: 'indices' }],
  };

  beforeEach(() => {
    _clearAssetClassCache();
    (upstreamFetch as unknown as Mock).mockReset();
    (upstreamFetch as unknown as Mock).mockImplementation(async (_cfg: unknown, req: { url: string }) => {
      if (req.url in PAYLOADS) return PAYLOADS[req.url];
      throw new Error(`unmocked ${req.url}`); // every other venue fails open
    });
  });
  afterEach(() => _clearAssetClassCache());

  it('each venue’s own record decides its book: TradFi books leave the CRYPTO floor, and a token leaves Tier 3', async () => {
    _setDetectorsForTest(null); // the REAL detector registry
    await _warmForTest();
    expect(await resolveAssetClass('ACNX', 'KUCOIN')).toBe('EQUITY');
    expect(await resolveAssetClass('KKR', 'WEEX')).toBe('EQUITY');
    expect(await resolveAssetClass('RTX', 'ASTER')).toBe('CRYPTO');
    expect(await resolveAssetClass('RTX', 'GATE')).toBe('EQUITY');      // Gate's own Raytheon record still decides on Gate
    expect(await resolveAssetClass('US30', 'WEEX')).toBe('INDEX');      // level-0 Stocks refined by Gate's level-2 indices
    expect(await resolveAssetClass('EUR', 'WEEX')).toBe('FX');
    expect(await resolveAssetClass('YMTC', 'WEEX')).toBe('PREMARKET');
    expect(await resolveAssetClass('ALL', 'WEEX')).toBe('CRYPTO');      // the deny-list, whatever WEEX files it under
    expect(await resolveAssetClass('SHEINHKD', 'KUCOIN')).toBe('HK_EQUITY');
    expect(await resolveAssetClass('MOONSHOT', 'KUCOIN')).toBe('PREMARKET');
    expect(await resolveAssetClass('GOLD', 'KUCOIN')).toBe('COMMODITY'); // adapter alias GOLD → XAUTUSDTM
    expect(await resolveAssetClass('BTC', 'KUCOIN')).toBe('CRYPTO');
    expect(await resolveAssetClass('OPENAI', 'ASTER')).toBe('PREMARKET');
    expect(await resolveAssetClass('CL', 'ASTER')).toBe('COMMODITY');
  });
});
