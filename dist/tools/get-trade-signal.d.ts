import type { TradeSignalResult } from '../types.js';
interface TradeSignalInput {
    coin: string;
    timeframe?: string;
    includeReasoning?: boolean;
}
export declare function getTradeSignal(input: TradeSignalInput): Promise<TradeSignalResult>;
export {};
//# sourceMappingURL=get-trade-signal.d.ts.map