# `ops/systemd/` — Host-side systemd units for crypto-quant-signal-mcp

This directory holds systemd unit files that run on the **Hetzner host**
(not inside a Docker container) to perform scheduled maintenance work
against the deployed crypto-quant-signal-mcp stack.

Currently shipping:

| Unit                                  | Purpose                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `algovault-funnel-snapshot.service`   | One-shot runner for the weekly activation-funnel snapshot + git commit. |
| `algovault-funnel-snapshot.timer`     | Weekly schedule: Monday 10:00 UTC, 15-minute randomized delay.          |

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

```bash
sudo mkdir -p /etc/algovault
sudo tee /etc/algovault/funnel-snapshot.env >/dev/null <<'EOF'
DATABASE_URL=postgres://algovault:algovault_signal_2024@127.0.0.1:5432/signal_performance
EOF
sudo chmod 600 /etc/algovault/funnel-snapshot.env
sudo chown root:root /etc/algovault/funnel-snapshot.env
```

The credentials here are the same ones the mcp-server container uses
(they're already in the `docker-compose.yml` for the mcp-server service).
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
