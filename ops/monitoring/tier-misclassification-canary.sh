#!/usr/bin/env bash
# ops/monitoring/tier-misclassification-canary.sh — OPS-ASSET-CLASS-TOTALITY-W1 CH3 (rewrites the weekly,
# one-way OPS-TIER-CLASSIFIER-XVENUE-W1 C3 canary in place).
#
# The DAILY, TWO-WAY check of the asset-class engine against what the public track record renders. It
# runs the ONE verdict — `dist/scripts/asset-class-totality.js --check`, INSIDE the app container — which
# reads every ACTIVE venue's own instrument list through the engine's own detectors (retired venues are
# skipped, never failed) and the live /api/performance-public. Nothing here re-derives a verdict; this
# file only pages and publishes.
#
# ── WHAT FAILS (the judge's `FAIL <kind> …` lines, each naming venue + tag/coin + action) ───────────────
#   lost             a venue instrument its own coin no longer reaches (keying broke)
#   collision        two instruments of one venue share a bare symbol
#   unmapped         a TradFi tag VENUE_TAG_CLASS has no row for (landed by TAG_PATTERNS meanwhile)
#   tier-not3-tradfi a Tier-2/4 (coin, venue) row the venue itself records as TradFi
#   tier3-crypto     a Tier-3 coin that every venue calling it records as crypto
#
# ── VERDICT ───────────────────────────────────────────────────────────────────────────────────
# Exactly one terminal `ASSET_CLASS_TOTALITY_VERDICT=PASS|FAIL|INDETERMINATE` (exit 0 / 1 / 3). Read the
# TOKEN, never the code. A failed venue fetch, an unreadable public endpoint, a stopped container or a
# missing token is INDETERMINATE: nothing was verified, so nothing pages — and a record is still published.
#
# ── THE PAGE ──────────────────────────────────────────────────────────────────────────────────
# FAIL → `OPS_TIER_MISCLASSIFICATION` CRITICAL_PERSISTENT through send_telegram.sh, the FAIL lines as the
# body; repetition is the wrapper's 24 h cooldown, not this file's. PASS and INDETERMINATE page nothing.
# DRY_RUN=1 runs the real judge and prints the verdict and the body it WOULD send; it sends and publishes
# nothing.
#
# ── LOGS ──────────────────────────────────────────────────────────────────────────────────────
# $LOG gets ONE summary line per run. The judge's full output is overwritten into $LOG.last every run and
# copied to $LOG.last-fail on a FAIL, so the forensics survive without an unbounded log.
#
# ── PUBLISHED ─────────────────────────────────────────────────────────────────────────────────
# Every non-dry run appends ONE canary_result_log record (canary `tier-misclassification`): verdict,
# per-venue counts, FAIL counts by kind, the failing keys. Identifiers and counts only.
#
# ── SCHEDULE: 23 13 * * * (signal-1) ──────────────────────────────────────────────────────────
# Daily. Read-only (venue instrument lists + one public GET); safe-to-kill; batch weight class.
#
# Usage: tier-misclassification-canary.sh             # the canary (cron)
#        tier-misclassification-canary.sh --self-test # hermetic, two-way, vacuity-guarded
set -uo pipefail

CTR="${TIER_CANARY_APP_CTR:-crypto-quant-signal-mcp-mcp-server-1}"
SEND="${TIER_CANARY_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${TIER_CANARY_LOG:-/var/log/tier-misclassification-canary.log}"
RESULT_LOG_DIR="${TIER_CANARY_RESULT_LOG_DIR:-/opt/algovault-monitoring}"
DOCKER="${TIER_CANARY_DOCKER:-docker}"   # the self-test's seam; unset in production
ALERT_ID="OPS_TIER_MISCLASSIFICATION"
CANARY="tier-misclassification"
TOKEN="ASSET_CLASS_TOTALITY_VERDICT"
TAG="[tier-canary]"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $TAG $*" >> "$LOG" 2>/dev/null || true; }

# Result metrics from the judge output — per-venue counts, FAIL counts by kind, the failing keys.
metrics_of() { # output_file verdict
  python3 - "$1" "$2" <<'PYM'
import json, re, sys
out, verdict = sys.argv[1], sys.argv[2]
venues, kinds, keys, skipped = {}, {}, [], ""
for line in open(out, encoding="utf-8", errors="replace"):
    line = line.rstrip("\n")
    m = re.match(r"venue=(\S+) tradfi=(\d+) crypto=(\d+) lost=(\d+) collisions=(\d+)", line)
    if m:
        venues[m.group(1)] = {"tradfi": int(m.group(2)), "crypto": int(m.group(3)), "lost": int(m.group(4)), "collisions": int(m.group(5))}
    m = re.match(r"FAIL (\S+) (.*?) action=", line)
    if m:
        kinds[m.group(1)] = kinds.get(m.group(1), 0) + 1
        keys.append(m.group(1) + " " + " ".join(f for f in m.group(2).split() if f.split("=")[0] in ("venue", "coin", "tag", "native", "bare")))
    m = re.search(r"skipped_retired=(\S+)", line)
    if m: skipped = m.group(1)
print(json.dumps({"verdict": verdict, "venues": venues, "fail_kinds": dict(sorted(kinds.items())),
                  "fail_keys": keys[:40], "skipped_retired": [s for s in skipped.split(",") if s and s != "none"]}, sort_keys=True))
PYM
}

# The page body: every FAIL line verbatim (each names its venue + tag/coin + action), counted with its noun.
page_body() { # judge_output_file
  local n
  n="$(grep -c '^FAIL ' "$1" | tr -d ' ')"
  printf '🛑 %s\n' "$ALERT_ID"
  printf 'Asset-class totality: %s %s FAILed against the venues'"'"' own instrument records.\n' "$n" "$( [ "$n" = 1 ] && echo finding || echo findings )"
  grep '^FAIL ' "$1" | head -25 | sed 's/^FAIL /- /'
  [ "$n" -gt 25 ] && printf -- '- … %s more in %s.last-fail\n' "$((n - 25))" "$LOG"
  printf 'unmapped: add the VENUE_TAG_CLASS row named · lost/collision: fix that venue'"'"'s keying in asset-class-detection.ts ·\n'
  printf 'tier-*: the public tier disagrees with the venue'"'"'s own record (classifyAsset takes the call'"'"'s venue).\n'
  printf 'Log: %s (full judge output: %s.last-fail) · result: canary-results.jsonl (%s)\n' "$LOG" "$LOG" "$CANARY"
  printf 'Recommended wave: OPS-ASSET-CLASS-TOTALITY-W{NEXT}\n'
}

publish() { # verdict exit_code metrics_json
  if [ "${DRY_RUN:-0}" = 1 ]; then echo "$TAG [DRY_RUN] would publish a $CANARY record: $3"; return 0; fi
  python3 - "$RESULT_LOG_DIR" "$CANARY" "$1" "$2" "$3" <<'PYREC' 2>/dev/null || echo "$TAG CANARY_RESULT_LOG_FAILED=python_unavailable"
import json, sys
sys.path.insert(0, sys.argv[1])
try:
    from canary_result_log import append_result
except Exception as e:
    print(f"[tier-canary] CANARY_RESULT_LOG_FAILED=import:{type(e).__name__}")
    raise SystemExit(0)
try:
    metrics = json.loads(sys.argv[5]) if sys.argv[5] else {}
    if not isinstance(metrics, dict):
        metrics = {"metrics_unparseable": True}
except Exception:
    metrics = {"metrics_unparseable": True}
ok, detail = append_result(sys.argv[2], sys.argv[3], int(sys.argv[4]), metrics)
print(f"[tier-canary] CANARY_RESULT_LOG={detail}" if ok else f"[tier-canary] CANARY_RESULT_LOG_FAILED={detail}")
PYREC
}

finish() { # verdict detail exit_code [metrics_json]
  log "$1 $2"
  publish "$1" "$3" "${4:-}"
  echo "$TAG $(date -u +%Y-%m-%dT%H:%M:%SZ) $TOKEN=$1 $2"
  exit "$3"
}

run_canary() {
  local out rc verdict metrics
  TC_TMP="$(mktemp -d 2>/dev/null || echo "/tmp/tc.$$")"; mkdir -p "$TC_TMP"; out="$TC_TMP/out"
  trap 'rm -rf "$TC_TMP"' EXIT

  # A plain string compare, never `… | grep -q`: under pipefail that can false-miss on SIGPIPE.
  if [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null)" != true ]; then
    finish INDETERMINATE "container $CTR is not running — nothing was judged" 3
  fi

  "$DOCKER" exec "$CTR" node dist/scripts/asset-class-totality.js --check > "$out" 2>&1
  rc=$?
  cp "$out" "$LOG.last" 2>/dev/null || true

  verdict="$(grep -a "^$TOKEN=" "$out" | tail -1 | cut -d= -f2-)"
  case "$verdict" in
    PASS|FAIL|INDETERMINATE) ;;
    *) finish INDETERMINATE "no verdict token in the judge output (rc=$rc)" 3 ;;
  esac
  metrics="$(metrics_of "$out" "$verdict" 2>/dev/null || echo '{"metrics_unparseable":true}')"

  if [ "$verdict" = INDETERMINATE ]; then
    finish INDETERMINATE "judge rc=$rc: $(grep -a '^INDETERMINATE ' "$out" | head -3 | tr '\n' ';') (no page)" 3 "$metrics"
  fi
  if [ "$verdict" = FAIL ]; then
    cp "$out" "$LOG.last-fail" 2>/dev/null || true
    if [ "${DRY_RUN:-0}" = 1 ]; then
      echo "$TAG [DRY_RUN] would send $ALERT_ID CRITICAL_PERSISTENT:"; page_body "$out"
    elif [ -x "$SEND" ]; then
      page_body "$out" | "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" || log "ESCALATE_UNSENT: send_telegram invocation failed"
    else
      log "ESCALATE_UNSENT: $SEND not executable"
    fi
    finish FAIL "judge rc=$rc findings=$(grep -c '^FAIL ' "$out" | tr -d ' ')" 1 "$metrics"
  fi
  finish PASS "judge rc=$rc $(grep -a '^conflicts=' "$out" | cut -d' ' -f1)" 0 "$metrics"
}

# ── two-way self-test, vacuity-guarded ─────────────────────────────────────────────────────────
self_test() {
  local me st checked=0 fails="" here real_send
  me="$0"; here="$(cd "$(dirname "$0")" && pwd)"
  TC_ST="$(mktemp -d 2>/dev/null || echo "/tmp/tc-st.$$")"; mkdir -p "$TC_ST"; st="$TC_ST"
  trap 'rm -rf "$TC_ST"' EXIT
  ck() { checked=$((checked + 1)); if [ "$2" = "$3" ]; then echo "SELF-TEST: ok   $1"; else echo "SELF-TEST: FAIL $1 (got '$2', want '$3')"; fails="$fails|$1"; fi; }
  has() { checked=$((checked + 1)); if grep -qF -- "$3" <<<"$2"; then echo "SELF-TEST: ok   $1"; else echo "SELF-TEST: FAIL $1 (missing '$3')"; fails="$fails|$1"; fi; }
  hasnt() { checked=$((checked + 1)); if grep -qF -- "$3" <<<"$2"; then echo "SELF-TEST: FAIL $1 (unexpected '$3')"; fails="$fails|$1"; else echo "SELF-TEST: ok   $1"; fi; }

  # A fake docker: `inspect` answers running unless $st/stopped exists; `exec` records argv, prints judge.out.
  cat > "$st/docker" <<EOF
#!/usr/bin/env bash
case "\$1" in
  inspect) [ -f "$st/stopped" ] && echo false || echo true ;;
  exec) shift; printf '%s\n' "\$@" > "$st/exec.argv"; cat "$st/judge.out"; exit \$(cat "$st/judge.rc" 2>/dev/null || echo 0) ;;
esac
EOF
  cat > "$st/send" <<EOF
#!/usr/bin/env bash
printf 'ARGV %s\n' "\$*" >> "$st/sent"; cat >> "$st/sent"; printf 'END\n' >> "$st/sent"
EOF
  chmod +x "$st/docker" "$st/send"
  judge() { # <verdict|''> [extra judge lines...]
    local v="$1"; shift
    {
      printf 'mode=check skipped_retired=EDGEX,BITMART\n'
      printf 'venue=BINANCE tradfi=234 crypto=659 lost=0 collisions=0 shadowed=1 denied=0\n'
      printf 'venue=OKX tradfi=222 crypto=289 lost=0 collisions=0 shadowed=0 denied=0\n'
      printf 'conflicts=99 (informational: the own record / first venue is kept)\n'
      for l in "$@"; do printf '%s\n' "$l"; done
      [ -n "$v" ] && printf '%s=%s\n' "$TOKEN" "$v"
    } > "$st/judge.out"
    TIER_CANARY_DOCKER="$st/docker" TIER_CANARY_SEND="${SEND_UNDER_TEST:-$st/send}" TIER_CANARY_LOG="$st/log" \
      TIER_CANARY_RESULT_LOG_DIR="${RESULT_DIR_UNDER_TEST:-$st/nolib}" CANARY_RESULT_LOG_PATH="$st/results.jsonl" \
      DRY_RUN="${DRY_UNDER_TEST:-0}" bash "$me" > "$st/run.out" 2>&1
    echo $? > "$st/run.rc"
  }
  tok() { grep -o "$TOKEN=[A-Z]*" "$st/run.out" | tail -1 | cut -d= -f2; }
  # `grep -c` prints 0 AND exits 1 on no match, so `|| echo 0` would print it twice.
  sends() { local n; n="$(grep -c "^ARGV $ALERT_ID CRITICAL_PERSISTENT" "$st/sent" 2>/dev/null)"; echo "${n:-0}"; }
  local U='FAIL unmapped venue=OKX tag="5" n=1 natives=EURUSD-USDT-SWAP action=add a VENUE_TAG_CLASS row for OKX "5"'
  local T='FAIL tier-not3-tradfi venue=BINANCE coin=TENCENT tier=4 class=HK_EQUITY n=7 action=the venue records TENCENT as HK_EQUITY; its tier must follow'

  # (1) PASS: no page; the judge is the totality script in --check mode, inside the container.
  judge PASS
  ck 'pass run: token PASS' "$(tok)" PASS
  ck 'pass run: exit 0' "$(cat "$st/run.rc")" 0
  ck 'pass run: no page' "$(sends)" 0
  has 'the judge is the totality script' "$(cat "$st/exec.argv")" 'dist/scripts/asset-class-totality.js'
  has 'in --check mode (the two-way tier check)' "$(cat "$st/exec.argv")" '--check'
  has 'inside the app container' "$(cat "$st/exec.argv")" 'crypto-quant-signal-mcp-mcp-server-1'
  ck 'the log takes ONE summary line per run' "$(grep -c . "$st/log" | tr -d ' ')" 1
  has 'the newest run is always in .last' "$(cat "$st/log.last" 2>/dev/null)" "$TOKEN=PASS"
  # (2) FAIL: one page, the FAIL lines as the body, venue + tag + action, the template wave id.
  judge FAIL "$U" "$T"
  ck 'fail run: token FAIL' "$(tok)" FAIL
  ck 'fail run: exit 1 (the token maps to its code)' "$(cat "$st/run.rc")" 1
  ck 'fail run: one page' "$(sends)" 1
  has 'the page goes to OPS_TIER_MISCLASSIFICATION, CRITICAL_PERSISTENT, body on stdin' "$(cat "$st/sent")" "ARGV $ALERT_ID CRITICAL_PERSISTENT -"
  has 'the body names the venue, the tag and the action' "$(cat "$st/sent")" '- unmapped venue=OKX tag="5" n=1 natives=EURUSD-USDT-SWAP action=add a VENUE_TAG_CLASS row for OKX "5"'
  has 'the body carries the tier finding with its coin' "$(cat "$st/sent")" '- tier-not3-tradfi venue=BINANCE coin=TENCENT'
  has 'the body counts findings as findings' "$(cat "$st/sent")" 'Asset-class totality: 2 findings FAILed'
  has 'the body carries the template wave id, never a hardcoded one' "$(cat "$st/sent")" 'OPS-ASSET-CLASS-TOTALITY-W{NEXT}'
  has 'a FAIL keeps its full judge output in .last-fail' "$(cat "$st/log.last-fail" 2>/dev/null)" "$U"
  # (3) A judge INDETERMINATE (a venue fetch failed): nothing sent, exit 3.
  judge INDETERMINATE 'INDETERMINATE fetch-failed venues=GATE' "$U"
  ck 'fetch failed: token INDETERMINATE' "$(tok)" INDETERMINATE
  ck 'fetch failed: exit 3' "$(cat "$st/run.rc")" 3
  ck 'fetch failed: nothing sent (still one page from the FAIL run)' "$(sends)" 1
  has 'fetch failed: the summary names why' "$(tail -1 "$st/log")" 'fetch-failed venues=GATE'
  hasnt 'a non-FAIL run never overwrites .last-fail' "$(cat "$st/log.last-fail")" 'fetch-failed'
  # (4) No token, or a stopped container: INDETERMINATE, nothing sent.
  judge ''
  ck 'no token: INDETERMINATE' "$(tok)" INDETERMINATE
  ck 'no token: exit 3' "$(cat "$st/run.rc")" 3
  touch "$st/stopped"; judge FAIL "$U"; rm -f "$st/stopped"
  ck 'stopped container: INDETERMINATE' "$(tok)" INDETERMINATE
  ck 'stopped container: nothing sent' "$(sends)" 1
  # (5) DRY_RUN=1: the real verdict and the body it WOULD send — nothing sent, nothing published.
  DRY_UNDER_TEST=1 judge FAIL "$U"
  ck 'dry run: token FAIL' "$(tok)" FAIL
  ck 'dry run: nothing sent' "$(sends)" 1
  has 'dry run: prints the body it would send' "$(cat "$st/run.out")" "[DRY_RUN] would send $ALERT_ID CRITICAL_PERSISTENT"
  has 'dry run: publishes nothing' "$(cat "$st/run.out")" '[DRY_RUN] would publish'
  # (6) Every non-dry exit path publishes a record — through the REAL canary_result_log beside this file.
  if [ -r "$here/canary_result_log.py" ]; then
    mkdir -p "$st/lib"; cp "$here/canary_result_log.py" "$st/lib/"
    RESULT_DIR_UNDER_TEST="$st/lib" judge FAIL "$U" "$T"
    has 'a FAIL run appends one result record' "$(cat "$st/run.out")" 'CANARY_RESULT_LOG=line='
    local rec; rec="$(tail -1 "$st/results.jsonl" 2>/dev/null || true)"
    has 'the record names this canary' "$rec" '"tier-misclassification"'
    has 'the record counts FAILs by kind' "$rec" '"fail_kinds":{"tier-not3-tradfi":1,"unmapped":1}'
    has 'the record carries per-venue counts' "$rec" '"OKX":{"collisions":0,"crypto":289,"lost":0,"tradfi":222}'
    has 'the record names the retired venues skipped' "$rec" '"skipped_retired":["EDGEX","BITMART"]'
    RESULT_DIR_UNDER_TEST="$st/lib" judge ''
    has 'an INDETERMINATE run also publishes' "$(tail -1 "$st/results.jsonl" 2>/dev/null)" '"INDETERMINATE"'
  else
    has 'canary_result_log.py sits beside this script' "missing" "present"
  fi
  # (7) Cooldown is the WRAPPER's: two FAIL runs reach the real send_telegram.sh (sandboxed, DRY_RUN_TG); the
  #     second is suppressed inside 24h.
  real_send="$here/send_telegram.sh"
  if [ -r "$real_send" ]; then
    mkdir -p "$st/tg"; printf 'TELEGRAM_BOT_TOKEN=selftest\nTELEGRAM_CHAT_ID=0\n' > "$st/tg/env"; printf '{"alerts":[]}\n' > "$st/tg/registry.json"; : > "$st/tg/status.md"
    cat > "$st/send-real" <<EOF
#!/usr/bin/env bash
ALERT_WRAPPER_LOG="$st/tg/log" ALERT_WRAPPER_STATE_DIR="$st/tg/state" ALERT_WRAPPER_ENV="$st/tg/env" \
ALERT_REGISTRY_PATH="$st/tg/registry.json" ALERT_WRAPPER_CURL=/bin/false STATUS_MD_PATH="$st/tg/status.md" \
DRY_RUN_TG=1 exec env -u VITEST -u NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT=0 bash "$real_send" "\$@"
EOF
    chmod +x "$st/send-real"
    for i in 1 2; do SEND_UNDER_TEST="$st/send-real" judge FAIL "$U"; done
    has 'run 1: the real wrapper fired (dry run, sandboxed)' "$(cat "$st/tg/log" 2>/dev/null)" 'DRY_RUN_FIRED'
    has 'run 2: the real wrapper suppressed it on its 24h cooldown' "$(cat "$st/tg/log" 2>/dev/null)" 'SUPPRESSED_COOLDOWN'
  else
    has 'send_telegram.sh sits beside this script' "missing" "present"
  fi

  # Vacuity guard: a self-test that asserted nothing must never report a pass.
  if [ "$checked" -lt 36 ]; then
    echo "SELF_TEST_VERDICT=INDETERMINATE — only $checked assertions ran (expected >= 36)"; return 3
  fi
  if [ -n "$fails" ]; then
    echo "SELF_TEST_VERDICT=FAIL — ${fails#|}"; return 1
  fi
  echo "SELF_TEST_VERDICT=PASS — $checked assertions (pass · fail page + body · fetch-failed / no-token / stopped INDETERMINATE · dry run · result record · wrapper cooldown)"
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  self_test; exit $?
fi
run_canary
