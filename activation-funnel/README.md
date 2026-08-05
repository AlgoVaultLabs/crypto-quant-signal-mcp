# Activation Funnel — Analytics Logbook

This directory is the activation analytics logbook for `crypto-quant-signal-mcp`. Its purpose is to track which activation levers we've shipped, when they went live, and what each one moved on the funnel — grounded in measurable `request_log` / `agent_sessions` data, not narrative claims. This is signal-interpretation product analytics, not outbound messaging: every entry is a dated observation on our own funnel, tied to a commit SHA and a pre/post metric, so downstream decisions stay evidence-based.

## Funnel stages glossary

- `install` — NPM download + `npx` execution of `crypto-quant-signal-mcp`
- `first_call` — distinct session_id makes its first remote tool call (any of the 3 tools)
- `second_call` — same session_id makes a second remote tool call (captured via `agent_sessions.call_count >= 2`)
- `fifth_plus_call` — same session_id reaches `agent_sessions.call_count >= 5` (stick-rate proxy)
- `paid_upgrade` — **two populations, summed. See the correction below before reading this stage.**
- `stripe_checkout_started` — distinct paid-tier Stripe Checkout Sessions created (see correction below)

## ⚠️ Correction — historical snapshots misreport two stages (REVENUE-METER-TRUTH-W6 CH5, 2026-08-05)

**Snapshots in `snapshots/` are historical records and have NOT been rewritten.** Read them with these
corrections applied. Both defects are in the *producer*, which is now fixed; the archived numbers are
what the old producer emitted.

**1. `paid_upgrade` was blind to settlement, and its glossary line above was wrong.**
It never read a Stripe payment event — the "captured via Stripe subscription creation" wording never
matched the query, and neither did the `stripe_payment_succeeded` alias comment in the code. What it
actually counted was `agent_sessions.tiers_seen` naming a paid tier, and a fourth predicate
`OR tiers_seen LIKE '%x402%'`. That fourth arm had **no settlement gate**: the x402 ledger claims an
ERC-3009 nonce *before* settlement to close the replay window, so a claim — money that may never
move — set the session tier and counted as a paid upgrade by construction. **15 of 18 lifetime x402
rows never settled.**

Measured before removing it, so the correction is not oversold: **the delta today is zero.**
`tiers_seen LIKE '%x402%'` matches **0 of 28,643 sessions all-time**; the only values that column has
ever held are `internal`, `free`, `starter`, `pro` and their combinations. Recomputed over the last
snapshot's window (2026-07-20 → 2026-08-03), `paid_upgrade` is **12 with the arm and 12 without it**.
So this was a **latent** defect that would have begun inflating the stage the first time one x402
session appeared — not an active over-count. No archived snapshot number changes.

The stage is now split and both parts are published in `paid_upgrade_detail`, because they **do not
share a unit**: `stripe_tier_sessions` counts SESSIONS, `x402_settled_wallets` counts DISTINCT
EXTERNAL PAYER WALLETS whose payment actually **settled**. There is no join key between the two
tables, so a per-session settlement gate is impossible; they are counted independently and added.

**2. `stripe_checkout_started` was structurally incapable of a non-zero value.** It counted
`processed_stripe_events` rows of type `checkout.session.created`. The webhook switch has no such
case — and, measured against the live Stripe endpoint on 2026-08-05, `checkout.session.created` is not
in its `enabled_events` either, so Stripe never sent it. **Every archived `stripe_checkout_started: 0`
means "not instrumented", never "nobody started a checkout".** It is now sourced from
`signup_attribution`, written only after a real Checkout URL exists (364 paid-tier rows all-time).
⚠️ Against 3 completed checkouts that is ~0.8%, which is **not a clean conversion base**: the endpoint
is reachable by crawlers and the funnel's own `identity_coverage` puts ~79% of traffic in the
automated bucket.

**3. A ratio labelled "retention" could exceed 1.** `quota_hit_hard → quota_hit_block` rendered
**1.214** (14 → 17). Both are `COUNT(DISTINCT session_id)`, so this is not a unit error: the
populations genuinely differ — 13 sessions emitted both, **4 emitted `block` with no `hard`**, 1 the
reverse. They come from two different emitters (`tier-warning.ts` raises the hard *warning*;
`license.ts` fires the *block*), so a session can be blocked without ever being warned. They are
siblings, not a sequence. Such a pair now reports `null` in `stage_retentions` and appears in full —
both counts and the raw ratio — under `stage_ratio_anomalies`. Nothing is dropped or clamped.

**⚠️ Tier and MRR read from `subscriber_profiles` remain UNTRUSTWORTHY, and this chapter does not fix
that.** `customer.subscription.updated` is in neither the webhook switch nor the live endpoint's
`enabled_events`, so one customer's 2026-07-17 starter→pro upgrade never reached the profile: it still
records **`starter` / $9.99 while Stripe bills $49 — MRR understated by $39.01/mo on that customer
alone.** All four profile rows read `starter` while the Stripe census is `{starter: 3, pro: 1}`, and
`reconcileCounts()` compares **totals only** (4 vs 4), so its `divergent: false` is *true* and is
nonetheless **not** evidence that profiles and Stripe agree. Owned by
`OPS-STRIPE-EVENT-SET-RECONCILE-W{NEXT}`.

## Lever Ledger

| Lever | Hypothesis (one line) | Shipped in | Commit SHA | Deploy date | Metric targeted | Verdict |
|---|---|---|---|---|---|---|
| **L1 — Signal performance resource** | Expose track_record WR/EV per cell in get_trade_signal response | pending (Phase-E gated, ≥2026-04-17) | pending | pending | second_call rate | pending |
| **L2 — HOLD rescue** | Return closest_tradeable cell on HOLD verdicts so 88% HOLD responses aren't dead-ends | v1.9.0 | 050bd95 / squashed to 2288b93 | 2026-04-15 | HOLD bounce rate, second_call rate | pending (2026-04-29 measurement) |
| **L3 — Session cohort surfacing** | Persist per-session metadata in agent_sessions table to make retention directly queryable | v1.9.0 | 75dc913 (part of PR#2 squash) | 2026-04-15 | stick_rate measurability | ✅ unblocks measurement — no metric yet |
| **L4 — Next-calls hints** | Include try_next top-3 non-HOLD cells in every response to distribute agents off BTC/ETH 1h | v1.9.0 | 75dc913 (part of PR#2 squash) | 2026-04-15 | calls_per_session, tool_call_distribution | pending (2026-04-29 measurement) |

## Snapshot Ledger

| Date | Tag | Sessions | Install-to-call | Stick-rate | HOLD rate | Notes |
|---|---|---|---|---|---|---|
| 2026-04-15 | baseline | 18 | 70.5:1 | 5.6% | 88.2% | Pre-v1.9.0 activation patch — data from analytics-funnel-snapshot-2026-04-15.md |

## How to run

- **Manual snapshot:** `cd crypto-quant-signal-mcp && npx tsx scripts/write-funnel-snapshot.ts --tag manual`
- **SQL-only:** `cat activation-funnel/queries/funnel-snapshot.sql | docker exec -i crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance`
- **Auto cron (future):** `systemctl list-timers algovault-funnel-snapshot.timer` (Hetzner VPS) — registration is a manual follow-up; see `ops/systemd/` for unit files
