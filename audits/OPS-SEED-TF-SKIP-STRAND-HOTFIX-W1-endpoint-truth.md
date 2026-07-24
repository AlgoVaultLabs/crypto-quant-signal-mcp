# OPS-SEED-TF-SKIP-STRAND-HOTFIX-W1 — R0 endpoint-truth (Plan-Mode, read-only)

Live-incident diagnosis of the `Seed OUTAGE: WHITEBIT` page. **Probed 2026-07-24 ~07:13 UTC** (≈23h after the OPS-SEED-UNSUPPORTED-TF-SKIP-W1 deploy at 2026-07-23 08:21). `claim | reality | resolution`.

> **Headline: H1 (the prompt's primary hypothesis) is REFUTED by live evidence, and the outage has SELF-RESOLVED. The real defect is H2 (heartbeat stamped *after* the skip guard), which gave WHITEBIT the thinnest liveness margin of any venue and let a transient deploy-churn gap trip the freshness pager. There is NO `servedIntervalMs` misparse to fix.**

---

## Hypothesis verdicts

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| **H1** | `servedIntervalMs(WHITEBIT,…)` over-inflates → guard skips faithful 15m/30m | **REFUTED** | Live grid (below): WHITEBIT skips **exactly {3m,5m}**; 15m/30m/1h/2h/4h/8h/12h/1d all `faithful=true`; **0 of 15 promoted stranded**; only skips anywhere = WHITEBIT 3m/5m + PHEMEX 12h. WHITEBIT 15m/30m **seed 100/0/0 live**. No misparse. |
| **H2** | Guard sits BEFORE `recordSeedHeartbeat` → an intended skip drops the liveness heartbeat | **CONFIRMED — this is the real root cause of the false page** | seed_heartbeats: WHITEBIT `5m` frozen **27.5h**, `3m` frozen **16d** (never re-stamp once skipped). WHITEBIT's freshest-stamping line is therefore **15m** → its liveness floor is ~15m, the **thinnest of all 17 venues** (every native venue stamps every 3m). |
| **H3** | Coincidental container/DB/cron outage | **FALSIFIED** | WHITEBIT `seed complete: 100 seeded, 0 skipped, 0 errors` @07:01:49; PHEMEX 95/0/5; BINANCE 81 — shared infra + WHITEBIT kline (200) healthy. |
| **H5** | Measurement/transient artifact (CLAUDE.md: H5 = DEFAULT when HEALED at probe) | **PRIMARY — HEALED at probe** | All 17 venues fresh now (WHITEBIT freshest age **854s** < 2700s SLA). Signal histogram: WHITEBIT gap only 07-23 **08–09h** (the 3-deploy churn window), continuous accrual since 10h. |

---

## A. WHITEBIT faithful grid (LIVE deployed dist, in-container)

```
tf    served       req         ratio  faithful
3m    900000       180000      5.00x   false  << SKIP
5m    900000       300000      3.00x   false  << SKIP
15m   900000       900000      1.00x   true   KEEP
30m   1800000      1800000     1.00x   true   KEEP
1h    3600000      3600000     1.00x   true   KEEP
2h    3600000      7200000     0.50x   true   KEEP
4h    14400000     14400000    1.00x   true   KEEP
8h    14400000     28800000    0.50x   true   KEEP
12h   14400000     43200000    0.33x   true   KEEP
1d    86400000     86400000    1.00x   true   KEEP
```
WHITEBIT skipped = **{3m,5m}** (intended). Full-grid skips across all 17 adapters = `PHEMEX:12h` + `WHITEBIT:3m,5m` — the intended matrix, no sibling misparse. **The predicate is correct.**

## B. seed_heartbeats — WHITEBIT per-tf attempt-recency age (s), now

| tf | age_s | note |
|---|--:|---|
| 30m | 729 | fresh (faithful, stamps) |
| 15m | 847 | fresh (faithful — the liveness FLOOR) |
| 12h/8h/2h/4h/1h | 2464–12519 | consistent with slow cadences |
| **5m** | **99094 (27.5h)** | **FROZEN — skipped, never stamps (H2)** |
| 1d | 110115 | daily cadence |
| **3m** | **1437832 (16.6d)** | **FROZEN — skipped (H2)** |

Freshest (max) WHITEBIT heartbeat age = **854s** → freshness monitor is GREEN now. Every promoted venue freshest age ≤ 854s (all fresh).

## C. The false-page mechanism (H2 × transient)

WHITEBIT is the ONLY venue whose fastest *faithful* (heartbeat-stamping) line is 15m — every native venue stamps every 3m. So WHITEBIT's liveness floor ≈ 15m vs 3m for the rest. The 3-deploy churn (2026-07-23 `f9b6b4d`≈07:54, `574a3ed`≈08:06, `39222e8`≈08:22 — each recreated **both** the app container AND postgres, so `recordSeedHeartbeat`/`seedExchange` writes failed mid-fire) gapped WHITEBIT's 15m/30m stamps across the 45-min window ending ~09:06 → page. A native venue (3m floor) would have ridden through the same churn. **With H2 fixed (stamp at attempt-time, before the skip), WHITEBIT's frequent 3m/5m fires stamp attempt-heartbeats even while skipping the seed WORK → floor drops to 3m → this class of false page cannot recur.** (Matches skill `cadence-bucket-marker-advances-on-skip-not-only-success` + CLAUDE.md "producer liveness pages on ATTEMPT recency, stamped before conditional work".)

---

## D. Impact on the prompt's R1–R5

| Req | Prompt premise | Reality | Resolution |
|---|---|---|---|
| **R1** fix `servedIntervalMs` misparse | WHITEBIT token misparsed (unit) | **No misparse** — grid correct; WHITEBIT map is STRING (`'15m'`→900000 ✓). | **Nothing to fix.** |
| **R1** raw-integer token MUST throw | ambiguous-unit is the bug class | **BYBIT legitimately uses bare-number-minute tokens** (`'1'`,`'60'`,`'D'`) → parser's bare-int→minutes rule is CORRECT for it; a throw would BREAK bybit. Number-map adapters (bitmart/kucoin/phemex/hl) already pass an EXPLICIT unit. | The ambiguity bug does not exist; a fail-closed throw is a regression. **Drop or reshape** (architect call). |
| **R2** heartbeat before guard | real, independent | **CONFIRMED real + is the actual fix.** | **DO — core of this hotfix.** |
| **R3** kill switch `ALGOVAULT_TF_SKIP_ENABLED` | firewall the spec lacked | Sound hardening (instant rollback lever). | **DO.** |
| **R4** no-stranded + runtime-faithful gates | "must FAIL on f9b6b4d" | No stranding exists on f9b6b4d → the no-stranded test **passes** there (can't fail). Runtime-faithful canary still valuable. | **DO (adjusted)** — keep as regression guards; drop the "must fail on f9b6b4d" clause. |
| **R5** verify KEEP side + alert clears | active outage | Already GREEN pre-fix. | Verify H2 fix: 3m/5m now stamp attempt-heartbeats (floor→3m). |
| **Break-glass** revert `f9b6b4d` + crontab | if >1h | **NOT needed** — outage resolved; reverting would drop the correct PHEMEX-12h fix for zero benefit. | **Do NOT break-glass.** |

---

## E. Architect HALT — awaiting ratification (see chat fenced block)

R0 refuted the prompt's primary hypothesis (H1) and found the incident healed. Proceeding would mean SKIP R1's misparse-fix (nothing to fix) + reshape R1's fail-closed clause (bybit) + execute R2/R3/R4/R5 as forward hardening. This changes the ratified plan → HALT before any state mutation.
