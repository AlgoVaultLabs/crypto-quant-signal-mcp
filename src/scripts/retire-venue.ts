#!/usr/bin/env tsx
/**
 * retire-venue.ts — OPS-SHADOW-PIPELINE-W1 / C4 (D3) — operator-gated retirement.
 *
 * Usage:
 *   node dist/scripts/retire-venue.js <EXCHANGE>
 *
 * Sets status='retired' + retired_at=now. The data-driven seed loop excludes
 * `retired` venues (listVenues table-driven selection), so a retired venue stops
 * accruing signals on the next cron fire. Idempotent (already-retired = no-op).
 * Used at day-30 when a shadow venue fails to qualify (or any time Mr.1 decides
 * to drop a venue). No public surface change (retired venues were never public).
 */
import { getVenue, setStatus } from '../lib/venue-store.js';
import { runScript } from '../lib/script-lifecycle.js';

export async function retireVenue(exchangeId: string, now: Date = new Date()): Promise<number> {
  const venue = await getVenue(exchangeId);
  if (!venue) {
    console.error(`❌ Venue '${exchangeId}' not found in the venues table.`);
    return 1;
  }
  if (venue.status === 'retired') {
    console.log(`✓ ${exchangeId} is already retired (no-op).`);
    return 0;
  }
  await setStatus(exchangeId, 'retired', { retired_at: now });
  console.log(`✅ ${exchangeId} retired (retired_at=${now.toISOString()}). The seed loop drops it (status='retired' excluded from selection).`);
  const after = await getVenue(exchangeId);
  if (after?.status === 'retired') {
    console.log(`   verified: status=retired, retired_at=${after.retired_at}`);
    return 0;
  }
  console.error(`❌ post-flip verification FAILED: status=${after?.status ?? 'unknown'}`);
  return 1;
}

async function main(): Promise<void> {
  const exchangeId = process.argv.slice(2).find(a => !a.startsWith('--'))?.toUpperCase();
  if (!exchangeId) {
    console.error('Usage: node dist/scripts/retire-venue.js <EXCHANGE>');
    process.exit(1);
  }
  process.exit(await retireVenue(exchangeId));
}

if (require.main === module) {
  void runScript('retire-venue', main); // OPS-SCRIPT-EXIT-LIFECYCLE-W1
}
