#!/usr/bin/env bash
# ops/cron/xrepo-ci-conclusion-canary.sh — OPS-MARKETPLACE-CANARY-REPAIR-W1 (2026-08-06)
#
# WHY THIS EXISTS. `algovault-skills`'s Marketplace Health Check — the only automated
# watcher of AlgoVault's public distribution surface — failed FORTY consecutive runs
# (2026-06-27 → 2026-08-05) and alerted nobody. Two independent reasons:
#   1. it asserted a protocol contract the server deliberately abandoned (fixed in CH2), and
#   2. its own alert step resolved both Telegram secrets to empty and `exit 0`'d — dark by
#      construction, because that repo holds no Telegram credentials at all.
# Nothing else was watching, because `ops/monitoring/monitoring-inventory.json` models HOST
# artifacts and a GitHub Actions workflow in a SECOND repo sits outside it entirely.
#
# ARCHITECT RULING: do NOT duplicate bot credentials into a second repo. Watch it from here
# instead, and alert through the existing, proven send_telegram.sh. One mechanism, one place
# credentials live. This also subsumes the separate "cross-repo CI visibility" work.
#
# NO TOKEN, AND NOW NO REST BUDGET EITHER (OPS-XREPO-CI-CANARY-DARK-W1, 2026-08-21).
# ─────────────────────────────────────────────────────────────────────────────────────────────
# The original reader called `api.github.com/repos/.../actions/workflows/<wf>/runs`. That
# endpoint is UNAUTHENTICATED 60/hr PER IP, shared with everything else egressing this box, and
# signal-1's budget is drained. Measured over this canary's whole life: it read a real conclusion
# on TWO days. Its INDETERMINATE streaks ran 3 (08-08), 5 (08-12→14) and 6 (08-15 →), and on
# 2026-08-21 09:41:02Z it correctly paged the operator to say it was dark.
#
# The fix is NOT a credential. The 9th probe — "does the underlying tool ALREADY do this?" —
# found that it does:
#
#     https://github.com/<owner>/<repo>/actions/workflows/<wf>/badge.svg?branch=<branch>
#
# MEASURED 2026-08-21 in one shell ON signal-1: `api.github.com` → HTTP 403 (rate limited) while
# the badge → HTTP 200 carrying the conclusion in its <title>. The two are metered SEPARATELY, so
# the badge is immune to the drain BY CONSTRUCTION rather than by anyone fixing the drain. This is
# the same migration `/opt/mcp-spec-watcher/watch.sh` already made on this host, away from
# api.github.com and onto a CDN-served feed, for this exact reason.
#
# A NARROW TOKEN WAS REJECTED and the reason is worth keeping: this file's own contract said a
# canary that needs a credential is one that dies when the credential expires — which is the class
# of failure it exists to catch. That argument is still correct, and the badge means we never have
# to weigh it. Moving the canary to aoe-1 (which has budget) was also rejected: that budget is a
# stable difference, not a standing guarantee, and it would split one alert path across two hosts.
#
# THE BADGE ANSWERS A DIFFERENT QUESTION THAN REST DID — SO THE BRANCH IS DECLARED, NOT INFERRED.
# ─────────────────────────────────────────────────────────────────────────────────────────────
# REST with `?status=completed&per_page=1` returned the newest completed run on ANY branch. The
# badge returns the latest run on ONE branch. Swapping one for the other silently would be the
# "confident number for the WRONG QUANTITY" defect this repo has now recorded three times, so the
# branch is a REQUIRED 4th field on every watch row and a row missing it REFUSES. The watch list
# is a corpus WE construct, so a malformed row is a config defect, never a fact about the world.
#
# BADGE VOCABULARY — MEASURED, never assumed. Every token below was observed live 2026-08-21:
#   passing     ← latest run conclusion = success
#   failing     ← latest run conclusion = failure  ... AND ALSO = cancelled (measured: the badge
#                 collapses every non-success terminal state into `failing`). Accepted: for a
#                 health canary "the workflow did not succeed" is the operator-actionable fact.
#   no status   ← the workflow has no runs on that branch
#   HTTP 404    ← the workflow file or the repo does not exist
# ANY token outside that set is INDETERMINATE with the raw title logged — never a laundered PASS.
# If GitHub ever changes the badge markup this canary goes DARK and says so, which is the correct
# direction to fail.
#
# NO CACHE-BUSTER, DELIBERATELY. The badge is served `cache-control: max-age=300, private`. The
# CLAUDE.md rule is that a CDN-cached VERIFICATION read is controlled by a cache-buster or a
# pinned SHA — and its corollary is that a fetch cadence far longer than the TTL does not need one
# at all. This cron is DAILY (86400s) against a 300s TTL, so a buster here would be pure churn.
#
# Contract (Claude files/monitoring-runbook.md ## Operator-action-required alert contract):
# ships ONLY the pure alert branch. send_telegram.sh OWNS the severity gate, the 24h-per-
# alert_id cooldown, the recommended-wave resolver and its own fail-open.
#
# FAIL-OPEN, per the ops/cron convention: an infra error logs and exits 0 rather than
# bouncing the cron. The VERDICT TOKEN still tells the truth in that case — INDETERMINATE,
# never a laundered PASS — so a caller reading the token can tell "all watched workflows are
# green" from "I could not find out" (CLAUDE.md verdict-token law).
#
# Suggested crontab (daily, off-:00 per snapshot-sampler discipline; marketplace-check.yml
# runs at 08:00 UTC, so 09:41 leaves it time to finish): 41 9 * * *
#
# On the SECOND row's cadence (OPS-CI-MAIN-WRITER-HARDEN-W1, 2026-08-21): regenerate-landing.yml
# is event-driven (repository_dispatch from algovault-skills), not scheduled, so no clock offset
# can be "after it finishes". That is fine and is worth stating so nobody later tunes the cron
# hoping to fix it: this canary reads the LATEST run, never an in-flight one, so the only thing
# the schedule governs is DETECTION LATENCY — a red regeneration is surfaced within 24h rather
# than at the moment it happens. Given that workflow fired 12 times in the four months to
# 2026-08-21, 24h is far inside the window in which it would otherwise have gone unnoticed
# indefinitely: before this row, nothing watched it at all.
#
# Self-test: `bash ops/cron/xrepo-ci-conclusion-canary.sh --self-test`
set -uo pipefail

SEND="${XREPO_CI_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${XREPO_CI_LOG:-/var/log/xrepo-ci-conclusion-canary.log}"
BADGE_HOST="${XREPO_CI_BADGE_HOST:-https://github.com}"
STATE="${XREPO_CI_STATE:-/var/lib/algovault-monitoring/xrepo-ci-indet-streak}"

# DECLARED watch list. Adding a workflow is a row here, not a code change.
# Format: <owner/repo>|<workflow-file>|<human label>|<branch>
# `${VAR-default}` NOT `${VAR:-default}`: an EXPLICITLY EMPTY watch list is a config
# defect and must reach the refusal below, whereas `:-` would silently substitute the
# default and report a confident all-clear over a list someone had just emptied.
# regenerate-landing.yml is the ONE CI writer of this repo's `main` (enumerated 2026-08-21 across
# all 6 workflows; publish-npm.yml's `git push` hit is a comment). It commits regenerated landing
# surfaces AND README.md — the canonical npm-README SoT — and OPS-CI-MAIN-WRITER-HARDEN-W1 gave it
# a bounded rebase-retry so it survives losing the race. What that hardening CANNOT make safe is a
# genuine rebase conflict: it aborts and fails the run, deliberately, because auto-resolving would
# risk authored release copy. This row is what makes that refusal LOUD. Without it the fix would
# fail loudly into an empty room — the same shape as the 40 unnoticed red runs that produced this
# script in the first place, one repo over.
# The 4th field is the BRANCH and it is REQUIRED — see the header on why it may not be inferred.
WATCHED="${XREPO_CI_WATCHED-AlgoVaultLabs/algovault-skills|marketplace-check.yml|Marketplace Health Check|main
AlgoVaultLabs/crypto-quant-signal-mcp|regenerate-landing.yml|Landing Regeneration|main}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG" >/dev/null 2>&1 || true; }
verdict() { echo "XREPO_CI_VERDICT=$1"; }

# ── PURE FUNCTIONS ───────────────────────────────────────────────────────────────────────────
# These are the pieces the self-test's fetch seam BYPASSES, so they are extracted and asserted
# directly. A hermetic self-test is structurally blind to exactly what its own seam replaces —
# that is a paid-for law in this repo, not a style preference.

badge_url() { printf '%s/%s/actions/workflows/%s/badge.svg?branch=%s' "$BADGE_HOST" "$1" "$2" "$3"; }

# The human-facing page for a RED alert. Deterministic, needs no API call — which is the whole
# point: the alert stays actionable even though we no longer hold a run id or a run URL.
actions_url() { printf '%s/%s/actions/workflows/%s?query=branch%%3A%s' "$BADGE_HOST" "$1" "$2" "$3"; }

# Extract the status token from the badge SVG's <title>. GitHub renders it as
# "<workflow name> - <status>", and a workflow NAME may itself contain " - ", so take the LAST
# segment, never the second one.
parse_badge_status() {
  local svg t
  svg=$(printf '%s' "$1" | tr '\n' ' ')
  t=$(printf '%s' "$svg" | sed -n 's/.*<title>\([^<]*\)<\/title>.*/\1/p' | head -1)
  [ -n "$t" ] || return 1
  case "$t" in
    *" - "*) printf '%s' "${t##* - }" ;;
    *) return 1 ;;
  esac
}

# MEASURED vocabulary only. Anything else is INDETERMINATE — the fail-safe direction.
classify_status() {
  case "$1" in
    passing)     echo PASS ;;
    failing)     echo FAIL ;;
    "no status") echo INDETERMINATE ;;
    *)           echo INDETERMINATE ;;
  esac
}

# ── THE ONE NETWORK SEAM ─────────────────────────────────────────────────────────────────────
# Writes the body to $2 and echoes the HTTP status. XREPO_CI_FIXTURE_DIR replaces the fetch for
# the self-test ONLY; it can never manufacture a PASS, because the verdict still comes from
# parse_badge_status + classify_status running on the bytes it returns.
fetch_badge() {
  local url="$1" out="$2" fx
  if [ -n "${XREPO_CI_FIXTURE_DIR:-}" ]; then
    fx="$XREPO_CI_FIXTURE_DIR/$(printf '%s' "$url" | tr -c 'A-Za-z0-9' '_')"
    if [ -f "$fx.svg" ]; then cat "$fx.svg" > "$out"; cat "$fx.code" 2>/dev/null || echo 200
    else : > "$out"; echo 404; fi
    return 0
  fi
  curl -sS --max-time 25 -o "$out" -w '%{http_code}' "$url" 2>/dev/null || echo 000
}

run_checks() {
  CHECKED=0; RED=0; INDET=0; RED_DETAIL=""
  local body; body=$(mktemp "${TMPDIR:-/tmp}/xrepo.XXXXXX")
  local REPO WF LABEL BRANCH URL HTTP SVG STATUS CLASS
  while IFS='|' read -r REPO WF LABEL BRANCH; do
    [ -n "${REPO:-}" ] || continue
    CHECKED=$((CHECKED + 1))
    # A row we authored ourselves that is missing its branch is a CONFIG defect, and the corpus
    # is one we construct — so refuse rather than infer a default branch and report on a quantity
    # nobody declared.
    if [ -z "${BRANCH:-}" ]; then
      echo "  x ${LABEL:-$WF} ($REPO): watch row has NO BRANCH field — config defect, refusing"
      log "INDETERMINATE $REPO/$WF — watch row missing required branch field"
      INDET=$((INDET + 1)); continue
    fi
    URL=$(badge_url "$REPO" "$WF" "$BRANCH")
    HTTP=$(fetch_badge "$URL" "$body")
    if [ "$HTTP" != "200" ]; then
      log "INDETERMINATE $REPO/$WF@$BRANCH — badge HTTP $HTTP"
      echo "  ? $LABEL ($REPO@$BRANCH): badge HTTP $HTTP — cannot verify"
      INDET=$((INDET + 1)); continue
    fi
    SVG=$(cat "$body" 2>/dev/null || true)
    if ! STATUS=$(parse_badge_status "$SVG"); then
      log "INDETERMINATE $REPO/$WF@$BRANCH — badge markup did not parse"
      echo "  ? $LABEL ($REPO@$BRANCH): badge markup did not parse — cannot verify"
      INDET=$((INDET + 1)); continue
    fi
    CLASS=$(classify_status "$STATUS")
    case "$CLASS" in
      PASS)
        echo "  + $LABEL ($REPO@$BRANCH): latest run = $STATUS"
        log "OK $REPO/$WF@$BRANCH $STATUS" ;;
      FAIL)
        echo "  x $LABEL ($REPO@$BRANCH): latest run = $STATUS"
        log "RED $REPO/$WF@$BRANCH $STATUS"
        RED=$((RED + 1))
        RED_DETAIL="$RED_DETAIL
- $REPO/$WF (branch $BRANCH): $STATUS
  $(actions_url "$REPO" "$WF" "$BRANCH")" ;;
      *)
        echo "  ? $LABEL ($REPO@$BRANCH): badge says '$STATUS' — not a conclusion, cannot verify"
        log "INDETERMINATE $REPO/$WF@$BRANCH status='$STATUS'"
        INDET=$((INDET + 1)) ;;
    esac
  done <<EOF
$(printf '%s\n' "$WATCHED")
EOF
  rm -f "$body" 2>/dev/null || true
}

# ── ALERT BODIES ─────────────────────────────────────────────────────────────────────────────
# REAL newlines, never `%0A` (OPS-XREPO-CI-CANARY-DARK-W1). send_telegram.sh does its own
# `--data-urlencode "text=${BODY}"`, so a body carrying `%0A` is DOUBLE-encoded and Telegram
# prints the escape literally. Measured on the delivered body 2026-08-21:
#   09:41:02Z [xrepo_ci_dark] FIRED: HTTP 200 body=🟡 AlgoVault Alert%0A%0Across-repo CI canary…
# This was the ONLY host caller still using `%0A`; the other ~30 all pipe real newlines. Only a
# REAL delivery could expose it — the fire-path proof stops at SUPPRESSED_TEST_CONTEXT, before
# rendering — which is why the self-test now asserts the rendered BODY and not just the verdict.
red_body() {
  local n="$1" detail="$2" noun="workflows are"
  [ "$n" -eq 1 ] && noun="workflow is"
  printf '%s\n\n%s cross-repo CI %s RED%s\n\nAction: dispatch OPS-XREPO-CI-RED-W{NEXT}\nSource: ops/cron/xrepo-ci-conclusion-canary.sh' \
    "🟡 AlgoVault Alert" "$n" "$noun" "$detail"
}

dark_body() {
  printf '%s\n\n%s\n' "🟡 AlgoVault Alert" \
"cross-repo CI canary has been UNABLE TO VERIFY for $1 consecutive runs.
It is dark, not green — no workflow conclusion has been read.
The reader is the GitHub Actions badge endpoint, which is NOT metered by the
REST API budget, so a rate limit is no longer a plausible cause: check
that github.com is reachable from this host and that the badge markup still
carries its <title>.

Action: dispatch OPS-XREPO-CI-CANARY-DARK-W{NEXT}
Source: ops/cron/xrepo-ci-conclusion-canary.sh"
}

fire() {
  local id="$1" body="$2"
  if [ -x "$SEND" ]; then
    # POSITIONAL, per send_telegram.sh's documented contract
    # (`<alert_id> <severity> [body_file|-]`) — corrected 2026-08-21 by
    # OPS-CI-MAIN-WRITER-HARDEN-W1 after BOTH alerts had been dark since this script's first
    # commit: the env-var form left `$2` unset, the wrapper died on `severity required`, and the
    # fail-open tail swallowed it into a log nobody reads.
    printf '%s' "$body" | "$SEND" "$id" "CRITICAL_PERSISTENT" - >/dev/null 2>&1 \
      || log "send_telegram.sh failed (fail-open)"
  else
    log "send_telegram.sh not executable at $SEND — alert NOT sent (fail-open)"
    echo "  ! alerter missing at $SEND — a $id condition went unannounced"
  fi
}

main() {
  command -v curl >/dev/null 2>&1 || { log "curl missing — cannot verify"; verdict INDETERMINATE; exit 0; }

  run_checks

  if [ "$CHECKED" -eq 0 ]; then
    # We build this list, so an empty one is a defect in the config, not a fact about
    # the world — refuse rather than report a confident all-clear over nothing.
    echo "  x watch list is EMPTY — nothing was checked"
    log "INDETERMINATE empty watch list"
    verdict INDETERMINATE; exit 0
  fi

  if [ "$RED" -gt 0 ]; then
    fire "xrepo_ci_red" "$(red_body "$RED" "$RED_DETAIL")"
    verdict FAIL; exit 0
  fi

  # A canary that cannot answer must not be quietly content. CLAUDE.md: a dark guard
  # exiting 0 is indistinguishable from a healthy one, so persistent INDETERMINATE
  # escalates on its own rather than waiting to be noticed — which is precisely what
  # nobody did for the 40 runs that motivated this script.
  if [ "$INDET" -gt 0 ]; then
    local STREAK
    STREAK=$(cat "$STATE" 2>/dev/null || echo 0)
    case "$STREAK" in ''|*[!0-9]*) STREAK=0 ;; esac
    STREAK=$((STREAK + 1))
    echo "$STREAK" > "$STATE" 2>/dev/null || true
    echo "  checked $CHECKED workflow(s): $INDET indeterminate, $RED red (consecutive indeterminate runs: $STREAK)"
    if [ "$STREAK" -ge 3 ]; then
      fire "xrepo_ci_dark" "$(dark_body "$STREAK")"
      log "DARK streak=$STREAK — escalated"
    fi
    verdict INDETERMINATE; exit 0
  fi

  echo 0 > "$STATE" 2>/dev/null || true
  echo "  checked $CHECKED workflow(s): all green"
  verdict PASS; exit 0
}

# ── SELF-TEST ────────────────────────────────────────────────────────────────────────────────
self_test() {
  local tmp fails=0 checks=0 out
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/xrepotest.XXXXXX") || { echo "XREPO_CI_VERDICT=INDETERMINATE"; exit 3; }
  # An assertion that RAISES is not an assertion — every check reports FAIL and continues.
  ck() { checks=$((checks + 1)); if [ "$2" != "$3" ]; then echo "  ✗ $1 (got '$2' want '$3')"; fails=$((fails + 1)); fi; }
  ckc() { checks=$((checks + 1)); case "$2" in *"$3"*) ;; *) echo "  ✗ $1 ('$2' does not contain '$3')"; fails=$((fails + 1)) ;; esac; }
  ckn() { checks=$((checks + 1)); case "$2" in *"$3"*) echo "  ✗ $1 ('$2' MUST NOT contain '$3')"; fails=$((fails + 1)) ;; *) ;; esac; }

  echo "SELF-TEST: pure functions (the pieces the fetch seam bypasses)"
  ck "badge_url shape" "$(BADGE_HOST=https://github.com badge_url o/r wf.yml main)" \
     "https://github.com/o/r/actions/workflows/wf.yml/badge.svg?branch=main"
  ck "actions_url shape" "$(BADGE_HOST=https://github.com actions_url o/r wf.yml main)" \
     "https://github.com/o/r/actions/workflows/wf.yml?query=branch%3Amain"
  ck "parse passing"   "$(parse_badge_status '<svg><title>Marketplace Health Check - passing</title></svg>')" "passing"
  ck "parse failing"   "$(parse_badge_status '<svg><title>Postgres test lane - failing</title></svg>')" "failing"
  ck "parse no status" "$(parse_badge_status '<svg><title>Postgres test lane - no status</title></svg>')" "no status"
  # A workflow NAME containing " - " must not fool the split — take the LAST segment.
  ck "parse name with dash" "$(parse_badge_status '<svg><title>Build - Deploy - passing</title></svg>')" "passing"
  ck "parse refuses markup with no title" "$(parse_badge_status '<svg></svg>' || echo REFUSED)" "REFUSED"
  ck "parse refuses title with no separator" "$(parse_badge_status '<svg><title>whatever</title></svg>' || echo REFUSED)" "REFUSED"
  ck "classify passing"   "$(classify_status passing)"     "PASS"
  ck "classify failing"   "$(classify_status failing)"     "FAIL"
  ck "classify no status" "$(classify_status 'no status')" "INDETERMINATE"
  ck "classify unmeasured token is INDETERMINATE, never PASS" "$(classify_status 'brand new github word')" "INDETERMINATE"

  echo "SELF-TEST: rendered ALERT BODIES (a verdict assertion cannot see a mis-rendered body)"
  local rb db RN
  RN=$'Alert\n'
  rb=$(red_body 1 "
- o/r (branch main): failing
  https://github.com/o/r/actions/workflows/wf.yml?query=branch%3Amain")
  db=$(dark_body 6)
  ckn "red body has NO literal %0A"  "$rb" '%0A'
  ckn "dark body has NO literal %0A" "$db" '%0A'
  ckc "red body has a real newline"  "$rb" "$RN"
  ckc "dark body has a real newline" "$db" "$RN"
  ck  "red body pluralises 1 correctly" "$(red_body 1 '' | sed -n '3p')" "1 cross-repo CI workflow is RED"
  ck  "red body pluralises 2 correctly" "$(red_body 2 '' | sed -n '3p')" "2 cross-repo CI workflows are RED"
  ckc "red body names the actions page" "$rb" "query=branch%3Amain"
  ckc "dark body carries the streak"    "$db" "6 consecutive runs"
  # The dark body must no longer blame a rate limit — the reader is not metered by that budget.
  ckn "dark body no longer blames the REST budget" "$db" "60/hr"

  echo "SELF-TEST: end-to-end through the fetch seam"
  mkfx() { # <url> <status-token> [http-code]
    local f; f="$tmp/fx/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"
    mkdir -p "$tmp/fx"
    printf '<svg><title>Some Workflow - %s</title></svg>' "$2" > "$f.svg"
    printf '%s' "${3:-200}" > "$f.code"
  }
  # A mock alerter that enforces the SAME positional refusal the real wrapper does, so a
  # regression to the env-var form FAILS this proof instead of passing it silently.
  cat > "$tmp/send.sh" <<'MOCK'
#!/usr/bin/env bash
: "${1:?alert_id required}"
: "${2:?severity required}"
body=$([ "${3:--}" = "-" ] && cat || cat "$3")
printf '%s|%s|%s\n' "$1" "$2" "$body" >> "$MOCK_SINK"
MOCK
  chmod +x "$tmp/send.sh"

  run_case() { # <watched> <expect-verdict>
    MOCK_SINK="$tmp/sink" XREPO_CI_FIXTURE_DIR="$tmp/fx" XREPO_CI_WATCHED="$1" \
      XREPO_CI_SEND="$tmp/send.sh" XREPO_CI_LOG="$tmp/log" XREPO_CI_STATE="$tmp/streak" \
      bash "$0" 2>&1
  }

  local A="https://github.com/o/a/actions/workflows/w.yml/badge.svg?branch=main"
  local B="https://github.com/o/b/actions/workflows/w.yml/badge.svg?branch=main"
  local ROWS="o/a|w.yml|Alpha|main
o/b|w.yml|Beta|main"

  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  mkfx "$A" passing; mkfx "$B" passing
  out=$(run_case "$ROWS")
  ckc "all-green run reports PASS" "$out" "XREPO_CI_VERDICT=PASS"
  ckc "all-green run emits POSITIVE per-row output, not absence-of-alert" "$out" "+ Alpha (o/a@main): latest run = passing"
  ck  "all-green run fires nothing" "$(wc -l < "$tmp/sink" | tr -d ' ')" "0"
  ck  "all-green run resets the streak" "$(cat "$tmp/streak")" "0"

  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  mkfx "$B" failing
  out=$(run_case "$ROWS")
  ckc "one-failing run reports FAIL" "$out" "XREPO_CI_VERDICT=FAIL"
  ckc "one-failing run FIRES with the right id and severity" "$(cat "$tmp/sink")" "xrepo_ci_red|CRITICAL_PERSISTENT|"
  ckc "the fired body names the workflow" "$(cat "$tmp/sink")" "o/b/w.yml (branch main): failing"
  ckn "the fired body has no literal %0A" "$(cat "$tmp/sink")" '%0A'

  : > "$tmp/sink"; echo 2 > "$tmp/streak"
  mkfx "$B" 'no status'
  out=$(run_case "$ROWS")
  ckc "no-status run reports INDETERMINATE" "$out" "XREPO_CI_VERDICT=INDETERMINATE"
  ckc "3rd consecutive indeterminate ESCALATES" "$(cat "$tmp/sink")" "xrepo_ci_dark|CRITICAL_PERSISTENT|"
  ck  "streak advanced to 3" "$(cat "$tmp/streak")" "3"

  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  mkfx "$B" passing 404
  out=$(run_case "$ROWS")
  ckc "HTTP 404 is INDETERMINATE, never FAIL" "$out" "XREPO_CI_VERDICT=INDETERMINATE"
  ckc "HTTP 404 says so per-row" "$out" "badge HTTP 404"

  : > "$tmp/sink"; echo 0 > "$tmp/streak"
  mkfx "$B" passing
  out=$(run_case "o/a|w.yml|Alpha|main
o/b|w.yml|Beta")
  ckc "a watch row with NO BRANCH refuses" "$out" "watch row has NO BRANCH field"
  ckc "a watch row with NO BRANCH yields INDETERMINATE" "$out" "XREPO_CI_VERDICT=INDETERMINATE"

  out=$(run_case "")
  ckc "an EMPTY watch list refuses rather than reporting all-clear" "$out" "watch list is EMPTY"
  ckc "an EMPTY watch list yields INDETERMINATE" "$out" "XREPO_CI_VERDICT=INDETERMINATE"

  echo "SELF-TEST: the shipped script never calls api.github.com"
  # Scan the executable body but CUT the self-test itself first: this assertion's own grep
  # pattern is executable text, so a naive scan would count itself and never be able to pass.
  ck "the reader never calls the REST API" \
     "$(grep -v '^ *#' "$0" | sed '/^self_test()/,$d' | grep -c 'api\.github\.com' | tr -d ' ')" "0"

  rm -rf "$tmp" 2>/dev/null || true
  # Vacuity guard: this suite must never report a pass having asserted nothing.
  if [ "$checks" -lt 30 ]; then
    echo "  ✗ only $checks checks ran — vacuity guard"; fails=$((fails + 1))
  fi
  if [ "$fails" -gt 0 ]; then
    echo "SELF-TEST: FAIL — $fails of $checks"
    verdict FAIL; exit 1
  fi
  echo "SELF-TEST: PASS — $checks assertions"
  verdict PASS; exit 0
}

if [ "${1:-}" = "--self-test" ]; then self_test; fi
main
