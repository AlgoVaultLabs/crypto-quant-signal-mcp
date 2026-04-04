import type { HLCandle, HLMetaAndAssetCtxs, HLPredictedFunding, Candle } from '../types.js';

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
      // brief pause before retry
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('HL API: max retries exceeded');
}

/**
 * Fetch candle data for a coin/interval starting from a given time.
 * Returns parsed Candle[] suitable for indicator calculations.
 */
export async function fetchCandles(coin: string, interval: string, startTime: number): Promise<Candle[]> {
  const raw = await hlPost<HLCandle[]>({
    type: 'candleSnapshot',
    req: { coin, interval, startTime },
  });
  return raw.map(c => ({
    open: parseFloat(c.o),
    high: parseFloat(c.h),
    low: parseFloat(c.l),
    close: parseFloat(c.c),
    volume: parseFloat(c.v),
    time: c.t,
  }));
}

/**
 * Fetch metadata + live asset context for all perps.
 * Returns funding rates, OI, volume, prices.
 */
export async function fetchMetaAndAssetCtxs(): Promise<HLMetaAndAssetCtxs> {
  const raw = await hlPost<[HLMetaAndAssetCtxs['meta'], HLMetaAndAssetCtxs['assetCtxs']]>({
    type: 'metaAndAssetCtxs',
  });
  return { meta: raw[0], assetCtxs: raw[1] };
}

/**
 * Fetch predicted funding rates across venues (HL, Binance, Bybit) for all assets.
 */
export async function fetchPredictedFundings(): Promise<HLPredictedFunding[]> {
  return hlPost<HLPredictedFunding[]>({ type: 'predictedFundings' });
}

/**
 * Fetch the current price for a specific coin using metaAndAssetCtxs.
 */
export async function fetchCurrentPrice(coin: string): Promise<number | null> {
  const data = await fetchMetaAndAssetCtxs();
  const idx = data.meta.universe.findIndex(a => a.name === coin);
  if (idx === -1) return null;
  const ctx = data.assetCtxs[idx];
  return parseFloat(ctx.oraclePx || ctx.markPx);
}
