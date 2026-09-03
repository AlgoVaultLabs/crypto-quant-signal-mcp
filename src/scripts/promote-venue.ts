#!/usr/bin/env tsx
/**
 * promote-venue.ts — OPS-SHADOW-PIPELINE-W1 / C4 — operator-gated promotion.
 *
 * Usage:
 *   node dist/scripts/promote-venue.js <EXCHANGE> [--force]
 *
 * Launches a qualified shadow venue to LIVE in one command. Re-checks the live
 * promotion criteria (days_since ≥ 15 ∧ buy_sell_sample ≥ min_buy_sell_sample ∧
 * pfe_wr ≥ 0.80) unless `--force`. On success: setStatus('promoted') +
 * promoted_at=now → the venue is immediately (a) selected by the data-driven
 * seed loop (status='promoted') and (b) exposed in public /api/performance-public
 * .byExchange (PFE-WR-only). Fires a Telegram confirmation and prints post-flip
 * verification. Refuses cleanly (no state change) on unmet criteria, naming the
 * failing criterion + a suggested action.
 *
 * Shadow auto-promote is DISABLED (evaluate-venues C4) — this is the ONLY path
 * a shadow venue goes live, keeping Mr.1 in the loop.
 */
import { getVenue, setStatus } from '../lib/venue-store.js';
import { runScript } from '../lib/script-lifecycle.js';
import { computeVenueStats } from './evaluate-venues.js';
import { sendVenueStatusChange } from '../lib/telegram.js';

const PFE_WR_THRESHOLD = 0.80;
const DAY_15_FLOOR = 15;

/**
 * OPS-BITMART-ENUM-RECONCILE-W1 CH4-B — THE FORCE FLOOR, now code instead of prose.
 *
 * `--force` used to proceed past ANY failure, including `pfe_wr === null` — i.e. a venue with no
 * measured outcomes at all could be promoted to a public surface. The "floor" that was supposed to
 * stop that lived only in a prior wave's endpoint-truth prose, so a dispatching spec built its ONLY
 * abort condition on a gate that did not exist. Per CLAUDE.md, a rule that has failed as prose must
 * become a gate or be deleted.
 *
 * `--force` now overrides the SOFT criteria only (sample size, the 15-day clock, the 0.80 bar).
 * These three are HARD and refuse even under --force, because each makes the promotion unevidenced
 * rather than merely early:
 *   • pfe_wr === null      — no Phase-E outcome exists; there is nothing to judge
 *   • days_since < 7       — too short to have observed a regime change
 *   • pfe_wr < 0.70        — below the floor the estate has ever knowingly published
 */
const FORCE_FLOOR_PFE_WR = 0.70;
const FORCE_FLOOR_DAYS = 7;

/** PURE — exported so the test can drive every branch without a DB. Returns the tripped
 *  conditions, in order, or [] when the venue clears the floor. */
export function forceFloorBreaches(stats: { days_since: number; pfe_wr: number | null }): string[] {
  const tripped: string[] = [];
  if (stats.pfe_wr === null) tripped.push('pfe_wr=null (no Phase-E outcome exists — nothing to judge)');
  else if (stats.pfe_wr < FORCE_FLOOR_PFE_WR) tripped.push(`pfe_wr=${(stats.pfe_wr * 100).toFixed(1)}% < floor ${(FORCE_FLOOR_PFE_WR * 100).toFixed(0)}%`);
  if (stats.days_since < FORCE_FLOOR_DAYS) tripped.push(`days_since=${stats.days_since} < floor ${FORCE_FLOOR_DAYS}`);
  return tripped;
}

export async function promoteVenue(exchangeId: string, force = false, now: Date = new Date()): Promise<number> {
  const venue = await getVenue(exchangeId);
  if (!venue) {
    console.error(`❌ Venue '${exchangeId}' not found in the venues table.`);
    console.error(`   suggested_action: check the exchange id (must be one of the 17 ExchangeId values).`);
    return 1;
  }
  if (venue.status === 'promoted') {
    console.log(`✓ ${exchangeId} is already promoted (no-op).`);
    return 0;
  }
  if (venue.status === 'retired') {
    console.error(`❌ ${exchangeId} is retired — cannot promote.`);
    console.error(`   suggested_action: un-retire it first (set status='shadow') if this is intended.`);
    return 1;
  }

  const stats = await computeVenueStats(venue, now);
  const failures: string[] = [];
  if (stats.days_since < DAY_15_FLOOR) failures.push(`days_since=${stats.days_since} < ${DAY_15_FLOOR}`);
  if (stats.buy_sell_count < venue.min_buy_sell_sample) failures.push(`buy_sell_sample=${stats.buy_sell_count} < ${venue.min_buy_sell_sample}`);
  if (stats.pfe_wr === null) failures.push(`pfe_wr=n/a (no Phase-E outcomes yet)`);
  else if (stats.pfe_wr < PFE_WR_THRESHOLD) failures.push(`pfe_wr=${(stats.pfe_wr * 100).toFixed(1)}% < ${(PFE_WR_THRESHOLD * 100).toFixed(0)}%`);

  if (failures.length > 0 && !force) {
    console.error(`❌ ${exchangeId} is NOT qualified for promotion — criteria not met:`);
    for (const f of failures) console.error(`   • ${f}`);
    console.error(`   suggested_action: wait for the criteria (see the daily readiness report), or re-run with --force to override.`);
    return 1;
  }
  if (failures.length > 0 && force) {
    // The floor is checked BEFORE the override takes effect — --force buys the soft criteria, never these.
    const tripped = forceFloorBreaches(stats);
    if (tripped.length > 0) {
      console.error(`❌ ${exchangeId} trips the FORCE FLOOR — --force cannot override this:`);
      for (const t of tripped) console.error(`   • ${t}`);
      console.error(`   suggested_action: this venue is UNEVIDENCED, not merely early. Let it accrue a Phase-E outcome and re-evaluate.`);
      console.log(`PROMOTE_FORCE_FLOOR_VERDICT=REFUSED tripped=${tripped.length}`);
      return 1;
    }
    console.log('PROMOTE_FORCE_FLOOR_VERDICT=CLEARED');
    console.warn(`⚠️  --force: promoting ${exchangeId} despite unmet criteria: ${failures.join('; ')}`);
  }

  await setStatus(exchangeId, 'promoted', { promoted_at: now });
  console.log(`✅ ${exchangeId} promoted → LIVE (promoted_at=${now.toISOString()}).`);
  console.log(`   • now selected by the seed loop (status='promoted') + exposed in public /api/performance-public.byExchange (PFE-WR-only).`);
  console.log(`   • NEXT (go-live): wire ${exchangeId} into the full multi-timeframe seed crons + re-check CPU (server upgrade if the box is near budget) — the OPS-...-GO-LIVE follow-up.`);

  try {
    await sendVenueStatusChange({
      venue: exchangeId,
      action: 'promoted',
      pfe_wr: stats.pfe_wr,
      buy_sell_count: stats.buy_sell_count,
      min_buy_sell_sample: venue.min_buy_sell_sample,
      days_since: stats.days_since,
      extension_count: venue.extension_count,
    });
  } catch (e) {
    console.warn(`   (Telegram confirmation failed — non-fatal: ${e instanceof Error ? e.message : e})`);
  }

  const after = await getVenue(exchangeId);
  if (after?.status === 'promoted') {
    console.log(`   verified: status=promoted, promoted_at=${after.promoted_at}`);
    return 0;
  }
  console.error(`❌ post-flip verification FAILED: status=${after?.status ?? 'unknown'}`);
  return 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const exchangeId = args.find(a => !a.startsWith('--'))?.toUpperCase();
  if (!exchangeId) {
    console.error('Usage: node dist/scripts/promote-venue.js <EXCHANGE> [--force]');
    process.exit(1);
  }
  process.exit(await promoteVenue(exchangeId, force));
}

if (require.main === module) {
  void runScript('promote-venue', main); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}
