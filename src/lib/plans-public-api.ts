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

/** One paid tier, as it appears in the public ladder. */
export interface PublicPlanTier {
  readonly id: PaidPlanId;
  readonly label: string;
  readonly monthly_calls: number;
  /**
   * Per-UTC-day cap, or `null` when the plan declares none.
   *
   * 🛑 `null` is a REFUSAL, not "unlimited" and not zero — `plans.ts::planDailyCallsLabel` carries
   * the same warning for the copy path. Enterprise is `null` because no real deal has set one. A
   * consumer must render the absence, never substitute a number or the word "unlimited".
   */
  readonly daily_calls: number | null;
  readonly price_usd: number;
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
        monthly_calls: plan.monthlyCalls,
        daily_calls: typeof plan.dailyCalls === 'number' ? plan.dailyCalls : null,
        price_usd: plan.priceUsdMonthly,
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
