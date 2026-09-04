# `ops/systemd/` — Host-side systemd units for crypto-quant-signal-mcp

This directory holds systemd unit files that run on the **Hetzner host**
(not inside a Docker container) to perform scheduled maintenance work
against the deployed crypto-quant-signal-mcp stack.

Currently shipping:

| Unit                                  | Purpose                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `algovault-funnel-snapshot.service`   | One-shot runner for the weekly activation-funnel snapshot + git commit. |
| `algovault-funnel-snapshot.timer`     | Weekly schedule: Monday 10:00 UTC, 15-minute randomized delay.          |
| `docker-builder-gc.service`           | One-shot size-capped `docker builder prune` (buildkit cache only; image-safe). See §8. |
| `docker-builder-gc.timer`             | Weekly: Sun 04:23 UTC + up to 1h randomized delay, `Persistent=true`.   |
| `algovault-bot.service`               | The public Telegram bot's long-running command listener. |
| `algovault-bot-cron.service`          | One-shot alert-engine tick (per-TF lazy dispatch). |
| `algovault-bot-cron.timer`            | **Every minute at :10 seconds** — see §9 for why the phase is load-bearing. |

The actual snapshot logic lives in `scripts/write-funnel-snapshot.ts` (owned
by Teammate 2's scope in this same PR); the commit wrapper is at
`scripts/commit-funnel-snapshot.sh`.

---

## 1. Prerequisites

Before enabling the timer, three pieces of host state must exist. **None of
them are created by this PR** — the unit files assume they will be set up
by an operator during registration.

### 1.1 Postgres port exposed on `127.0.0.1:5432`

The production stack runs Postgres inside the
`crypto-quant-signal-mcp-postgres-1` container, on the internal docker
network. The container **does not currently publish port 5432 to the host**
— verify with `docker inspect crypto-quant-signal-mcp-postgres-1 --format '{{json .NetworkSettings.Ports}}'`.

To expose it to the loopback interface only (no public exposure), add this
under the `postgres:` service in `docker-compose.yml`:

```yaml
  postgres:
    # ...existing config...
    ports:
      - "127.0.0.1:5432:5432"
```

Then restart just that container:

```bash
cd /opt/crypto-quant-signal-mcp
docker compose up -d postgres
```

Verify:

```bash
ss -ltnp | grep 5432
# expected: 127.0.0.1:5432  LISTEN  ...  docker-proxy
```

Binding to `127.0.0.1` (not `0.0.0.0`) means the port is reachable from the
host — and therefore from systemd services running on the host — but is
**not** exposed on the public internet. Hetzner's firewall should also be
verified to confirm 5432/tcp remains closed externally.

### 1.2 `/etc/algovault/funnel-snapshot.env`

Create the env file that the systemd unit loads via `EnvironmentFile=`:

Read the password from the app env file rather than typing it — **never paste a
credential into this repo, which is public** (see the warning below):

```bash
sudo mkdir -p /etc/algovault
# shellcheck disable=SC1091
POSTGRES_PASSWORD=$(sudo grep -m1 '^POSTGRES_PASSWORD=' /opt/crypto-quant-signal-mcp/.env | cut -d= -f2-)
sudo tee /etc/algovault/funnel-snapshot.env >/dev/null <<EOF
DATABASE_URL=postgres://algovault:${POSTGRES_PASSWORD}@127.0.0.1:5432/signal_performance
EOF
unset POSTGRES_PASSWORD
sudo chmod 600 /etc/algovault/funnel-snapshot.env
sudo chown root:root /etc/algovault/funnel-snapshot.env
```

> ⚠️ **Never commit the literal password here.** An earlier revision of this file
> hardcoded it; because this repo is public and the value stayed in git history,
> the only real remediation was rotating the secret
> (`OPS-AUDIT-REMEDIATION-CRITICAL-W1`). `scripts/security-canary.mjs` now fails
> the build on a DSN-embedded password, so a repeat cannot reach `main`.

The credentials here are the same ones the mcp-server container uses
(sourced from `/opt/crypto-quant-signal-mcp/.env`, which `docker-compose.yml`
passes through as `${POSTGRES_PASSWORD}` — never a literal).
The difference is the host — `127.0.0.1` instead of `postgres` — because
the host can't resolve the docker network's internal DNS name.

The `0600 / root:root` perms are non-negotiable: this file contains a DB
credential that is currently reachable from the loopback interface.

### 1.3 Deploy-key push access

The wrapper script runs `git push origin main`. That only works if the
deploy key on this host has **push** access, not just pull. Verify:

```bash
cd /opt/crypto-quant-signal-mcp
git push origin main --dry-run
```

Possible outcomes:

- `Everything up-to-date` — push access works.
- `ERROR: The key you are authenticating with has been marked as read-only`
  — you need to add a write-enabled deploy key or use a PAT.
- `Permission denied (publickey)` — no key is loaded at all.

If you hit either error case, see BLOCKER-3 below.

---

## 2. Registration

Once the prerequisites in section 1 are satisfied:

```bash
# Copy the unit files into /etc/systemd/system/
sudo cp /opt/crypto-quant-signal-mcp/ops/systemd/algovault-funnel-snapshot.service /etc/systemd/system/
sudo cp /opt/crypto-quant-signal-mcp/ops/systemd/algovault-funnel-snapshot.timer   /etc/systemd/system/

# Reload systemd so it picks up the new units
sudo systemctl daemon-reload

# Enable + start the timer (the service is triggered by the timer, not enabled directly)
sudo systemctl enable --now algovault-funnel-snapshot.timer

# Verify the timer is registered and see the next fire time
systemctl list-timers algovault-funnel-snapshot.timer
```

Expected `list-timers` output should show a `NEXT` column pointing at the
next Monday 10:00 UTC (plus up to 15 minutes of randomized delay).

---

## 3. Manual one-shot test

The first run should always be triggered manually so you can catch env-file
and tsx-cache issues in the foreground rather than silently overnight.

```bash
# Fire the service once (bypasses the timer entirely)
sudo systemctl start algovault-funnel-snapshot.service

# Tail the last 100 log lines
sudo journalctl -u algovault-funnel-snapshot.service -n 100 --no-pager

# If the timer is already enabled, this works too:
sudo systemctl status algovault-funnel-snapshot.service
```

A successful run ends with log lines like:

```
[commit-funnel-snapshot] push succeeded
[commit-funnel-snapshot] done status=0 repo=/opt/crypto-quant-signal-mcp ts=...
```

Exit code semantics (defined in `scripts/commit-funnel-snapshot.sh`):

| Exit | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| `0`  | Success, or nothing to do (same snapshot filename already exists) |
| `2`  | `DATABASE_URL` missing — env file not installed or not loaded     |
| `3`  | `git push origin main` failed — local commit remains intact       |
| *    | Any other error propagates via `set -euo pipefail`                |

---

## 4. CPX22 footprint

The Hetzner host is a CPX22 (2 vCPU / 4GB RAM / 80GB NVMe / 20TB traffic).
Per CLAUDE.md we must verify new cron load fits within these specs before
shipping. Measurements / expectations for this unit:

| Resource          | Expected                                                     |
| ----------------- | ------------------------------------------------------------ |
| RAM (while running) | &lt;50 MB — a single node-tsx process + libpq client        |
| CPU               | &lt;5 % of one vCPU for &lt;2 s on steady-state runs         |
| Disk (per run)    | ~4 KB new snapshot file + git object churn (&lt;50 KB/week) |
| DB query time     | &lt;200 ms — dataset is tiny (32 rows in `request_log`, 0 rows in `agent_sessions` as of 2026-04-15) |
| First `npx -y tsx` run | ~30 s + ~100 MB into `~/.npm/_npx` cache                |
| Subsequent runs   | &lt;2 s; cache is persistent across runs                     |
| Network           | ~500 KB outbound git push + ~100 MB first-time npm fetch     |

Weekly cadence means 52 runs/year → trivial footprint on a CPX22 with the
current workload. No concerns.

---

## 5. Known blockers

> **These must be resolved at install time.** The unit files are shipped
> ready-to-register, but the cron will fail on its first run until each
> blocker below is addressed.

### BLOCKER-1 — Postgres port not exposed

**Problem:** `docker-compose.yml` does not publish port 5432 to the host.
The host therefore cannot reach Postgres, and `DATABASE_URL` using
`127.0.0.1:5432` will fail `ECONNREFUSED`.

**Fix:** Add the one-line `ports:` block shown in section 1.1 and restart
the postgres container. Bind to `127.0.0.1` only — **never** expose to the
public interface.

**Why it wasn't fixed in this PR:** Modifying `docker-compose.yml` is out
of scope for T3 (file creation only). The main thread should either apply
this edit in the same PR under a separate teammate's scope or follow up
with a one-line commit before enabling the timer.

### BLOCKER-2 — `tsx` not cached on the host

**Problem:** The host has no `npm ci`-installed dev dependencies under
`/opt/crypto-quant-signal-mcp/node_modules`, and no warm `~/.npm/_npx`
cache for `tsx`. The very first `npx -y tsx scripts/write-funnel-snapshot.ts`
therefore needs network access to `registry.npmjs.org` and will take ~30 s.

**Fix:** Pre-warm the cache once, manually, during registration. Run
`sudo -u root npx -y tsx --version` from `/opt/crypto-quant-signal-mcp`
and verify exit 0. From that point on, subsequent systemd invocations
will use the cached tsx and complete in &lt;2 s.

**If NPM is down or the host is air-gapped** at the scheduled fire time,
the cron will fail cleanly with a non-zero exit (systemd journal will
show the `npx` error). Because the wrapper uses `set -euo pipefail`, no
partial commit will be created.

### BLOCKER-3 — Deploy-key push access unverified

**Problem:** `.github/workflows/deploy.yml` sets up a deploy key for
CI-driven deploys, but it is unclear at time of writing whether the same
key on the Hetzner host has **push** rights on `origin` — it may be a
read-only deploy key.

**Fix:** Run `git push origin main --dry-run` from `/opt/crypto-quant-signal-mcp`
as the user the systemd unit will run as (root, per `User=root`). If it
returns `Everything up-to-date`, you're good. Otherwise, add a new
write-enabled deploy key in the GitHub repo settings and install its
private half at `/root/.ssh/id_ed25519_algovault_funnel` (or similar)
with matching `IdentityFile=` in `/root/.ssh/config` for the
`github.com-algovault-funnel` host alias, and rewrite the origin URL to
use that alias.

If push access cannot be granted, the fallback is to have the wrapper
skip the push and have a human review/push the snapshot manually the
following Monday morning — exit code 3 makes this state easy to detect
via `systemctl status` or journal scrape.

---

## 6. Optional alternative path (Option B)

If resolving all three blockers above proves too much scope, the cron can
be rewritten to bypass node-on-host entirely:

```bash
docker exec crypto-quant-signal-mcp-postgres-1 \
  psql -U algovault -d signal_performance \
       -A -F'|' -t \
       -c "$(cat activation-funnel/queries/funnel-snapshot.sql)"
```

The pipe-delimited output can be parsed by a sibling Python or Bash
formatter to produce the same markdown the TypeScript writer emits.

**Pros:**
- No Postgres port exposure (BLOCKER-1 goes away).
- No `npx tsx` on the host (BLOCKER-2 goes away).
- No new credentials on the host (env file becomes unnecessary).

**Cons:**
- Duplicates the markdown-generation logic in two languages (TS for the
  manual `scripts/write-funnel-snapshot.ts` path, Python/Bash for the
  cron path) — violates "fix at the generator, not the lane".
- Requires maintaining the SQL query as a standalone file (which it
  already is: `activation-funnel/queries/funnel-snapshot.sql`).

**This PR does NOT implement Option B.** It is documented here as a
fallback the team can pick up if BLOCKER-1/2 prove problematic to
resolve.

---

## 7. Uninstallation

To cleanly remove the timer:

```bash
sudo systemctl disable --now algovault-funnel-snapshot.timer
sudo rm /etc/systemd/system/algovault-funnel-snapshot.timer
sudo rm /etc/systemd/system/algovault-funnel-snapshot.service
sudo systemctl daemon-reload
# Optional: remove the env file and its parent dir if nothing else uses it
sudo rm /etc/algovault/funnel-snapshot.env
sudo rmdir /etc/algovault 2>/dev/null || true
```

The repo-side files (`ops/systemd/*.service`, `ops/systemd/*.timer`,
`scripts/commit-funnel-snapshot.sh`) can be left in place — they are
inert until re-registered.

---

## 8. Docker buildkit cache GC (`OPS-BUILDER-GC-TIMER-W1`)

Weekly, size-capped `docker builder prune` on **both** Hetzner hosts so the
buildkit cache from daily deploys can never silently re-climb to ~50 GB (the
driver behind `OPS-HETZNER-DISK-RECLAIM-W1`'s one-time 36 GB sweep). Runs on
the **containerd snapshotter** both boxes use.

**Image-safe by construction:** `docker builder prune` removes **only** build
cache — never image layers (held by running images), volumes, or containers.
It is NOT `docker system prune`. `--max-used-space` LRU-evicts cache records
until the cache is under the cap, keeping the hot/most-recent working set warm.

**Per-host cap** via `/etc/algovault/docker-builder-gc.env` (mode 644):

| Host | `GC_MAX_USED_SPACE` | Warm ≤7-day set at install | Rationale |
| ---- | ------------------- | -------------------------- | --------- |
| 204 (CPX42, signal-MCP) | `15GB` | 9.92 GB (`docker buildx du`) | ~1.5× warm; first run LRU-evicts the cold >7-day tail |
| 178 (CPX22, AOE)        | `6GB`  | 2.21 GB | generous forward ceiling; already under cap (backstop only) |

Cap sizing is **measured, not guessed** — re-run `docker buildx du` before
changing a cap; never set below one week's warm working set or the next deploy
rebuilds cold.

### Install (per host)

```bash
sudo mkdir -p /etc/algovault
echo 'GC_MAX_USED_SPACE=15GB' | sudo tee /etc/algovault/docker-builder-gc.env  # 6GB on 178
sudo chmod 644 /etc/algovault/docker-builder-gc.env
sudo cp /opt/<repo>/ops/systemd/docker-builder-gc.service /etc/systemd/system/
sudo cp /opt/<repo>/ops/systemd/docker-builder-gc.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start docker-builder-gc.service            # dry-run once; check journald + `docker buildx du` <= cap
sudo systemctl enable --now docker-builder-gc.timer
systemctl list-timers docker-builder-gc.timer
```

**Silent** (journald only, no Telegram — routine GC is not an operator alert).
Fail-open: a failed run (docker down) is harmless and retries next week. This
is the **Recover** primitive for the build-cache-growth class, wireable into
the planned `disk-fill` autopilot (detector `ops/scripts/disk-forensics.sh`).

### Uninstall (per host)

```bash
sudo systemctl disable --now docker-builder-gc.timer
sudo rm /etc/systemd/system/docker-builder-gc.{service,timer}
sudo systemctl daemon-reload
# optional: sudo rm /etc/algovault/docker-builder-gc.env
```


---

## 9. algovault-bot units (`OPS-BOT-DISPATCH-LATENCY-W1` CH4)

These three units ran in production for months with **no committed ancestor in any repo** —
`git ls-tree -r origin/main` over the algovault-bot repo returns zero `[Unit]` and zero
`ExecStart` lines, and they are absent from `ops/deploy/algovault-bot.manifest`. That is the
exact precondition of `OPS-CLOSEDBAR-DISPATCH-OFFSET-INCIDENT-W1`, where `dispatch_schedule.py`
was live while existing on no branch and a full-tree rsync silently deleted it. Committing them
here closes that gap.

`algovault-bot.service` and `algovault-bot-cron.service` are **byte-identical to the live host
files** — verified with `diff` against `/etc/systemd/system/` before committing, so this commit
records reality rather than an idealised version of it. Only the timer differs, and only in two
lines.

### 9.1 What changed in the timer, and why the phase is not cosmetic

```
-OnCalendar=*:*:00      +OnCalendar=*:*:10
-AccuracySec=5s         +AccuracySec=1s
```

The engine dispatches a watch row at `bar_open + offset + grace + jitter`, **rounded up to the
next tick**. On a `*:*:00` grid the only reachable instants after a bar closes are +0s and +60s,
so the smallest expressible non-zero offset is a WHOLE MINUTE. That is the entire reason
`ALGOVAULT_BOT_CLOSE_GRACE_MIN` existed at 1, and the reason a 15m alert could not land sooner
than bar_close + 60s no matter how the knobs were set.

Bar close +0s is not a safe alternative. Measured on Binance fapi **from this host**: a
just-closed bar's final `(close, volume)` settles between **+2.13s and +6.27s**, and the edge
serves NON-MONOTONIC reads out to +6.45s — a new bar appearing, vanishing, and reappearing.
Dispatching at +0s scores the correct bar with non-final data, and the scorer's volume component
is a step function over `lastCandleVol / avgCandleVol`, so an under-integrated bar biases it
downward. The magnitude scales as 1/bar-duration (measured ~4.9% shortfall on a 1m BTC bar,
implying ~0.08% at 1h), so it is a short-timeframe concern rather than a book-wide one — but it
is removed entirely by waiting ~10s instead of arguing about it.

**`AccuracySec=1s` is part of the same change, not a tidy-up.** systemd may fire anywhere inside
the accuracy window, so leaving 5s would turn a 10s target into 10–15s and spend the settle
margin. Measured over 1620 consecutive ticks the timer already fires within +0.010s..+0.335s, so
1s is a ceiling this host comfortably meets.

### 9.2 Registration

Deliberately a documented manual step, matching every other unit in this directory. It is NOT
automated into `ops/scripts/host-deploy.sh`: that tool's `--units` flag runs `daemon-reload` +
`restart` and has never written a unit file, and the monitoring rules are explicit that an
unattended job must not perform an unreviewed privileged mutation. Installing a unit into
`/etc/systemd/system/` is exactly that.

```bash
# Back up first — the live copies are the only record of the pre-change state.
for u in algovault-bot.service algovault-bot-cron.service algovault-bot-cron.timer; do
  sudo cp -a "/etc/systemd/system/$u" "/etc/systemd/system/$u.bak.DISPATCH-LATENCY-W1-$(date -u +%Y%m%dT%H%M%SZ)"
done

sudo cp /opt/crypto-quant-signal-mcp/ops/systemd/algovault-bot.service        /etc/systemd/system/
sudo cp /opt/crypto-quant-signal-mcp/ops/systemd/algovault-bot-cron.service   /etc/systemd/system/
sudo cp /opt/crypto-quant-signal-mcp/ops/systemd/algovault-bot-cron.timer     /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart algovault-bot-cron.timer

# Assert the phase actually took — `daemon-reload` alone does NOT re-arm a running timer.
systemctl show -p NextElapseUSecRealtime --value algovault-bot-cron.timer
systemctl list-timers algovault-bot-cron.timer          # NEXT must land on a :10 second
```

### 9.3 The env half — it must land in the SAME window

The timer phase alone changes nothing user-visible: `CLOSE_GRACE_MIN=1` still adds a minute on
top of it. Both halves are one change.

```bash
sudo cp -a /etc/algovault-bot/env "/etc/algovault-bot/env.bak.DISPATCH-LATENCY-W1-$(date -u +%Y%m%dT%H%M%SZ)"
sudo sed -i 's/^ALGOVAULT_BOT_CLOSE_GRACE_MIN=.*/ALGOVAULT_BOT_CLOSE_GRACE_MIN=0/'   /etc/algovault-bot/env
sudo sed -i 's/^ALGOVAULT_BOT_JITTER_WINDOW_MIN=.*/ALGOVAULT_BOT_JITTER_WINDOW_MIN=1/' /etc/algovault-bot/env
```

> ⚠️ **`JITTER_WINDOW_MIN=1`, never `0`.** `dispatch_schedule._bounded_int_env` is default-DENY
> over `[1, 60)`, so `0` is out of range and falls back to the **default of 3** — silently
> restoring full jitter while looking like a successful change. `1` is the real "off":
> `jitter_minutes` returns 0 for any window <= 1. The liveness canary reads the same raw value
> and would build an EMPTY due-time grid from `0`, so the wrong value is doubly wrong.

### 9.4 Preconditions — none of this is safe without them

| Precondition | Why | Status |
| --- | --- | --- |
| Concurrent dispatch + budget >= 104 | `JITTER_WINDOW_MIN=1` deletes the load-spreading primitive `FETCH_BUDGET_PER_MIN` depends on, collapsing ~89 rows (104 at a 4h boundary) onto ONE tick. At the old budget of 30 that drains over four ticks, putting the last cohort at +190s — worse than the +120s being fixed. | Shipped + deployed (`2d9ad14`); measured live at **8.1x** (25 rows in 1.81s vs 14.7s sequential) |
| `/mcp` limiter exempts the internal caller | ~104 rows is ~115 tool calls plus handshakes in one minute against `max: 120`, and the overflow is a SILENTLY DROPPED ALERT, not a retry. | Committed, **not yet merged/deployed** |
| `closedbar-w1-liveness` cron moved `:44` -> `:11` | At `:44` it audits the `:30` bar, which carries no 1h cohort and cannot exhibit contention. Its SAMPLE_BLIND arm goes INDETERMINATE on a wrong-bar sample, so the cron move and that script are one change. | Committed, **not yet merged/deployed** |

### 9.5 Rollback

```bash
sudo cp -a /etc/systemd/system/algovault-bot-cron.timer.bak.DISPATCH-LATENCY-W1-<ts> /etc/systemd/system/algovault-bot-cron.timer
sudo cp -a /etc/algovault-bot/env.bak.DISPATCH-LATENCY-W1-<ts> /etc/algovault-bot/env
sudo systemctl daemon-reload && sudo systemctl restart algovault-bot-cron.timer
```

`FETCH_CONCURRENCY=1` in the same env file independently restores the pre-CH3 sequential tick
with no redeploy, if the concurrency rather than the phase turns out to be the problem.
