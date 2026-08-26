#!/usr/bin/env bash
#
# ops/cron/binance-pr-disposition-canary.sh — OPS-DATEMODIFIED-DERIVE-AND-PR-DISPOSITION-W1 R2.
#
# Watches ONE bit that can change at most once in 90 days: has anyone at Binance engaged with
# PR #254, or should we close it ourselves and keep only the surfaces we own?
#
# BINANCE-AGENT-OS-GEO-AND-SUBMISSIONS-W2 recorded the disposition honestly — opened 2026-05-08,
# 0 maintainer comments, and ZERO third-party skills have ever been merged into that hub. A
# lottery ticket, not a channel. This canary is the trigger that forces the decision instead of
# letting the PR sit open forever because nobody scheduled the question.
#
# ── WHY A DATE GATE, AND NOT A DAILY POLL ────────────────────────────────────────────────────
# Polling a 90-day question 90 times spends 90 requests to learn one bit. `api.github.com` is
# metered 60/hr PER IP, unauthenticated and SHARED by every process on this host, and it has been
# observed fully drained here: on 2026-08-21 `xrepo-ci-conclusion-canary.sh` measured HTTP 403
# from this host while a github.com badge returned 200, and that canary spent almost its whole
# life INDETERMINATE as a result (OPS-XREPO-CI-CANARY-DARK-W1).
#
# CORRECTION, measured on signal-1 2026-08-26 10:40 UTC: the budget is NOT drained today —
# `api.github.com/…/pulls/254` returned HTTP 200 and `/rate_limit` reported core 59/60. The
# 2026-08-21 exhaustion was a point-in-time state, not a standing property. That is precisely why
# the date gate is still the right shape: the budget is volatile and shared, so a canary that
# needs it 90 times is fragile and one that needs it twice is not. Before the decision date this
# script makes ZERO network calls.
#
# ── WHY THE API AND NOT THE WEB PAGE ─────────────────────────────────────────────────────────
# The 9th probe says prefer a surface the tool already offers, and `xrepo-ci-conclusion-canary.sh`
# made exactly that migration (REST → badge.svg) for its own question. MEASURED here on signal-1
# 2026-08-26 before writing a line — and for THIS question it comes out the other way:
#
#   github.com/binance/binance-skills-hub/pull/254   → 200, 292 KB, carries `"state":"OPEN"`
#                                                      but NO comment or review count at all.
#   api.github.com/repos/…/pulls/254                 → 200, ~1 KB, carries state, merged,
#                                                      comments, review_comments.
#
# The web page cannot distinguish OPEN_UNENGAGED from OPEN_ENGAGED, and that distinction IS the
# alert. A surface that cannot answer the question is not a cheaper way to answer it. So: the API,
# twice per 90 days, with 403 → INDETERMINATE and never a pass.
#
# ── THE TRAP THAT WOULD HAVE MADE THIS DARK ON DAY ONE ───────────────────────────────────────
# PR #254 has 1 comment and it is OURS (`AlgoVaultFi`, author_association NONE, posted by W2 CH3).
# A naive `comments > 0 ⇒ ENGAGED` would report ENGAGED forever and the one branch that pages
# could NEVER fire — a guard dark by construction, shipped by the wave that added it. Engagement
# is therefore keyed on author_association, never on a count. Measured vocabulary, 2026-08-26:
#   state: "open" | "closed"          merged: true | false
#   author_association: OWNER | MEMBER | COLLABORATOR | CONTRIBUTOR | NONE
# Ours reads NONE. Maintainer engagement = OWNER | MEMBER | COLLABORATOR, or any review.
#
# ── VERDICT TOKEN ────────────────────────────────────────────────────────────────────────────
#   BINANCE_PR_DISPOSITION_VERDICT=OPEN_UNENGAGED|OPEN_ENGAGED|CLOSED|INDETERMINATE
# Callers gate on the TOKEN, never the exit code. A run that read nothing must never be
# indistinguishable from a run that read CLOSED.
#   exit 0 → gate not yet due, or a state was read (OPEN_UNENGAGED / OPEN_ENGAGED / CLOSED)
#   exit 3 → INDETERMINATE (token-law default for a new gate; NOT check_test_baseline.sh's 2)
# Only OPEN_UNENGAGED pages. send_telegram.sh owns the severity gate and the 24h-per-alert
# cooldown — one mechanism, one place credentials live — so this ships only the alert branch.
#
# Self-test: `bash ops/cron/binance-pr-disposition-canary.sh --self-test`
set -uo pipefail

SEND="${BINANCE_PR_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${BINANCE_PR_LOG:-/var/log/binance-pr-disposition-canary.log}"
STATE="${BINANCE_PR_STATE:-/var/lib/algovault-monitoring/binance-pr-disposition-last-read}"
API_HOST="${BINANCE_PR_API_HOST:-https://api.github.com}"
PR_REPO="${BINANCE_PR_REPO:-binance/binance-skills-hub}"
PR_NUM="${BINANCE_PR_NUM:-254}"
OUR_LOGIN="${BINANCE_PR_OUR_LOGIN:-AlgoVaultFi}"

# 90 days from 2026-08-26, the date W2 recorded the disposition. `${VAR-default}` not `${VAR:-…}`:
# an EXPLICITLY EMPTY decision date is a config defect and must reach the refusal below, whereas
# `:-` would silently substitute the default and quietly re-arm a gate someone had just cleared.
DECIDE_ON="${BINANCE_PR_DECIDE_ON-2026-11-24}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG" >/dev/null 2>&1 || true; }
verdict() { echo "BINANCE_PR_DISPOSITION_VERDICT=$1"; }

# ── PURE FUNCTIONS ───────────────────────────────────────────────────────────────────────────
# The self-test's fetch seam BYPASSES the network, so everything that DECIDES is extracted here
# and asserted directly. A hermetic self-test is structurally blind to exactly what its own seam
# replaces — a paid-for law in this repo, not a style preference.

# Does this PR JSON describe a resolved PR? Echoes CLOSED, OPEN, or nothing (unparseable).
pr_state() {
  printf '%s' "$1" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    s = d.get("state")
    if s == "closed":
        print("CLOSED")
    elif s == "open":
        print("OPEN")
except Exception:
    pass
' 2>/dev/null
}

# Count MAINTAINER engagement: comments whose author_association marks them as repo-side, plus
# any review. Deliberately NOT a raw comment count — ours is already in there and always will be.
maintainer_engagement() {
  local pr_json="$1" comments_json="$2" ours="$3"
  printf '%s\n---SPLIT---\n%s' "$pr_json" "$comments_json" | OURS="$ours" python3 -c '
import sys, json, os
raw = sys.stdin.read().split("\n---SPLIT---\n", 1)
ours = os.environ.get("OURS", "")
n = 0
try:
    pr = json.loads(raw[0])
    n += int(pr.get("review_comments") or 0)
except Exception:
    print("ERR"); sys.exit(0)
try:
    for c in json.loads(raw[1]) if len(raw) > 1 and raw[1].strip() else []:
        login = (c.get("user") or {}).get("login") or ""
        assoc = c.get("author_association") or ""
        if login == ours:
            continue
        if assoc in ("OWNER", "MEMBER", "COLLABORATOR"):
            n += 1
except Exception:
    print("ERR"); sys.exit(0)
print(n)
' 2>/dev/null
}

# state + engagement → verdict token. The whole decision, in one testable place.
classify() {
  local state="$1" engagement="$2"
  case "$state" in
    CLOSED) printf 'CLOSED' ;;
    OPEN)
      case "$engagement" in
        ''|ERR|*[!0-9]*) printf 'INDETERMINATE' ;;
        0)               printf 'OPEN_UNENGAGED' ;;
        *)               printf 'OPEN_ENGAGED' ;;
      esac ;;
    *) printf 'INDETERMINATE' ;;
  esac
}

alert_body() {
  printf '%s' "PR #${PR_NUM} on ${PR_REPO} is still OPEN with no maintainer engagement.

Opened 2026-05-08. Zero third-party skills have ever been merged into that hub,
and the only comment on the thread is ours. This is the 90-day decision point
that BINANCE-AGENT-OS-GEO-AND-SUBMISSIONS-W2 recorded, now due.

DECIDE — this is a judgment call and stays one:
  (a) close PR #254 ourselves and keep only the surfaces we own, or
  (b) leave it open with a NEW stated reason and a new decision date.

Do not report it as a distribution channel either way.

Action: dispatch OPS-BINANCE-SKILLS-PR-DISPOSITION-W1
Source: ops/cron/binance-pr-disposition-canary.sh"
}

fire() {
  local id="$1" body="$2"
  if [ -x "$SEND" ]; then
    # POSITIONAL, per send_telegram.sh's documented contract (`<alert_id> <severity> [body|-]`).
    # The env-var form left both of this repo's other host alerts dark for months.
    # REAL newlines, never `%0A` — the wrapper does its own --data-urlencode and a pre-escaped
    # body arrives double-encoded.
    printf '%s' "$body" | "$SEND" "$id" "WARNING" - >/dev/null 2>&1 \
      || log "send_telegram.sh failed (fail-open)"
  else
    log "send_telegram.sh not executable at $SEND — alert NOT sent (fail-open)"
    echo "  ! alerter missing at $SEND — a $id condition went unannounced"
  fi
}

# ── FETCH SEAM ───────────────────────────────────────────────────────────────────────────────
# Replaced wholesale by --self-test. Nothing below it decides anything; everything that decides
# is a pure function above.
fetch_pr()       { curl -sS --max-time 20 "$1/repos/$2/pulls/$3" 2>/dev/null; }
fetch_comments() { curl -sS --max-time 20 "$1/repos/$2/issues/$3/comments" 2>/dev/null; }

# ── MAIN ─────────────────────────────────────────────────────────────────────────────────────
run_once() {
  local today pr comments state engagement token
  # Re-resolve every tunable from the ENVIRONMENT AT CALL TIME, not at script load.
  #
  # This is not a style choice, it is a correctness fix caught by the self-test: with the values
  # bound at load time, `BINANCE_PR_DECIDE_ON=2099-01-01 run_once` had NO effect, so the
  # date-gate assertions passed against the DEFAULT date rather than the one they set — green for
  # the wrong reason, which is worse than red. An assertion that cannot influence its subject is
  # not an assertion.
  local SEND LOG STATE API_HOST PR_REPO PR_NUM OUR_LOGIN DECIDE_ON
  SEND="${BINANCE_PR_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
  LOG="${BINANCE_PR_LOG:-/var/log/binance-pr-disposition-canary.log}"
  STATE="${BINANCE_PR_STATE:-/var/lib/algovault-monitoring/binance-pr-disposition-last-read}"
  API_HOST="${BINANCE_PR_API_HOST:-https://api.github.com}"
  PR_REPO="${BINANCE_PR_REPO:-binance/binance-skills-hub}"
  PR_NUM="${BINANCE_PR_NUM:-254}"
  OUR_LOGIN="${BINANCE_PR_OUR_LOGIN:-AlgoVaultFi}"
  DECIDE_ON="${BINANCE_PR_DECIDE_ON-2026-11-24}"

  today=$(date -u +%F)

  if [ -z "$DECIDE_ON" ]; then
    log "REFUSE: BINANCE_PR_DECIDE_ON is empty — a gate with no decision date can never fire"
    echo "  ✖ decision date is empty — refusing rather than polling forever"
    verdict INDETERMINATE
    return 3
  fi

  # ── THE DATE GATE. Everything above this line is local; nothing below runs before the date. ──
  if [ "$today" \< "$DECIDE_ON" ]; then
    log "gate: $today < $DECIDE_ON — not due, no network call made"
    echo "  ok  decision gate closed until $DECIDE_ON (no network call)"
    # NO verdict token before the decision date, deliberately. The four tokens answer "what is
    # this PR's disposition"; before the date we have not asked, which is a different axis. A
    # fifth token would quietly widen a declared contract, and mapping it to INDETERMINATE would
    # make 89 of every 90 runs exit 3 for a gate that is working exactly as designed.
    return 0
  fi

  if [ -f "$STATE" ] && [ "$(cat "$STATE" 2>/dev/null)" = "$today" ]; then
    log "already read today ($today) — not re-reading"
    echo "  ok  already read today; state recorded at $STATE"
    return 0
  fi

  pr=$(fetch_pr "$API_HOST" "$PR_REPO" "$PR_NUM"); comments=$(fetch_comments "$API_HOST" "$PR_REPO" "$PR_NUM")
  state=$(pr_state "$pr")
  engagement=$(maintainer_engagement "$pr" "$comments" "$OUR_LOGIN")
  token=$(classify "$state" "$engagement")

  echo "  read $PR_REPO#$PR_NUM: state=${state:-<unreadable>} maintainer_engagement=${engagement:-<none>}"
  log "read state=${state:-unreadable} engagement=${engagement:-none} verdict=$token"

  if [ "$token" = "INDETERMINATE" ]; then
    echo "  ✖ could not read PR state — NOT reporting a clean disposition over nothing"
    log "INDETERMINATE — api host $API_HOST unreadable or shape changed; raw head: $(printf '%s' "$pr" | head -c 120)"
    verdict INDETERMINATE
    return 3
  fi

  printf '%s\n' "$today" > "$STATE" 2>/dev/null || log "could not record the read at $STATE (fail-open)"

  if [ "$token" = "OPEN_UNENGAGED" ]; then
    echo "  ! $PR_REPO#$PR_NUM open and unengaged at the decision date — paging"
    fire "BINANCE_SKILLS_PR_STALE" "$(alert_body)"
  else
    echo "  ok  disposition resolved ($token) — no operator action"
  fi
  verdict "$token"
  return 0
}

# ── SELF-TEST ────────────────────────────────────────────────────────────────────────────────
self_test() {
  local pass=0 fail=0
  ck() {
    local name="$1" got="$2" want="$3"
    if [ "$got" = "$want" ]; then printf '  PASS  %s\n' "$name"; pass=$((pass+1))
    else printf '  FAIL  %s — got "%s", want "%s"\n' "$name" "$got" "$want"; fail=$((fail+1)); fi
  }

  local OPEN_PR CLOSED_PR OURS_ONLY MAINT REVIEWED EMPTY
  OPEN_PR='{"state":"open","merged":false,"review_comments":0}'
  CLOSED_PR='{"state":"closed","merged":false,"review_comments":0}'
  REVIEWED='{"state":"open","merged":false,"review_comments":2}'
  OURS_ONLY='[{"user":{"login":"AlgoVaultFi"},"author_association":"NONE"}]'
  MAINT='[{"user":{"login":"AlgoVaultFi"},"author_association":"NONE"},{"user":{"login":"someBinanceDev"},"author_association":"MEMBER"}]'
  EMPTY='[]'

  ck "state parser: open"          "$(pr_state "$OPEN_PR")"   "OPEN"
  ck "state parser: closed"        "$(pr_state "$CLOSED_PR")" "CLOSED"
  ck "state parser: garbage ⇒ ''"  "$(pr_state 'not json')"   ""

  # THE TRAP: the only comment is OURS. A raw count would say ENGAGED and the alert would never
  # fire. This is the live shape of PR #254 today, not a hypothetical.
  ck "our own comment is NOT engagement" "$(maintainer_engagement "$OPEN_PR" "$OURS_ONLY" "$OUR_LOGIN")" "0"
  # The login-skip is what the assoc filter CANNOT do, and the difference only shows when our own
  # account carries a repo-side association. If AlgoVaultFi ever becomes a COLLABORATOR on that
  # repo — one merged PR away — an assoc-only filter would count OUR OWN comment as maintainer
  # engagement and the only branch that pages would go dark forever. Deleting the login-skip left
  # the earlier fixture green, because `NONE` is excluded by the assoc filter anyway: that
  # assertion tests the assoc filter, not the login-skip. This one tests the login-skip.
  local OURS_PROMOTED
  OURS_PROMOTED='[{"user":{"login":"AlgoVaultFi"},"author_association":"COLLABORATOR"}]'
  ck "our own comment is NOT engagement EVEN IF we become a collaborator" \
     "$(maintainer_engagement "$OPEN_PR" "$OURS_PROMOTED" "$OUR_LOGIN")" "0"
  ck "a MEMBER comment IS engagement"    "$(maintainer_engagement "$OPEN_PR" "$MAINT" "$OUR_LOGIN")"     "1"
  ck "a review IS engagement"            "$(maintainer_engagement "$REVIEWED" "$EMPTY" "$OUR_LOGIN")"    "2"

  # All four tokens forced.
  ck "TOKEN OPEN_UNENGAGED" "$(classify OPEN "$(maintainer_engagement "$OPEN_PR" "$OURS_ONLY" "$OUR_LOGIN")")" "OPEN_UNENGAGED"
  ck "TOKEN OPEN_ENGAGED"   "$(classify OPEN "$(maintainer_engagement "$OPEN_PR" "$MAINT" "$OUR_LOGIN")")"     "OPEN_ENGAGED"
  ck "TOKEN CLOSED"         "$(classify CLOSED 0)"                                                            "CLOSED"
  ck "TOKEN INDETERMINATE (unreadable state)" "$(classify '' 0)"                                              "INDETERMINATE"
  ck "TOKEN INDETERMINATE (unreadable engagement)" "$(classify OPEN ERR)"                                     "INDETERMINATE"

  # The date gate must make ZERO network calls. Proven by pointing the reader at an unroutable
  # host: if it were dialled, curl would take the full timeout and the token would be
  # INDETERMINATE. Asserting the token alone would not prove it; asserting it against a host that
  # CANNOT answer does.
  local out rc
  out=$(BINANCE_PR_API_HOST="https://198.51.100.1" BINANCE_PR_DECIDE_ON="2099-01-01" \
        BINANCE_PR_LOG=/dev/null BINANCE_PR_STATE=/dev/null run_once 2>&1); rc=$?
  ck "date gate: exits 0 before the decision date" "$rc" "0"
  case "$out" in *BINANCE_PR_DISPOSITION_VERDICT=*) ck "date gate emits NO verdict token" "$out" "<no token>" ;;
                 *) ck "date gate emits NO verdict token" "yes" "yes" ;; esac
  case "$out" in *"no network call"*) ck "date gate: says so explicitly" "yes" "yes" ;;
                 *) ck "date gate: says so explicitly" "$out" "…no network call…" ;; esac

  # END-TO-END token → EXIT CODE mapping on the READ path. Asserting classify() returns
  # INDETERMINATE does not assert that a run which READS an unreadable state exits 3 — those are
  # different claims, and re-coding the return to 0 left every token assertion green. Driven
  # against an unroutable host with the gate OPEN, so the read genuinely happens and genuinely
  # fails.
  # A host that REFUSES instantly, not one that times out: this assertion is about the token and
  # the exit code, and making it wait out two 20s curl timeouts would put 40s into every CI run
  # for no extra proof. The unroutable host is used ABOVE, where slowness IS the evidence.
  out=$(BINANCE_PR_API_HOST="http://127.0.0.1:1" BINANCE_PR_DECIDE_ON="2020-01-01" \
        BINANCE_PR_LOG=/dev/null BINANCE_PR_STATE=/dev/null run_once 2>&1); rc=$?
  ck "unreadable read ⇒ exit 3, not 0" "$rc" "3"
  case "$out" in *BINANCE_PR_DISPOSITION_VERDICT=INDETERMINATE*) ck "unreadable read ⇒ INDETERMINATE token" "yes" "yes" ;;
                 *) ck "unreadable read ⇒ INDETERMINATE token" "$out" "INDETERMINATE" ;; esac

  # An empty decision date REFUSES rather than polling forever — a config WE author, so empty is
  # vacuity, not a fact about the world.
  out=$(BINANCE_PR_DECIDE_ON="" BINANCE_PR_LOG=/dev/null run_once 2>&1); rc=$?
  ck "empty decision date ⇒ exit 3" "$rc" "3"
  case "$out" in *BINANCE_PR_DISPOSITION_VERDICT=INDETERMINATE*) ck "empty decision date ⇒ INDETERMINATE" "yes" "yes" ;;
                 *) ck "empty decision date ⇒ INDETERMINATE" "$out" "INDETERMINATE" ;; esac

  printf 'SELF-TEST: %s (%d passed, %d failed)\n' \
    "$([ "$fail" -eq 0 ] && echo PASS || echo FAIL)" "$pass" "$fail"
  [ "$fail" -eq 0 ]
}

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  *)
    LOCK="${BINANCE_PR_LOCK:-/var/lock/binance-pr-disposition-canary.lock}"
    if [ -z "${BINANCE_PR_NO_FLOCK:-}" ] && command -v flock >/dev/null 2>&1; then
      exec 9>"$LOCK" 2>/dev/null && flock -n 9 || { log "another run holds the lock — skipping"; exit 0; }
    fi
    run_once; exit $?
    ;;
esac
