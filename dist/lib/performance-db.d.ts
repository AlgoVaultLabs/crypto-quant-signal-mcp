import Database from 'better-sqlite3';
import type { SignalRecord, SignalVerdict, PerformanceStats } from '../types.js';
export declare function getDb(): Database.Database;
export declare function closeDb(): void;
export declare function recordSignal(coin: string, signal: SignalVerdict, confidence: number, timeframe: string, priceAtSignal: number): void;
/**
 * Find signals that need outcome backfill.
 * Returns signals older than the threshold with null outcome fields.
 */
export declare function getSignalsNeedingBackfill(hoursAgo: 1 | 4 | 24): SignalRecord[];
export declare function updateOutcome(id: number, field: 'price_after_1h' | 'price_after_4h' | 'price_after_24h', price: number, returnPctField: 'return_pct_1h' | 'return_pct_4h' | 'return_pct_24h', returnPct: number): void;
export declare function getPerformanceStats(): PerformanceStats;
//# sourceMappingURL=performance-db.d.ts.map