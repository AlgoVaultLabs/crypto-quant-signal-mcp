/**
 * Unit tests for the underlying-type resolver (TRADIFI-SIGNAL-HARDENING-W1, R2/R7).
 *
 * OPS-ASSET-CLASS-TOTALITY-W1: `resolveAssetClass` is a pure projection of the asset-class engine
 * on every venue — Binance included (its second exchangeInfo read is retired). These pin the
 * projection and the floor (engine silent → UNKNOWN for a known TradFi symbol, else CRYPTO),
 * offline through the engine's own record seam.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

// Only `upstreamFetch` is replaced (every other export stays real): the XT and HTX blocks drive the
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
