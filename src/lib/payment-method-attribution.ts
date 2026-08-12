/**
 * Payment-method attribution resolver — PAY-UNIONPAY-ATTRIBUTION-W1.
 *
 * ONE pure derivation of the payment-method dimension, imported by BOTH the webhook write
 * path (`src/index.ts`) and the read-side admin API (`/dashboard/api/payment-methods`), per
 * CLAUDE.md's single-derivation rule. Two independent re-derivations of "which brand was
 * this" drift to contradiction, and the contradiction surfaces as an operator reading two
 * different decline rates for one population.
 *
 * ── Why this module exists at all ────────────────────────────────────────────────────────
 * Before this wave the repo recorded ZERO payment-method facts — `payment_method`,
 * `card_brand` and every brand literal returned 0 matches tree-wide. "Which method
 * converted, and why did one fail" was not a hard question, it was an unanswerable one.
 * The lane fix ("turn on UnionPay") was measured to be a no-op: UnionPay is a card BRAND
 * carried by the `card_payments` capability, not a payment method, so it has no Payment
 * Method Configuration key and no separate account capability — there is nothing to toggle.
 * The generator fix is this missing dimension.
 *
 * ── 🛑 SECURITY: the PAN prohibition is STRUCTURAL, not a convention ─────────────────────
 * Stripe hands us objects that DO carry `last4`, `fingerprint`, `iin`/`bin`, and cardholder
 * `name`. This resolver must never let one reach the database. Two independent guarantees:
 *
 *   1. ALLOW-LIST READS. Exactly four paths are read (`type`, `card.brand`, `card.country`,
 *      `card.funding`). There is no spread, no `Object.assign`, no passthrough of the source
 *      object — so a field Stripe adds tomorrow cannot appear in the output by default.
 *      (CLAUDE.md: "Allow-list (not deny-list) for public-API response shaping.")
 *
 *   2. SHAPE VALIDATION ON EVERY FIELD. Each value must match a narrow pattern before it is
 *      returned; anything else becomes `null`. This is what makes the guarantee structural
 *      rather than merely careful: even if a PAN were placed INTO `card.brand` — by a Stripe
 *      bug, a malformed test fixture, or a future refactor pointing the reader at the wrong
 *      path — it is digits, no pattern here admits digits, and the field resolves to `null`.
 *      A deny-list ("strip anything that looks like a PAN") would be the weaker inverse: it
 *      has to anticipate every shape. An allow-list only has to know what IS permitted.
 *
 * Missing data resolves to `null` — NEVER a fabricated default. A guessed brand is a wrong
 * brand that looks entirely plausible, and it would poison the very rate this wave exists to
 * measure.
 */

/** The normalized payment-method dimension. Every field independently nullable. */
export interface PaymentMethodAttribution {
  /** Stripe's payment-method `type` — `card`, `link`, … Lowercase. */
  methodType: string | null;
  /** Card brand — `visa`, `mastercard`, `unionpay`, `amex`, `jcb`, … Lowercase. */
  cardBrand: string | null;
  /** ISO-3166-1 alpha-2 issuer country, uppercase. `CN` is the cohort this wave was opened for. */
  cardCountry: string | null;
  /** `credit` | `debit` | `prepaid` | `unknown`. */
  cardFunding: string | null;
}

/** Every field null — the honest answer when nothing resolvable was supplied. */
export const EMPTY_ATTRIBUTION: Readonly<PaymentMethodAttribution> = Object.freeze({
  methodType: null,
  cardBrand: null,
  cardCountry: null,
  cardFunding: null,
});

// ── Shape validators ─────────────────────────────────────────────────────────────────────
// Deliberately narrow. Note that NONE of them admit a digit, which is what makes a
// PAN/last4/BIN unrepresentable in any output field regardless of how it got into the input.

/** Stripe method types and brands are lowercase snake/alpha tokens: `card`, `unionpay`, `us_bank_account`. */
const TOKEN_RE = /^[a-z][a-z_]{1,31}$/;
/** ISO-3166-1 alpha-2, exactly two letters. */
const ISO2_RE = /^[A-Z]{2}$/;
/** Stripe's closed funding vocabulary. */
const FUNDING_VALUES = new Set(['credit', 'debit', 'prepaid', 'unknown']);

function asToken(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return TOKEN_RE.test(s) ? s : null;
}

function asIso2(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return ISO2_RE.test(s) ? s : null;
}

function asFunding(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return FUNDING_VALUES.has(s) ? s : null;
}

/** Narrow an unknown to an indexable record without asserting anything about its contents. */
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The shapes Stripe delivers this dimension in. We do not import Stripe's types here: this
 * module is consumed by a plain-`.mjs` backfill script and by tests that construct literals,
 * and a structural read keeps all three callers on ONE derivation.
 *
 *   • PaymentMethod          → `{ type, card: { brand, country, funding } }`
 *   • Charge                 → `{ payment_method_details: { type, card: {…} } }`
 *   • PaymentIntent (failed) → `{ last_payment_error: { payment_method: {…} } }`
 */
export type PaymentMethodLike = unknown;

/**
 * Resolve the payment-method dimension from a Stripe `PaymentMethod`, `Charge`, or failed
 * `PaymentIntent`. Pure — no I/O, no clock, no throw. Unrecognized input yields all-null
 * rather than an exception, because a webhook handler must never 500 on an unfamiliar
 * payload shape: Stripe retries a non-2xx for three days, and the retry would re-deliver the
 * same unfamiliar shape.
 */
export function resolvePaymentMethodAttribution(source: PaymentMethodLike): PaymentMethodAttribution {
  const root = obj(source);
  if (!root) return { ...EMPTY_ATTRIBUTION };

  // Unwrap to the node that actually carries `type` + `card`, in specificity order.
  //   charge.payment_method_details  →  paymentIntent.last_payment_error.payment_method  →  the object itself
  const holder =
    obj(root.payment_method_details) ??
    obj(obj(root.last_payment_error)?.payment_method) ??
    root;

  const card = obj(holder.card);

  return {
    methodType: asToken(holder.type),
    cardBrand: card ? asToken(card.brand) : null,
    cardCountry: card ? asIso2(card.country) : null,
    cardFunding: card ? asFunding(card.funding) : null,
  };
}

// ── Failure detail (the decline diagnosis) ───────────────────────────────────────────────

/**
 * The failure dimension written alongside the attribution on `stripe_payment_failures`.
 *
 * The four `outcome_*` fields are what retired the "ask the operator about Radar" step
 * permanently. `GET /v1/radar/rules` does not exist (HTTP 404, "Unrecognized request URL"),
 * so Radar state was previously a question you could only answer once, by hand, from the
 * Dashboard — and only about the present. `outcome.type === 'blocked'` is Radar declaring
 * itself IN THE DATA, on every failure, forever. A one-time answer became a measurement.
 */
export interface PaymentFailureDetail extends PaymentMethodAttribution {
  /** Issuer's decline reason — `do_not_honor`, `insufficient_funds`, … */
  declineCode: string | null;
  /** Stripe's failure code — `card_declined`, `expired_card`, … */
  failureCode: string | null;
  /** Human-readable failure message. Free text, so length-capped. */
  failureMessage: string | null;
  /** `issuer_declined` | `blocked` | `invalid` | … — **`blocked` is the Radar tell.** */
  outcomeType: string | null;
  outcomeReason: string | null;
  /** Free text, length-capped. */
  outcomeSellerMessage: string | null;
  /** `normal` | `elevated` | `highest` | … */
  outcomeRiskLevel: string | null;
}

/** Free-text fields are capped rather than validated — they are diagnostic prose, not tokens. */
const FREE_TEXT_MAX = 512;

function asFreeText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s.slice(0, FREE_TEXT_MAX) : null;
}

/**
 * Resolve a failed `Charge` or `PaymentIntent` into the full failure record.
 *
 * Delegates the four attribution fields to `resolvePaymentMethodAttribution` — it does NOT
 * re-derive them. That delegation is the single-derivation rule in force: were this function
 * to read `card.brand` itself, the write path and the read path would each own a copy of the
 * same logic and the two would drift.
 */
export function resolvePaymentFailureDetail(source: PaymentMethodLike): PaymentFailureDetail {
  const attribution = resolvePaymentMethodAttribution(source);
  const root = obj(source);
  if (!root) {
    return {
      ...attribution,
      declineCode: null,
      failureCode: null,
      failureMessage: null,
      outcomeType: null,
      outcomeReason: null,
      outcomeSellerMessage: null,
      outcomeRiskLevel: null,
    };
  }

  // A Charge carries `outcome` + `failure_code` at the root; a failed PaymentIntent nests the
  // same information under `last_payment_error`.
  const err = obj(root.last_payment_error);
  const outcome = obj(root.outcome) ?? obj(err?.outcome);

  return {
    ...attribution,
    declineCode: asToken(root.decline_code ?? err?.decline_code ?? outcome?.network_decline_code),
    failureCode: asToken(root.failure_code ?? err?.code),
    failureMessage: asFreeText(root.failure_message ?? err?.message),
    outcomeType: asToken(outcome?.type),
    outcomeReason: asToken(outcome?.reason),
    outcomeSellerMessage: asFreeText(outcome?.seller_message),
    outcomeRiskLevel: asToken(outcome?.risk_level),
  };
}
