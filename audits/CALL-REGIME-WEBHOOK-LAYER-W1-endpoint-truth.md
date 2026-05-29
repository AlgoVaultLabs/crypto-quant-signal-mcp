# CALL-REGIME-WEBHOOK-LAYER-W1 — Plan-Mode endpoint-truth audit (C1)

- **Wave:** CALL-REGIME-WEBHOOK-LAYER-W1 (Tier-2 Bulk-Spec, 6 chapters, REST-only outbound webhook delivery service)
- **Target ICP tier(s):** T2 (prosumer algo-traders — FreqTrade / Hummingbot / 3Commas / Cryptohopper / Nautilus)
- **Date:** 2026-05-29
- **Probed against:** `origin/main` @ `c273550` (= deploy SoT, `v1.18.2`)
- **Verdict:** ✅ **CH1_GREEN** — all primitives live-verified; greenfield confirmed; tier-gating ratified by Mr.1/Cowork (CLOSED); regime-scope decision deferred to a C3 live probe (per Cowork directive).

---

## 0. BASELINE RESOLUTION (🛑 HALT-class finding, resolved)

The vault planning-hub mirror `…/Obsidian Vault/AlgoVault MCP/experiments/crypto-quant-signal/crypto-quant-signal-mcp` was **181 commits behind `origin/main`** (`v1.10.6` vs `v1.18.2`). The prompt's line anchors were computed off that stale snapshot and are **advisory only**.

**Resolution (Cowork-ratified):** Do NOT use the vault mirror as the working/push source. Fresh clone established at `~/code/crypto-quant-signal-mcp`:
- `git rev-parse HEAD` = `c273550f19ffc077041593f163dc813221edc706` == `origin/main` ✓
- `git status` clean ✓ · `package.json` version `1.18.2` ✓ · no `hooks/` dir (no AOE main-branch protection on this repo) ✓
- All code work + commits + push happen here. Vault files (`status.md`, `system-map.md`, `Claude files/WIS-PENDING.md`) updated in the vault.
- **All anchors below re-derived from `origin/main`.** Corrected anchors are canonical.

---

## 1. system-map.md edge enumeration (Step 0)

Touched component: **`crypto-quant-signal-mcp` (SIGNAL)**. Edges this wave mutates:

| # | Edge | Produces / Consumes | Type |
|---|------|---------------------|------|
| 1 | NEW outbound publish edge: `SIGNAL --POST <subscriber_url> (trade_call + regime_shift, HMAC-signed)--> [external subscriber URLs]` | SIGNAL **produces** signed delivery POSTs | new external-publish-target class → bump "External publish targets (16)"→(17) at `system-map.md:221` |
| 2 | NEW internal edge: `recordSignal` post-insert hook → webhook event queue (`webhook_deliveries`) | `recordSignal` **produces** events; `webhook-events` **consumes** | internal |
| 3 | NEW postgres tables under SIGNAL: `webhook_subscriptions`, `webhook_deliveries` (DB `signal_performance`) | store **produces/consumes** | new tables |
| 4 | NEW API routes under SIGNAL: `POST/GET/DELETE /api/webhooks`, `POST /api/webhooks/:id/test` | SIGNAL HTTP surface | new routes |
| 5 | UNCHANGED (assert): MCP tool count stays 3 (`get_trade_call`/`scan_funding_arb`/`get_market_regime`); `get_trade_signal` alias unchanged; `server.json`/`manifest.json`/`tools/list` UNTOUCHED → no version bump, no publish | — | invariant |

**No edge involves `documented-only` consumers → no deferred verification.** Component reference row at `system-map.md:240` (SIGNAL table-list) gets the 2 new tables appended in C6.

---

## 2. Endpoint-truth table (claim | reality | resolution)

| # | Claim (prompt, off stale mirror) | Reality on `origin/main` @ c273550 (`grep -n`) | Resolution |
|---|---|---|---|
| 1 | local tree current | **181 behind** (v1.10.6→v1.18.2) | resolved — fresh clone @ c273550 (§0) |
| 2 | `/webhooks` rate-limit `src/index.ts:343` | `src/index.ts:808` — `app.use('/webhooks', rateLimit({ windowMs:60_000, max:20, … }))` | anchor → **808**; reuse `rateLimit` import (already `await import('express-rate-limit')`) |
| 3 | Stripe webhook `src/index.ts:457-458` (do NOT touch) | `src/index.ts:938` — `app.post('/webhooks/stripe', express.raw(…))` | anchor → **938**; firewall: do NOT touch |
| 4 | backfill worker pattern `src/index.ts:934` | `src/index.ts:2026-2027` — `setTimeout(()=>runBackfill()…,10_000)` + `setInterval(()=>runBackfill()…,300_000)` | anchor → **2026-27**; mirror for delivery worker boot (C6) |
| 5 | `performance-db.insertSignal` (~338-344) | **function is `recordSignal`** @ `src/lib/performance-db.ts:547`; INSERT @ 559 (`INSERT INTO signals (coin, signal, confidence, timeframe, exchange, price_at_signal, created_at, signal_hash, regime)`) | **wrong name** → use `recordSignal`. 1 identifier fix. Hook site = inside `recordSignal` (any caller triggers it) |
| 6 | `CREATE_TABLE_SQL` L112 / `SIGNAL_MIGRATIONS` L141 / `runMigrations` L179 | **L112 / L141 / L179 — EXACT MATCH** (top-of-file, undrifted) | ✓ reuse migration pattern verbatim |
| 7 | `signals` has `regime TEXT NULL` (mig L155) + `signal_hash` (L157) + `created_at` epoch | L155 `{ table:'signals', column:'regime', type:'TEXT NULL' }`; L157 `signal_hash VARCHAR(66)`; `created_at INTEGER NOT NULL` epoch-sec (`Math.floor(Date.now()/1000)`) | ✓ |
| 8 | idempotency precedent `processed_*_events` + `tryClaimEvent()` to mirror | **EXISTS**: `src/lib/stripe-events-store.ts` (`tryClaimEvent` + `processed_stripe_events`); `src/lib/signup-emails-store.ts` (`tryClaimSignupEmailEvent` + `processed_signup_email_events`, `ON CONFLICT` PG+SQLite) | mirror `signup-emails-store.ts` for `tryClaimDelivery` (UNIQUE(subscription_id,event_id) + ON CONFLICT DO NOTHING + changes/rowCount) |
| 9 | no existing hosted webhook-delivery service | **greenfield** — `git grep` for `webhook_subscriptions\|webhook_deliveries\|webhooks-store\|webhook-delivery\|webhook-events\|WEBHOOK_DELIVERY_ENABLED` on origin/main = **0 hits**. Only inbound `/webhooks/stripe`. | ✓ all-new files |
| 10 | Test runner `vitest run`; layout `tests/` (+ `tests/integration/`) | `package.json:25 "test":"vitest run"`; `tests/` + `tests/integration/` both present | ✓ |
| 11 | `isFreeTier`/tier reuse (`src/lib/license.ts`) | `license.ts:207 isFreeTier`, `:139 resolveLicenseSync`; tiers free/starter/pro/enterprise/x402; quota path `checkQuota`/`getMonthlyQuota`/`trackCall` present | ✓ reuse for quota gate (§4) |
| 12 | verdict `call ∈ {BUY,SELL,HOLD}`; regime example BULL/BEAR | `SignalVerdict='BUY'\|'SELL'\|'HOLD'` (`src/types.ts:121`) stored in `signal` col; **regime = `RegimeType='TRENDING_UP'\|'TRENDING_DOWN'\|'RANGING'\|'VOLATILE'`** (`src/types.ts:123`) | "BULL/BEAR" was a placeholder → use real `RegimeType` enum in events + tests |
| 13 | `_algovault` metadata block | `AlgoVaultMeta` type (`src/types.ts:203`); built per-tool (`get-trade-call.ts`, `get-market-regime.ts`, `scan-funding-arb.ts`) | mirror for `buildPayload._algovault` |
| 14 | no Dockerfile/deploy.yml change (worker in-process) | worker = in-process `setInterval`; all changes in `src/` → `dist/` via `tsc`. **deploy.yml `paths-ignore` does NOT cover `audits/`/`docs/`/`*.md`** (only `activation-funnel/snapshots`, `ops/systemd`) | any push redeploys; feature ships dark (flag-off) so safe. No Dockerfile/deploy.yml edit needed ✓ |
| 15 | Hetzner postgres reachable; `signal_performance` DB | SSH `root@204.168.185.24` OK (date 2026-05-29 07:54 UTC); pg container `crypto-quant-signal-mcp-postgres-1`; DB `signal_performance` | ✓ pre-apply target |

**Fictional-primitive count: effectively 1** (`insertSignal`→`recordSignal`). The ≥3 line-anchor mismatches share a **single root cause** (181-commit stale mirror), not fictional code — all primitives exist on `origin/main`. Resolution = fresh clone + re-derived anchors. **Below HALT threshold for fictional primitives; the baseline HALT was raised to + cleared by the architect.**

---

## 3. Identifier diff (Requirements ↔ Acceptance)

Cross-checked every cited identifier across prompt sections — **internally consistent, 0 contradictions**:

| Identifier | Value | Consistency |
|---|---|---|
| env: ship-dark flag | `WEBHOOK_DELIVERY_ENABLED` (default `false`) | Build-Rule#8 = C6 ✓ |
| env: regime cooldown | `WEBHOOK_REGIME_COOLDOWN_SEC=3600` | C3 ✓ |
| env: max attempts | `WEBHOOK_MAX_ATTEMPTS=5` | C4 ✓ |
| env: disable threshold | `WEBHOOK_DISABLE_AFTER_FAILURES=20` | C4 ✓ |
| event types | `trade_call`, `regime_shift` | NAMING LAW = Map-Anchor = C3 = C4 ✓ |
| event_id (call) | `call:<signal_hash>` | C3 ✓ |
| event_id (regime) | `regime:<coin>:<timeframe>:<exchange>:<created_at>` | C3 ✓ |
| tables | `webhook_subscriptions`, `webhook_deliveries` | Map-Anchor#3 = C2 = taxonomy ✓ |
| dedup key | `UNIQUE(subscription_id, event_id)` ↔ `tryClaimDelivery(subscription_id,event_id)` | C2 ✓ |
| routes | `POST/GET/DELETE /api/webhooks`, `POST /api/webhooks/:id/test` | Map-Anchor#4 = C5 ✓ |
| HMAC headers | `X-AlgoVault-Signature`, `-Event`, `-Delivery`, `-Timestamp` | C4 ✓ |
| forbidden keys | `outcome_return_pct`, `outcome_price`, `return_pct_*`, `pfe_*`, `mae_*`, `price_after_*` | Build-Rule#5 = C4 = Data-Integrity LAW ✓ |

**Intentional public renames per NAMING LAW (not defects):** payload `data.price_at_call` ← DB col `price_at_signal`; payload `data.call` ← DB col `signal` (verdict). Keep.

---

## 4. Tier-gating ratification — **CLOSED (Mr.1/Cowork, 2026-05-29)**

**Decision: NO webhook-specific tiering.** Webhooks follow the universal MCP access model:
- Available on **ALL tiers** — all event types (`trade_call` + `regime_shift`), all assets, all timeframes, multiple endpoints. **No** per-event / per-asset / per-endpoint feature gates.
- Gated **ONLY** by the existing monthly **call quota** via the existing license path (`checkQuota` / `trackCall` / `getMonthlyQuota` / `isFreeTier`): Free 100 / Starter 3,000 / Pro 15,000 / Enterprise 100,000. **HOLD-type events free.**
- **Each delivered event draws down that quota exactly like a pull call.** Quota-exhausted → pause deliveries + emit the existing upgrade hint (mirror the API block); resume next cycle / on upgrade.
- **Registration `POST /api/webhooks` requires an API key** (a **FREE-tier key is fine**) to own the subscription, issue the signing secret, and attribute deliveries to a quota. Keyless-anonymous sessions can pull but **cannot own a subscription** → reject with `suggested_action` ("create a free key").

**Spec deltas vs prompt:** DELETE the bespoke "Free = regime_shift only / ≤2 assets / 1 endpoint" scheme **and** the C5 tier-gate-error path. Reuse the existing quota meter instead.

---

## 5. Regime-detection scope — decision deferred to C3 live probe (Cowork directive)

**Constraint discovered:** `recordSignal` (the only `signals`-insert path) fires **only for BUY/SELL calls with confidence ≥ 52** (`get-trade-call.ts:428-435`, `MIN_TRACKABLE_CONFIDENCE=52` @ `:70`). HOLD goes to `hold_counts` via `recordHoldCount` (no `signals` row). The webhook hook lives inside `recordSignal`, so a regime flip is detected only at the moment a tradeable BUY/SELL call is generated.

**Risk:** the headline use case ("pause my bot when regime turns INTO hostile RANGING/VOLATILE") is exactly when BUY/SELL rows stop firing (conf <52 / HOLD). Coupling `regime_shift` solely to inserts may MISS the most valuable transition.

**C3 gate (before writing detection):** probe Hetzner `signal_performance` — do RANGING/VOLATILE assets still produce `recordSignal` rows often enough to catch the shift INTO hostile promptly?
- **YES** → coupling is fine; proceed as specced (post-insert hook only).
- **NO** → expand C3: capture regime per **scanned** asset in `seed-signals.ts` (even when no row inserted), OR add a bounded poller over the distinct assets under active `regime_shift` subscriptions. Requirement: `regime_shift` fires on the transition INTO RANGING/VOLATILE, not only at BUY/SELL moments. Bound cost to subscribed assets only.

**RESOLVED (C3 live probe, 2026-05-29) → YES, post-insert hook is sufficient.** Prod `signal_performance` 30-day distribution: `TRENDING_UP` 34,638 / `RANGING` 21,493 / `TRENDING_DOWN` 10,698 / `VOLATILE` 0. RANGING rows = **8,270 in the last 7d (~32% of all calls)**; ~2,785 calls/day across 1,044 distinct (coin,tf,exchange) tuples. BUY/SELL calls fire frequently enough in RANGING that the transition INTO hostile regime is caught promptly by the post-insert hook — no poller / `seed-signals.ts` expansion needed this wave. Caveat: `VOLATILE` is never emitted by the current classifier (0 rows), so detectable transitions are among {TRENDING_UP, TRENDING_DOWN, RANGING}; a standalone regime poller (catching idle-market flips with no tradeable call, + VOLATILE once the classifier emits it) is filed as follow-up `OPS-WEBHOOK-REGIME-POLL-EMITTER-W1`.

---

## 6. Postgres safe-window + pre-apply plan (C2)

- **Op class: additive DDL.** `CREATE TABLE IF NOT EXISTS webhook_subscriptions` + `webhook_deliveries`. No `ALTER`/`DROP`/`DELETE`/`TRUNCATE`; no lock on existing `signals`/`signup_emails`. **Non-destructive → safe window is OPEN now** (no table-conflicting cron; `systemctl list-timers` next fires = `algovault-bot-cron`, `sysstat-collect`, `mcp-spec-watcher` — none touch these tables).
- **Pre-apply (per CLAUDE.md "pre-apply schema via SSH then deploy code with IF NOT EXISTS"):** scp a `.sql` to Hetzner → `docker exec crypto-quant-signal-mcp-postgres-1 psql -U <user> -d signal_performance -f /tmp/…sql` (PG dialect: `TEXT[]` for `events`, `BIGSERIAL`/`SERIAL` PK, `BOOLEAN`, `BIGINT` epoch, `UNIQUE(subscription_id,event_id)`). Verify with `\d webhook_subscriptions` / `\d webhook_deliveries`.
- Code ships `IF NOT EXISTS` schema-as-code → **no-op against the prepared DB** on next boot. SQLite (local/test) path uses `JSON` text for `events` + `INTEGER` PK + `ON CONFLICT` (SQLite 3.35+).

---

## 7. Build invariants (confirmed)

- All-in-`src/` → `dist/` via `tsc`; **no Dockerfile / deploy.yml edit** (worker in-process). ✓
- **No version bump / no `mcp-publisher` / no CHANGELOG heading / no Discussion** — internal infra wave. `server.json`/`manifest.json`/`tools/list` untouched; MCP tool count stays 3. ✓
- **Ship dark:** `WEBHOOK_DELIVERY_ENABLED` default `false`; flag-off = zero behavior change; instant rollback. ✓
- README / landing / `server.json` / manifests **UNTOUCHED**. ✓
- Commit strategy: per-chapter local commits (revertability + bisect); single push at C6 (one deploy of a fully-built, flag-off feature). Tables pre-applied before push.

---

## CH1_GREEN

All Step-0 probes complete and live-verified against `origin/main`. Baseline HALT raised + cleared (fresh clone). Tier-gating CLOSED (universal + quota). Regime-scope gated on a C3 live probe. Proceeding to C2.
