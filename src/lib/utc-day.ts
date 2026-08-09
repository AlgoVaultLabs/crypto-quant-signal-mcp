/**
 * UTC calendar-day boundaries — the ONE derivation, extracted so both sides of the daily meter
 * can share it (PRICING-FOLLOWUPS-GENERATOR-W1 CH1).
 *
 * WHY THIS MODULE EXISTS. R-B's daily meter is ENFORCED in `license.ts` and RENDERED in
 * `quota-notice.ts`, and those two may not import each other: `license.ts` imports
 * `nudge-copy.ts` and consumes `quota-notice.ts`, so an import the other way closes a cycle.
 * `quota-notice.ts` already carries one duplicated constant for exactly that reason
 * (`FALLBACK_WINDOW_MS`, a copy of `license.MONTH_MS`) and says so in its own comment.
 *
 * Duplicating the day-boundary arithmetic a second time is what this module refuses. The daily
 * wall's retry hint is the number a walled caller acts on; two implementations of it is two
 * chances to disagree about when access returns. So the arithmetic moves DOWN into a leaf that
 * imports nothing, and both modules project from it — the shared-derivation-engine-as-leaf
 * pattern this repo already uses to break consumer cycles.
 *
 * LEAF: imports nothing, and must stay that way. Anything that needs a plan value, a price or a
 * tier belongs in the consumer, not here.
 */

const HOUR_MS = 60 * 60 * 1000;

/** The UTC calendar day an instant belongs to (`2026-08-08`). */
export function utcDayKey(atMs: number = Date.now()): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/**
 * The instant the next UTC day begins — epoch ms of the following 00:00:00Z.
 *
 * Exported alongside the hours form because the two callers need different shapes of the same
 * fact: the meter wants the INSTANT (it becomes the notice's `resets_at`), the copy wants the
 * DURATION. Deriving the duration from the instant, here, is what keeps them consistent.
 */
export function utcDayResetAtMs(atMs: number = Date.now()): number {
  const d = new Date(atMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Whole hours until the next 00:00 UTC, floored at 1 while the day is still running.
 *
 * The retry hint a DAILY wall needs. `daysUntilMonthReset` would answer "27 days" to a caller
 * who is back in business after lunch, which is worse than saying nothing — it reads as a
 * month-long lockout and is the kind of wrong-but-confident number that loses a subscriber.
 * Returns at least 1 so the copy never renders "come back in 0 hours".
 *
 * ⚠️ This function shipped in CH4 of PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 exported,
 * unit-tested, deployed — and called by NOTHING. Production told daily-walled callers "30 days"
 * for a day and a half because the only assertions pointed at the primitive rather than at the
 * path. It now has a real consumer (`quota-notice.buildQuotaNoticeMessage`) and a wiring
 * assertion that fails if it loses one again.
 */
export function hoursUntilUtcDayReset(atMs: number = Date.now()): number {
  return Math.max(1, Math.ceil((utcDayResetAtMs(atMs) - atMs) / HOUR_MS));
}
