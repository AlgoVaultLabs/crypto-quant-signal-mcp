/**
 * indeterminate-counter.ts — make the "could not determine" branch OBSERVABLE.
 *
 * OPS-ZERO-VS-UNKNOWN-W1.
 *
 * THE WHOLE 25-HOUR LESSON. `tryClaimPayment`'s fail-safe already logged its DB error to
 * `console.error`. It was still invisible: a line in a container log that **nothing counts** is
 * not an observable signal, and the paid rail served nothing for 25 hours while every gate stayed
 * green. A fault that is distinguishable in code but recorded nowhere is invisible in practice.
 *
 * So the rule this module exists to enforce is narrow and absolute: **when a load-bearing path
 * cannot determine an answer, that fact must land somewhere a canary can read.**
 *
 * DESIGN NOTES, each one load-bearing:
 *
 *  - **In-process counters, not a DB write.** The indeterminate branch fires precisely when a
 *    dependency is broken; a counter that needs the database would be unable to record "the
 *    database is unreachable". It must not share a failure mode with what it measures.
 *
 *  - **Never throws.** This is called from inside catch blocks on the money and auth paths. An
 *    instrument that can break the thing it measures is worse than no instrument.
 *
 *  - **A structured single-line log per event, with a stable prefix.** `[indeterminate]` is what a
 *    host-side canary greps. The counter answers "how many"; the log answers "when and where".
 *
 *  - **Lifetime AND windowed.** A lifetime total hid a 3-day burst on the quota canary and it
 *    never alerted (CLAUDE.md's lifetime-vs-rolling-window discipline). Consumers need the recent
 *    rate, so `since` is exposed and the reader computes the window.
 */

export interface IndeterminateSnapshot {
  /** Total since process start, per declared site. */
  counts: Record<string, number>;
  /** Epoch ms of the most recent event per site — the freshness signal a canary alerts on. */
  lastAt: Record<string, number>;
  /** Epoch ms this counter began observing (process start). Windows are computed from it. */
  since: number;
}

const counts = new Map<string, number>();
const lastAt = new Map<string, number>();
const since = Date.now();

/**
 * Record that a load-bearing path could NOT determine its answer.
 *
 * @param site stable identifier for the call site, e.g. `x402_claim` / `stripe_validate_api_key`.
 *             Keep it coarse and stable — a canary matches on it, and a diagnostic string here
 *             would make the series unqueryable.
 * @param detail optional non-sensitive context for the log line ONLY (never the counter key, or
 *               the cardinality explodes). Must not carry keys, nonces, wallets or SQL.
 */
export function recordIndeterminate(site: string, detail?: string): void {
  try {
    counts.set(site, (counts.get(site) ?? 0) + 1);
    lastAt.set(site, Date.now());
    // One line, stable prefix, machine-greppable. Deliberately console.error: this is an
    // operator-action-required class, not a debug line.
    console.error(
      `[indeterminate] site=${site} total=${counts.get(site)}${detail ? ` detail=${detail}` : ''}`,
    );
  } catch {
    // An instrument must never break the path it instruments.
  }
}

/** Read the counters. Used by the health/metrics surface and by tests. */
export function getIndeterminateSnapshot(): IndeterminateSnapshot {
  return {
    counts: Object.fromEntries(counts),
    lastAt: Object.fromEntries(lastAt),
    since,
  };
}

/** Tests only — module-level state needs an explicit reset seam (CLAUDE.md cache-seam rule). */
export function _resetIndeterminateCounters(): void {
  counts.clear();
  lastAt.clear();
}
