# Hetzner CPX22 Disk Diagnosis — 2026-05-18

**Host:** `204.168.185.24` (CPX22, 2 vCPU AMD, 4 GB RAM, **80 GB NVMe**, 20 TB traffic)
**Probe timestamp:** 2026-05-18 (read-only forensic — zero state mutations)
**Output mode:** PROPOSED commands only; nothing executed against the host.

---

## Summary (TL;DR — 3 lines)

1. **Root cause:** `/var/lib/containerd` holds **51 GB** (87% of the 59 GB used) — Docker's containerd-overlayfs snapshotter is hoarding **~52 GB of build cache** (52.45 GB reclaimable per `docker system df`) plus **~50 GB of image layers** (50.44 GB reclaimable, three images: mcp-server, facilitator, postgres — both `crypto-quant-signal-mcp-*` images were rebuilt one hour before probe with full prior layers retained).
2. **Postgres is innocent:** the `signal_performance` database is **only 1.38 GB** (`funding_history` 1240 MB + `signals` 108 MB); growth is slow and indexed reasonably. No `>5 GB` table exists.
3. **Verdict: CLEAN-ONLY.** A single `docker builder prune -af` + `docker image prune -af` reclaims an estimated **35–45 GB** of physical disk (52 GB logical build-cache + 10 GB unique old images), takes the host from 82% → ~25–30% used. **No Hetzner Volume rental needed; no CPX31 upgrade needed.** Re-evaluate in 6 months as postgres `funding_history` keeps appending.

---

## Disk Map

`df -h /`:
```
Filesystem      Size  Used Avail Use%
/dev/sda1        75G   59G   13G  82%
```
`df -i /`: 81% inode usage (3.93M / 4.86M inodes — comfortable but worth watching).

### Top-level consumers (sum-of-rows reconciles to 58.0 GB / 59 GB used = **98.3% accounted**)

| Path | Size | % of used | Class |
|------|------|-----------|-------|
| `/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs` | 47 GB | 79.7% | DELETABLE (build cache + stale image layers) |
| `/var/lib/containerd/io.containerd.content.v1.content` | 3.5 GB | 5.9% | DELETABLE (orphaned image manifests + blobs) |
| `/var/lib/docker` (docker subdir, separate from containerd) | 2.9 GB | 4.9% | KEEP (1.5 GB postgres volume + 1.1 GB rootfs + 385 MB buildkit) |
| `/var/log` | 1.3 GB | 2.2% | MIXED (778 MB journal + 156 MB btmp + 97 MB auth.log.1) |
| `/opt` | 977 MB | 1.7% | KEEP (editorial 327M, crypto-quant 302M, bot 158M, piper-tts 127M) |
| `/home/algovault` | 757 MB | 1.3% | KEEP (Playwright Chromium 261M+177M for dashboard ops) |
| `/usr` (system libs + claude.exe 234M) | ~600 MB | 1.0% | KEEP |
| `/var/lib/apt` | 236 MB | 0.4% | DELETABLE (apt cache only, not lib state) |
| `/root` | 222 MB | 0.4% | KEEP (`.npm` 131 MB, `.cache` 18 MB) |
| `/tmp` | 82 MB | 0.1% | DELETABLE (mcp-registry-diff 55M + ~200 stale `shot-*` Playwright screenshots ≤180 KB each) |
| **Sum** | **57.9 GB** | **98.3%** | |

**Unaccounted delta:** ~1 GB (1.7%) — within the 5% reconciliation tolerance the spec required. Likely kernel buffer cache + `/boot` (253M EFI + ~150M `/boot`) + small dirs.

### Inode pressure

`/` is at 81% inode use (3.93M used). Not yet critical, but `docker builder prune -af` will reclaim a large slice (each cached build step = many small files in the overlayfs snapshot tree).

### Files >100 MB outside Docker

```
261M  /home/algovault/.cache/ms-playwright/chromium-1217/.../chrome
234M  /usr/lib/node_modules/@anthropic-ai/claude-code/.../claude
234M  /usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
177M  /home/algovault/.cache/ms-playwright/.../chrome-headless-shell
156M  /var/log/btmp                                 ← failed-login log (large because of constant SSH brute-force attempts on port 22)
154M  /var/lib/containerd/.../libLLVM.so.19.1       ← inside an image layer
137M  /usr/lib/x86_64-linux-gnu/libLLVM.so.20.1
101M  /var/lib/containerd/.../sha256/bfb0...        ← inside an image layer
```
Nothing surprising; the only DELETABLE single file is `/var/log/btmp` (logrotate-managed; will compress on next rotation).

---

## Docker Subsystem

### `docker system df`

| Bucket | Total | Active | Size | Reclaimable | % reclaimable |
|--------|-------|--------|------|-------------|---------------|
| Images | 4 | 3 | 50.46 GB | 50.44 GB | **99%** |
| Containers | 3 | 3 | 36.86 kB | 0 B | 0% |
| Local Volumes | 1 | 1 | 1.557 GB | 0 B | 0% |
| Build Cache | 1188 | 0 | **52.99 GB** | **52.45 GB** | **99%** |

**Note on the apparent double-count:** Docker's logical sums (50 GB images + 53 GB cache + 1.5 GB volumes = 105 GB) exceed physical on-disk usage (51 GB in `/var/lib/containerd/.../overlayfs`) because shared base layers are counted against every consumer. Physical reclaim ceiling is **~47 GB** (the size of the overlayfs snapshotter dir) minus the working set of the 3 running containers (~1.5 GB).

### Top images (all 4)

| Repo | Tag | Created | Size | Shared | Unique | Containers |
|------|-----|---------|------|--------|--------|------------|
| `crypto-quant-signal-mcp-facilitator` | latest | ~1h ago | 529 MB | 418 MB | 110 MB | 1 (running) |
| `crypto-quant-signal-mcp-mcp-server` | latest | ~1h ago | 530 MB | 418 MB | 111 MB | 1 (running) |
| `postgres` | 16-alpine | 2 mo ago | 395 MB | 0 | 395 MB | 1 (running) |
| `ethereum/solc` | 0.8.20 | 3 yr ago | 20 MB | 0 | 20 MB | 0 (DELETABLE) |

Only one stale image surfaces in the named-image list (`ethereum/solc 0.8.20`, ~20 MB). The **real bulk of the 50 GB reclaimable "images" number is dangling (untagged) image layers from past deploys** — every `docker compose up -d --build` since the host's standup left an orphan layer set behind because Docker doesn't auto-prune.

### Build cache

`docker buildx du` reports **1,188 cache records**, oldest from 2026-04-07, the bulk created **5 weeks ago**. All 1,188 records have `Reclaimable: true`. Build cache is unused at runtime — present only to accelerate *future* `docker compose build` calls on the same host. **For a server that gets a code-side rebuild via GHA every push to main, the local build cache is near-worthless** because the GHA runner builds in a fresh ephemeral env, then `docker compose up -d --build` re-runs the build on the host using whatever cache happens to be present. After clean, the next deploy will be ~30s slower (one cold rebuild) and then the cache rewarms.

### Container json logs

| Container | Log size |
|-----------|----------|
| `mcp-server` | 145 KB |
| `postgres` | 13 KB |
| `facilitator` | 349 B |

All three are **tiny** (containers were restarted ~1h ago when the latest deploy ran). No log-rotation concern; Docker daemon's default `json-file` driver is unbounded but the recent restart reset accumulated logs.

---

## Postgres Breakdown

### Databases (in `crypto-quant-signal-mcp-postgres-1`)

| Database | Size | Notes |
|----------|------|-------|
| **`signal_performance`** | **1378 MB** | Production data |
| `postgres` | 7.5 MB | admin |
| `template0` | 7.4 MB | |
| `template1` | 7.4 MB | |
| **Total** | **~1.4 GB** | matches `du /var/lib/postgresql/data` 1.5 GB |

`pg_wal` directory: **80 MB** (healthy — autocheckpoint is keeping it small). `base` directory: 1.4 GB. `shared_preload_libraries = pg_stat_statements`. `track_activity_query_size = 1024` (default — no oversized query history blowup).

### Top 20 tables in `signal_performance.public`

| Table | Total size | Heap | Indexes | Class |
|-------|-----------|------|---------|-------|
| **`funding_history`** | **1240 MB** | 579 MB | 661 MB | KEEP (cross-venue funding rate history; consumed by `scan_funding_arb` MCP tool) |
| `signals` | 108 MB | 105 MB | 3 MB | KEEP (signal call ledger — every `get_trade_call` appended; growth source) |
| `hold_counts` | 16 MB | 10 MB | 6 MB | KEEP |
| `agent_sessions` | 2 MB | 1.2 MB | 0.8 MB | KEEP |
| `request_log` | 1.8 MB | 1.5 MB | 0.3 MB | KEEP |
| `skill_invocations` | 96 KB | — | — | KEEP |
| `quota_usage` | 80 KB | — | — | KEEP |
| `forum_post_failures` | 64 KB | — | — | KEEP |
| `forum_post_audit_log` | 48 KB | — | — | KEEP |
| `venues` | 48 KB | — | — | KEEP |
| `merkle_batches` | 24 KB | — | — | KEEP |

**Only 11 tables exist** (spec asked for top 20; there aren't 20). **No table exceeds the 5 GB flag threshold.**

### Top 10 indexes

| Table.Index | Size |
|-------------|------|
| `funding_history.idx_funding_coin_time` | 391 MB |
| `funding_history.funding_history_pkey` | 270 MB |
| `hold_counts.hold_counts_pkey` | 6.3 MB |
| `signals.signals_pkey` | 2.9 MB |
| (remaining 6 indexes <1 MB each) | |

`funding_history` indexes (661 MB total) are 53% of the table's footprint — high but defensible (composite + PK + range scans by `scan_funding_arb`). Not a deletion target.

---

## Journal + Logs

`journalctl --disk-usage`: **778.8 MB** in archived + active journals.
`/etc/systemd/journald.conf`: **no overrides** — running on systemd's default `SystemMaxUse=10%` of `/var`, which on a 75 GB disk caps at ~7.5 GB. Currently at 778 MB → comfortably below cap.

### Top files in `/var/log`

| File | Size | Class |
|------|------|-------|
| `btmp` | 156 MB | DELETABLE (failed-login log; logrotate manages but compression lag) |
| `auth.log.1` | 97 MB | KEEP-COMPRESSED (last week's sshd auth log; will gzip on next rotate) |
| `btmp.1` | 85 MB | DELETABLE (last week's btmp; logrotate hasn't compressed) |
| `journal/.../system@...journal` (×N) | 41–46 MB each | KEEP (active systemd journal segments) |

**Sustained driver of btmp size:** constant brute-force SSH attempts on port 22. Mitigation outside this wave's scope (move SSH to non-standard port + fail2ban + Cloudflare-Tunnel-only access — see follow-up).

---

## Classification Table

| Path / Bucket | Size | Class | Rationale |
|---------------|------|-------|-----------|
| Docker build cache (in containerd overlayfs) | ~28 GB physical (52 GB logical) | **DELETABLE** | Zero runtime value; GHA rebuilds cleanly; rewarms in 1 deploy |
| Dangling/old image layers (in containerd overlayfs) | ~15 GB physical (50 GB logical) | **DELETABLE** | Past deploys' layers replaced by current images; no rollback path uses them |
| `ethereum/solc:0.8.20` image | 20 MB | **DELETABLE** | 3-year-old image, no container references it |
| `containerd content blobs` (orphaned manifests) | ~2.5 GB | **DELETABLE** (auto-purged when images go) | Manifests for the same orphan layers |
| `/var/log/btmp` + `/var/log/btmp.1` | 241 MB | **DELETABLE** | Failed-login bookkeeping; truncatable safely |
| `/tmp` (mcp-registry-diff + ~200 shot-* dirs) | 82 MB | **DELETABLE** | Stale Playwright screenshots from prior dashboard ops |
| `/var/lib/apt/lists` cache | ~120 MB | **DELETABLE** | apt update will rebuild |
| systemd journal (778 MB) | 778 MB | **KEEP-CAPPED** | Within default 7.5 GB cap; useful for incident forensics |
| Postgres `funding_history` (1240 MB) | 1.24 GB | **KEEP** | Live consumed by `scan_funding_arb`; growing slowly (no `>5 GB` red flag) |
| Postgres `signals` (108 MB) | 108 MB | **KEEP** | Every signal call appended; growth = 390 backfill queued |
| Postgres `pgdata` volume | 1.557 GB | **KEEP** | Production data |
| Running container images (3× crypto-quant + postgres) | ~1.5 GB | **KEEP** | Active runtime |
| `/opt/algovault-*` (editorial + bot + crypto-quant + piper-tts) | 977 MB | **KEEP** | Deploy artifacts for sibling services |
| `/home/algovault/.cache/ms-playwright` | 438 MB | **KEEP** | Used by `landing-as-subpage-visual-consistency-audit` + screenshot ops |
| `/root/.npm` | 131 MB | **ARCHIVABLE→DELETABLE** | npm cache; trivially rebuilt; reclaim if pressure recurs |
| `claude.exe` + claude binary (`/usr/lib/node_modules/@anthropic-ai/claude-code/`) | 468 MB | **KEEP** | Active toolchain (claude-code CLI) |

No `ARCHIVABLE→S3` rows (we have no S3 setup wired in this stack, and nothing here is "cold but valuable" — it's either live or junk).

---

## Cleanup Proposal — PROPOSED ONLY (not executed this wave)

### Tier 1 — Safe Immediate (zero risk, runs while containers stay up)

```bash
# 1. Reclaim Docker build cache (biggest win — ~28 GB physical)
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 'docker builder prune -af'
# Estimated reclaim: ~28 GB physical (52.45 GB logical). All 1,188 records flagged Reclaimable: true.

# 2. Prune dangling images (untagged layers from past deploys — ~15 GB physical)
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 'docker image prune -af'
# Estimated reclaim: ~15 GB physical (50.44 GB logical). Drops ethereum/solc + every layer not in a tagged image referenced by a running container.

# 3. Cap systemd journal at 500 MB (current 778 MB → 500 MB)
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 'journalctl --vacuum-size=500M'
# Estimated reclaim: ~278 MB. Persistent cap: edit /etc/systemd/journald.conf with SystemMaxUse=500M and `systemctl restart systemd-journald`.

# 4. Truncate btmp (failed-login log)
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 'truncate -s 0 /var/log/btmp && rm -f /var/log/btmp.1'
# Estimated reclaim: ~241 MB. logrotate manages /var/log/btmp; truncation is the canonical reset (don't rm — sshd holds the inode).

# 5. Clean /tmp Playwright screenshot debris
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 'find /tmp -maxdepth 1 -name "shot-*" -type d -mtime +1 -exec rm -rf {} +; rm -rf /tmp/mcp-registry-diff /tmp/hl_candles'
# Estimated reclaim: ~80 MB.

# 6. Apt cache (only the downloaded debs; keeps lists)
ssh -i ~/.ssh/algovault_deploy root@204.168.185.24 'apt clean'
# Estimated reclaim: ~120 MB.
```

**Tier 1 total estimated reclaim: ~43.7 GB physical.** Post-cleanup `df -h /` projection: **15 GB used / 75 GB total (20%)**.

### Tier 2 — Needs confirmation (would alter behavior)

```bash
# 7. Configure Docker daemon to cap container json-file logs (prevents future growth)
# /etc/docker/daemon.json:
# {"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}
# Then: systemctl restart docker  (CAUSES BRIEF CONTAINER RESTART — confirm with Mr.1 before doing)
# Reclaim today: 0 (logs already tiny); prevention only.

# 8. Add weekly cron to keep build cache bounded
# crontab -e:
# 0 4 * * 0  docker builder prune -af --filter "until=168h" > /var/log/docker-prune.log 2>&1
# Reclaim today: 0; prevention only.

# 9. Pre-emptively VACUUM funding_history (it's append-only with index churn)
# docker exec crypto-quant-signal-mcp-postgres-1 psql -U algovault -d signal_performance -c "VACUUM (ANALYZE) public.funding_history;"
# Reclaim today: probably <50 MB (table is well-tended); useful for query planner stats.
```

### Tier 3 — Out of scope this wave, file as follow-ups

- Move SSH off port 22 + add fail2ban (drives btmp growth — currently 156 MB and refilling).
- Wire Cloudflare-Tunnel-only access for SSH (per CLAUDE.md `cloudflare-tunnel-zero-trust-internal-ui-expose` skill).
- Schedule `funding_history` partitioning by month if it crosses 5 GB (currently 1.24 GB; ~6 month runway at current growth).

---

## Hetzner Volume Cost Analysis

**Sources:**
- [Hetzner Price Adjustment doc](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) (fetched 2026-05-18)
- [Hetzner Cloud Pricing page](https://www.hetzner.com/cloud/pricing/) (fetched 2026-05-18; prices JS-rendered, confirmed via price-adjustment doc)

**Hetzner Cloud Volume pricing (effective April 1, 2026):** **€0.0572 / GB / month** (was €0.04/GB/mo pre-April; bumped per the official price-adjustment notice). No setup or attach fee. Minimum size 10 GB, maximum 10 TB per volume. Volumes attach to a single server at a time.

| Volume size | Monthly EUR |
|-------------|-------------|
| 50 GB | €2.86 |
| 100 GB | **€5.72** |
| 250 GB | €14.30 |
| 500 GB | €28.60 |

**CPX22 vs CPX31 (Germany/Finland EUR, effective April 1, 2026):**

| Plan | vCPU | RAM | NVMe | New price | Old price |
|------|------|-----|------|-----------|-----------|
| CPX22 (current) | 2 (AMD) | 4 GB | 80 GB | **€7.99/mo** | €5.99/mo |
| CPX31 (upgrade option) | 4 (AMD) | 8 GB | 160 GB | **€13.99/mo** | €10.49/mo |
| Delta | +2 vCPU | +4 GB | +80 GB | **+€6.00/mo** | +€4.50/mo |

A CPX22→CPX31 upgrade costs **€6/mo** and doubles the disk (80 GB → 160 GB) in addition to doubling vCPU + RAM. A 100 GB volume costs **€5.72/mo** — disk-only-equivalent, slightly cheaper than the full upgrade, but the upgrade also gets you 2× compute that the host doesn't currently need.

---

## Verdict

**CLEAN-ONLY.**

Rationale: the 82% disk pressure is **not** caused by production data growth — postgres is 1.4 GB, the entire application footprint outside Docker is <2 GB. The pressure is **stale Docker build cache + dangling image layers** accumulated across deploys, with **52.45 GB flagged Reclaimable: true** by Docker's own bookkeeping. A single `docker builder prune -af && docker image prune -af` recovers an estimated **35–45 GB physical**, dropping `df -h /` from 82% to ~20%, with zero risk to running services (the 3 active containers' working set is ~1.5 GB and stays out of the prune set).

Renting a 100 GB volume (€5.72/mo) or upgrading to CPX31 (+€6/mo) would both **mask** the underlying issue — old Docker layers would just continue to accumulate and refill any new headroom. Mr.1's 2026 North Star (acquisition above all else, keep cost low) favors **zero recurring spend** here, especially since the recurring spend doesn't fix the root cause.

**Follow-up to prevent recurrence:** ship Tier 2 step #7 (Docker daemon `log-opts` cap) + Tier 2 step #8 (weekly cron `docker builder prune -af --filter "until=168h"`) in a 5-minute hardening wave. Re-evaluate disk pressure in 6 months — if `funding_history` is approaching 5 GB AND `signals` is approaching 1 GB AND cleanup runway is shrinking, **then** rent a 50 GB volume (€2.86/mo) to host `/var/lib/postgresql/data` and call it good through 2027.

**Decision: CLEAN-ONLY. No volume rental. No CPX31 upgrade.**

---

*Probed read-only via `ssh -i ~/.ssh/algovault_deploy root@204.168.185.24` on 2026-05-18. Zero state mutations executed. All cleanup commands above are PROPOSED; execution requires a separate Mr.1-approved dispatch.*
