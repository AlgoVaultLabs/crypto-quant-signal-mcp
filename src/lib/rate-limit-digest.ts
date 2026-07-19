/**
 * rate-limit-digest.ts — OPS-TELEMETRY-DIGEST-REFRAME-W1
 *
 * The weekly per-venue rate-limit telemetry digest: one durable event stream
 * (`rate_limit_events`) → a 7d per-venue summary + the two denial-based
 * self-watching triggers. Rendered by `src/scripts/rate-limit-digest-weekly.ts`
 * (Sunday 00:00 UTC cron) and sent via `sendDigest`.
 *
 * ── Why this module exists ──
 * Extracted verbatim from the former `src/scripts/shadow-digest-weekly.ts`, whose
 * OTHER half (a 1m/3m "should we launch these timeframes publicly?" verdict) was
 * DEAD: 3m has been public since before 2026-06-01 (`SHADOW_REVEAL_TIMEFRAMES=3m`
 * in the prod env; ~97k signals on /api/performance-public) and the 1m seed cron
 * was decommissioned by OPS-1M-SEED-DECOM-W1, leaving ~2 on-demand samples/week
 * against a 3,000-sample gate it can never reach. That section reported
 * INSUFFICIENT_DATA every week about a decision settled ~7 weeks earlier, which
 * reads as "not ready to launch" for something already shipped. It is gone; the
 * telemetry it was carrying is what actually earns the cron slot.
 *
 * Living in `lib/` (not the script) makes the logic test-importable per CLAUDE.md
 * — the script is a thin `main()` wrapper, mirroring geo-weekly-cron → geo-digest.
 *
 * NOT an alert path (digest section only); trigger lines emit the template form
 * OPS-<CLASS>-W{NEXT} — literal wave numbers are forbidden per CLAUDE.md.
 */

import { dbQuery } from './performance-db.js';
import { PROMOTED_VENUE_IDS } from './capabilities.js';
import { VENUE_FETCH_CONFIGS } from './adapters/_upstream-fetch.js';

/**
 * The promoted-venue DISPLAY names, derived from the same compile-time SoT the
 * venue-budget registry uses (`capabilities.ts`).
 *
 * ⚠️ Derived via `VENUE_FETCH_CONFIGS[id].venueName`, NOT `EXCHANGES[id].label` —
 * these two disagree and only `venueName` is correct here. `venueName` is the
 * literal string `UpstreamRateLimitError` carries into `rate_limit_events.venue`
 * (migrations/008), which is what this digest groups by. GATE is the live
 * counter-example: its label is "Gate.io" but its venueName is "Gate", so
 * deriving from `.label` would classify Gate as a shadow venue and re-create the
 * exact bug this wave fixes, one venue later.
 *
 * Was a hardcoded 5-name literal. The live `venues` table has had 12 promoted
 * since OPS-VENUE-GO-LIVE-2026-06-30, so Aster — a promoted venue — was being
 * judged by the shadow-venue trigger below and the alert recommended the wrong
 * wave class.
 */
export const PROMOTED_VENUE_NAMES: readonly string[] = PROMOTED_VENUE_IDS.map(
  (id) => VENUE_FETCH_CONFIGS[id].venueName,
);

const HL_VENUE_NAME = VENUE_FETCH_CONFIGS.HL.venueName;
const SHADOW_THROW_TRIGGER = 3;            // ≥3 typed throws/7d on ANY non-promoted (shadow) venue
const HL_INTERACTIVE_THROW_TRIGGER = 25;   // "sustained" HL interactive (budget self-throttle) throws/7d — tunable
// (OPS-RATELIMIT-DIGEST-THRESHOLD-RECAL-W1: the HL batch-wait p95 trigger was REMOVED — batch
// waits are by-design, not a fault. Both triggers are now denial-based; see evaluateRateLimitTriggers.)

export interface VenueRl { venue: string; throws: number; waits: number; skips: number; iThrows: number; bThrows: number; }

/**
 * The SHAPE of a venue's interactive throws across the window — not just how many.
 *
 * OPS-HL-INTERACTIVE-PRIORITY-W1: the `hlDenial` trigger below is labelled
 * "sustained", but it used to test a bare 7-day SUM, which cannot tell chronic
 * pressure apart from one burst. Live proof: 171 HL interactive throws in a week
 * looked like sustained demand, but **161 of them (94%) landed in a single minute**
 * — Monday 13:17 UTC, the weekly `scan-showcase` cron. That is a spike, and the
 * operator-facing action it recommended ("investigate the interactive driver")
 * therefore fired every week on a non-problem. Same measurement-shape bug as the
 * shadow-venue misclassification this file already fixed: the metric did not
 * measure the thing its label claimed.
 */
export interface ThrowShape {
  total: number;
  /** Distinct UTC days carrying ≥1 throw. */
  days: number;
  /** Largest single-hour count. */
  peakHour: number;
  /** Label of the peak hour, for the diagnostic line. */
  peakHourLabel: string | null;
  /** peakHour / total — 1.0 means the whole week happened in one hour. */
  peakShare: number;
}

/** Minimum distinct days before a throw pattern can be called "sustained". */
const SUSTAINED_MIN_DAYS = 2;
/** Above this single-hour share, the week is one burst — not sustained pressure. */
const BURST_PEAK_SHARE = 0.5;

/**
 * Summarize hourly throw buckets into a {@link ThrowShape} (pure; unit-tested both
 * sides of each boundary). `hour` is any stable per-hour label — the day count is
 * derived from its leading date, so `YYYY-MM-DD HH:00` is the expected form.
 */
export function summarizeThrowShape(hourly: { hour: string; n: number }[]): ThrowShape {
  const total = hourly.reduce((a, h) => a + h.n, 0);
  const days = new Set(hourly.filter((h) => h.n > 0).map((h) => h.hour.slice(0, 10))).size;
  let peakHour = 0;
  let peakHourLabel: string | null = null;
  for (const h of hourly) {
    if (h.n > peakHour) { peakHour = h.n; peakHourLabel = h.hour; }
  }
  return { total, days, peakHour, peakHourLabel, peakShare: total > 0 ? peakHour / total : 0 };
}

/**
 * Is this shape genuinely SUSTAINED (as opposed to one burst)? Requires the throws to
 * span ≥2 distinct days AND for no single hour to account for >50% of them.
 * A shape we have no data for is treated as sustained — the filter may only ever
 * SUPPRESS a noisy alert, never invent silence where we cannot see.
 */
export function isSustained(shape: ThrowShape | null | undefined): boolean {
  if (!shape || shape.total === 0) return true;
  return shape.days >= SUSTAINED_MIN_DAYS && shape.peakShare <= BURST_PEAK_SHARE;
}

/** p95 of a sample (backend-agnostic; avoids PG-only percentile_cont so the trigger logic is pure-testable). */
export function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1))];
}

/**
 * PURE trigger evaluation — unit-tested both sides of each threshold. Emits a trigger line
 * ONLY when a threshold trips; silent otherwise. BOTH triggers are DENIAL-based (typed throws
 * = live-caller denial); by-design batch waits/skips are NOT triggers
 * (OPS-RATELIMIT-DIGEST-THRESHOLD-RECAL-W1 — see the HL block).
 */
export function evaluateRateLimitTriggers(
  perVenue: VenueRl[],
  hlShape?: ThrowShape | null,
): { lines: string[]; shadowBudget: boolean; hlDenial: boolean } {
  const lines: string[] = [];
  const shadowHit = perVenue.find((v) => !PROMOTED_VENUE_NAMES.includes(v.venue) && v.throws >= SHADOW_THROW_TRIGGER);
  const hl = perVenue.find((v) => v.venue === HL_VENUE_NAME);
  const hlInteractive = hl?.iThrows ?? 0;
  const shadowBudget = !!shadowHit;
  // BOTH conditions required: enough throws AND a genuinely sustained shape. The count
  // alone cannot distinguish chronic denial from one weekly cron burst — see ThrowShape.
  const hlDenial = hlInteractive >= HL_INTERACTIVE_THROW_TRIGGER && isSustained(hlShape);
  if (shadowBudget) {
    lines.push(`⚠️ ${shadowHit!.venue}: ${shadowHit!.throws} throws/7d (≥${SHADOW_THROW_TRIGGER}) — Action: dispatch OPS-SHADOW-BUDGET-W{NEXT} via Cowork → Claude Code`);
  }
  if (hlDenial) {
    // OPS-RATELIMIT-DIGEST-THRESHOLD-RECAL-W1: DENIAL-ONLY trigger — fires solely on sustained HL
    // interactive throws (live-caller denial → HL→Binance fallback → provenance loss = the real,
    // operator-actionable signal). The old `batch-wait p95 > 20s` disjunct was REMOVED: post
    // OPS-HL-BACKFILL-BATCH-W1 the backfill correctly runs in the batch lane, which is DESIGNED to
    // wait (up to ~5min) to yield the interactive reserve, so its p95 (~179s live) perpetually
    // tripped on a NON-problem (alert noise that trains the operator to ignore the digest). Batch
    // waits/skips are by-design, not faults — only throws are actionable. The action stays
    // driver-agnostic (OPS-RATELIMIT-TIDYUP-W1): OPS-HL-WEBSOCKET was cancelled (saturation was
    // backfill-on-read, not live demand) — attribute via the per-caller breakdown first, never
    // blind-recommend a structural wave. p95 stays in the informational SECTION (diagnostics),
    // NOT this alert (actionable signal only).
    lines.push(`⚠️ HL: ${hlInteractive} interactive throws/7d — Action: investigate the HL interactive driver via the per-caller breakdown above (attribute first; do NOT prescribe a structural wave blind)`);
  }
  return { lines, shadowBudget, hlDenial };
}

/** Aggregate the raw count rows into per-venue totals (pure; testable with synthetic rows). */
export function aggregateRateLimit(counts: { venue: string; kind: string; class: string; n: number }[]): VenueRl[] {
  const byVenue = new Map<string, VenueRl>();
  for (const c of counts) {
    const v = byVenue.get(c.venue) ?? { venue: c.venue, throws: 0, waits: 0, skips: 0, iThrows: 0, bThrows: 0 };
    if (c.kind === 'throw') { v.throws += c.n; if (c.class === 'interactive') v.iThrows += c.n; else v.bThrows += c.n; }
    else if (c.kind === 'wait') v.waits += c.n;
    else if (c.kind === 'skip') v.skips += c.n;
    byVenue.set(c.venue, v);
  }
  return [...byVenue.values()].sort((a, b) => b.throws - a.throws);
}

/**
 * Top callers by throw count for a venue (pure; testable with synthetic rows).
 * OPS-RATELIMIT-CALLER-ATTRIBUTION-W1 R4 — self-pins the HL interactive-demand driver
 * in the weekly digest so the websocket scope is visible without a manual query.
 */
export function aggregateCallers(rows: { caller: string; n: number }[], topN = 5): { caller: string; n: number }[] {
  const byCaller = new Map<string, number>();
  for (const r of rows) byCaller.set(r.caller, (byCaller.get(r.caller) ?? 0) + r.n);
  return [...byCaller.entries()]
    .map(([caller, n]) => ({ caller, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, topN);
}

async function buildRateLimitSection(): Promise<string[]> {
  const header = ['', '⚡ *Rate-limit telemetry (7d)*'];
  try {
    const rawCounts = await dbQuery<{ venue: string; kind: string; class: string; n: string }>(
      `SELECT venue, kind, class, COUNT(*)::text AS n
         FROM rate_limit_events
        WHERE ts > NOW() - INTERVAL '7 days'
        GROUP BY venue, kind, class`,
      [],
    );
    const hlWaits = await dbQuery<{ wait_ms: number }>(
      `SELECT wait_ms FROM rate_limit_events
        WHERE ts > NOW() - INTERVAL '7 days' AND venue = $1 AND kind = 'wait' AND class = 'batch' AND wait_ms IS NOT NULL`,
      [HL_VENUE_NAME],
    );
    // R4 — per-caller HL throw attribution (the OPS-RATELIMIT-CALLER-ATTRIBUTION-W1 payoff).
    const hlCallerRows = await dbQuery<{ caller: string; n: string }>(
      `SELECT caller, COUNT(*)::text AS n
         FROM rate_limit_events
        WHERE ts > NOW() - INTERVAL '7 days' AND venue = $1 AND kind = 'throw'
        GROUP BY caller`,
      [HL_VENUE_NAME],
    );
    // Hourly shape of HL's INTERACTIVE throws — feeds the burst-vs-sustained filter.
    const hlHourly = await dbQuery<{ hour: string; n: string }>(
      `SELECT to_char(date_trunc('hour', ts), 'YYYY-MM-DD HH24:00') AS hour, COUNT(*)::text AS n
         FROM rate_limit_events
        WHERE ts > NOW() - INTERVAL '7 days' AND venue = $1 AND kind = 'throw' AND class = 'interactive'
        GROUP BY 1 ORDER BY 1`,
      [HL_VENUE_NAME],
    );
    const perVenue = aggregateRateLimit(rawCounts.map((c) => ({ ...c, n: Number(c.n) })));
    const hlWaitP95Ms = p95(hlWaits.map((r) => Number(r.wait_ms)));
    const hlTopCallers = aggregateCallers(hlCallerRows.map((c) => ({ caller: c.caller, n: Number(c.n) })));
    const hlShape = summarizeThrowShape(hlHourly.map((h) => ({ hour: h.hour, n: Number(h.n) })));

    // Always SHOW the shape when there are interactive throws, whether or not the
    // trigger fires — the operator should be able to see a suppressed burst, not
    // just be told nothing. A silent suppression is indistinguishable from a broken gate.
    const shapeLine = hlShape.total > 0
      ? [`   HL interactive shape: ${hlShape.total} throws over ${hlShape.days} day(s); peak hour ` +
         `${hlShape.peakHourLabel} = ${hlShape.peakHour} (${(hlShape.peakShare * 100).toFixed(0)}%) → ` +
         `${isSustained(hlShape) ? 'SUSTAINED' : 'BURST (trigger suppressed)'}`]
      : [];

    const body = perVenue.length === 0
      ? ['   (no rate-limit events — all venues healthy)']
      : [
          ...perVenue.map((v) => `   *${v.venue}*: ${v.throws} throws (i:${v.iThrows}/b:${v.bThrows}), ${v.waits} waits, ${v.skips} skips`),
          ...(perVenue.some((v) => v.venue === HL_VENUE_NAME) ? [`   HL batch-wait p95: ${(hlWaitP95Ms / 1000).toFixed(1)}s`] : []),
          ...(hlTopCallers.length ? [`   HL throw drivers (by caller, 7d): ${hlTopCallers.map((c) => `${c.caller} (${c.n})`).join(', ')}`] : []),
          ...shapeLine,
        ];
    const { lines } = evaluateRateLimitTriggers(perVenue, hlShape);
    return [...header, ...body, ...(lines.length ? ['', ...lines] : [])];
  } catch (e) {
    // Fail-open: a telemetry-query failure must never break the weekly digest.
    return [...header, `   (rate-limit telemetry unavailable: ${e instanceof Error ? e.message : e})`];
  }
}

export async function buildDigest(): Promise<{ text: string; sections: string[] }> {
  const weekEnding = new Date().toISOString().slice(0, 10);
  const sections = [
    `📊 *OPS TELEMETRY WEEKLY DIGEST* (week ending ${weekEnding})`,
    ...(await buildRateLimitSection()),
  ];
  return { text: sections.join('\n'), sections };
}
