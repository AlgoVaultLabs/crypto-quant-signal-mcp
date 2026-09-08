/**
 * GROWTH-TG-QUOTA-PARITY-W1 CH1 — the public, machine-readable plan-ladder surface.
 *
 * WHY THIS EXISTS. `src/lib/plans.ts` is the ladder SoT, but before this wave it was reachable
 * over HTTP only through `/api/entitlement/state`, which requires bot-internal auth AND a
 * subscriber `api_key`. A FREE, unlinked Telegram chat has no counterpart for either, so the bot
 * could not DERIVE the free allowance it enforces — it hand-typed it, in eleven places, in three
 * languages. Publishing the ladder is what turns CH2's "derive, don't hand-type" into something
 * other than a second hand-typed constant. (CH0/P3 probed every one of the 76 routes in
 * `index.ts` plus `/capabilities`: no surface returned the ladder. This is the first.)
 *
 * WHY A REGISTRAR MODULE RATHER THAN INLINE IN index.ts. `index.ts` boots the server at import, so
 * a handler closure defined there cannot be exercised by a test without starting the whole
 * process — CLAUDE.md's "make entrypoints test-importable" rule, and the same shape
 * `webhook-api.ts::registerWebhookRoutes` and `entitlement-api.ts::registerEntitlementRoutes`
 * already use. `tests/plans-public-api.test.ts` boots THIS registrar on an ephemeral port and
 * asserts over real HTTP against the real handler.
 *
 * ALLOW-LIST, NOT DENY-LIST (`build-and-runtime.md` LAW). `buildPublicPlansBody()` is an EXPORTED
 * PURE FORMATTER with a declared TS interface: the response is constructed field-by-field from
 * named plan fields, so an internal field cannot leak by being forgotten in a deny-list. Nothing
 * here reads a customer count, a subscriber row, `outcome_return_pct`, or any DB at all.
 *
 * `_algovault` IS ON THE ALLOW-LIST — ratified 2026-08-27 (Q3=b), against this chapter's own
 * initial recommendation to exempt the endpoint. `public-cta.ts` declares that any future public
 * JSON endpoint merges `buildPublicCtaBlock()`; `audits/public-cta-shape-snapshot-2026-07-15.json`
 * already lists `_algovault` and its four sub-keys under each endpoint's `allowed_keys`. The block
 * is a pure formatter returning static approved copy — no I/O, no live figures — so it changes
 * neither the cost profile nor the cacheability of a static projection. Exempting the first
 * endpoint that finds a universal rule inconvenient is how the rule dies, and an agent fetching
 * our pricing JSON is the highest-intent CTA placement on the estate.
 *
 * 🛑 `generated_at` IS A RENDER STAMP, NOT A FRESHNESS SIGNAL. It is the only per-request-varying
 * field in the body. `verification-gates.md` — "freshness alarms measure PRODUCERS, never rendered
 * artifacts" — so nothing may key a staleness alarm on it: it would report this process's clock,
 * not the ladder's cadence. The ladder changes only on deploy, and the container restart is its
 * real invalidation boundary. It is emitted because a machine consumer benefits from knowing when
 * a cached copy was minted; it is documented as a render stamp in the shape snapshot so no future
 * canary mistakes it for one.
 */
import type { Express } from 'express';
import {
  PLANS,
  FREE_MONTHLY_CALLS,
  FREE_DAILY_CALLS,
  PREPAY_6MONTH_MONTHS,
  planPrepayTotalUsd,
  type PaidPlanId,
} from './plans.js';
import { buildPublicCtaBlock, type PublicCtaBlock } from './public-cta.js';

/**
 * Render order for `tiers[]`, DECLARED rather than inherited from `Object.keys(PLANS)`.
 *
 * `build-and-runtime.md`: a load-bearing property must never be RENTED from another module's
 * iteration order. Object-literal key order is stable in practice, which is exactly what makes
 * depending on it a trap — it survives review and breaks on a refactor nobody connected to this
 * file. `tests/plans-public-api.test.ts` asserts this array's SET equals `Object.keys(PLANS)`, so
 * a plan added to the SoT and forgotten here fails a test instead of silently vanishing from the
 * public ladder.
 */
export const PUBLIC_PLAN_ORDER: readonly PaidPlanId[] = ['starter', 'pro', 'enterprise'];

/**
 * Plans sold by CONTACT, not from a page — the ones with no publishable self-serve figures.
 *
 * DECLARED, exactly like `PUBLIC_PLAN_ORDER` above and for the same stated reason: a load-bearing
 * property must not be inferred from a coincidence in another module's data. The tempting
 * inferences are all wrong. `dailyCalls === null` is about PACING and would couple two unrelated
 * facts. `priceUsd6Month === undefined` is about a TERM nobody priced, not about whether a
 * monthly figure may be published. And `priceUsdMonthly` cannot carry it: enterprise really is
 * `299` in `plans.ts` because `ENTERPRISE_PRICE_ID` stays live and unarchived in Stripe so an
 * in-flight subscription never breaks. **Enforcement is not the commercial offer**, and this
 * constant is the line between them.
 *
 * WHY THIS EXISTS AT ALL. `GET /api/plans/public` published `price_usd: 299` on the enterprise
 * rung while `brand-facts.md:552` listed "$299/mo as an Enterprise list price" as a HIGH-severity
 * forbidden phrase and `:143` stated Enterprise no longer publishes a price. Every human surface
 * already refused it — `signup-flow.ts` renders a contact-us line, `emit-pricing-tokens.mjs`
 * emits "Custom volume — contact us" — but each of them hardcoded that judgement separately, so
 * the ONE machine-readable surface, the one deliberately fed to AI crawlers, was the only place
 * nobody had said it. That is the defect: the fact was real and encoded four times ad hoc, and a
 * fifth renderer inherited none of them.
 *
 * ⚠️ RESIDUAL DEBT, named rather than hidden: this belongs in `plans.ts` as one exported
 * predicate every renderer projects from. This wave's chapter firewall splits `plans.ts` (CH3)
 * from this file (CH1), so no single chapter may create it. `tests/plans-public-api.test.ts`
 * pins this set against `planPriceLabel`'s refusal so the two cannot silently disagree, and
 * `OPS-PLANS-CONTACT-US-PREDICATE-W{NEXT}` collapses them into one derivation.
 */
export const CONTACT_US_PLANS: readonly PaidPlanId[] = ['enterprise'];

/**
 * The monthly price this plan PUBLISHES, or `null` when it is sold by contact.
 *
 * 🛑 `null` is a REFUSAL, in the same voice as `planDailyCallsLabel` and `planPrepayTotalUsd`: it
 * means "there is no self-serve price to state", never zero and never "free". A consumer must
 * OMIT the figure — rendering `null`, `0`, or a fabricated number is the defect this replaces.
 */
export function publishedMonthlyPriceUsd(id: PaidPlanId): number | null {
  return CONTACT_US_PLANS.includes(id) ? null : PLANS[id].priceUsdMonthly;
}

/**
 * The monthly call allowance this plan PUBLISHES, or `null` when it is sold by contact.
 *
 * `brand-facts.md:134` gives Enterprise's quota and daily cap as `custom` / `custom`. Publishing
 * `100000` also made Enterprise indistinguishable from Pro on the public ladder, which is a
 * second way of being wrong. `license.ts` keeps ENFORCING 100,000 — unchanged by this wave.
 */
export function publishedMonthlyCalls(id: PaidPlanId): number | null {
  return CONTACT_US_PLANS.includes(id) ? null : PLANS[id].monthlyCalls;
}

/** One paid tier, as it appears in the public ladder. */
export interface PublicPlanTier {
  readonly id: PaidPlanId;
  readonly label: string;
  /**
   * Monthly call allowance, or `null` when the plan is sold by CONTACT and publishes no figure.
   *
   * 🛑 `null` is a REFUSAL, the same one `daily_calls` and `price_usd_6month` below already carry.
   * It means "custom — ask us", never zero and never unlimited. `brand-facts.md:134` gives
   * Enterprise's quota as `custom`; `license.ts` still ENFORCES 100,000, because enforcement is
   * not the commercial offer. A consumer must render the absence, never substitute a number.
   */
  readonly monthly_calls: number | null;
  /**
   * Per-UTC-day cap, or `null` when the plan declares none.
   *
   * 🛑 `null` is a REFUSAL, not "unlimited" and not zero — `plans.ts::planDailyCallsLabel` carries
   * the same warning for the copy path. Enterprise is `null` because no real deal has set one. A
   * consumer must render the absence, never substitute a number or the word "unlimited".
   */
  readonly daily_calls: number | null;
  /**
   * Monthly price in USD, or `null` when the plan is sold by CONTACT and publishes no price.
   *
   * 🛑 `null` is a REFUSAL — "there is no self-serve price to state". Rendering `0`, `"null"` or a
   * fabricated figure is the exact defect this field's nulling exists to retire: this endpoint
   * published `299` for Enterprise while `brand-facts.md:552` listed that as a HIGH-severity
   * forbidden phrase and every human surface already said "Contact us".
   *
   * The KEY REMAINS PRESENT. `tiers_value_keys` stays a stable six-key set so no consumer's
   * key-set assertion breaks; only the value refuses.
   */
  readonly price_usd: number | null;
  /**
   * TOTAL charged for the six-month prepay term, or `null` when the plan is not sold on it.
   *
   * 🛑 `null` is a REFUSAL, exactly as `daily_calls` above — "not sold on this term", never zero
   * and never a scaled-down monthly. `plans.ts::planPrepayTotalUsd` already refuses to fabricate a
   * term nobody priced, and this field is that refusal projected onto the wire. Enterprise is
   * `null` because it has no self-serve prepay Price.
   *
   * It is a TOTAL, not a monthly rate: `39.9` is what the buyer's card is charged once. A consumer
   * rendering it beside `price_usd` must say so (`$39.90/6mo`), or it reads as a price cut.
   *
   * Added by GROWTH-TG-PLAN-PICKER-W1 R1, discharging `OPS-PLANS-PUBLIC-PREPAY-FIELD-W1`. The
   * Telegram bot's plan picker renders four SKUs — two of them prepay — and before this field the
   * two 6-month prices were hand-typed in three places, which is the `_TIER_QUOTA` generator defect
   * `scripts/check-quota-refusal-seam.py` L4 exists to make unwritable.
   */
  readonly price_usd_6month: number | null;
}

/** The free tier's two meters. Both are REAL caps: a call is refused when EITHER is exhausted. */
export interface PublicFreeTier {
  readonly monthly_calls: number;
  readonly daily_calls: number;
}

/** The complete public plan-ladder response. Every field is public by construction. */
export interface PublicPlansBody {
  readonly free: PublicFreeTier;
  readonly tiers: readonly PublicPlanTier[];
  /** Render stamp — see the module docstring. NOT a producer-freshness signal. */
  readonly generated_at: string;
  readonly _algovault: PublicCtaBlock;
}

/**
 * Projects the ladder from `plans.ts` at call time. Never a literal.
 *
 * Pure: no I/O, no DB, no cache, no shared mutable state. `now` is injectable so a test can pin
 * `generated_at` without stubbing the clock globally.
 */
export function buildPublicPlansBody(now: Date = new Date()): PublicPlansBody {
  return {
    free: {
      monthly_calls: FREE_MONTHLY_CALLS,
      daily_calls: FREE_DAILY_CALLS,
    },
    tiers: PUBLIC_PLAN_ORDER.map((id) => {
      const plan = PLANS[id];
      return {
        id,
        label: plan.label,
        // Both project through a helper that REFUSES, exactly as `price_usd_6month` below already
        // does — never an `id === 'enterprise'` branch. The projection stays tier-agnostic and the
        // judgement lives in ONE named place (`CONTACT_US_PLANS`), so a future contact-us tier
        // inherits the refusal instead of needing a fifth renderer to be told about it.
        monthly_calls: publishedMonthlyCalls(id),
        daily_calls: typeof plan.dailyCalls === 'number' ? plan.dailyCalls : null,
        price_usd: publishedMonthlyPriceUsd(id),
        // Projected through `planPrepayTotalUsd`, never off `plan.priceUsd6Month` directly: that
        // helper is where "a term nobody priced must never be fabricated by scaling a term that
        // was priced" lives, and reading the field raw here would be a second derivation of the
        // same decision — the drift the single-derivation rule exists to prevent.
        price_usd_6month: planPrepayTotalUsd(id, PREPAY_6MONTH_MONTHS),
      };
    }),
    generated_at: now.toISOString(),
    _algovault: buildPublicCtaBlock(),
  };
}

/**
 * `public, max-age=300`.
 *
 * The value changes only on deploy, so any TTL is "correct" for data freshness; 300s is chosen to
 * match the bot's EXISTING five-minute entitlement-drain cadence (CH2's ladder mirror rides that
 * cron — no new schedule), so the mirror can never be more than one drain cycle behind an edge
 * copy. There is no serving hot path here: the handler is a pure projection with no DB touch.
 *
 * (The cron spec is deliberately spelled out in words: a literal slash-star-slash-five inside a
 * JSDoc block closes the comment — CLAUDE.md build-and-runtime, the `examples/<glob>/demo.py`
 * trap.)
 */
export const PLANS_PUBLIC_CACHE_HEADER = 'public, max-age=300';

export function registerPlansPublicRoutes(app: Express): void {
  app.get('/api/plans/public', (_req, res) => {
    res.setHeader('Cache-Control', PLANS_PUBLIC_CACHE_HEADER);
    res.json(buildPublicPlansBody());
  });
}
