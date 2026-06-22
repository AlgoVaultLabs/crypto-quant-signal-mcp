# REFERRAL-PARITY-NOTIFS-W1 — Plan-Mode Step-0 endpoint-truth

Wave: REFERRAL-PARITY-NOTIFS-W1 (Tier-2 Bulk-Spec, 2 chapters, cross-repo). Closes referral audit #6.
Probed `origin/main` `e7075ba` (delta since payout waves = all OPS-TIER-CLASSIFIER; **referral code unchanged**). Architect-ratified Q1–Q4.

## Probe results (claim | reality | resolution)

| Anchor | Reality | Resolution |
|---|---|---|
| `/api/referral/code.stats` carries commission $? | `resolveTgReferralCode` (referral-api.ts) returns `stats{signups,conversions,accrued_usd_e2,credited_usd_e2,usdc_pending_usd_e2}` from `referrerStats` — **but lacks `usdc_paid_usd_e2` + the payout-min** | **Q3:** additive extend — `stats.usdc_paid_usd_e2` + `terms.usdc_min_payout_usd`. No reshape; e2=cents throughout; bot ÷100 |
| accrual trigger | `processInvoicePaid` → `appendLedger` (idempotent on `stripe_event_id`); `led.appended`=new-row | `commission_earned` fires on `led.appended` only; `source_id='led:<id>'` |
| attribution trigger | **3 call sites**: `processFreeReferralSignup`, `onPaidConversion` (referral-accrual.ts), `attributeTgReferral` (referral-api.ts); `recordAttribution` (referral-store) is pure-persistence | `friend_joined` fires on `recorded:true` at the 3 sites via one shared helper; queue dedups on `source_id='attr:<id>'` |
| `tgIdentity` salt secret/auth-reused? | `algovault-tg-identity-v1` used **ONLY** in referral-api.ts `tgIdentity` (2 lines); `checkInternalBypass` uses a SEPARATE secret (`ALGOVAULT_INTERNAL_BYPASS_KEY`). So it's a **non-secret data-minimization salt** | **Q2:** replicate-salt is technically OK, but we take the **code-as-join-key** default (cleaner; no cross-repo HMAC drift). The tg notification row carries `code`; the bot caches `code`→`chat_id` (new `subscribers.referral_code` col, set from `/api/referral/code` resp) + resolves locally. Engine never gets a chat_id for notifications |
| bot drain host | bot has **no PTB JobQueue** — periodic work = host-cron scripts (`daily-digest.sh`, `check-npm-unlocks.sh */10`) | C2 drain = NEW host-cron script (`*/5`), not a PTB job |
| rate-safe sender | `broadcast.py` `sendDM`/`_send_with_retry` (backoff 1/2/4s, 429+Forbidden, `bot_blocked`) | C2 reuses it; **never `send_telegram.sh`** |
| migration | latest = `017` (payout-address) | new table/col = **`018`**; SSH pre-apply + dual-backend `IF NOT EXISTS` |
| `checkInternalBypass` | two-flag (`BOT_INTERNAL_BYPASS_ENABLED`+`X-AlgoVault-Internal-Key`), gates `/api/referral/*` | the 3 new internal routes reuse it |

## Frozen contract (C1 freezes; C2 consumes, never mutates)
- **Table `referral_notifications`** (migration 018): `id, referrer_code TEXT, event TEXT('friend_joined'|'commission_earned'), channel TEXT('email'|'tg'), payload_json TEXT, status TEXT('pending'|'delivered'), source_id TEXT, created_at` + UNIQUE`(channel, source_id)` (replay idempotency).
- **Pref:** `referral_codes.notify_opt_out` (BOOLEAN/INTEGER default false=ON). Single column = single-derivation; both the TG `/notifications` toggle and the email manage-link write it; `notifyReferrer` checks it once.
- **3 internal routes** (internal-key-gated): `GET /api/referral/notifications?status=pending&channel=tg&limit=N` → `[{id, code, event, payload}]` (code, NOT tg:hash); `POST /api/referral/notifications/:id/delivered`; `POST /api/referral/notify-pref {tg:<chat_id>, opt_out}` (engine hashes). Plus a PUBLIC signed email unsubscribe `GET /referral/notify/unsubscribe?c=<code>&t=<sig>`.
- **Parity fields:** `/api/referral/code` → `stats.usdc_paid_usd_e2` + `terms.usdc_min_payout_usd` (additive; allow-list excludes `outcome_*`).
- **Events:** `friend_joined`, `commission_earned`. **Numbers:** all from `REFERRAL_TERMS` (grep-gated).

## Identifier diff (R ↔ AC) — consistent
events `friend_joined`/`commission_earned` · queue cols above · `notify_opt_out` · routes above · SoT `REFERRAL_TERMS{BONUS_CALLS, COMMISSION_RATE→pct, COMMISSION_MONTHS, USDC_MIN_PAYOUT_USD}` · money e2=cents.

## No-leak allow-list
Notification payload + `/api/referral/code` stats + TG render expose ONLY the referrer's own counts/commission $ (their data) — NEVER `outcome_return_pct`/`outcome_price`/Phase-E, and NEVER the friend's identity ("a friend joined", never their email). User notifications via the bot's user-messaging (`sendDM`) + email ONLY — never `send_telegram.sh`.
