# OPS-MONITORING-SCHEDULE-SOT-W1 — R0 endpoint-truth

**Read-only forensics gate. Zero mutations, zero commits, executed before any state change.**
Probed 2026-08-03 07:51–08:05 UTC against live `signal-1` (204.168.185.24), live `aoe-1`
(178.104.200.44), and `origin/main`.

```
SCHEDULE_SOT_R0=DECLARATION_STALE
```

Condition satisfied on all three legs: live is `27 12 * * 1` · `27` is in the CLAUDE.md
off-`:00` set `{13,17,23,27,33,37,43,47,53,57}` · R0b ties the change to a deliberate SEC-48
remediation. **Proceed to R1–R4.**

---

## R0a — the schedule census. FIVE copies, not four.

The spec anticipated four. A fifth exists, it is stale, and nothing detects it.

| # | Location | Value | State |
|---|---|---|---|
| 1 | live root crontab, `signal-1` | `27 12 * * 1` | ✅ authoritative |
| 2 | `ops/monitoring/monitoring-inventory.json:447` | `0 12 * * 1` | ❌ stale → R1 |
| 3 | repo `ops/monitoring/venue-slo-tiers-drift-canary.sh:16` | `27 12 * * 1` | ✅ already correct |
| 4 | host checkout `/opt/crypto-quant-signal-mcp/…:16` | `27 12 * * 1` | ✅ pulled |
| **5** | **installed `/opt/algovault-monitoring/venue-slo-tiers-drift-canary.sh:16`** | **`0 12 * * 1`** | ❌ **stale → R1** |

Probes: `crontab -l | grep -n venue-slo`; `ls -la /etc/cron.d/` (only `e2scrub_all`,
`.placeholder`, `sysstat` — no monitoring entries); `jq` on the row; `grep -n` on the script
(the comment is at **`:16`** — the spec's unconfirmed figure was correct, now verified);
`git grep -n -- '12 \* \* 1' origin/main`; `grep -rn '12 \* \* 1' /opt/algovault-monitoring/`.

**Line 16 of the repo script already read `27`, and lines 18–19 already carried the rationale**
(*"forbids :00 … contention over-counts CPU by 50-90x. This was `0 12 * * 1` until 2026-08-02"*).
So R1's "update the script comment" step is a **repo no-op** — the real work is copy 5.

### Why copy 5 was invisible

`check_hash_drift` compares the row's **recorded** `sha256` against the **host** file:

```
row.sha256                                   68d026ea…   (the HOST file's own hash)
/opt/algovault-monitoring/…canary.sh         68d026ea…   -> equal -> HASH_DRIFT: OK
ops/monitoring/…canary.sh (repo, origin/main) b2280d27…   -> never compared
```

The check's docstring says "repo → host", but the recorded hash tracks the **host** artifact, so
a **repo-only edit is invisible by construction**. `OPS-AUDIT-REMEDIATION-LOW-W1` edited the repo
script and never re-installed it; every gate stayed green for a day. Same shape as the schedule
itself: a fact duplicated with nothing coupling the copies.

---

## R0b — attribution (AC2). The wave is **named**.

```
$ git log -S'27 12' --oneline --all
90610fa fix(ops): Ch1 — schedule the dark parity guard, guard 7 cron entrypoints,
        fix first-match-wins safety tags [OPS-AUDIT-REMEDIATION-LOW-W1]
```

`90610fa` is the **only** commit that ever introduced the string `27 12`, and
`git log --follow -- ops/monitoring/venue-slo-tiers-drift-canary.sh` shows it as the most recent
commit to touch that script. It landed 2026-08-02 13:35 UTC and applied SEC-48's remediation
verbatim (`audits/SECURITY-AUDIT-FULL-W1/report.md:1288`).

Corroborating host evidence: `/opt/algovault-monitoring/crontab.bak.PRE-POSTURE-DRIFT-20260730T054808Z`
and two other crontab backups still contain `0 12 * * 1 …venue-slo-tiers-drift-canary.sh`, so the
live value was `:00` as recently as 2026-07-30. **Hypothesis (b) — "the crontab moved earlier than
2026-08-02" — is refuted.**

**Verdict: `OPS-AUDIT-REMEDIATION-LOW-W1` moved the crontab and the repo script comment, and
updated neither the inventory row nor the installed host copy.**

---

## R0c — breach-streak composition (AC3). Neither hypothesis (a) nor (b). A third mechanism.

Verbatim from `/var/log/monitoring-inventory-reconcile.log`:

| Run | Result | Streak |
|---|---|---|
| `2026-07-30T06:57:38Z` | `HASH_DRIFT: BREACH [webhook-delivery-canary, directional-label-freshness, docs-drift-canary]` | `1/3` → `SUSTAIN_PENDING` |
| `2026-07-31T06:57:37Z` | all nine checks `OK (empty set)` | `0/3` |
| `2026-08-01T06:57:37Z` | all checks `OK (empty set)` | `0/3` |
| `2026-08-02T06:57:37Z` | all checks `OK (empty set)` | `0/3` |
| `2026-08-03T06:57:38Z` | `SCHEDULE_DRIFT: BREACH [{"id": "venue-slo-tiers-drift-canary", "inventory": "0 12 * * 1", "live": "27 12 * * 1"}]` | **`4/3` → `ALERT_SENT`** |

The counter went `0/3` → `4/3` across **one** cron interval. It cannot be counting days. Source:

```python
def update_breach_streak(breached):
    p = breach_state_path()
    if not breached:
        p.unlink(missing_ok=True); return 0     # a clean run RESETS
    ...
    streak = prev + 1                            # +1 PER INVOCATION
    p.write_text(str(streak))
```

**The streak increments once per *invocation*, not once per day, and it is persisted.** The cron
log records exactly ONE breaching run since the last clean one, so **three further breaching
invocations happened off-cron** between 2026-08-02 13:35 (when `90610fa` landed) and 2026-08-03
06:57 — ad-hoc runs whose stdout was never appended to the log file.

Hypothesis (a) was directionally right (the streak is on the *condition*, not the row) but wrong
on mechanism; (b) is refuted outright by the crontab backups above.

**Operational consequence, and it binds this wave:** any ad-hoc reconciler run advances the
pager's persisted streak, so a wave verifying its own work can push the counter past the paging
threshold. Every verification run in this wave therefore uses `ALGOVAULT_TG_TEST_INERT=1` — never
bare, and never `DRY_RUN_TG=1`, which still writes the 24h cooldown marker
(`send_telegram.sh:143-145`) and false-greens back-to-back runs.

### `checkout-parity` — report only, and the open record is **stale**

```
$ crontab -l | grep checkout-parity
47 6 * * * /opt/crypto-quant-signal-mcp/ops/cron/checkout-parity.sh >> /var/log/checkout-parity.log 2>&1
```

Live schedule `47 6 * * *` matches the inventory row exactly. **It is NOT dark.** Of the two
disagreeing `status.md` records, `OPS-AUDIT-REMEDIATION-LOW-W1` Ch1's "fixed" is correct and
`RELEASE-BATCHED-W1`'s later-timestamped "still open" is stale. **No routing to
`OPS-CHECKOUT-PARITY-SCHEDULE-W{NEXT}` is required; that wave is not needed.**

---

## Two-host reconciler census (the spec's fifth census target)

| Host | Path | sha256 (pre-wave) | Cron |
|---|---|---|---|
| `signal-1` | `/opt/algovault-monitoring/monitoring-inventory-reconcile.py` | `9a61457f…` | `57 6 * * *` |
| `signal-1` | `/opt/crypto-quant-signal-mcp/ops/monitoring/…` (checkout) | `9a61457f…` | — |
| `aoe-1` | `/opt/algovault-monitoring/monitoring-inventory-reconcile.py` | `9a61457f…` | `17 7 * * *`, `MONITORING_HOST_LABELS=aoe-1` |

Exactly two installations, **byte-identical**, and one shared inventory row whose `installed_at[]`
already names both. R3 takes **path (a) — update both** — with a `.bak` on each and a per-host
`ALGOVAULT_TG_TEST_INERT=1` run asserting the new body.

---

## Probes 7 & 8

**Probe 8 · system-map edge-touch: `NONE — internal change only`.** `system-map.md` lives in the
Obsidian vault, not the repo. Re-grepped there: 2 hits for `venue-slo-tiers`, both inside the
`crypto-quant-signal-mcp` component row describing `src/lib/venue-slo-tiers.ts`. **No row names a
schedule.** → `system-map.md updated: n-a`.

**Probe 7 · deploy scope — confirmed from the workflow, not from the spec.**
`git show origin/main:.github/workflows/deploy.yml` lists `ops/monitoring/**` under `paths-ignore`
(with the comment "installed to /opt/algovault-monitoring/ via SSH, NOT shipped in the container
image"). A monitoring-only commit therefore does not rebuild prod — **and does not run CI at all**,
which is the finding below.

---

## Spec-premise corrections

| # | Spec premise | Reality | Resolution |
|---|---|---|---|
| 1 | R1 updates the script's suggested-cron comment | Repo copy already correct; the **installed host copy** is the stale one | R1 re-installs to the host + re-stamps `sha256` |
| 2 | AC9: `carry-scorer`'s `7 0-1,3-23 * * *` PASSES, evidenced by "gate output naming that row" | **`carry-scorer` has no inventory row at all.** The gate reads the inventory, so it can never name it | AC9's *intent* satisfied by a unit-test fixture pinning that exact expression → parses + PASSES. Reported separately: `/opt/algovault-carry/*` crons (`carry-scorer`, `paper-carry-tracker`, `carry-retrain`) have no inventory rows — an inventory-coverage gap, out of scope |
| 3 | AC12: R3's predicate **imports** R2's module | R2 is Node, R3 is Python — `import` is impossible across that boundary | Shared rule **data** (`schedule-boundary-rule.json`) read by both + a cross-language parity test over one corpus requiring byte-identical `--classify` / `--classify-schedule` output |
| 4 | R2 wired to `deploy.yml` + `prepublishOnly` | `deploy.yml` is the **only** push-on-main workflow and paths-ignores `ops/monitoring/**`. A commit touching only the inventory runs **no CI** → the gate would be **structurally dark for its primary corpus** | Added `.github/workflows/monitoring-schedules.yml`, paths-triggered on the inventory/rule/baseline/gate. Not a `pre-push` block — that hook already carries five and a sixth deadlocked ~70 checkouts twice in 27h |
| 5 | Lint every row `schedule` | `installed_at[].schedule` is a real **per-host override** that `schedule_for()` prefers | Gate lints the row schedule **and** every `installed_at[]` override, naming the host |
| 6 | "Expect more than one" pre-existing violation | **3** after R1 converges `venue-slo` | Baselined; `OPS-MONITORING-SCHEDULE-SWEEP-W{NEXT}` filed (count ≥ 2) |

---

## Cron safe-window (AC15)

| Fact | Value |
|---|---|
| `signal-1` `date -u` at R0 | `Mon 2026-08-03 07:51:12 UTC` |
| `aoe-1` `date -u` at R0 | `Mon 2026-08-03 07:55:45 UTC` |
| `venue-slo-tiers-drift-canary` next fire | **12:27 UTC today** |
| `monitoring-inventory-reconcile` | `signal-1` ran 06:57, `aoe-1` ran 07:17 — next fire tomorrow |
| Working window | **now → 11:57 UTC (~4h)**; exclusion band **11:57–14:27** |

All host writes are stamped with `ssh … date -u` immediately before and after.

---

## Pre-existing off-`:00` violations (R2 baseline, AC10)

Enumerated by the gate over all 31 declared schedules. **None fixed in this wave.**

| id | schedule | offset | owner |
|---|---|---|---|
| `recommendation-drift-canary` | `0 12 * * 2` | 0 min | `OPS-MONITORING-RECOMMENDATION-RESOLVER-AND-CANARY-W1` |
| `webhook-delivery-canary` | `13,28,43,58 * * * *` | 2 min (`:58`) | `WEBHOOK-HARDENING-W1` |
| `aoe-shadow-writer-stall-canary` | `13,18,…,58 * * * *` | 2 min (`:58`) | `OPS-AOE-MONITORING-PARITY-W1` |

The two `:58` rows breach because the law measures distance to the **nearest** `:00` in both
directions — which is precisely what makes `57` the canonical set's ceiling (`60 − 57 = 3`). A
forward-only reading would admit `:58` and `:59`, the two minutes the law most needs to exclude.

Eight further rows are **legal but off the canonical set** (`:9`, `:19`, `:29`, `:31`, `:39` ×3,
`:41`) — reported, never blocked, because blocking a compliant `:41` would get the gate disabled
inside a week.
