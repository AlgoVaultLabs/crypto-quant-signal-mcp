# QUOTA-CONSISTENCY-COUNT-ALL-W1 — Plan-Mode Step-0 endpoint-truth

**Produced:** 2026-06-08 · **Verdict:** 🛑 **HALT — 3 fictional primitives + 1 semantic discrepancy + mandatory PUSH-UX Q-ROW. Wait for architect.**
**Tier:** 1 · Plan-Mode REQUIRED · cross-repo · mutates user-visible quota semantics
**Probed against `origin/main` (NOT vault mirror), both repos clean (working tree == origin/main):**
- `crypto-quant-signal-mcp` (CQSM) @ `0870214` (`/Users/tank/code/crypto-quant-signal-mcp`)
- `algovault-bot` (BOT) @ `155c562` (`/Users/tank/algovault-bot`)

---

## Step 0 — system-map edge-touch enumeration

**Map Anchor = NONE — internal metering-logic change. CONFIRMED.**
The bot calls signal-MCP with `X-AlgoVault-Internal-Key` → server maps to `tier:'internal'` → server-side counter bypassed (`quota.py:7-8`). The bot enforces its own 100/mo cap in its **SQLite `subscribers` table** (`quota.py:9-10,157-170`). `consume_quota` writes only `subscribers.alert_count`/`alerts_window_start` — bot-local. **No producer→consumer DATA edge to the MCP server changes; the bot↔signal-MCP `internal-bypass` edge is unchanged.** `system-map.md updated: N`.

---

## Probe results (`claim | reality | resolution`)

### CQSM — API/MCP singles (Step-0 #3) — ALL COUNT ✅ (line-number drift only)

| Spec claim | Reality (origin/main `0870214`) | Resolution |
|---|---|---|
| `scan-funding-arb.ts:145` → `trackCall(license)` | `trackCall(license)` at **`:147`** (unconditional; funding-arb has no HOLD concept) | ✅ counts. Drift +2. |
| `get-market-regime.ts:32` → `trackCall(license)` | `trackCall(license)` at **`:40`** (unconditional) | ✅ counts. Drift +8. |
| `get-trade-call.ts:351` → `trackCall(license)`, gated by `checkQuota` at `:94`; HOLD skipped | `trackCall(license)` at **`:447`** inside `if (!input.internal && signal !== 'HOLD')` (`:446`); read-only `checkQuota` gate at **`:104`** | ✅ counts; HOLD-free CONFIRMED. **Drift +96 on trackCall, +10 on gate.** |
| `index.ts:110` "Quota tracking handled inside getTradeSignal (HOLDs are free)" | comment at **`:301`** inside `makeTradeCallHandler` (`:293`) | ✅ present. Drift. |
| `license.ts`: `getMonthlyQuota('free')=100`, key `free:${ipHash}` | `getMonthlyQuota` default `return 100` (`:448`); key `free:${getRequestIpHash() || 'anon'}` (`:472`, `:511`) | ✅ exact. |

### CQSM — scanner (Step-0 #4b, R2b) — EXACT ✅ (no change)

| Spec claim | Reality | Resolution |
|---|---|---|
| `const units = Math.max(1, result.eligible_non_hold); trackCall(license, units)`; 3-call→3, all-HOLD→1, no scan base | `checkQuota(license)` `:95`; `const units = Math.max(1, result.eligible_non_hold)` **`:109`**; `const tracked = trackCall(license, units)` **`:110`** | ✅ EXACT. 1/non-HOLD, min 1, no base. **No code change.** vitest only. |

### CQSM — equity tools (Step-0 #4b, R2) — EXIST, but 🔴 **charge HOLD** (semantic discrepancy)

| Spec claim | Reality | Resolution |
|---|---|---|
| equity tools live on origin/main (absent in mirror) | ✅ registered `index.ts:444` (`get_equity_call`), `:469` (`get_equity_regime`); orchestrators `equity-tool-formatters.ts:105`/`:140` | confirmed real |
| R2: "a HOLD … equity call does NOT charge" (vitest must prove) | `quotaGate(license)` runs **unconditionally at the TOP** of each orchestrator (`:107`, `:142`) → `trackCall(license)` (`:92`) **BEFORE the verdict is known**. Equity charges **1 per call including when the verdict is HOLD.** | 🔴 **R2 invariant is FALSE for equity.** A "equity-HOLD-does-not-charge" vitest would FAIL. crypto `get_trade_call` skips HOLD; equity does NOT. **Architect Q-row 2.** |

### CQSM — x402 pricing (R-x402, DEFERRED) — gap CONFIRMED ✅

`x402.ts:58 TOOL_PRICING = { get_trade_signal: 0.02, scan_funding_arb: 0.01, get_market_regime: 0.02 }`. **Absent:** `scan_trade_calls`, `get_equity_call`, `get_equity_regime`, and the **canonical `get_trade_call`** (only the alias `get_trade_signal` is priced). Matches spec → DEFER to `OPS-X402-PRICING-EXPANSION-W1`. No change here.

### CQSM — trade-call alias (R2) — identical metering ✅

`makeTradeCallHandler('get_trade_call'|'get_trade_signal')` (`:293`); both registered `:330`/`:337` via the SAME handler → identical metering. **(Spec cited `src/index.ts:90/102/145-149` — all drift; actual `:293/:330/:337`.)**

### CQSM — webhook (Step-0 #4, R3) — regime_shift counts ✅; 🔴 NO `top:N` scan

| Spec claim | Reality | Resolution |
|---|---|---|
| `regime_shift` deliveries count owner quota | `webhook-delivery.ts:341 trackCallByKey(sub.owner_key, sub.tier)` — 1 unit/delivered event; `regime_shift` is a valid event (`webhook-api.ts:31 VALID_EVENTS=['trade_call','regime_shift']`) | ✅ counts |
| webhooks require paid/API-key owner; free not unlimited | create gate `webhook-api.ts:170 if(!ownerKey) return authRequired` → API key REQUIRED (keyless-anon CANNOT subscribe, `:40`). free-tier *API-key* owner CAN, sized by `checkQuotaByKey(ownerKey, tier)`; at exhaustion deliveries **PAUSE silently** (`webhook-delivery.ts:293`) | ✅ **gated, not unlimited.** R3 = no gap. Document only. |
| AC3 / R2b(c): "`top:N` scan delivery charges `1 + N`" | **No scan webhook event exists.** `VALID_EVENTS=['trade_call','regime_shift']`; no `top`/`topN`/`scan` selector anywhere in `webhook-*.ts`. Webhook charges exactly **1 per delivered trade_call/regime_shift** (`:341`). HOLD never enqueued (`webhook-events.ts:128`). | 🔴 **FICTIONAL.** No `top:N` scan delivery to confirm. **Architect Q-row 3.** |

### BOT — census + the real gap (Step-0 #1) — regime gap REAL ✅; funding-arb/scan FICTIONAL 🔴

**DEFINITIVE MCP-tool census (whole `src/`):** the bot calls exactly **TWO** tools — `get_market_regime` (`alert_engine.py:377`) and `get_trade_call` (`alert_engine.py:430`, `handlers.py:73`, `mcp_client.py:88`). **No `scan_funding_arb`, no `scan_trade_calls`, no equity tools.** Commands: `start/help/watch/unwatch/unwatchall/list/stats/unlock_premium_alerts` (+callbacks+photo). **No `/scan`, no `/regime` command.**

| Spec claim | Reality | Resolution |
|---|---|---|
| `quota.py consume_quota` increments only for trade-call alerts; docstring claims regime is free | `consume_quota` `:140` (+1 `alert_count`; paid no-op `:154`; `PAID_TIERS={starter,pro,enterprise,x402}` `:42`). Docstring `:17-19` = the WRONG premise. | ✅ confirmed |
| R1: meter **regime** | regime path `alert_engine.py:373-422` fires `get_market_regime`, sends alert, `record_alert_fired(...,"regime")` `:408` — **NO `consume_quota`**. ← THE GAP | ✅ **ACTIONABLE.** Insert `consume_quota(db,row.chat_id)` after `_push` succeeds (`:402`), next to `:408`. (paid no-op auto-handled.) |
| R1: meter **`scan_funding_arb`** invocations | **bot NEVER calls `scan_funding_arb`.** No funding-arb path exists. | 🔴 **FICTIONAL.** Nothing to meter. **Architect Q-row 1.** |
| R2b(b) / Step-0 #4b: TG bot `/scan` charges 1/non-HOLD | **No `/scan` command; bot never calls the scanner.** | 🔴 **FICTIONAL.** **Architect Q-row 1.** |
| trade-call path counts; HOLD free | `:479` only BUY/SELL fire; `consume_quota` at `:529` after `_push_photo`; HOLD → no fire, no consume | ✅ correct (unchanged) |

### BOT — 🟡 in-repo help-text contradicts R1 (R4 scope tension)

`messages.py:38-39` and `:82-83` (`/start`, `/help`): **"📊 Regime shifts — free, no limit"** and `/watch` warning `:74` "regime-only". If R1 ships (regime now counts), the bot's OWN user-facing copy becomes FALSE. R4 firewalls "public copy" to `WEBSITE-X402-SURFACING-W1` — but these are the **bot's in-repo strings**, not website copy. Shipping R1 without fixing them = the bot lies to users (Factuality/Data-Integrity). **Architect Q-row 4.**

### PUSH-UX (Step-0 #2, mandatory Q-ROW)

Bot regime alerts are **100% auto-pushed** by the scheduled alert engine per watch-row; **there is no user-initiated `/regime` command.** So the menu option "meter only explicit user `/regime`/`/scan` while leaving auto-pushes free" would meter **NOTHING** → R1 becomes a no-op. The decision is binary: **(A)** count auto-pushed regime (R1 as written — passive quota burn, free users exhaust faster, more upgrade CTAs) OR **(B)** leave regime free (R1 void). Prompt default = literal directive (A). Given the acquisition-north-star tension + the help-text contradiction, **confirm explicitly. Architect Q-row 5.**

---

## HALT tally

- **Fictional primitives (≥3 → HALT per CLAUDE.md):** (1) bot `scan_funding_arb` path, (2) bot `/scan`/`scan_trade_calls`, (3) webhook `top:N` scan delivery. → **3.**
- **Semantic discrepancy:** equity tools charge HOLD (R2's "equity HOLD doesn't charge" is false).
- **Scope tension:** bot in-repo help-text would become false under R1 vs R4 firewall.
- **Mandatory PUSH-UX Q-ROW:** all bot regime alerts are auto-pushed.
- **Line drift (inline-correctable, NOT blocking):** see corrected anchors below.

---

## Corrected anchors (bake into the post-approval brief)

- BOT R1 insert: `alert_engine.py` regime fired-branch — `consume_quota(db, row.chat_id)` after `_push` True (`:402`), beside `record_alert_fired(...,"regime")` (`:408`). Update `quota.py:17-19` docstring.
- CQSM singles (no change; vitest targets): `scan-funding-arb.ts:147`, `get-market-regime.ts:40`, `get-trade-call.ts:447` (gate `:104`), scanner `scan-trade-calls.ts:109-110`, equity `equity-tool-formatters.ts:92/107/142`, alias `index.ts:293/330/337`, webhook `webhook-delivery.ts:341`.

## Post-approval execution (BLOCKED pending architect answers)

1. **R1 (bot):** add `consume_quota` to the regime fired-branch (pending Q1 funding-arb drop + Q5 push confirm). pytest: regime alert +1 for free, paid no-op, HOLD trade-call no-tick.
2. **R2 (CQSM vitest):** lock crypto singles + alias + scanner (3→3, all-HOLD→1). Equity assertions pending Q2 (charges-HOLD vs make-HOLD-free).
3. **R3:** document webhook (regime_shift counts; free=API-key-gated+paused, not unlimited). No code change.
4. Bot help-text: pending Q4.

---

## RESOLUTION (architect Mr.1, 2026-06-08) + SHIPPED

Architect answered the HALT Q-block inline:
- **Q1** → bot meters **regime only**; bot `/scan` + funding-arb feature **deferred** to a follow-up wave (noted in status.md).
- **Q2 = B** → made `get_equity_call` **HOLD-free** (CODE CHANGE).
- **Q3** → webhook `top:N` scan **deferred** (no scan webhook event); webhook invariant = 1 per delivered `trade_call`/`regime_shift`.
- **Q4** → updated bot `/start`+`/help` copy + README THIS wave.
- **Q5 = A** → count auto-pushed regime (literal directive).

**Shipped + DIRECT-DEPLOYED (no commit — GitHub account flagged):**
- R1: `alert_engine.py` regime branch `consume_quota` + `quota.py`/`fetch_budget.py` doc fixes; pytest `tests/test_regime_quota_metering.py` (3) green; bot suite 377/0.
- R2: `equity-tool-formatters.ts` HOLD-free (`assertQuotaAvailable` + post-verdict charge; `tierLimitError` extracted); `get_equity_regime` unchanged. vitest `tests/quota-metering-invariants.test.ts` (13) green; CQSM +0 new failures; `tsc` 0.
- R3: documented (no code) — regime_shift counts; webhook API-key-gated + pauses at exhaustion (not unlimited).
- Deploy: CQSM rsync+rebuild (live smoke SPY→trending_down, AAPL→BUY); bot rsync+restart (cron `errors:0`). UNCOMMITTED; recovery patches in vault `Claude files/QUOTA-CONSISTENCY-COUNT-ALL-W1-recovery/`.

**Flagged for architect (NOT done — beyond R1's literal "consume" scope):** regime now COUNTS but auto-pushed regime alerts are NOT exhaustion-GATED on the bot, whereas the API/MCP gates `get_market_regime` at exhaustion. Full surface-parity would gate regime (UX change → ratification needed). See status.md.
