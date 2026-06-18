#!/usr/bin/env npx tsx
/**
 * CONVERSION-MEASUREMENT-W1 C2 — one-shot backfill of the subscriber_profiles
 * pre-conversion bridge columns for existing rows (bridge_confidence IS NULL).
 * Thin wrapper around `backfillSubscriberBridges()` in
 * `src/lib/subscriber-attribution.ts` (scripts/ is outside tsc rootDir).
 *
 * Local / dev:
 *   npx tsx scripts/backfill-subscriber-bridges.ts
 *
 * PROD (the container prunes tsx — run against the compiled dist instead):
 *   docker exec <ctr> node -e "import('./dist/lib/subscriber-attribution.js') \
 *     .then(m => m.backfillSubscriberBridges()) \
 *     .then(n => { console.log('backfilled', n); process.exit(0); }) \
 *     .catch(e => { console.error(e); process.exit(1); })"
 *
 * Idempotent (only touches still-NULL rows) + fail-open per row.
 */
import { backfillSubscriberBridges } from '../src/lib/subscriber-attribution.js';
import { closeDb } from '../src/lib/performance-db.js';

async function main(): Promise<void> {
  const n = await backfillSubscriberBridges();
  console.log(`[backfill-subscriber-bridges] done — ${n} subscriber row(s) backfilled.`);
}

main()
  .then(async () => { await closeDb(); process.exit(0); })
  .catch(async (err) => {
    console.error('[backfill-subscriber-bridges] fatal:', err instanceof Error ? err.message : err);
    try { await closeDb(); } catch { /* ignore */ }
    process.exit(1);
  });
