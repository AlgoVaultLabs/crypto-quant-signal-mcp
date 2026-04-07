import { getPerformanceStatsAsync } from '../lib/performance-db.js';
import { getSignalsNeedingBackfillAsync, getSignalsNeedingBackfill15mAsync, updateOutcome } from '../lib/performance-db.js';
import { getAdapter } from '../lib/exchange-adapter.js';
import type { PerformanceStats } from '../types.js';

/**
 * Run a lightweight backfill pass: check for signals that need outcome prices.
 * Called lazily on resource access.
 */
export async function runBackfill(): Promise<void> {
  const adapter = getAdapter();

  // 15-minute backfill (v3)
  try {
    const signals15m = await getSignalsNeedingBackfill15mAsync();
    for (const sig of signals15m) {
      try {
        const price = await adapter.getCurrentPrice(sig.coin);
        if (price === null) continue;
        const returnPct = ((price - sig.price_at_signal) / sig.price_at_signal) * 100;
        updateOutcome(sig.id!, 'price_after_15m', price, 'return_pct_15m', parseFloat(returnPct.toFixed(4)));
      } catch {
        // Skip failed fetches silently
      }
    }
  } catch {
    // Skip 15m backfill errors silently
  }

  // Hourly backfills (1h / 4h / 24h)
  const horizons = [1, 4, 24] as const;
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
 * Backfill runs in the background — never blocks the response.
 */
export async function getSignalPerformance(): Promise<PerformanceStats> {
  // Fire-and-forget backfill — don't block the resource response
  runBackfill().catch(() => {});
  return getPerformanceStatsAsync();
}
