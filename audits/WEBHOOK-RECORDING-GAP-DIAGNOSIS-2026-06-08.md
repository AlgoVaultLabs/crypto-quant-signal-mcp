# WEBHOOK-RECORDING-GAP-DIAGNOSIS — why `checkout.session.completed` records nothing

**Type:** read-only forensic (zero mutation; fix PROPOSED, not executed).
**Date:** 2026-06-08. **Trigger:** ACTIVATION-PAYWALL-W1-SOAK-MEASURE (2026-06-08) found `processed_stripe_events` empty despite a real paid completion. This is the **(b)** fork of the recommended follow-up.
**Severity:** **LOW — measurement/attribution gap only. No customer harm, no revenue/entitlement impact, no security issue. No escalation.**

---

## Root cause (confirmed)

The production live Stripe webhook endpoint is **registered, enabled, correctly routed** — but **not subscribed to `checkout.session.completed`**.

```
GET /v1/webhook_endpoints/we_1TKJVZKGleoEgU2HdSvmIUIl
  url:            https://api.algovault.com/webhooks/stripe   ✓ matches app.post('/webhooks/stripe') (index.ts:1059)
  status:         enabled                                     ✓
  livemode:       true                                        ✓
  api_version:    2026-03-25.dahlia
  enabled_events: ["customer.subscription.created",
                   "customer.subscription.deleted"]           ✗ checkout.session.completed ABSENT
```

The webhook handler (`src/index.ts:1067-1074`) routes **three** event types — but Stripe only delivers the two the endpoint is subscribed to:

| event.type | handler does | subscribed? | delivered? |
|---|---|---|---|
| `customer.subscription.created` | `handleSubscriptionCreated` → **provision API key + tier** (entitlement) | ✅ yes | ✅ yes |
| `customer.subscription.deleted` | `handleSubscriptionDeleted` → cancel | ✅ yes | ✅ yes |
| `checkout.session.completed` | `tryClaimEvent` + `logRequest` (**measurement/attribution**) | ❌ **no** | ❌ **never** |

Because the event is never delivered, the `checkout.session.completed` case never executes → `processed_stripe_events` and `request_log[tool_name='stripe_checkout_completed']` are never written. This exactly explains the SOAK-MEASURE finding (0 DB rows despite a real completion).

**The handler code is correct** — it would record the event if it received it. The defect is purely the **Stripe-side event subscription**: ACTIVATION-PAYWALL-W1 shipped the handler but the endpoint's `enabled_events` was never updated to route `checkout.session.completed` to it.

### Hypotheses tested

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | Endpoint unregistered / wrong URL / not subscribed | ✅ **ROOT CAUSE** | 1 endpoint, enabled, correct URL, livemode — but `enabled_events` = `[subscription.created, subscription.deleted]`, `checkout.session.completed` absent. |
| H2 | Signature verification failing (`STRIPE_WEBHOOK_SECRET` unset/mismatched) | ❌ ruled out | Secret is set (`whsec_…`, len 38). Moot anyway — the handler never runs (event never delivered). |
| H3 | Route not exposed / reverse-proxy gap | ❌ ruled out | `app.post('/webhooks/stripe', express.raw…)` mounted (index.ts:1059); endpoint `status=enabled` at the correct public URL; the *other* two events deliver fine through it. |

**Corroboration via Stripe Events:** the generated completion event `evt_1TfVpi…` (created `1780796942` = 2026-06-07 01:49:02 UTC) has **`pending_webhooks: 0`** — Stripe had zero subscribers for this event type, so it never attempted delivery. (A subscribed-but-failing endpoint would have shown `pending_webhooks > 0` during retries.)

---

## Entitlement analysis — paying customers are NOT harmed (empirically confirmed)

API-key provisioning (the thing that grants product access) is **independent of `checkout.session.completed`**:

- **Provisioning path:** `customer.subscription.created` → `handleSubscriptionCreated` (`src/lib/stripe.ts:218-241`) → `generateApiKey()` → `customers.update(metadata:{api_key, tier})`. `generateApiKey` has **exactly one caller** (verified) — this is the sole provisioning path, and its trigger event **is** subscribed and **does** fire.
- **Entitlement resolution:** `resolveLicense` → `resolveFromApiKeyAsync` (`src/lib/license.ts:267-278`) validates the key **live against Stripe** (`stripeValidateApiKey`, 5-min TTL cache) and reads tier from the customer's active subscription — **never** from a webhook-written DB row.

**Empirical test on the real paid customer** (`cs_live_a1hvV1…`, $9.99 starter, 2026-06-07):
```
customer:       cus_UepUXyDjxzx99c
has_api_key:    true          ← key WAS provisioned
metadata.tier:  starter
subscription:   active
sequence:  session.created 01:48:16  →  subscription.created 01:49:01 (delivered → key provisioned)
                                      →  checkout.session.completed 01:49:02 (NO subscriber → not delivered)
```

✅ The customer got their API key, correct tier, and active subscription. **Entitlement is fully intact.** The only thing lost is the measurement/attribution record of the conversion.

---

## Blast radius (what the gap actually breaks — all measurement)

1. `processed_stripe_events` — never populated for checkout completions (idempotency store unused; moot while no event arrives).
2. `request_log[tool_name='stripe_checkout_completed']` — conversion-attribution rows never written → the funnel/AC4 DB-side corroboration is blind (this is why SOAK-MEASURE had to rely on the authoritative Stripe-side count).
3. `funnel-snapshot.ts` stage-8 `stripe_checkout_started` (counts `checkout.session.created` from `processed_stripe_events`) — also blind: the endpoint isn't subscribed to `checkout.session.created` **either**, and the handler has no case for it. Pre-existing, same class.

No effect on: entitlement, billing, the customer's API key, tier resolution, or any user-facing surface.

---

## Proposed fix (NOT executed — separate operator action / wave)

**Primary (closes the measurement gap): add `checkout.session.completed` to the endpoint's `enabled_events`.** Stripe-side config only — **no code change, no deploy, no container restart.** The handler is already live and correct; the same `STRIPE_WEBHOOK_SECRET` keeps signature verification valid.

- **Option A — Dashboard:** Developers → Webhooks → `we_1TKJVZ…` → *Select events* → add `checkout.session.completed` → save.
- **Option B — API** (`enabled_events` is a full-replace array — include all three):
  ```bash
  # run on the Hetzner host so the live key never leaves it:
  K=$(docker exec crypto-quant-signal-mcp-mcp-server-1 printenv STRIPE_SECRET_KEY)
  curl -s https://api.stripe.com/v1/webhook_endpoints/we_1TKJVZKGleoEgU2HdSvmIUIl -u "$K:" \
    -d "enabled_events[]=customer.subscription.created" \
    -d "enabled_events[]=customer.subscription.deleted" \
    -d "enabled_events[]=checkout.session.completed"
  ```
  *(Optionally also add `checkout.session.created` to light up funnel stage-8 `stripe_checkout_started`.)*

**Verification after applying:**
1. `stripe trigger checkout.session.completed` (test mode) OR wait for the next live completion.
2. Confirm a row appears: `SELECT count(*) FROM processed_stripe_events WHERE event_type='checkout.session.completed'` → ≥1, and `SELECT count(*) FROM request_log WHERE tool_name='stripe_checkout_completed'` → ≥1.
3. `docker logs crypto-quant-signal-mcp-mcp-server-1 | grep 'checkout.session.completed processed'` shows the success log.

**Caveats for the fix wave:**
- **Backfill:** the 1 historical completion (`evt_1TfVpi…`) will **not** auto-record (Stripe doesn't retroactively deliver to a newly-added event type). If historical attribution completeness matters, resend it from the Dashboard (Events → the event → *Resend*) after the fix, or accept the 1-row gap (measurement-only, low value).
- **api_version `2026-03-25.dahlia`:** the handler reads only stable Checkout Session fields (`id`, `customer_details.email`, `customer_email`, `amount_total`, `metadata.*`, `client_reference_id`, `status`, `payment_status`) — low compatibility risk; the test-mode trigger above is the smoke test.
- **No secret rotation** — same endpoint, same `whsec_` secret; signature verification already works for the other two delivered event types.

**Recommended wave handle:** `OPS-STRIPE-WEBHOOK-EVENT-SUBSCRIPTION-W1` (or a direct operator action — it's a one-line, reversible Stripe config change). Closes the **(b)** fork of the ACTIVATION-PAYWALL follow-up.

---

## Evidence appendix (all read-only)
- `GET /v1/webhook_endpoints/we_1TKJVZ…` → `enabled_events=[subscription.created, subscription.deleted]`, enabled, livemode, url=`…/webhooks/stripe`.
- `GET /v1/events?type=checkout.session.completed` → 1 event, `pending_webhooks=0`.
- `GET /v1/events?type=customer.subscription.created` → 1 event, fired 01:49:01.
- `GET /v1/checkout/sessions/cs_live_a1hvV1…?expand[]=customer&expand[]=subscription` → `has_api_key=true`, tier `starter`, sub `active`.
- Container env: `STRIPE_WEBHOOK_SECRET` set (`whsec_`, len 38).
- Code: `src/index.ts:1059-1074` (route + switch), `src/lib/stripe.ts:209-241` (`constructWebhookEvent`, `handleSubscriptionCreated`), `src/lib/license.ts:165-278` (`resolveLicense` → `resolveFromApiKeyAsync`, live Stripe validation).
