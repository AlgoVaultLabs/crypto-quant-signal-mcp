/**
 * monitor-seed-freshness.ts — OPS-SEED-ORCHESTRATOR-W1 / CH2
 *
 * Pure venue-freshness evaluator for the monitor's critical cycle. Given each
 * promoted venue's most-recent signal timestamp (epoch-MS), decides which
 * venues have gone stale (no new signal within `thresholdMin`). Venue-table-
 * driven: a freshly-promoted venue inherits this monitoring for free. Never
 * pages on a venue that has never produced a signal — it is reported with a
 * sentinel until its first signal exists (mirrors evaluatePfeWinRate's
 * report-not-page posture).
 *
 * The monitor (monitor.ts::checkSeedFreshness) wires the DB query + the
 * consecutive-gated alert path; this module is pure and unit-tested in isolation.
 */

export interface SeedFreshnessRow {
  /** Venue id (signals.exchange), e.g. 'HL', 'BINANCE'. */
  exchange: string;
  /** Epoch-MS of the venue's most recent signal, or null if it has none yet. */
  lastCreatedAtMs: number | null;
}

export interface SeedFreshnessVerdict {
  venue: string;
  /** Minutes since the venue's last signal; -1 sentinel when it has none yet. */
  staleMin: number;
  /** true ⇔ paged-worthy: a venue WITH signals whose newest is ≥ thresholdMin old. */
  stale: boolean;
}

/**
 * R2.1 — pure freshness verdict. `nowMs` and each row's `lastCreatedAtMs` are
 * epoch-MS (the caller converts the DB's epoch-seconds `created_at`). A venue
 * with `lastCreatedAtMs === null` (no signal ever) is reported with staleMin=-1
 * and stale=false: it MUST NOT page until it has produced a first signal.
 */
export function evaluateSeedFreshness(
  rows: SeedFreshnessRow[],
  nowMs: number,
  thresholdMin = 45,
): SeedFreshnessVerdict[] {
  return rows.map((r) => {
    if (r.lastCreatedAtMs == null) {
      return { venue: r.exchange, staleMin: -1, stale: false };
    }
    const staleMin = Math.round((nowMs - r.lastCreatedAtMs) / 60_000);
    return { venue: r.exchange, staleMin, stale: staleMin >= thresholdMin };
  });
}
