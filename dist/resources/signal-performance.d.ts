import type { PerformanceStats } from '../types.js';
/**
 * Run a lightweight backfill pass: check for signals that need outcome prices.
 * Called lazily on resource access.
 */
export declare function runBackfill(): Promise<void>;
/**
 * Get signal performance stats (the MCP resource handler).
 */
export declare function getSignalPerformance(): Promise<PerformanceStats>;
//# sourceMappingURL=signal-performance.d.ts.map