#!/usr/bin/env bash
# robots-ai-allowlist-canary.sh — daily host-side driver for the live-edge robots.txt gate.
#
# GEO-ROBOTS-CONTENT-SIGNAL-W1 / R5.
#
# WHY A HOST CANARY AND NOT A website-drift-manifest.yaml ROW (the mechanism the dispatching
# spec assumed, and which does not exist): that manifest's whole contract is "a NUMBER or a SET
# extracted from a page vs the same value from an HTTP JSON SoT" — every tolerance_type is
# EXACT / BAND / FLOOR / EXACT_SET / EXACT_SUBSTRING_LOWER / FRESH / EXACT_ISO_MINUTE, and the one
# self-referential escape hatch is hardcoded at website-drift-canary.py to a single
# `<h3 class="text-white font-semibold text-sm flex-1">` grep (see its SELF_REFERENCE override).
# "Resolve RFC 9309 user-agent groups and report the effective rule for path /" is not expressible
# in any of them, and forcing it in would have meant a second, weaker copy of the resolver living
# in a YAML row — the exact single-derivation violation the gate was written to avoid.
#
# SINGLE DERIVATION: this wrapper owns NO policy. It runs the committed gate out of the deploy
# checkout at /opt/crypto-quant-signal-mcp, which is a real git tree kept at origin/main by the
# deploy — so the gate AND its allowlist SoT (src/lib/ai-crawler-allowlist.ts) are the same bytes
# CI tested. Nothing is vendored into /opt/algovault-monitoring, so there is no copy to drift and
# no .sha256 to keep honest.
#
# Alert contract: send_telegram.sh OWNS the severity gate, the 24h-per-alert_id cooldown, the
# recommended_wave {NEXT} resolver, and the INERT/DRY_RUN gates. Never re-implement them here.
# For a REPEATED smoke use ALGOVAULT_TG_TEST_INERT=1 (suppresses BEFORE the cooldown gate and
# writes NO marker). DRY_RUN_TG=1 DOES write the marker, so back-to-back dry runs false-green.
#
# Exit: always 0 on the live path (fail-open — a canary outage must not bounce cron). The VERDICT
# line is the truth; read the token, never the code. `--self-test` is the exception.
#
#   ROBOTS_CANARY_VERDICT=OK | BREACH | INDETERMINATE
#
# INDETERMINATE FIRES. A gate that could not verify is indistinguishable from a healthy one at
# exit 0, and this one guards a channel whose loss has no other symptom — so "could not check"
# escalates, bounded by the wrapper's own 24h cooldown, rather than going quiet.
set -uo pipefail

ALERT_ID="ROBOTS_AI_ALLOWLIST"
SEND="${ROBOTS_CANARY_WRAPPER:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${ROBOTS_CANARY_LOG:-/var/log/robots-ai-allowlist-canary.log}"
GATE="${ROBOTS_CANARY_GATE:-/opt/crypto-quant-signal-mcp/scripts/check-robots-ai-allowlist.mjs}"
NODE_BIN="${ROBOTS_CANARY_NODE:-node}"

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ALERT_ID" "$*" | tee -a "$LOG" 2>/dev/null || true; }

# --- the decision, as a pure function of the gate's OUTPUT ------------------------------------
# Extracted ONLY so the self-test can drive it with fixtures. The RED branch is unreachable from
# live state whenever the zone is configured correctly — which is always, right up until the day
# it is not — and an unreachable branch that has never executed is a dark guard.
#
# Gates on the TOKEN, never the exit code: an absent token is INDETERMINATE even at exit 0,
# because that combination means the gate died before it could say anything.
# Echoes: <VERDICT> <detail>
decide() {
  local rc="$1" out="$2" token
  token="$(printf '%s\n' "$out" | sed -n 's/^ROBOTS_ALLOWLIST_VERDICT=\(.*\)$/\1/p' | tail -1)"
  if [ -z "$token" ]; then
    echo "INDETERMINATE gate emitted NO verdict token (rc=$rc) — it died before deciding"; return
  fi
  case "$token" in
    GREEN)         echo "OK gate=GREEN rc=$rc — every allowlisted agent still allowed on /" ;;
    RED)           echo "BREACH gate=RED rc=$rc — the live file no longer grants our allowlist" ;;
    INDETERMINATE) echo "INDETERMINATE gate=INDETERMINATE rc=$rc — could not verify; not a pass" ;;
    *)             echo "INDETERMINATE gate emitted an UNKNOWN token '$token' (rc=$rc)" ;;
  esac
}

fire() {
  local verdict="$1" detail="$2" evidence="$3"
  if [ ! -x "$SEND" ]; then
    log "FAIL_OPEN: wrapper not executable at $SEND — operator NOT notified"; return
  fi
  printf '%s\n' "$(cat <<EOF
<b>robots.txt AI-crawler allowlist: ${verdict}</b>

${detail}

algovault.com/robots.txt is the single machine-readable file that decides whether every AI crawler
on earth may ingest our content. A Disallow there is a silent, total, zone-wide loss of the
acquisition channel — no error, no user-visible symptom, nothing else in the stack notices.

Gate output:
${evidence}

Most likely cause if this is RED: Cloudflare's managed robots.txt or "Block AI training bots" was
enabled on the zone, which PREPENDS Disallow rules for exactly the agents we allowlist. That
injection lives at the edge and appears in NO committed file, so no repo test can see it.

Action: this is a DASHBOARD fix, not an auto-recoverable one, and a policy surface is never
mutated by an unattended job. Check the Cloudflare zone: Bots -> "Block AI bots" = Do not block,
and "Manage your robots.txt" = Disable robots.txt configuration. Cloudflare's new AI-bot-policy
defaults land 2026-09-15 and deprecate the legacy control, so a default migration is a live cause.

Verify locally with: npm run check:robots

recommended_wave: OPS-ROBOTS-ALLOWLIST-RESTORE-W{NEXT}
EOF
)" | "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" || log "FAIL_OPEN: send_telegram invocation failed"
}

# --- two-way self-test, vacuity-guarded --------------------------------------------------------
if [ "${1:-}" = "--self-test" ]; then
  fails=(); checked=0
  expect() { # <expected-verdict> <rc> <gate-output> <label>
    local got; got="$(decide "$2" "$3")"; checked=$((checked + 1))
    case "$got" in
      "$1"*) printf '  ✓ %s ⇒ %s\n' "$4" "$1" ;;
      *) printf '  ✗ %s ⇒ expected %s, got: %s\n' "$4" "$1" "$got"; fails+=("$4") ;;
    esac
  }
  echo "--- decision fixtures (must-fire and must-not-fire) ---"
  expect OK            0 'GPTBot: allowed
ROBOTS_ALLOWLIST_VERDICT=GREEN' "gate GREEN — must NOT page"
  expect BREACH        1 'GPTBot: DISALLOWED
REASON: disallowed on /: GPTBot
ROBOTS_ALLOWLIST_VERDICT=RED' "gate RED — must page"
  expect INDETERMINATE 3 'REASON: non-2xx: HTTP 503
ROBOTS_ALLOWLIST_VERDICT=INDETERMINATE' "gate could not verify — must page"
  expect INDETERMINATE 0 'some noise but no token at all' "no token at exit 0 — the dark-guard case"
  expect INDETERMINATE 1 'ROBOTS_ALLOWLIST_VERDICT=BANANA' "unknown token — never read as a pass"
  expect BREACH        0 'ROBOTS_ALLOWLIST_VERDICT=RED' "token wins over a passing exit code"
  expect OK            9 'ROBOTS_ALLOWLIST_VERDICT=GREEN' "token wins over a failing exit code"

  # The branch that matters most: does a BREACH actually INVOKE the wrapper, with the contract's
  # argument shape? Asserting the verdict string alone leaves the send path unexercised — the
  # exact failure mode (`INVENTORY_LOAD_FAILED … exit 0`) this repo has hit four times.
  echo "--- wrapper invocation ---"
  probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/robots-canary.XXXXXX")"
  trap 'rm -rf "$probe_dir"' EXIT   # BSD mktemp: XXXXXX must be TERMINAL, so use -d + a fixed name inside
  cat > "$probe_dir/fake-send.sh" <<'PROBE'
#!/usr/bin/env bash
printf 'argv=%s|%s|%s\n' "$1" "$2" "$3" > "$CAPTURE"
cat >> "$CAPTURE"
PROBE
  chmod +x "$probe_dir/fake-send.sh"
  bash -c 'SEND="'"$probe_dir"'/fake-send.sh"; export CAPTURE="'"$probe_dir"'/captured.txt"
           '"$(declare -f fire log)"'
           LOG=/dev/null; ALERT_ID=ROBOTS_AI_ALLOWLIST
           fire BREACH "gate=RED — the live file no longer grants our allowlist" "GPTBot: DISALLOWED"' >/dev/null 2>&1
  checked=$((checked + 1))
  if [ ! -s "$probe_dir/captured.txt" ]; then
    echo "  ✗ BREACH did not invoke the wrapper at all"; fails+=("wrapper-invoked")
  else
    grep -q 'argv=ROBOTS_AI_ALLOWLIST|CRITICAL_PERSISTENT|-' "$probe_dir/captured.txt" \
      && echo "  ✓ invoked as: <alert_id> CRITICAL_PERSISTENT - (matches send_telegram.sh usage)" \
      || { echo "  ✗ wrong argv: $(head -1 "$probe_dir/captured.txt")"; fails+=("wrapper-argv"); }
    grep -q 'GPTBot: DISALLOWED' "$probe_dir/captured.txt" \
      && echo "  ✓ body carries the gate's own per-agent evidence" \
      || { echo "  ✗ body lost the gate evidence"; fails+=("wrapper-body"); }
    grep -q 'W{NEXT}' "$probe_dir/captured.txt" \
      || { echo "  ✗ hardcoded wave id — CLAUDE.md requires the OPS-<CLASS>-W{NEXT} template"; fails+=("recommended-wave"); }
    grep -q 'Manage your robots.txt' "$probe_dir/captured.txt" \
      && echo "  ✓ body names the operator action (a dashboard fix, never auto-recovered)" \
      || { echo "  ✗ body lost the remediation"; fails+=("wrapper-remediation"); }
  fi

  # Vacuity guard: a self-test that asserts nothing must never report a pass.
  if [ "$checked" -lt 8 ]; then
    echo "SELF_TEST_VERDICT=INDETERMINATE — only $checked assertions ran (expected >= 8)"; exit 3
  fi
  if [ "${#fails[@]}" -gt 0 ]; then
    echo "SELF_TEST_VERDICT=FAIL — ${#fails[@]}/$checked: ${fails[*]}"; exit 1
  fi
  echo "SELF_TEST_VERDICT=PASS — $checked assertions (2 must-fire, 2 must-not-fire, 3 indeterminate, wrapper path proven)"
  exit 0
fi

# --- live path ---------------------------------------------------------------------------------
if [ ! -f "$GATE" ]; then
  log "VERDICT=INDETERMINATE gate absent at $GATE — cannot verify"
  fire INDETERMINATE "The gate script is missing at ${GATE}, so the allowlist was NOT checked." \
    "(no output — script absent)"
  echo "ROBOTS_CANARY_VERDICT=INDETERMINATE"
  exit 0
fi

OUT="$("$NODE_BIN" "$GATE" 2>&1)"; RC=$?
RESULT="$(decide "$RC" "$OUT")"
VERDICT="${RESULT%% *}"

# POSITIVE per-run output on EVERY path: a run silently skipped by a load error must not look
# identical to a run that passed. The gate's own per-agent lines go to the log too, so a later
# forensic read can tell WHICH agent moved.
log "VERDICT=$VERDICT ${RESULT#* }"
printf '%s\n' "$OUT" | sed 's/^/    /' | tee -a "$LOG" >/dev/null 2>&1 || true

case "$VERDICT" in
  BREACH)        fire BREACH "${RESULT#* }" "$OUT" ;;
  INDETERMINATE) fire INDETERMINATE "${RESULT#* }" "$OUT" ;;
esac

echo "ROBOTS_CANARY_VERDICT=$VERDICT"
exit 0
