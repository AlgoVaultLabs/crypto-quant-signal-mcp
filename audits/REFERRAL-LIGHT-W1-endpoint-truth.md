# REFERRAL-LIGHT-W1 — Plan-Mode Step-0 Endpoint-Truth

**Probed:** 2026-06-19 against `origin/main`. **Worktree:** `feat/referral-light-w1` off `e1249fa` (= prod HEAD; the +1 commit beyond `bb35a91`, ATTRIBUTION-SRC-COVERAGE-W1, touched only docs/landing/scripts/tests → core source anchors unchanged).

## Ship-boundary — GREENFIELD
Zero referral commits in all-history; all target files absent; no referral symbols in `src/`; no REFERRAL marker in status.md. Execute the wave (not a verify-only resume).

## Fictional-primitive tally: **0.** Every cited symbol exists. Drift is line-number float + a migration-number collision + a stale baseline claim — all inline-fixable.

| Primitive | Prompt claim (2026-06-04) | Reality (verified) | Resolution |
|---|---|---|---|
| `generateApiKey` / `validateApiKey` | stripe.ts:42 / :67 | :42 / :67 (exact) | — |
| `createCheckoutSession` | stripe.ts:142 | :142; session `metadata{tier,utm_*}` + `client_reference_id`; **no `subscription_data`** | add `refCode` → `subscription_data.metadata.ref_code` + session `metadata.ref_code` |
| `handleSubscriptionCreated` | stripe.ts:218 | :218; mints `av_live_`, `customers.update`, `sendWelcomeEmail` | hook paid attribution + bonus here (`subscription.metadata.ref_code`; key in hand) |
| `getCustomerByApiKey` | (C3) | stripe.ts:267 | referrer-credit lookup by `owner_key` |
| `customers.createBalanceTransaction` | Stripe docs | **REAL** — `node_modules/stripe/cjs/resources/Customers.js:531` (v22.0.1) | payout primitive |
| `webhookEndpoints.list/update/retrieve` | Stripe API | **REAL** — `WebhookEndpoints.js` :28 / :22 / :16 | C3.4 |
| Webhook switch | index.ts:947-997 | **index.ts:1216-1310** (`constructWebhookEvent`:1222; `customer.subscription.created`:1226; `checkout.session.completed`:1232 w/ `tryClaimEvent` + `buildSubscriberProfile`) | add `invoice.paid` + `charge.refunded` cases |
| `/signup` / `/welcome` / `/api/signup-email` | :1019 / :1075 / :1748 | **:1310 / :1400 / :2127** | add optional `ref` |
| `/account` + portal + recover-key | :1106-1108 | **:1431-1433** (`recoverKeyLimiter`) | add `/account/referrals` |
| Admin gate | chat:1260 / geo:1279 / funnel:1223 | env **`ADMIN_API_KEY`** (index.ts:1437); routes mount inside `if (adminKeyRaw){…}`; `isAdminAuthorized(req)` → 401 | mount `/admin/referrals*` inside that block, same gate |
| `initQuotaDb` / `persistTracker` / `getCallTracker` | :261 / :295 / :327 | **:402 / :432 / :446** | load `referral_bonus` at initQuotaDb; mirror persist |
| `trackCall(license,units=1)` / `trackCallByKey(key,tier,units=1)` | seam present | **:528 / :577** (units seam present); free block `count > quota` | overflow past quota consumes `bonus_remaining` |
| `getMonthlyQuota('free')` | (free allowance) | **:463 → default 100** | free base 100 unchanged; bonus is +500 on top |
| `resolveLicense` (async) / `resolveLicenseSync` | :110 / :139 | **:171 (→`resolveFromApiKeyAsync`:280)** / **:262 (→`resolveFromApiKey`:309, sync)** | async: `await lookupFreeKey`; sync (stdio): cache-only, miss → existing behavior |
| `TrackCallResult` | additive `bonus_remaining?` | :476 | add optional `bonus_remaining?` (**internal only**) |
| `tryClaimEvent` / `processed_stripe_events` | stripe-events-store.ts:72 | :72; SELECT-then-INSERT idempotency idiom | mirror for ledger event-id idempotency |
| `sendWelcomeEmail` / `sendOptinConfirmationEmail` / `maskEmail` | email.ts:48 / 139 | :48 / :149 / `maskEmail`:36 | welcome referral block; referred-free variant; mask stats |
| `EMAIL_RE` | (capture) | **stripe.ts:295** (exported) | reuse for ref capture |
| `recordFunnelEvent` / `dbExec`,`dbRun`,`dbQuery` | perf-db:809 / 631-639 | **:1007 / :797,:801,:805** | funnel rows; store CRUD (`?` placeholders, dbRun fire-and-forget no rowCount) |
| Migration number | `005_referral_tables.sql` | **005 TAKEN; latest `014_pql_candidates.sql`** | → **`015_referral_tables.sql`** |
| `signup-email` shape snapshot | audits/…2026-05-28.json | EXISTS | diff additive `ref`/key fields |
| scan/trade `_algovault` snapshot | decide bonus exposure | **STRICT** allow-list (`quota:[used,total,remaining]`) | **`bonus_remaining` PORTAL-ONLY** — envelopes byte-stable |
| Dual-backend DDL | `IF NOT EXISTS` | idiom: `process.env.DATABASE_URL ? 'BIGSERIAL/TIMESTAMPTZ/BIGINT/now()' : 'INTEGER AUTOINCREMENT/TIMESTAMP/datetime(\'now\')'`; `ON CONFLICT` works on SQLite 3.24+ & PG | mirror; soft FKs in init DDL (regex CHECK PG-only → migration only) |
| Existing attribution infra | (rides rails) | `signup_attribution` (011) + `subscriber-attribution.ts` (`buildSubscriberProfile`) | coexist — referral tables separate; add alongside, fail-open |
| Test baseline | "15-16 failures" | **GREEN / zero** (OPS-VITEST-SUITE-REPAIR-W1; `audits/test-baseline-known-failures.txt`) | any failure = NEW regression |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `RESEND_API_KEY` | presence | present; secret = **`sk_live_`** (live, not test); whsec_ ✓; Resend ✓ | **operator-confirmed: go LIVE, no test mode** |
| Prod deployed commit | — | `e1249fa` (= origin/main) | clean; deploy is direct (GitHub-flagged) |

## Gate-robustness corrections
- C1 gate `… | wc -l | grep -q "^0$"` is **macOS-BSD broken** (`wc -l` left-pads spaces) → use `cnt=$(grep -c … ); [[ "$cnt" -eq 0 ]]`.
- Baseline gate: full `vitest run` must stay GREEN (zero failures), not "≤16".

## Operator decisions (this session)
1. **Go LIVE, no test mode** — paid commission engine ships against live Stripe; proven by stubbed-Stripe integration tests (no real charges). Free path is the live AC.
2. **Full wave, auto-deploy** — implement C1→C4 + pre-apply schema + deploy + live ACs end-to-end. Security audit (C3.7) still runs.
3. Free-tier base stays 100 calls/month; referee bonus +500 on top.

## Resolved design decisions
- ref_code paid bridge: `createCheckoutSession` sets `subscription_data.metadata.ref_code` → read in `handleSubscriptionCreated` (key + code in one event; no cross-event race). Session `metadata.ref_code` retained for the completed-event path.
- `bonus_remaining` portal-only (strict envelope snapshot); `TrackCallResult.bonus_remaining?` internal.
- sync/stdio license path = cache-only for `av_free_`; async (remote HTTP) path awaits `lookupFreeKey`.
- Worktree off fresh origin/main; never touch the main checkout's parallel-session dirty README.
