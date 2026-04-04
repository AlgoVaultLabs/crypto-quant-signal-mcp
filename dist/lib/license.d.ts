import type { LicenseInfo } from '../types.js';
export declare function getLicense(): LicenseInfo;
export declare function resetLicenseCache(): void;
export declare function isFreeTier(): boolean;
export declare function canAccessCoin(coin: string): boolean;
export declare function canAccessTimeframe(timeframe: string): boolean;
export declare function getFundingArbLimit(requestedLimit: number): number;
export declare function freeGateMessage(coin: string, timeframe: string): string;
//# sourceMappingURL=license.d.ts.map