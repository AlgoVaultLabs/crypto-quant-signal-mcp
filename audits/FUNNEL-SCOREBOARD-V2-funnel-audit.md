# FUNNEL-SCOREBOARD-V2 — funnel audit (R1) + FIX INVENTORY + build plan + HALT

**Target ICP:** META (internal conversion analytics) · **Probed:** 2026-07-09 UTC · **Mode:** AUDIT-FIRST + fix-inventory · MEASUREMENT-ONLY · MCP-TOOL-SURFACE FROZEN.
**Design SoT:** `Funnel-Scoreboard-v2-mockup.html` (dual-funnel). **Companion:** [`FUNNEL-SCOREBOARD-V2-endpoint-truth.md`](FUNNEL-SCOREBOARD-V2-endpoint-truth.md) + firewall baseline JSON.

**Bottom line:** Every stage of BOTH funnels is computable from live sources TODAY except **Visitors** (no server-side source — landing is CDN/static; proxy only). Three of the mockup's "illustrative" numbers map to real queries (Activated 899, Quota-crossing 10, call volume via request_log). Two data-corrections vs the mockup: **x402 Paid = 7, not 0**, and the **HOLD base is request_log-external (~897/24h), NOT the 36M lifetime counter** (which isn't verdict/internal-splittable). The **activation-nudge layer is already shipped** (don't rebuild); what's genuinely absent = **OAuth/one-tap signup** + **in-protocol x402-at-quota-edge** → the two Fix waves. **6 architect decisions in the fenced block.**

## R1(a) — Data map (both funnels)

**Segmentation model (Q6):** the two funnels draw from **inherently separate sources** — there is no single split column. Human = `signup_attribution` / `free_keys` / `subscriber_profiles` / Stripe (web-account rail). Agent = `mcp_connect` / `agent_sessions` / `request_log` / `processed_x402_payments` (connection rail). The **bridge = the API key** (a human signs up → gets a key → wires it into agents, which then appear "recognized"). This matches the mockup's bridge note.

- **Human funnel** (Stripe): Visitors *(proxy 88/71 — Q1)* → Subscribe-click **165** → Signup **6** → Paid **1**. Leak = click→signup **3.6%** (6/165). Channel: direct 156 / tg_bot 6 / referral 0.
- **Agent funnel** (x402): Connections **1,316** → Activated **899** *(call≥1, non-internal — Q3)* → Quota-crossing **10** *(quota_usage≥100 — Q2)* → Paid-x402 **7** *(not 0 — Q4)*. Leak = quota→paid (7/10 = 70%? or by a stricter def) — **the "0%" in the mockup is stale**; live x402 = 7. Channel: reuse H0-C4 `retention.by_channel`.
- **HOLD / verdict** (Q5): `request_log.verdict` external → HOLD 6819 / BUY 93 / SELL 2 / null 1321. **HOLD-upside base = request_log external** (897/24h · 6,653/30d), HOLD = `verdict='HOLD'`. NOT the 36M lifetime counter (endpoint-truth D2).

## R1(b) — FIX INVENTORY (input to the deferred Fix wave — do NOT rebuild what exists)

| Candidate fix (from mockup/Mr.1) | Already built? | Detail |
|---|---|---|
| Reduce signup fields | ✅ **already ≤1 field** | Free = email-only (`/api/signup-email`); consent optional; referral via `?ref=`. Field-count is not the leak. |
| Kill the password | ✅ **N/A — no password exists** | Free = email→key; paid = Stripe-hosted. No user-password system. |
| GitHub/Google one-tap · magic link | ❌ **ABSENT** | No OAuth/passwordless. → `FUNNEL-FIX-HUMAN-SIGNUP-W1` candidate. |
| Give referral code AFTER first value | ⚠️ **partial** | Referral exists (`?ref=`, +500 bonus, `/account/referrals`); ordering (code-after-value) not enforced. |
| Account portal / key recovery | ✅ **shipped** | `/account`, `/account/recover-key`, `/welcome` key reveal. |
| x402 pay-per-call at the quota edge | ❌ **ABSENT** | `TierLimitReachedError` surfaces a **Stripe subscription** URL + referral_hint at the quota edge — **no x402 micropayment path**. → `FUNNEL-FIX-AGENT-X402-NUDGE-W1` candidate. |
| Subscription upgrade nudge at quota edge | ✅ **shipped** | `TierLimitReachedError.suggested_upgrade_url` (`upgrade_from=limit` + utm) + agent-relayable `referral_hint`. |
| `tier_warning` (soft/hard) | ✅ **shipped** | `activation-thresholds.ts` + `tier-warning.ts withTierWarning`. |
| `upgrade_cta_clicked` event | ✅ **shipped** | fires from `/signup?upgrade_from=…` (=1 all-time). |
| `/welcome` paywall CTA | ✅ **shipped** | `getWelcomePageHtml` (organic branch). |

**Fix-wave scoping (Q7):** the nudge layer is BUILT. The two real gaps → `FUNNEL-FIX-HUMAN-SIGNUP-W1` (OAuth/one-tap + reduce the email-gate / referral-after-value) + `FUNNEL-FIX-AGENT-X402-NUDGE-W1` (in-protocol x402 pay-per-call discovery at the quota edge). Both DEFERRED to a separate dispatch (R6).

## R1(c) — Existing route + firewall
`/dashboard/funnel` (cookie-gated) + `/dashboard/api/funnel-scoreboard` (`isAdminAuthorized`) → `getFunnelScoreboard()` + `renderFunnelDashboardHtml()`. V2 re-renders in place. **Firewall honored by construction** — HTTP route + `src/lib/` helpers + DB reads; no `server.tool`/registry/envelope/version. `tools/list` stays 9 (byte-identical; AC2 re-proves live).

## Proposed build plan (pending Q1–Q7)
- **R2** extend `src/lib/funnel-scoreboard.ts`: `getHumanFunnel(window)`, `getAgentFunnel(window)` (incl. quota-crossing), `getHoldUpside(window)` (avg calls/agent + HOLD/trade split, **external-only**, upside = holdVol × {0.001,0.002,0.005} labeled projection), per-window rollups (7/30/90/180/365/all), channel breakdowns. Pure segmenter + `getHoldUpside` exported/test-imported. Default-deny NaN; retention stays a curve.
- **R3** re-render `renderFunnelDashboardHtml()` per the mockup: two side-by-side funnels (step-% + drop + RAG bands + auto biggest-leak) · HOLD-upside panel · bridge note · channel-inside-each · cross-cutting flags · **7D/30D/90D/180D/365D/All filter** (client-side buttons → re-fetch `?window=`). Daily timeseries retained. Operator-gated.
- **R4** guards: benchmark bands (signup-form 30–55%, free→paid ~5%, d7 ~30%); n<30 low-confidence; cohort-maturity; internal-vs-external labeled; HOLD "estimate only — HOLDs stay free until you decide."
- **R5** AC2 firewall proof (handshake diff + no `server.tool` diff + 4-manifest version diff).
- **R6** status.md + file the two Fix waves (NOT built) + mockup→live note.

Scope self-check: zero MCP-tool touch · zero version bump · zero public copy · zero Telegram · zero paid-path mutation. ✅

---

## HALT — architect (Mr.1) ratification required before any build

```
FUNNEL-SCOREBOARD-V2 — Plan-Mode HALT (6 decisions + fix-inventory delivered).
Audit: audits/FUNNEL-SCOREBOARD-V2-funnel-audit.md (+ endpoint-truth.md). Probed live 2026-07-09.

Q1 [Visitors has NO server-side source — landing is CDN/static]. The human funnel's top
   stage can't be counted server-side. Render it as:
     (a) [rec] a labeled PROXY = track_record_viewed (71) or landing_cta_clicked (88)
         "engaged visitors (proxy)" + a caveat; file real visitor instrumentation as a
         Fix-wave item.  (b) "n/a — not instrumented" (funnel starts at Subscribe-click).
     Which — and which proxy?

Q2 [Quota-crossing / agent PQL definition]. Two live sources:
     (a) [rec] quota_usage.call_count>=100 = 10 keys (cumulative "hit the free cap")
     (b) funnel_events quota_hit_hard/block distinct sessions (7/1, recent since 2026-07-04)
   Use (a) as the PQL count, (b) as the recent-flow signal? Or a different cap threshold?

Q3 [Activated definition]. agent_sessions.call_count>=1 AND first_tier<>'internal' = 899
   (a real tool call, tools/list handshakes excluded). Confirm?

Q4 [x402 Paid — mockup says 0, live=7]. processed_x402_payments = 7 all-time (all 2026-06-30).
   Agent-funnel "Paid" should read the live x402 count (7), not the mockup's 0. Confirm —
   and is "paid agent" the payment COUNT (7) or distinct paying wallets? (nonce-keyed; no
   wallet column → count is what's queryable.)

Q5 [HOLD-upside base]. request_log has ~98K rows (8,235 external), NOT the 36M lifetime
   counter (which isn't verdict/internal-splittable). So HOLD-upside + avg-calls/agent use
   request_log external (is_bot_internal=false): 897/24h, HOLD=verdict='HOLD' (6,819). The
   1,321 null-verdict calls (chat/search/regime — non-signal tools) → shown as "non-verdict",
   excluded from the HOLD/trade split. Confirm request_log-external is the right base (it is
   the only clean external source) + the null-verdict handling.

Q6 [Segmentation model]. The two funnels come from SEPARATE sources (human = signup/keys/
   Stripe; agent = connect/sessions/request_log/x402); no single split column; bridge = API
   key. Confirm this is the intended model (matches the mockup).

Q7 [Fix-wave scoping — R6, deferred]. File FUNNEL-FIX-HUMAN-SIGNUP-W1 (gap = OAuth/one-tap +
   email-gate/referral-after-value; nudge layer already built) + FUNNEL-FIX-AGENT-X402-NUDGE-W1
   (gap = in-protocol x402 pay-per-call at the quota edge; subscription-nudge already built).
   Confirm the 2-wave split + that tier_warning/TierLimitReachedError/upgrade_cta/welcome are
   NOT rebuilt.

Note: the 7D/30D/…/All filter scopes the funnel STAGE counts + call volume + x402; retention
stays a cohort CURVE (largely window-independent), d90 null-not-0. system-map edge = NONE.
```

**Until Mr.1 answers: NO code, NO commit, NO deploy.** Only these 3 audit artifacts exist (uncommitted, in the `funnel-scoreboard-v2` worktree). On ratification: V2-RESUME folds the answers into a "Pre-resolved decisions" table, thin re-probe for new drift, then R2→R6. The Fix waves are a SEPARATE future dispatch scoped from R1(b).
