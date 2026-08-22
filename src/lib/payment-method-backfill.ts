/**
 * One-shot payment-method attribution backfill — PAY-UNIONPAY-ATTRIBUTION-W1 (R7).
 *
 * Stripe retains full `payment_method_details` on every historical Charge, so the dimension
 * this wave adds is recoverable for the account's entire life, not just going forward.
 * Without this, `GET /dashboard/api/payment-methods` returns an EMPTY set on day one and its
 * acceptance test proves only that a route answers — the difference between demonstrating a
 * handler and demonstrating a pipeline.
 *
 * Lives in `src/lib/` (not `scripts/`) deliberately, following the three existing
 * `backfill-subscriber-*` precedents: `scripts/` is outside tsc `rootDir` and is not COPYed
 * into the runtime image, so only a compiled `dist/lib/` module can actually run in prod.
 * `scripts/backfill-payment-method-attribution.ts` is a thin tsx wrapper for local use.
 *
 * ── Idempotency, on both paths ───────────────────────────────────────────────────────────
 *   failures  → `ON CONFLICT (event_id) DO NOTHING` inside `recordPaymentFailure`
 *   successes → the UPDATE matches only rows where the columns are still NULL
 * A second run therefore writes zero rows, which `--check` asserts rather than assumes.
 *
 * ⚠️ EVERY WRITE IS AWAITED, and the tables are RE-READ before the report is returned.
 * `dbRun` is fire-and-forget on Postgres and a short-lived process exits before such a write
 * flushes — the sibling interval backfill logged 3 successes and landed 2 rows exactly that
 * way. Nothing here goes through `dbRun`.
 */
import { dbQuery } from './performance-db.js';
import { getStripeClient } from './stripe.js';
import { resolvePaymentMethodAttribution } from './payment-method-attribution.js';
import {
  ensureStripePaymentFailuresSchema,
  recordPaymentFailure,
  type StripePaymentFailureRow,
} from './stripe-payment-failures-store.js';
import { ensureSubscriberPaymentMethodColumns } from './subscriber-attribution.js';
import { resolvePaymentFailureDetail } from './payment-method-attribution.js';

export interface BackfillReport {
  mode: 'dry-run' | 'execute';
  charges_fetched: number;
  /** Succeeded charges whose customer has a profile row still missing the dimension. */
  success_candidates: number;
  success_rows_written: number;
  /** Failed charges not already recorded. */
  failure_candidates: number;
  failure_rows_written: number;
  /** Post-run re-read — the report's own verification, not its intention. */
  profiles_with_attribution: number;
  failure_rows_total: number;
  /** 0 ⇒ nothing left to do; `--check` exits non-zero when this is > 0. */
  pending_after: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
const num = (v: unknown): number => Number(v ?? 0) || 0;

/**
 * Backfill from the Stripe Charges list.
 *
 * A backfilled failure row uses the CHARGE id as its `event_id` (its primary key) and marks
 * `source_event_type` as `backfill:charge`, so provenance is visible in the data rather than
 * inferred. If a live `charge.failed` webhook later records the same underlying payment under
 * its own `evt_…` id, that is a second ROW for one payment — and it does not distort anything,
 * because every rate in this wave is computed over `COUNT(DISTINCT payment_intent_id)`. This
 * is precisely the case the dedup dimension was chosen for.
 */
export async function backfillPaymentMethodAttribution(
  opts: { execute?: boolean; limit?: number } = {},
): Promise<BackfillReport> {
  const execute = opts.execute === true;
  const limit = opts.limit ?? 100;

  await ensureSubscriberPaymentMethodColumns();
  ensureStripePaymentFailuresSchema();

  const client = getStripeClient();
  if (!client) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY absent)');

  // Paginate explicitly so the backfill is not silently capped at one page. `limit` bounds
  // total work, and a cap that is actually hit is REPORTED via `charges_fetched` rather than
  // passing silently as "we covered everything" (CLAUDE.md: no silent caps).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const charges: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any = await client.charges.list({ limit: 100 });
  for (;;) {
    charges.push(...page.data);
    if (!page.has_more || charges.length >= limit || page.data.length === 0) break;
    page = await client.charges.list({ limit: 100, starting_after: page.data[page.data.length - 1].id });
  }

  let successCandidates = 0;
  let successWritten = 0;
  let failureCandidates = 0;
  let failureWritten = 0;
  // A customer can have SEVERAL charges. In execute mode the first one fills the profile and
  // the rest stop matching the pending query, so writes are naturally per-customer — but a
  // DRY RUN writes nothing, so every charge keeps matching and the candidate count would
  // over-report (measured: 7 charges vs 4 real profiles). A reader comparing a dry-run's 7 to
  // an execute's 4 would reasonably conclude 3 rows failed silently. They did not; the two
  // numbers were counting different things. This set makes both modes count PROFILES.
  const seenCustomers = new Set<string>();

  for (const charge of charges.slice(0, limit)) {
    const chargeId = str(charge?.id);
    if (!chargeId) continue;

    if (charge.status === 'failed') {
      const detail = resolvePaymentFailureDetail(charge);
      const createdEpoch = typeof charge.created === 'number' ? charge.created : null;
      const currency = str(charge.currency)?.toLowerCase() ?? null;
      const row: StripePaymentFailureRow = {
        ...detail,
        eventId: chargeId,
        paymentIntentId: str(charge.payment_intent),
        sourceEventType: 'backfill:charge',
        // The charge's OWN created stamp — never `now()`. A wall-clock stamp would file a
        // months-old decline as today's and manufacture a spike in the 24h window.
        occurredAt: new Date((createdEpoch ?? 0) * 1000).toISOString(),
        amountUsd: typeof charge.amount === 'number' && currency === 'usd' ? charge.amount / 100 : null,
        tier: str(charge?.metadata?.tier),
        // The linkage the R9 floor counts over. A backfilled charge carries `customer`; it has
        // no invoice/subscription reference on the account's api_version, and a fabricated one
        // would be worse than a null.
        customerId: str(charge.customer as string | null | undefined),
        invoiceId: null,
        subscriptionId: null,
      };
      const [already] = await dbQuery<{ n: unknown }>(
        'SELECT COUNT(*) AS n FROM stripe_payment_failures WHERE event_id = ?', [chargeId],
      );
      if (num(already?.n) > 0) continue;
      failureCandidates++;
      if (execute && (await recordPaymentFailure(row))) failureWritten++;
      continue;
    }

    if (charge.status !== 'succeeded') continue;
    const customerId = typeof charge.customer === 'string' ? charge.customer : str(charge?.customer?.id);
    if (!customerId) continue;

    const attr = resolvePaymentMethodAttribution(charge);
    if (!attr.methodType && !attr.cardBrand) continue; // nothing resolvable — write nothing

    // Only fill rows still missing the dimension. This is what makes a second run a no-op,
    // and it also means the backfill can never OVERWRITE a value the live webhook path
    // established — the webhook is the fresher, more authoritative writer.
    const pending = await dbQuery<{ customer_id: string }>(
      `SELECT customer_id FROM subscriber_profiles
        WHERE customer_id = ? AND payment_method_type IS NULL AND card_brand IS NULL`,
      [customerId],
    );
    if (pending.length === 0) continue;
    if (seenCustomers.has(customerId)) continue;   // already counted/filled this profile
    seenCustomers.add(customerId);
    successCandidates++;
    if (execute) {
      // `RETURNING` is not decoration: `dbQuery` runs `.all()`, and better-sqlite3 THROWS
      // ("This statement does not return data") on a bare UPDATE. The RETURNING clause makes
      // it a reader statement on both backends — the same reason `tryClaimEvent` uses
      // `INSERT … RETURNING`. Using `dbRun` instead would be worse: it is fire-and-forget, and
      // a short-lived backfill process exits before the write flushes.
      await dbQuery(
        `UPDATE subscriber_profiles
            SET payment_method_type = COALESCE(payment_method_type, ?),
                card_brand          = COALESCE(card_brand, ?),
                card_country        = COALESCE(card_country, ?),
                card_funding        = COALESCE(card_funding, ?)
          WHERE customer_id = ?
        RETURNING customer_id`,
        [attr.methodType, attr.cardBrand, attr.cardCountry, attr.cardFunding, customerId],
      );
      successWritten++;
    }
  }

  // Re-read AFTER every awaited write — the report verifies rather than narrates.
  const [profiles] = await dbQuery<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM subscriber_profiles
      WHERE payment_method_type IS NOT NULL OR card_brand IS NOT NULL`, [],
  );
  const [failures] = await dbQuery<{ n: unknown }>(
    'SELECT COUNT(*) AS n FROM stripe_payment_failures', [],
  );

  return {
    mode: execute ? 'execute' : 'dry-run',
    charges_fetched: charges.length,
    success_candidates: successCandidates,
    success_rows_written: successWritten,
    failure_candidates: failureCandidates,
    failure_rows_written: failureWritten,
    profiles_with_attribution: num(profiles?.n),
    failure_rows_total: num(failures?.n),
    // In execute mode the candidates were consumed; in dry-run they are what remains to do.
    pending_after: execute
      ? successCandidates - successWritten + (failureCandidates - failureWritten)
      : successCandidates + failureCandidates,
  };
}
