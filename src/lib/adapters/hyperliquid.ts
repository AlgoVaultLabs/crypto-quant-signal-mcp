/**
 * Hyperliquid adapter — implements ExchangeAdapter for the HL public API.
 * Base URL: https://api.hyperliquid.xyz/info
 * All requests are POST, no auth needed for read endpoints.
 */
import type {
  ExchangeAdapter,
  Candle,
  AssetContext,
  FundingData,
  HLCandle,
  HLMetaAndAssetCtxs,
  HLPredictedFunding,
  DexType,
} from '../../types.js';

const BASE_URL = 'https://api.hyperliquid.xyz/info';
const TIMEOUT_MS = 3000;
const MAX_RETRIES = 1;

async function hlPost<T>(body: Record<string, unknown>, retries = MAX_RETRIES): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`HL API ${res.status}: ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('HL API: max retries exceeded');
}

export class HyperliquidAdapter implements ExchangeAdapter {
  getName(): string {
    return 'Hyperliquid';
  }

  async getCandles(coin: string, interval: string, startTime: number, dex: DexType = 'standard'): Promise<Candle[]> {
    // xyz perps require the xyz: prefix for candle fetches
    const apiCoin = dex === 'xyz' ? `xyz:${coin}` : coin;
    const raw = await hlPost<HLCandle[]>({
      type: 'candleSnapshot',
      req: { coin: apiCoin, interval, startTime },
    });
    return (raw || []).map(c => ({
      open: parseFloat(c.o),
      high: parseFloat(c.h),
      low: parseFloat(c.l),
      close: parseFloat(c.c),
      volume: parseFloat(c.v),
      time: c.t,
    }));
  }

  async getAssetContext(coin: string, dex: DexType = 'standard'): Promise<AssetContext> {
    const body: Record<string, unknown> = { type: 'metaAndAssetCtxs' };
    if (dex === 'xyz') body.dex = 'xyz';

    const raw = await hlPost<[HLMetaAndAssetCtxs['meta'], HLMetaAndAssetCtxs['assetCtxs']]>(body);
    const meta = raw[0];
    const ctxs = raw[1];
    const idx = meta.universe.findIndex(a => a.name === coin);
    if (idx === -1) {
      throw new Error(`${coin} not found on Hyperliquid${dex === 'xyz' ? ' (xyz dex)' : ''}`);
    }
    const ctx = ctxs[idx];
    return {
      coin,
      funding: parseFloat(ctx.funding || '0'),
      openInterest: parseFloat(ctx.openInterest || '0'),
      prevDayPx: parseFloat(ctx.prevDayPx || '0'),
      volume24h: parseFloat(ctx.dayNtlVlm || '0'),
      oraclePx: parseFloat(ctx.oraclePx || '0'),
      markPx: parseFloat(ctx.markPx || '0'),
    };
  }

  async getPredictedFundings(): Promise<FundingData[]> {
    const raw = await hlPost<HLPredictedFunding[]>({ type: 'predictedFundings' });
    return raw.map(entry => ({
      coin: entry[0],
      venues: (entry[1] || [])
        .filter(([, data]) => data != null && data.fundingRate != null)
        .map(([venue, data]) => ({
          venue,
          fundingRate: parseFloat(data.fundingRate) || 0,
          nextFundingTime: data.nextFundingTime ?? 0,
        })),
    }));
  }

  async getCurrentPrice(coin: string, dex: DexType = 'standard'): Promise<number | null> {
    try {
      const ctx = await this.getAssetContext(coin, dex);
      return ctx.oraclePx || ctx.markPx;
    } catch {
      return null;
    }
  }
}
