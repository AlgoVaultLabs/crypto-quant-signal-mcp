#!/usr/bin/env bash
# deploy-cron-interlock.sh — OPS-DEPLOY-INTERLOCK-CRON-DEFER-W1.
# (was deploy-labeler-interlock.sh — OPS-DEPLOY-LABELER-WINDOW-W1 CH2. Renamed because the name
#  stopped describing the scope: a name that lies is the defect OPS-HOST-KERNEL-REBOOT-W3 CH3
#  retired for alert copy, so the rename shipped WITH the generalization, not after it.)
#
# THE POLICY, NOT THE MECHANISM. The mechanism already shipped: deploy.yml has SIGTERM'd any
# in-flight nightly labeler before `docker compose up` since OPS-LABEL-FRESHNESS-W1 R2, and it is
# named in src/lib/graceful-stop.ts's own docstring. That preemption is DELIBERATE and it works —
# a truncated run checkpoints at a venue/group boundary and resumes from DB state.
#
# What it never did was answer for its cost: 10 of 32 nightly runs (31.2%, 60d window, measured
# 2026-08-22) ended early, 10 of 10 attributed to a deploy, and NOTHING counted it.
#
# ── WHAT THIS WAVE CHANGED, AND WHY ─────────────────────────────────────────────────────────
# The deploy runs `docker compose up -d --build --force-recreate`, which recreates mcp-server,
# facilitator AND postgres. EVERY `docker exec` into any of the three dies at that instant. Until
# now exactly ONE of them was protected, by a pattern hardcoded in this file — so every other long
# cron was unprotected BY DEFAULT and nothing went red when a new one appeared. That default is
# the retired bug class.
#
# THE PROTECTED SET IS NOW DATA: ops/scripts/cron-interlock-registry.json, one row per process
# pattern, each carrying a CLASS and a MANDATORY reason:
#
#   safe-to-kill         atomic-replace publish, checkpoint-resumable, or idempotent on next fire.
#                        The deploy does NOTHING. The row exists so a future reader sees the job
#                        was CONSIDERED, not missed.
#   preempt-and-catchup  killing loses work a bounded catch-up can repair. The labeler's shape.
#   no-safe-kill         neither. Bounded wait for it to drain ON ITS OWN — never a SIGTERM, since
#                        killing is precisely what is unsafe — then PROCEED ANYWAY with a loud
#                        DEFERRED record. A deploy must never hang on a batch job.
#
# A row whose `class` is unknown or whose `reason` is missing/empty is INDETERMINATE, never a
# silent safe-to-kill. Same convention as schedule-boundary-rule.json's exemptions.
#
# scripts/check-cron-interlock-coverage.mjs fails the BUILD when an ops/cron/*.sh gains a
# command-position `docker exec` with no registry row — so "unprotected by default" is now
# "unbuildable by default".
#
# ── THE THREE THINGS THE ORIGINAL CHANGED, ALL PRESERVED ────────────────────────────────────
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
# LEDGERED. The hatch is TOTAL — it does not even load the registry, because a hatch that depends
# on the thing it is bypassing is not a hatch. It downgrades the outcome only and never launders
# the verdict.
#
# EVERY PATH WRITES A RECORD. Silent proceed is the defect being fixed; reintroducing it inside
# the fix would be the joke that writes itself. Positive PER-JOB output goes to stdout as one
# `INTERLOCK_JOB=<id> class=<class> outcome=<what happened>` line per row, on every path including
# the ones that did nothing — a row skipped by a load error must never look like a row that passed.
#
# ── VERDICT TOKEN, AND ITS PRECEDENCE ───────────────────────────────────────────────────────
# Exactly ONE terminal INTERLOCK_VERDICT=PROCEED|DEFERRED|BYPASSED|INDETERMINATE, aggregated over
# every row. The precedence is EXPLICIT, because an aggregate whose precedence is implicit is how
# two meanings end up sharing one token:
#
#   BYPASSED  (hotfix set)      >  INDETERMINATE  (any job)  >  DEFERRED  (any job)  >  PROCEED
#
# BYPASSED wins outright: the operator said "do not evaluate", and an evaluation result printed
# over that would misrepresent what happened. INDETERMINATE beats DEFERRED because "we could not
# tell" must never be reported as the weaker, more specific "we told, and waited".
#
# A registry that fails to load ⇒ INTERLOCK_VERDICT=INDETERMINATE, exit 0, the deploy proceeds.
# Fail OPEN and LOUD — never fail closed on a deploy path.
#
# OPS-DEPLOY-CATCHUP-DETACH-W1 — `DEFERRED` from `catchup` means "the catch-up was LAUNCHED",
# not "the catch-up ran". Its outcome arrives as a LATER ledger row written by the detached runner
# (`catchup=finished|lock-held|failed`). The token SET is unchanged, every path still exits 0, and
# no caller reads anything but the token — but a ledger reader must pair `catchup=launched` with
# its completion row rather than treating the first row as terminal.
#
# LEDGER FORMAT — one declared change this wave. Every record now carries a leading `job=<id>`
# field (`job=*` for records about the invocation rather than one row). With more than one job in
# scope a ledger row that cannot say WHICH job it describes is unreadable, and nothing machine-
# parses this file (grepped 2026-08-29 across the repo and /opt/algovault-monitoring: zero
# consumers). Everything after that field is byte-identical for carry-labeler, and
# tests/unit/deploy-interlock.test.ts proves it by fixture rather than by inspection.
#
# ALWAYS exits 0 — this is a deploy interlock, and a deploy must never be blocked by this script's
# own bugs. Callers read the TOKEN.
set -uo pipefail

CTR="${INTERLOCK_CONTAINER:-crypto-quant-signal-mcp-mcp-server-1}"

# THE ONE PLACE the labeler is named. It was a bare literal inside deploy.yml, where a rename of
# the script would silently stop matching with nothing red; `tests/unit/deploy-interlock.test.ts`
# pins this constant to the real file on disk. It is ALSO the `process_pattern` of the registry's
# carry-labeler row, and --self-test asserts the two agree — a registry that disagreed with this
# constant would silently disarm the one job that was already protected.
LABELER_PATTERN="${INTERLOCK_PATTERN:-dist/scripts/backfill-directional-labels}"
LABELER_SCRIPT_REL="src/scripts/backfill-directional-labels.ts"

# DERIVED, WITH ITS INSTRUMENT — never a round number.
#   max in-flight batch sleep   57,194 ms   (n=400 most recent `wait_ms`, of 4,172 in the log)
# + worst per-group time        38,320 ms   (n=466 venue-summary rows, elapsed/groups)
# = 95,514 ms, +25% margin      ≈ 119,000 ms  -> 120s
# Re-derive from the same two measurements if the venue mix or the weight budget changes; a
# measured baseline is meaningless without its instrument.
#
# It is ALSO the drain budget for a `no-safe-kill` row, and that reuse is deliberate rather than
# lazy: both budgets answer the same question — how long may a deploy stand still for a batch job
# — and the measured no-safe-kill population maxes at 7s (publish-merkle-batch), an order of
# magnitude inside it. A second tunable would need a second derivation and would drift from this
# one with nothing to catch it.
WAIT_S="${INTERLOCK_WAIT_S:-120}"

LEDGER="${INTERLOCK_LEDGER:-/var/log/algovault-deploy-interlock.log}"
# OPS-DEPLOY-CATCHUP-DETACH-W1: absolute path to THIS script, so the detached runner re-enters the
# same file the deploy invoked. Resolved rather than assumed — deploy.yml calls it by absolute path
# from the checkout, but a relative $0 would break the moment anyone invokes it from another cwd.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
# The DECLARED protected set. Beside its only consumer — this file — and NOT in ops/monitoring/,
# because check-declaration-coverage.mjs pins CONSUMER_DIRS = ['ops/monitoring','ops/cron'] and a
# declaration read only from ops/scripts/ would have zero readers there and sit half-declared. It
# needs no sync: deploy.yml runs `git reset --hard origin/main` BEFORE invoking this script, so the
# registry is always current at the only moment it is ever read.
REGISTRY="${INTERLOCK_REGISTRY:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cron-interlock-registry.json}"
# Registry parsing goes through python3, which this script ALREADY required for
# remaining_budget_min — so the dependency set is unchanged. Deliberately not `jq`: `jq -e` is a
# vacuity hole on containers (it exits 0 for [] and {}), and this repo lints that shape out.
# Seamed so --self-test can drive the load-failure branch without deleting an interpreter.
PY_BIN="${INTERLOCK_PY:-python3}"
# Anything the detached runner writes OUTSIDE the ledger (a setsid/exec failure before the record).
# Without this the one failure mode that loses the runner entirely would be silent.
RUNNER_LOG="${INTERLOCK_RUNNER_LOG:-/var/log/algovault-deploy-interlock-runner.log}"
# The backfill's own stdout/stderr. Seamed so --self-test can exercise the runner off-host;
# an unwritable redirect target fails the command BEFORE it runs, which would have made the
# outcome checks below test nothing at all.
CARRY_LOG="${INTERLOCK_CARRY_LOG:-/var/log/carry-labeler.log}"
# The carry-labeler's preemption marker. Its DEFAULT is unchanged, so an existing marker on the
# host is still found after this rename. Other preempt-and-catchup rows derive theirs from the
# same directory via marker_for() — one declared location, no second constant.
MARKER="${INTERLOCK_MARKER:-/var/lib/algovault-monitoring/.labeler-preempted}"
TIERS="${INTERLOCK_TIERS:-/opt/algovault-monitoring/venue-slo-tiers.json}"
DOCKER_BIN="${INTERLOCK_DOCKER:-docker}"
# OPS-DEPLOY-CATCHUP-DETACH-W1: how the catch-up is detached from the deploy's SSH session.
# `setsid` gives it a new session and process group, so it is not in the group the SSH action
# signals on teardown. Overridable ONLY so `--self-test` can drive the runner synchronously —
# and the self-test asserts this DEFAULT string too (`--print-detach`), because a hermetic test
# that replaces a seam is structurally blind to exactly what it replaced.
DETACH_BIN="${INTERLOCK_DETACH:-setsid}"
# `flock` is util-linux too — present on the host, ABSENT on macOS. Seamed for the same reason as
# DETACH_BIN: without it the runner's three outcomes cannot be driven deterministically off-host,
# and an untestable branch is how "lock held" stayed indistinguishable from "ran" in the first
# place. The real default is asserted in --self-test.
FLOCK_BIN="${INTERLOCK_FLOCK:-flock}"
# NOTE: DOCKER_BIN is a plain global so the self-test can swap it per case.

# The legacy row. Named once so the carry-labeler special cases below cannot drift apart.
LEGACY_JOB_ID="carry-labeler"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

record() { # record <verdict> <detail>
  printf '%s interlock=%s %s\n' "$(now)" "$1" "$2" | tee -a "$LEDGER" 2>/dev/null || \
    printf '%s interlock=%s %s\n' "$(now)" "$1" "$2"
}

# POSITIVE PER-JOB OUTPUT. Printed for every row on every path — including rows the interlock
# deliberately did nothing about, and rows it could not classify. A row that produced no line is
# indistinguishable from a row that passed, which is the whole defect class this file exists in.
job_line() { # job_line <id> <class> <outcome> <detail>
  printf 'INTERLOCK_JOB=%s class=%s outcome=%s %s\n' "$1" "$2" "$3" "${4:-}"
}

# ── aggregate verdict ────────────────────────────────────────────────────────────────────────
# Precedence, stated once and implemented once: BYPASSED > INDETERMINATE > DEFERRED > PROCEED.
AGG="PROCEED"
bump() { # bump <verdict>
  case "$1" in
    BYPASSED)      AGG="BYPASSED" ;;
    INDETERMINATE) [ "$AGG" = "BYPASSED" ] || AGG="INDETERMINATE" ;;
    DEFERRED)      case "$AGG" in BYPASSED|INDETERMINATE) ;; *) AGG="DEFERRED" ;; esac ;;
    PROCEED)       ;;   # the floor; never lowers anything
  esac
}
emit_agg() { echo "INTERLOCK_VERDICT=$AGG"; }

# ── registry ─────────────────────────────────────────────────────────────────────────────────
# Emits one TAB-separated row per registry entry: id, container, process_pattern, class.
# `class` is rewritten to INDETERMINATE when the row is unusable (unknown class, or a missing /
# empty reason) — an unclassifiable row is never silently a safe-to-kill.
#
# Non-zero exit means the registry could not be LOADED AT ALL (absent, unparseable, no rows).
# That is a different fact from "a row is bad", and the caller answers it differently.
registry_rows() {
  [ -f "$REGISTRY" ] || return 1
  "$PY_BIN" - "$REGISTRY" <<'PY'
import json, sys
VALID = ("safe-to-kill", "preempt-and-catchup", "no-safe-kill")
try:
    doc = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(1)
rows = doc.get("rows")
# A registry WE author is a CONSTRUCTED corpus, so an empty declaration is vacuity and must
# refuse — the same rule that lets this script stay permissive about the world's input.
if not isinstance(rows, list) or not rows:
    sys.exit(1)
out = []
for r in rows:
    if not isinstance(r, dict):
        sys.exit(1)
    rid = str(r.get("id") or "").strip()
    if not rid:
        sys.exit(1)
    cls = str(r.get("class") or "").strip()
    reason = str(r.get("reason") or "").strip()
    if cls not in VALID or not reason:
        cls = "INDETERMINATE"
    out.append("\t".join([rid, str(r.get("container") or ""), str(r.get("process_pattern") or ""), cls]))
print("\n".join(out))
PY
}

# Where a preempt-and-catchup row records that it was preempted. carry-labeler keeps the LEGACY
# path verbatim so an existing host marker survives this rename; anything else derives a sibling.
marker_for() { # marker_for <id>
  if [ "$1" = "$LEGACY_JOB_ID" ]; then printf '%s' "$MARKER"; else printf '%s/.%s-preempted' "$(dirname "$MARKER")" "$1"; fi
}

# ── preempt ──────────────────────────────────────────────────────────────────────────────────
cmd_preempt() {
  AGG="PROCEED"
  if [ "${DEPLOY_HOTFIX:-0}" = "1" ]; then
    # TOTAL, and deliberately BEFORE the registry load: a hatch that can fail because the thing it
    # bypasses is broken is not a hatch.
    record BYPASSED "job=* reason=hotfix pattern=$LABELER_PATTERN"
    job_line '*' hotfix bypassed "registry not evaluated — DEPLOY_HOTFIX=1 is total"
    bump BYPASSED; emit_agg; return 0
  fi

  local rows
  if ! rows="$(registry_rows 2>/dev/null)" || [ -z "$rows" ]; then
    # FAIL OPEN AND LOUD. The deploy proceeds; the token says we verified nothing.
    record INDETERMINATE "job=* reason=registry-unloadable path=$REGISTRY"
    job_line '*' unknown registry-unloadable "no job was evaluated — $REGISTRY absent, unparseable, or empty"
    bump INDETERMINATE; emit_agg; return 0
  fi

  local safe_n=0 id ctr pat cls
  while IFS=$'\t' read -r id ctr pat cls; do
    [ -n "$id" ] || continue
    case "$cls" in
      safe-to-kill)
        safe_n=$((safe_n + 1))
        job_line "$id" "$cls" none "classified safe to kill; the deploy does not probe or wait"
        ;;
      preempt-and-catchup) job_preempt_catchup "$id" "${ctr:-$CTR}" "$pat" ;;
      no-safe-kill)        job_no_safe_kill    "$id" "${ctr:-$CTR}" "$pat" ;;
      *)
        record INDETERMINATE "job=$id reason=unclassifiable-row class=${cls:-<empty>}"
        job_line "$id" "${cls:-<empty>}" unclassifiable "unknown class or missing/empty reason — never a silent safe-to-kill"
        bump INDETERMINATE
        ;;
    esac
  done <<< "$rows"

  # ONE bounded summary row for the whole safe-to-kill set. Seventeen individual ledger rows per
  # deploy would be recovery chatter; the per-job stdout lines above are the positive output.
  [ "$safe_n" -gt 0 ] && record PROCEED "job=* class=safe-to-kill n=$safe_n action=none"
  emit_agg
  return 0
}

# The labeler's shape, now driven by a row. SIGTERM, give it the DERIVED budget to reach a
# checkpoint, leave a marker so `catchup` knows a repair may be owed.
job_preempt_catchup() { # <id> <container> <pattern>
  local id="$1" ctr="$2" pat="$3" mk; mk="$(marker_for "$id")"
  "$DOCKER_BIN" exec "$ctr" pkill -TERM -f "$pat" 2>/dev/null
  local rc=$?
  case "$rc" in
    0)
      # In flight. Preempt (policy: preempt + SLO-gated catch-up) and give it the DERIVED budget
      # to reach a boundary. The marker is what tells the post-deploy step a catch-up may be owed.
      mkdir -p "$(dirname "$mk")" 2>/dev/null
      echo "$(now)" > "$mk" 2>/dev/null
      local waited=0
      while [ "$waited" -lt "$WAIT_S" ]; do
        "$DOCKER_BIN" exec "$ctr" pkill -0 -f "$pat" 2>/dev/null || break
        sleep 1
        waited=$((waited + 1))
      done
      if [ "$waited" -ge "$WAIT_S" ]; then
        # The bounded wait EXPIRED. Proceed anyway — a deploy must never hang on a batch job —
        # but say so: this is the branch where a graceful stop can still become a hard kill.
        record DEFERRED "job=$id outcome=wait-expired waited_s=$waited budget_s=$WAIT_S"
        job_line "$id" preempt-and-catchup wait-expired "SIGTERM sent; no checkpoint within ${WAIT_S}s — proceeding, catch-up owed"
      else
        record DEFERRED "job=$id outcome=checkpointed waited_s=$waited budget_s=$WAIT_S"
        job_line "$id" preempt-and-catchup checkpointed "SIGTERM sent; checkpointed in ${waited}s — catch-up owed"
      fi
      bump DEFERRED
      ;;
    1)
      record PROCEED "job=$id reason=no-labeler-in-flight"
      job_line "$id" preempt-and-catchup not-in-flight "nothing matching the pattern is running"
      ;;
    *)
      # THE THIRD STATE. `docker exec` could not run at all — container down, daemon unreachable,
      # exec denied. Before this branch existed that was indistinguishable from "nothing running",
      # and printed the same reassuring line. Fail OPEN, visibly: the deploy proceeds.
      record INDETERMINATE "job=$id reason=probe-failed docker_exec_rc=$rc"
      job_line "$id" preempt-and-catchup probe-failed "docker exec rc=$rc — could not tell whether it is running"
      bump INDETERMINATE
      ;;
  esac
}

# NEVER SIGTERM. For this class the kill IS the harm, so the only lever is to wait for the job to
# finish on its own — and then proceed regardless, because a deploy that can be held open by a
# batch job is a worse failure than the one being avoided.
job_no_safe_kill() { # <id> <container> <pattern>
  local id="$1" ctr="$2" pat="$3"
  "$DOCKER_BIN" exec "$ctr" pkill -0 -f "$pat" 2>/dev/null
  local rc=$?
  case "$rc" in
    0)
      local waited=0
      while [ "$waited" -lt "$WAIT_S" ]; do
        sleep 1
        waited=$((waited + 1))
        "$DOCKER_BIN" exec "$ctr" pkill -0 -f "$pat" 2>/dev/null || break
      done
      if [ "$waited" -ge "$WAIT_S" ]; then
        record DEFERRED "job=$id outcome=no-safe-kill-wait-expired waited_s=$waited budget_s=$WAIT_S"
        job_line "$id" no-safe-kill wait-expired "still running after ${WAIT_S}s — PROCEEDING ANYWAY; this job has no safe kill and no repair"
        bump DEFERRED
      else
        record PROCEED "job=$id outcome=no-safe-kill-drained waited_s=$waited budget_s=$WAIT_S"
        job_line "$id" no-safe-kill drained "finished on its own after ${waited}s; nothing was killed"
      fi
      ;;
    1)
      record PROCEED "job=$id reason=not-in-flight"
      job_line "$id" no-safe-kill not-in-flight "nothing matching the pattern is running"
      ;;
    *)
      record INDETERMINATE "job=$id reason=probe-failed docker_exec_rc=$rc"
      job_line "$id" no-safe-kill probe-failed "docker exec rc=$rc — could not tell whether it is running"
      bump INDETERMINATE
      ;;
  esac
}

# ── catchup ──────────────────────────────────────────────────────────────────────────────────
# Runs AFTER the container is back, for every preempt-and-catchup row that left a marker.
# SLO-GATED: skip entirely when the worst projected lag is already inside SLO. One per night,
# inheriting the ORIGINAL run's remaining budget rather than a fresh one — a catch-up is repair,
# not a second nightly.
cmd_catchup() {
  AGG="PROCEED"
  if [ "${DEPLOY_HOTFIX:-0}" = "1" ]; then
    record BYPASSED "job=* catchup=skipped reason=hotfix"
    job_line '*' hotfix bypassed "registry not evaluated — DEPLOY_HOTFIX=1 is total"
    bump BYPASSED; emit_agg; return 0
  fi

  local rows
  if ! rows="$(registry_rows 2>/dev/null)" || [ -z "$rows" ]; then
    record INDETERMINATE "job=* catchup=skipped reason=registry-unloadable path=$REGISTRY"
    job_line '*' unknown registry-unloadable "no catch-up was evaluated — $REGISTRY absent, unparseable, or empty"
    bump INDETERMINATE; emit_agg; return 0
  fi

  local id ctr pat cls mk
  while IFS=$'\t' read -r id ctr pat cls; do
    [ -n "$id" ] || continue
    if [ "$cls" = "INDETERMINATE" ]; then
      record INDETERMINATE "job=$id catchup=skipped reason=unclassifiable-row"
      job_line "$id" '<empty>' unclassifiable "unknown class or missing/empty reason — no catch-up attempted"
      bump INDETERMINATE; continue
    fi
    [ "$cls" = "preempt-and-catchup" ] || continue
    mk="$(marker_for "$id")"
    if [ ! -f "$mk" ]; then
      record PROCEED "job=$id catchup=skipped reason=no-preemption-this-deploy"
      job_line "$id" "$cls" no-catchup-owed "no marker — this deploy preempted nothing"
      continue
    fi
    if [ "$id" = "$LEGACY_JOB_ID" ]; then
      job_catchup_labeler "$id" "$mk"
    else
      # REFUSE rather than guess. The SLO gate and the budget arithmetic below are the LABELER's —
      # they read venue-slo-tiers.json and parse the carry log. A second preempt-and-catchup row
      # needs its own gate declared before a catch-up can be run for it, and inventing one here
      # would be a scheduler built for a population of one. Loud INDETERMINATE, never a silent
      # skip: the row asked for a repair and did not get one.
      rm -f "$mk" 2>/dev/null
      record INDETERMINATE "job=$id catchup=skipped reason=no-gate-declared-for-this-row"
      job_line "$id" "$cls" catchup-unsupported "preempted, but this row declares no SLO gate — repair NOT run"
      bump INDETERMINATE
    fi
  done <<< "$rows"

  emit_agg
  return 0
}

job_catchup_labeler() { # <id> <marker>
  local id="$1" mk="$2" worst remaining
  worst=$(worst_projected_lag_ratio)
  if [ -z "$worst" ]; then
    # Could not evaluate the SLO gate. Do NOT run a catch-up on a guess, and do NOT report clean.
    record INDETERMINATE "job=$id catchup=skipped reason=slo-gate-unevaluable"
    job_line "$id" preempt-and-catchup slo-gate-unevaluable "tiers file unreadable — no catch-up on a guess"
    bump INDETERMINATE; return 0
  fi
  if [ "$worst" -lt 100 ]; then
    # Every venue is projected to stay inside its own tier SLO. A preemption at venue 15 of 17
    # with two long-tail venues on 72h SLOs needs no catch-up; running one is recovery chatter.
    rm -f "$mk" 2>/dev/null
    record PROCEED "job=$id catchup=skipped reason=within-slo worst_lag_pct_of_slo=$worst"
    job_line "$id" preempt-and-catchup within-slo "worst projected lag ${worst}% of SLO — no repair owed"
    return 0
  fi

  remaining=$(remaining_budget_min)
  if [ "$remaining" -le 0 ]; then
    rm -f "$mk" 2>/dev/null
    record PROCEED "job=$id catchup=skipped reason=no-budget-remaining worst_lag_pct_of_slo=$worst"
    job_line "$id" preempt-and-catchup no-budget "the original run's budget is spent; the next nightly owns it"
    return 0
  fi

  rm -f "$mk" 2>/dev/null
  # LAUNCHED, not "running" — it has not run yet, and the word is the difference between a record
  # that is true when written and one that is a prediction.
  # `setsid` is util-linux and is NOT present on macOS, where --self-test and the pre-push gate
  # run. A missing binary would make the launch below fail into a discarded `&` — the catch-up
  # silently never runs, which is precisely the silent-proceed defect this script exists to end.
  # So the mode is PROBED and RECORDED, and the degraded path still runs the work.
  local detach_mode="$DETACH_BIN"
  command -v "$DETACH_BIN" >/dev/null 2>&1 || detach_mode="degraded-no-$DETACH_BIN"
  record DEFERRED "job=$id catchup=launched worst_lag_pct_of_slo=$worst remaining_budget_min=$remaining detach=$detach_mode"
  job_line "$id" preempt-and-catchup catchup-launched "detached repair started (detach=$detach_mode); its outcome arrives as a later ledger row"
  bump DEFERRED
  # OPS-DEPLOY-CATCHUP-DETACH-W1 — DETACHED, ALWAYS. This used to run in the FOREGROUND, and the
  # deploy's SSH action (~10 min) would time out waiting on a backfill budgeted up to 125 min. The
  # deploy had already fully succeeded — containers recreated, GIT_SHA advanced — so the workflow
  # reported FAILURE on a healthy deploy. A red badge that means "deployed fine" is worse than no
  # badge: it trains an operator to ignore deploy failures and will mask a real one.
  #
  # Detaching costs NOTHING that was previously gained. Measured 2026-08-23 on run 32616428011:
  # the backfill was still running on the host 72 minutes AFTER the SSH action was killed, so the
  # child already outlived the session. Blocking the parent bought no supervision — only the false
  # red. There is deliberately no "detach only if the budget is large" branch: two paths would
  # mean the rare one is never exercised, and its threshold would drift from the action's real
  # timeout with nothing to catch it.
  #
  # The runner records its OWN terminal outcome, so "launched" is always answered by a later row.
  if [ "$detach_mode" = "$DETACH_BIN" ]; then
    "$DETACH_BIN" "$SELF" --catchup-runner "$remaining" </dev/null >>"$RUNNER_LOG" 2>&1 &
  else
    # No session-detach available: a plain background job still frees the deploy, and `disown`
    # keeps it off this shell's job table. Weaker than setsid (same process group), but the work
    # RUNS and the ledger says which mode produced it.
    "$SELF" --catchup-runner "$remaining" </dev/null >>"$RUNNER_LOG" 2>&1 &
    disown 2>/dev/null || true
  fi
  return 0
}

# ── catchup runner ───────────────────────────────────────────────────────────────────────────
# The detached half. Runs the backfill and writes the TERMINAL record for it.
#
# Three outcomes, distinguishable — the old inline call had ONE. `flock -n` is NON-BLOCKING, so
# when the nightly holds the lock it returns immediately having run nothing, and the old `|| true`
# swallowed that: the ledger said `catchup=running` for a catch-up that never ran. "Ran to budget",
# "lock was held" and "the container failed" were one indistinguishable line.
cmd_catchup_runner() {
  local remaining="${1:-0}" t0 t1 rc
  t0=$(date +%s)
  # Same flock as the nightly, so a catch-up can never collide with it or with a second deploy.
  "$FLOCK_BIN" -n /var/lock/algovault-nightly-carry-labeler-5d062010.lock \
    "$DOCKER_BIN" exec "$CTR" node dist/scripts/backfill-directional-labels.js \
      --lookback-days 21 --time-budget-min "$remaining" --venue-budget-min 45 \
    >> "$CARRY_LOG" 2>&1
  rc=$?
  t1=$(date +%s)
  if [ "$rc" -eq 0 ]; then
    record DEFERRED "job=$LEGACY_JOB_ID catchup=finished rc=0 duration_s=$((t1-t0))"
  elif [ "$rc" -eq 1 ]; then
    # flock -n could not acquire: the nightly (or another deploy's catch-up) holds it. NOTHING ran.
    record DEFERRED "job=$LEGACY_JOB_ID catchup=lock-held duration_s=$((t1-t0))"
  else
    record DEFERRED "job=$LEGACY_JOB_ID catchup=failed rc=$rc duration_s=$((t1-t0))"
  fi
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
  "$PY_BIN" - "$log" <<'PY' 2>/dev/null || printf '0'
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
  local REAL_REGISTRY="$REGISTRY"
  LEDGER="$tmp/ledger"; MARKER="$tmp/marker"; WAIT_S=2; TIERS="$tmp/tiers.json"; RUNNER_LOG="$tmp/runner.log"; CARRY_LOG="$tmp/carry.log"
  : > "$LEDGER"; echo '{}' > "$TIERS"
  printf '#!/bin/sh\nexit 0\n' > "$tmp/rc0.sh"
  printf '#!/bin/sh\nexit 1\n' > "$tmp/rc1.sh"
  printf '#!/bin/sh\nexit 7\n' > "$tmp/rc7.sh"
  chmod +x "$tmp"/rc*.sh

  # Fixture registries, built HERE rather than pointed at the real file, so each dispatch case is
  # driven deterministically. The real file is asserted separately at the end, because a hermetic
  # test is structurally blind to exactly what its seam replaces.
  reg() { printf '{"schema_version":1,"rows":[%s]}\n' "$2" > "$1"; }
  local ROW_LABELER='{"id":"carry-labeler","container":"ctr","process_pattern":"dist/scripts/backfill-directional-labels","class":"preempt-and-catchup","reason":"seeded"}'
  local ROW_SAFE='{"id":"seed-signals","container":"ctr","process_pattern":"dist/scripts/seed-signals","class":"safe-to-kill","reason":"idempotent on next fire"}'
  local ROW_NOSAFE='{"id":"publish-merkle-batch","container":"ctr","process_pattern":"dist/scripts/publish-merkle-batch","class":"no-safe-kill","reason":"onchain then db"}'
  local ROW_NOREASON='{"id":"unreasoned","container":"ctr","process_pattern":"p","class":"safe-to-kill","reason":"   "}'
  local ROW_BADCLASS='{"id":"badclass","container":"ctr","process_pattern":"p","class":"probably-fine","reason":"stated"}'
  local ROW_SECOND_PC='{"id":"other-job","container":"ctr","process_pattern":"dist/scripts/other","class":"preempt-and-catchup","reason":"stated"}'
  reg "$tmp/reg-labeler.json"  "$ROW_LABELER"
  reg "$tmp/reg-safe.json"     "$ROW_SAFE"
  reg "$tmp/reg-nosafe.json"   "$ROW_NOSAFE"
  reg "$tmp/reg-noreason.json" "$ROW_NOREASON"
  reg "$tmp/reg-badclass.json" "$ROW_BADCLASS"
  reg "$tmp/reg-second.json"   "$ROW_SECOND_PC"
  reg "$tmp/reg-mixed.json"    "$ROW_SAFE,$ROW_NOSAFE,$ROW_LABELER"
  reg "$tmp/reg-mixed-rev.json" "$ROW_LABELER,$ROW_NOSAFE,$ROW_SAFE"
  printf '{"schema_version":1,"rows":[]}\n' > "$tmp/reg-empty.json"
  printf 'not json at all\n'                > "$tmp/reg-broken.json"

  REGISTRY="$tmp/reg-labeler.json"

  echo "deploy-cron-interlock --self-test"

  # ── the legacy carry-labeler path, unchanged ───────────────────────────────────────────────
  # A hotfix ALWAYS proceeds, whatever the probe would have said. Env goes INSIDE the
  # substitution — a prefix on `ck` applies to ck, not to the subshell that produced its argument.
  ck "hotfix ALWAYS bypasses" \
     "$(DEPLOY_HOTFIX=1 DOCKER_BIN=/bin/false cmd_preempt | tail -1)" "INTERLOCK_VERDICT=BYPASSED"
  ck "the hotfix bypass is LEDGERED, never laundered" "$(grep -c 'interlock=BYPASSED' "$LEDGER")" "1"
  ck "hotfix does not even LOAD the registry (the hatch is total)" \
     "$(DEPLOY_HOTFIX=1 REGISTRY=/nonexistent LEDGER=$tmp/hx DOCKER_BIN=/bin/false cmd_preempt | tail -1)" "INTERLOCK_VERDICT=BYPASSED"

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

  # ── registry-driven dispatch, one case per class ───────────────────────────────────────────
  ck "a safe-to-kill row is NOT probed and does not defer" \
     "$(REGISTRY=$tmp/reg-safe.json LEDGER=$tmp/s1 DOCKER_BIN=$tmp/rc0.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=PROCEED"
  ck "…and it still produces a POSITIVE per-job line" \
     "$(REGISTRY=$tmp/reg-safe.json LEDGER=$tmp/s2 DOCKER_BIN=$tmp/rc0.sh cmd_preempt | grep -c 'INTERLOCK_JOB=seed-signals class=safe-to-kill outcome=none')" "1"
  ck "…and the safe set is summarised in ONE ledger row, not seventeen" \
     "$(grep -c 'class=safe-to-kill n=1 action=none' "$tmp/s2")" "1"

  # no-safe-kill NEVER sends a SIGTERM. `pkill -TERM` and `pkill -0` are indistinguishable
  # through a stub exit code, so the stub RECORDS its argv and the assertion reads it.
  printf '#!/bin/sh\necho "$@" >> %s\nexit 0\n' "$tmp/argv" > "$tmp/rc0-log.sh"; chmod +x "$tmp/rc0-log.sh"
  : > "$tmp/argv"
  ck "a no-safe-kill row in flight DEFERS after the bounded wait" \
     "$(REGISTRY=$tmp/reg-nosafe.json LEDGER=$tmp/n1 DOCKER_BIN=$tmp/rc0-log.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=DEFERRED"
  ck "…and it NEVER sends a SIGTERM — killing is the harm for this class" \
     "$(grep -c -- '-TERM' "$tmp/argv")" "0"
  ck "…and the record says the deploy proceeded anyway" \
     "$(grep -c 'outcome=no-safe-kill-wait-expired' "$tmp/n1")" "1"
  ck "a no-safe-kill row that is NOT running proceeds cleanly" \
     "$(REGISTRY=$tmp/reg-nosafe.json LEDGER=$tmp/n2 DOCKER_BIN=$tmp/rc1.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=PROCEED"

  # ── the unusable-row rules ─────────────────────────────────────────────────────────────────
  ck "an EMPTY reason makes the row INDETERMINATE, never a silent safe-to-kill" \
     "$(REGISTRY=$tmp/reg-noreason.json LEDGER=$tmp/r1 DOCKER_BIN=$tmp/rc0.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=INDETERMINATE"
  ck "…and it says WHY, per job" \
     "$(grep -c 'job=unreasoned reason=unclassifiable-row' "$tmp/r1")" "1"
  ck "an unknown class is INDETERMINATE too" \
     "$(REGISTRY=$tmp/reg-badclass.json LEDGER=$tmp/r2 DOCKER_BIN=$tmp/rc0.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=INDETERMINATE"

  # ── registry load failure: fail OPEN and LOUD ──────────────────────────────────────────────
  ck "a MISSING registry is INDETERMINATE" \
     "$(REGISTRY=/nonexistent/registry.json LEDGER=$tmp/l1 DOCKER_BIN=$tmp/rc0.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=INDETERMINATE"
  ck "an UNPARSEABLE registry is INDETERMINATE" \
     "$(REGISTRY=$tmp/reg-broken.json LEDGER=$tmp/l2 DOCKER_BIN=$tmp/rc0.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=INDETERMINATE"
  ck "an EMPTY rows[] is vacuity and REFUSES — we author this corpus" \
     "$(REGISTRY=$tmp/reg-empty.json LEDGER=$tmp/l3 DOCKER_BIN=$tmp/rc0.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=INDETERMINATE"
  ck "an unloadable registry still EXITS 0 — never fail closed on a deploy path" \
     "$(REGISTRY=/nonexistent/registry.json LEDGER=$tmp/l4 DOCKER_BIN=$tmp/rc0.sh cmd_preempt >/dev/null 2>&1; echo $?)" "0"
  ck "…and it names the path it could not read" "$(grep -c 'reason=registry-unloadable' "$tmp/l1")" "1"

  # ── aggregate precedence, ALL FOUR outcomes ────────────────────────────────────────────────
  # PROCEED is the floor; DEFERRED beats it; INDETERMINATE beats DEFERRED; BYPASSED beats all.
  ck "PRECEDENCE 1/4 — all rows clean aggregates to PROCEED" \
     "$(REGISTRY=$tmp/reg-mixed.json LEDGER=$tmp/p1 DOCKER_BIN=$tmp/rc1.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=PROCEED"
  ck "PRECEDENCE 2/4 — one DEFERRED row beats the PROCEED rows" \
     "$(REGISTRY=$tmp/reg-mixed.json MARKER=$tmp/m2 LEDGER=$tmp/p2 DOCKER_BIN=$tmp/rc0.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=DEFERRED"
  ck "PRECEDENCE 3/4 — INDETERMINATE beats DEFERRED" \
     "$(REGISTRY=$tmp/reg-mixed.json MARKER=$tmp/m3 LEDGER=$tmp/p3 DOCKER_BIN=$tmp/rc7.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=INDETERMINATE"
  ck "PRECEDENCE 4/4 — BYPASSED beats everything" \
     "$(DEPLOY_HOTFIX=1 REGISTRY=$tmp/reg-mixed.json LEDGER=$tmp/p4 DOCKER_BIN=$tmp/rc7.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=BYPASSED"
  ck "…and a DEFERRED aggregate really did contain a PROCEED row too" \
     "$(grep -c 'class=safe-to-kill' "$tmp/p2")" "1"
  # The precedence is ORDER-INDEPENDENT: a load-bearing safety property must never be RENTED from
  # iteration order. Same three rows, reversed, must produce the same aggregate.
  ck "…and the aggregate does not depend on ROW ORDER" \
     "$(REGISTRY=$tmp/reg-mixed-rev.json MARKER=$tmp/m5 LEDGER=$tmp/p5 DOCKER_BIN=$tmp/rc7.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=INDETERMINATE"
  # THE DISCRIMINATING CASE, and it exists because the check above did NOT discriminate. A single
  # docker stub returns ONE rc, so every row lands in the SAME state and the ordering rule is never
  # exercised. Measured 2026-08-29: deliberately inverting `bump` so DEFERRED outranks
  # INDETERMINATE left this whole suite GREEN. So the stub now branches on the PATTERN it is asked
  # about, producing a genuinely mixed run — one row DEFERRED, one INDETERMINATE, in the same
  # invocation — which is the only shape that can tell the two orderings apart.
  printf '#!/bin/sh\ncase "$*" in *backfill-directional-labels*) exit 0;; *publish-merkle-batch*) exit 7;; *) exit 1;; esac\n' > "$tmp/rc-mixed.sh"
  chmod +x "$tmp/rc-mixed.sh"
  ck "PRECEDENCE — INDETERMINATE outranks DEFERRED when BOTH occur in one run" \
     "$(REGISTRY=$tmp/reg-mixed.json MARKER=$tmp/m6 LEDGER=$tmp/p6 DOCKER_BIN=$tmp/rc-mixed.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=INDETERMINATE"
  ck "…and that mixed run really did contain BOTH a DEFERRED and an INDETERMINATE row" \
     "$(grep -c 'interlock=DEFERRED' "$tmp/p6")$(grep -c 'interlock=INDETERMINATE' "$tmp/p6")" "11"
  ck "…and it still holds with the rows in the OPPOSITE order" \
     "$(REGISTRY=$tmp/reg-mixed-rev.json MARKER=$tmp/m7 LEDGER=$tmp/p7 DOCKER_BIN=$tmp/rc-mixed.sh cmd_preempt | tail -1)" "INTERLOCK_VERDICT=INDETERMINATE"

  # ── OPS-DEPLOY-CATCHUP-DETACH-W1 ───────────────────────────────────────────────────────────
  #
  # THE ASSERTION THAT IS THE FIX. A backfill budgeted up to 125 min used to run in the FOREGROUND
  # of the deploy's SSH session, whose action times out at ~10 min — so a fully successful deploy
  # reported FAILURE. `cmd_catchup` must now LAUNCH and RETURN, whatever the child does.
  #
  # The shim sleeps 10s: far longer than the ~2s bound below, so a regression to a foreground call
  # cannot pass by being fast. `DETACH_BIN=` empty would make the launch `$SELF ... &` — still
  # detached — so the seam is driven with a REAL detach substitute rather than an empty string.
  # THE CHILD MUST ACTUALLY BE SLOW, or this check measures nothing. An earlier draft passed
  # SELF=/bin/true here: the mutation that reverts the detach to a foreground call then still
  # returned instantly and the suite stayed GREEN on the exact defect this wave exists to fix.
  # The seam replaced the thing the assertion was meant to observe.
  REGISTRY="$tmp/reg-labeler.json"
  printf '#!/bin/sh\nsleep 10\nexit 0\n' > "$tmp/slow-self.sh"; chmod +x "$tmp/slow-self.sh"
  printf '#!/bin/sh\nexec "$@"\n' > "$tmp/nodetach.sh"; chmod +x "$tmp/nodetach.sh"
  local c0 c1
  MARKER="$tmp/marker"; : > "$MARKER"
  c0=$(date +%s)
  ck "catch-up LAUNCHES and returns (does not block the deploy)" \
     "$(INTERLOCK_WORST_OVERRIDE=140 INTERLOCK_REMAINING_OVERRIDE=99 DETACH_BIN=$tmp/nodetach.sh \
        SELF=$tmp/slow-self.sh cmd_catchup | tail -1)" "INTERLOCK_VERDICT=DEFERRED"
  c1=$(date +%s)
  ck "…and returns in ~2s despite a 10s child" "$([ $((c1-c0)) -le 2 ] && echo yes)" "yes"
  # The DEGRADED branch (no setsid) must ALSO return immediately and must SAY it degraded. It is
  # the branch that runs where setsid is absent, and its whole reason for existing is that a failed
  # launch would skip the catch-up in silence — so it needs its own assertion, not an assumption.
  local d0 d1
  : > "$MARKER"
  d0=$(date +%s)
  # Its OWN ledger, so these checks neither pollute nor depend on the shared one.
  ck "the DEGRADED (no-setsid) launch also returns immediately" \
     "$(LEDGER=$tmp/dl INTERLOCK_WORST_OVERRIDE=140 INTERLOCK_REMAINING_OVERRIDE=99 \
        DETACH_BIN=$tmp/definitely-absent SELF=$tmp/slow-self.sh cmd_catchup | tail -1)" "INTERLOCK_VERDICT=DEFERRED"
  d1=$(date +%s)
  ck "…and the degraded launch is fast too" "$([ $((d1-d0)) -le 2 ] && echo yes)" "yes"
  ck "a missing detach binary is RECORDED, never silent" \
     "$(grep -c 'detach=degraded-no-' "$tmp/dl")" "1"

  ck "the launch is recorded as LAUNCHED, never as 'running'" \
     "$(grep -c 'catchup=launched' "$LEDGER")" "1"
  ck "the recorded detach MODE is not silently dropped" \
     "$(grep -c 'detach=' "$LEDGER")" "1"

  # The runner writes the TERMINAL record. Three outcomes the old inline call could not tell apart.
  # Each drives its OWN ledger so these checks neither pollute nor depend on the shared one.
  # `flock -n <lock> <cmd...>`: the pass-through shim drops its own two args and execs the command.
  printf '#!/bin/sh\nshift 2\nexec "$@"\n' > "$tmp/flock-pass.sh"; chmod +x "$tmp/flock-pass.sh"
  printf '#!/bin/sh\nexit 1\n' > "$tmp/flock-held.sh"; chmod +x "$tmp/flock-held.sh"
  ck "runner records FINISHED on rc=0" \
     "$(LEDGER=$tmp/rl1 FLOCK_BIN=$tmp/flock-pass.sh DOCKER_BIN=$tmp/rc0.sh cmd_catchup_runner 5 >/dev/null 2>&1; grep -c 'catchup=finished rc=0' "$tmp/rl1")" "1"
  # rc=1 from `flock -n` means the lock was HELD and NOTHING ran — before this wave `|| true`
  # swallowed it and the ledger claimed `catchup=running` for a catch-up that never happened.
  ck "runner distinguishes LOCK-HELD from a real run" \
     "$(LEDGER=$tmp/rl2 FLOCK_BIN=$tmp/flock-held.sh DOCKER_BIN=$tmp/rc0.sh cmd_catchup_runner 5 >/dev/null 2>&1; grep -c 'catchup=lock-held' "$tmp/rl2")" "1"
  ck "LOCK-HELD is never recorded as finished" "$(grep -c 'catchup=finished' "$tmp/rl2")" "0"
  ck "runner records FAILED with the rc that caused it" \
     "$(LEDGER=$tmp/rl3 FLOCK_BIN=$tmp/flock-pass.sh DOCKER_BIN=$tmp/rc7.sh cmd_catchup_runner 5 >/dev/null 2>&1; grep -c 'catchup=failed rc=7' "$tmp/rl3")" "1"
  ck "a runner failure is NEVER recorded as finished" "$(grep -c 'catchup=finished' "$tmp/rl3")" "0"
  ck "the REAL flock default is flock" "$FLOCK_BIN" "flock"

  # BYPASSED-ARTIFACT ASSERTION. Every check above replaces DETACH_BIN, so none of them can see
  # the real one. `setsid` is util-linux — absent on macOS — and a wrong default would fail into a
  # discarded background job with a green suite.
  ck "the REAL detach default is setsid" "$DETACH_BIN" "setsid"
  ck "--print-detach names the runner subcommand it will spawn" \
     "$(bash "$SELF" --print-detach | grep -c -- '--catchup-runner')" "1"

  # Catch-up: the SLO gate skips when everything is projected inside SLO.
  # Re-arm the marker — the launch check above consumed the one the preempt test left.
  : > "$MARKER"
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

  # A SECOND preempt-and-catchup row REFUSES loudly rather than inventing a gate for itself.
  date -u +%Y-%m-%dT%H:%M:%SZ > "$tmp/.other-job-preempted"
  ck "a preempt-and-catchup row with no declared gate REFUSES loudly" \
     "$(REGISTRY=$tmp/reg-second.json MARKER=$tmp/marker LEDGER=$tmp/o1 DOCKER_BIN=$tmp/rc0.sh cmd_catchup | tail -1)" \
     "INTERLOCK_VERDICT=INDETERMINATE"
  ck "…and says exactly why, naming the job" \
     "$(grep -c 'job=other-job catchup=skipped reason=no-gate-declared-for-this-row' "$tmp/o1")" "1"
  ck "…and a catch-up registry load failure is ALSO INDETERMINATE" \
     "$(REGISTRY=$tmp/reg-broken.json LEDGER=$tmp/o2 DOCKER_BIN=$tmp/rc0.sh cmd_catchup | tail -1)" "INTERLOCK_VERDICT=INDETERMINATE"

  # EVERY VERDICT CLASS reached the ledger — silent proceed is the defect being fixed, and a
  # magic row COUNT would only pin how many cases this self-test happens to have. What matters is
  # that no class can go unrecorded.
  local missing=""
  for v in BYPASSED PROCEED DEFERRED INDETERMINATE; do
    grep -q "interlock=$v" "$LEDGER" || missing="$missing $v"
  done
  ck "every verdict class reached the ledger" "${missing:-none}" "none"
  # Every ledger row names its job — with more than one job in scope, a row that cannot say which
  # one it describes is unreadable.
  ck "every ledger row names its job" "$(grep -cv 'job=' "$LEDGER")" "0"
  # The pattern must match the REAL script, or a rename silently disarms the interlock with
  # nothing red. The vitest suite pins this against the file on disk; this is the in-script half.
  local base; base=$(basename "$LABELER_PATTERN")
  local matched=no
  [ "${LABELER_SCRIPT_REL#*$base}" != "$LABELER_SCRIPT_REL" ] && matched=yes
  ck "the pattern matches the real script path" "$matched" "yes"

  # ── THE HERMETIC SEAM'S OWN BLIND SPOT ─────────────────────────────────────────────────────
  # Every dispatch check above points REGISTRY at a fixture, so all of them are blind to the real
  # file. A malformed, renamed or half-classified real registry would pass every one of them and
  # then fail on the first live deploy. CLAUDE.md: assert the bypassed artifact too.
  REGISTRY="$REAL_REGISTRY"
  ck "SEAM — the REAL registry is at the declared default path" \
     "$([ "$REGISTRY" = "$(dirname "$SELF")/cron-interlock-registry.json" ] && echo yes)" "yes"
  ck "SEAM — the REAL registry loads and yields rows" \
     "$([ -n "$(registry_rows 2>/dev/null)" ] && echo yes)" "yes"
  ck "SEAM — no REAL row is unclassifiable (class known AND reason non-empty)" \
     "$(registry_rows 2>/dev/null | awk -F'\t' '$4=="INDETERMINATE"' | wc -l | tr -d ' ')" "0"
  ck "SEAM — the REAL registry still carries the carry-labeler row this file hardcodes" \
     "$(registry_rows 2>/dev/null | awk -F'\t' -v p="$LABELER_PATTERN" '$1=="carry-labeler" && $3==p' | wc -l | tr -d ' ')" "1"
  ck "SEAM — the REAL python default is python3" "$PY_BIN" "python3"

  rm -rf "$tmp"
  if [ "$fails" -gt 0 ]; then
    echo "SELF-TEST: $fails of $n failed"
    echo "SELF_TEST_VERDICT=FAIL"
    echo "INTERLOCK_VERDICT=INDETERMINATE"
    return 1
  fi
  echo "SELF-TEST: PASS — $n checks"
  echo "SELF_TEST_VERDICT=PASS"
  echo "INTERLOCK_VERDICT=PROCEED"
  return 0
}

case "${1:-}" in
  preempt)   cmd_preempt ;;
  catchup)   cmd_catchup ;;
  # INTERNAL — spawned detached by `catchup`, never called by deploy.yml. Kept as a subcommand of
  # THIS script (rather than an inline `setsid bash -c '…'`) so `record` stays the one ledger
  # writer and the runner is reachable by the self-test.
  --catchup-runner) shift; cmd_catchup_runner "${1:-0}" ;;
  --print-detach) printf '%s %s --catchup-runner\n' "$DETACH_BIN" "$SELF" ;;
  --self-test) cmd_self_test ;;
  --print-pattern)  printf '%s\n' "$LABELER_PATTERN" ;;
  --print-script)   printf '%s\n' "$LABELER_SCRIPT_REL" ;;
  --print-wait)     printf '%s\n' "$WAIT_S" ;;
  --print-registry) printf '%s\n' "$REGISTRY" ;;
  *) echo "usage: $0 preempt|catchup|--self-test|--print-pattern|--print-script|--print-wait|--print-detach|--print-registry" >&2; exit 2 ;;
esac
