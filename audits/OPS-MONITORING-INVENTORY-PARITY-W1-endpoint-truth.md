# OPS-MONITORING-INVENTORY-PARITY-W1 — R1 endpoint-truth

**Requirement:** R1 (Plan-Mode artifact). **Status:** 🛑 **STOP — awaiting architect ratification of
the CLASSIFICATION before R2** (spec: *"R1 output must include a proposed inventory table … so the
architect ratifies the classification, not just the count"*).

**Probed:** 2026-07-28 09:44Z live, read-only. **Zero mutations** — no `scp`, no `crontab -e`, no
host file edits, no service restart. Every command was `find`/`sha256sum`/`crontab -l`/
`systemctl list-timers`/`grep`/`git show`/`ls`.

**Base:** `origin/main` `0096cb9`. **Worktree:** `ops/monitoring-inventory-parity-w1`.
**Clock:** box `date -u` cross-checked against Mac + Cloudflare `Date:` earlier this session — no skew.

---

## 0. Headline — the finding the spec did not anticipate

`send_telegram.sh` — the shared alert wrapper CLAUDE.md forbids consumers from re-implementing —
is **unversioned on both hosts, and the two copies have already diverged**:

| Host | sha256 | size |
|---|---|---|
| `204.168.185.24` | `b122a5eb5ff4e2d6bfaff652835b4f7bf8a03c3267e97b9cb90b262edf30299` | 7144 B |
| `178.104.200.44` | `938d6b6f7104a8c1802c506d11c4cabefb0d9e392d13743a487530cc305169c5` | — |

No diff, no history, no owner, on the single most load-bearing file in the alerting layer. This
makes the schema's `host` field load-bearing on day one rather than speculative.

**Scale correction:** the spec anticipated **2** orphans. Reality is **18**, of which **6 are
actively cron-scheduled**.

---

## 1. Probe table — `claim | reality | resolution`

| # | Claim | Reality (live 2026-07-28 09:44Z) | Resolution |
|---|---|---|---|
| P1 | Enumerate host artifacts | **27** files under `/opt/algovault-monitoring/` (`*.py`/`*.sh`/`*.mjs`/`*.yaml`/`*.json`), excluding `backups/`, `.alert-state/`, `.drift-canary-state/`, `.registry-schema-cache/`, `.venv*`, `*.bak*`, `*.disabled-*`. Full sha256 set captured | §2 |
| P2 | Live root crontab | Captured verbatim. **12** lines invoke `/opt/algovault-monitoring/*` directly; 3 more monitoring-class lines run from the repo checkout | §4 |
| P3 | systemd units/timers | 4 relevant: `algovault-funnel-leak-detector.timer` (drives `funnel-leak-detector.py`), `algovault-funnel-snapshot.timer`, `editorial-override-currency-canary.timer`, `docker-builder-gc.timer`. No transient `systemd-run` gate armed now | Feeds `invoked_by` |
| P4 | Committed set | **16** — 10 `ops/monitoring/` + 6 `ops/cron/`. (`ops/scripts/disk-forensics.sh`, added on `0096cb9` after the probe, is a manual read-only tool: not installed, not scheduled → out of scope) | §2 |
| P5 | ORPHAN set | 🛑 **18** — see §2.1 | **Q1** |
| P6 | DARK set | 🛑 **2 CONFIRMED** (`nav-drift-canary.sh`, `analytics-drift-canary.sh`) + 1 candidate (`book-liveness-canary.py`). 3 further set-difference hits correctly re-classified as retired/manual | **Q2, Q3** |
| P7 | HASH-DRIFT set | 🛑 **1** — `shadow-cpu-gate-48h.sh` | **Q4** |
| P8 | Secret scan | ✅ **CLEAN — 0 assignment-shaped secret literals** across all 18 orphans | §3 |
| P9 | Free off-`:00` slot | 🛑 Spec default `43 6` is **OCCUPIED**. Free in hour 06 = `{:09, :39, :57}`; only `:57` is in the CLAUDE.md preferred set | **Q5** |
| P10 | LIVE `paths-ignore` | `ops/monitoring/**` **ignored** ✅. List **changed today** — now also `ops/scripts/**`. `ops/cron/**` NOT ignored; `audits/**` NOT ignored and `Dockerfile:13` COPYs it | **Q6** |
| P11 | True consumer count vs the `system-map.md:271` "12" | 12 direct `/opt/algovault-monitoring/*` cron lines + 3 repo-resident = **15** monitoring-class scheduled entries. The map's "12 consumers (11 live + 1 pending)" is numerically coincidental but wrong in composition, and self-declares stale | R6 |
| P12 | Does `178` have the same gap? | 🛑 **YES** — `aoe-shadow-writer-stall-canary.py` + its manifest on a live 5-min cron (`13,18,…,58`), plus a second `send_telegram.sh`. None in any repo | `OPS-AOE-MONITORING-INVENTORY-W{NEXT}` |

---

## 2. Reconciliation sets

### 2.1 🛑 ORPHAN — on host, no repo ancestor: **18**

| # | Artifact | Size | Invocation | Proposed class |
|---|---|---|---|---|
| 1 | `send_telegram.sh` | 7.1 K | called-by: every consumer | **load-bearing** (diverged across hosts) |
| 2 | `website-drift-canary.py` | 84 K | `57 0 * * *` | load-bearing |
| 3 | `website-drift-manifest.yaml` | 26 K | config for #2 | load-bearing |
| 4 | `postgres-cpu-snapshot.sh` | 5.6 K | `47 */6 * * *` | load-bearing |
| 5 | `recommendation-drift-canary.py` | 8.6 K | `0 12 * * 2` | load-bearing |
| 6 | `recommendation-drift-manifest.yaml` | 2.1 K | config for #5 | load-bearing |
| 7 | `registry-conformance-canary.py` | 15 K | `23 * * * *` | load-bearing |
| 8 | `llm-spend-monitor.py` | 7.3 K | `23 12 * * 4` | load-bearing |
| 9 | `stripe-webhook-events-canary.sh` | 1.6 K | `19 8 1 * *` | load-bearing |
| 10 | `check-stripe-webhook-events.mjs` | 4.3 K | called-by #9 | advisory |
| 11 | `postgres-cpu-autopilot.py` | 19 K | autopilot flow | load-bearing |
| 12 | `postgres-cpu-autopilot-registry.yaml` | 1.9 K | config for #11 | load-bearing |
| 13 | `funnel-leak-detector.py` | 21 K | `systemd:algovault-funnel-leak-detector.timer` | load-bearing |
| 14 | `seed-orchestrator-gate-48h.sh` | 7.5 K | transient `systemd-run` one-shot | advisory |
| 15 | `OPS-SEED-ORCHESTRATOR-W1-baseline.json` | 1.6 K | data baseline for #14 | data |
| 16 | `book-liveness-canary.py` | 8.7 K | **none found** | ⚠️ see **Q2** |
| 17 | `test-website-drift-canary.py` | 26 K | manual | test |
| 18 | `test-registry-conformance-canary.py` | 7.8 K | manual | test |

**6 of these are actively cron-scheduled** (#2, #4, #5, #7, #8, #9) — i.e. six live alarms whose
source has no review history and cannot be reverted.

### 2.2 🛑 HASH-DRIFT — both sides, content differs: **1**

| Artifact | Host sha256 | Repo sha256 |
|---|---|---|
| `shadow-cpu-gate-48h.sh` | `9ff89f1087c4fbd6a86adee076872db937a4398fbe3a16cef183aa6d36ef4938` (20 lines) | `5a1346c52db7294eb58731ed51a7dc20f751430642c85b293e3383f36b572f8e` |

**The committed copy is not what runs.** Previously undetectable. → **Q4**

### 2.3 🛑 DARK — committed guard, nothing invokes it: **2 CONFIRMED**

| Artifact | `/opt/algovault-monitoring/` | repo checkout on host | crontab lines |
|---|---|---|---|
| `nav-drift-canary.sh` | ABSENT | PRESENT | **0** |
| `analytics-drift-canary.sh` | ABSENT | PRESENT | **0** |

Both spec-named cases **confirmed, not refuted**. The code is on the box (the deploy git-pulls it)
and nothing ever runs it. `docs-drift-canary.sh` had the identical status and already consumed one
remediation wave — this failure mode has recurred and been paid for once. → **Q3**

*Honest scoping:* both are **secondary** guards. The primary gate for each is a CI `--check`
(`build_nav --check` / `build_analytics --check`) that does run in `deploy.yml`. The uncovered path
is host-side manual HTML edits only — a real hole, but narrower than "unguarded".

### 2.4 ✅ Correctly classified — set-difference alone would mis-flag these

| Artifact | Truth | Evidence |
|---|---|---|
| `equity-launch-readiness.sh`, `equity-verdict-watch.sh` | **RETIRED**, not dark | on host as `*.disabled-equity-retire-20260716T040525Z` + `crontab.bak.equity-retire-…` |
| `seed-promoted-ramp.sh` | **manual** | operator-run venue ramp; 0 crontab lines; referenced by `seed-coverage-canary.sh` |
| `seed-coverage-canary.sh`, `snapshot-landing-daily.sh` | **installed, second install model** | run from `/opt/crypto-quant-signal-mcp/ops/cron/`, never copied to `/opt/algovault-monitoring/` |

**Schema consequence:** `host_path` must express **two install models** — scp-installed
(`/opt/algovault-monitoring/X`) and repo-resident (`/opt/crypto-quant-signal-mcp/ops/cron/X`).
`HASH_DRIFT` is **vacuous for repo-resident rows** (they *are* the repo copy) and must be skipped
for them, not silently passed.

### 2.5 ✅ IN-SYNC both sides: **8**

`directional-label-freshness.py` · `test-directional-label-freshness.py` ·
`tier-misclassification-canary.sh` · `venue-slo-tiers-drift-canary.sh` · `venue-slo-tiers.json` ·
`webhook-delivery-canary.py` · `x402-bazaar-canary.py` · `docs-drift-canary.sh` *(committed under
`ops/cron/`, installed to `/opt/algovault-monitoring/` — hash matches)*

---

## 3. P8 — secret scan detail (gates R3)

Structural scan, **by shape not by vendor prefix** (CLAUDE.md): any `LABEL[:=] <≥16-char literal>`
where LABEL matches `TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL|CHAT_ID|DSN|CONN_STR`,
excluding env-indirection forms (`os.environ`, `getenv`, `process.env`, `${VAR}`) and placeholders.

- **Result: 0 hits across all 18 orphans.** ✅
- `send_telegram.sh:127` sources `/etc/algovault-monitoring/env`; the token is only ever
  `${TELEGRAM_BOT_TOKEN}` at the call site (`:152`). Correct pattern.
- 3 files reference a credential **path** (`llm-spend-monitor.py`, `postgres-cpu-autopilot.py`,
  `send_telegram.sh`) — a path is not a secret, and referencing it is the desired indirection.
- High-entropy sweep hits are wave-IDs / alert-IDs (`OPS-DRIFT-CANARY-MONOTONIC-DETECTOR-W1`,
  `WEBSITE_DRIFT_MANIFEST_CONFIG_VIOLATION`), not credentials.
- ⛔ `autopilot-pg-creds` (mode `600`, no extension) is **outside** the artifact set by construction
  and must never enter the repo. The R4 ORPHAN scan must exclude it explicitly so it is never even
  proposed.

---

## 4. P9 — cron slot arithmetic

Hour-06 occupancy computed by expanding every crontab field (step/range/list), not by eye:

- **`:43` is OCCUPIED** — the funding-stats matview refresh `3-58/5` lands on `:43`.
- **Free minutes in hour 06: `{9, 39, 57}`** — the crontab is densely tiled by every-N-minute jobs
  whose residues cover nearly every slot (the same three that were free in hour 00).
- Of CLAUDE.md's preferred off-`:00` set `{13,17,23,27,33,37,43,47,53,57}`, only **`:57`** is free.

→ **Proposed: `57 6 * * *`** — free, off-`:00`, in the preferred set, and 6 h clear of the 00:57
website-drift canary. → **Q5**

---

## 5. P10 — deploy consequences (bears on AC8)

Live `paths-ignore` on `0096cb9`:

```
activation-funnel/snapshots/**   activation-funnel/README.md   ops/systemd/**
ops/monitoring/**                ops/scripts/**                LICENSE
glama.json                       Caddyfile
```

| Path | Ignored? | Consequence for this wave |
|---|---|---|
| `ops/monitoring/**` | ✅ yes | R3 + R4 artifact commits → **no rebuild, no restart** (the spec's premise holds) |
| `ops/cron/**` | ❌ no | only relevant if a `ops/cron/` file is touched |
| `audits/**` | ❌ no, and `Dockerfile:13` COPYs it | **committing this endpoint-truth REBUILDS + restarts prod** → **Q6** |
| `CLAUDE.md`, `status.md`, `system-map.md` | n/a | vault files, outside the repo → never deploy |

⚠️ The list **changed during this session** (`ops/scripts/**` added by `0096cb9` at ~09:4x). Grep it
live at execution time; do not inherit this table.

---

## 6. Proposed inventory table (for ratification — R2 input)

One row per artifact, 100 % of the P1 host set + the repo-only rows. `criticality`/`install_state`
are the classifications being ratified.

| id | host_path | criticality | schedule | invoked_by | install_state |
|---|---|---|---|---|---|
| `monitoring-inventory-reconcile` | `/opt/algovault-monitoring/monitoring-inventory-reconcile.py` | load-bearing | `57 6 * * *` | `crontab:root` | installed *(R5)* |
| `send-telegram-wrapper` | `…/send_telegram.sh` | load-bearing | null | `called-by:*` | installed |
| `website-drift-canary` | `…/website-drift-canary.py` | load-bearing | `57 0 * * *` | `crontab:root` | installed |
| `website-drift-manifest` | `…/website-drift-manifest.yaml` | load-bearing | null | `called-by:website-drift-canary` | installed |
| `postgres-cpu-snapshot` | `…/postgres-cpu-snapshot.sh` | load-bearing | `47 */6 * * *` | `crontab:root` | installed |
| `postgres-cpu-autopilot` | `…/postgres-cpu-autopilot.py` | load-bearing | null | `called-by:postgres-cpu-snapshot` | installed |
| `postgres-cpu-autopilot-registry` | `…/postgres-cpu-autopilot-registry.yaml` | load-bearing | null | `called-by:postgres-cpu-autopilot` | installed |
| `recommendation-drift-canary` | `…/recommendation-drift-canary.py` | load-bearing | `0 12 * * 2` | `crontab:root` | installed |
| `recommendation-drift-manifest` | `…/recommendation-drift-manifest.yaml` | load-bearing | null | `called-by:recommendation-drift-canary` | installed |
| `registry-conformance-canary` | `…/registry-conformance-canary.py` | load-bearing | `23 * * * *` | `crontab:root` | installed |
| `llm-spend-monitor` | `…/llm-spend-monitor.py` | load-bearing | `23 12 * * 4` | `crontab:root` | installed |
| `stripe-webhook-events-canary` | `…/stripe-webhook-events-canary.sh` | load-bearing | `19 8 1 * *` | `crontab:root` | installed |
| `check-stripe-webhook-events` | `…/check-stripe-webhook-events.mjs` | advisory | null | `called-by:stripe-webhook-events-canary` | installed |
| `funnel-leak-detector` | `…/funnel-leak-detector.py` | load-bearing | null | `systemd:algovault-funnel-leak-detector.timer` | installed |
| `webhook-delivery-canary` | `…/webhook-delivery-canary.py` | load-bearing | `13,28,43,58 * * * *` | `crontab:root` | installed |
| `directional-label-freshness` | `…/directional-label-freshness.py` | load-bearing | `41 6 * * *` | `crontab:root` | installed |
| `tier-misclassification-canary` | `…/tier-misclassification-canary.sh` | advisory | `23 13 * * 1` | `crontab:root` | installed |
| `venue-slo-tiers-drift-canary` | `…/venue-slo-tiers-drift-canary.sh` | advisory | `0 12 * * 1` | `crontab:root` | installed |
| `venue-slo-tiers` | `…/venue-slo-tiers.json` | advisory | null | `called-by:venue-slo-tiers-drift-canary` | installed |
| `x402-bazaar-canary` | `…/x402-bazaar-canary.py` | advisory | `17 12 * * 3` | `crontab:root` | installed |
| `docs-drift-canary` | `…/docs-drift-canary.sh` | advisory | `29 6 * * 1` | `crontab:root` | installed |
| `seed-orchestrator-gate-48h` | `…/seed-orchestrator-gate-48h.sh` | advisory | null | `manual` (transient `systemd-run`) | installed |
| `seed-orchestrator-baseline` | `…/OPS-SEED-ORCHESTRATOR-W1-baseline.json` | advisory | null | `called-by:seed-orchestrator-gate-48h` | installed |
| `shadow-cpu-gate-48h` | `…/shadow-cpu-gate-48h.sh` | advisory | null | `manual` | installed ⚠️ **hash-drift** |
| `book-liveness-canary` | `…/book-liveness-canary.py` | advisory | null | **unknown** | ⚠️ **Q2** |
| `test-website-drift-canary` | `…/test-website-drift-canary.py` | advisory | null | `manual` | installed (test) |
| `test-registry-conformance-canary` | `…/test-registry-conformance-canary.py` | advisory | null | `manual` | installed (test) |
| `test-directional-label-freshness` | `…/test-directional-label-freshness.py` | advisory | null | `manual` | installed (test) |
| `seed-coverage-canary` | `/opt/crypto-quant-signal-mcp/ops/cron/seed-coverage-canary.sh` | load-bearing | `37 * * * *` | `crontab:root` | installed (repo-resident) |
| `snapshot-landing-daily` | `/opt/crypto-quant-signal-mcp/ops/cron/snapshot-landing-daily.sh` | load-bearing | `39 0 * * *` | `crontab:root` | installed (repo-resident) |
| `seed-promoted-ramp` | `/opt/crypto-quant-signal-mcp/ops/cron/seed-promoted-ramp.sh` | advisory | null | `manual` | installed (repo-resident) |
| `nav-drift-canary` | *(not installed)* | advisory | `— ` | `crontab:root` *(intended)* | 🛑 **DARK → Q3** |
| `analytics-drift-canary` | *(not installed)* | advisory | `— ` | `crontab:root` *(intended)* | 🛑 **DARK → Q3** |
| `equity-launch-readiness` | `…/equity-launch-readiness.sh.disabled-…` | advisory | null | `manual` | **retired** 2026-07-16 |
| `equity-verdict-watch` | `…/equity-verdict-watch.sh.disabled-…` | advisory | null | `manual` | **retired** 2026-07-16 |

---

## 7. 🛑 STOP — architect ratification required before R2

Six decisions change what gets committed or installed. The Q-block is reproduced verbatim in the
session reply for copy-paste to Cowork; summary:

| Q | Decision |
|---|---|
| **Q1** | Commit all **18** orphans (not the 2 the spec expected), incl. `send_telegram.sh`, the 2 host tests, 3 config yamls, 1 data baseline? |
| **Q2** | `book-liveness-canary.py` — retired / manual / third dark guard? (has fired once: `.alert-state/book_liveness_ceiling-last-fired-at`, 2026-07-21) |
| **Q3** | The 2 confirmed DARK canaries — install now, or `pending` + 30 d clock + named deferral wave? |
| **Q4** | `shadow-cpu-gate-48h.sh` hash-drift — adopt the HOST copy as baseline, or reconcile in-wave? |
| **Q5** | Reconciler slot `57 6 * * *` (spec's `43 6` is occupied)? |
| **Q6** | This audit's own commit rebuilds prod (`audits/**` not ignored + `Dockerfile:13`) — proceed and verify version/RestartCount unchanged, or hold it to land with R7? |

**No R2–R7 work has been started. Nothing has been written to the host. This file is the only
artifact, and it is committed locally but deliberately NOT pushed** (pushing rebuilds prod — Q6).
