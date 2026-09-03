#!/usr/bin/env tsx
/**
 * venue-readiness-report.ts — OPS-SHADOW-PIPELINE-W1 / C5 (Deliverable C).
 *
 * Daily operator digest (host cron 06:05 UTC, just after evaluate-venues 06:00)
 * of EVERY venue's promotion readiness, with a READY-TO-LAUNCH header block
 * carrying the exact promote command. One line per all 17 venues:
 *   status · PFE WR (or n/a) · BUY+SELL N/target+% · days since seeding · verdict.
 *
 * PUBLIC PFE WR ONLY — never outcome_return_pct / Phase-E outcome WR (Data
 * Integrity LAW). "Days since seeding" derives from the C3 seeding_started_at
 * clock (COALESCE(seeding_started_at, integrated_at), computed in computeVenueStats).
 *
 * Delivery: the venue-lifecycle TG family (app-side src/lib/telegram.ts), via
 * sendDigest() — an informational digest, distinct from the host send_telegram.sh
 * CRITICAL-drift wrapper (which only fires on CRITICAL_PERSISTENT). Set DRY_RUN=1
 * to print to stdout without sending.
 */
import { listVenues } from '../lib/venue-store.js';
import { runScript } from '../lib/script-lifecycle.js';
import { computeVenueStats } from './evaluate-venues.js';
import { sendDigest } from '../lib/telegram.js';
import { dbQuery } from '../lib/performance-db.js';
import { loadEquityReadinessInput, renderToolReadiness } from './tool-readiness-report.js';
import { isEquityToolsEnabled } from '../lib/equities/equity-tools-flag.js';
import type { VenueRecord } from '../types.js';

const PFE_WR_THRESHOLD = 0.80;
const DAY_15_FLOOR = 15;

interface Stats { pfe_wr: number | null; buy_sell_count: number; days_since: number; }
interface Verdict { glyph: string; line: string; qualified: boolean; }

const wrPct = (wr: number) => `${(wr * 100).toFixed(1)}%`;

/** Per-venue readiness verdict. PFE-WR-only; no outcome fields ever referenced. */
export function venueVerdict(v: VenueRecord, s: Stats): Verdict {
  if (v.status === 'promoted') return { glyph: '🟢', line: `🟢 ${v.exchange_id} — already live`, qualified: false };
  if (v.status === 'retired')  return { glyph: '⚫', line: `⚫ ${v.exchange_id} — retired`, qualified: false };

  const target = v.min_buy_sell_sample;
  const pct = target > 0 ? Math.round((100 * s.buy_sell_count) / target) : 0;
  const smp = `sample ${s.buy_sell_count}/${target} (${pct}%)`;

  if (s.buy_sell_count === 0) {
    // Distinguish truly-unseeded (seeding_started_at NULL) from actively-seeding
    // venues that have produced only HOLDs so far (BUY/SELL not yet accrued).
    return v.seeding_started_at
      ? { glyph: '🌱', line: `🌱 ${v.exchange_id} — seeding, sample 0/${target} (HOLDs only so far), WR n/a`, qualified: false }
      : { glyph: '🔌', line: `🔌 ${v.exchange_id} — no pipeline yet`, qualified: false };
  }
  if (s.days_since < DAY_15_FLOOR) return { glyph: '⏱', line: `⏱ ${v.exchange_id} — within initial window (day ${s.days_since}/15), ${smp}, WR ${s.pfe_wr === null ? 'n/a (no Phase-E outcomes yet)' : wrPct(s.pfe_wr)}`, qualified: false };
  if (s.pfe_wr === null) return { glyph: '⏳', line: `⏳ ${v.exchange_id} — ${smp}, WR n/a (no Phase-E outcomes yet)`, qualified: false };
  if (s.buy_sell_count < target) return { glyph: '⏳', line: `⏳ ${v.exchange_id} — ${smp} (need ${target - s.buy_sell_count} more), WR ${wrPct(s.pfe_wr)}`, qualified: false };
  if (s.pfe_wr < PFE_WR_THRESHOLD) return { glyph: '⚠️', line: `⚠️ ${v.exchange_id} — WR ${wrPct(s.pfe_wr)} < 80% (${smp})`, qualified: false };
  return { glyph: '✅', line: `✅ ${v.exchange_id} — QUALIFIED (day ${s.days_since}, ${smp}, WR ${wrPct(s.pfe_wr)})`, qualified: true };
}

/**
 * OPS-BITMART-ENUM-RECONCILE-W1 CH5 — is there anything to ACT on?
 *
 * With the shadow set nearly empty this digest was on its way to reporting a static roster every
 * morning forever, and per CLAUDE.md chatter is noise: an alert is operator-action-required or it
 * should not fire. This is the predicate, kept PURE so both directions are testable — a
 * suppression-only test would let the SEND path rot dark, which is the "installed is not working"
 * class this estate keeps paying for.
 *
 * ACTIONABLE (architect-decided 2026-09-03, implemented as given):
 *   • ≥1 shadow venue          — an onboarding is in flight and needs watching
 *   • ≥1 ✅ QUALIFIED          — it is waiting on a promote decision
 *   • ≥1 ⚠️ WR < 80%           — a venue below the promotion bar is a regression the operator may
 *                                need to act on; this is what keeps the digest valuable once the
 *                                shadow set empties
 * NOT actionable:
 *   • 🔌 "no pipeline yet"     — already ruled silent by the estate (New-Venue-SOP Phase 1: a
 *                                starved venue "fires no operator alert and burns no extension")
 *
 * The equity card is handled by a one-line short-circuit at the call site rather than being folded
 * in here: its input is inlined at the render site and hoisting it is an unbudgeted refactor.
 */
export function isDigestActionable(rows: VenueRecord[], statsByVenue: Map<string, Stats>): { actionable: boolean; reason: string } {
  const empty: Stats = { pfe_wr: null, buy_sell_count: 0, days_since: 0 };
  const shadow = rows.filter((v) => v.status === 'shadow').length;
  let qualified = 0;
  let belowBar = 0;
  for (const v of rows) {
    const verdict = venueVerdict(v, statsByVenue.get(v.exchange_id) ?? empty);
    if (verdict.qualified) qualified += 1;
    else if (verdict.glyph === '⚠️') belowBar += 1;
  }
  const actionable = shadow > 0 || qualified > 0 || belowBar > 0;
  return {
    actionable,
    reason: `${shadow} shadow, ${qualified} qualified, ${belowBar} below-bar`,
  };
}

/** Build the digest sections (pure — exported for tests). dateLabel passed in (no Date.now in tests). */
export function buildReport(rows: VenueRecord[], statsByVenue: Map<string, Stats>, dateLabel: string): string[] {
  const sorted = [...rows].sort((a, b) => a.exchange_id.localeCompare(b.exchange_id));
  const promoted = sorted.filter(v => v.status === 'promoted');
  const shadow = sorted.filter(v => v.status === 'shadow');
  const retired = sorted.filter(v => v.status === 'retired');

  const lineFor = (v: VenueRecord) => venueVerdict(v, statsByVenue.get(v.exchange_id) ?? { pfe_wr: null, buy_sell_count: 0, days_since: 0 });

  const ready = shadow.map(v => ({ v, vd: lineFor(v) })).filter(x => x.vd.qualified);

  const sections: string[] = [`📊 *Venue Promotion Readiness* — ${dateLabel}`];

  if (ready.length > 0) {
    const block = [`🚀 *READY TO LAUNCH (${ready.length})*`];
    for (const { v } of ready) {
      const s = statsByVenue.get(v.exchange_id)!;
      block.push(`• ${v.exchange_id} — QUALIFIED (sample ${s.buy_sell_count}/${v.min_buy_sell_sample}, WR ${wrPct(s.pfe_wr as number)})`);
      block.push(`  → npx tsx src/scripts/promote-venue.ts ${v.exchange_id}`);
    }
    sections.push(block.join('\n'));
  } else {
    sections.push(`🚀 *READY TO LAUNCH (0)* — none yet`);
  }

  sections.push([`*Promoted (${promoted.length})*`, ...promoted.map(v => lineFor(v).line)].join('\n'));
  sections.push([`*Shadow (${shadow.length})*`, ...shadow.map(v => lineFor(v).line)].join('\n'));
  if (retired.length > 0) sections.push([`*Retired (${retired.length})*`, ...retired.map(v => lineFor(v).line)].join('\n'));

  return sections;
}

async function main(): Promise<void> {
  const rows = await listVenues();
  const statsByVenue = new Map<string, Stats>();
  for (const v of rows) {
    try {
      statsByVenue.set(v.exchange_id, await computeVenueStats(v));
    } catch (e) {
      console.error(`[venue-readiness] stats failed for ${v.exchange_id}: ${e instanceof Error ? e.message : e}`);
      statsByVenue.set(v.exchange_id, { pfe_wr: null, buy_sell_count: 0, days_since: 0 });
    }
  }
  const dateLabel = new Date().toISOString().slice(0, 10);
  const sections = buildReport(rows, statsByVenue, dateLabel);

  // EQUITY-READINESS-REPORT-W1: append the recurring "Tool Promotion Readiness"
  // card for the (non-venue) equity tools so it rides THIS digest's single
  // sendDigest() Telegram — no new cron/alert channel. Fail-soft: a DB hiccup on
  // the equity section must never suppress the venue blocks.
  //
  // EQUITY-TOOLS-DARK-RETIRE-W1: gated by the SAME flag as the equity tool
  // registration (single-derivation, in-container `docker exec` so the container
  // env is authoritative for both). OFF (default) → the equity card is not rendered
  // and its DB read is skipped; the venue digest + its single sendDigest() below are
  // otherwise byte-identical.
  if (isEquityToolsEnabled()) {
    try {
      sections.push(renderToolReadiness(await loadEquityReadinessInput(dbQuery)));
    } catch (e) {
      console.error(
        `[tool-readiness] equity section failed (venue digest still sent): ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  const text = sections.join('\n\n');
  console.log(text);

  if (process.env.DRY_RUN) {
    console.log('\n[DRY_RUN] not sent.');
    return;
  }
  // CH5 — speak only when there is something to act on. FAIL-OPEN: a predicate error SENDS, because
  // one day of noise beats one day of blind. The equity leg is a one-line short-circuit rather than
  // a hoist: if the card is active the digest sends unconditionally, so enabling it can never be
  // silently swallowed by a venue-side predicate.
  let verdict = { actionable: true, reason: 'predicate not evaluated (fail-open)' };
  try {
    verdict = isEquityToolsEnabled()
      ? { actionable: true, reason: 'equity Tool-Promotion-Readiness card is active' }
      : isDigestActionable(rows, statsByVenue);
  } catch (e) {
    console.error(`[venue-readiness] actionability predicate failed — SENDING anyway: ${e instanceof Error ? e.message : e}`);
  }
  if (!verdict.actionable) {
    // Silence in Telegram must never mean silence everywhere: this line is the job's liveness.
    console.log(`[venue-readiness] SUPPRESSED — nothing actionable (${verdict.reason}, equity card inactive)`);
    return;
  }
  const ok = await sendDigest(sections, { label: 'venue-readiness-report' });
  console.log(ok ? '\n[sent via telegram.sendDigest]' : '\n[telegram not configured — printed only]');
}

if (require.main === module) {
  void runScript('venue-readiness-report', main); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}
