#!/usr/bin/env bash
# OPS-MONITORING-TELEGRAM-INTEGRATION-W1 + PATCH-A + OPS-MONITORING-RECOMMENDATION-RESOLVER-AND-CANARY-W1 PATCH-B
#   + OPS-ALERT-RECOVERY-NOTICE-W1 CH1 (the alert channel becomes a STATE, not an event stream)
# Reusable Telegram alert wrapper.
# Usage: send_telegram.sh <alert_id> <severity> [body_file|-]     # fire (unchanged)
#        send_telegram.sh --clear <alert_id> [reason]             # FIRING -> CLEAR
#        send_telegram.sh --reconcile [alert_id]                  # adopt on-disk state, emit nothing
#        send_telegram.sh --self-test                             # hermetic
#   body via stdin if 3rd arg is "-" or omitted.
#
# ── WHY --clear EXISTS (OPS-ALERT-RECOVERY-NOTICE-W1) ────────────────────────────────────────
# This wrapper could say a thing broke. It had no way to say it stopped. `date +%s > "$MARKER"`
# runs on a delivered fire and NOTHING ever cleared it, so the channel's last message was pinned
# to the worst thing that ever happened, and the 24h cooldown made a self-healed condition go
# quiet — indistinguishable from one still broken inside its cooldown, and from a dead reporter.
# Measured: MONITORING_DECLARATION_SYNC_FAILED fired 2026-08-17 during a published GitHub
# incident, self-healed within the hour, and 70 HOURS LATER the operator was still treating it as
# live and dispatched a wave to investigate a condition that had already fixed itself.
#
# ── AND WHY IT IS SILENT BY DEFAULT ──────────────────────────────────────────────────────────
# CLAUDE.md holds that recovery CHATTER is noise and silent recovery is the default; a prior wave
# retired real alarm-fatigue in webhook-delivery-canary.py by auto-resolving silently, and that
# decision stands. The law was AMENDED (2026-08-21), not overridden: chatter is unbounded
# per-cycle "recovered again" traffic; a RESOLUTION is at most one message per episode, emitted
# only on FIRING -> CLEAR, only when a fire was actually DELIVERED, and it removes the marker so
# it cannot repeat. Announcing is therefore OPT-IN PER ALERT via `announce_resolution` on the
# alert-registry row, and every failure mode of that lookup — absent registry, absent row,
# unreadable file, no python3 — resolves to SILENT. The default lives in DATA and in the code
# path, never in a sentence someone has to read.
#
# CONTRACT (CLAUDE.md ## Automation-first recovery → Operator-action-required alert contract):
#   TG fires ONLY when:
#     (a) severity == CRITICAL_PERSISTENT, AND
#     (b) cooldown elapsed (24h per alert_id), AND
#     (c) DRY_RUN_TG env var is unset/0.
#   All other paths log silently. Fail-open exit 0 on every error path.
#
# PATCH-B (RECRESOLVER-W1): resolve_template() substitutes OPS-<CLASS>-W{NEXT} placeholders
#   in the body by greping /var/lib/algovault-monitoring/status.md for highest-completed
#   GREEN W<N> of the class. Runs AFTER body read + AFTER cooldown gate + BEFORE DRY_RUN
#   gate, so DRY_RUN_FIRED + FIRED log lines reflect the RESOLVED body.

set -euo pipefail

# ── MODE DISPATCH — must precede the positional reads, which are mandatory in alert mode ────
MODE=alert
case "${1:-}" in
  --clear)     MODE=clear;     shift ;;
  --reconcile) MODE=reconcile; shift ;;
  --self-test) MODE=self-test; shift ;;
esac

case "$MODE" in
  alert)
    ALERT_ID="${1:?alert_id required}"
    SEVERITY="${2:?severity required}"
    BODY_INPUT="${3:--}"
    ;;
  clear)
    ALERT_ID="${1:?alert_id required}"
    CLEAR_REASON="${2:-}"
    ;;
  reconcile) ALERT_ID="${1:-ALL}" ;;
  self-test) ALERT_ID="SELF_TEST" ;;
esac

# Every path below is overridable ONLY so the hermetic --self-test can redirect it. All four are
# unset in production, so production resolves to the same literals as before this change.
LOG="${ALERT_WRAPPER_LOG:-/var/log/algovault-monitoring-telegram.log}"
STATE_DIR="${ALERT_WRAPPER_STATE_DIR:-/opt/algovault-monitoring/.alert-state}"
ENV_FILE="${ALERT_WRAPPER_ENV:-/etc/algovault-monitoring/env}"
ALERT_REGISTRY="${ALERT_REGISTRY_PATH:-/opt/algovault-monitoring/alert-registry.json}"
# The POST seam. Stubbed by --self-test so the suite touches no network; the suite ALSO asserts
# the real invocation's flags are intact, because a hermetic test is structurally blind to
# exactly what its own seam replaces.
TG_CURL="${ALERT_WRAPPER_CURL:-curl}"
COOLDOWN_SEC=86400  # 24h per CLAUDE.md operator-action-required contract

# fail-open: an unwritable STATE_DIR must not abort under `set -e`. The header has always
# promised fail-open on every error path; before this line it was the one place that did not
# honour it, and a wrapper that dies takes the caller's cron with it. (AC7.)
mkdir -p "$STATE_DIR" 2>/dev/null || true

# `|| true` is LOAD-BEARING: under `set -euo pipefail` an unwritable $LOG made the FIRST log()
# call abort the wrapper, so every alert from a non-root caller died silently — the editorial units
# run as User=algovault against a root-owned log. The header promises fail-open on every error path;
# a logging failure must never be able to swallow an operator alert.
# (OPS-AUTOPUB-FULL-REVIEW-FIX-W1 C5. The perms themselves are fixed too, incl. the logrotate
# `create` line that regenerated them weekly — but the code must not depend on that.)
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ALERT_ID] $*" >> "$LOG" 2>/dev/null || true; }

# === PATCH-B: resolve_template() — substitutes OPS-<CLASS>-W{NEXT} via status.md grep ===
# Reads STATUS_MD_PATH (default /var/lib/algovault-monitoring/status.md, refreshed per
# CLAUDE.md ## Execution flow step 6 SOP after every wave's status.md append).
# Behavior:
#   - Class has GREEN history: substitute W{NEXT} → W<max+1> (MAX-W<N> via grep -oE | sort -n | tail -1)
#   - Class has zero GREEN history (greenfield): substitute → W1 + log RESOLVER_MISS
#   - status.md unreachable OR regex extract fails: ship placeholder verbatim + log RESOLVER_MISS
# Three RESOLVER_MISS reasons enumerated: reachable_status_md_path_not_found,
# no_completed_waves_for_class, regex_extract_failed.
resolve_template() {
  local body="$1"
  local status_path="${STATUS_MD_PATH:-/var/lib/algovault-monitoring/status.md}"
  if [[ ! -r "$status_path" ]]; then
    log "RESOLVER_MISS: template=<not-extracted> reason=reachable_status_md_path_not_found"
    echo "$body"
    return 0
  fi
  local templates
  templates=$(echo "$body" | grep -oE 'OPS-[A-Z0-9-]+-W\{NEXT\}' | sort -u || true)
  if [[ -z "$templates" ]]; then
    echo "$body"
    return 0
  fi
  local tpl class highest next
  while IFS= read -r tpl; do
    [[ -z "$tpl" ]] && continue
    class="${tpl%-W\{NEXT\}}"
    # OPS-CLOSEDBAR-LIVENESS-BAND-W1 R4. The prior pattern was
    #   ^### .* — ${class}-W[0-9]+ — .*GREEN
    # which demands " — " IMMEDIATELY AFTER the wave id. CLAUDE.md MANDATES a
    # "(Target ICP tier(s): …)" block in exactly that position, so it could never match a
    # conforming entry. MEASURED 2026-08-07: 96 `OPS-*-W<N>` headings in status.md, ZERO
    # matches — this resolver had NEVER resolved anything for ANY class, so every templated
    # recommended_wave it shipped said "W1", a COMPLETED wave whenever the class had one.
    # A regex that encodes a format its own SoT does not produce is a dark guard.
    # Anchor on the wave id; require GREEN anywhere on the heading (accepting
    # GREEN_WITH_CAVEAT / GREEN_RETROACTIVE_CLOSE, which are completions too).
    highest=$(grep -oE "^### .*${class}-W[0-9]+.*GREEN" "$status_path" 2>/dev/null \
              | grep -oE "${class}-W[0-9]+" | grep -oE '[0-9]+$' | sort -n | tail -1 || true)
    if [[ -z "$highest" ]]; then
      # Ship the placeholder VERBATIM — exactly what this file's header has always documented.
      # The prior code asserted W1: a CONFIDENT WRONG ANSWER, strictly worse than an unresolved
      # template, because the operator cannot tell it was a guess.
      log "RESOLVER_MISS: template=${tpl} reason=no_completed_waves_for_class (placeholder shipped verbatim)"
      continue
    fi
    next=$((highest + 1))
    if ! [[ "$next" =~ ^[0-9]+$ ]]; then
      log "RESOLVER_MISS: template=${tpl} reason=regex_extract_failed"
      continue
    fi
    # Never hand the operator a wave that already shipped — re-running a completed wave is not
    # a remedy, and this alert family has now produced that Action line twice.
    if grep -qE "^### .*${class}-W${next}.*GREEN" "$status_path" 2>/dev/null; then
      log "RESOLVER_MISS: template=${tpl} reason=resolved_wave_already_green (${class}-W${next}); placeholder shipped verbatim"
      continue
    fi
    body="${body//${tpl}/${class}-W${next}}"
  done <<< "$templates"
  echo "$body"
}

# ── THE TEST-CONTEXT PREDICATE, DERIVED ONCE ────────────────────────────────────────────────
# The trigger SET is unchanged (OPS-AUTOPUB-TEST-ALERT-LEAK-W1); it moved into a function so the
# fire path and the clear path cannot drift apart. Two copies of this condition would be two
# places to update, and the clear path is the one where a miss is WORSE: a test that writes the
# marker silences the next page, but a test that DELETES it erases the episode and makes the next
# genuine fire look fresh. Same predicate, one definition, both consumers project from it.
is_test_context() {
  [[ -n "${NODE_TEST_CONTEXT:-}" || -n "${VITEST:-}" || "${ALGOVAULT_TG_TEST_INERT:-0}" == "1" ]]
}

# ── announce_resolution <alert_id> -> 0 announce / 1 SILENT ─────────────────────────────────
# Opt-in, per alert, expressed in DATA. EVERY failure mode resolves to SILENT: no registry file,
# unreadable registry, malformed JSON, missing row, missing key, no python3. That is deliberate —
# the law's default is silence, so the mechanism that implements the exception must fail toward
# the default rather than away from it.
announce_resolution() {
  [[ -r "$ALERT_REGISTRY" ]] || return 1
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$ALERT_REGISTRY" "$1" <<'PY' >/dev/null 2>&1
import json, sys
try:
    rows = json.load(open(sys.argv[1])).get("alerts", [])
    row = next((r for r in rows if r.get("alert_id") == sys.argv[2]), None)
    sys.exit(0 if (row or {}).get("announce_resolution") is True else 1)
except Exception:
    sys.exit(1)
PY
}

# ── human_span <seconds> ────────────────────────────────────────────────────────────────────
human_span() {
  local s=$1
  if   [[ $s -lt 3600   ]]; then echo "$((s / 60))m"
  elif [[ $s -lt 172800 ]]; then echo "$((s / 3600))h"
  else echo "$((s / 86400))d $(( (s % 86400) / 3600 ))h"
  fi
}

# ── do_clear — the FIRING -> CLEAR transition ───────────────────────────────────────────────
# Emits AT MOST ONE message per episode: it is gated on the marker existing (i.e. a fire was
# actually DELIVERED to the operator) and removes that marker on success. Its rate is bounded by
# the fires it answers — the 24h cooldown already limits an alert to one fire per day, therefore
# to one resolution per day. No new timer and no new tunable, which is the whole argument for why
# this is a resolution rather than chatter.
do_clear() {
  # 1. TEST CONTEXT FIRST — before ANY state read or write. See is_test_context above.
  if is_test_context; then
    log "SUPPRESSED_TEST_CONTEXT: --clear raised from a test process (NODE_TEST_CONTEXT=${NODE_TEST_CONTEXT:-} VITEST=${VITEST:-} ALGOVAULT_TG_TEST_INERT=${ALGOVAULT_TG_TEST_INERT:-0}); production alert state untouched"
    exit 0
  fi

  local marker="$STATE_DIR/${ALERT_ID}-last-fired-at"

  # 2. No marker -> NOTHING HAPPENED. Never announce a resolution for a condition that never
  #    fired: that is a confident wrong answer, which this file's own RESOLVER_MISS history
  #    already establishes is strictly worse than saying nothing.
  if [[ ! -f "$marker" ]]; then
    log "CLEAR_NOOP: no marker — nothing was firing, so nothing resolved"
    exit 0
  fi

  local since now age span
  since=$(cat "$marker" 2>/dev/null || echo "")
  now=$(date +%s)
  if [[ "$since" =~ ^[0-9]+$ ]]; then age=$((now - since)); else age=-1; fi
  if [[ $age -ge 0 ]]; then span=$(human_span "$age"); else span="unknown (unparseable marker)"; fi

  # 3. SILENT by default. Forensics go to the log, which is exactly what the law asks for.
  if ! announce_resolution "$ALERT_ID"; then
    rm -f "$marker" 2>/dev/null || true
    log "CLEAR_SILENT: resolved after ${span} (announce_resolution not enabled; state cleared, no POST)${CLEAR_REASON:+ reason=$CLEAR_REASON}"
    exit 0
  fi

  local body
  body=$(printf '✅ RESOLVED — %s\n\nThis is a STATE TRANSITION: the condition that fired is no longer present.\nWas firing for: %s\n%sHost: %s\n\nNo action required. This message exists so silence never has to be interpreted.\n' \
    "$ALERT_ID" "$span" "${CLEAR_REASON:+Reason: $CLEAR_REASON$'\n'}" "$(hostname)")

  # 4. DRY_RUN mirrors DRY_RUN_FIRED exactly: no POST, state change still performed.
  if [[ "${DRY_RUN_TG:-0}" == "1" ]]; then
    rm -f "$marker" 2>/dev/null || true
    log "DRY_RUN_CLEARED: TG POST skipped (DRY_RUN_TG=1); marker removed; resolved after ${span}"
    exit 0
  fi

  # 5. Creds. KEEP the marker — a resolution we could not deliver must be retried, never dropped.
  if [[ ! -r "$ENV_FILE" ]]; then
    log "CLEAR_SEND_FAILED: $ENV_FILE not readable; marker KEPT for retry"
    exit 0
  fi
  # shellcheck disable=SC1091
  . "$ENV_FILE"
  if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
    log "CLEAR_SEND_FAILED: credentials unset; marker KEPT for retry"
    exit 0
  fi

  # NOTE: a resolution is DELIBERATELY not cooldown-gated. A resolution that waits 24h is
  # worthless, and its rate is already bounded by the fires it answers.
  local tmp code
  tmp=$(mktemp /tmp/.tg-clear-XXXXXX)
  code=$("$TG_CURL" -sS -o "$tmp" -w "%{http_code}" -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${body}" \
    --max-time 10 || echo "000")

  if [[ "$code" =~ ^2 ]]; then
    rm -f "$marker" 2>/dev/null || true
    log "CLEAR_FIRED: HTTP $code — resolved after ${span}; marker removed"
  else
    # Losing state on an undelivered resolution would leave the operator with a stale FIRING view
    # and no way back to CLEAR. Keep it; the next healthy tick retries.
    log "CLEAR_SEND_FAILED: HTTP $code — marker KEPT for retry"
  fi
  rm -f "$tmp" 2>/dev/null || true
  exit 0
}

# ── do_reconcile — adopt on-disk state WITHOUT emitting any transition ──────────────────────
# The adoption tool. When an alert flips announce_resolution to true, any marker it already
# carries would produce a RESOLVED for a historical episode on the very next healthy tick.
# Measured at design time: 31 markers across the two hosts, aged 0d to 82d. Run this for an id
# whose history you do NOT want announced; skip it for one whose resolution IS the receipt.
# One-way, and logged per alert_id, so the silence is a recorded decision rather than a gap.
do_reconcile() {
  if is_test_context; then
    log "SUPPRESSED_TEST_CONTEXT: --reconcile raised from a test process; production alert state untouched"
    exit 0
  fi
  local n=0 f id
  shopt -s nullglob
  for f in "$STATE_DIR"/*-last-fired-at; do
    id=$(basename "$f" -last-fired-at)
    # Scoped to the marker glob ONLY. $STATE_DIR is SHARED — seven other canaries keep their own
    # .count/.set/.json state beside these markers, so anything wholesale here would eat theirs.
    [[ "$ALERT_ID" == "ALL" || "$ALERT_ID" == "$id" ]] || continue
    rm -f "$f" 2>/dev/null || true
    n=$((n + 1))
    log "RECONCILED: $id adopted silently — pre-existing marker dropped, no transition emitted"
  done
  log "RECONCILE_DONE: $n marker(s) adopted silently (scope=$ALERT_ID)"
  exit 0
}

# ── --self-test: hermetic. No network, no /opt, no /var/log, no TG. Vacuity-guarded ─────────
# Verdict contract: exactly one terminal ALERT_WRAPPER_VERDICT=PASS|FAIL|INDETERMINATE.
# Exit 0=PASS / 1=FAIL / 3=INDETERMINATE (3 is the token-law default for a new gate).
self_test() {
  local fails=0 checks=0 tmp me
  me="${BASH_SOURCE[0]}"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/tgtest.XXXXXX") || { echo "ALERT_WRAPPER_VERDICT=INDETERMINATE"; exit 3; }
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  mkdir -p "$tmp/state"
  ck() { checks=$((checks+1)); [[ "$2" == "$3" ]] || { echo "  ✗ $1 (got '$2' want '$3')"; fails=$((fails+1)); }; }

  printf 'TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=c\n' > "$tmp/env"
  printf '#!/usr/bin/env bash\nprintf 200\n' > "$tmp/curl-ok";   chmod +x "$tmp/curl-ok"
  printf '#!/usr/bin/env bash\nprintf 500\n' > "$tmp/curl-fail"; chmod +x "$tmp/curl-fail"

  # THE SUITE'S OWN VACUITY HAZARD, closed explicitly: this file suppresses everything under
  # VITEST / NODE_TEST_CONTEXT, and `npm test` sets VITEST=1. Inheriting it would send every
  # child down SUPPRESSED_TEST_CONTEXT and the whole suite would pass while asserting nothing.
  # So each child is launched with those cleared, and the ONE case that wants suppression sets
  # it explicitly.
  run() {  # <state_dir> <extra-env...> -- <args...>
    local sd="$1"; shift
    env -u VITEST -u NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT=0 \
        ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$sd" \
        ALERT_WRAPPER_ENV="$tmp/env" ALERT_REGISTRY_PATH="$tmp/registry.json" \
        ALERT_WRAPPER_CURL="$tmp/curl-ok" "$@" >/dev/null 2>&1
  }
  verb() { tail -1 "$tmp/log" 2>/dev/null | sed -E 's/.*\] ([A-Z_]+):.*/\1/'; }
  mark() { echo "$1" > "$tmp/state/AID-last-fired-at"; }
  fresh() { rm -f "$tmp/state"/*-last-fired-at 2>/dev/null || true; : > "$tmp/log"; rm -f "$tmp/registry.json"; }
  optin() { printf '{"alerts":[{"alert_id":"AID","announce_resolution":true}]}\n' > "$tmp/registry.json"; }

  # ── transitions ──────────────────────────────────────────────────────────
  fresh; run "$tmp/state" bash "$me" --clear AID
  ck 'CLEAR with no marker is a NOOP'                    "$(verb)" 'CLEAR_NOOP'
  ck 'CLEAR with no marker announces nothing'            "$(grep -c 'CLEAR_FIRED' "$tmp/log")" '0'

  fresh; mark "$(( $(date +%s) - 7200 ))"; run "$tmp/state" bash "$me" --clear AID
  ck 'CLEAR is SILENT when not opted in (the law default)' "$(verb)" 'CLEAR_SILENT'
  ck 'CLEAR_SILENT still clears the state'               "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'n'

  fresh; mark "$(( $(date +%s) - 7200 ))"; printf '{"alerts":[{"alert_id":"AID"}]}\n' > "$tmp/registry.json"
  run "$tmp/state" bash "$me" --clear AID
  ck 'a row WITHOUT announce_resolution stays SILENT'    "$(verb)" 'CLEAR_SILENT'
  fresh; mark "$(( $(date +%s) - 7200 ))"; printf 'not json\n' > "$tmp/registry.json"
  run "$tmp/state" bash "$me" --clear AID
  ck 'a MALFORMED registry fails toward SILENT'          "$(verb)" 'CLEAR_SILENT'

  fresh; mark "$(( $(date +%s) - 7200 ))"; optin; run "$tmp/state" bash "$me" --clear AID
  ck 'opted in + delivered -> CLEAR_FIRED'               "$(verb)" 'CLEAR_FIRED'
  ck 'a delivered resolution removes the marker'         "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'n'

  # A resolution is DELIBERATELY exempt from the 24h cooldown. Marker 1 minute old.
  fresh; mark "$(( $(date +%s) - 60 ))"; optin; run "$tmp/state" bash "$me" --clear AID
  ck 'resolution is NOT suppressed by an unexpired cooldown' "$(verb)" 'CLEAR_FIRED'

  # ── failed send KEEPS the marker ─────────────────────────────────────────
  fresh; mark "$(( $(date +%s) - 7200 ))"; optin
  env -u VITEST -u NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT=0 \
      ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$tmp/state" ALERT_WRAPPER_ENV="$tmp/env" \
      ALERT_REGISTRY_PATH="$tmp/registry.json" ALERT_WRAPPER_CURL="$tmp/curl-fail" \
      bash "$me" --clear AID >/dev/null 2>&1
  ck 'a FAILED send logs CLEAR_SEND_FAILED'              "$(verb)" 'CLEAR_SEND_FAILED'
  ck 'a FAILED send KEEPS the marker for retry'          "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'y'

  fresh; mark "$(( $(date +%s) - 7200 ))"; optin
  env -u VITEST -u NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT=0 \
      ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$tmp/state" ALERT_WRAPPER_ENV="$tmp/nope" \
      ALERT_REGISTRY_PATH="$tmp/registry.json" bash "$me" --clear AID >/dev/null 2>&1
  ck 'missing creds KEEP the marker too'                 "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'y'

  # ── DRY_RUN mirrors DRY_RUN_FIRED ────────────────────────────────────────
  fresh; mark "$(( $(date +%s) - 7200 ))"; optin
  env -u VITEST -u NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT=0 DRY_RUN_TG=1 \
      ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$tmp/state" ALERT_WRAPPER_ENV="$tmp/env" \
      ALERT_REGISTRY_PATH="$tmp/registry.json" bash "$me" --clear AID >/dev/null 2>&1
  ck 'DRY_RUN_TG clears state without a POST'            "$(verb)" 'DRY_RUN_CLEARED'

  # ── THE SHARPEST HAZARD: test context cannot clear production state ──────
  # A test that DELETES alert state is worse than one that writes it: a write silences the next
  # page, a delete erases the episode and makes the next genuine fire look like a fresh incident.
  local before after
  for trig in VITEST NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT; do
    fresh; mark 1755700000; optin
    before=$(cksum < "$tmp/state/AID-last-fired-at")
    env -u VITEST -u NODE_TEST_CONTEXT "$trig=1" \
        ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$tmp/state" ALERT_WRAPPER_ENV="$tmp/env" \
        ALERT_REGISTRY_PATH="$tmp/registry.json" ALERT_WRAPPER_CURL="$tmp/curl-ok" \
        bash "$me" --clear AID >/dev/null 2>&1
    after=$(cksum < "$tmp/state/AID-last-fired-at" 2>/dev/null || echo MISSING)
    ck "test context cannot clear production state ($trig)" "$after" "$before"
    ck "  and it announces nothing ($trig)" "$(grep -c 'CLEAR_FIRED' "$tmp/log")" '0'
  done

  # ── reconcile emits nothing ──────────────────────────────────────────────
  fresh; mark "$(( $(date +%s) - 999999 ))"; optin
  echo 12345 > "$tmp/state/OTHER-last-fired-at"
  echo keep > "$tmp/state/some-canary.count"     # a SHARED-DIR neighbour that must survive
  run "$tmp/state" bash "$me" --reconcile AID
  ck 'reconcile drops the scoped marker'                 "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'n'
  ck 'reconcile leaves an out-of-scope marker alone'     "$([[ -f "$tmp/state/OTHER-last-fired-at" ]] && echo y || echo n)" 'y'
  ck 'reconcile never touches a neighbour canary file'   "$([[ -f "$tmp/state/some-canary.count" ]] && echo y || echo n)" 'y'
  ck 'reconcile emits NO transition'                     "$(grep -cE 'CLEAR_FIRED|CLEAR_SILENT' "$tmp/log")" '0'

  # ── THE UNSCOPED CASE, which is the only one where the GLOB is load-bearing ──────────────
  # Caught by the proof-it-can-fail step: the scoped case above survives a broken glob because
  # the alert_id filter rejects a neighbour anyway, so it passed while asserting nothing about
  # the glob. `--reconcile` with no id is the shape where $STATE_DIR being a SHARED directory
  # actually bites — seven other canaries keep .count/.set/.json state beside these markers.
  fresh; mark 111; echo 222 > "$tmp/state/OTHER-last-fired-at"
  echo keep > "$tmp/state/some-canary.count"
  echo keep > "$tmp/state/another-canary.set"
  run "$tmp/state" bash "$me" --reconcile
  ck 'unscoped reconcile drops EVERY marker'             "$(ls "$tmp/state"/*-last-fired-at 2>/dev/null | wc -l | tr -d ' ')" '0'
  ck 'unscoped reconcile spares a .count neighbour'      "$([[ -f "$tmp/state/some-canary.count" ]] && echo y || echo n)" 'y'
  ck 'unscoped reconcile spares a .set neighbour'        "$([[ -f "$tmp/state/another-canary.set" ]] && echo y || echo n)" 'y'

  # ── legacy 3-arg path byte-identical ─────────────────────────────────────
  # The documented verb for each legacy scenario, pinned. Any reordering of the gates, or a new
  # gate slipped in front of one, changes the verb a scenario produces and fails here.
  fresh; run "$tmp/state" bash "$me" AID LOW - < /dev/null
  ck 'legacy 3-arg path byte-identical: non-critical severity' "$(verb)" 'SUPPRESSED_SEVERITY'
  fresh; env VITEST=1 ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$tmp/state" \
      ALERT_WRAPPER_ENV="$tmp/env" bash "$me" AID CRITICAL_PERSISTENT - < /dev/null >/dev/null 2>&1
  ck 'legacy 3-arg path byte-identical: test context'    "$(verb)" 'SUPPRESSED_TEST_CONTEXT'
  fresh; mark "$(( $(date +%s) - 60 ))"; run "$tmp/state" bash "$me" AID CRITICAL_PERSISTENT - < /dev/null
  ck 'legacy 3-arg path byte-identical: cooldown'        "$(verb)" 'SUPPRESSED_COOLDOWN'
  fresh; env -u VITEST -u NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT=0 ALERT_WRAPPER_LOG="$tmp/log" \
      ALERT_WRAPPER_STATE_DIR="$tmp/state" ALERT_WRAPPER_ENV="$tmp/nope" \
      bash "$me" AID CRITICAL_PERSISTENT - < /dev/null >/dev/null 2>&1
  ck 'legacy 3-arg path byte-identical: no creds'        "$(verb)" 'FAILED_NO_ENV'
  fresh; printf 'b\n' | run "$tmp/state" bash "$me" AID CRITICAL_PERSISTENT -
  ck 'legacy 3-arg path byte-identical: fires'           "$(verb)" 'FIRED'
  ck 'legacy 3-arg path byte-identical: writes the marker' "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'y'

  # ── SEAM-BLINDNESS GUARD ─────────────────────────────────────────────────
  # Every POST above went through a stubbed curl, so this suite is structurally blind to the real
  # invocation. Assert the bypassed artifact directly: both POST sites must still carry the flags
  # that make them correct, and neither may hardcode `curl` past the seam.
  ck 'the fire POST keeps -sS -o -w and --max-time'   "$(grep -c '"\$TG_CURL" -sS -o "\$TMP_RESP" -w "%{http_code}" -X POST' "$me")" '1'
  ck 'the clear POST keeps -sS -o -w and --max-time'  "$(grep -c '"\$TG_CURL" -sS -o "\$tmp" -w "%{http_code}" -X POST' "$me")" '1'
  ck 'no POST bypasses the seam'                      "$(grep -cE '^\s*(HTTP_CODE=\$\(|code=\$\()curl ' "$me")" '0'
  ck 'the cooldown value is untouched'                "$(grep -c '^COOLDOWN_SEC=86400' "$me")" '1'

  # ── VACUITY GUARDS ───────────────────────────────────────────────────────
  checks=$((checks+1))
  if [[ $checks -lt 25 ]]; then
    echo "  ✗ this suite ran only $checks checks — it is asserting almost nothing"; fails=$((fails+1))
  fi
  checks=$((checks+1))
  if [[ ! -s "$tmp/log" ]]; then
    echo "  ✗ the captured log is EMPTY — every child was suppressed and nothing was asserted"
    fails=$((fails+1))
  fi

  if [[ $fails -ne 0 ]]; then
    echo "SELF-TEST: FAIL — $fails of $checks check(s) failed"
    echo "ALERT_WRAPPER_VERDICT=FAIL"
    exit 1
  fi
  echo "SELF-TEST: PASS — $checks checks (transitions both ways, silent-by-default, failed-send retains state, test context cannot clear production state, legacy 3-arg path byte-identical, reconcile emits nothing, seam-blindness guard)"
  echo "ALERT_WRAPPER_VERDICT=PASS"
  exit 0
}

case "$MODE" in
  clear)     do_clear ;;
  reconcile) do_reconcile ;;
  self-test) self_test ;;
esac

# Severity gate
if [[ "$SEVERITY" != "CRITICAL_PERSISTENT" ]]; then
  log "SUPPRESSED_SEVERITY: severity=$SEVERITY not in TG-fire set"
  exit 0
fi

# ── TEST-CONTEXT GATE (OPS-AUTOPUB-TEST-ALERT-LEAK-W1, 2026-07-22) ────────────────────────
# No alert may originate from a test process.
#
# WHY HERE AND NOT IN THE CALLERS: this wrapper is the single choke point for ALL Telegram
# egress, and node/vitest child processes inherit the parent env, so one gate here covers every
# current AND future consumer in any language — instead of each caller remembering to inject a
# stub. `lib/drafter.mjs` and `lib/anchor-numeric-claims.mjs` already accept an injectable
# `invoker` for exactly this, but the DEFAULT is the real wrapper, so any test that drives the
# module end-to-end (rather than calling the alert fn directly) fires for real. That happened on
# 2026-07-22T12:43:22Z: `tests/unit/drafter.test.mjs` runs the real drafter against a fake
# `claude` that emits malformed output, retries exhausted, and the escalation paged the operator
# with test-fixture text.
#
# DELIBERATELY BEFORE THE COOLDOWN GATE, and it does NOT write the marker. The dangerous half of
# that incident was not the spurious message — it was that firing WROTE the 24h cooldown marker,
# which would have SILENCED the next genuine drafter failure. A test run must leave production
# alert state untouched.
#
# Backward-compatible: both vars are unset in production, so prod behaviour is byte-identical.
# Forward-compatible: ALGOVAULT_TG_TEST_INERT is the explicit escape hatch for non-node harnesses.
if is_test_context; then
  log "SUPPRESSED_TEST_CONTEXT: alert raised from a test process (NODE_TEST_CONTEXT=${NODE_TEST_CONTEXT:-} VITEST=${VITEST:-} ALGOVAULT_TG_TEST_INERT=${ALGOVAULT_TG_TEST_INERT:-0}); no POST, no cooldown marker"
  exit 0
fi

# Cooldown gate
MARKER="$STATE_DIR/${ALERT_ID}-last-fired-at"
if [[ -f "$MARKER" ]]; then
  LAST=$(cat "$MARKER")
  NOW=$(date +%s)
  AGE=$((NOW - LAST))
  if [[ $AGE -lt $COOLDOWN_SEC ]]; then
    HRS=$((AGE / 3600))
    log "SUPPRESSED_COOLDOWN: last fired ${HRS}h ago (cooldown ${COOLDOWN_SEC}s)"
    exit 0
  fi
fi

# Source TG credentials
if [[ ! -r "$ENV_FILE" ]]; then
  log "FAILED_NO_ENV: $ENV_FILE not readable"
  exit 0  # fail-open per contract row 5
fi
# shellcheck disable=SC1091
. "$ENV_FILE"
: "${TELEGRAM_BOT_TOKEN:?TG token unset}" "${TELEGRAM_CHAT_ID:?chat id unset}"

# Read body
if [[ "$BODY_INPUT" == "-" ]]; then
  BODY=$(cat)
else
  BODY=$(cat "$BODY_INPUT")
fi

# === PATCH-B: resolver invocation — AFTER body-read, AFTER cooldown, BEFORE DRY_RUN gate ===
BODY=$(resolve_template "$BODY")
BODY_LOG=$(echo "$BODY" | tr '\n' ' ' | head -c 1500)

# PATCH-A: DRY_RUN_TG gate — synthetic smokes + cred probes go through ALL gate logic
# but skip the actual TG POST. Marker is still written so cooldown-suppression smokes work.
if [[ "${DRY_RUN_TG:-0}" == "1" ]]; then
  date +%s > "$MARKER"
  log "DRY_RUN_FIRED: TG POST skipped (DRY_RUN_TG=1); marker written for cooldown smokes; body=${BODY_LOG}"
  exit 0
fi

# Post to TG (fail-open: log error but exit 0 so caller cron doesn't bounce)
TMP_RESP=$(mktemp /tmp/.tg-resp-XXXXXX)
HTTP_CODE=$("$TG_CURL" -sS -o "$TMP_RESP" -w "%{http_code}" -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${BODY}" \
  --max-time 10 || echo "000")

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  date +%s > "$MARKER"
  log "FIRED: HTTP $HTTP_CODE body=${BODY_LOG}"
  rm -f "$TMP_RESP"
  exit 0
else
  RESP=$(head -c 500 "$TMP_RESP" 2>/dev/null || echo "")
  log "FAILED_TG_API: HTTP $HTTP_CODE response='${RESP}'"
  rm -f "$TMP_RESP"
  exit 0  # fail-open per contract
fi
