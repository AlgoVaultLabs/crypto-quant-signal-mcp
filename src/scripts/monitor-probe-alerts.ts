/**
 * monitor-probe-alerts — OPS-PFE-PROBE-INDETERMINATE-W1
 *
 * ONE declaration of every operator-visible alert string a monitor HTTP probe
 * can return, plus the sentinel `fetchJson()` reports when the fetch THREW.
 *
 * ## Why the strings moved out of monitor.ts
 *
 * `fetchJson()` collapses EVERY throw — abort, ECONNREFUSED, DNS, socket hang
 * up — to `status: 0`, and the three paging call sites each composed their own
 * `HTTP ${status}` template inline. That made `HTTP 0` the single most common
 * failure string the monitor can emit, and it was invisible to
 * `classifyProbeFailure` (`extractHttpStatus` matched `\d{3}`), so a
 * could-not-measure abort paged at `consecutive=1` as though it were a
 * confirmed adverse state. Measured 2026-09-01 06:44:01Z on the PFE check; the
 * endpoint was healthy and the check auto-recovered at 06:46.
 *
 * Three inline copies is also why the gap survived: nothing bound the PRODUCERS
 * of these strings to the classifier that has to read them. They are declared
 * here, once, and `tests/unit/monitor-probe-alerts.test.ts` enumerates this
 * registry — so a probe alert added later is classified the day it is written,
 * rather than the day it pages.
 *
 * Pure + dependency-free ⇒ importable by the gate without loading monitor.ts.
 */

/**
 * The `status` `fetchJson()` reports when the fetch threw and there is no HTTP
 * response at all. NOT a real status code — the absence of one. Every consumer
 * that renders or classifies a probe failure derives "the fetch threw" from
 * THIS constant, never from a literal 0.
 */
export const FETCH_THROW_STATUS = 0;

/**
 * The parenthesised cause clause. `fetchJson()` used to drop `err.message`
 * entirely (it landed in `data`, which every failure path discarded), so the
 * 2026-09-01 page said only "HTTP 0" and the actual cause — a 15 s abort
 * against a 69,744 ms recompute — had to be reconstructed from container logs.
 * Carrying the reason is also defence in depth: the reason text alone
 * ("aborted", "timeout", "ECONNREFUSED") classifies transient even if the
 * numeric leg of the classifier ever regresses again.
 */
export function probeFailureCause(reason?: string | null): string {
  const r = (reason ?? '').trim();
  return r ? ` (${r})` : '';
}

export function serverHealthProbeAlert(status: number, attempts: number, reason?: string | null): string {
  return `Server health check failed (HTTP ${status}) after ${attempts} attempts${probeFailureCause(reason)}`;
}

export function facilitatorProbeAlert(status: number, attempts: number, reason?: string | null): string {
  return `x402 facilitator down (HTTP ${status}) after ${attempts} attempts${probeFailureCause(reason)}`;
}

export function pfeProbeAlert(status: number, attempts: number, reason?: string | null): string {
  return `PFE check failed: performance-public HTTP ${status} after ${attempts} attempts${probeFailureCause(reason)}`;
}

/**
 * There is deliberately NO exported registry array here.
 *
 * The first draft had one, and `scripts/check-dark-exports.mjs` refused the push:
 * it was exported, tested, and called by nothing in `src/` — the exact
 * "declaration only" shape that gate exists to catch, and the gate was right.
 * The enumeration it existed for is better taken from the MODULE'''s own exports
 * (`Object.entries(mod)` filtered to `*ProbeAlert`), which `tests/unit/
 * monitor-probe-alerts.test.ts` does. That keeps the property the registry was
 * for — a probe alert added later is covered the day it is written — without a
 * second list that can disagree with the first.
 *
 * The naming convention IS the contract: any function exported from this module
 * whose name ends in `ProbeAlert` is enumerated and gated.
 */
