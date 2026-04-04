"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBackfill = runBackfill;
exports.getSignalPerformance = getSignalPerformance;
const performance_db_js_1 = require("../lib/performance-db.js");
const performance_db_js_2 = require("../lib/performance-db.js");
const hyperliquid_js_1 = require("../lib/hyperliquid.js");
/**
 * Run a lightweight backfill pass: check for signals that need outcome prices.
 * Called lazily on resource access.
 */
async function runBackfill() {
    const horizons = [1, 4, 24];
    for (const h of horizons) {
        const signals = (0, performance_db_js_2.getSignalsNeedingBackfill)(h);
        for (const sig of signals) {
            try {
                const price = await (0, hyperliquid_js_1.fetchCurrentPrice)(sig.coin);
                if (price === null)
                    continue;
                const returnPct = ((price - sig.price_at_signal) / sig.price_at_signal) * 100;
                const field = `price_after_${h}h`;
                const retField = `return_pct_${h}h`;
                (0, performance_db_js_2.updateOutcome)(sig.id, field, price, retField, parseFloat(returnPct.toFixed(4)));
            }
            catch {
                // Skip failed fetches silently
            }
        }
    }
}
/**
 * Get signal performance stats (the MCP resource handler).
 */
async function getSignalPerformance() {
    // Best-effort backfill before returning stats
    try {
        await runBackfill();
    }
    catch {
        // Don't fail the resource if backfill fails
    }
    return (0, performance_db_js_1.getPerformanceStats)();
}
//# sourceMappingURL=signal-performance.js.map