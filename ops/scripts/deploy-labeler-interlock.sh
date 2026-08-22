#!/usr/bin/env bash
# deploy-labeler-interlock.sh — OPS-DEPLOY-LABELER-WINDOW-W1 CH2.
#
# THE POLICY, NOT THE MECHANISM. The mechanism already shipped: deploy.yml has SIGTERM'd any
# in-flight nightly labeler before `docker compose up` since OPS-LABEL-FRESHNESS-W1 R2, and it is
# named in src/lib/graceful-stop.ts's own docstring. That preemption is DELIBERATE and it works —
# a truncated run checkpoints at a venue/group boundary and resumes from DB state.
#
# What it never did was answer for its cost: 10 of 32 nightly runs (31.2%, 60d window, measured
# 2026-08-22) ended early, 10 of 10 attributed to a deploy, and NOTHING counted it.
#
# This script changes three things and preserves everything else:
#
#   1. THE WAIT IS DERIVED, NOT GUESSED. It was 30s against a MEASURED max in-flight batch sleep
#      of 57,194 ms — a single sleep could outlast the entire budget, so the loop expired and the
#      deploy proceeded regardless. Nothing has broken yet only because the deploy spends ~40s on
#      git pull + landing sync + build AFTER the wait expires: the real safety margin came from
#      BUILD DURATION, not from the wait. That is incidental slack, and a faster build removes it.
#   2. THREE STATES, NOT TWO. `docker exec` failing (container down, daemon unreachable) used to
#      take the same branch as "no labeler running" and print the same reassuring line. Exit 0 may
#      never encode both "verified, clean" and "verified nothing."
#   3. A CATCH-UP RUN, SLO-GATED. Preemption is kept (it costs zero deploy latency, which is why
#      it survives contact with an operator in a hurry); the harm it causes — a major sitting past
#      its 24h SLO — is repaired afterwards instead of prevented. Skipped entirely when the worst
#      projected lag is already inside SLO, because a preemption at venue 15 of 17 needs no
#      catch-up and running one anyway is recovery chatter.
#
# A HOTFIX IS NEVER BLOCKED. `DEPLOY_HOTFIX=1` bypasses everything, immediately, and the bypass is
# LEDGERED. The hatch is total; it downgrades the outcome only and never launders the verdict — a
# hatch that fails when it is most needed gets replaced by someone doing it manually, which writes
# no record at all.
#
# EVERY PATH WRITES A RECORD. Silent proceed is the defect being fixed; reintroducing it inside
# the fix would be the joke that writes itself.
#
# Verdict token: exactly one terminal INTERLOCK_VERDICT=PROCEED|DEFERRED|BYPASSED|INDETERMINATE.
# ALWAYS exits 0 — this is a deploy interlock, and a deploy must never be blocked by this script's
# own bugs. Callers read the TOKEN.
set -uo pipefail

CTR="${INTERLOCK_CONTAINER:-crypto-quant-signal-mcp-mcp-server-1}"

# THE ONE PLACE the labeler is named. It was a bare literal inside deploy.yml, where a rename of
# the script would silently stop matching with nothing red; `tests/unit/deploy-interlock.test.ts`
# pins this constant to the real file on disk.
LABELER_PATTERN="${INTERLOCK_PATTERN:-dist/scripts/backfill-directional-labels}"
LABELER_SCRIPT_REL="src/scripts/backfill-directional-labels.ts"

# DERIVED, WITH ITS INSTRUMENT — never a round number.
#   max in-flight batch sleep   57,194 ms   (n=400 most recent `wait_ms`, of 4,172 in the log)
# + worst per-group time        38,320 ms   (n=466 venue-summary rows, elapsed/groups)
# = 95,514 ms, +25% margin      ≈ 119,000 ms  -> 120s
# Re-derive from the same two measurements if the venue mix or the weight budget changes; a
# measured baseline is meaningless without its instrument.
WAIT_S="${INTERLOCK_WAIT_S:-120}"

LEDGER="${INTERLOCK_LEDGER:-/var/log/algovault-deploy-interlock.log}"
MARKER="${INTERLOCK_MARKER:-/var/lib/algovault-monitoring/.labeler-preempted}"
TIERS="${INTERLOCK_TIERS:-/opt/algovault-monitoring/venue-slo-tiers.json}"
DOCKER_BIN="${INTERLOCK_DOCKER:-docker}"
# NOTE: DOCKER_BIN is a plain global so the self-test can swap it per case.

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

record() { # record <verdict> <detail>
  printf '%s interlock=%s %s\n' "$(now)" "$1" "$2" | tee -a "$LEDGER" 2>/dev/null || \
    printf '%s interlock=%s %s\n' "$(now)" "$1" "$2"
}

# ── preempt ──────────────────────────────────────────────────────────────────────────────────
cmd_preempt() {
  if [ "${DEPLOY_HOTFIX:-0}" = "1" ]; then
    record BYPASSED "reason=hotfix pattern=$LABELER_PATTERN"
    echo "INTERLOCK_VERDICT=BYPASSED"
    return 0
  fi

  "$DOCKER_BIN" exec "$CTR" pkill -TERM -f "$LABELER_PATTERN" 2>/dev/null
  local rc=$?
  case "$rc" in
    0)
      # In flight. Preempt (policy: preempt + SLO-gated catch-up) and give it the DERIVED budget
      # to reach a boundary. The marker is what tells the post-deploy step a catch-up may be owed.
      mkdir -p "$(dirname "$MARKER")" 2>/dev/null
      echo "$(now)" > "$MARKER" 2>/dev/null
      local waited=0
      while [ "$waited" -lt "$WAIT_S" ]; do
        "$DOCKER_BIN" exec "$CTR" pkill -0 -f "$LABELER_PATTERN" 2>/dev/null || break
        sleep 1
        waited=$((waited + 1))
      done
      if [ "$waited" -ge "$WAIT_S" ]; then
        # The bounded wait EXPIRED. Proceed anyway — a deploy must never hang on a batch job —
        # but say so: this is the branch where a graceful stop can still become a hard kill.
        record DEFERRED "outcome=wait-expired waited_s=$waited budget_s=$WAIT_S"
      else
        record DEFERRED "outcome=checkpointed waited_s=$waited budget_s=$WAIT_S"
      fi
      echo "INTERLOCK_VERDICT=DEFERRED"
      ;;
    1)
      record PROCEED "reason=no-labeler-in-flight"
      echo "INTERLOCK_VERDICT=PROCEED"
      ;;
    *)
      # THE THIRD STATE. `docker exec` could not run at all — container down, daemon unreachable,
      # exec denied. Before this branch existed that was indistinguishable from "nothing running",
      # and printed the same reassuring line. Fail OPEN, visibly: the deploy proceeds.
      record INDETERMINATE "reason=probe-failed docker_exec_rc=$rc"
      echo "INTERLOCK_VERDICT=INDETERMINATE"
      ;;
  esac
  return 0
}

# ── catchup ──────────────────────────────────────────────────────────────────────────────────
# Runs AFTER the container is back. SLO-GATED: skip entirely when the worst projected lag is
# already inside SLO. One per night, inheriting the ORIGINAL run's remaining budget rather than a
# fresh one — a catch-up is repair, not a second nightly.
cmd_catchup() {
  if [ ! -f "$MARKER" ]; then
    record PROCEED "catchup=skipped reason=no-preemption-this-deploy"
    echo "INTERLOCK_VERDICT=PROCEED"
    return 0
  fi
  if [ "${DEPLOY_HOTFIX:-0}" = "1" ]; then
    record BYPASSED "catchup=skipped reason=hotfix"
    echo "INTERLOCK_VERDICT=BYPASSED"
    return 0
  fi

  local worst
  worst=$(worst_projected_lag_ratio)
  if [ -z "$worst" ]; then
    # Could not evaluate the SLO gate. Do NOT run a catch-up on a guess, and do NOT report clean.
    record INDETERMINATE "catchup=skipped reason=slo-gate-unevaluable"
    echo "INTERLOCK_VERDICT=INDETERMINATE"
    return 0
  fi
  if [ "$worst" -lt 100 ]; then
    # Every venue is projected to stay inside its own tier SLO. A preemption at venue 15 of 17
    # with two long-tail venues on 72h SLOs needs no catch-up; running one is recovery chatter.
    rm -f "$MARKER" 2>/dev/null
    record PROCEED "catchup=skipped reason=within-slo worst_lag_pct_of_slo=$worst"
    echo "INTERLOCK_VERDICT=PROCEED"
    return 0
  fi

  local remaining
  remaining=$(remaining_budget_min)
  if [ "$remaining" -le 0 ]; then
    rm -f "$MARKER" 2>/dev/null
    record PROCEED "catchup=skipped reason=no-budget-remaining worst_lag_pct_of_slo=$worst"
    echo "INTERLOCK_VERDICT=PROCEED"
    return 0
  fi

  rm -f "$MARKER" 2>/dev/null
  record DEFERRED "catchup=running worst_lag_pct_of_slo=$worst remaining_budget_min=$remaining"
  # Same flock as the nightly, so a catch-up can never collide with it or with a second deploy.
  flock -n /var/lock/algovault-nightly-carry-labeler-5d062010.lock \
    "$DOCKER_BIN" exec "$CTR" node dist/scripts/backfill-directional-labels.js \
      --lookback-days 21 --time-budget-min "$remaining" --venue-budget-min 45 \
    >> /var/log/carry-labeler.log 2>&1 || true
  echo "INTERLOCK_VERDICT=DEFERRED"
  return 0
}

# Worst projected lag as a PERCENTAGE of that venue's own tier SLO. >=100 means at least one
# venue is projected to breach. Empty output means the gate could not be evaluated.
worst_projected_lag_ratio() {
  if [ -n "${INTERLOCK_WORST_OVERRIDE:-}" ]; then printf '%s' "$INTERLOCK_WORST_OVERRIDE"; return 0; fi
  [ -f "$TIERS" ] || return 0
  "$DOCKER_BIN" exec "$CTR" node -e '
    const { MAJOR_VENUES, sloHoursFor } = require("./dist/lib/venue-slo-tiers.js");
    const { dbQuery } = require("./dist/lib/performance-db.js");
    (async () => {
      const rows = await dbQuery(`SELECT s.exchange, MAX(s.created_at) FILTER (WHERE d.signal_id IS NOT NULL) AS f
        FROM signals s LEFT JOIN directional_labels d ON d.signal_id = s.id AND d.barrier_spec = $1
        WHERE s.signal IN (\x27BUY\x27,\x27SELL\x27) AND s.pfe_return_pct IS NOT NULL AND s.timeframe <> \x271m\x27
        GROUP BY 1`, ["tau1.0-floor0.30-v1"]);
      const now = Date.now() / 1000;
      let worst = 0;
      for (const r of rows) {
        const lagH = (now - Number(r.f || 0)) / 3600;
        worst = Math.max(worst, Math.round((lagH / sloHoursFor(r.exchange)) * 100));
      }
      console.log(worst);
    })().catch(() => process.exit(1));
  ' 2>/dev/null | tail -1 | grep -E '^[0-9]+$' || return 0
}

# The ORIGINAL run's remaining budget — a catch-up inherits it rather than getting a fresh one.
remaining_budget_min() {
  if [ -n "${INTERLOCK_REMAINING_OVERRIDE:-}" ]; then printf '%s' "$INTERLOCK_REMAINING_OVERRIDE"; return 0; fi
  local log="${INTERLOCK_LABELER_LOG:-/var/log/carry-labeler.log}"
  [ -f "$log" ] || { printf '0'; return 0; }
  python3 - "$log" <<'PY' 2>/dev/null || printf '0'
import re, sys
from datetime import datetime, timezone
lines = open(sys.argv[1], errors="replace").read().split("\n")
starts = [l for l in lines if "DWR backfill start" in l]
if not starts:
    print(0); raise SystemExit
last = starts[-1]
m = re.match(r"\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\]", last)
b = re.search(r"budget=(\d+)m", last)
if not (m and b):
    print(0); raise SystemExit
started = datetime.fromisoformat(m.group(1).replace("Z", "+00:00"))
used = (datetime.now(timezone.utc) - started).total_seconds() / 60
print(max(0, int(int(b.group(1)) - used)))
PY
}

# ── self-test ────────────────────────────────────────────────────────────────────────────────
cmd_self_test() {
  local fails=0 n=0
  ck() { n=$((n+1)); if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 — got '$2', want '$3'"; fails=$((fails+1)); fi; }
  local tmp; tmp=$(mktemp -d)
  # Assign the GLOBALS directly. The config constants resolve at script LOAD, so exporting
  # INTERLOCK_* here would arrive too late and the self-test would silently drive the real
  # /var/log ledger — a test seam that misses its own target, which is the class this estate
  # keeps retiring. Caught by the first run of this very self-test.
  LEDGER="$tmp/ledger"; MARKER="$tmp/marker"; WAIT_S=2; TIERS="$tmp/tiers.json"
  : > "$LEDGER"; echo '{}' > "$TIERS"
  printf '#!/bin/sh\nexit 0\n' > "$tmp/rc0.sh"
  printf '#!/bin/sh\nexit 1\n' > "$tmp/rc1.sh"
  printf '#!/bin/sh\nexit 7\n' > "$tmp/rc7.sh"
  chmod +x "$tmp"/rc*.sh

  echo "deploy-labeler-interlock --self-test"
  # A hotfix ALWAYS proceeds, whatever the probe would have said. Env goes INSIDE the
  # substitution — a prefix on `ck` applies to ck, not to the subshell that produced its argument.
  ck "hotfix ALWAYS bypasses" \
     "$(DEPLOY_HOTFIX=1 DOCKER_BIN=/bin/false cmd_preempt | tail -1)" "INTERLOCK_VERDICT=BYPASSED"
  ck "the hotfix bypass is LEDGERED, never laundered" "$(grep -c 'interlock=BYPASSED' "$LEDGER")" "1"

  # An unreachable probe fails OPEN with the third state — never closed, never "clean".
  ck "probe failure is INDETERMINATE" \
     "$(DOCKER_BIN=$tmp/rc7.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=INDETERMINATE"
  ck "probe failure is NOT reported as PROCEED" "$(grep -c 'interlock=PROCEED' "$LEDGER")" "0"
  ck "probe failure records the rc that caused it" "$(grep -c 'docker_exec_rc=7' "$LEDGER")" "1"

  ck "no labeler in flight proceeds" \
     "$(DOCKER_BIN=$tmp/rc1.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=PROCEED"

  # In flight -> deferred, and the bounded wait EXPIRES rather than hanging.
  local t0 t1; t0=$(date +%s)
  ck "in flight defers" "$(DOCKER_BIN=$tmp/rc0.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=DEFERRED"
  t1=$(date +%s)
  ck "the bounded wait EXPIRED rather than hanging" "$([ $((t1-t0)) -le 8 ] && echo yes)" "yes"
  ck "wait-expiry is recorded, not silent" "$(grep -c 'wait-expired' "$LEDGER")" "1"
  ck "a preemption leaves the catch-up marker" "$([ -f "$MARKER" ] && echo yes)" "yes"

  # Catch-up: the SLO gate skips when everything is projected inside SLO.
  ck "catch-up SKIPS when inside SLO" \
     "$(INTERLOCK_WORST_OVERRIDE=80 DOCKER_BIN=$tmp/rc0.sh cmd_catchup | tail -1)" "INTERLOCK_VERDICT=PROCEED"
  ck "the within-SLO skip is recorded" "$(grep -c 'reason=within-slo' "$LEDGER")" "1"

  # ... and does not run when the original run's budget is already spent.
  date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
  ck "catch-up SKIPS with no budget remaining" \
     "$(INTERLOCK_WORST_OVERRIDE=140 INTERLOCK_REMAINING_OVERRIDE=0 DOCKER_BIN=$tmp/rc0.sh cmd_catchup | tail -1)" \
     "INTERLOCK_VERDICT=PROCEED"

  ck "no preemption means no catch-up" \
     "$(DOCKER_BIN=$tmp/rc0.sh cmd_catchup | tail -1)" "INTERLOCK_VERDICT=PROCEED"

  # An unevaluable SLO gate is INDETERMINATE — never a silent catch-up, never a silent skip.
  date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
  TIERS=/nonexistent
  ck "unevaluable SLO gate is INDETERMINATE" \
     "$(DOCKER_BIN=$tmp/rc0.sh cmd_catchup | tail -1)" "INTERLOCK_VERDICT=INDETERMINATE"
  TIERS="$tmp/tiers.json"

  # A hotfix skips the catch-up too, and says so.
  date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
  ck "hotfix skips the catch-up as well" \
     "$(DEPLOY_HOTFIX=1 DOCKER_BIN=$tmp/rc0.sh cmd_catchup | tail -1)" "INTERLOCK_VERDICT=BYPASSED"

  # EVERY VERDICT CLASS reached the ledger — silent proceed is the defect being fixed, and a
  # magic row COUNT would only pin how many cases this self-test happens to have. What matters is
  # that no class can go unrecorded.
  local missing=""
  for v in BYPASSED PROCEED DEFERRED INDETERMINATE; do
    grep -q "interlock=$v" "$LEDGER" || missing="$missing $v"
  done
  ck "every verdict class reached the ledger" "${missing:-none}" "none"
  # The pattern must match the REAL script, or a rename silently disarms the interlock with
  # nothing red. The vitest suite pins this against the file on disk; this is the in-script half.
  local base; base=$(basename "$LABELER_PATTERN")
  local matched=no
  [ "${LABELER_SCRIPT_REL#*$base}" != "$LABELER_SCRIPT_REL" ] && matched=yes
  ck "the pattern matches the real script path" "$matched" "yes"

  rm -rf "$tmp"
  if [ "$fails" -gt 0 ]; then echo "SELF-TEST: $fails of $n failed"; echo "INTERLOCK_VERDICT=INDETERMINATE"; return 1; fi
  echo "SELF-TEST: PASS — $n checks"
  echo "INTERLOCK_VERDICT=PROCEED"
  return 0
}

case "${1:-}" in
  preempt)   cmd_preempt ;;
  catchup)   cmd_catchup ;;
  --self-test) cmd_self_test ;;
  --print-pattern) printf '%s\n' "$LABELER_PATTERN" ;;
  --print-script)  printf '%s\n' "$LABELER_SCRIPT_REL" ;;
  --print-wait)    printf '%s\n' "$WAIT_S" ;;
  *) echo "usage: $0 preempt|catchup|--self-test|--print-pattern|--print-script|--print-wait" >&2; exit 2 ;;
esac
