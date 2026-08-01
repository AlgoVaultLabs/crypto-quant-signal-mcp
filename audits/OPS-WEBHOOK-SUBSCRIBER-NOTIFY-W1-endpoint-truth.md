# OPS-WEBHOOK-SUBSCRIBER-NOTIFY-W1 — CH1 Step-0 endpoint-truth

**Chapter:** CH1 (READ-ONLY, zero mutation) · **Probed:** 2026-08-01, box UTC `2026-08-01T10:51:35Z`
**Base:** worktree `ops/webhook-subscriber-notify-w1` off `origin/main` `54adf5b`
(planning probes ran at `b8fe03e`; `b8fe03e..54adf5b` touched only `scripts/check_test_baseline.sh` +
`tests/unit/test-gate-build-classifier.test.ts` — **no probed surface moved**, re-verified below).

**Verdict: ✅ CH1_GREEN.** Zero fictional primitives. One genuine blocking finding (P3), six factual drifts, and one
new tooling defect that invalidated an earlier reading of this very audit's own probes.

---

## 0. ⚠️ Methodology correction — read this before trusting any grep in this wave

`src/lib/performance-db.ts` contains **3 raw NUL bytes** (line 2329, a composite-key separator:
`` const key = `${ex}\x00${r.coin}\x00${r.timeframe}\x00${r.signal}`; ``), committed on `origin/main`.

BSD `grep` therefore classifies the whole 2778-line file as **binary and prints nothing while exiting 0**:

| probe | plain `grep` | `grep -a` / `rg` |
|---|---|---|
| `grep -c export src/lib/performance-db.ts` | *(empty)* | **73** |
| `grep -c 'CREATE TABLE' src/lib/performance-db.ts` | *(empty)* | **18** |
| `grep -rn SIGNAL_MIGRATIONS src/` | 0 hits | **5 hits** |

**This produced a false HALT during Plan Mode.** Three primitives were reported "fictional" (`SIGNAL_MIGRATIONS`, the
`information_schema`/`PRAGMA` pre-check helper, `performance-db.ts` as the DDL home) purely because plain grep could
not see the file that contains all three. **All three exist. R4.3 is accurate as written.**

**Rule for the rest of this wave: every gate and every "grep-proven" AC uses `grep -a` or `rg`.** CH3's published gate
(`grep -rn 'WEBHOOK_QUARANTINE_MAX_SEC' src/ | … | wc -l` == 0) would otherwise **skip this file silently and
false-GREEN**. This is the 5th instance of the dark-guard class CLAUDE.md records (`check-mcp-stateless.mjs`,
`INVENTORY_LOAD_FAILED … exit 0`, the two `MANUAL_PENDING` canaries, `check_test_baseline.sh`).

Root fix (raw NUL → `\u0000` escape; runtime-identical string) is **out of scope** — own wave.

---

## P1 — Subscription census

**There are 2 subscriptions. Not 6.** `(new: 6)` in the 2026-08-01 page is a subscription **ID**, not a count.

| id | delivery_state | active | tier | failure_class | disabled_reason | quarantined_at (UTC) | last_success_at | last_probe_at | next_probe_at | owner |
|---|---|---|---|---|---|---|---|---|---|---|
| 6 | `disabled` | f | `starter` | `legacy` | `quarantine_expired` | 2026-07-24 15:34:36 | **NULL** | 2026-07-31 23:02:21 | NULL | `av_live_…` |
| 7 | `active` | t | `pro` | — | — | — | 2026-08-01 10:45:02 | — | — | `av_live_…` |

By state: `disabled` = 1, `active` = 1, `degraded` = 0, `quarantined` = 0. **Total = 2.**
`free:`-owned subscriptions = **0 of 2** (both owners are `av_live_`) — matches the spec's last-recorded figure.
`url` / `secret` never read. Probe ran read-only via `psql -U algovault` (see P1-note).

| claim | reality | resolution |
|---|---|---|
| "1 subscription disabled, id 6" | ✅ exact | D3 diagnosis confirmed |
| "there are not six webhook subscriptions" | ✅ there are **2** | answer the operator's question in `status.md` |
| P1 probe role `algovault_autopilot` | ✅ correct — canary `PG_ROLE = "algovault_autopilot"` (`webhook-delivery-canary.py:57`) | container `POSTGRES_USER` is `algovault`; **both** roles read `webhook_subscriptions` fine |
| `dead=0 failed=0 total=791` | `dead=0 failed=0` ✅; `total` is a **rolling 24h window** — 791 at page time, **454** at probe time and declining | **no AC may pin `791`** |

---

## P2 — Terminal transition reason 🚦

| claim | reality | resolution |
|---|---|---|
| terminal reason is `quarantine_expired`, not `permanent_http_410` | ✅ **`quarantine_expired`** | **CH5's blocking architect gate CLEARS** — the restore in R5.3 is authorised. No 410, so the subscriber never said "Gone". |

---

## P3 — 🚧 BLOCKING: does an `owner_key → email` path exist?

**Answer: NO, not as the spec assumed. The premise is false.**

| claim | reality |
|---|---|
| "`sendKeyRecoveryEmail` is fired from `/account/recover-key`, so *some* key→email resolution exists" | ❌ **That path runs the REVERSE direction.** `accountRecoverKeyHandler` (`account-handlers.ts:281-296`) takes an email **supplied by the user** and calls `getCustomerByEmail(email)` → `{apiKey, tier}` (`stripe.ts:329`). It resolves **email → apiKey**. |

**Resolution chain, end to end, as it actually exists:**

1. `owner_key` **IS the API key** — `resolveOwner` (`webhook-api.ts:66-69`) returns `ownerKey: license.key`.
   Corroborated by `performance-db.ts:744`: *"owner_key is the quota tracker key (paid = license.key, free = …)"*.
2. `getCustomerByApiKey(apiKey)` (`stripe.ts:294`) → `{ customerId, tier }`. It runs
   `stripe.customers.search({query: "metadata['api_key']:'…'"})`, so it **already holds a customer object carrying
   `.email`** — and **discards it**. Returns null unless an **active** subscription exists.
3. **No local bridge.** Candidate stores enumerated live on prod:

| table | has api_key? | has email? | usable as owner_key→email? |
|---|---|---|---|
| `subscriber_profiles` | ❌ (PK `customer_id`) | ✅ | ❌ — no join key |
| `free_keys` | ✅ | ✅ | ❌ — free keys only; both owners here are `av_live_` |
| `referral_attributions` | `referee_key` | — | ❌ — referred users only |
| `referral_codes` | `owner_key` | ❌ | ❌ |
| `signup_emails` | ❌ | ✅ | ❌ |
| `webhook_subscriptions` | `owner_key` | ❌ | — |

Live `subscriber_profiles`: **1 row**, `starter` + `status=active`, email present. Sub 7 is `pro` and has no profile
row, so this row is *almost certainly* sub 6's owner — **but it is unjoinable without Stripe**, and inference is not
proof. Must be confirmed by the actual lookup at CH4/CH5 time.

**RESOLUTION — architect-ratified (Q4, 2026-08-01):** additively widen `getCustomerByApiKey` →
`{ customerId, tier, email }`. Zero extra round-trip (the email is already in hand), and it widens the **existing**
resolver rather than adding a second one, so single-derivation holds. Fall back to the `subscriber_profiles.email`
cache on Stripe error/timeout — the degradation pattern `stripe.ts:367` already documents.
**`src/lib/stripe.ts` is therefore ADDED to CH4's Taxonomy** (no chapter authorised it before).

**Free-tier owners:** `free:<ipHash>` owners structurally have no email. Live count today = **0**, but CH4 must still
treat `owner_unreachable` as a first-class non-throwing, non-paging outcome.

---

## P4 — Canary live state

| claim | reality | resolution |
|---|---|---|
| deployed canary byte-identical to repo | ✅ host `sha256` = `aac453da860aa80c1047121d31318f7f15c36d83e15b0feff42fb0505e668f5c` | == `monitoring-inventory.json` row `sha256` ✅ |
| disabled-set contains `6` | ✅ `.alert-state/webhook-delivery-canary-disabled.set` = `6` | that is why it has not re-fired (per-sub dedup working as designed) |
| breach counter | `.count` = `0` | every cycle today logs `HEALTHY: disabled=1 dead=0 failed=0 total=… (counter reset)` |
| cron | `13,28,43,58 * * * *` | matches inventory `schedule` ✅ |
| inventory row | `criticality: load-bearing`, `install_state: installed`, `alert_ids: [WEBHOOK_DELIVERY_DRIFT]`, `owner_wave: OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1` | CH2 must update `sha256` in the **same commit** as the canary edit |

---

## P5 — Every symbol this spec names (binary-safe re-derivation)

**15 / 15 exist. ZERO fictional primitives** (HALT threshold is ≥3 — not met).

| symbol | location |
|---|---|
| `getQuarantinedDue` · `recordProbeResult` · `recordFailureAndTransition` · `setDeliveryState` · `getSubscription` | `webhooks-store.ts:486 / 503 / 541 / 460 / 261` |
| `runHealthProbeSweep` · `startHealthProbeSweep` · `stopHealthProbeSweep` · `buildSampleEvent` | `webhook-delivery.ts:595 / 639 / 652 / 538` |
| `classifyDeliveryFailure` · `extractErrorCode` | `webhook-failure-class.ts:72 / 106` |
| `getResendClient` · `maskEmail` · `sendWelcomeEmail` · `sendKeyRecoveryEmail` | `email.ts:25 / 43 / 55 / 89` |

**R4.3 primitives — all real** (initially mis-reported absent; see §0):

| symbol | location |
|---|---|
| `SIGNAL_MIGRATIONS` | `performance-db.ts:341` (`const SIGNAL_MIGRATIONS: MigrationDescriptor[]`) |
| `information_schema` / `PRAGMA table_info` pre-check migration runner | `performance-db.ts:380-435` |
| `performance-db.ts` as DDL home | ✅ **18** `CREATE TABLE IF NOT EXISTS`, incl. `webhook_subscriptions` (`:752/:778`) and `webhook_deliveries` (`:814/:827`) |
| `tryClaimEvent` (the idempotency shape R4.3 mirrors) | `stripe-events-store.ts:75` |
| `renderEmailHtml` · `referralNotifShell` (R4.4 shells) | `email.ts:445` · `email.ts:352` |

**D5 — `email.ts` `send*` export count = 8** ✅ exactly as the spec states
(`sendWelcomeEmail`, `sendKeyRecoveryEmail`, `sendOptinConfirmationEmail`, `sendReferredFreeKeyEmail`,
`sendFreeKeyEmail`, `sendPayoutPaidEmail`, `sendReferralFriendJoined`, `sendReferralEarned`).
Confirms the map's hand-maintained "3 send paths" has drifted 3→8. Replace with an SoT pointer; **write no number**.

---

## P6 — `WEBHOOK_QUARANTINE_MAX_SEC`

| claim | reality | resolution |
|---|---|---|
| live value | **not set** in the container → code default `604800` (7d) | env override is available as CH3's rollback lever exactly as R3.1 assumes |
| consumers | **1 real reader**: `webhooks-store.ts:450` (`lifecycleEnvInt('WEBHOOK_QUARANTINE_MAX_SEC', 604800)`), consumed at `webhook-delivery.ts:601` via `lc.quarantineMaxSec`. Plus 1 docstring (`webhook-delivery.ts:589`) and 3 test refs. | CH3's single-derivation repoint is a **one-site** change |

---

## P7 — Quota-pause (D4) reachability

| claim | reality |
|---|---|
| the branch pauses silently | ✅ `webhook-delivery.ts:379-389` — `checkQuotaByKey(sub.owner_key, sub.tier)`; on `!allowed` returns `status:'pending'`, `subscriptionDisabled:false`, and a `suggested_action` string **returned to nobody** |
| "compute the owner's usage against their tier cap" | ⚠️ **spec drift** — `quota_usage` is keyed **`tracker_key`**, not `api_key` (columns: `tracker_key`, `call_count`, `period_start`, `milestone_referral_shown`). Any usage probe must use that column. |

Reachability is live, not theoretical: sub 7 is `pro` and actively delivering. Has-it-ever-fired is **not** determinable
from `request_log` (no route/status columns — see the known forensic limits); CH4 should instrument the outcome row
rather than back-fill history.

---

## P8 — Test layout + runner

| claim | reality |
|---|---|
| `npm test` = `vitest run`, vitest `^3.1.1` | ✅ `package.json:25`, `:126` |
| webhook tests are **flat** in `tests/` | ✅ **13** flat files (`webhook-api`, `webhook-auto-recovery`, `webhook-delivery`, `webhook-delivery-transition`, `webhook-events`, `webhook-failure-class`, `webhook-hmac-timestamp`, `webhook-lifecycle-store`, `webhook-ratelimit-prefix`, `webhook-ssrf{,-ipv6,-pin}`, `webhooks-store`) |
| new webhook tests go flat | ✅ confirmed — match the neighbours |

---

## Cross-cutting drifts to fold into CH3–CH5

| # | Spec | Live | Consequence |
|---|---|---|---|
| 1 | quarantined "2026-07-25 ~01:45Z" | **2026-07-24 15:34:36Z** (~10h earlier) | every derived date shifts |
| 2 | CH3 expiry "~2026-08-24", "day ~7 of 30" | **2026-08-23 15:34:36Z**; day **7.8** of 30 | **R5.4's AC pins a wrong date literal** — derive from live `quarantined_at`; no date literal in any AC |
| 3 | "no 2xx since ~2026-07-22" | `last_success_at` is **NULL** — sub 6 has **never** delivered successfully (`failure_class='legacy'` ⇒ backfilled by `backfillLegacyWebhookLifecycle`) | **R4.4's quarantine email is specified to state "when it last succeeded" — no such value exists.** Template must omit that sentence when NULL, pinned by a test |
| 4 | paid = `starter`/`pro`/`enterprise` "derived from `LicenseTier`" | `LicenseTier` (`types.ts:582`) = `free\|starter\|pro\|enterprise\|x402\|internal` — **6** members | under R3.1's "unrecognised → 7d", a **paying x402 customer gets the free-tier clock — reintroducing D2**, the defect this wave exists to fix |
| 5 | `total=791` | rolling 24h; **454** and falling | no AC may pin it |
| 6 | P7 usage vs cap | `quota_usage.tracker_key` | use the right column |

## Environment readiness (CH4/CH5 preconditions)

`RESEND_API_KEY` ✅ set · `RESEND_FROM_EMAIL` ✅ set · `STRIPE_SECRET_KEY` ✅ set · `WEBHOOK_DELIVERY_ENABLED` ✅ set ·
`WEBHOOK_QUARANTINE_MAX_SEC` **unset** (default 7d) · `SUBSCRIBER_NOTIFY_*` unset (expected — not yet built).

Live `tools/list` = **7** tools (`get_trade_call`, `get_trade_signal`, `get_market_regime`, `scan_funding_arb`,
`scan_trade_calls`, `chat_knowledge`, `search_knowledge`) — matches the spec's equity-dark expectation.
**R5.6 asserts against this measured 7**, not against a literal in the spec. Transport returned **no
`Mcp-Session-Id`** ✅ consistent with the stateless-transport contract.

---

## CH1 Acceptance Criteria

| # | Criterion | Result |
|---|---|---|
| 1 | audit file exists with `claim \| reality \| resolution` rows for P1–P8 | ✅ |
| 2 | live subscription total + per-state breakdown stated as measured numbers | ✅ total **2**; disabled 1 / active 1 |
| 3 | P3 answered with a named, code-anchored resolution chain **or** a HALT Q-block | ✅ chain named + architect-ratified widening |
| 4 | zero writes — only this file; no DB mutation; no email | ✅ |
