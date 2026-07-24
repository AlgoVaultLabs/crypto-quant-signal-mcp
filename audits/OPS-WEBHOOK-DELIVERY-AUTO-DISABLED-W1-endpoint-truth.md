# OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 — Endpoint-Truth (Plan-Mode Step 0)

**Wave:** OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 · Tier-2 Bulk-Spec · **Plan Mode**
**Target ICP:** T2 (prosumer webhook subscribers) · **INTERNAL/META infra-reliability** — no public copy, no version bump, no publish.
**Produced:** 2026-07-24 (C1, READ-ONLY forensic) · **Status: AWAITING ARCHITECT APPROVAL at CH1 gate.**
**Baseline:** canonical clone `~/code/crypto-quant-signal-mcp` @ `634abf6` == `origin/main` (verified; branch `main`, tree clean). Version 1.23.3 (package.json == server.json). The vault mirror is v1.10.6 and was NOT read.

**Wave Objective (same every chapter):** Replace the one-way `active=true→false` auto-disable with a failure-classified, self-healing subscription lifecycle: transient outage → back-off + auto-health-probe + **auto-resume**; permanent-dead → hard-disable (re-registration). Detect→**Recover**→Alert→Escalate; canary pages ONLY on terminal permanent-disable and **auto-resolves** on recovery. Behind `WEBHOOK_DELIVERY_ENABLED` + new `WEBHOOK_AUTO_RECOVERY_ENABLED` (two-flag firewall).

> **C1 is READ-ONLY.** Every query below is a `SELECT`; zero mutation was performed. Schema pre-apply (C2), classifier (C3), sweep (C4), canary (C5) do not begin until the architect approves this doc.

---

## §1 — system-map.md rows this wave mutates (read @ HEAD)

| # | Row (live line) | What C6 edits | Edge identity |
|---|---|---|---|
| 1 | `crypto-quant-signal-mcp` component cell — **system-map.md:248** ("**Hosted outbound webhook delivery service**" narrative: `webhook-delivery` worker "retry/backoff/auto-disable") | `webhook_subscriptions` gains lifecycle columns (additive); worker gains a health-probe/auto-resume sweep; auto-disable → failure-classified | Additive — no column removed, no edge identity changed |
| 2 | `algovault-monitoring` consumer cell — **system-map.md:258**, consumer **(6) `webhook-delivery-canary.py`** ("classes AUTO-DISABLED/DEAD-SPIKE/FAILED-RATE; CRITICAL_PERSISTENT after 3 breaches; off-:00 `:13,:28,:43,:58`; reads via `algovault_autopilot` SELECT-grant") | AUTO-DISABLED re-pointed to terminal `delivery_state='disabled'` (permanent) + auto-resolve/dedup | Consumer semantics only; new columns inherit existing table-level SELECT |
| 3 | Outbound-delivery edge — **system-map.md:231** (`signal-MCP PUSHES to ──── subscriber webhook URLs … dark behind WEBHOOK_DELIVERY_ENABLED`) | Annotate: delivery is now lifecycle-gated (quarantined paused; probe-driven resume) | Same producer→consumer identity; annotation only |

`Last touched:` line = **system-map.md:3** (overwrite in place in C6; NEVER prepend a log row — it is a map, not a log).

**system-map edges: rows (1)(2)(3) additive/annotation only — no NEW producer/consumer edge.** The health-probe sweep re-uses the existing signal-MCP→subscriber-URL edge (new event type on it, not a new edge); the canary already reads both webhook tables.

---

## §2 — Live forensic (READ-ONLY) — the diagnosis the operator asked for

**Host** `204.168.185.24` (`AlgoVault-MCP`); app ctr `crypto-quant-signal-mcp-mcp-server-1` (Up 4h); pg ctr `crypto-quant-signal-mcp-postgres-1` (postgres:16-alpine); DB `signal_performance`; `POSTGRES_USER=algovault`; `WEBHOOK_DELIVERY_ENABLED=true` (**service is LIVE, not dark**).

### The auto-disabled subscription (the alert's `disabled=1`)

| id | host | tier | active | consec_fail | owner_key | classification |
|----|------|------|--------|-------------|-----------|----------------|
| **6** | `pg28gb.tailfa7e2b.ts.net` (**Tailscale Funnel**) | `starter` | `false` | **21** | `av_live_25…` (**PAID**, `is_free_key=false`) | **Real paying customer** — NOT the operator's test endpoint |

- Timeline: created **2026-07-21T10:43Z**, delivered OK for **3.25h** (last success 2026-07-21T13:58Z), then the funnel's backing service went down → **~71.5h of continuous failure** → 21 consecutive → legacy `WEBHOOK_DISABLE_AFTER_FAILURES=20` tripped → **silent permanent death.**
- The only other sub (id 4, `algovault-bot.ngrok.pro`, starter, paid) is healthy: `consecutive_failures=0`, delivering.

### Failure spread — every observed failure is TRANSIENT

| status | response_code | n (48h) | n (all-time) | class (ratified default) |
|--------|---------------|---------|--------------|--------------------------|
| delivered | 200 | 100 | 1907 | — (2xx resets) |
| failed | **502** | 8 | 14 | **transient** (5xx — funnel up, backing service down) |
| failed | (null) | 0 | 9 | **transient** (network error / timeout — `lastCode=null`) |
| failed | 404 | 0 | 5 | **transient** (4xx≠410) |
| failed | 401 | 0 | 3 | **transient** (4xx≠410) |
| failed | 422 | 0 | 1 | **transient** (4xx≠410) |
| failed | 400 | 0 | 1 | **transient** (4xx≠410) |
| dead | (null) | 1 | 10 | mixed non-transition path (see §5) |

- **Concentration:** 100% of the 8 failed + 1 dead in 48h are on sub **6**; sub 4 has zero. → endpoint-specific, **not** a shared-network blip (rules out a false alarm).
- **No `410`, no TLS-cert error, no observed NXDOMAIN in live data** — the "permanent" rows in the classification table are anticipatory/defensive, not exercised by current traffic. The ONLY real failure mode in prod is the **transient 502** — exactly the case legacy logic turns into permanent death.

### H5 (measurement-artifact) — REJECTED

The alert (`window=24h dead=1 failed=9 total=74 disabled=1`, sustained 3/3 → `CRITICAL_PERSISTENT`) reproduces in durable DB state: my 24h snapshot = delivered 38 / failed 8 / dead 1 / disabled 1. The small drift (failed 9→8, total 74→47) is only the rolling-window advancing between fire-time and now. **The alert is correct.** It is not a sampling/cumulative-stat artifact — `active=false` is a durable boolean.

### The canary is ALREADY re-firing every cycle (validates C5's premise)

`/var/log/algovault-webhook-delivery-canary.log` shows `SUSTAINED: class=AUTO-DISABLED … | 87/3 cycles → firing wrapper` — the consecutive-breach counter has climbed **68 → 87 and is still rising**, firing the `send_telegram.sh` wrapper **every 15 min**. Only the wrapper's 24h cooldown suppresses Telegram spam. There is **no auto-resolve and no disabled-set dedup** — precisely the alarm-fatigue class C5 must retire.

### Grants + schema

- `algovault_autopilot` has **table-level SELECT** on both `webhook_subscriptions` and `webhook_deliveries` → **new columns inherit it, no grant change** (C5 confirmed). (The canary connects as `PG_ROLE=algovault_autopilot`.)
- `webhook_subscriptions` current = **17 columns**: `id, url, secret, events, assets, timeframes, min_confidence, tier, owner_key, active, consecutive_failures, created_at, last_delivered_at, cadence, timeframe, exchange, top_n`. Indexes: `pkey(id)`, `idx_webhook_subscriptions_active(active)` [enqueue hot-path], `idx_webhook_subscriptions_owner_key`. **All 7 spec-proposed columns are ABSENT → all need adding.**

---

## §3 — Code anchors (re-derived from origin/main) — `claim | reality | resolution`

| Spec claim | Reality @ `634abf6` | Resolution |
|---|---|---|
| `webhook-delivery.ts` `deliverOne`, `postWithTimeout`, retry loop | `deliverOne`@284, `postWithTimeout`@255, retry loop @373-397 | ✅ confirmed |
| `bumpFailureAndMaybeDisable` call site (single) | delivery.ts:**401** (only call site); def store.ts:**345** | ✅ single call site → replace with `recordFailureAndTransition` (C3) |
| terminal `delivered\|failed\|dead` marking | delivered@385, failed@400, dead@294/314/347 | ✅ confirmed |
| `setInterval` worker boot | `startDeliveryWorker` (delivery.ts:445, `setInterval`@448); booted in **index.ts:3427** behind `WEBHOOK_DELIVERY_ENABLED==='true'` (index.ts:3425) | ✅ confirmed — sweep folds here |
| store `consecutive_failures`, `active` filter, `pendingDeliveries`, `markDelivery`, `tryClaimDelivery` | col@97; enqueue gate `listActiveSubscriptions` `WHERE active=?`@246; `pendingDeliveries`@309; `markDelivery`@318; `tryClaimDelivery`@300 | ✅ confirmed. `active` gate feeds BOTH fan-out consumers (`webhook-events.ts:248`, `scan-digest-scheduler.ts:80`) → the projection cleanly pauses both |
| `WEBHOOK_DISABLE_AFTER_FAILURES` / `WEBHOOK_MAX_ATTEMPTS` env reads | in `webhook-delivery.ts` `loadDeliveryConfig`@205-211: `MAX_ATTEMPTS=5`, `DISABLE_AFTER_FAILURES=20`, `DELIVERY_TIMEOUT_MS=10000`, `BACKOFF_BASE_MS=1000` | ⚠️ read in **delivery.ts, not store.ts** (spec grep hint misdirected — see §4-#4) |
| `/test` sample-event builder | `webhook-api.ts:357` — **inline object literal** in the `POST /api/webhooks/:id/test` handler (`registerWebhookRoutes`@166) | ⚠️ not exported/reusable (see §4-#3) |
| `GET /api/webhooks` in `index.ts` | actually `webhook-api.ts:303` (routes registered unconditionally, index.ts:2687) | ⚠️ wrong file (see §4-#2) |
| SSRF `resolveAndAssertEgress` reuse | webhook-ssrf.ts:252; imported delivery.ts:22 | ✅ read-only reuse — but collapses DNS errors (see §4-#7) |
| test runner + flat layout | `package.json` `"test":"vitest run"`; `tests/webhook-*.test.ts` flat (9 specs) | ✅ confirmed |

---

## §4 — Factuality corrections (spec text vs live code) — architect attention

1. **CREATE TABLE DDL lives in `src/lib/performance-db.ts` `getBackend()`, NOT `webhooks-store.ts`** (store.ts:6-7 says so). → **C2's base DDL edit + idempotent migration belong in `performance-db.ts`**; `webhooks-store.ts` gets the new helper functions + column mappers. The Scope line "src/lib/webhooks-store.ts (add columns via idempotent migration)" must expand to include `performance-db.ts`.
2. **`GET /api/webhooks` is in `webhook-api.ts:303`**, not `index.ts`. **`webhook-api.ts` is absent from the System Taxonomy table** → returning `delivery_state` to the owner (C4/C6) requires a MAY-touch entry for `webhook-api.ts` (`GET /api/webhooks` additive field only).
3. **The `/test` sample-event builder is an inline literal (`webhook-api.ts:357`), not exported.** C4 "reuse the /test sample-event builder" ⇒ either (a) extract to an exported `buildSampleEvent()` (touches `webhook-api.ts`) or (b) build the probe event locally in the sweep. Recommend (a) for single-derivation.
4. **`WEBHOOK_DISABLE_AFTER_FAILURES` (default 20) is read in `delivery.ts loadDeliveryConfig`, not the store.** Minor; the Step-0-B grep hint pointed at the wrong file.
5. **`last_success_at` (new) overlaps existing `last_delivered_at`** (set on success, store.ts:368). See Q3.
6. **The retry-loop `catch` (delivery.ts:391-393) DISCARDS the network error** (`lastCode=null`). To classify TLS-cert / `ECONNREFUSED` / `ETIMEDOUT` (spec's permanent/transient split), C3/C4 MUST capture `err.cause?.code` — the current code throws it away. Non-trivial wiring the spec understates.
7. **The SSRF guard collapses ALL DNS failures into one error.** `resolveAndAssertEgress` (webhook-ssrf.ts:264-272) catches NXDOMAIN, `EAI_AGAIN`, and resolver blips and wraps every one as `EgressBlockedError('blocked_ip','host … did not resolve')` — indistinguishable from an internal-target block. Since webhook-ssrf.ts is **read-only** this wave, the classifier **cannot** tell transient `EAI_AGAIN` from permanent NXDOMAIN. ⇒ the spec's table row "`EAI_AGAIN` → transient" is **unreachable in the delivery/probe path**; the only feasible reading is the classifier's own `egressBlocked → permanent` input. See **Q1** (the lead question).
8. **Naming:** existing `DeliveryStatus` (per-delivery: `pending\|delivered\|failed\|dead`) is distinct from the new per-subscription `delivery_state` (`active\|degraded\|quarantined\|disabled`). Different tables/columns — keep the names but document to avoid confusion.

---

## §5 — Failure-classification table (ratified default, reconciled to §2 observed statuses)

Classifier `classifyDeliveryFailure({httpStatus?, errorCode?, egressBlocked?}) → 'transient'|'permanent'` — the ONE shared leaf (no store/HTTP imports).

| Input | Class | Observed in prod? | Lifecycle |
|---|---|---|---|
| `egressBlocked === true` (any `EgressBlockedError`: internal-target, NXDOMAIN, non-resolving) | **permanent** | the 10 all-time `dead` rows are a mix incl. this | → `disabled` immediately, `disabled_reason` per §7 |
| `httpStatus === 410` | **permanent** | no | → `disabled` |
| `errorCode ∈ {DEPTH_ZERO_SELF_SIGNED_CERT, ERR_TLS_CERT_ALTNAME_INVALID, CERT_*}` | **permanent** | no | → `disabled` |
| `httpStatus` 5xx (incl **502**), 408, 429 | **transient** | **502 ×14** (the incident) | → degraded→quarantine→probe |
| `httpStatus` any other 4xx **except 410** (404/403/401/422/400) | **transient** | 404/401/422/400 | → degraded→quarantine→probe |
| `errorCode ∈ {ETIMEDOUT, ECONNRESET, ECONNREFUSED, EAI_AGAIN, socket-hangup}` (network `lastCode=null`) | **transient** | failed/null ×9 | → degraded→quarantine→probe |

**Non-transition `dead` paths (stay as-is, do NOT transition the subscription):** sub inactive/gone (delivery.ts:294) and corrupt `event_data` (delivery.ts:347) — these are not endpoint-health signals. Only the **egress-block dead** path (delivery.ts:314) gets wired to a permanent transition (C3).

**Every real observed failure maps to a class (no `undefined`).** The dominant real failure (502) is transient → the wave directly heals the incident.

---

## §6 — Thresholds (env, defaults — ratify)

| Env | Default | Role | Existing? |
|---|---|---|---|
| `WEBHOOK_DELIVERY_ENABLED` | (set `true` in prod) | master flag (service live) | existing |
| `WEBHOOK_AUTO_RECOVERY_ENABLED` | **ON when DELIVERY_ENABLED=true** | new behavior gate; OFF = legacy terminal-disable | **NEW** |
| `WEBHOOK_QUARANTINE_AFTER_FAILURES` | **10** | consecutive transient → `quarantined` (safe-lower than legacy 20; quarantine ≠ death) | **NEW** |
| `WEBHOOK_PROBE_BACKOFF_BASE_SEC` | **300** | first `next_probe_at = now+base` | **NEW** |
| `WEBHOOK_PROBE_BACKOFF_MAX_SEC` | **86400** | `min(base·2^n, max)` cap | **NEW** |
| `WEBHOOK_QUARANTINE_MAX_SEC` | **604800** (7d) | no-recovery → `disabled` (`quarantine_expired`) | **NEW** |
| `WEBHOOK_MAX_ATTEMPTS` | 5 | in-call retry budget | existing |
| `WEBHOOK_DISABLE_AFTER_FAILURES` | 20 | **legacy-only** (governs when AUTO_RECOVERY=OFF) | existing |
| `WEBHOOK_DELIVERY_TIMEOUT_MS` | 10000 | probe + delivery timeout | existing |
| `WEBHOOK_WORKER_INTERVAL_MS` | 15000 | worker tick (sweep reuses) | existing |

**Live-on-deploy note:** because `WEBHOOK_DELIVERY_ENABLED=true` already and `WEBHOOK_AUTO_RECOVERY_ENABLED` defaults ON, **auto-recovery activates the moment C4 deploys** — no env change needed to turn it on. **Rollback requires SETTING `WEBHOOK_AUTO_RECOVERY_ENABLED=false` in the container env** (not currently present) → note the rollback lever in status.md + deploy env.

---

## §7 — Identifier diff (Requirements ↔ Acceptance) + proposed value sets

- **Env vars, state strings, columns, container/host/DB/role identifiers: internally CONSISTENT across the spec's Requirements and AC sections** (no email/port/hostname/slug/version mismatch). The only drifts are spec-text-vs-live-code (§4), not spec-internal.
- `delivery_state ∈ {active, degraded, quarantined, disabled}`; `active := delivery_state IN ('active','degraded')` (projected, same write; enqueue `WHERE active` byte-unchanged).
- `failure_class ∈ {transient, permanent}` (classifier output; nullable until first failure).
- **`disabled_reason` proposed value set (ratify granularity — Q4):** `legacy_auto_disable` (backfill) · `quarantine_expired` (7d) · `permanent_egress` · `permanent_http_410` · `permanent_tls_cert`. (Alternative: a single `permanent`.) C5 pages on `disabled` EXCLUDING `legacy_auto_disable`.
- Probe header `X-AlgoVault-Event: health_probe` (new; `buildHeaders` gains an event-type param or the sweep post-sets it).

---

## §8 — Build/deploy scope confirmation

- **No Dockerfile / `deploy.yml` change.** The sweep is in-process (folds into `startDeliveryWorker`'s existing `setInterval`); all app code stays in `src/` → `dist/` via `tsc`. Confirmed no new file outside `src/`.
- **Canary is host-side.** Repo SoT `ops/monitoring/webhook-delivery-canary.py` IS covered by `deploy.yml paths-ignore: 'ops/monitoring/**'` → **a commit does NOT auto-deploy it.** C5 must (a) edit the repo copy (committed, no rebuild) **and** (b) SSH-install to `/opt/algovault-monitoring/webhook-delivery-canary.py`. `--self-test` does **not** exist (entrypoint canary:177 has no argparse) → **C5 adds it**, driving the existing `WEBHOOK_CANARY_FORCE_{DEAD,FAILED,TOTAL,DISABLED}` + `DRY_RUN_TG=1` seams.
- **Dual-backend migration (C2):** PG `information_schema.columns` pre-check + `ADD COLUMN IF NOT EXISTS`; SQLite `PRAGMA table_info` + `_ensure_column` (SQLite has NO `ADD COLUMN IF NOT EXISTS`). **Pre-apply the 7 columns to Hetzner PG via SSH BEFORE the C2 commit** (schema-as-code then no-ops against the prepared DB). Suggest an additive index `(delivery_state, next_probe_at)` for `getQuarantinedDue` (small set; keeps the sweep cheap).
- **Data Integrity:** payload is allow-listed by shape (`WebhookEventData` discriminated union) → forbidden keys (`outcome_return_pct`/`pfe_*`/`mae_*`/…) structurally impossible; C6 pairs a positive-assertion `git grep` canary. Webhook tables are internal (not public-facing). No onchain.
- **Worktree:** C2–C6 (post-approval) run in a fresh worktree branched off `origin/main` (per LAW; nested worktrees `venue-go-live-15`, `readme-pct-suffix` already on disk — scans anchored to avoid them).

---

## §9 — Skills governing later chapters (applied at execution)

- C2 pre-apply: `pre-apply-schema-before-push-when-push-autodeploys`, `sqlite-insert-col-count-mismatch-post-migration`, `host-bash-query-containerized-postgres-via-psql-not-docker-node-e`.
- C3/C4 classifier + single-derivation: `single-derivation-across-rendered-surfaces-not-just-functions`, `external-api-classification-3-tier-fallback`, `throw-loud-not-silent-stale-fallback-on-shape-mismatch`.
- C4 auto-recovery loop: `fail-open-gate-classify-recover-and-read-back-the-ledger`, `attempt-heartbeat-liveness-vs-market-confounded-output-recency`.
- C5 canary: `cadence-bucket-marker-advances-on-skip-not-only-success`, `constant-alert-count-loop-cadence-fingerprint`, `self-watch alerts fire on DENIAL not by-design waits` (CLAUDE.md).
- Cross-cutting: `prompt-factuality-preflight` (this doc), `verify-consumer-liveness-before-producer-removal-or-demotion`.

---

## §10 — Architect-confirm questions (HALT — answer to unblock C2)

Plain framing outside the block; the copy-paste Q-set for Mr.1 → Cowork is the single fenced block:

```
OPS-WEBHOOK-DELIVERY-AUTO-DISABLED-W1 — CH1 architect-confirm (5 Qs)

Q1 [SSRF/DNS collapse — LEAD]. resolveAndAssertEgress (webhook-ssrf.ts:264-272)
   wraps EVERY DNS failure (NXDOMAIN, EAI_AGAIN, resolver blip) AND internal-target
   blocks into ONE EgressBlockedError; webhook-ssrf.ts is read-only this wave. So the
   classifier cannot split transient EAI_AGAIN from permanent NXDOMAIN. Ratify option:
   (a) egressBlocked => PERMANENT (disabled) — simplest, matches the classifier's own
       egressBlocked input; risk: a transient resolver blip during the terminal path
       (after 5 retries) or a probe => permanent disable (re-registration). RECOMMENDED
       for this wave; defer errno-preservation to OPS-WEBHOOK-SSRF-IP-PIN-W1.
   (b) carve a bounded exception to the read-only rule so resolveAndAssertEgress
       preserves the original DNS errno, letting the classifier split them.
   Pick (a) or (b)?

Q2 [Backfill of the ONE live victim — highest customer impact]. The disabled sub (id 6)
   is a PAID starter customer whose Tailscale-funnel endpoint returned transient 502s for
   ~72h (not permanently gone). Spec C2 backfills active=false => disabled/legacy_auto_disable
   (customer must re-register). RECOMMENDED instead: backfill legacy active=false =>
   'quarantined', disabled_reason='legacy_auto_disable', next_probe_at=now, so C4's first
   sweep re-adjudicates via a LIVE probe (2xx => auto-resume the paying customer with zero
   re-registration; permanent => falls to disabled; still-transient => backoff). This is the
   automation-first outcome and directly serves the affected customer. Approve quarantine-seed,
   or keep spec's disabled-seed?

Q3 [last_success_at vs last_delivered_at]. last_delivered_at already exists (stamped on real
   delivery, store.ts:368). Options: (a) probe-success stamps NEW last_success_at, real delivery
   stamps BOTH (probe != delivery, cleaner forensics); (b) reuse last_delivered_at for probe
   success too, no new column. Pick (a) or (b)?

Q4 [disabled_reason granularity]. Ratify the value set: legacy_auto_disable | quarantine_expired |
   permanent_egress | permanent_http_410 | permanent_tls_cert  — OR collapse the 3 permanent_*
   into a single 'permanent'. Granular or single?

Q5 [Scope expansion — factuality]. webhook-api.ts (owner GET /api/webhooks route + the /test
   sample-event builder) and performance-db.ts (the CREATE TABLE DDL) are NOT in the System
   Taxonomy but MUST be touched (add delivery_state to the owner response; add the 7 columns +
   migration; export a reusable sample-event builder). Approve adding webhook-api.ts (additive
   owner field + export only) and performance-db.ts (DDL + idempotent migration) as MAY-touch?

Also acknowledge (no answer needed): auto-recovery is LIVE-ON-DEPLOY (default-on under the
already-true WEBHOOK_DELIVERY_ENABLED); rollback = set WEBHOOK_AUTO_RECOVERY_ENABLED=false in
the container env. HALT-branch (operator-test + permanently-gone) does NOT apply — sub 6 is a
paying customer with transient failures.
```

---

## §10b — CH1 Ratifications (Mr.1, 2026-07-24) — folded into C2+

- **Q1 → `egressBlocked ⇒ TRANSIENT`** (NOT permanent). Quarantine + probe; 7d no-heal → `disabled(quarantine_expired)`. `webhook-ssrf.ts` stays read-only; the per-DELIVERY row still marks `dead` (0 quota/0 retries), only the per-SUBSCRIPTION class is transient. errno-split deferred → `OPS-WEBHOOK-SSRF-ERRNO-W1`.
- **Q2 → quarantine-seed, GENERALIZED.** Backfill ALL legacy `active=false` → `quarantined`, `failure_class='legacy'`, `quarantined_at=now`, `next_probe_at=now` (NOT `disabled`). ✅ applied live in C2 (Sub 6 converted).
- **Q3 → NEW `last_success_at`.** Probe stamps it only; a real delivery stamps BOTH.
- **Q4 → `disabled_reason ∈ {permanent_http_410, quarantine_expired}`** only. **HTTP 410 is the SOLE instant hard-disable.** Granular cause → `failure_class ∈ {http_410|http_5xx|http_4xx|timeout|conn|egress_block|tls|other|legacy}`.
- **Q5 → APPROVED** `webhook-api.ts` (export `/test` builder + owner `delivery_state`) + `performance-db.ts` (migration where the DDL lives) as MAY-touch, additive-only. No new system-map edge.

**Net model:** ONE permanent class (`http_410`); everything else self-heals through quarantine+probe. Classifier returns the granular `failure_class`; terminality = `failure_class === 'http_410'`.

---

## §11 — CH1 gate

- endpoint-truth doc produced (this file) — **written, uncommitted, pending architect approval** (Plan-Mode commit-touching architect-confirm; will commit on approval, in the wave worktree).
- Classification table (§5) + thresholds (§6) + identifier diff (§7) + system-map rows (§1) enumerated.
- **BLOCKED on Q1–Q5.** On approval → commit this doc → C2 (SSH pre-apply schema + store helpers) → `CH2_GREEN` … sequential to C6. `CH1_GREEN` withheld until architect answers.
