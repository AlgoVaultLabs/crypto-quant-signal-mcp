/**
 * Payment-method report — PAY-UNIONPAY-ATTRIBUTION-W1 (R6).
 *
 * The aggregation behind `GET /dashboard/api/payment-methods`. Admin-gated, so this is an
 * OPERATOR surface and never public copy — the repo names zero card brands on any
 * user-visible page, and adding one is a separate decision requiring explicit approval.
 *
 * This module derives NOTHING about payment methods itself. Every brand/country/funding value
 * it reads was written by `resolvePaymentMethodAttribution` on the webhook path, and the
 * failure aggregates come from `stripe-payment-failures-store`. One derivation, two readers.
 *
 * ── Why every rate ships its own denominator description ─────────────────────────────────
 * The two sides of this ratio are NOT the same unit, and saying so in the payload is the
 * whole point:
 *
 *   successes → `subscriber_profiles`, one row per converted CUSTOMER
 *   failures  → `stripe_payment_failures`, COUNT(DISTINCT payment_intent_id)
 *
 * So `decline_rate_pct` is "declined payments as a share of (conversions + declined
 * payments)" — an operational decline rate, NOT an issuer authorization rate. A reader who
 * assumed the latter would compare it against published card-network benchmarks and reach a
 * wrong conclusion. (Not that any such benchmark exists for UnionPay cross-border: the
 * circulating "98.3%" figure is fabricated, which is exactly why this wave measures rather
 * than cites.) `rate_definition` travels WITH the number so the caveat cannot be separated
 * from it by a copy-paste.
 */
import { dbQuery } from './performance-db.js';
import {
  getFailureAggregate,
  WINDOW_LABELS,
  type FailureAggregate,
  type WindowLabel,
} from './stripe-payment-failures-store.js';
import { ensureSubscriberPaymentMethodColumns } from './subscriber-attribution.js';

const PG = !!process.env.DATABASE_URL;

const WINDOW_HOURS: Readonly<Record<WindowLabel, number | null>> = Object.freeze({
  'Last 24h': 24,
  'Last 30d': 24 * 30,
  Lifetime: null,
});

/** Same dialect-correct predicate as the failures store; `hours` is never caller-supplied. */
function sinceClause(column: string, hours: number | null): string {
  if (hours === null) return '1=1';
  if (!Number.isInteger(hours) || hours <= 0) throw new Error(`sinceClause: bad hours ${hours}`);
  return PG
    ? `${column} >= NOW() - INTERVAL '${hours} hours'`
    : `${column} >= datetime('now', '-${hours} hours')`;
}

const num = (v: unknown): number => Number(v ?? 0) || 0;

export interface SuccessAggregate {
  window: WindowLabel;
  total_n: number;
  by_brand: { card_brand: string | null; n: number }[];
  by_method_type: { payment_method_type: string | null; n: number }[];
  by_card_country: { card_country: string | null; n: number }[];
}

export interface BrandDeclineRate {
  card_brand: string | null;
  succeeded_n: number;
  failed_n: number;
  /** succeeded_n + failed_n — printed so no rate ever appears without its own denominator. */
  total_n: number;
  /** `null` when total_n is 0: a rate over nothing is not 0%, it is unmeasured. */
  decline_rate_pct: number | null;
  /**
   * `true` when `total_n < 20`. CLAUDE.md requires count/total alongside any pass-rate at
   * n<20; this flag lets a consumer refuse to render a percentage rather than merely
   * printing one in small type next to its n.
   */
  low_confidence: boolean;
}

export interface PaymentMethodWindowReport {
  window: WindowLabel;
  successes: SuccessAggregate;
  failures: FailureAggregate;
  decline_rate_by_brand: BrandDeclineRate[];
  /**
   * Observed population in this window: converted customers + distinct failed payments.
   *
   * Computed HERE, once, because TWO consumers need it — this report's own endpoint and
   * `/dashboard/api/payment-rails` (PAY-RAIL-DASHBOARD-W1 R2b). Deriving it again in the
   * caller would be two expressions of one quantity, in a panel whose entire job is to report
   * that quantity honestly.
   *
   * This is the DASHBOARD's population figure. The decline canary computes the same quantity
   * independently, in its own process, against the same tables — they agree by construction of
   * the query, not by shared code. See `CalibrationState.canaryAttribution`.
   */
  population_n: number;
}

export interface PaymentMethodReport {
  generated_at: string;
  rate_definition: string;
  low_confidence_threshold_n: number;
  windows: PaymentMethodWindowReport[];
}

/** n below which a percentage is not trustworthy on its own (CLAUDE.md telemetry rule). */
export const LOW_CONFIDENCE_N = 20;

/**
 * Map key standing in for a NULL brand when joining the success and failure sides.
 *
 * 🛑 WRITTEN AS AN ESCAPE, NEVER AS A RAW NUL BYTE. A `U+0000` typed literally into source
 * makes the agent shell's `grep` (an embedded ugrep carrying a hardcoded `-I`) classify the
 * whole FILE as binary and skip it — silently, at exit 0, so "no matches" becomes
 * indistinguishable from "searched and found nothing". This module shipped with exactly that
 * byte and `scripts/check-source-greppable.mjs` caught it at pre-push. The compiled string is
 * byte-identical either way; only the source is greppable.
 *
 * A NUL is the right SENTINEL — no real card brand can collide with it — which is precisely
 * why the fix is the encoding and not the value.
 */
const NULL_BRAND_KEY = '\u0000null';

const RATE_DEFINITION =
  'decline_rate_pct = failed_n / (succeeded_n + failed_n). ' +
  'succeeded_n counts subscriber_profiles rows (one per converted customer); ' +
  'failed_n counts COUNT(DISTINCT payment_intent_id) in stripe_payment_failures. ' +
  'This is an OPERATIONAL decline rate, not an issuer authorization rate — the two ' +
  'sides are different units and must not be compared against card-network benchmarks.';

async function getSuccessAggregate(window: WindowLabel): Promise<SuccessAggregate> {
  await ensureSubscriberPaymentMethodColumns();
  const where = sinceClause('converted_at', WINDOW_HOURS[window]);

  const [totals] = await dbQuery<{ n: unknown }>(
    `SELECT COUNT(*) AS n FROM subscriber_profiles WHERE ${where}`,
    [],
  );

  const group = (col: string, limit: number) =>
    dbQuery<{ k: string | null; n: unknown }>(
      `SELECT ${col} AS k, COUNT(*) AS n FROM subscriber_profiles WHERE ${where}
        GROUP BY ${col} ORDER BY n DESC LIMIT ${limit}`,
      [],
    );

  const [brands, methods, countries] = await Promise.all([
    group('card_brand', 20),
    group('payment_method_type', 20),
    group('card_country', 30),
  ]);

  return {
    window,
    total_n: num(totals?.n),
    by_brand: brands.map((r) => ({ card_brand: r.k, n: num(r.n) })),
    by_method_type: methods.map((r) => ({ payment_method_type: r.k, n: num(r.n) })),
    by_card_country: countries.map((r) => ({ card_country: r.k, n: num(r.n) })),
  };
}

/**
 * Join successes and failures per brand. PURE — exported so the ratio has ONE derivation and
 * a test can pin it without a database.
 *
 * A brand present on only one side still appears, with 0 on the other. Dropping it would hide
 * the most important row this report can produce: a brand that has ONLY ever failed.
 */
export function computeDeclineRates(
  successesByBrand: readonly { card_brand: string | null; n: number }[],
  failuresByBrand: readonly { card_brand: string | null; n: number }[],
): BrandDeclineRate[] {
  const key = (b: string | null) => b ?? NULL_BRAND_KEY;
  const succ = new Map(successesByBrand.map((r) => [key(r.card_brand), r.n]));
  const fail = new Map(failuresByBrand.map((r) => [key(r.card_brand), r.n]));

  const brands = new Map<string, string | null>();
  for (const r of successesByBrand) brands.set(key(r.card_brand), r.card_brand);
  for (const r of failuresByBrand) brands.set(key(r.card_brand), r.card_brand);

  return [...brands.entries()]
    .map(([k, brand]) => {
      const succeeded_n = succ.get(k) ?? 0;
      const failed_n = fail.get(k) ?? 0;
      const total_n = succeeded_n + failed_n;
      return {
        card_brand: brand,
        succeeded_n,
        failed_n,
        total_n,
        // A rate over an empty population is UNMEASURED, not 0%. Emitting 0 would read as
        // "nothing ever declined on this brand", which is a claim nobody made.
        decline_rate_pct: total_n === 0 ? null : Math.round((failed_n / total_n) * 1000) / 10,
        low_confidence: total_n < LOW_CONFIDENCE_N,
      };
    })
    .sort((a, b) => b.total_n - a.total_n);
}

/** The full report — every window, every counter labelled. */
export async function getPaymentMethodReport(): Promise<PaymentMethodReport> {
  const windows = await Promise.all(
    WINDOW_LABELS.map(async (window): Promise<PaymentMethodWindowReport> => {
      const [successes, failures] = await Promise.all([
        getSuccessAggregate(window),
        getFailureAggregate(window),
      ]);
      return {
        window,
        successes,
        failures,
        decline_rate_by_brand: computeDeclineRates(successes.by_brand, failures.by_brand),
        population_n: successes.total_n + failures.distinct_payment_intents,
      };
    }),
  );

  return {
    generated_at: new Date().toISOString(),
    rate_definition: RATE_DEFINITION,
    low_confidence_threshold_n: LOW_CONFIDENCE_N,
    windows,
  };
}
