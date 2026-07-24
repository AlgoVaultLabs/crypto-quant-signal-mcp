# OPS-DIRECTIONAL-LABEL-HALT-W1 — Plan-Mode endpoint-truth (R1 forensics)

Probes run live 2026-07-21 ~13:00–13:40Z, all read-only (204 syslog/cron/logs + postgres
under `SET default_transaction_read_only=on` + per-venue kline-horizon probes through the
production adapters). Plan approved 2026-07-21 ratifying the §3 fix design. **The mechanism
was established from five independent forensic evidence lines — no mutating reproduction
was needed; the first fixed-run's per-venue timing log is the executable confirmation.**

## 1. Truth table (claim | reality | resolution)

| # | Claim (spec) | Reality (probed) | Resolution |
|---|---|---|---|
| 1 | Dead: KUCOIN·OKX·WEEX·XT·HTX·MEXC (+WHITEBIT 06-30) | ✅ tau1.0 label-frontier lags 393–510h — **plus 2 the spec missed: PHEMEX 0 labels EVER (9,687 eligible) and HL 91.4h** | repair scope = 9 venues |
| 2 | "BINANCE/BYBIT/BITGET (+others) still labelling" | partially — only ASTER/BINANCE/BINGX meet 24h (11–13h); BITGET 35.1h · BITMART 34.5h · EDGEX 31.1h · BYBIT 30.6h · GATE 28.0h | fixed nightly heals these |
| 3 | orchestrator logs per dead venue | **16 nightly `STEP directional-labels START` (07-06→07-21, 02:32 each), 0 OK / 0 FAILED / 0 ALL-3 in the whole log** — the step NEVER completed post-cutover; the killer leaves no line (SIGKILL) | mechanism §2 |
| 4 | checkpoint state | DWR lane has no separate checkpoint — resume = `directional_labels` rows (done-set diff). Not stuck/poisoned; tail venues simply never REACHED | fix = ordering+budget |
| 5 | candidate mechanisms | per-group try/catch EXISTS (`:323`) → error-abort ruled out; dmesg clean → OOM ruled out; OKX/HTX/MEXC have budget-registry entries → unpaced-throw ruled out as the discriminator | see §2 |
| 6 | recoverability matrix NOW | measured live, 8 venues × 9 TFs (§4 of the plan; summary below) | ordered the R3 runner |
| 7 | cron safe-window + pacing | **cron had NO flock 07-06→07-21** (syslog CMDs verbatim); flock added TODAY 04:21Z + the 6h script watchdog TODAY 04:19Z (`95b6d43`→`e55d952`) — neither existed during the incident. Labeler runs under `runAsBatch` shared ledgers | keep both; fix makes the run fit its lifetime |
| 8 | `--check` zero-write | ✅ source-verified (`:220-224`, short-circuits before fetches) | convergence loop + AC3 sound |

## 2. Mechanism (five evidence lines)

1. **Throughput**: `loadGroups` = ALL-TIME groups (25,960, +342/day), alphabetical; pace
   12–28 groups/min (250ms/fetch + HL `batch_wait` ≈60s dominating the log) → full pass
   15–36h ≫ 24h. The permanently-unlabelable noKlines backlog (37,915 by mid-run;
   never-labeled cohorts BINGX 9.3k / BITMART 11.2k / HL 11.4k / PHEMEX 9.7k) re-attempted
   nightly — self-amplifying.
2. **Ordering**: fixed alphabetical → the tail (HTX…XT) sits past the death frontier every
   night. **Per-venue label frontiers reconstruct each run's death**: the 07-20 run start
   02:32 → BYBIT reached ~06:37 (4h) → GATE ~08:39 (6h) → died inside HL's 60s-wait swamp
   (HL frozen at 07-17); the 07-21 run reached BINGX 02:03 and was killed by the 04:19Z
   deploy recreate.
3. **The killer**: near-daily deploy container-recreates SIGKILL every in-container process
   — no log line possible; hence 16 STARTs / 0 completions / 0 errors. The lane's
   "silent-recovery contract" cannot log what kills it from outside.
4. **No serialization**: two interleaved labeler progress streams in one log on 07-21
   (`15000/25618` vs `5600/25960` — different group censuses = different nights' runs
   coexisting), compounding slowness through the shared weight ledgers.
5. **No freshness assertion existed** → 16 days invisible through two Monday health checks.

WHITEBIT (06-30) + MEXC (07-04 07:43) predate the 07-05 cutover: the pre-cutover ad-hoc
daily-batch lane had the same alphabetical full-pass property, already truncating at the
extreme tail; census growth + the 02:23 anchor + the deploy-kill window moved the frontier
to ~HL.

## 3. Recoverability matrix v1 (measured 2026-07-21 ~13:30Z)

Gap ≈ 16.5d. KUCOIN/OKX ≥50.6d every tf = FULLY recoverable. Recent-only venues by tf:
3m/5m — WEEX/XT/HTX/PHEMEX 3.5d (~13d lost), MEXC 6.9d (~9.5d lost), WHITEBIT 10.4d (~6d);
15m — 10.4d on WEEX/XT/HTX/PHEMEX/WHITEBIT (~6d lost), MEXC 20.8d FULL;
30m — WEEX 10.4d (~6d lost), XT/HTX/PHEMEX/WHITEBIT ~20.8d FULL; ≥1h — FULL everywhere
(41.7–50.6d). Trailing-sigma burn (60×W full / 30×W min → `low_vol_history` flag) further
narrows full-quality spans on the 3.5d-horizon venues; the labeler's existing flags account
for it by construction; matrix v2 (post-backfill) measures the realized loss.

## 4. Ship ledger (execution evidence)

| Deliverable | Evidence |
|---|---|
| R2 generator fix (`830c5bd`, main) | rotation/budgets/lookback/isolation/--timeframe; 22 new unit tests; suite 3,776 passed; deployed 14:16Z (GHA 29838097954), dist grep positive in the recreated container |
| R3 triage backfill | host runner `/opt/algovault-backfill-labels-run-triage.sh` (flock, nohup, convergence-retry) launched 14:17Z; WEEX healed to 5.7h lag within minutes; per-slice logs `/var/log/label-backfill-triage.log` |
| R4 paging canary | `/opt/algovault-monitoring/directional-label-freshness.py` + cron `41 6 * * *` (slot-audited); 26-assertion hermetic suite; live healthy run + forced-stale `DRY_RUN_FIRED` through the real wrapper (resolver `W{NEXT}`→W1, cooldown marker written). **Live smoke caught a real defect the hermetic suite could not**: a quoted `-F'|'` under `split()`/no-shell reaches psql with literal quotes and silently kills every census row — psql's unaligned default separator already IS `\|`; flag dropped, comment encodes the trap |
| R4 digest twin | AOE `src/monitoring/label_freshness.py` + daily/weekly wiring (mirrors carry flip-readiness exactly; fail-soft); AOE suite 611 passed; `1729f77` on AOE main (rides the next AOE-box redeploy — the line is fail-soft additive) |
| Thresholds ledger | `defensive-reductions-to-revisit.md` CREATED at vault root (the CLAUDE.md convention file had never been instantiated) with 4 rows, revisit 2026-08-04 |

## 5. Honest scope notes

- The two-tier SLO sets are the spec's (Mr.1 venue policy 2026-07-21). HL is a MAJOR and
  was itself lagging 91h at ship — the backfill heals it; the canary would page from
  day 2 if it regresses.
- The AOE digest line and the 204 pager derive freshness from a byte-identical census SQL
  but are 2 deployed copies (different repos/hosts) — cross-referenced in both files;
  3rd consumer triggers the shared-extraction rule.
- `ops/label-backfill/run-triage.sh` is committed as the wave's reusable artifact; the
  host copy is the executed instance.

## 6. Final backfill ledger (measured 2026-07-24 09:30Z — `TRIAGE BACKFILL DONE` 09:15:36Z)

**Incident-window recovery** (signals created 2026-07-04 → 07-21, tau1.0; the other two specs
ride the same klines):

| venue | eligible | labeled | recovered % | permanently lost |
|---|---|---|---|---|
| OKX | 3,944 | 3,905 | **99.0%** | 39 |
| KUCOIN | 6,737 | 6,614 | **98.2%** | 123 |
| MEXC | 5,311 | 4,613 | 86.9% | 698 |
| WHITEBIT | 1,738 | 1,316 | 75.7% | 422 |
| XT | 3,300 | 2,451 | 74.3% | 849 |
| PHEMEX | 3,870 | 2,846 | 73.5% | 1,024 |
| HTX | 1,823 | 932 | 51.1% | 891 |
| HL | 1,330 | 591 | 44.4% | 739 |
| WEEX | 1,157 | 403 | 34.8% | 754 |
| **TOTAL** | **29,210** | **23,671** | **81.0%** | **5,539 (19.0%)** |

**The 16-day detection delay cost 5,539 incident-window rows (19.0%)** — concentrated exactly
where matrix v1 predicted: the 3.5d-kline-horizon venues' short TFs (WEEX/HL/HTX worst). The
losses are permanent physics (klines aged out before anyone knew to fetch them), which is the
number that justifies the canary forever.

**Residual characterization (why the post-convergence `--check` counts are NOT losses):**
OKX's 6,038 all-time residual = 1,962 pre-incident **delisted-coin archaeology** (TON 1,486 ·
IP 313 — klines unfetchable despite OKX's 50d depth) + 39 incident + ~9 recent eval-window-open;
KUCOIN's 700 same shape. The recent-only venues' large all-time residuals (PHEMEX 18.5k ·
MEXC 26.0k) are pre-incident history that predates their kline horizons — never recoverable by
anyone, now measured and retired from the nightly by the 21d window (F3).

## 7. Successor-wave reconciliation (the pipeline closing its own loop)

The canary's first REAL page (2026-07-23 06:41 `FIRED: HTTP 200`, BINANCE 53.4h, consecutive=2,
body naming `OPS-LABEL-FRESHNESS-W1`) led to that wave being dispatched to a parallel session,
which shipped `cd3ff60` (2026-07-24 07:52): **SLO-deadline rotation** (confirmed my
staleness-first ordering minimised max-staleness but whack-a-moled the majors' 24h SLO across
3 nights — the correct objective is time-to-SLO-breach, majors-first), a **shared tier SoT**
(`src/lib/venue-slo-tiers.ts` — retiring this wave's 2-copy tier-constants caveat, §5), a
**poison-venue circuit-breaker** (the BITMART 2,546-error class), **graceful-stop SIGTERM in
deploy.yml** (structurally closing the deploy-kill mechanism §2.3), and canary auto-recovery.
Incident wave → canary page → dispatch → hardening wave: the operator-action-required contract
worked end-to-end in production within 24h of the canary going live.
