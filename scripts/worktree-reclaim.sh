#!/usr/bin/env bash
# worktree-reclaim.sh — THE ONE automatic reclaim entry point (OPS-WORKTREE-RECLAIM-ON-CREATE-W1-V2 R1).
#
#   worktree-reclaim.sh --trigger worktree-create|session-start|manual [--foreground]
#
# ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
#   Nothing owned WHEN a worktree leaves. The disk filled on 2026-10-17 with 214 landed
#   worktrees (~143 GiB), because `cc-session.sh clean` — the reclaim tool that already knew
#   what is safe — only ran when a human typed it.
#
# ── TWO TRIGGERS, ONE ENTRY POINT ──────────────────────────────────────────────────────────
#   1. scripts/worktree-create-hook.sh, at the end of its section 9;
#   2. one user-level SessionStart registration with matcher `startup`.
#   The second is not optional. Measured 2026-10-17: the WorktreeCreate hook fired 46 times
#   EVER while 214 worktrees were born — sessions hand-roll `git worktree add` (80 via the
#   canonical-worktree skill, 114 more with no fire). Growth happens when sessions START, so
#   the trigger sits there. Both triggers share ONE cooldown and ONE lock, so two of them in
#   the same minute sweep at most once.
#
# ── THE TRIGGER CONTRACT: return at once, print NOTHING ────────────────────────────────────
#   SessionStart stdout becomes context Claude reads, and Claude's first response waits for
#   the hook to exit. The WorktreeCreate hook's stdout must carry its path and nothing else.
#   So the default mode re-execs itself fully DETACHED — stdin/stdout/stderr all on /dev/null,
#   so the child holds no pipe the caller is waiting to see closed — and exits 0 at once.
#   `--foreground` is the detached child (and what tests and manual runs use).
#
# ── VERDICT ────────────────────────────────────────────────────────────────────────────────
#   One JSON line per run to $ARTIFACTS/reclaim.jsonl, and in --foreground mode exactly ONE
#   terminal stdout line:   WORKTREE_RECLAIM_VERDICT=PASS|INDETERMINATE|SKIPPED_COOLDOWN|SKIPPED_LOCKED
#   exit: 0 = PASS and both SKIPPED_* · 3 = INDETERMINATE (the token-law default for a new
#   gate). Callers gate on the TOKEN. The triggers ignore both: a reclaim failure must never
#   cost a session or a worktree.
#
#   INDETERMINATE means the sweep could not decide, and refused everything: lsof unavailable,
#   no primary discovered, an unreadable reclaim block, or `clean` exiting non-zero.
#
# ── FAIL CLOSED FOR TEARDOWN ───────────────────────────────────────────────────────────────
#   This script only ever DESTROYS (through `clean --force`). Any configuration it cannot read
#   is therefore a reason not to sweep, never a reason to guess a default.
#
# Portable to macOS bash 3.2: no associative arrays, no mapfile.

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
SELF="$SELF_DIR/$(basename "${BASH_SOURCE[0]}")"
# The SoT travels WITH this script (same pattern as the hook), so the installed copy reads the
# installed SoT and a checkout reads its own.
SOT="${ALGOVAULT_WORKTREE_SOT:-$SELF_DIR/../ops/shared-worktree-state.json}"
ARTIFACTS="${ALGOVAULT_HOOK_ARTIFACTS:-$HOME/.local/state/algovault/OPS-WORKTREE-CREATE-HOOK-W1}"
JSONL="$ARTIFACTS/reclaim.jsonl"
LOG="$ARTIFACTS/reclaim.log"
STAMP="$ARTIFACTS/reclaim.last-completed"
RUNS="$ARTIFACTS/reclaim-runs"
RUNS_KEEP=30
# Test seam: the sweep command. Defaults to the cc-session.sh that travels with this script.
CC_SESSION="${WORKTREE_RECLAIM_CC_SESSION:-$SELF_DIR/cc-session.sh}"
LOCK_NAME="worktree-reclaim"

trigger=""; foreground=0
while [ $# -gt 0 ]; do
  case "$1" in
    --trigger)    shift; trigger="${1:-}" ;;
    --trigger=*)  trigger="${1#--trigger=}" ;;
    --foreground) foreground=1 ;;
    -h|--help)    sed -n '2,45p' "$SELF" | sed -e 's/^# \{0,1\}//'; exit 0 ;;
    *)            trigger="__invalid__" ;;
  esac
  shift
done
case "$trigger" in worktree-create|session-start|manual) ;; *) trigger="" ;; esac

if [ "$foreground" -eq 0 ]; then
  # A trigger. Never print, never block, never fail the caller — even on a bad argument, which
  # is a registration bug and must not take a session start down with it.
  if [ -n "$trigger" ]; then
    bash "$SELF" --trigger "$trigger" --foreground >/dev/null 2>&1 </dev/null &
    disown 2>/dev/null || true
  fi
  exit 0
fi

# ── --foreground: the sweep itself ─────────────────────────────────────────────────────────
mkdir -p "$ARTIFACTS" "$RUNS" 2>/dev/null
now_epoch() { date -u +%s; }
log() { printf '%s [worktree-reclaim] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG" 2>/dev/null; }

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED="$(now_epoch)"
VERDICT="INDETERMINATE"; DETAIL=""
CONSIDERED=0; REMOVED=0; KIB_FREED=0; SKIPPED_FOREIGN=0; UNREACHABLE=0
HELD_JSON="{}"; LOCK_TOKEN=""; FLOOR_BREACHED=false; FREE_GIB=""; RUNLOG=""
COOLDOWN_H=""; FLOOR_GIB=""; AGE_H=""; TTL_S=""; SWEEP_CWD=""

is_uint() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# Free GiB on the volume holding $HOME, one decimal. `df -kP` = POSIX columns, no line wrap.
free_gib() {
  df -kP "$HOME" 2>/dev/null | awk 'NR==2 && $4 ~ /^[0-9]+$/ {printf "%.1f", $4/1048576}'
}

# installed_sha + installed_matches_origin_main — so a stale install shows on EVERY run.
# The install writes .installed-sha and .manifest beside scripts/; a checkout has neither.
INSTALL_ROOT="$(cd "$SELF_DIR/.." 2>/dev/null && pwd)"
installed_sha() {
  if [ -r "$INSTALL_ROOT/.installed-sha" ]; then tr -d '\n' < "$INSTALL_ROOT/.installed-sha"
  else printf 'uninstalled'; fi
}
# Per-file BLOB compare against the sweep cwd's origin/main. Prints "true", "false:<files>",
# or "null:<why>". Never fetches: this runs unattended, and a background fetch would contend
# with whatever the operator is doing in that checkout. The ref it compared is recorded.
ORIGIN_MAIN_SHA=""
installed_matches() {
  local rel blob local_blob drift="" n=0
  [ -r "$INSTALL_ROOT/.manifest" ] || { printf 'null:no-manifest'; return; }
  [ -n "$SWEEP_CWD" ] || { printf 'null:no-sweep-cwd'; return; }
  ORIGIN_MAIN_SHA="$(git -C "$SWEEP_CWD" rev-parse --verify --quiet origin/main 2>/dev/null)"
  [ -n "$ORIGIN_MAIN_SHA" ] || { printf 'null:no-origin-main'; return; }
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    n=$((n + 1))
    blob="$(git -C "$SWEEP_CWD" rev-parse --verify --quiet "origin/main:$rel" 2>/dev/null)"
    local_blob="$(git hash-object "$INSTALL_ROOT/$rel" 2>/dev/null)"
    [ -n "$blob" ] && [ "$blob" = "$local_blob" ] || drift="$drift${drift:+,}$rel"
  done < "$INSTALL_ROOT/.manifest"
  [ "$n" -gt 0 ] || { printf 'null:empty-manifest'; return; }
  if [ -z "$drift" ]; then printf 'true'; else printf 'false:%s' "$drift"; fi
}

record() {
  local dur im im_json drift_json
  dur=$(( $(now_epoch) - STARTED ))
  [ -n "$FREE_GIB" ] || FREE_GIB="$(free_gib)"
  im="$(installed_matches)"
  case "$im" in
    true)     im_json=true;  drift_json='[]' ;;
    false:*)  im_json=false; drift_json="$(printf '%s' "${im#false:}" | jq -R 'split(",")' 2>/dev/null || echo '[]')" ;;
    *)        im_json=null;  drift_json='[]' ;;
  esac
  if command -v jq >/dev/null 2>&1; then
    jq -cn \
      --arg ts "$TS" --arg trigger "$trigger" --arg verdict "$VERDICT" --arg detail "$DETAIL" \
      --argjson considered "$CONSIDERED" --argjson removed "$REMOVED" \
      --argjson held "$HELD_JSON" --argjson kib "$KIB_FREED" \
      --arg free "${FREE_GIB:-}" --arg floor "${FLOOR_GIB:-}" --argjson breached "$FLOOR_BREACHED" \
      --argjson foreign "$SKIPPED_FOREIGN" --argjson unreachable "$UNREACHABLE" \
      --arg lock "$LOCK_TOKEN" --arg sha "$(installed_sha)" --argjson im "$im_json" \
      --argjson drift "$drift_json" --arg om "$ORIGIN_MAIN_SHA" --arg runlog "$RUNLOG" \
      --argjson dur "$dur" --arg age "${AGE_H:-}" \
      '{ts:$ts, trigger:$trigger, WORKTREE_RECLAIM_VERDICT:$verdict, detail:$detail,
        considered:$considered, removed:$removed, held:$held, kib_freed:$kib,
        free_gib:(if $free=="" then null else ($free|tonumber) end),
        floor_gib:(if $floor=="" then null else ($floor|tonumber) end), floor_breached:$breached,
        max_age_hours:(if $age=="" then null else ($age|tonumber) end),
        skipped_foreign_primaries:$foreign, unreachable_primaries:$unreachable,
        lock:$lock, installed_sha:$sha, installed_matches_origin_main:$im,
        installed_drift_files:$drift, origin_main_compared:$om, run_log:$runlog,
        duration_s:$dur}' >>"$JSONL" 2>/dev/null
  else
    # No jq means no structured record; say so in a line that still carries the token.
    printf '{"ts":"%s","trigger":"%s","WORKTREE_RECLAIM_VERDICT":"%s","detail":"jq unavailable"}\n' \
      "$TS" "$trigger" "$VERDICT" >>"$JSONL" 2>/dev/null
  fi
  log "verdict=$VERDICT trigger=$trigger considered=$CONSIDERED removed=$REMOVED kib_freed=$KIB_FREED ${DETAIL:+detail=$DETAIL}"
}

finish() {   # <verdict> [detail]
  VERDICT="$1"; DETAIL="${2:-}"
  record
  printf 'WORKTREE_RECLAIM_VERDICT=%s\n' "$VERDICT"
  case "$VERDICT" in INDETERMINATE) exit 3 ;; *) exit 0 ;; esac
}

[ -n "$trigger" ] || finish INDETERMINATE "no valid --trigger (expected worktree-create|session-start|manual)"
command -v jq >/dev/null 2>&1 || finish INDETERMINATE "jq is not on PATH"

# ── 1. the reclaim block ───────────────────────────────────────────────────────────────────
[ -r "$SOT" ] || finish INDETERMINATE "SoT unreadable: $SOT"
rc_get() { jq -r --arg k "$1" '(.worktree_roots.reclaim // {})[$k] // empty' "$SOT" 2>/dev/null; }
COOLDOWN_H="$(rc_get cooldown_hours)"; FLOOR_GIB="$(rc_get floor_gib)"
AGE_H="$(rc_get auto_max_age_hours)";  TTL_S="$(rc_get lock_ttl_s)"; SWEEP_CWD="$(rc_get sweep_cwd)"
for v in "$COOLDOWN_H" "$FLOOR_GIB" "$AGE_H" "$TTL_S"; do
  is_uint "$v" || finish INDETERMINATE "worktree_roots.reclaim is missing a non-negative integer (cooldown_hours, floor_gib, auto_max_age_hours, lock_ttl_s)"
done
case "$SWEEP_CWD" in /*) ;; *) finish INDETERMINATE "worktree_roots.reclaim.sweep_cwd is not an absolute path" ;; esac
git -C "$SWEEP_CWD" rev-parse --git-dir >/dev/null 2>&1 || finish INDETERMINATE "sweep_cwd is not a git repository: $SWEEP_CWD"

# ── 2. cooldown — the stamp is the last COMPLETED sweep, so a crash never suppresses one ────
in_cooldown() {
  local last
  last="$(cat "$STAMP" 2>/dev/null | tr -d '\n')"
  is_uint "$last" || return 1
  [ $(( $(now_epoch) - last )) -lt $(( COOLDOWN_H * 3600 )) ]
}
in_cooldown && finish SKIPPED_COOLDOWN "last completed sweep is younger than ${COOLDOWN_H}h"

# ── 3. the ONE lock primitive, sourced — never its `-- <cmd>` form ─────────────────────────
# with-lock's TIMEOUT fails OPEN and runs the command anyway (its header R1d) — right for
# landing, wrong here: a concurrent trigger must SKIP, not sweep unlocked. So this script asks
# for the lock itself and gates on the TOKEN. TTL is set HERE so every contender judges
# staleness by the same 3600 s; dead-pid reclaim still frees a crashed holder at once.
export ALGOVAULT_LOCK_DIR="${WORKTREE_RECLAIM_LOCK_DIR:-$HOME/.local/state/algovault/locks}"
export ALGOVAULT_LOCK_TTL="$TTL_S"
export ALGOVAULT_LOCK_TIMEOUT="${WORKTREE_RECLAIM_LOCK_TIMEOUT:-2}"
export ALGOVAULT_LOCK_POLL=1
[ -r "$SELF_DIR/lib/with-lock.sh" ] || finish INDETERMINATE "lib/with-lock.sh unreadable beside $SELF"
# shellcheck source=lib/with-lock.sh
. "$SELF_DIR/lib/with-lock.sh"
trap 'algovault_lock_release "$LOCK_NAME" 2>/dev/null' EXIT
algovault_lock_acquire "$LOCK_NAME" 2>>"$LOG"
LOCK_TOKEN="${ALGOVAULT_LOCK_VERDICT:-INDETERMINATE}"
case "$LOCK_TOKEN" in
  ACQUIRED|RECLAIMED) : ;;
  TIMEOUT) finish SKIPPED_LOCKED "another sweep holds '$LOCK_NAME'; this trigger did not run clean" ;;
  *)       finish INDETERMINATE "lock could not be evaluated (token $LOCK_TOKEN)" ;;
esac
# Re-check inside the lock: a sweep may have COMPLETED between the first check and acquiring.
in_cooldown && finish SKIPPED_COOLDOWN "a sweep completed while this trigger waited for the lock"

# ── 4. the sweep ───────────────────────────────────────────────────────────────────────────
RUNLOG="$RUNS/$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
( cd "$SWEEP_CWD" && bash "$CC_SESSION" clean --force --max-age-hours "$AGE_H" ) >"$RUNLOG" 2>&1 </dev/null
CLEAN_RC=$?
# Forensics stay bounded: keep the newest $RUNS_KEEP run logs.
ls -1t "$RUNS" 2>/dev/null | awk -v k="$RUNS_KEEP" 'NR>k' | while IFS= read -r old; do rm -f "$RUNS/$old"; done

CONSIDERED="$(grep -cE '^(KEEP|REMOVED|WOULD-REMOVE) ' "$RUNLOG" 2>/dev/null || true)"
REMOVED="$(grep -cE '^REMOVED ' "$RUNLOG" 2>/dev/null || true)"
KIB_FREED="$(sed -n 's/^REMOVED .* kib=\([0-9][0-9]*\).*/\1/p' "$RUNLOG" 2>/dev/null | awk '{s+=$1} END{print s+0}')"
SKIPPED_FOREIGN="$(grep -c '^SKIP primary ' "$RUNLOG" 2>/dev/null || true)"
UNREACHABLE="$(grep -c '=== UNREACHABLE' "$RUNLOG" 2>/dev/null || true)"
is_uint "$CONSIDERED" || CONSIDERED=0; is_uint "$REMOVED" || REMOVED=0
is_uint "$KIB_FREED" || KIB_FREED=0;   is_uint "$SKIPPED_FOREIGN" || SKIPPED_FOREIGN=0
is_uint "$UNREACHABLE" || UNREACHABLE=0
# Held by reason: the first word after the em dash, cut at "(" or ":" — in-use, locked,
# exempt, work, ignored-payload, noise-not-deletable, unmerged, REFUSED, self.
HELD_JSON="$(awk '/^KEEP / { if (match($0, /— /)) { r = substr($0, RSTART + RLENGTH);
                 sub(/^ +/, "", r); split(r, a, /[(: ]/); if (a[1] != "") print a[1] } }' "$RUNLOG" 2>/dev/null \
  | jq -Rcn '[inputs | select(length > 0)] | group_by(.) | map({(.[0]): length}) | add // {}' 2>/dev/null)"
[ -n "$HELD_JSON" ] || HELD_JSON="{}"

# ── 5. floor — alert only, never block ─────────────────────────────────────────────────────
FREE_GIB="$(free_gib)"
if [ -n "$FREE_GIB" ] && awk -v f="$FREE_GIB" -v l="$FLOOR_GIB" 'BEGIN{exit !(f < l)}'; then
  FLOOR_BREACHED=true
  largest="$(awk '/^KEEP / { p=$2; r=""; if (match($0, /— /)) r=substr($0, RSTART+RLENGTH); print p "\t" r }' "$RUNLOG" 2>/dev/null \
    | while IFS=$'\t' read -r p r; do
        k="$(du -sk "$p" 2>/dev/null | awk '{print $1}')"; is_uint "$k" && printf '%s\t%s\t%s\n' "$k" "$p" "$r"
      done | sort -rn | head -5 \
    | awk -F'\t' '{printf "%s%s (%.1f GiB — %s)", (NR>1?"; ":""), $2, $1/1048576, $3}')"
  msg="WORKTREE_RECLAIM_FLOOR: free ${FREE_GIB} GiB < floor ${FLOOR_GIB} GiB after the sweep; 5 largest HELD: ${largest:-none}"
  log "$msg"
  { printf '%s\n' "$msg" >/dev/tty; } 2>/dev/null || true
fi

# ── 6. verdict ─────────────────────────────────────────────────────────────────────────────
if [ "$CLEAN_RC" -ne 0 ]; then
  finish INDETERMINATE "cc-session.sh clean exited $CLEAN_RC: $(tail -1 "$RUNLOG" 2>/dev/null | cut -c1-200)"
fi
if grep -q 'process-cwd UNAVAILABLE' "$RUNLOG" 2>/dev/null; then
  finish INDETERMINATE "lsof unavailable — clean refused every worktree"
fi
printf '%s\n' "$(now_epoch)" > "$STAMP.tmp.$$" 2>/dev/null && mv -f "$STAMP.tmp.$$" "$STAMP" 2>/dev/null
finish PASS
