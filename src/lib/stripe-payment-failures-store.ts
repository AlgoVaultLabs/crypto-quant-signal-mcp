/**
 * `stripe_payment_failures` — the decline record. PAY-UNIONPAY-ATTRIBUTION-W1 (R2/R4a).
 *
 * Mirrors `stripe-events-store.ts`'s contract deliberately: `event_id TEXT PRIMARY KEY` +
 * `ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, one awaited round-trip, and
 * `dbRun` (the fire-and-forget writer) never imported. Same reasoning as SEC-20 — a claim
 * made through `dbRun` is neither atomic nor durable.
 *
 * ── 🛑 THE DEDUP DIMENSION IS `payment_intent_id`, NOT `event_id` ────────────────────────
 * These two ids answer different questions and conflating them inflates the decline rate:
 *
 *   `event_id`         — "have we already PROCESSED this webhook delivery?" (replay safety)
 *   `payment_intent_id`— "how many distinct PAYMENTS actually failed?" (the metric)
 *
 * ONE declined card fires BOTH `payment_intent.payment_failed` AND `charge.failed`. Those
 * are two events, two event_ids, two rows — and ONE failed payment. Counting rows would
 * report a 2x decline rate off a single decline. So **every rate in this module and in the
 * canary is computed over `COUNT(DISTINCT payment_intent_id)`**, never `COUNT(*)`.
 *
 * Measured on the live account before this wave shipped: `payment_intent.payment_failed` = 3
 * and `charge.failed` = 1 over the same window. They are demonstrably not 1:1 — and that
 * asymmetry is itself signal rather than noise: a PI-failure with NO matching `charge.failed`
 * means the payment was blocked or failed authentication BEFORE charge creation, whereas both
 * firing means the issuer saw the charge and declined it. Keeping both rows (deduped at read
 * time) preserves that distinction; deduping at WRITE time would destroy it permanently.
 */
// NB: `dbRun` deliberately NOT imported — see the module header.
import { dbExec, dbQuery } from './performance-db.js';
import crypto from 'node:crypto';
import { resolvePaymentFailureDetail, readCardFingerprint, type PaymentFailureDetail } from './payment-method-attribution.js';
import { resolveIpHashKey } from './analytics.js';

const PG = !!process.env.DATABASE_URL;
const TS = PG ? 'TIMESTAMPTZ' : 'TIMESTAMP';

const CREATE_STRIPE_PAYMENT_FAILURES_SQL = `
  CREATE TABLE IF NOT EXISTS stripe_payment_failures (
    event_id TEXT PRIMARY KEY,
    payment_intent_id TEXT,
    source_event_type TEXT,
    occurred_at ${TS} NOT NULL,
    payment_method_type TEXT,
    card_brand TEXT,
    card_country TEXT,
    card_funding TEXT,
    decline_code TEXT,
    failure_code TEXT,
    failure_message TEXT,
    outcome_type TEXT,
    outcome_reason TEXT,
    outcome_seller_message TEXT,
    outcome_risk_level TEXT,
    amount_usd ${PG ? 'NUMERIC' : 'REAL'},
    tier TEXT,
    customer_id TEXT,
    invoice_id TEXT,
    subscription_id TEXT,
    card_ref TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_spf_occurred_at ON stripe_payment_failures (occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_spf_payment_intent_id ON stripe_payment_failures (payment_intent_id);
  CREATE INDEX IF NOT EXISTS idx_spf_customer_id ON stripe_payment_failures (customer_id);
  CREATE INDEX IF NOT EXISTS idx_spf_card_ref ON stripe_payment_failures (card_ref);
`;

// ── The three linkage columns, added to a table that already exists in PROD ────────────────
//
// 🛑 WHY THEY EXIST: without them the table cannot say WHOSE payment failed, and the R9 canary
// therefore could not tell one dunned customer from three failing ones. Measured on the live
// account 2026-08-22 — 6 rows over 30d, ALL of them one customer / one subscription / one
// invoice / one PaymentIntent — while `COUNT(DISTINCT COALESCE(payment_intent_id, event_id))`
// reported THREE distinct failed payments and tripped the absolute floor of 3.
//
// `customer` is the field that makes this recoverable: measured on api_version
// `2026-03-25.dahlia`, it is present on ALL THREE subscribed event types, while `invoice` is
// absent from both charge and PI objects and `payment_intent` is absent from the Invoice. So a
// customer is the only unit every failure event can be attributed to, and it is the unit the
// floor predicate actually means.
//
// Same idempotent-ALTER shape as referral-store.ensureReferralPayoutColumns: PG's ADD COLUMN IF
// NOT EXISTS is natively idempotent; SQLite has none and needs the PRAGMA pre-check.
const LINKAGE_COLUMNS = Object.freeze(
  ['customer_id', 'invoice_id', 'subscription_id', 'card_ref'] as const,
);

let _linkageColInit = false;
export async function ensurePaymentFailureLinkageColumns(): Promise<void> {
  if (_linkageColInit) return;
  ensureStripePaymentFailuresSchema();
  if (PG) {
    dbExec(LINKAGE_COLUMNS.map(
      (c) => `ALTER TABLE stripe_payment_failures ADD COLUMN IF NOT EXISTS ${c} TEXT;`).join('\n'));
  } else {
    const rows = await dbQuery<{ name: string }>('PRAGMA table_info(stripe_payment_failures)', []);
    const have = new Set(rows.map((r) => r.name));
    const missing = LINKAGE_COLUMNS.filter((c) => !have.has(c));
    if (missing.length) {
      dbExec(missing.map((c) => `ALTER TABLE stripe_payment_failures ADD COLUMN ${c} TEXT;`).join('\n'));
    }
  }
  _linkageColInit = true;
}

/** Reset the linkage-column latch — tests only. */
export function _resetPaymentFailureLinkageInitForTest(): void {
  _linkageColInit = false;
}

let _initialized = false;

/** Single multi-statement `dbExec` — never N sequential calls (CLAUDE.md DDL-bundling rule). */
export function ensureStripePaymentFailuresSchema(): void {
  if (_initialized) return;
  dbExec(CREATE_STRIPE_PAYMENT_FAILURES_SQL);
  _initialized = true;
}

/** Reset the init latch — tests only. */
export function _resetPaymentFailuresInitForTest(): void {
  _initialized = false;
}

export interface StripePaymentFailureRow extends PaymentFailureDetail {
  eventId: string;
  paymentIntentId: string | null;
  sourceEventType: string;
  /** ISO-8601. Taken from the Stripe object's own `created`, NEVER `now()` — a backfilled
   *  row stamped with wall-clock time would silently claim today's failures happened today. */
  occurredAt: string;
  amountUsd: number | null;
  tier: string | null;
  /** The ONLY id present on all three subscribed failure events — see LINKAGE_COLUMNS above. */
  customerId: string | null;
  /** Present on `invoice.payment_failed` (the object's own id); null elsewhere on `dahlia`. */
  invoiceId: string | null;
  subscriptionId: string | null;
  /** Keyed per-card pseudonym — see hashCardRef. NEVER the raw fingerprint. */
  cardRef: string | null;
}

/**
 * Insert one failure row. Returns `true` if NEW, `false` if this `event_id` was already
 * recorded (Stripe replay). Idempotent by construction.
 *
 * This is a RECORD, not a claim: the caller has already claimed the event via `tryClaimEvent`
 * before running any side-effect (R4a reuses that one claim rather than adding a second).
 * The `ON CONFLICT` here is belt-and-braces for the backfill path, which has no webhook
 * delivery to claim against.
 */
export async function recordPaymentFailure(row: StripePaymentFailureRow): Promise<boolean> {
  await ensurePaymentFailureLinkageColumns();
  const inserted = await dbQuery<{ event_id: string }>(
    `INSERT INTO stripe_payment_failures (
       event_id, payment_intent_id, source_event_type, occurred_at,
       payment_method_type, card_brand, card_country, card_funding,
       decline_code, failure_code, failure_message,
       outcome_type, outcome_reason, outcome_seller_message, outcome_risk_level,
       amount_usd, tier, customer_id, invoice_id, subscription_id, card_ref
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [
      row.eventId,
      row.paymentIntentId,
      row.sourceEventType,
      row.occurredAt,
      row.methodType,
      row.cardBrand,
      row.cardCountry,
      row.cardFunding,
      row.declineCode,
      row.failureCode,
      row.failureMessage,
      row.outcomeType,
      row.outcomeReason,
      row.outcomeSellerMessage,
      row.outcomeRiskLevel,
      row.amountUsd,
      row.tier,
      row.customerId,
      row.invoiceId,
      row.subscriptionId,
      row.cardRef,
    ],
  );
  return inserted.length > 0;
}

/** Current card-pseudonym derivation version. Bump ONLY together with a key rotation. */
export const CARD_REF_VERSION = 'v1';

/**
 * A KEYED, non-reversible pseudonym for a physical card. `v1:<16 hex>`, or null.
 *
 * ── WHY A PSEUDONYM AND NOT THE FINGERPRINT ───────────────────────────────────────────────
 * The decline floor needs to know whether two failures came from the SAME CARD — an equality
 * question, which never requires the value itself. And `payment-method-attribution.ts` carries a
 * structural PAN prohibition asserting it "never emits last4, fingerprint, iin or cardholder name
 * even when present". A Stripe fingerprint is not a PAN and is not reversible to one, but it IS a
 * stable CROSS-MERCHANT identifier for a physical card, so that control is pointing at something
 * real. Storing a keyed hash satisfies the counter exactly and stores nothing linkable.
 *
 * HMAC-SHA256 under the server-side key already provisioned for `hashIp`, with a `card:` DOMAIN
 * PREFIX so the two pseudonym namespaces cannot collide or be cross-joined. Reusing the key is
 * deliberate: a second secret means a second provisioning, rotation and leak surface for no gain,
 * and domain separation is the purpose-built answer. A rotation bumps both version tags together.
 *
 * 🛑 IT RETURNS NULL RATHER THAN THROWING WHEN THE KEY IS ABSENT. `hashIp` throws by design — an
 * unkeyed pseudonym is the reversible bug wearing a new label — but this runs inside a LIVE
 * PAYMENT WEBHOOK, and a guard on a serving path refuses, it does not throw. No key ⇒ no card
 * ref ⇒ the canary's COALESCE falls back to `customer_id`, i.e. exactly the pre-wave behaviour.
 * Degraded, never broken, and never silently unkeyed.
 */
export function hashCardRef(fingerprint: string | null | undefined): string | null {
  if (typeof fingerprint !== 'string' || fingerprint.trim() === '') return null;
  let key: string;
  try {
    key = resolveIpHashKey();
  } catch {
    console.warn('[stripe-payment-failures] no pseudonym key — card_ref degrades to NULL '
      + '(the decline floor falls back to customer_id; it does NOT store an unkeyed value)');
    return null;
  }
  const mac = crypto.createHmac('sha256', key).update(`card:${fingerprint.trim()}`).digest('hex').slice(0, 16);
  return `${CARD_REF_VERSION}:${mac}`;
}

// ── Event → row (pure; the webhook cases are thin shells over this) ──────────────────────

/**
 * The three failure events this repo subscribes to, and where each carries the PI id.
 *
 * `payment_intent.payment_failed` is the PRIMARY. On a `mode: 'subscription'` Checkout flow a
 * FIRST-payment failure — the blocked-China-user case this wave was opened for — surfaces
 * here; `invoice.payment_failed` fires only on a RENEWAL. Measured on the live account over
 * Stripe's 30-day event window before shipping: `payment_intent.payment_failed` = 3,
 * `charge.failed` = 1, `invoice.payment_failed` = **0**. The spec's original two-event set
 * would have missed the majority of the signal it was written to capture.
 */
export const PAYMENT_FAILURE_EVENT_TYPES: readonly string[] = Object.freeze([
  'payment_intent.payment_failed',
  'charge.failed',
  'invoice.payment_failed',
]);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
const idOf = (v: unknown): string | null =>
  typeof v === 'string' ? v : str((v as { id?: unknown })?.id);

/**
 * Map a Stripe failure event to a row. PURE — no I/O, no clock, no throw. Exported so the
 * webhook case in `index.ts` stays a thin shell and the mapping is unit-testable without a
 * server (CLAUDE.md's test-importable-entrypoints rule).
 *
 * Returns `null` only when the event carries no usable object at all.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildPaymentFailureRow(event: any): StripePaymentFailureRow | null {
  const eventId = str(event?.id);
  const eventType = str(event?.type);
  const object = event?.data?.object;
  if (!eventId || !eventType || !object || typeof object !== 'object') return null;

  // Where the PaymentIntent id lives differs per event: a PI event's own `id` IS the PI, and a
  // Charge REFERENCES one.
  //
  // 🛑 AN INVOICE DOES NOT — MEASURED, not assumed. On the account's live api_version
  // `2026-03-25.dahlia`, `invoice.payment_failed`'s object has NO `payment_intent` key at all
  // (`hasOwnProperty` -> false), so the old unconditional `idOf(object.payment_intent)` wrote
  // NULL for every invoice event. The modern linkage is `payments[].payment.payment_intent`,
  // which the webhook payload does NOT expand — measured absent on both live events — so it is
  // read here for the BACKFILL path (which fetches with `expand[]=payments`) and the legacy
  // `payment_intent` is kept as the fallback for pre-`basil` payloads. On a live webhook this
  // still resolves to null, and that is exactly why `customerId` below is the load-bearing one.
  const invoicePaymentIntent = (obj: any): string | null =>
    idOf(obj?.payments?.data?.[0]?.payment?.payment_intent) ?? idOf(obj?.payment_intent);
  const paymentIntentId =
    eventType === 'payment_intent.payment_failed' ? idOf(object.id)
      : object.object === 'invoice' ? invoicePaymentIntent(object)
        : idOf(object.payment_intent);

  // The linkage the metric actually needs. `customer` is present on ALL THREE subscribed event
  // types (measured on `dahlia`), which is why the R9 floor counts distinct CUSTOMERS: Stripe's
  // dunning fires a fresh `invoice.payment_failed` per retry attempt, so any per-event unit
  // makes one unpaid card look like a systemic outage on the third retry.
  const customerId = idOf(object.customer);
  const invoiceId = object.object === 'invoice' ? idOf(object.id) : idOf(object.invoice);
  // `subscription` moved off the Invoice into `parent.subscription_details` — measured absent at
  // the top level on `dahlia`, present under `parent`. Both are read so neither shape is lost.
  const subscriptionId =
    idOf(object.subscription) ?? idOf(object?.parent?.subscription_details?.subscription);

  // occurred_at from the Stripe object's OWN timestamp, falling back to the event's.
  // NEVER `now()` — the backfill shares this mapper, and a wall-clock stamp would file
  // four-month-old declines as having happened today, silently fabricating a spike.
  const createdEpoch =
    typeof object.created === 'number' ? object.created
      : typeof event.created === 'number' ? event.created
        : null;
  const occurredAt = createdEpoch !== null ? new Date(createdEpoch * 1000).toISOString() : new Date(0).toISOString();

  // `amount_usd` means USD. Our account settles in MYR (`default_currency=myr`, measured)
  // while `plans.ts` prices in USD, so the currency is NOT assumable. Anything not already
  // USD writes NULL rather than a fabricated conversion at an invented rate.
  const rawAmount = typeof object.amount === 'number' ? object.amount
    : typeof object.amount_due === 'number' ? object.amount_due
      : null;
  const currency = str(object.currency)?.toLowerCase() ?? null;
  const amountUsd = rawAmount !== null && currency === 'usd' ? rawAmount / 100 : null;

  const detail = resolvePaymentFailureDetail(object);

  return {
    ...detail,
    eventId,
    paymentIntentId,
    sourceEventType: eventType,
    occurredAt,
    amountUsd,
    tier: str(object?.metadata?.tier) ?? str(object?.lines?.data?.[0]?.metadata?.tier),
    customerId,
    invoiceId,
    subscriptionId,
    // Measured on `dahlia`: present on charge.failed and payment_intent.payment_failed, ABSENT
    // from invoice.payment_failed — which is why the canary joins the ref per CUSTOMER, not per
    // row. The raw fingerprint lives only in this expression and is never stored.
    cardRef: hashCardRef(readCardFingerprint(object)),
  };
}

// ── Read side (R6 + R9 canary) ───────────────────────────────────────────────────────────

/** The declared measurement windows. Every counter carries its label — never a bare number. */
export type WindowLabel = 'Last 24h' | 'Last 30d' | 'Lifetime';

const WINDOW_HOURS: Readonly<Record<WindowLabel, number | null>> = Object.freeze({
  'Last 24h': 24,
  'Last 30d': 24 * 30,
  Lifetime: null,
});

export const WINDOW_LABELS: readonly WindowLabel[] = Object.freeze(['Last 24h', 'Last 30d', 'Lifetime']);

/**
 * Dialect-correct "within the last N hours" predicate.
 *
 * `hours` is never caller-supplied — it comes from the frozen `WINDOW_HOURS` map — but it is
 * asserted to be a finite integer anyway, because it is interpolated rather than bound. PG's
 * `INTERVAL` and SQLite's `datetime()` modifier cannot take a bind parameter in this position
 * on both backends, so interpolation is forced; the assertion is what keeps it safe.
 */
function sinceClause(column: string, hours: number | null): string {
  if (hours === null) return '1=1';
  if (!Number.isInteger(hours) || hours <= 0) throw new Error(`sinceClause: bad hours ${hours}`);
  return PG
    ? `${column} >= NOW() - INTERVAL '${hours} hours'`
    : `${column} >= datetime('now', '-${hours} hours')`;
}

export interface BrandCount {
  card_brand: string | null;
  n: number;
}
export interface MethodTypeCount {
  payment_method_type: string | null;
  n: number;
}
export interface CodeCount {
  code: string | null;
  n: number;
}

export interface FailureAggregate {
  window: WindowLabel;
  /** THE metric denominator — distinct failed payments, not rows. */
  distinct_payment_intents: number;
  /** Raw row count. Exposed alongside so the dedup is visible rather than implied. */
  rows: number;
  by_brand: BrandCount[];
  by_method_type: MethodTypeCount[];
  top_decline_codes: CodeCount[];
  top_outcome_types: CodeCount[];
}

const num = (v: unknown): number => Number(v ?? 0) || 0;

/**
 * Failure aggregates for one window.
 *
 * A row with a NULL `payment_intent_id` (possible on a malformed or very old payload) cannot
 * be deduped, so it is counted as its own distinct payment via the `event_id` fallback —
 * COUNT(DISTINCT) would otherwise DROP it entirely and silently under-report the failure
 * count. Under-reporting a decline is the one direction this metric must never fail in.
 */
export async function getFailureAggregate(window: WindowLabel): Promise<FailureAggregate> {
  ensureStripePaymentFailuresSchema();
  const where = sinceClause('occurred_at', WINDOW_HOURS[window]);

  const [totals] = await dbQuery<{ distinct_pi: unknown; rows: unknown }>(
    `SELECT COUNT(DISTINCT COALESCE(payment_intent_id, event_id)) AS distinct_pi,
            COUNT(*) AS rows
       FROM stripe_payment_failures WHERE ${where}`,
    [],
  );

  const group = async (col: string, limit: number) =>
    dbQuery<{ k: string | null; n: unknown }>(
      `SELECT ${col} AS k, COUNT(DISTINCT COALESCE(payment_intent_id, event_id)) AS n
         FROM stripe_payment_failures WHERE ${where}
        GROUP BY ${col} ORDER BY n DESC LIMIT ${limit}`,
      [],
    );

  const [brands, methods, declines, outcomes] = await Promise.all([
    group('card_brand', 20),
    group('payment_method_type', 20),
    group('decline_code', 10),
    group('outcome_type', 10),
  ]);

  return {
    window,
    distinct_payment_intents: num(totals?.distinct_pi),
    rows: num(totals?.rows),
    by_brand: brands.map((r) => ({ card_brand: r.k, n: num(r.n) })),
    by_method_type: methods.map((r) => ({ payment_method_type: r.k, n: num(r.n) })),
    top_decline_codes: declines.map((r) => ({ code: r.k, n: num(r.n) })),
    top_outcome_types: outcomes.map((r) => ({ code: r.k, n: num(r.n) })),
  };
}

/** Distinct failed payments in the last N hours — the canary's absolute-floor input. */
export async function countDistinctFailedPayments(hours: number | null): Promise<number> {
  ensureStripePaymentFailuresSchema();
  const [row] = await dbQuery<{ n: unknown }>(
    `SELECT COUNT(DISTINCT COALESCE(payment_intent_id, event_id)) AS n
       FROM stripe_payment_failures WHERE ${sinceClause('occurred_at', hours)}`,
    [],
  );
  return num(row?.n);
}
