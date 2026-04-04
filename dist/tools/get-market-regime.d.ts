import type { MarketRegimeResult } from '../types.js';
interface MarketRegimeInput {
    coin: string;
    timeframe?: string;
}
export declare function getMarketRegime(input: MarketRegimeInput): Promise<MarketRegimeResult>;
export {};
//# sourceMappingURL=get-market-regime.d.ts.map