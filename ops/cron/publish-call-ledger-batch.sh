#!/usr/bin/env bash
# publish-call-ledger-batch.sh — DECISION-CALL-V2-W5 CH2.
#
# Anchors the pre_trade_check call ledger once a day: `docker exec` dist/scripts/publish-call-ledger-batch.js
# (src/scripts/publish-call-ledger-batch.ts) on the ONE crash-safe anchor (src/lib/anchor-batch.ts). It
# reconciles every sealed or sent batch against the call-ledger registry on Base, seals at most one new batch
# per UTC day (every leaf not yet batched), sends its root, reads it back, marks it verified, then rechecks the
# newest 7 verified batches by rebuilding every leaf from the stored check rows. The publisher key lives in
# the app container's environment: this file never reads, passes or prints it (no `-e` on the exec).
#
# ── SCHEDULE: 13 0 * * * ── (DECISION-CALL-V2-W5 §9 ruling: "cron line 13 0 * * * (house flock + wrapper)")
#
# Eight minutes after the signal publisher (5 0 * * *, measured max 7 s), with which it shares ONE publisher
# EOA and ONE Postgres advisory lock (anchor-batch.ts ANCHOR_LOCK_KEY): a run that finds the lock held is
# INDETERMINATE and sends nothing; the next night reconciles and seals.
#
# THE CRONTAB LINE, appended exactly (diff +1/−0); the lock is the line's, as the labelers' are:
#   13 0 * * * flock -n /var/lock/algovault-publish-call-ledger-batch.lock /opt/crypto-quant-signal-mcp/ops/cron/publish-call-ledger-batch.sh >> /var/log/publish-call-ledger-batch.log 2>&1  # DECISION-CALL-V2-W5 CH2 call-ledger anchor (inventory row publish-call-ledger-batch; preempt-and-catchup)
#
# ── ONE TOKEN PER RUN, ONE PAGE ──
#
# CALL_LEDGER_ANCHOR_VERDICT=PASS|FAIL|INDETERMINATE lands in /var/log/publish-call-ledger-batch.log. When the
# child never reaches its token (the container is down, a deploy SIGKILLed the `docker exec`, it crashed),
# this wrapper prints INDETERMINATE in its place, so every run ends in exactly one token. The exit code is the
# token's (0 / 1 / 3), never the child's raw code. (A tick that finds the crontab line's lock held prints
# nothing at all — `flock -n` exits before this file runs.)
#
# anchor_root_mismatch pages CRITICAL_PERSISTENT when the run prints an ANCHOR_ROOT_MISMATCH line: the registry
# holds a different root for a batch id this ledger sealed, or the recheck rebuilt a root from the stored rows
# that differs from the one on chain. The run stopped there; the batch stays sealed; nothing new is anchored
# until a human resolves it, so every later run fails the same way (repetition is send_telegram.sh's 24 h
# cooldown). The body is those lines. Any other FAIL or INDETERMINATE pages nothing HERE: a stalled anchor
# is the health canary's call_ledger_stale (a leaf unanchored > 26 h), whatever stalled it. A PASS calls
# --clear (silent).
#
# PREEMPT-AND-CATCHUP (ops/scripts/cron-interlock-registry.json): every state change is one statement and each
# run reconciles first, so a SIGTERM or a kill at any instant loses nothing; the repair is the next run.
set -uo pipefail

CTR="${CALL_LEDGER_ANCHOR_CONTAINER:-crypto-quant-signal-mcp-mcp-server-1}"
DOCKER="${CALL_LEDGER_ANCHOR_DOCKER:-docker}"
SEND="${CALL_LEDGER_ANCHOR_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
ALERT_ID="anchor_root_mismatch"
TAG="[publish-call-ledger-batch]"
SCRIPT="dist/scripts/publish-call-ledger-batch.js"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

page() { # body on stdin
  if [ -x "$SEND" ]; then
    "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - || echo "$TAG $(ts) ESCALATE_UNSENT: send_telegram invocation failed ($ALERT_ID)"
  else
    cat > /dev/null; echo "$TAG $(ts) ESCALATE_UNSENT: $SEND not executable ($ALERT_ID)"
  fi
}

clear_alert() {
  if [ -x "$SEND" ]; then
    "$SEND" --clear "$ALERT_ID" "call-ledger anchor PASS" > /dev/null || echo "$TAG $(ts) CLEAR_UNSENT: send_telegram --clear failed ($ALERT_ID)"
  fi
}

mismatch_body() { # output_file
  printf '🛑 %s\n' "$ALERT_ID"
  printf 'The call-ledger anchor stopped on a root mismatch: the registry on Base holds a different root for a batch this ledger sealed, or a recheck rebuilt a root from the stored check rows that differs from the one on chain. Nothing further is sealed or sent until it is resolved.\n'
  grep -a '^ANCHOR_ROOT_MISMATCH ' "$1" | head -5 | sed 's/^/- /'
  printf 'Batches: call_ledger_batches (state, tx_hash, recheck_ok_at) · log: /var/log/publish-call-ledger-batch.log\n'
  printf 'Recommended wave: DECISION-CALL-V2-W{NEXT}\n'
}

run() {
  local out rc v code why
  echo "$TAG $(ts) start"
  # A plain string compare, never `… | grep -q`: under pipefail that can false-miss on SIGPIPE.
  if [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null)" != true ]; then
    echo "$TAG $(ts) container $CTR is not running — nothing was anchored"
    echo "CALL_LEDGER_ANCHOR_VERDICT=INDETERMINATE"
    echo "$TAG $(ts) exit=3"
    exit 3
  fi
  out="$(mktemp 2>/dev/null || echo "/tmp/pclb.$$")"
  trap 'rm -f "$out"' EXIT
  "$DOCKER" exec "$CTR" node "$SCRIPT" > "$out" 2>&1
  rc=$?
  # The child's own token is the run's token. Without one, INDETERMINATE takes its place.
  v="$(grep -a '^CALL_LEDGER_ANCHOR_VERDICT=' "$out" | tail -1 | cut -d= -f2 | cut -d' ' -f1)"
  case "$v" in
    PASS|FAIL|INDETERMINATE) cat "$out" ;;
    *)
      # A token-less run's output keeps every line but no stray verdict-shaped fragment.
      grep -av '^CALL_LEDGER_ANCHOR_VERDICT=' "$out"
      if [ "$rc" -eq 137 ]; then why="killed (exit 137: a deploy recreated the container)"; else why="exit $rc before a verdict"; fi
      echo "$TAG $(ts) $why"
      echo "CALL_LEDGER_ANCHOR_VERDICT=INDETERMINATE"
      v=INDETERMINATE
      ;;
  esac
  if grep -aq '^ANCHOR_ROOT_MISMATCH ' "$out"; then
    mismatch_body "$out" | page
  elif [ "$v" = PASS ]; then
    clear_alert
  fi
  case "$v" in PASS) code=0 ;; FAIL) code=1 ;; *) code=3 ;; esac
  echo "$TAG $(ts) child_rc=$rc exit=$code"
  exit "$code"
}

# ── two-way self-test, vacuity-guarded ─────────────────────────────────────────────────────────
self_test() {
  local me st checked=0 fails=""
  me="$0"
  PCLB_ST="$(mktemp -d 2>/dev/null || echo "/tmp/pclb-st.$$")"; mkdir -p "$PCLB_ST"; st="$PCLB_ST"
  trap 'rm -rf "$PCLB_ST"' EXIT
  ck() { checked=$((checked + 1)); if [ "$2" = "$3" ]; then echo "SELF-TEST: ok   $1"; else echo "SELF-TEST: FAIL $1 (got '$2', want '$3')"; fails="$fails|$1"; fi; }
  has() { checked=$((checked + 1)); if grep -qF -- "$3" <<<"$2"; then echo "SELF-TEST: ok   $1"; else echo "SELF-TEST: FAIL $1 (missing '$3')"; fails="$fails|$1"; fi; }
  hasnt() { checked=$((checked + 1)); if grep -qF -- "$3" <<<"$2"; then echo "SELF-TEST: FAIL $1 (unexpected '$3')"; fails="$fails|$1"; else echo "SELF-TEST: ok   $1"; fi; }

  # A fake docker: `inspect` answers running unless $st/stopped exists; `exec` records its argv, prints
  # $st/child.out and exits $st/child.rc.
  cat > "$st/docker" <<EOF
#!/usr/bin/env bash
case "\$1" in
  inspect) [ -f "$st/stopped" ] && echo false || echo true ;;
  exec) shift; printf '%s\n' "\$@" > "$st/exec.argv"; cat "$st/child.out"; exit \$(cat "$st/child.rc") ;;
esac
EOF
  # A recording wrapper: argv + body, one record per call.
  cat > "$st/send" <<EOF
#!/usr/bin/env bash
printf 'ARGV %s\n' "\$*" >> "$st/sent"; [ "\$1" = --clear ] || cat >> "$st/sent"; printf 'END\n' >> "$st/sent"
EOF
  chmod +x "$st/docker" "$st/send"
  : > "$st/sent"
  child() { # rc, then the child's lines
    printf '%s\n' "$1" > "$st/child.rc"; shift
    printf '%s\n' "$@" > "$st/child.out"
    rm -f "$st/exec.argv"
    CALL_LEDGER_ANCHOR_DOCKER="$st/docker" CALL_LEDGER_ANCHOR_SEND="$st/send" bash "$me" > "$st/run.out" 2>&1
    echo $? > "$st/run.rc"
  }
  tok() { grep -a '^CALL_LEDGER_ANCHOR_VERDICT=' "$st/run.out" | cut -d= -f2; }
  ntok() { grep -ac '^CALL_LEDGER_ANCHOR_VERDICT=' "$st/run.out" | tr -d ' '; }
  pages() { local n; n="$(grep -c "^ARGV $ALERT_ID CRITICAL_PERSISTENT -" "$st/sent" 2>/dev/null)"; echo "${n:-0}"; }
  clears() { local n; n="$(grep -c "^ARGV --clear $ALERT_ID" "$st/sent" 2>/dev/null)"; echo "${n:-0}"; }
  local M1='ANCHOR_ROOT_MISMATCH call-ledger batch 3: the ledger holds root 0xaa over 8 leaves, the registry holds root 0xbb over 8 — stopped, nothing further sealed or sent'
  local M2='ANCHOR_ROOT_MISMATCH recheck batch 2: rebuilt root 0xcc over 6 leaves, the registry holds 0xdd'

  # (1) PASS: one token, exit 0, the alert clears, nothing pages; the exec is the script and nothing else.
  child 0 '[publish-call-ledger-batch] [anchor] call-ledger batch 4: sealed 6 leaves, root 0xee' 'CALL_LEDGER_ANCHOR_SEALED=4' 'CALL_LEDGER_ANCHOR_VERIFIED=4' 'CALL_LEDGER_ANCHOR_VERDICT=PASS'
  ck 'pass: token PASS' "$(tok)" PASS
  ck 'pass: exactly one token' "$(ntok)" 1
  ck 'pass: exit 0' "$(cat "$st/run.rc")" 0
  ck 'pass: clears' "$(clears)" 1
  ck 'pass: no page' "$(pages)" 0
  ck 'pass: the exec is the container, node and the script — no -e, so no key on a command line' "$(tr '\n' ' ' < "$st/exec.argv")" "crypto-quant-signal-mcp-mcp-server-1 node dist/scripts/publish-call-ledger-batch.js "
  has 'pass: the child output is kept in the log' "$(cat "$st/run.out")" 'CALL_LEDGER_ANCHOR_SEALED=4'
  # (2) A reconcile mismatch: FAIL, exit 1, ONE page whose body is the mismatch line; no clear.
  child 1 "$M1" 'CALL_LEDGER_ANCHOR_SEALED=' 'CALL_LEDGER_ANCHOR_VERIFIED=' 'CALL_LEDGER_ANCHOR_VERDICT=FAIL'
  ck 'mismatch: token FAIL' "$(tok)" FAIL
  ck 'mismatch: exit 1' "$(cat "$st/run.rc")" 1
  ck 'mismatch: PAGES' "$(pages)" 1
  has 'mismatch: the page goes to anchor_root_mismatch, CRITICAL_PERSISTENT, body on stdin' "$(cat "$st/sent")" "ARGV $ALERT_ID CRITICAL_PERSISTENT -"
  has 'mismatch: the body carries the mismatch line' "$(cat "$st/sent")" "- $M1"
  has 'mismatch: the body names where to look' "$(cat "$st/sent")" 'call_ledger_batches (state, tx_hash, recheck_ok_at)'
  has 'mismatch: the body carries the template wave id' "$(cat "$st/sent")" 'Recommended wave: DECISION-CALL-V2-W{NEXT}'
  ck 'mismatch: never clears' "$(clears)" 1
  # (3) A recheck mismatch pages too (PASS anchor, FAIL recheck).
  child 1 '[publish-call-ledger-batch] RECHECK verdict=FAIL batches_ok=1 [1] failures=1' "$M2" 'CALL_LEDGER_ANCHOR_VERDICT=FAIL'
  ck 'recheck mismatch: pages' "$(pages)" 2
  has 'recheck mismatch: the body carries the recheck line' "$(cat "$st/sent")" "- $M2"
  # (4) Any other FAIL (a reverted tx) pages nothing here and clears nothing: call_ledger_stale owns a stall.
  child 1 '[publish-call-ledger-batch] call-ledger batch 5: tx 0x01 reverted in block 9' 'CALL_LEDGER_ANCHOR_VERDICT=FAIL'
  ck 'other FAIL: token FAIL' "$(tok)" FAIL
  ck 'other FAIL: no page' "$(pages)" 2
  ck 'other FAIL: no clear' "$(clears)" 1
  # (5) INDETERMINATE from the child (the lock held): exit 3, nothing pages or clears.
  child 3 '[publish-call-ledger-batch] the anchor lock is held by another publisher run' 'CALL_LEDGER_ANCHOR_VERDICT=INDETERMINATE'
  ck 'child INDETERMINATE: token' "$(tok)" INDETERMINATE
  ck 'child INDETERMINATE: exit 3' "$(cat "$st/run.rc")" 3
  ck 'child INDETERMINATE: no page' "$(pages)" 2
  ck 'child INDETERMINATE: no clear' "$(clears)" 1
  # (6) Killed by a deploy (137, no token): INDETERMINATE in its place, exactly one token, exit 3.
  child 137 '[publish-call-ledger-batch] [anchor] call-ledger batch 6: sealed 4 leaves, root 0xff'
  ck 'killed: INDETERMINATE' "$(tok)" INDETERMINATE
  ck 'killed: exactly one token' "$(ntok)" 1
  ck 'killed: exit 3' "$(cat "$st/run.rc")" 3
  has 'killed: says why' "$(cat "$st/run.out")" 'killed (exit 137: a deploy recreated the container)'
  ck 'killed: nothing clears' "$(clears)" 1
  # (7) A crash before the token (rc 1, no token) is INDETERMINATE, never FAIL — and never PASS on rc 0.
  child 1 'TypeError: boom'
  ck 'crash: INDETERMINATE' "$(tok)" INDETERMINATE
  has 'crash: names the exit code' "$(cat "$st/run.out")" 'exit 1 before a verdict'
  child 0 'no token at all'
  ck 'rc 0 without a token: INDETERMINATE, never PASS' "$(tok)" INDETERMINATE
  ck 'rc 0 without a token: exit 3' "$(cat "$st/run.rc")" 3
  ck 'rc 0 without a token: never clears' "$(clears)" 1
  # (8) The exit code is the TOKEN's: a FAIL token with rc 0 still exits 1.
  child 0 'CALL_LEDGER_ANCHOR_VERDICT=FAIL'
  ck 'FAIL token, rc 0: exit 1' "$(cat "$st/run.rc")" 1
  # (9) A stopped container: INDETERMINATE, exit 3, the exec never runs, nothing pages or clears.
  touch "$st/stopped"; child 0 'CALL_LEDGER_ANCHOR_VERDICT=PASS'; rm -f "$st/stopped"
  ck 'stopped: INDETERMINATE' "$(tok)" INDETERMINATE
  ck 'stopped: exactly one token' "$(ntok)" 1
  ck 'stopped: exit 3' "$(cat "$st/run.rc")" 3
  ck 'stopped: the exec never ran' "$( [ -e "$st/exec.argv" ] && echo ran || echo never)" never
  ck 'stopped: no clear' "$(clears)" 1
  # (10) An unexecutable send never hides the page: it says ESCALATE_UNSENT.
  child 1 "$M1" 'CALL_LEDGER_ANCHOR_VERDICT=FAIL'
  local before; before="$(pages)"
  printf '1\n' > "$st/child.rc"; printf '%s\n' "$M1" 'CALL_LEDGER_ANCHOR_VERDICT=FAIL' > "$st/child.out"
  CALL_LEDGER_ANCHOR_DOCKER="$st/docker" CALL_LEDGER_ANCHOR_SEND="$st/nonexistent" bash "$me" > "$st/run.out" 2>&1
  has 'no send: ESCALATE_UNSENT is printed' "$(cat "$st/run.out")" 'ESCALATE_UNSENT'
  ck 'no send: nothing reached the recorder' "$(pages)" "$before"
  hasnt 'this file never names the publisher key' "$(grep -v '^ *hasnt ' "$me")" 'MERKLE_PUBLISHER_KEY'

  # Vacuity guard: a self-test that asserted nothing must never report a pass.
  if [ "$checked" -lt 43 ]; then
    echo "SELF_TEST_VERDICT=INDETERMINATE — only $checked assertions ran (expected >= 43)"; return 3
  fi
  if [ -n "$fails" ]; then
    echo "SELF_TEST_VERDICT=FAIL — ${fails#|}"; return 1
  fi
  echo "SELF_TEST_VERDICT=PASS — $checked assertions (pass + clear · reconcile and recheck mismatch page + body · other FAIL silent · child INDETERMINATE · killed and token-less runs INDETERMINATE · exit = token · stopped container · unsent page · no key)"
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  self_test; exit $?
fi
run
