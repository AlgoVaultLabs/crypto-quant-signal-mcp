/**
 * regime-snapshot-timeframes.ts — REGIME-TF-ADMISSION-W1 CH1. The ONE literal of the timeframes the regime
 * sampler writes.
 *
 * A LEAF on purpose: it imports nothing. `regime-snapshots.ts` re-exports it (every importer of that module is
 * unchanged), and `tool-param-schema.ts` — which the docs builders load from dist — imports it here, so the
 * snapshot-served tools (`scan_market_regimes`, `pre_trade_check`) take the sampler's set without pulling
 * performance-db into a pure declaration module. `serving-windows.ts` keeps its own private copy, pinned equal to
 * this one by tests/unit/serving-windows.test.ts.
 */

/** The timeframes the sampler produces. `get_market_regime`'s own set is `REGIME_TIMEFRAMES` (tool-param-schema.ts). */
export const REGIME_SNAPSHOT_TIMEFRAMES = ['1h', '4h', '1d'] as const;
export type RegimeSnapshotTimeframe = (typeof REGIME_SNAPSHOT_TIMEFRAMES)[number];
