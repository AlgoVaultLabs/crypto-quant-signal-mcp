# PRICING-FLAT-CALL-BILLING-AND-6MONTH-W1 — CH1 backtest (READ-ONLY)

**Run:** 2026-08-08 · **Mutations: ZERO** (SELECT only; no DDL, no DML, no Stripe write)
**Data:** `signal_performance` on `204.168.185.24`, `request_log` 266,279 rows spanning
`2026-04-07T13:04:09Z → 2026-08-08T06:26:07Z`. Stripe read live via the app container's own
`STRIPE_SECRET_KEY` (never printed, never copied to the operator machine).
**Access pattern:** `docker exec crypto-quant-signal-mcp-postgres-1 psql -U "$POSTGRES_USER" -tA -F'|' -c …`
(`POSTGRES_USER=algovault`, `POSTGRES_DB=signal_performance` — the role is **not** `postgres`).

> 🔒 **REDACTED — this repository is PUBLIC.** Stripe customer ids, API-key fragments, `ip_hash`
> values and full Stripe Price ids are replaced by stable pseudonyms (`SUB-A…F`, `KEY-A…D`,
> `FREE-1…5`, `FREE-Q1…Q4`, `X402-1…3`, `price_…<last6>`). Every count, ratio and verdict below is
> unmodified. The unredacted copy lives in the private vault at
> `audits/PRICING-FLAT-CALL-BILLING-W1-backtest-FULL-PRIVATE.md`; pseudonyms map 1:1 to it in
> row order.

---

## AC1.6 — HALT branches: both CLEAR

| Branch | Trigger | Measured | Outcome |
|---|---|---|---|
| Spec-Q1 | any paying subscriber exceeds the new caps | **none of 4** — worst is 5.1% of its monthly cap | ✅ no HALT |
| Spec-Q2 | any x402 caller > $20/mo of new HOLD cost | **max $0.02/mo** (3 callers, 11 calls in 30d) | ✅ no HALT |

---

## AC1.2 — Per-tier verdict mix (verdict-bearing rows, all time)

| tier | n | HOLD | actionable | HOLD % |
|---|---:|---:|---:|---:|
| internal | 192,661 | 191,446 | 1,215 | **99.37%** |
| free | 40,926 | 40,362 | 564 | **98.62%** |
| starter | 2,893 | 2,829 | 64 | **97.79%** |
| pro | 14 | 14 | 0 | 100.00% |
| x402 | 7 | 7 | 0 | 100.00% |

**Caller-level hold ratio**, external only, callers with ≥20 verdict calls (n=111):
**p50 = 0.9902 · p95 = 1.0000 · mean = 0.9857**.

> Replaces the spec's estimates. The spec offered "caller-side ~98.5%" (**confirmed** — measured
> 98.62% for free) and "engine-side ~91.7%" (**that figure is the Merkle-verified ACCURACY, not a
> hold rate** — the real engine-side hold rate is 99.2% on `get_trade_call`). Any copy deriving a
> hold-rate claim must use ~99%, not 91.7%.

**Per-tool verdict carriage** — only 3 tools emit a verdict at all:

| tool | rows | HOLD | actionable | null verdict |
|---|---:|---:|---:|---:|
| `get_trade_call` | 235,971 | 234,138 | 1,833 | 0 |
| `get_trade_signal` (alias) | 528 | 520 | 8 | 0 |
| `scan_trade_calls` | 22,058 | 0 | 0 | **22,058** |
| `get_market_regime` | 6,909 | — | — | 6,909 |
| `scan_funding_arb` | 559 | — | — | 559 |
| `get_equity_call` | 101 | — | — | 101 |
| `get_equity_regime` | 20 | — | — | 20 |

⚠️ `scan_trade_calls` logs **one row with a NULL verdict per request**, so `request_log` cannot
measure per-scan row counts. R-G's charge basis must be pinned by unit test, not backtested here.

---

## AC1.3 — `paying subscriber walled: NO` (all four, explicitly)

Live base: **4 active subscriptions, all monthly** — 3 × Starter @ $9.99, 1 × Pro @ $49
(`subscriber_profiles`; Stripe confirms `active:3` on the Starter monthly Price and `active:1` on
the Pro monthly Price, plus 2 canceled Starters).

| customer | tier | api key | `quota_usage` count (period start) | new monthly cap | % of cap | `paying subscriber walled` |
|---|---|---|---:|---:|---:|---|
| `SUB-A` | **pro** | `KEY-A` | **5,120** (2026-07-23) | 100,000 | 5.1% | **NO** |
| `SUB-B` | starter | `KEY-B` | 136 (2026-07-18) | 10,000 | 1.4% | **NO** |
| `SUB-C` | starter | `KEY-C` | *no tracker row* | 10,000 | 0% | **NO** |
| `SUB-D` | starter | `KEY-D` | *no tracker row* | 10,000 | 0% | **NO** |

Daily side: heaviest **paid** `ip_hash` over 90d is 339 calls total, worst single UTC day **190**
— against a 1,000/day Starter cap. Aggregate starter volume is 3,012 calls / 30d across all
starter callers combined.

### Where the Pro subscriber's 5,120 came from — and why flat billing does not multiply it

`request_log` shows **zero `pro` rows in 30 days**, which looked like a contradiction. It is not:
**webhook delivery is a third metered rail that charges quota and never writes `request_log`** —
`src/lib/webhook-delivery.ts:517` `trackCallByKey(sub.owner_key, sub.tier, quotaUnits)`.

- The Pro key owns webhook subscription **id 7**, events `["trade_call"]`.
- `webhook-delivery.ts:486` sets `quotaUnits = 1` for every event type **except** `scan_digest`
  (which uses `Math.max(1, non-HOLD count)`).
- ⇒ a `trade_call` webhook already charges **1 per delivered event regardless of verdict**.
  **Flat billing changes this rail by exactly nothing** for both live subscriptions.
- Both subscriptions (id 6 starter, id 7 pro) are `active=false`, `delivery_state=quarantined`,
  with **zero deliveries in the last 30 days**. The rail is currently dark.
- All-time `scan_digest` deliveries: 40, on subscription id **5**, which no longer exists in
  `webhook_subscriptions`. No active `scan_digest` subscription exists today.

⚠️ **Scope finding for CH3/R-G:** `webhook-delivery.ts:486` is a **FOURTH** implementation of the
non-HOLD units rule, alongside `get-trade-call.ts:790`, `scan-trade-calls.ts:260` and the
`feature-registry` declaration. The spec does not name it. Left unchanged it would keep the old
basis the moment anyone creates a `scan_digest` subscription. **Added to the CH3 edit list.**

---

## AC1.4 — x402 caller impact: `$0.02/mo` worst case (threshold $20)

| ip_hash | calls 30d | HOLD | actionable | implied new HOLD cost @ $0.02 |
|---|---:|---:|---:|---:|
| `X402-1` | 8 | 1 | 0 | **$0.02** |
| `X402-2` | 2 | 1 | 0 | **$0.02** |
| `X402-3` | 1 | 1 | 0 | **$0.02** |

All-time x402-tagged `request_log` rows: **18**, spanning `2026-06-30 → 2026-07-29`.
`processed_x402_payments` holds **18** settled rows lifetime.
**Three orders of magnitude below the $20/mo HALT threshold.** Spec-Q2 → proceed (Q2-a).

---

## AC1.5 — Stripe inventory (live read-back) + zero-annual re-confirmed

| Price ID | Product | amount | interval | count | active | subscriptions |
|---|---|---:|---|---:|---|---|
| `price_…82sxGb` | AlgoVault Starter | 999 | month | 1 | true | **3 active**, 2 canceled |
| `price_…xLiIa1` | AlgoVault Pro Subscription | 4900 | month | 1 | true | **1 active** |
| `price_…XAMhCG` | AlgoVault Entreprise | 29900 | month | 1 | true | 0 |
| `price_…JU10OC` | AlgoVault Starter — *Starter Annual* | 7900 | year | 1 | true | **0** |
| `price_…i4dETi` | AlgoVault Pro Subscription — *Pro Annual* | 29900 | year | 1 | true | **0** |

`TOTAL_PRICES=5, has_more=false` · `TOTAL_SUBSCRIPTIONS(all statuses)=6`.

✅ **Both annual Prices carry ZERO subscriptions** — re-confirmed live, so CH6.5's archive
precondition holds. (CH6 must re-run this check same-minute before archiving.)
✅ The 3 monthly Prices are the ones CH6 must leave byte-identical (AC6.2).
⚠️ `AlgoVault Entreprise` is a live typo in the Stripe **product name** (not our copy). Out of
scope; noted so a future wave does not "discover" it as drift.
⚠️ Stripe customer `metadata.tier` reads `starter` for **all six** customers including the Pro
one. Live enforcement resolves tier from the subscription's Price through the `stripe.ts`
price→tier registry, so behaviour is correct; the metadata field is stale and unused. Noted, not
fixed (out of scope).

---

## Free-tier impact under the new ladder (30d)

| metric | value |
|---|---:|
| distinct free keys | 294 |
| keys exceeding **500/mo** | **15** (5.1%) |
| keys exceeding **100/day** | **33** (11.2%) |
| total free calls | 34,994 |
| calls above the 500/mo cap | **13,973** |
| **% of free traffic disciplined** | **39.93%** |
| upstream venue fetches saved (R-F pre-fetch refusal) | **13,973** |

Heaviest free callers (30d):

| ip_hash | calls 30d | worst UTC day | HOLD | HOLD % |
|---|---:|---:|---:|---:|
| `FREE-1` | **6,880** | 2,673 | 6,780 | 98.5% |
| `FREE-2` | 2,453 | 1,892 | 2,409 | 98.2% |
| `FREE-3` | 1,217 | 1,119 | 1,178 | 96.8% |
| `FREE-4` | 1,191 | 130 | 1,171 | 98.3% |
| `FREE-5` | 1,181 | 536 | 1,174 | 99.4% |

✅ The spec's headline case is **confirmed exactly**: `FREE-1` burned **6,880** calls
(6,780 free HOLDs) for $0 and hit the 100-chargeable wall. Under the new ladder that caller is
refused at 500 calls **before the upstream fetch** (R-F), saving 6,380 venue fetches from that one
key alone.

---

## Internal / TG-bot exemption (AC4.3's biggest regression risk)

| tier | is_bot_internal | client_name | rows 30d |
|---|---|---|---:|
| internal | true | *(null)* | 83,574 |
| internal | true | `python-httpx` | 46,598 |
| internal | true | `node` | 52 |
| free | false | *(null)* | 28,097 |
| free | false | `node` | 6,755 |
| starter | false | *(null)* | 3,012 |
| x402 | false | *(null)* | 11 |

Internal daily volume, last 7 UTC days: `5,404 · 6,409 · 7,377 · 7,795 · 7,436 · 5,792 · 3,192`
— i.e. **~6,200/day**, matching the spec's figure.

✅ **Verified, not assumed:** every internal row carries `license_tier='internal'` **and**
`is_bot_internal=true`, and **no internal traffic appears under any subscriber tier**. The
`internal → Infinity` exemption in `getMonthlyQuota` is therefore sufficient; CH4 must extend the
same exemption to the daily meter or ~6,200 bot calls/day break on day one.

---

## Effective-capacity arithmetic (the S4 finding, now measured)

Using the measured per-tier hold rates, the ratio `1/(1−holdRate)` is the factor by which flat
billing accelerates meter consumption:

| tier | hold rate | consumption ×| ceiling × | today's ceiling in TOTAL calls | new ceiling | net |
|---|---:|---:|---:|---:|---:|---|
| Free | 98.62% | 72.5× | 5.0× | ~7,250 | 500 | **14.5× tighter** |
| Starter | 97.79% | 45.2× | 3.3× | ~135,700 | 10,000 | **13.6× tighter** |
| Pro | ~99% (p50) | ~102× | 6.7× | ~1,530,000 | 100,000 | **~15× tighter** |

This is the deliberate effective price rise ratified under Q5-a. It is a **ceiling** contraction:
measured actual usage shows no current subscriber within 5% of either new bound, so nobody is
walled today — but a future heavy Starter reaches the wall ~13.6× sooner than the old ladder
implied. Build Rule 8's wording is amended per Q5-a to: *"nobody walled AT CUTOVER; first-full-month
usable capacity is deliberately tighter."*

---

## `quota_usage` migration state (Build Rule 8)

671 tracker rows; 21 at or over 100. Top rows:

| tracker_key | count | period_start |
|---|---:|---|
| `KEY-A` (pro) | 5,120 | 2026-07-23 |
| `FREE-Q1` | 1,412 | 2026-07-30 |
| `FREE-Q2` | 1,101 | 2026-07-06 |
| `FREE-Q3` | 1,059 | 2026-07-06 |
| `FREE-Q4` | 529 | 2026-07-24 |
| `KEY-B` (starter) | 136 | 2026-07-18 |

⚠️ **Four free trackers already exceed the new 500/mo cap** (1,412 · 1,101 · 1,059 · 529). Because
counts are preserved and the ceiling rises 100 → 500 in the same deploy, these callers go from
*already walled at 100* to *still walled at 500* — they are **not newly walled**, but neither do
they gain headroom. Build Rule 8's "every existing tracker gains headroom" is true for the 667
trackers under 500 and **false for these four**, all of which are already-walled free keys. Stated
in `status.md` rather than silently generalised.

Note both key namespaces are live: `free:<hash>` (pre-2026-07-30 v1) and `free:v2:<hash>`. The
daily meter must key off the same `deriveTrackerKey` output, not a re-derived hash.

---

## Probe commands

Every figure above is reproducible from three scripts run via
`ssh root@204.168.185.24 'bash -s' < <script>`:

| Script | Produces |
|---|---|
| `ch1_schema.sh` | table list, `request_log` / `quota_usage` / `subscriber_profiles` columns, row span |
| `ch1_backtest2.sh` | P4 tier check · P4b internal daily · P6 subscribers · P7 x402 · P8 free impact · P9 heaviest free · P10 `quota_usage` · P11 fetches saved |
| `ch1_stripe2.sh` | S1 all Prices · S3 subs per Price · S4 annual zero-sub re-confirm · S5 customer→key map |
| `ch1_webhook2.sh` | W3 subscriptions · W4–W5 delivery volume · W6–W7 scan_digest multiplier · W9 projection |

`CH1_GREEN`
