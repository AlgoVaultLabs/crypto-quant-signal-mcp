/**
 * tests/unit/exchange-universe-fetchers.test.ts — OPS-SCAN-UNIVERSE-EXPAND-W1.
 *
 * The rich universe fetchers for the newly-promoted venues, via the public dispatch
 * (getExchangeTopAssetsWithVolume / fetchVenueUniverse). Pins: real-OI computation (GATE),
 * volume-PROXY labeling (ASTER oiIsProxy + 1000× override), OI_PROXY_VENUES membership, and the
 * fail-soft-on-unknown-venue contract (a non-promoted / unknown ExchangeId → [], never throws).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getExchangeTopAssetsWithVolume, fetchVenueUniverse, OI_PROXY_VENUES,
} from '../../src/lib/exchange-universe.js';

function resp(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as Response;
}

afterEach(() => vi.restoreAllMocks());

describe('exchange-universe — rich fetchers for the newly-promoted venues', () => {
  it('GATE: real OI = total_size × quanto_multiplier × mark_price, sorted OI-desc, USDT-only', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(resp([
      { contract: 'BTC_USDT', total_size: '1000', quanto_multiplier: '0.0001', mark_price: '60000', volume_24h_quote: '5', change_percentage: '-1.5', funding_rate: '0.0001' },
      { contract: 'ETH_USDT', total_size: '1000', quanto_multiplier: '0.001', mark_price: '3000', volume_24h_quote: '9', change_percentage: '2.0', funding_rate: '-0.0002' },
      { contract: 'SOL_USDC', total_size: '9', quanto_multiplier: '1', mark_price: '1', volume_24h_quote: '1' }, // non-USDT → excluded
    ]));
    const assets = await getExchangeTopAssetsWithVolume('GATE', 5);
    expect(assets.map((a) => a.coin)).toEqual(['BTC', 'ETH']); // BTC 1000×0.0001×60000=6000 > ETH 1000×0.001×3000=3000
    expect(assets[0].notionalOI_usd).toBe(6000);
    expect(assets[0].changePct24h).toBe(-1.5); // Gate change_percentage is already a %
    expect(assets.every((a) => a.oiIsProxy === undefined)).toBe(true); // REAL OI, not a proxy
    expect(assets.some((a) => a.coin === 'SOL')).toBe(false);
  });

  it('ASTER: volume PROXY (oiIsProxy=true, notionalOI = quoteVolume) + 1000× meme override', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(resp([
      { symbol: 'BTCUSDT', quoteVolume: '1000', priceChangePercent: '1.2' },
      { symbol: '1000PEPEUSDT', quoteVolume: '5000', priceChangePercent: '-3.4' },
      { symbol: 'ETHUSDC', quoteVolume: '9999' }, // non-USDT → excluded
    ]));
    const assets = await fetchVenueUniverse('ASTER');
    expect(assets.map((a) => a.coin)).toEqual(['PEPE', 'BTC']); // volume-desc; 1000PEPE → PEPE
    expect(assets[0].oiIsProxy).toBe(true);
    expect(assets[0].notionalOI_usd).toBe(5000); // ranks by the quoteVolume proxy
    expect(assets[0].changePct24h).toBe(-3.4);
  });

  it('fail-soft: a non-promoted / unknown venue returns [] (never throws)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // WEEX gained a fetcher with OPS-WEEX-PROMOTE-W1, so the fail-soft case now uses the two
    // venues that genuinely have none: EDGEX and BITMART, both RETIRED.
    await expect(getExchangeTopAssetsWithVolume('EDGEX', 5)).resolves.toEqual([]);
    await expect(fetchVenueUniverse('BITMART' as never)).resolves.toEqual([]);
  });

  it('OI_PROXY_VENUES = the volume-proxy venues (Binance / Aster / BingX / XT / WEEX)', () => {
    expect(OI_PROXY_VENUES.has('ASTER')).toBe(true);
    expect(OI_PROXY_VENUES.has('BINGX')).toBe(true);
    expect(OI_PROXY_VENUES.has('BINANCE')).toBe(true);
    // OPS-WEEX-PROMOTE-W1: WEEX ranks on quoteVolume — its openInterest endpoint is per-symbol
    // only AND its unit does not reconcile ($10.9B vs $1.09M on contractVal), so a labelled
    // proxy is the honest option and an uninterpretable magnitude is a Factuality hazard.
    expect(OI_PROXY_VENUES.has('WEEX')).toBe(true);
    expect(OI_PROXY_VENUES.has('GATE')).toBe(false);
  });
});
