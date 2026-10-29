/**
 * Unit tests for the underlying-type resolver (TRADIFI-SIGNAL-HARDENING-W1, R2/R7).
 *
 * OPS-ASSET-CLASS-TOTALITY-W1: `resolveAssetClass` is a pure projection of the asset-class engine
 * on every venue — Binance included (its second exchangeInfo read is retired). These pin the
 * projection and the floor (engine silent → UNKNOWN for a known TradFi symbol, else CRYPTO),
 * offline through the engine's own record seam.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveAssetClass } from '../../src/lib/underlying-type.js';
import { _clearAssetClassCache, _loadVenueRecordsForTest } from '../../src/lib/asset-class-detection.js';

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
