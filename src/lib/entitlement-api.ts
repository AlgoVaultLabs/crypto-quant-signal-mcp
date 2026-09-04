/**
 * PRICING-BOT-DELIVERY-METERING-W1 CH3 — the /api/entitlement/* HTTP surface.
 *
 * A thin shell over `consumeEntitlement`/`readEntitlement`. No business logic lives here: the
 * decision, the claim and the charge are all the primitive's, and this module only translates
 * between HTTP and that contract.
 *
 * WHY A REGISTRAR MODULE RATHER THAN INLINE IN index.ts. `index.ts` boots the server at import,
 * so a handler closure defined there cannot be exercised by a test without starting the whole
 * process — CLAUDE.md's "make entrypoints test-importable" rule, and the same shape
 * `webhook-api.ts`'s `registerWebhookRoutes` already uses. The routes still REGISTER beside
 * `/api/bot/validate-key`; only their bodies moved.
 *
 * AUTH: the same `checkBotInternalAuth` as validate-key, with byte-identical 401/403 shapes. The
 * bot must NEVER authenticate as the subscriber — it holds a `linked_api_key` for tier lookup
 * only, and promoting that to a credential would make every bot delivery indistinguishable from
 * the customer's own traffic.
 */
import type { Express } from 'express';
import express from 'express';
import type { LicenseTier } from '../types.js';
import { checkBotInternalAuth } from './bot-auth.js';
import { validateApiKey } from './stripe.js';
import { consumeEntitlement, readEntitlement } from './entitlement.js';
import { asChannelId } from './entitlement-channels.js';
import { projectEntitlementHttp } from './entitlement-http.js';
import { PLANS, DEFAULT_UPGRADE_PLAN, type PaidPlanId } from './plans.js';

export function registerEntitlementRoutes(app: Express): void {
  // ── PRICING-BOT-DELIVERY-METERING-W1 CH3 — /api/entitlement/* ────────────────────────────────
  //
  // The bot is a separate process on the same host. It needs the entitlement primitive over
  // loopback, and it must NEVER authenticate AS the subscriber to get it — the bot holds a
  // `linked_api_key` for tier lookup only, and turning that into an auth credential would make
  // every bot delivery indistinguishable from the customer's own traffic.
  //
  // Same auth as validate-key above (`checkBotInternalAuth`), same 401/403 shapes, same 404 shape
  // for an unknown key. These are thin shells over `consumeEntitlement`/`readEntitlement` — no
  // business logic lives here.
  //
  // 🛑 Neither route writes `request_log`. A debit is not a request; see the note in entitlement.ts.

  /**
   * The state fields merged onto a 200. Deliberately a SUBSET of the projection's body: `valid`
   * is omitted because a 200 from these routes has always meant "we answered", never "entitled",
   * and adding it would change a field four-month-old clients already parse.
   */
  function stateFields(p: { state: string; body: Record<string, unknown> }): Record<string, unknown> {
    const out: Record<string, unknown> = { entitlement_state: p.state };
    if (p.body.dunning !== undefined) out.dunning = p.body.dunning;
    if (p.body.subscription_status !== undefined) out.subscription_status = p.body.subscription_status;
    return out;
  }

  /** `Infinity` is not valid JSON — `JSON.stringify` emits `null` silently. Make it explicit. */
  const finiteOrNull = (n: number): number | null => (Number.isFinite(n) ? n : null);

  /** The self-serve rung above the caller's plan, projected from plans.ts. Never hand-typed. */
  function nextPlanFor(tier: string): Record<string, unknown> | null {
    const ladder: PaidPlanId[] = ['starter', 'pro'];
    const idx = ladder.indexOf(tier as PaidPlanId);
    // `enterprise` is a contact-us tier with no self-serve next rung — return null rather than
    // fabricate one. A free/x402/internal caller is upsold to the declared default.
    const next: PaidPlanId | null =
      tier === 'enterprise' ? null : idx >= 0 ? (ladder[idx + 1] ?? null) : DEFAULT_UPGRADE_PLAN;
    if (!next) return null;
    return {
      id: next,
      label: PLANS[next].label,
      monthly_calls: PLANS[next].monthlyCalls,
      price_usd: PLANS[next].priceUsdMonthly,
      signup_url: `https://api.algovault.com/signup?plan=${next}&utm_source=tg_bot&utm_campaign=plan_wall`,
    };
  }

  function entitlementBody(
    outcome: string,
    d: { allowed: boolean; tier: string; used: number; total: number; remaining: number;
         limit: string | null; periodStart: string | null; dailyDay: string | null; refusesAtWall: boolean },
  ): Record<string, unknown> {
    return {
      ok: true,
      outcome,
      tier: d.tier,
      used: d.used,
      // null means "no ceiling" — never zero. Documented for the client.
      total: finiteOrNull(d.total),
      remaining: finiteOrNull(d.remaining),
      allowed: d.allowed,
      limit: d.limit,
      period_start: d.periodStart,
      daily_day: d.dailyDay,
      refuses_at_wall: d.refusesAtWall,
      next_plan: nextPlanFor(d.tier),
    };
  }

  app.post('/api/entitlement/consume', express.json(), async (req, res) => {
    const auth = checkBotInternalAuth(req.headers as Record<string, string | undefined>);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const apiKey = String(body.api_key ?? '').trim();
    if (!apiKey) return res.status(400).json({ error: 'api_key_required' });

    // Default-deny. An unknown channel must never fall back to one that can charge.
    const channel = asChannelId(body.channel);
    if (!channel) return res.status(400).json({ error: 'unknown_channel' });

    // NEVER synthesise a key: a server-minted one defeats the guard on exactly the retry it
    // exists for, because each retry would mint a different one and every replay would charge.
    const idempotencyKey = String(body.idempotency_key ?? '').trim();
    if (!idempotencyKey) return res.status(400).json({ error: 'idempotency_key_required' });

    const rawUnits = Number(body.units ?? 1);
    const units = Number.isFinite(rawUnits) && rawUnits >= 1 ? Math.floor(rawUnits) : 1;

    // OPS-VALIDATE-KEY-INDETERMINATE-W1 CH2/CH4 — the ONE projection, and the revenue fix.
    //
    // The `if (!valid || !tier) 404` this replaces was terminal to the drainer: it stamped
    // `key_invalid_404` and the debit was never charged and never retried. A DUNNING customer
    // therefore received unlimited free deliveries for as long as Stripe kept dunning them —
    // measured at 1,987 uncharged debits over nine days.
    //
    // `chargeableTier` is what decides, NOT `valid`. Deriving the meter from `valid` is exactly
    // what produced the leak: a customer can be un-ENTITLED for API access and still owe us for
    // every alert we deliver while their card is being retried.
    const result = await validateApiKey(apiKey);
    const p = projectEntitlementHttp(result);
    if (!p.chargeableTier) return res.status(p.status).json(p.body);

    const consumed = await consumeEntitlement({
      trackerKey: apiKey, tier: p.chargeableTier as LicenseTier, channel, units, idempotencyKey,
    });
    // 200 for ALL FOUR outcomes — these are business outcomes, not transport failures. A 5xx must
    // mean the server broke, because that is the distinction the client's retry logic keys on.
    // `entitlement_state` rides along so a 200 still says WHICH kind of 200 it is. Without it a
    // charged DUNNING debit is indistinguishable from a charged ENTITLED one, and CH3's link
    // lifecycle would have nothing to read.
    return res.json({ ...entitlementBody(consumed.outcome, consumed.decision), ...stateFields(p) });
  });

  app.get('/api/entitlement/state', async (req, res) => {
    const auth = checkBotInternalAuth(req.headers as Record<string, string | undefined>);
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

    const apiKey = ((req.query.api_key as string | undefined) || '').trim();
    if (!apiKey) return res.status(400).json({ error: 'api_key_required' });
    const channel = asChannelId(req.query.channel);
    if (!channel) return res.status(400).json({ error: 'unknown_channel' });

    const result = await validateApiKey(apiKey);
    const p = projectEntitlementHttp(result);
    if (!p.chargeableTier) return res.status(p.status).json(p.body);

    // No charge, no claim — the mirror-refresh poll for an idle subscriber.
    const decision = readEntitlement(apiKey, p.chargeableTier as LicenseTier, channel);
    return res.json({ ...entitlementBody('READ', decision), ...stateFields(p) });
  });
}
