# OPS-LABEL-FRESHNESS-W1 — R1 endpoint-truth & mechanism forensics

**Status:** R1 read-only forensics COMPLETE → architect-ratified (Q1–Q4) → **R2/R3 shipped `cd3ff60`, R4 backfill + verification per status.md.** (Census below is the 07-23 09:35Z R1 snapshot; see the 07-24 corroboration addendum at the end.)
**Author:** Claude Code · **Box:** 204.168.185.24 (`AlgoVault-MCP`) · **Box UTC at probe:** 2026-07-23 09:24→09:35Z · **DB clock:** 2026-07-23 09:35:16Z (epoch 1784799316) — box & session calendars agree, no clock-drift artifact.
**Method:** live box only (vault mirror not trusted); psql via `docker exec …-postgres-1 psql -tA` (host-bash pattern); no state mutated.

---

## Mechanism verdict (one line)

**H1 CONFIRMED as the primary structural cause; H2/H3/H4/H5 REFUTED. Two amplifiers on top: (A1) deploy container-recreate kills the nightly run mid-flight — the *same* failure class as the original 16-day incident; (A2) OPS-VENUE-GO-LIVE-15-W1 grew the rotation to 17 venues on a fixed 210-min budget and BITMART burns a full 45-min venue-budget on 2,546 errors, stealing budget from incumbents.**

The rotation optimizes **max-staleness** when it must optimize **SLO-breach**: a fresh major sinks to the back of a staleness-ordered queue that a 210-min budget only reaches ~6–7 of 17 deep, so BINANCE ages past its 24h SLO before it resurfaces. "Self-correcting" is false under structural overload — a fixed-budget staleness fair-queue **deterministically starves the least-stale**.

---

## R1.1 — What actually shipped (claim | reality | resolution)

| Claim (spec/system-map) | Reality (live box) | Resolution |
|---|---|---|
| W1 replaced unbounded pass with staleness-first rotation + budgets | `830c5bdf fix(labels): staleness-first venue rotation + clean-exit budgets + nightly recency window` — HEAD `39222e86`, deployed | ✅ confirmed |
| Two-tier canary shipped | `7eb31baf feat(monitoring): two-tier … freshness canary + triage backfill runner` | ✅ confirmed |
| Nightly cron `23 2 * * *`, flock-guarded | `23 2 * * * flock -n /var/lock/algovault-nightly-carry-labeler-5d062010.lock docker exec …mcp-server-1 node dist/scripts/nightly-carry-labeler.js >> /var/log/carry-labeler.log` | ✅ confirmed |
| Flags `--lookback-days 21 --time-budget-min 210 --venue-budget-min 45` | Run-start line: `… over 17 venues … lookback=21d budget=210m/venue≤45m` | ✅ confirmed — **but 17 venues, not 15 (see identifier-diff)** |
| Canary is `/opt/algovault-monitoring/directional-label-freshness.py`, cron `41 6` | `41 6 * * * python3 /opt/algovault-monitoring/directional-label-freshness.py >> /var/log/directional-label-freshness.log` | ✅ confirmed |
| Vault status.md lacks W1 completion | Live box status.md at `/var/lib/algovault-monitoring/status.md` (415 KB) carries it + the OPS FALLOUT note that spawned this wave | ✅ reconciled from box |

---

## R1.2 — Frontier census (tau1.0-floor0.30-v1, mirrors canary; 09:35Z) — settles H5

Lag desc. Majors in **bold**. `unlab_48h` = unlabeled-but-eligible BUY/SELL signals in the last 48h (input-flowing proof).

| venue | tier | newest_labeled (UTC) | lag_h | eligible | unlabeled_total | unlab_48h |
|---|---|---|---|---|---|---|
| ASTER | long-tail | 07-21 00:10 | 57.4 | 15968 | 974 | 748 |
| **BINANCE** | **major** | **07-21 01:14** | **56.4** 🛑 | 58546 | 1402 | **1118** |
| BINGX | long-tail | 07-21 02:03 | 55.5 | 14741 | 9806 | 482 |
| EDGEX | long-tail | 07-21 14:41 | 42.9 | 2028 | 1698 | 0 |
| **OKX** | **major** | **07-21 19:17** | **38.3** 🛑 | 51376 | 2482 | 416 |
| WHITEBIT | long-tail | 07-22 01:43 | 31.9 | 5587 | 4201 | 162 |
| KUCOIN | long-tail | 07-22 02:59 | 30.6 | 34536 | 3925 | 530 |
| **HL** | **major** | **07-22 03:40** | **29.9** 🛑 | 11774 | 11188 | 95 |
| BITMART | long-tail | 07-22 20:27 | 13.1 | 11686 | 11345 | 154 |
| WEEX | long-tail | 07-22 22:23 | 11.2 | 2723 | 2069 | 76 |
| GATE | long-tail | 07-23 01:01 | 8.6 | 23322 | 3426 | 580 |
| PHEMEX | long-tail | 07-23 00:57 | 8.6 | 10082 | 7347 | 234 |
| XT | long-tail | 07-23 01:14 | 8.3 | 8541 | 3879 | 226 |
| **BITGET** | **major** | 07-23 01:23 | 8.2 ✅ | 48633 | 1560 | 52 |
| HTX | long-tail | 07-23 01:31 | 8.1 | 7003 | 5050 | 120 |
| **BYBIT** | **major** | 07-23 01:38 | 7.9 ✅ | 60115 | 161 | 96 |
| MEXC | long-tail | 07-23 08:02 | 1.5 | 21532 | 12492 | 415 |

**H5 = REFUTED.** BINANCE Q2: newest BUY/SELL at 07-23 09:33 (0.0h), matured signals at 08:14/08:03 carry `has_tau1=f`; 1,118 matured-but-unlabeled in 48h. Input flowing + output frozen = the real silent-producer-halt, not a canary artifact. Canary query independently verified sound: `signals.created_at` epoch used consistently on both sides, correct `barrier_spec`/`BUY,SELL`/`pfe NOT NULL`/`tf<>'1m'` filters, `input_flowing` 48h gate. Q3: BINANCE frozen at **07-21 01:14 across all 3 specs** (tau0.5/1.0/2.0) → uniform "not processed," **refutes H4** (poisoning would be spec- or partial-shaped).

---

## R1.3 — `[venue-summary]` replay decides H1 vs H2/H3/H4

Two nightly runs (both staleness-ordered; order = live staleness ranking at run start):

**07-22 run** (`13447 groups / 17 venues`, rotation `PHEMEX>WHITEBIT>MEXC>XT>KUCOIN>HL>BITMART>EDGEX>BITGET>BYBIT>GATE>ASTER>BINANCE(13th)>BINGX>HTX>WEEX>OKX(17th)`):
- Served: PHEMEX, WHITEBIT, MEXC(venue-budget), XT, KUCOIN(venue-budget), HL(venue-budget 2759s), **BITMART → `outcome=global-budget` at 91/423, elapsed cumulative = 210m EXHAUSTED**.
- **BINANCE (13th), OKX (17th) never reached** — no venue-summary line exists. **Pure H1: fresh majors sorted to the back, 210-min global budget spent on the recovering long-tail.**

**07-23 run** (`13720 groups / 17 venues`, rotation `EDGEX>BITGET>BYBIT>BITMART>GATE>ASTER>BINANCE(7th)>BINGX>OKX(9th)>WHITEBIT>KUCOIN>HL(12th)>…`):
- Served: EDGEX(33s), BITGET(855s→lag 52.7h→ok), BYBIT(632s→48.1h→ok), BITMART(2724s venue-budget, **2,546 errors**). Then **DIED at 03:48:32Z** — `[pg-pool] … terminating connection due to administrator command`.
- **BINANCE (7th), OKX (9th), HL (12th) never reached.**

| Hypothesis | Discriminator evidence | Verdict |
|---|---|---|
| **H1** starved by staleness-ordering within budget | BINANCE 0 venue-summary lines across both nights; 07-22 hit global-budget at venue 7 with BINANCE 13th | **CONFIRMED** |
| H2 main() hang / 6h watchdog SIGKILL | No `SIGKILL`/`WATCHDOG` lines; kills are pg `admin_shutdown` (57P01) at 85 min, not 6h; 07-22 clean `global-budget`/`venue-budget` exits | **REFUTED** |
| H3 BINANCE-specific throw | "never reached" (no summary, no error line) ⇒ not a throw | **REFUTED** |
| H4 checkpoint poisoning / frontier stuck | frozen uniformly across all 3 specs at last-reached-run boundary; classic not-reached | **REFUTED** |
| H5 canary mis-measures | census reproduces breach; BINANCE emitting matured unlabeled BUY/SELL; query sound | **REFUTED** |

---

## R1.4 — Watchdog / flock / kill forensics (settles H2 + surfaces amplifier A1)

- **No 6h watchdog fire.** The 07-23 kill is at **03:48:32Z, ~85 min in** — nowhere near a 6h backstop (which would fire ~08:23Z). Message class = Postgres `57P01 admin_shutdown` ("terminating connection due to administrator command").
- **A1 — deploy-kill:** 03:48:32Z termination coincides within ~31s of the **OPS-VENUE-GO-LIVE-15-W1 container recreate `2026-07-23T03:49:03Z`** (box status.md line 55). The deploy tore down the DB backends the running labeler held.
- **This is recurring:** the same `administrator command` termination appears **8 additional times** across the 16-day-recovery window in `carry-labeler.log` (lines 1410, 2031, 2560, 7050, 7557, 8655, 9158, 9674) — the labeler is chronically interrupted by deploy/restart events. **Same failure class as the original 16-day starvation** (system-map row 248: "killed nightly by deploy container-recreates").
- **flock:** no `flock -n` no-acquire — nightly runs did not overlap each other. **But** the detached triage backfill (below) started 01:40 and **overlapped** the 02:23 nightly (separate locks → no mutual exclusion); API rate contention is a plausible contributor to BITMART's 2,546 errors on the nightly.

---

## R1.5 — Capacity arithmetic (measured, not assumed)

- Global budget **210 min/night**; per-venue cap **45 min**; **17 venues** in rotation.
- Observed per-venue durations: heavy venues hit the 45m cap — BITMART 2724s, MEXC 2702s, KUCOIN 2702s, HL 2759s; mid — BITGET 855s, XT 1620s, PHEMEX 1201s; light — WHITEBIT 589s, EDGEX 33s.
- **07-22:** 210m served **~6.5 venues** (6 full + BITMART partial) before `global-budget` → **~10 venues unreached**.
- **07-23:** deploy-killed at 85m / **4 venues**.
- **Structural shortfall:** only **~6–7 of 17** venues reachable/night. A freshly-labeled venue sinks to the back and does not resurface for ~2–3 nights (48–72h). A **major (24h SLO) therefore breaches after ~1 missed night** — guaranteed unless it lands in the top ~6 most-stale that night. Even at a conservative ~20 venue-min/venue to stay current, demand ≈ **17×20 = 340 venue-min vs 210 budget ≈ 130 venue-min short (~38% under-provisioned)**; backlog paydown (unlabeled_total: MEXC 12.5k, HL 11.2k, BITMART 11.3k, BINGX 9.8k) makes real demand far higher.
- **A2 — new-venue theft:** OPS-VENUE-GO-LIVE-15-W1 added WHITEBIT/BITMART/XT to an already-overloaded budget with **no budget re-check**; BITMART alone consumes a full 45-min venue-budget on errors, directly starving venues behind it.

---

## R1.6 — Cron safe-window + pacing (for R3/R4)

- Nightly labeler window **02:23 → ≤ ~05:53** (210m). Canary at **06:41** (post-window). Widening the budget past ~06:00 collides with the 06:41 canary read — **hard ceiling on any budget-widen** (design fork below).
- Detached **triage backfill** `/opt/algovault-backfill-labels-run-triage.sh` (PID 1272515, PPID=1, started 01:40Z) is the W1 R3 recovery, recoverability-fuse ordered, holding `/var/lock/algovault-label-backfill.lock`, currently on MEXC 5m. Idempotent (`--check`/`ON CONFLICT`), paced via the shared weight-budget lane. It does **not** prioritize majors.
- Pacing inherited from the shared transport: 418/429 typed & never blind-retried; HL ~4500ms (~22% ≤25%) rider; per-venue per-minute weight windows (observed `used:100` caps, `batch_wait` backoffs). R3/R4 must acquire a lock that **mutexes against the 02:23 nightly** and inherit these riders.

---

## Identifier-diff (cited vs live) — for ratification before R2 mutates state

| Identifier | Spec/canary says | Live reality | Action |
|---|---|---|---|
| Venue count | "15 promoted" | **17** in labeler rotation + canary digest (15 promoted + shadow ASTER/BINGX/EDGEX) | R2 tier-SoT & capacity must cover **17** |
| Major tier set | canary `MAJORS={BINANCE,BYBIT,OKX,BITGET,HL}` (hardcoded .py) | same, but labeler has **no tier concept** (raw staleness) | R2 single-source it; scheduler+canary must import ONE SoT |
| SLO thresholds | `MAJOR_SLO_H=24`, `LONGTAIL_SLO_H=72`, `INPUT_FLOWING_H=48`, `CONSECUTIVE_TO_PAGE=2`, `BARRIER_SPEC=tau1.0` | confirmed in canary | reuse verbatim from the shared SoT |
| Budget env | `LABELER_LOOKBACK_DAYS=21`, `LABELER_TIME_BUDGET_MIN=210`, `LABELER_VENUE_BUDGET_MIN=45` | confirmed | R2 capacity response may add a ceiling/intraday-pass env |
| Canary vs budget timing | — | budget ends ~05:53, canary 06:41 (only ~48m gap) | constrains budget-widen; may need intraday pass or canary move |

---

## Map Anchor (edges this wave will mutate — enumerated per Plan-Mode)

- **Row 248** — `nightly-carry-labeler …label new signals into directional_labels… → signal_performance`: semantics change (staleness-first → SLO-deadline-aware ordering + capacity-honest budget). Edit the labeler clause + overwrite the single `Last touched:` line (never prepend).
- **NEW monitoring edge** (R3) — `directional-label-freshness canary --"targeted --venue re-label (Detect→Recover)"--> nightly-carry-labeler/backfill`. Add the row.
- **Read-only consumers of `directional_labels`** (unbroken; recovered-window footnoted in R5): AOE `edge_gate` shadow (rows 90–92, 249), EDGE-CARRY-RANKER training set, paper-carry-tracker.

---

## Non-negotiables carried into R2 (from firewall)

Per-venue isolation preserved · `[venue-summary]` line per venue/run retained · pacing riders honored · deep/backfill (no-flag) invocation unchanged · **budget-widen alone = HALT** (only allowed as R2's bounded capacity response paired with the shortfall signal) · never retry 418/429 · DWR/outcome_return_pct stay INTERNAL · per-file `git add`.

---

## Addendum — 07-24 corroboration (the session spanned into the next nightly cycle)

Box UTC advanced ~22h mid-session; a full **07-24 nightly ran on the OLD (staleness-first) code with NO deploy** — the cleanest possible H1 confirmation:

- **07-24 nightly (02:32Z)** rotation `ASTER>BINANCE(2nd)>BINGX>EDGEX>OKX(5th)>KUCOIN>HL(7th)>BITMART>GATE>BITGET(10th)>BYBIT(11th)>…`. Served 7 venues → `[budget] global time budget reached` (clean exit, no kill) → **BITGET/BYBIT never reached → breach**.
- **07-24 06:41Z canary:** BINANCE 4.7h ✅ · OKX 4.4h ✅ · HL 3.9h ✅ (the 07-23 breachers, healed by aging to the front) · **BITGET 29.3h BREACH · BYBIT 29.0h BREACH** (day-1). The breaching-major SET rotated: 07-22 {BITGET,BYBIT} → 07-23 {BINANCE,OKX,HL} → **07-24 {BITGET,BYBIT}** — the whack-a-mole is a deterministic property of budget×staleness-ordering, not venue-specific and not deploy-dependent. This is the decisive "no-deploy night still starves majors" evidence.
- **Reconciliation:** no parallel session on this wave (only `origin/ops/directional-label-halt-w1`, W1 merged). The running backfills were a detached operator recovery (`/opt/algovault-backfill-t3-tail.sh`, no interactive login) finishing the long-tail T3 sweep — stopped under wave control (Q4) before deploy; R4 absorbs its remaining work.
- **R4 acute target shifted** BINANCE→{BITGET,BYBIT} (the current breachers) — a parameter change, not a mechanism change; SLO-deadline ordering protects whichever majors are most overdue.
