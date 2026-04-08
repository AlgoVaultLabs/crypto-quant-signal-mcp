import { getPerformanceStatsAsync, getSignalsNeedingUnifiedBackfillAsync, updateUnifiedOutcome } from '../lib/performance-db.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import type { PerformanceStats } from '../types.js';

/**
 * Run a lightweight backfill pass: check for signals that need outcome prices.
 * v1.3: uses unified outcome model — each signal evaluated at its own timeframe.
 * Called lazily on resource access.
 */
export async function runBackfill(): Promise<void> {
  const adapter = getAdapter();

  try {
    const signals = await getSignalsNeedingUnifiedBackfillAsync();
    for (const sig of signals) {
      try {
        const price = await adapter.getCurrentPrice(sig.coin);
        if (price === null) continue;
        const returnPct = ((price - sig.price_at_signal) / sig.price_at_signal) * 100;
        updateUnifiedOutcome(sig.id!, price, parseFloat(returnPct.toFixed(4)));
      } catch {
        // Skip failed fetches silently
      }
    }
  } catch {
    // Skip backfill errors silently
  }
}

/**
 * Get signal performance stats (the MCP resource handler).
 * Backfill runs in the background — never blocks the response.
 */
export async function getSignalPerformance(): Promise<PerformanceStats> {
  // Fire-and-forget backfill — don't block the resource response
  runBackfill().catch(() => {});
  return getPerformanceStatsAsync();
}
