# CHECKOUT-COMPLETION-DIAGNOSIS — checkout-start → paid-completion leak profile

**Wave:** CHECKOUT-COMPLETION-DIAGNOSIS — read-only, zero production mutation.
**Run:** 2026-06-08 04:26 UTC. **Engine:** `scripts/measure-activation-soak.mjs --profile` (extended in place, flag-not-fork), run inside the live MCP container (`STRIPE_SECRET_KEY` never left the host).
**Plan-Mode Step-0:** `audits/CHECKOUT-COMPLETION-DIAGNOSIS-endpoint-truth.md`.

---

## DIAGNOSIS verdict: `LOW-INTENT TRAFFIC`

> The checkout-start → paid-completion leak is a **traffic-quality / awareness** problem, **not** a checkout/pricing-UX problem. Recommend the **awareness levers** (A8 ICP-SHARPENING-W1, A1 TELEGRAM-FUNNEL-AUDIT-W1) over any checkout/pricing-optimization work.

**Why (three independent signals, none relying on the email proxy):**
1. **Zero quota-driven starts.** `funnel_events.upgrade_cta_clicked` = **0 all-time** → not one checkout start arrived via the in-MCP tier-warning / quota-block CTA (`?upgrade_from=quota`). Every start is a cold `/signup` or `/welcome` click.
2. **Nobody is near the ceiling.** In-window, **0** free-tier callers crossed 75 / 90 / 100 calls/period (max caller = **56**). The single lifetime ceiling-crosser (129 calls) was **2026-05-11, pre-window**. No pent-up usage-driven upgrade demand exists to convert.
3. **Cold, anonymous, curiosity traffic.** 36/38 starts are untagged `direct` hits; only 2 are `tg_bot`. Rapid multi-plan clusters (3 sessions within ~4s on 05-28, 05-25, 05-26; pairs on 06-05) indicate **one visitor sampling multiple plan tiers** → unique visitors are materially **fewer than 38**. This is pricing-page browsing, not purchase intent.

**Honesty caveat (why not `MIXED`):** the email-capture mid-funnel proxy is **unmeasurable** on this hosted single-page Checkout (`customer_details.email` populates only on payment submission — see §Telemetry honesty), so I cannot *positively* exclude that a minority of the 37 expired sessions had real intent and bailed at the price step. But signals 1–3 are independent of email and converge decisively on low intent, and there is **no** corroborating evidence of price-step friction (0 ceiling-pressure, 0 upgrade-CTA traffic). Optimizing checkout/pricing would tune a step that engaged users are not reaching. → **LOW-INTENT**, not MIXED.

---

## Windows + epochs

| Window | gte | lte | UTC |
|---|---|---|---|
| Extended | `1779262200` | `1780892792` | 2026-05-20 07:30:00 → 2026-06-08 04:26:32 UTC |
| 14d sub-window (SOAK) | `1779262200` | `1780471800` | 2026-05-20 07:30:00 → 2026-06-03 07:30:00 UTC |

## Funnel (R1 → R2 → R3)

Raw N (all-status) = **38** → operator-excluded M = **0** → **analyzed = 38**. (Pull: 1 Stripe page, `has_more=false`; statuses ∈ {complete:1, expired:37}.)

| Stage | 14d sub-window (n=27) | Extended (n=38) |
|---|---|---|
| **S0** STARTED-no-email | **27 (100.0%)** | **37 (97.4%)** |
| **S1** ENGAGED-no-pay | 0 (0.0%) | 0 (0.0%) |
| **S2** PAID | 0 (0.0%) | 1 (2.6%) |

The lone S2 is `cs_live_a1hvV1…` ($9.99 starter, `direct`, created 2026-06-07 01:48 UTC) — the organic post-SOAK-window completion; 0 paid inside the 14d window.

**Operator exclusion (R2):** input N=38 → excluded M=0 (email 0 / session-id 0 / utm_source 0 / utm_campaign 0) → analyzed 38. *Caveat:* operator end-to-end **abandoned** tests would be `expired` with no email and (unless their session-id is in the filter) are not strippable. Mr.1 verified checkout by **completing** it (→ paid, not abandoned), and 37 abandons is not operator behavior, so residual operator contamination of the expired pool is assessed **low**; it does not change the diagnosis.

## Traffic-quality split (R4)

- **Engaged (quota-driven) starts:** `funnel_events.upgrade_cta_clicked` = **0** (all-time). No start carried `?upgrade_from=quota`.
- **Attribution:** `direct`/(none) = **36/38**, `tg_bot` = **2/38**. (`client_reference_id` prefixes corroborate: `direct:…` ×36, `tg_bot:…` ×2.)
- **Product engagement depth:** `request_log` in-window = **641 free** calls (~34/day) vs 23,924 internal; spread thin (max single free caller = 56 calls/period).
- **No identity bridge:** `client_reference_id` is a synthetic per-click id (`${utm}:${ts}:${rand}`), so a start cannot be joined to a *specific* known product user. → engaged-vs-cold is read from `upgrade_cta_clicked` (0) + utm. **Instrumentation gap** flagged for a future FUNNEL-INSTRUMENTATION wave.

## Quota-pressure (R5)

`quota_usage(tracker_key='free:<key>', call_count, period_start)`. Distinct free callers crossing thresholds:

| Threshold | In-window (period_start ≥ 2026-05-20) | Lifetime |
|---|---|---|
| ≥ 75 calls | **0** | 1 |
| ≥ 90 calls | **0** | 1 |
| ≥ 100 calls (free cap) | **0** | 1 |

Max in-window caller = **56** calls. The single lifetime crosser (129) was 2026-05-11 (pre-window). ⇒ the in-MCP `tier_warning`/`tier_limit_reached` paywall path effectively **never fired** for in-window users — the 27–38 starts are not quota-pressured upgrades.

## Per-source × per-stage (R6)

| utm_source | S0 STARTED-no-email | S1 ENGAGED-no-pay | S2 PAID | total |
|---|---|---|---|---|
| `direct`/(none) | 35 | 0 | 1 | 36 |
| `tg_bot` | 2 | 0 | 0 | 2 |
| **total** | **37** | **0** | **1** | **38** |

## Telemetry honesty note (Stripe)

Stripe hosted Checkout does **not** expose granular "reached the card field but didn't submit" telemetry. On this **single-page** Checkout config, `customer_details` (incl. `.email`) is populated **only on payment submission** — empirically 0/37 non-paid vs 1/1 paid, confirmed via both the list endpoint and `GET`-by-id retrieval. Therefore **S1_ENGAGED_no_pay is structurally ~0 as an artifact** and is NOT claimed as evidence that visitors bounced before the email field. Email-capture is reported for completeness but is **not** the discriminator; the diagnosis rests on quota-pressure + `upgrade_cta_clicked` + attribution. No card-stage was fabricated.

## Recommended next wave

**A8 ICP-SHARPENING-W1 and/or A1 TELEGRAM-FUNNEL-AUDIT-W1** (awareness / traffic-quality). Defer checkout/pricing-optimization work until traffic carries demonstrable intent (quota-pressured users reaching the paywall, or `upgrade_cta_clicked` > 0). Secondary: a FUNNEL-INSTRUMENTATION wave to add an identity bridge (carry the product API key / a first-party analytics id through `/signup` → Stripe) so future cohorts can join starts to known users and measure mid-funnel intent directly.

## Reproduction

```bash
docker cp scripts/measure-activation-soak.mjs crypto-quant-signal-mcp-mcp-server-1:/tmp/m.mjs
docker cp audits/OPERATOR_TEST_STRIPE_FILTER.json crypto-quant-signal-mcp-mcp-server-1:/tmp/filter.json
docker exec crypto-quant-signal-mcp-mcp-server-1 node /tmp/m.mjs \
  --gte 1779262200 --lte "$(date -u +%s)" --filter /tmp/filter.json \
  --profile --subwindow-lte 1780471800 --json
```
R4/R5 corroboration (read-only) via `psql` on `quota_usage` / `funnel_events` / `request_log` — see endpoint-truth.md.
