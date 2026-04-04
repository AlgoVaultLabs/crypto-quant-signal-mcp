import type { HLMetaAndAssetCtxs, HLPredictedFunding, Candle } from '../types.js';
/**
 * Fetch candle data for a coin/interval starting from a given time.
 * Returns parsed Candle[] suitable for indicator calculations.
 */
export declare function fetchCandles(coin: string, interval: string, startTime: number): Promise<Candle[]>;
/**
 * Fetch metadata + live asset context for all perps.
 * Returns funding rates, OI, volume, prices.
 */
export declare function fetchMetaAndAssetCtxs(): Promise<HLMetaAndAssetCtxs>;
/**
 * Fetch predicted funding rates across venues (HL, Binance, Bybit) for all assets.
 */
export declare function fetchPredictedFundings(): Promise<HLPredictedFunding[]>;
/**
 * Fetch the current price for a specific coin using metaAndAssetCtxs.
 */
export declare function fetchCurrentPrice(coin: string): Promise<number | null>;
//# sourceMappingURL=hyperliquid.d.ts.map