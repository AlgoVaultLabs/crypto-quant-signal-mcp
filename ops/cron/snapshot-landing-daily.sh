#!/usr/bin/env bash
# ops/cron/snapshot-landing-daily.sh — OPS-FRESHNESS-SOURCE-TRUTH-W1 (2026-07-28)
#
# WHY THIS EXISTS (the generator-level fix, G2).
#
# scripts/snapshot-landing-data.mjs rewrites the data-tr-field span fallbacks + JSON-LD
# literals in landing/*.html from the live SoT. Until this wave it ran ONLY inside the
# deploy.yml SSH step, so every baked literal tracked the DEPLOY clock. Values that change
# on a different clock therefore drifted for as long as nobody pushed:
#
#   * latest_batch_at / latest_batch / latest_batch_n — the merkle publisher fires DAILY at
#     00:05 UTC, so a 3-day deploy gap left /verify claiming a 3-day-old batch. That is what
#     produced the 2026-07-27 `VERIFY_LATEST_BATCH_FRESH` alert (page baked 2026-07-25,
#     canary ran 2026-07-27 12:00 -> 2.50d) and sent the operator to investigate a merkle
#     publisher with a 100/100 record.
#   * call_count / total_calls_executed — grows hourly.
#   * the JSON-LD literals LLM crawlers ingest.
#
# Running the SAME injector on a schedule that matches the PRODUCER (daily, just after the
# 00:05 publish) retires that class for every claim in scripts/snapshot-landing-manifest.json
# at once — including the drift that OPS-WEBSITE-COPY-DRIFT-CLEANUP-W1 deferred to a
# never-built OPS-JSON-LD-BUILD-TIME-INJECT-W1. Adding a claim stays a manifest row.
#
# The deploy path is UNCHANGED and still runs the injector: this is an ADDITIONAL trigger,
# not a replacement, so a deploy never serves a stale bake while waiting for 00:39.
#
# SCHEDULE (crontab): 39 0 * * *
#   00:05 publish-merkle-batch (observed tail 00:05:15.823) -> 33m44s of head-room
#   00:39 THIS SCRIPT (injector clocks 2-5s)
#   00:57 website-drift-canary.py verifies the result
#   :39 and :57 are used because :13 and :23 are both occupied on this box; only :09, :39
#   and :57 are free in hour 00. Off-`:00` per the CLAUDE.md cron rule.
#   Moving this cron REQUIRES updating producer_fire_minute_utc / canary_run_minute_utc in
#   website-drift-manifest.yaml — the canary's cadence-coherence lint fails closed otherwise.
#
# EXIT CONTRACT — FAIL-OPEN, deliberately (matches the injector's own contract):
#   0  normal, INCLUDING an unreachable SoT (stale fallbacks survive; nothing is worse off)
#   0  another instance holds the lock (flock -n) — never queue re-bakes
#   1  --check only: the baked literals are confirmed STALE vs the live SoT
#   1  the injector's own catastrophic-pattern-drift guard (>=50% of claims matched nothing)
#
# Fail-open is safe ONLY because the heartbeat below is stamped unconditionally and watched
# by SNAPSHOT_INJECTOR_HEARTBEAT_FRESH — otherwise this script could die quietly forever.

set -uo pipefail

REPO_DIR="${SNAPSHOT_LANDING_REPO:-/opt/crypto-quant-signal-mcp}"
WEBROOT="${SNAPSHOT_LANDING_WEBROOT:-/var/www/algovault}"
HEARTBEAT="${SNAPSHOT_LANDING_HEARTBEAT:-/var/lib/algovault-monitoring/snapshot-landing-heartbeat}"
LOCK="${SNAPSHOT_LANDING_LOCK:-/var/lock/algovault-snapshot-landing-daily.lock}"
NODE_BIN="${NODE_BIN:-/usr/bin/node}"
INJECTOR="scripts/snapshot-landing-data.mjs"

# --check [id-filter]  e.g. `--check batch` checks only claims whose id contains "batch".
# An UNFILTERED --check can never be clean (call_count grows every few minutes), so a gate
# must scope the check to claims whose producer cadence makes staleness meaningful. Default
# filter is `batch` — the daily merkle claims this wave exists to keep honest.
CHECK_MODE=0
CHECK_FILTER="${2:-batch}"
[ "${1:-}" = "--check" ] && CHECK_MODE=1

log() { printf '[%s] [snapshot-landing-daily] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# ── Heartbeat: stamped at job START, BEFORE any conditional work ──────────────────────
# CLAUDE.md: "Producer liveness pages on ATTEMPT recency (heartbeat stamped at job START,
# fail-soft, before conditional work), NOT output recency". Output recency would be
# market/deploy-confounded: a day when the SoT is unreachable produces no change, and an
# output-recency probe would page for a fault that never happened. Attempt recency answers
# the only question the watcher needs — "is this producer still running at all?"
# Never gated behind --check: a check run is still an attempt.
# Fail-SOFT: a heartbeat we cannot write must not stop the re-bake it precedes.
stamp_heartbeat() {
  if ! mkdir -p "$(dirname "$HEARTBEAT")" 2>/dev/null; then
    log "WARN heartbeat_dir_unwritable dir=$(dirname "$HEARTBEAT") — continuing (fail-soft)"
    return 0
  fi
  if date -u +%s > "$HEARTBEAT" 2>/dev/null; then
    log "HEARTBEAT_STAMPED path=$HEARTBEAT epoch=$(cat "$HEARTBEAT" 2>/dev/null)"
  else
    log "WARN heartbeat_write_failed path=$HEARTBEAT — continuing (fail-soft)"
  fi
}

run_body() {
  cd "$REPO_DIR" || { log "ERROR repo_dir_missing dir=$REPO_DIR"; return 0; }

  if [ ! -x "$NODE_BIN" ] && ! command -v node >/dev/null 2>&1; then
    log "ERROR node_not_found bin=$NODE_BIN — cannot re-bake (fail-open)"
    return 0
  fi
  [ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"

  if [ "$CHECK_MODE" = "1" ]; then
    # Manifest-driven staleness check — no writes, no sync. Single-derivation: the injector
    # owns which claims exist, so this never re-encodes a field list; we only scope by id.
    local filter_arg=()
    [ -n "$CHECK_FILTER" ] && [ "$CHECK_FILTER" != "all" ] && filter_arg=("--only=$CHECK_FILTER")
    "$NODE_BIN" "$INJECTOR" --check "${filter_arg[@]}"
    local rc=$?
    if [ "$rc" -eq 0 ]; then
      log "CHECK_CLEAN scope='${CHECK_FILTER}' literals match the live SoT"
    else
      log "CHECK_DRIFT scope='${CHECK_FILTER}' rc=$rc — a re-bake is due"
    fi
    return "$rc"
  fi

  # ── Re-bake ──
  "$NODE_BIN" "$INJECTOR"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    # Only the catastrophic-pattern-drift guard returns non-zero; SoT failures exit 0.
    log "ERROR injector_exit=$rc — NOT syncing to the webroot (refusing to publish a bad bake)"
    return "$rc"
  fi
  log "INJECTOR_OK exit=0"

  # ── Sync to the Caddy webroot ──
  # THE SAME COMMAND deploy.yml uses (.github/workflows/deploy.yml, "Sync static landing
  # pages"): `cp landing/*.html /var/www/algovault/`. Single-derivation — inventing a second
  # sync mechanism here would let the two paths drift, and Caddy serves ONLY this webroot
  # copy (landing/verify.html is NOT in the Docker image).
  local pages=(landing/*.html)
  if cp landing/*.html "$WEBROOT"/ 2>/dev/null; then
    log "WEBROOT_SYNCED dest=$WEBROOT files=${#pages[@]}"
  else
    log "ERROR webroot_sync_failed dest=$WEBROOT (re-bake succeeded; served copy still previous)"
    return 0
  fi
  return 0
}

# ── flock: skip rather than queue ─────────────────────────────────────────────────────
# Standard self-reexec idiom: re-run THIS script under flock, guarded by an env marker so
# the second invocation runs the body. `-E 75` gives lock-conflict a DISTINCT exit code so it
# can never be confused with --check's "drift found" 1 (flock's default conflict code is also
# 1 — that collision would have made a busy lock look like confirmed staleness).
#
# A queued second re-bake has zero value: the next daily run supersedes it.
#
# Honest scoping — this lock is NOT taken by deploy.yml's injector invocation, nor by
# scripts/commit-funnel-snapshot.sh (which runs `git checkout -- .` weekly, Mon ~10:08 UTC,
# discarding injector working-tree edits). Neither can collide with a 00:39 fire, and the
# injector is state-INDEPENDENT — it regex-replaces span CONTENTS, so its output is a
# function of the SoT alone, never of the previous literal. The lock guards cron-vs-cron;
# schedule separation guards the rest. Do not mistake it for protection against those two.
if [ -z "${SNAPSHOT_LANDING_LOCK_HELD:-}" ]; then
  export SNAPSHOT_LANDING_LOCK_HELD=1
  flock -n -E 75 "$LOCK" "$0" "$@"
  rc=$?
  if [ "$rc" -eq 75 ]; then
    # Heartbeat still stamped by the holder; a skipped run is not a missed attempt.
    log "LOCK_BUSY lock=$LOCK — another instance is running; skipping this fire (exit 0)"
    exit 0
  fi
  exit "$rc"
fi

stamp_heartbeat
run_body
exit $?
