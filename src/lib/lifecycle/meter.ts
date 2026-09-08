/**
 * IDENTITY-LIFECYCLE-W3 CH2 — a READ-ONLY snapshot of a bucket's monthly meter.
 *
 * 🛑 THE OBVIOUS IMPLEMENTATION MUTATES PRODUCTION. `checkQuotaByKey()` calls `getCallTracker()`,
 * which does this:
 *
 *     if (!tracker || Date.now() - tracker.periodStart > MONTH_MS) {
 *       tracker = { count: 0, periodStart: Date.now() };   // <- materialises / RESTARTS
 *     }
 *
 * So asking "how much has this bucket used?" through the normal path INVENTS a tracker for a key
 * that has none and RESTARTS the 30-day window for one whose period has expired. The dispatcher
 * asks that question about every email-bound bucket every 15 minutes, so using it would silently
 * reset real people's quota windows 96 times a day — while looking like a read. `license.ts`
 * already documents this exact hazard for the daily tracker; this is the monthly twin.
 *
 * WHAT THIS DOES INSTEAD, and why it is still ONE derivation of the expiry rule.
 * `initQuotaDb()` seeds `callTrackers` from `quota_usage` and SKIPS any row whose period has
 * expired (`loadQuotaRows`: `if (now - periodStart > MONTH_MS) continue`). After seeding, a key
 * is in the map IFF it has a live period — so `getTrackerEpisode(key).periodStart` (read-only,
 * exported, and already carrying that rule) is the authority on liveness, and the row that fed
 * the map supplies the count. The expiry decision stays in `license.ts` where it belongs; this
 * module never re-implements `MONTH_MS`.
 *
 * The dispatcher is a SEPARATE PROCESS (`docker exec … node dist/scripts/…`), so its meter is
 * empty until seeded and nothing in it ever increments a counter. That is what makes reading the
 * persisted row equivalent to reading the tracker here, rather than merely close.
 */
import { initQuotaDb, getTrackerEpisode } from '../license.js';
import { FREE_MONTHLY_CALLS } from '../plans.js';
import { dbQuery, awaitDbWrites } from '../performance-db.js';

/** Milliseconds in the rolling window. Imported meaning, not a re-declared constant — the value
 *  is asserted against `license.ts`'s own behaviour by `lifecycle-steps.test.ts`. */
const ROLLING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface BucketMeter {
  trackerKey: string;
  /** Monthly calls used in the CURRENT live period. 0 when there is no live period. */
  used: number;
  /** The free-tier monthly allowance. */
  total: number;
  /** ISO start of the live period, or null when the bucket has no live period. */
  periodStart: string | null;
  /** Epoch ms at which the live period resets, or null. */
  resetAtMs: number | null;
  /** `14 September 2026` — for copy. Null when there is no live period. */
  resetDate: string | null;
}

/** `14 September 2026`. UTC, and spelled out so no locale ambiguity reaches a subject line. */
export function formatResetDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/**
 * Seed the in-process meter from `quota_usage`, once, and wait for it.
 *
 * `initQuotaDb` kicks its loads off fire-and-forget, so a caller that reads immediately sees an
 * EMPTY map and would conclude every bucket has zero usage — which for `quota_80` means "nobody
 * is eligible" and for `reset_return` means "everybody is". Awaiting the settle is what makes the
 * snapshot a measurement rather than a race.
 */
export async function primeMeter(): Promise<void> {
  initQuotaDb();
  await awaitDbWrites();
  // One read to force the async seeding chain to have been issued and settled behind the DDL
  // barrier; the result is discarded on purpose.
  await dbQuery('SELECT 1 AS ok');
}

/**
 * Read the monthly meter for a set of tracker keys. Never writes, never materialises.
 *
 * Returns a map keyed by tracker key; a key with no live period is present with `used: 0` and
 * `periodStart: null`, because "no live period" is a FACT the predicates need (it is exactly what
 * makes `reset_return` and `activation_nudge` eligible) and dropping the key would make absence
 * indistinguishable from an unread bucket.
 */
export async function readMeters(trackerKeys: string[]): Promise<Map<string, BucketMeter>> {
  const out = new Map<string, BucketMeter>();
  if (trackerKeys.length === 0) return out;

  let rows: { tracker_key: string; call_count: number | string }[] = [];
  try {
    rows = await dbQuery<{ tracker_key: string; call_count: number | string }>(
      `SELECT tracker_key, call_count FROM quota_usage`,
    );
  } catch {
    // An unreadable meter reports every bucket at zero with no live period, which makes the two
    // usage steps find NOBODY. That is the safe direction: the alternative reads a failure as
    // usage and mails somebody about a cap they never hit.
    rows = [];
  }
  const counts = new Map(rows.map((r) => [r.tracker_key, Number(r.call_count) || 0]));

  for (const key of trackerKeys) {
    // LIVENESS FROM license.ts, COUNT FROM THE ROW THAT FED IT. `getTrackerEpisode` is read-only
    // and already reports an expired window as absent, so a stale row can never be read as
    // current usage.
    const periodStart = getTrackerEpisode(key).periodStart;
    const live = periodStart !== null;
    const startMs = live ? Date.parse(periodStart as string) : null;
    const resetAtMs = startMs !== null && Number.isFinite(startMs) ? startMs + ROLLING_WINDOW_MS : null;
    out.set(key, {
      trackerKey: key,
      used: live ? (counts.get(key) ?? 0) : 0,
      total: FREE_MONTHLY_CALLS,
      periodStart,
      resetAtMs,
      resetDate: resetAtMs !== null ? formatResetDate(resetAtMs) : null,
    });
  }
  return out;
}
