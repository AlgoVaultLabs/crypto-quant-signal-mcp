import type { FundingArbResult } from '../types.js';
interface ScanFundingArbInput {
    minSpreadBps?: number;
    limit?: number;
}
export declare function scanFundingArb(input: ScanFundingArbInput): Promise<FundingArbResult>;
export {};
//# sourceMappingURL=scan-funding-arb.d.ts.map