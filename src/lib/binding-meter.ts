/**
 * OPS-QUOTA-BINDING-METER-AND-CONVERSION-W1 CH1 — the ONE derivation of "which meter binds".
 *
 * THE CLASS THIS RETIRES: `PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1` (R-B) gave the free tier a
 * SECOND meter — a UTC-day pacing cap alongside the rolling monthly budget — and only the REFUSAL
 * path learned about it. Every surface ahead of the refusal kept dividing by the monthly limit, so
 * a caller pacing at the daily cap was told `remaining: 100` on the same envelope that refused
 * them, got no soft or hard warning, and was pooled with monthly blocks in the scoreboard.
 *
 * The fix is not "teach each surface about the daily meter" — that is the same mistake with a
 * larger blast radius next time. It is to compute "which meter is closest to refusing, and how
 * close" ONCE and have every surface project from that one value (CLAUDE.md single-derivation
 * rule). A third meter — the chat 10/mo meter has this blindness today, webhook quotas are next —
 * then becomes a registration, not a six-file sweep.
 *
 * LEAF. This module imports TYPES ONLY, and that is load-bearing rather than tidy: `license.ts`
 * and `tier-warning.ts` are both CONSUMERS, so a value import back from here would close a cycle —
 * the identical trap `quota-notice.ts` documents in its own header. `--self-test`-style leafness is
 * asserted by `tests/unit/binding-meter.test.ts`, which greps this file's own import list, so the
 * property is checked rather than remembered.
 */
import type { BindingMeterState, MeterReading, QuotaWall } from '../types.js';

/**
 * Is this reading honestly metered?
 *
 * A meter with a non-finite or non-positive limit is EXCLUDED, not zeroed. An unmetered tier
 * (`x402` / `internal`, whose quota is `Infinity`) has no honest ratio — `used / Infinity` is 0,
 * which would render as "0% used" and is a claim about a meter that does not exist. This is
 * `plans.ts`'s own `null is a REFUSAL, not a zero` rule applied one layer down.
 *
 * `used` is guarded the same way and for the same reason, matching `computeTierWarning`'s
 * long-standing defensive pair. Note what is deliberately NOT excluded: `used > limit`. A caller
 * can legitimately sit past a wall (bonus grants, a multi-unit charge landing on the boundary), and
 * a ratio above 1 is the honest reading of that, not an error.
 */
function isMetered(m: MeterReading | null | undefined): m is MeterReading {
  return (
    !!m &&
    Number.isFinite(m.limit) && m.limit > 0 &&
    Number.isFinite(m.used) && m.used >= 0
  );
}

/** `used / limit`, only ever called on a reading that already passed `isMetered`. */
function ratioOf(m: MeterReading): number {
  return m.used / m.limit;
}

/**
 * Resolve the binding meter, or `null` when neither is metered.
 *
 * BINDING = the higher `used / limit`. Ties resolve to `monthly`, and that tie-break is a
 * statement about severity rather than a coin flip: a daily wall clears at the next 00:00 UTC and
 * the caller returns on their own, while a monthly wall does not clear until the caller's own
 * rolling anchor. Naming the daily one on a tie would understate the wait — the exact defect
 * `quota-notice.ts` records running in production for a day and a half, one field over.
 *
 * `null` means EMIT NOTHING. Every consumer must treat it that way and never as "0% used": the
 * only way to reach it is that neither meter is honestly metered, which is a fact about the tier,
 * not a measurement of the caller.
 */
export function bindingMeter(
  monthly?: MeterReading | null,
  daily?: MeterReading | null,
): BindingMeterState | null {
  const m = isMetered(monthly) ? monthly : null;
  const d = isMetered(daily) ? daily : null;
  if (!m && !d) return null;

  // Ties AND the single-meter cases both land on this one expression: with only a daily meter the
  // monthly ratio is -Infinity and daily wins; with only a monthly meter the reverse. There is no
  // separate branch to drift, which is the point of the whole module.
  const monthlyRatio = m ? ratioOf(m) : Number.NEGATIVE_INFINITY;
  const dailyRatio = d ? ratioOf(d) : Number.NEGATIVE_INFINITY;
  const binding: QuotaWall = dailyRatio > monthlyRatio ? 'daily' : 'monthly';

  // Non-null by construction: `binding` can only be 'daily' when d is set, and only 'monthly' when
  // m is set (if m were null, monthlyRatio is -Infinity and any real dailyRatio exceeds it).
  const chosen = (binding === 'daily' ? d : m) as MeterReading;

  return {
    binding,
    ratio: ratioOf(chosen),
    used: chosen.used,
    limit: chosen.limit,
    remaining: Math.max(0, chosen.limit - chosen.used),
    resetAtMs: chosen.resetAtMs,
    // Both underlying pairs travel WITH the binding one. A consumer that had to re-derive the
    // split would be a second derivation of the thing this module exists to derive once, and a
    // consumer handed only the binding pair could silently drop the other meter from a rendered
    // envelope — which is how the daily meter stayed invisible for two weeks.
    monthly: m,
    daily: d,
  };
}
