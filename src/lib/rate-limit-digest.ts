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
): { lines: string[]; shadowBudget: boolean; hlDenial: boolean } {
  const lines: string[] = [];
  const shadowHit = perVenue.find((v) => !PROMOTED_VENUE_NAMES.includes(v.venue) && v.throws >= SHADOW_THROW_TRIGGER);
  const hl = perVenue.find((v) => v.venue === HL_VENUE_NAME);
  const hlInteractive = hl?.iThrows ?? 0;
  const shadowBudget = !!shadowHit;
  const hlDenial = hlInteractive >= HL_INTERACTIVE_THROW_TRIGGER;
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
    const perVenue = aggregateRateLimit(rawCounts.map((c) => ({ ...c, n: Number(c.n) })));
    const hlWaitP95Ms = p95(hlWaits.map((r) => Number(r.wait_ms)));
    const hlTopCallers = aggregateCallers(hlCallerRows.map((c) => ({ caller: c.caller, n: Number(c.n) })));

    const body = perVenue.length === 0
      ? ['   (no rate-limit events — all venues healthy)']
      : [
          ...perVenue.map((v) => `   *${v.venue}*: ${v.throws} throws (i:${v.iThrows}/b:${v.bThrows}), ${v.waits} waits, ${v.skips} skips`),
          ...(perVenue.some((v) => v.venue === HL_VENUE_NAME) ? [`   HL batch-wait p95: ${(hlWaitP95Ms / 1000).toFixed(1)}s`] : []),
          ...(hlTopCallers.length ? [`   HL throw drivers (by caller, 7d): ${hlTopCallers.map((c) => `${c.caller} (${c.n})`).join(', ')}`] : []),
        ];
    const { lines } = evaluateRateLimitTriggers(perVenue);
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
