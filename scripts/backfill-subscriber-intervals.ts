#!/usr/bin/env npx tsx
/**
 * OPS-STRIPE-SUBSCRIPTION-TRUTH-W3 CH2 — one-shot convergence of the existing
 * `subscriber_profiles` rows against Stripe (tier · billing_interval · monthly_rate_usd).
 *
 * Thin wrapper around `backfillSubscriberIntervals()` in `src/lib/subscriber-attribution.ts`
 * (repo-root `scripts/` is outside tsc `rootDir`, so this file is never compiled).
 *
 * Local / dev:
 *   npx tsx scripts/backfill-subscriber-intervals.ts            # dry-run (default)
 *   npx tsx scripts/backfill-subscriber-intervals.ts --execute
 *
 * PROD (the container prunes tsx — run against the compiled dist instead; this is the invocation
 * that actually works, per the sibling's own header. NOT `dist/scripts/…`, which cannot exist):
 *   docker exec <ctr> node -e "import('./dist/lib/subscriber-attribution.js') \
 *     .then(m => m.backfillSubscriberIntervals({ execute: true })) \
 *     .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); }) \
 *     .catch(e => { console.error(e); process.exit(1); })"
 *
 * DRY-RUN BY DEFAULT. Idempotent — a second run finds nothing changed and writes nothing.
 * Every write is awaited and the table is re-read before the report is returned, because
 * `dbRun` is fire-and-forget on Postgres and a short-lived process exits before such a write
 * flushes (W5's backfill logged 3 successes and landed 2 rows exactly that way).
 */
import { backfillSubscriberIntervals } from '../src/lib/subscriber-attribution.js';
import { closeDb } from '../src/lib/performance-db.js';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const r = await backfillSubscriberIntervals({ execute });

  console.log(`[backfill-subscriber-intervals] stripe_active=${r.stripeSubscriptions} profile_rows=${r.profileRows} mode=${execute ? 'EXECUTE' : 'DRY-RUN'}`);
  for (const row of r.rows) {
    const b = row.before, a = row.after;
    console.log(
      `  ${row.customerId.slice(0, 8)}…${row.customerId.slice(-6)}  ` +
      `tier ${b.tier ?? '-'}→${a.tier ?? '-'}  ` +
      `interval ${b.interval ?? '-'}→${a.interval}  ` +
      `rate ${b.rate ?? 'NULL'}→${a.rate ?? 'NULL'}  ` +
      `${row.changed ? (execute ? '[WRITTEN]' : '[would change]') : '[unchanged]'}`,
    );
  }
  if (execute) {
    console.log(`[backfill-subscriber-intervals] written=${r.written} verified_converged=${r.verifiedConverged}/${r.stripeSubscriptions} mrr_from_record=$${(r.mrrFromRecord ?? 0).toFixed(2)}`);
    // Verify by RESULT: refuse to report success unless the re-read agrees with Stripe.
    if (r.verifiedConverged !== r.stripeSubscriptions) {
      throw new Error(`convergence NOT verified: ${r.verifiedConverged}/${r.stripeSubscriptions} rows match Stripe after the write`);
    }
    console.log('[backfill-subscriber-intervals] CONVERGED — every Stripe subscription has a matching profile row.');
  } else {
    const n = r.rows.filter((x) => x.changed).length;
    console.log(`[backfill-subscriber-intervals] DRY-RUN — ${n} row(s) would change. Pass --execute to write.`);
  }
}

main()
  .then(async () => { await closeDb(); process.exit(0); })
  .catch(async (err) => {
    console.error('[backfill-subscriber-intervals] fatal:', err instanceof Error ? err.message : err);
    try { await closeDb(); } catch { /* ignore */ }
    process.exit(1);
  });
