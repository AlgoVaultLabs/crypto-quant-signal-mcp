#!/usr/bin/env npx tsx
/**
 * PAY-UNIONPAY-ATTRIBUTION-W1 (R7) — one-shot backfill of the payment-method dimension from
 * the Stripe Charges history.
 *
 * Thin wrapper around `backfillPaymentMethodAttribution()` in
 * `src/lib/payment-method-backfill.ts` (repo-root `scripts/` is outside tsc `rootDir`, so
 * this file is never compiled — same shape as the three `backfill-subscriber-*` siblings).
 *
 * Local / dev:
 *   npx tsx scripts/backfill-payment-method-attribution.ts             # dry-run (default)
 *   npx tsx scripts/backfill-payment-method-attribution.ts --check     # dry-run, exit 1 if work pending
 *   npx tsx scripts/backfill-payment-method-attribution.ts --execute
 *
 * PROD (the container prunes tsx AND does not ship `scripts/` — run the compiled lib instead;
 * this is the invocation that actually works. NOT `dist/scripts/…`, which cannot exist):
 *   docker exec <ctr> node -e "import('./dist/lib/payment-method-backfill.js') \
 *     .then(m => m.backfillPaymentMethodAttribution({ execute: true })) \
 *     .then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); }) \
 *     .catch(e => { console.error(e); process.exit(1); })"
 *
 * DRY-RUN BY DEFAULT. Idempotent — a second run finds nothing pending and writes nothing,
 * which is what `--check` turns into an assertable exit code rather than a claim.
 */
import { backfillPaymentMethodAttribution } from '../src/lib/payment-method-backfill.js';
import { closeDb } from '../src/lib/performance-db.js';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const check = process.argv.includes('--check');
  if (execute && check) {
    console.error('[backfill-payment-method-attribution] --check and --execute are mutually exclusive');
    process.exit(2);
  }

  const r = await backfillPaymentMethodAttribution({ execute });
  console.log(JSON.stringify(r, null, 2));
  console.log(
    `[backfill-payment-method-attribution] mode=${r.mode} charges=${r.charges_fetched} ` +
    `success ${r.success_rows_written}/${r.success_candidates} · failures ${r.failure_rows_written}/${r.failure_candidates} ` +
    `· profiles_with_attribution=${r.profiles_with_attribution} failure_rows=${r.failure_rows_total} pending=${r.pending_after}`,
  );

  await closeDb();
  // `--check` is the idempotency ASSERTION: non-zero while any row is still un-backfilled.
  // Plain dry-run stays exit 0 — reporting pending work is not itself a failure.
  process.exit(check && r.pending_after > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[backfill-payment-method-attribution] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
