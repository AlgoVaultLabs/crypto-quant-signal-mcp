# FUNNEL-SCOREBOARD-V2 — endpoint-truth (Plan-Mode Step 0, read-only live probes)

**Probed:** 2026-07-09 UTC · **Host:** Hetzner `204.168.185.24` (prod) · **Repo base:** worktree `~/code/cqs-H0-C4-MEASURE-CLOSE` fast-forwarded to `origin/main` @ **`3cebb75`** (canonical `~/code/crypto-quant-signal-mcp` still stale; `3cebb75` = my `4cf9c53` + an unrelated ACP-graduation fix that does NOT touch funnel code). **Mode:** AUDIT-FIRST · MEASUREMENT-ONLY · every probe read-only. **No code written except these audit docs. HALT for Mr.1 after.**

Format: `claim | reality (live) | resolution`.

## A. Repo / route / firewall

| # | claim | reality | resolution |
|---|-------|---------|------------|
| A1 | canonical checkout; verify freshness | worktree at `origin/main` `3cebb75` on branch `funnel-scoreboard-v2`; funnel code identical to `4cf9c53` (H0-C4). node_modules present (npm ci from H0-C4; ACP fix added no deps). | Fresh. Build here. |
| A2 | existing `/dashboard/funnel` route to match | `src/index.ts:2153` `app.get('/dashboard/funnel')` (cookie-gated like `/dashboard`) + `:2141` `/dashboard/api/funnel-scoreboard` (`isAdminAuthorized`) → `getFunnelScoreboard()` (`src/lib/funnel-scoreboard.ts:411`) + `renderFunnelDashboardHtml()`. | V2 EXTENDS these — same route, same auth, re-render. |
| A3 | firewall: `tools/list` byte-identical | live handshake: **9 tools**, sha256 `0da5e7cc…` (identical to H0-C4 baseline). Saved `audits/FUNNEL-SCOREBOARD-V2-toolslist-baseline-2026-07-09.json`. Manifests: package/server **1.23.0**, manifest **1.16.0**, lobehub **"18"**. | AC2 diffs against these; wave bumps none, touches no `server.tool`. |

## B. HUMAN funnel primitives (web → account → Stripe)

| stage | source · query | computable today? | live value |
|---|---|---|---|
| **Visitors** (awareness) | ❌ NO clean server-side source — landing is Caddy-static/CDN + function-rendered, no per-visit logging. Only proxies: `funnel_events` `landing_cta_clicked` **88** / `track_record_viewed` **71** (distinct sessions). | proxy-only | 88 / 71 (proxy) — **see Q1** |
| **Subscribe click** (intent) | `signup_attribution` (one row per `/signup` CTA click, `src/index.ts:1512`, by channel) | ✅ | **165** |
| **Signup** (free key + referral) | `free_keys` (email→`av_free_` key via `/api/signup-email`) [+ `signup_emails`] | ✅ | **6** |
| **Paid** (Stripe sub) | Stripe `subscriptions.list(active)` (canonical) / `subscriber_profiles.status='active'` | ✅ | **1** |
| channel breakdown | `signup_attribution.channel` (direct/tg_bot/referral) | ✅ | direct 156 · tg_bot 6 · referral 0 |

## C. AGENT funnel primitives (MCP/API → x402, no signup)

| stage | source · query | computable? | live value |
|---|---|---|---|
| **Connections** (reach) | `funnel_events` `COUNT(DISTINCT session_id) WHERE event_type='mcp_connect'` | ✅ | **1,316** |
| **Activated** (≥1 real call) | `agent_sessions WHERE call_count>=1 AND first_tier<>'internal'` | ✅ | **899** — **see Q3** |
| **Quota-crossing** (PQL) | (a) `quota_usage WHERE call_count>=100` = **10 keys** (cumulative); (b) `funnel_events` `quota_hit_hard`=7 / `block`=1 distinct sessions (recent, since 2026-07-04) | ✅ (two candidates) | 10 (cumulative) / 1–7 (recent) — **see Q2** |
| **Paid x402** (conversion) | `processed_x402_payments` (nonce PK) | ✅ | **7 all-time** (all 2026-06-30) — mockup says "0"; **see Q4** |
| channel breakdown | reuse H0-C4 `retention.by_channel` (connection `?src=`): claude 43% d7 (n≈67) · unknown 9% (n≈1199) | ✅ | (from H0-C4 module) |

## D. HOLD / verdict + internal-vs-external filter (the AC4 integrity primitive)

| # | claim | reality | resolution |
|---|-------|---------|------------|
| D1 | HOLD vs trade split source | `request_log.verdict` IS populated (external): **HOLD 6819 · BUY 93 · SELL 2 · (null) 1321**. HOLD = 98.6% of verdict-bearing external calls (≈ the 99.1% claim). null-verdict = non-signal tools (chat/search/regime). | ✅ HOLD/trade from `request_log.verdict`; null-verdict shown separately (Q5). |
| D2 | ~36M lifetime dominated by internal | ⚠️ **`request_log` has only ~98K rows** (external `is_bot_internal=false` **8,235**; internal **90,494**), NOT 36M. The 36M is a SEPARATE lifetime cumulative counter, NOT per-row in request_log and NOT verdict/internal-splittable. | **HOLD-upside base = `request_log` external (the only clean external source), NOT the 36M.** Per-window: ext 24h **897** · 7d **3,709** · 30d **6,653**. **See Q5.** |
| D3 | external-only filter | `request_log WHERE is_bot_internal=false` (+ optional tier ∈ recognized/raw/x402) = external agent calls; matches `getUsageStats.totalCallsExternal` (~897/24h). | ✅ external filter = `is_bot_internal=false`; HOLD = that + `verdict='HOLD'`. |

## E. FIX INVENTORY primitives (R1(b) — "is the fix already built?")

| candidate fix | reality (file · state) | verdict |
|---|---|---|
| **Human signup friction** | Free = `/api/signup-email` (`src/index.ts:2609`): **email-only, 1 field**; consent NO LONGER required (D4); referral via `?ref=`; no password, no email-verify-to-get-key. Paid = `/signup`→Stripe-hosted checkout. Rich account infra: `/welcome` paywall CTA, `/account` self-service portal, `/account/recover-key`, `/account/referrals`. | signup already **LOW-FRICTION (email-only)** — field-count is NOT the leak |
| OAuth / magic-link / one-tap | grep: **ABSENT** (no passport/bcrypt/oauth/magic-link for user auth; the only OAuth ref is geo-mining Reddit). | **ABSENT** → Fix-wave candidate |
| **x402 quota-edge upgrade** | `TierLimitReachedError` (`src/lib/errors.ts:94`, ACTIVATION-PAYWALL-W1 + REFERRAL-INPRODUCT-NUDGE-W1): at the quota edge the tool envelope surfaces `suggested_upgrade_url` (`upgrade_from=limit` + utm) **+ `referral_hint`** — but points to the **Stripe SUBSCRIPTION**, NOT an x402 pay-per-call path. | subscription-nudge **SHIPPED**; **in-protocol x402 pay-per-call discovery ABSENT** → Fix-wave candidate |
| **Activation / quota nudges** | `tier_warning` (soft/hard band, `activation-thresholds.ts` + `tier-warning.ts withTierWarning`) **SHIPPED**; `upgrade_cta_clicked` event **SHIPPED** (=1 fired); `TierLimitReachedError` (at-limit) **SHIPPED**; `/welcome` paywall CTA **SHIPPED**. | nudge layer **BUILT — do NOT rebuild** |

## F. H0-C4 module (what V2 extends)
Exports live: `getFunnelScoreboard()` (411), `computeRetentionCurve/Breakdown`, `classifyTierBucket`, `projectClientActivity`. **Absent (V2 adds):** `getHumanFunnel()`, `getAgentFunnel()`, `getHoldUpside()`, per-window rollups. Composes `generateFunnelSnapshot()` + `aggregateProfiles()` + Stripe census + `getUsageStats()`.

## System-map edge (Step 0)
**`NONE — internal read-only aggregation + re-render`** (extends the existing operator route; new read queries + exported helpers only; no new cron/matview proposed). If a per-window rollup matview is later added, edit the map rows + `Last touched:` same commit. **Firewall honored:** HTTP route + `src/lib/` helpers + DB reads only; no `server.tool`/registry/envelope/version touch; `tools/list` stays 9.
