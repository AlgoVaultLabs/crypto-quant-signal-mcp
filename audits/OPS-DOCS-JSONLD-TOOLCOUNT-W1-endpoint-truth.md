# OPS-DOCS-JSONLD-TOOLCOUNT-W1 — R3 endpoint-truth.md (Plan-Mode, host cron install)

**Probed:** 2026-07-14 · host `204.168.185.24` via `ssh -i ~/.ssh/algovault_deploy` (READ-ONLY probes; the crontab/script write WAITS for approval).
**Format:** `claim | reality | resolution`. R1+R2 already shipped + live (JSON-LD now derives "6 tools"). This artifact gates the R3 SSH cron install only.

| # | Probe | Reality (probed) | Resolution |
|---|---|---|---|
| 1 | Idempotency — already installed? | `crontab -l \| grep -c docs-drift-canary` = **0**; `/opt/algovault-monitoring/docs-drift-canary.sh` **absent** | Fresh install. Idempotent = **check-before-add** (grep the crontab; append only if absent) + `install -m755` the script (overwrite-safe). |
| 2 | `send_telegram.sh` path | `-rwxr-xr-x root 5327 /opt/algovault-monitoring/send_telegram.sh` **present + executable** | The canary's `SEND` default (`/opt/algovault-monitoring/send_telegram.sh`) matches — no override needed. |
| 3 | Host-vs-container runtime | `bash curl dig node` all at `/usr/bin/`. The committed `docs-drift-canary.sh` is **bash + curl + dig + send_telegram.sh** — it does a **LIVE FETCH** of `https://algovault.com/docs.html` (NOT `build_docs --check`; docs.html is Caddy-static + absent from the app image). | Runs **HOST-SIDE** (no `docker exec`). All deps present. |
| 4 | Safe off-`:00` slot (no collision) | Per-hour canaries occupy `:13,:28,:43,:58` (webhook-delivery), `:37` (seed-coverage), `:17` (oi-sampler), `:47` (postgres-cpu `*/6`), plus dense seed spreads. Monday-specific: `00:00`, `05:37`, `08:00`, `12:00`, `13:17/13:23`. **The script's suggested `43 6 * * 1` COLLIDES with webhook-delivery (`:43`); nav-drift's `37 6` collides with seed-coverage (`:37`).** Minute **`:29`** is free of every per-hour job AND has no Mon-06:xx job (nearest: `05:37`, `06:05` venue-readiness, `06:47` postgres-cpu). | **`29 6 * * 1`** (Mon 06:29 UTC) — off-`:00`, weekly, zero collision. Overrides the committed `43 6 * * 1` suggestion; I'll update the script's comment. |
| 5 | Consumer count | 2 crontab lines literally mention `send_telegram`; the real consumers call it INTERNALLY (website-drift, recommendation-drift, x402-bazaar, postgres-cpu-autopilot, webhook-delivery, tier-misclass, stripe-webhook, llm-spend, equity-verdict-watch, funnel-leak, …). docs-drift = a NEW consumer. | "13th consumer" is the wave's tracking label (nav-drift = 12th, also install-pending); the ordinal is not load-bearing for `send_telegram.sh` itself. Note it, don't gate on it. |

## Proposed install (on approval — the ONLY host mutation this wave)

```bash
# 1. copy the committed canary to the monitoring dir (overwrite-safe, 0755)
scp -i ~/.ssh/algovault_deploy ops/cron/docs-drift-canary.sh root@204.168.185.24:/opt/algovault-monitoring/docs-drift-canary.sh
ssh … 'chmod 755 /opt/algovault-monitoring/docs-drift-canary.sh'

# 2. idempotent crontab add (check-before-add) at the clean Mon 06:29 UTC slot
ssh … 'ROW="29 6 * * 1 /opt/algovault-monitoring/docs-drift-canary.sh >> /var/log/docs-drift-canary.log 2>&1";
        crontab -l 2>/dev/null | grep -q docs-drift-canary || (crontab -l 2>/dev/null; echo "$ROW") | crontab -'
```

## Verification (post-install, per AC)

- `crontab -l | grep -c docs-drift-canary` == **1** (idempotent — re-running the add is a no-op).
- **OK path:** `DOCS_DRIFT_URL=https://algovault.com/docs.html /opt/algovault-monitoring/docs-drift-canary.sh` → log `OK: all 18 required docs sections present`, exit 0, **no send**.
- **Alert path (dry-run):** `DRY_RUN_TG=1 DOCS_DRIFT_URL=https://algovault.com/ /opt/algovault-monitoring/docs-drift-canary.sh` → the homepage lacks the docs section ids → canary detects missing sections → calls `send_telegram.sh` which (DRY_RUN_TG) **logs a well-formed alert WITHOUT sending**. Proves the escalation branch end-to-end, zero real notification.

## Open question for the architect

**Q1** — install slot: confirm **`29 6 * * 1`** (Mon 06:29 UTC, the clean slot) over the script's committed `43 6 * * 1` suggestion (which collides with webhook-delivery-canary at `:43`)? [Recommend: yes.]

Everything else (script copy + idempotent add + dry-run verify) is standard per the monitoring runbook. On approval I run the 2 install steps + the 3 verifications, then flip the status entry's R3 line to installed.
