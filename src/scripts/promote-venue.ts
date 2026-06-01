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
import { computeVenueStats } from './evaluate-venues.js';
import { sendVenueStatusChange } from '../lib/telegram.js';

const PFE_WR_THRESHOLD = 0.80;
const DAY_15_FLOOR = 15;

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
  main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
}
