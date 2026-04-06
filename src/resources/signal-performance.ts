import { getPerformanceStatsAsync } from '../lib/performance-db.js';
import { getSignalsNeedingBackfillAsync, updateOutcome } from '../lib/performance-db.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import type { PerformanceStats } from '../types.js';

/**
 * Run a lightweight backfill pass: check for signals that need outcome prices.
 * Called lazily on resource access.
 */
export async function runBackfill(): Promise<void> {
  const horizons = [1, 4, 24] as const;
  const adapter = getAdapter();

  for (const h of horizons) {
    const signals = await getSignalsNeedingBackfillAsync(h);
    for (const sig of signals) {
      try {
        const price = await adapter.getCurrentPrice(sig.coin);
        if (price === null) continue;
        const returnPct = ((price - sig.price_at_signal) / sig.price_at_signal) * 100;
        const field = `price_after_${h}h` as const;
        const retField = `return_pct_${h}h` as const;
        updateOutcome(sig.id!, field, price, retField, parseFloat(returnPct.toFixed(4)));
      } catch {
        // Skip failed fetches silently
      }
    }
  }
}

/**
 * Get signal performance stats (the MCP resource handler).
 */
export async function getSignalPerformance(): Promise<PerformanceStats> {
  // Best-effort backfill before returning stats
  try {
    await runBackfill();
  } catch {
    // Don't fail the resource if backfill fails
  }
  return getPerformanceStatsAsync();
}
