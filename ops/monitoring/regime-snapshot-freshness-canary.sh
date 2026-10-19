#!/usr/bin/env bash
# ops/monitoring/regime-snapshot-freshness-canary.sh — SCAN-MARKET-REGIMES-W1-V2 CH3.
#
# The freshness canary for the bar-close regime snapshot that scan_market_regimes serves. "Installed" is
# not "working": the sampler (cron 11 *) can exit 0 for weeks while one pair quietly stops advancing, and a
# stale snapshot served to a programmatic trader is a silent wrong answer. This wrapper runs the ONE
# freshness verdict — `dist/scripts/regime-snapshot-sampler.js --freshness`, INSIDE the app container — which
# judges only the producer's own run record through the same readers the tool serves from. Nothing here
# re-derives a verdict; this file only persists the known-unserved set, pages, clears and publishes.
#
# ── READ-ONLY ─────────────────────────────────────────────────────────────────────────────────
# The judge runs with PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=…": the server
# refuses any write in the session (SQLSTATE 25006), so the canary cannot mutate the store it judges. The
# judge never issues DDL — it adopts the existing tables (to_regclass) instead of the producer's lazy ensure.
#
# ── VERDICT ───────────────────────────────────────────────────────────────────────────────────
# Exactly one terminal `REGIME_SNAPSHOT_FRESHNESS_VERDICT=PASS|FAIL|INDETERMINATE` (exit 0 / 1 / 3). Read
# the TOKEN, never the code. No token, a stopped container or an unreadable state file is INDETERMINATE —
# and still publishes a record, never silence.
#
# ── THE KNOWN-UNSERVED SET (V2 CH3 R1 — page-on-change keyed VENUE|TF) ─────────────────────────────
# $STATE_FILE holds the comma-joined `VENUE|TF` pairs that were unserved when the canary started watching.
#   absent      → the judge runs in SEED mode: today's WINDOW_STALE pairs are seeded, printed UNSERVED,
#                 never paged. The file is written from REGIME_FRESHNESS_KNOWN_UNSERVED_NEXT.
#   present     → handed to the judge; a seeded pair prints UNSERVED each run, prints RESOLVED (no page)
#                 the run it turns servable and leaves the file, so a later relapse is a regression.
# The file is rewritten ONLY after a PASS or FAIL run (temp + rename); an INDETERMINATE run never shrinks
# or seeds it.
#
# ── THE PAGE ──────────────────────────────────────────────────────────────────────────────────
# FAIL → `regime_snapshot_stale` CRITICAL_PERSISTENT through send_telegram.sh; repetition is the wrapper's
# 24h cooldown, not this file's. PASS → `send_telegram.sh --clear regime_snapshot_stale` (adopted: true in
# alert-registry.json; announce_resolution false, so a clear is silent). INDETERMINATE pages nothing and
# clears nothing: a run that read nothing knows nothing.
#
# ── LOGS ──────────────────────────────────────────────────────────────────────────────────────
# $LOG gets ONE summary line per run (verdict, mode, keys). The judge's full output — one line per
# venue and per pair — is overwritten into $LOG.last every run and copied to $LOG.last-fail on a FAIL,
# so the forensics of the newest run and of the newest failure survive without an unbounded log.
#
# ── PUBLISHED ─────────────────────────────────────────────────────────────────────────────────
# Every run appends ONE canary_result_log record (canary `regime-snapshot-freshness`): verdict, mode, pair
# counts by state, the unserved / resolved / failing keys. Identifiers and counts only.
# ops/scripts/monitoring-results-sync.sh pulls it into the vault.
#
# ── SCHEDULE: 44 * * * * (signal-1) ───────────────────────────────────────────────────────────
# Hourly, 33 minutes after the producer's :11 fire (a full sweep measured 322 s). Read-only; safe-to-kill.
#
# Usage: regime-snapshot-freshness-canary.sh             # the canary (cron)
#        regime-snapshot-freshness-canary.sh --self-test # hermetic, two-way, vacuity-guarded
set -uo pipefail

CTR="${REGIME_FRESHNESS_APP_CTR:-crypto-quant-signal-mcp-mcp-server-1}"
SEND="${REGIME_FRESHNESS_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${REGIME_FRESHNESS_LOG:-/var/log/regime-snapshot-freshness.log}"
STATE_FILE="${REGIME_FRESHNESS_STATE_FILE:-/var/lib/algovault-monitoring/regime-snapshot-freshness/known-unserved}"
RESULT_LOG_DIR="${REGIME_FRESHNESS_RESULT_LOG_DIR:-/opt/algovault-monitoring}"
DOCKER="${REGIME_FRESHNESS_DOCKER:-docker}"   # the self-test's seam; unset in production
PGOPTS="-c default_transaction_read_only=on -c statement_timeout=60000"
ALERT_ID="regime_snapshot_stale"
CANARY="regime-snapshot-freshness"
TAG="[regime-freshness-canary]"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $TAG $*" >> "$LOG" 2>/dev/null || true; }

# `KEY=value` line value from the judge output (last occurrence). Empty when absent.
field() { grep -a "^$1=" "$2" | tail -1 | cut -d= -f2- ; }

# Result metrics from the judge output — counts by state + the key lists. Pure over the file.
metrics_of() { # output_file mode verdict
  python3 - "$1" "$2" "$3" <<'PYM'
import json, sys
out, mode, verdict = sys.argv[1], sys.argv[2], sys.argv[3]
pairs, venues, kv = [], [], {}
for line in open(out, encoding="utf-8", errors="replace"):
    line = line.rstrip("\n")
    for tag, acc in (("[regime-freshness] PAIR ", pairs), ("[regime-freshness] VENUE ", venues)):
        i = line.find(tag)
        if i >= 0:
            try: acc.append(json.loads(line[i + len(tag):]))
            except Exception: pass
    if line.startswith("REGIME_FRESHNESS_") and "=" in line:
        k, v = line.split("=", 1); kv[k] = [x for x in v.split(",") if x]
by = {}
for p in pairs: by[p.get("state")] = by.get(p.get("state"), 0) + 1
print(json.dumps({
    "mode": mode, "verdict": verdict, "pairs": len(pairs), "venues": len(venues),
    "states": dict(sorted(by.items())),
    "dead_venues": sorted(v.get("venue") for v in venues if v.get("state") == "PRODUCER_DEAD"),
    "unserved": kv.get("REGIME_FRESHNESS_UNSERVED", []), "resolved": kv.get("REGIME_FRESHNESS_RESOLVED", []),
    "fail_keys": kv.get("REGIME_FRESHNESS_FAIL_KEYS", []),
}, sort_keys=True))
PYM
}

# The page body. Every key carries its entity noun ("pair OKX|1h"), never a bare figure.
page_body() { # fail_keys_csv
  local n
  n="$(tr ',' '\n' <<<"$1" | grep -c . | tr -d ' ')"
  printf '🛑 %s\n' "$ALERT_ID"
  printf 'Regime snapshot freshness: %s %s FAILed the producer-record check.\n' "$n" "$( [ "$n" = 1 ] && echo finding || echo findings )"
  tr ',' '\n' <<<"$1" | grep . | while IFS= read -r k; do
    printf -- '- pair %s — %s\n' "${k%%:*}" "${k#*:}"
  done
  printf 'scan_market_regimes serves the newest servable generation; a pair past its bound is refused as\n'
  printf 'snapshot_stale, a dead producer stops every pair. PRODUCER_DEAD: check the :11 cron + /var/log/regime-sampler.log;\n'
  printf 'NEWLY_WINDOW_STALE: the venue serves a stale window for that timeframe (compare get_market_regime).\n'
  printf 'Log: %s (full judge output: %s.last-fail) · result: canary-results.jsonl (%s)\n' "$LOG" "$LOG" "$CANARY"
  printf 'Recommended wave: SCAN-MARKET-REGIMES-W{NEXT}\n'
}

publish() { # verdict exit_code metrics_json
  python3 - "$RESULT_LOG_DIR" "$CANARY" "$1" "$2" "$3" <<'PYREC' 2>/dev/null || echo "$TAG CANARY_RESULT_LOG_FAILED=python_unavailable"
import json, sys
sys.path.insert(0, sys.argv[1])
try:
    from canary_result_log import append_result
except Exception as e:
    print(f"[regime-freshness-canary] CANARY_RESULT_LOG_FAILED=import:{type(e).__name__}")
    raise SystemExit(0)
try:
    metrics = json.loads(sys.argv[5]) if sys.argv[5] else {}
    if not isinstance(metrics, dict):
        metrics = {"metrics_unparseable": True}
except Exception:
    metrics = {"metrics_unparseable": True}
ok, detail = append_result(sys.argv[2], sys.argv[3], int(sys.argv[4]), metrics)
print(f"[regime-freshness-canary] CANARY_RESULT_LOG={detail}" if ok else f"[regime-freshness-canary] CANARY_RESULT_LOG_FAILED={detail}")
PYREC
}

finish() { # verdict detail exit_code [metrics_json]
  log "$1 $2"
  publish "$1" "$3" "${4:-}"
  echo "$TAG $(date -u +%Y-%m-%dT%H:%M:%SZ) REGIME_SNAPSHOT_FRESHNESS_VERDICT=$1 $2"
  exit "$3"
}

# Persist the next known-unserved set atomically.
persist_state() { # csv
  local dir tmp
  dir="$(dirname "$STATE_FILE")"
  mkdir -p "$dir" 2>/dev/null || return 1
  tmp="$(mktemp "$dir/.known-unserved.XXXXXX" 2>/dev/null)" || return 1
  printf '%s\n' "$1" > "$tmp" && mv -f "$tmp" "$STATE_FILE"
}

run_canary() {
  local out rc verdict mode known_env next fails metrics tmp
  RFC_TMP="$(mktemp -d 2>/dev/null || echo "/tmp/rfc.$$")"; mkdir -p "$RFC_TMP"; tmp="$RFC_TMP"
  trap 'rm -rf "$RFC_TMP"' EXIT

  # A plain string compare, never `… | grep -q`: under pipefail that can false-miss on SIGPIPE.
  if [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null)" != true ]; then
    finish INDETERMINATE "container $CTR is not running — nothing was judged" 3
  fi

  # The known-unserved set: absent = SEED (env NOT passed); present = handed over verbatim (may be empty).
  known_env=()
  if [ -e "$STATE_FILE" ]; then
    if ! [ -r "$STATE_FILE" ]; then
      finish INDETERMINATE "state file $STATE_FILE exists but is unreadable — refusing to re-seed over it" 3
    fi
    known_env=(-e "REGIME_FRESHNESS_KNOWN_UNSERVED=$(head -1 "$STATE_FILE" | tr -d '[:space:]')")
  fi

  # ${a[@]+"${a[@]}"}: an empty array under `set -u` is an unbound error on bash 3.2.
  "$DOCKER" exec -e "PGOPTIONS=$PGOPTS" ${known_env[@]+"${known_env[@]}"} "$CTR" \
    node dist/scripts/regime-snapshot-sampler.js --freshness > "$tmp/out" 2>&1
  rc=$?
  # The FULL judge output is kept for the LAST run (and the last FAIL run) only. Appended hourly it
  # would grow the log ~80 lines an hour with no rotation; $LOG itself gets ONE line per run (finish).
  cp "$tmp/out" "$LOG.last" 2>/dev/null || true
  out="$tmp/out"

  verdict="$(field REGIME_SNAPSHOT_FRESHNESS_VERDICT "$out")"
  mode="$(grep -ao 'MODE=[A-Z]*' "$out" | tail -1 | cut -d= -f2)"
  case "$verdict" in
    PASS|FAIL|INDETERMINATE) ;;
    *) finish INDETERMINATE "no verdict token in the judge output (rc=$rc); state untouched" 3 ;;
  esac
  metrics="$(metrics_of "$out" "${mode:-UNKNOWN}" "$verdict" 2>/dev/null || echo '{"metrics_unparseable":true}')"

  if [ "$verdict" = INDETERMINATE ]; then
    finish INDETERMINATE "judge rc=$rc mode=${mode:-?} (state untouched, no page, no clear)" 3 "$metrics"
  fi

  next="$(field REGIME_FRESHNESS_KNOWN_UNSERVED_NEXT "$out")"
  if ! persist_state "$next"; then
    log "STATE_WRITE_FAILED: $STATE_FILE"
    finish INDETERMINATE "judge verdict $verdict but the known-unserved set could not be written to $STATE_FILE" 3 "$metrics"
  fi

  fails="$(field REGIME_FRESHNESS_FAIL_KEYS "$out")"
  if [ "$verdict" = FAIL ]; then
    cp "$tmp/out" "$LOG.last-fail" 2>/dev/null || true
    if [ -x "$SEND" ]; then
      page_body "$fails" | "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" || log "ESCALATE_UNSENT: send_telegram invocation failed"
    else
      log "ESCALATE_UNSENT: $SEND not executable"
    fi
    finish FAIL "judge rc=$rc mode=${mode:-?} fail_keys=$fails" 1 "$metrics"
  fi
  if [ -x "$SEND" ]; then
    "$SEND" --clear "$ALERT_ID" "freshness PASS" 2>>"$LOG" >/dev/null || log "CLEAR_UNSENT: send_telegram --clear failed"
  fi
  finish PASS "judge rc=$rc mode=${mode:-?} unserved=$(field REGIME_FRESHNESS_UNSERVED "$out") resolved=$(field REGIME_FRESHNESS_RESOLVED "$out")" 0 "$metrics"
}

# ── two-way self-test, vacuity-guarded ─────────────────────────────────────────────────────────
self_test() {
  local me st checked=0 fails="" here real_send
  me="$0"; here="$(cd "$(dirname "$0")" && pwd)"
  RFC_ST="$(mktemp -d 2>/dev/null || echo "/tmp/rfc-st.$$")"; mkdir -p "$RFC_ST"; st="$RFC_ST"
  trap 'rm -rf "$RFC_ST"' EXIT
  ck() { checked=$((checked + 1)); if [ "$2" = "$3" ]; then echo "SELF-TEST: ok   $1"; else echo "SELF-TEST: FAIL $1 (got '$2', want '$3')"; fails="$fails|$1"; fi; }
  has() { checked=$((checked + 1)); if grep -qF -- "$3" <<<"$2"; then echo "SELF-TEST: ok   $1"; else echo "SELF-TEST: FAIL $1 (missing '$3')"; fails="$fails|$1"; fi; }
  hasnt() { checked=$((checked + 1)); if grep -qF -- "$3" <<<"$2"; then echo "SELF-TEST: FAIL $1 (unexpected '$3')"; fails="$fails|$1"; else echo "SELF-TEST: ok   $1"; fi; }

  # A fake docker: `inspect` answers running unless $st/stopped exists; `exec` records its argv and prints
  # $st/judge.out.
  cat > "$st/docker" <<EOF
#!/usr/bin/env bash
case "\$1" in
  inspect) [ -f "$st/stopped" ] && echo false || echo true ;;
  exec) shift; printf '%s\n' "\$@" > "$st/exec.argv"; cat "$st/judge.out"; exit \$(cat "$st/judge.rc" 2>/dev/null || echo 0) ;;
esac
EOF
  # A recording wrapper: argv + body, one record per call.
  cat > "$st/send" <<EOF
#!/usr/bin/env bash
printf 'ARGV %s\n' "\$*" >> "$st/sent"; [ "\$1" = --clear ] || cat >> "$st/sent"; printf 'END\n' >> "$st/sent"
EOF
  chmod +x "$st/docker" "$st/send"
  judge() { # <verdict|''> <mode> <unserved> <resolved> <fail_keys> <next> [pair-state...]
    local v="$1" m="$2" u="$3" r="$4" f="$5" n="$6"; shift 6
    {
      printf '[regime-freshness] MODE=%s\n' "$m"
      printf '[regime-freshness] VENUE {"venue":"BINANCE","state":"LIVE","last_tick":"2026-10-19T10:11:00.000Z","age_min":33}\n'
      for s in "$@"; do printf '[regime-freshness] PAIR {"venue":"%s","tf":"%s","state":"%s"}\n' "${s%%|*}" "$(cut -d'|' -f2 <<<"$s")" "${s##*|}"; done
      printf 'REGIME_FRESHNESS_UNSERVED=%s\nREGIME_FRESHNESS_RESOLVED=%s\nREGIME_FRESHNESS_FAIL_KEYS=%s\nREGIME_FRESHNESS_KNOWN_UNSERVED_NEXT=%s\n' "$u" "$r" "$f" "$n"
      [ -n "$v" ] && printf 'REGIME_SNAPSHOT_FRESHNESS_VERDICT=%s\n' "$v"
    } > "$st/judge.out"
    REGIME_FRESHNESS_DOCKER="$st/docker" REGIME_FRESHNESS_SEND="${SEND_UNDER_TEST:-$st/send}" \
      REGIME_FRESHNESS_LOG="$st/log" REGIME_FRESHNESS_STATE_FILE="$st/state/known-unserved" \
      REGIME_FRESHNESS_RESULT_LOG_DIR="${RESULT_DIR_UNDER_TEST:-$st/nolib}" CANARY_RESULT_LOG_PATH="$st/results.jsonl" \
      bash "$me" > "$st/run.out" 2>&1
    echo $? > "$st/run.rc"
  }
  tok() { grep -o 'REGIME_SNAPSHOT_FRESHNESS_VERDICT=[A-Z]*' "$st/run.out" | tail -1 | cut -d= -f2; }
  state() { cat "$st/state/known-unserved" 2>/dev/null | tr -d '\n' || true; }
  # `grep -c` prints 0 AND exits 1 on no match, so `|| echo 0` would print it twice.
  sends() { local n; n="$(grep -c "^ARGV $ALERT_ID CRITICAL_PERSISTENT" "$st/sent" 2>/dev/null)"; echo "${n:-0}"; }
  clears() { local n; n="$(grep -c "^ARGV --clear $ALERT_ID" "$st/sent" 2>/dev/null)"; echo "${n:-0}"; }
  argv() { cat "$st/exec.argv" 2>/dev/null; }

  # (1) First run, no state file: SEED — the judge is NOT handed the set, the seed is persisted, PASS clears.
  judge PASS SEED 'BITGET|1d,OKX|1h' '' '' 'BITGET|1d,OKX|1h' 'BINANCE|1h|FRESH' 'OKX|1h|UNSERVED' 'BITGET|1d|UNSERVED'
  ck 'seed run: token PASS' "$(tok)" PASS
  ck 'seed run: exit 0' "$(cat "$st/run.rc")" 0
  hasnt 'seed run: the judge was NOT handed a known set (SEED needs it unset)' "$(argv)" 'REGIME_FRESHNESS_KNOWN_UNSERVED='
  has 'the judge runs read-only' "$(argv)" 'PGOPTIONS=-c default_transaction_read_only=on'
  has 'with a server-side statement timeout' "$(argv)" 'statement_timeout=60000'
  has 'and is the producer script in --freshness mode' "$(argv)" '--freshness'
  ck 'seed run: the seed is persisted' "$(state)" 'BITGET|1d,OKX|1h'
  ck 'seed run: no page' "$(sends)" 0
  ck 'seed run: PASS clears (adopted)' "$(clears)" 1
  # (2) Next run: the set is handed over verbatim; still PASS.
  judge PASS JUDGE 'BITGET|1d,OKX|1h' '' '' 'BITGET|1d,OKX|1h' 'OKX|1h|UNSERVED'
  has 'judge run: the known set is handed over' "$(argv)" 'REGIME_FRESHNESS_KNOWN_UNSERVED=BITGET|1d,OKX|1h'
  ck 'judge run: PASS' "$(tok)" PASS
  # (3) A seeded pair RESOLVES: no page, and it leaves the persisted set.
  judge PASS JUDGE 'BITGET|1d' 'OKX|1h' '' 'BITGET|1d' 'OKX|1h|RESOLVED' 'BITGET|1d|UNSERVED'
  ck 'resolved run: PASS' "$(tok)" PASS
  ck 'resolved run: the pair left the set' "$(state)" 'BITGET|1d'
  ck 'resolved run: no page' "$(sends)" 0
  has 'resolved run: the log names the resolution' "$(cat "$st/log")" 'resolved=OKX|1h'
  # (4) The regression arm: a pair NEWLY WINDOW_STALE FAILs and pages, with the entity noun.
  judge FAIL JUDGE 'BITGET|1d' '' 'OKX|1h:NEWLY_WINDOW_STALE' 'BITGET|1d' 'OKX|1h|NEWLY_WINDOW_STALE'
  ck 'regression run: token FAIL' "$(tok)" FAIL
  ck 'regression run: exit 1 (the token maps to its code)' "$(cat "$st/run.rc")" 1
  ck 'regression run: one page' "$(sends)" 1
  has 'the page goes to regime_snapshot_stale, CRITICAL_PERSISTENT, body on stdin' "$(cat "$st/sent")" "ARGV $ALERT_ID CRITICAL_PERSISTENT -"
  has 'the body names the pair with its entity noun and its state' "$(cat "$st/sent")" '- pair OKX|1h — NEWLY_WINDOW_STALE'
  has 'the body counts findings as findings' "$(cat "$st/sent")" 'Regime snapshot freshness: 1 finding FAILed'
  has 'the body carries the template wave id, never a hardcoded one' "$(cat "$st/sent")" 'SCAN-MARKET-REGIMES-W{NEXT}'
  ck 'regression run: a FAIL never clears' "$(clears)" 3
  ck 'regression run: the set is NOT widened by a regression' "$(state)" 'BITGET|1d'
  has 'a FAIL keeps its full judge output in .last-fail' "$(cat "$st/log.last-fail" 2>/dev/null)" '[regime-freshness] PAIR {"venue":"OKX","tf":"1h","state":"NEWLY_WINDOW_STALE"}'
  has 'the newest run is always in .last' "$(cat "$st/log.last" 2>/dev/null)" 'REGIME_SNAPSHOT_FRESHNESS_VERDICT=FAIL'
  ck 'the log itself never takes the judge output (one summary line per run)' "$(grep -c '\[regime-freshness\] PAIR' "$st/log" | tr -d ' ')" 0
  # (5) A FAIL with two findings counts both.
  judge FAIL JUDGE '' '' 'BINANCE|*:PRODUCER_DEAD,BYBIT|4h:STALE_GENERATION' '' 'BYBIT|4h|STALE_GENERATION'
  has 'two findings are counted as two' "$(cat "$st/sent")" '2 findings FAILed'
  has 'a dead producer is named by venue' "$(cat "$st/sent")" '- pair BINANCE|* — PRODUCER_DEAD'
  ck 'an emptied set is persisted as empty, not deleted (empty ≠ SEED)' "$(state)$( [ -e "$st/state/known-unserved" ] && echo :present)" ':present'
  # (6) INDETERMINATE from the judge: state untouched, no page, no clear, exit 3.
  printf 'KEEP|1h\n' > "$st/state/known-unserved"
  judge INDETERMINATE JUDGE '' '' '' ''
  ck 'judge INDETERMINATE: token INDETERMINATE' "$(tok)" INDETERMINATE
  ck 'judge INDETERMINATE: exit 3' "$(cat "$st/run.rc")" 3
  ck 'judge INDETERMINATE: state untouched' "$(state)" 'KEEP|1h'
  ck 'judge INDETERMINATE: no page' "$(sends)" 2
  ck 'judge INDETERMINATE: no clear' "$(clears)" 3
  hasnt 'a non-FAIL run never overwrites .last-fail' "$(cat "$st/log.last-fail" 2>/dev/null)" 'REGIME_SNAPSHOT_FRESHNESS_VERDICT=INDETERMINATE'
  # (7) Whole-run INDETERMINATE: no token / stopped container — state untouched.
  judge '' JUDGE 'X|1h' '' '' 'X|1h'
  ck 'no token: INDETERMINATE' "$(tok)" INDETERMINATE
  ck 'no token: state untouched' "$(state)" 'KEEP|1h'
  touch "$st/stopped"; judge PASS JUDGE '' '' '' ''; rm -f "$st/stopped"
  ck 'stopped container: INDETERMINATE' "$(tok)" INDETERMINATE
  ck 'stopped container: exit 3' "$(cat "$st/run.rc")" 3
  ck 'stopped container: state untouched' "$(state)" 'KEEP|1h'
  # (8) An unreadable state file refuses rather than re-seeding over it (skipped when running as root,
  #     which reads through mode 000).
  if [ "$(id -u)" != 0 ]; then
    chmod 000 "$st/state/known-unserved"; judge PASS SEED 'A|1h' '' '' 'A|1h'; chmod 600 "$st/state/known-unserved"
    ck 'unreadable state: INDETERMINATE' "$(tok)" INDETERMINATE
    ck 'unreadable state: not re-seeded' "$(state)" 'KEEP|1h'
  else
    ck 'unreadable state: (root reads mode 000 — arm covered off-host)' ok ok
    ck 'unreadable state: (root) state untouched' "$(state)" 'KEEP|1h'
  fi
  # (9) Every exit path publishes a record — through the REAL canary_result_log when it is beside this file.
  if [ -r "$here/canary_result_log.py" ]; then
    mkdir -p "$st/lib"; cp "$here/canary_result_log.py" "$st/lib/"
    RESULT_DIR_UNDER_TEST="$st/lib" judge PASS JUDGE 'KEEP|1h' '' '' 'KEEP|1h' 'BINANCE|1h|FRESH' 'KEEP|1h|UNSERVED'
    has 'a PASS run appends one result record' "$(cat "$st/run.out")" 'CANARY_RESULT_LOG=line='
    local rec; rec="$(tail -1 "$st/results.jsonl" 2>/dev/null || true)"
    has 'the record names this canary' "$rec" '"regime-snapshot-freshness"'
    has 'the record counts pairs by state' "$rec" '"states":{"FRESH":1,"UNSERVED":1}'
    has 'the record lists the unserved pairs' "$rec" '"unserved":["KEEP|1h"]'
    RESULT_DIR_UNDER_TEST="$st/lib" judge '' JUDGE '' '' '' ''
    has 'an INDETERMINATE run also publishes' "$(tail -1 "$st/results.jsonl" 2>/dev/null)" '"INDETERMINATE"'
  else
    has 'canary_result_log.py sits beside this script' "missing" "present"
  fi
  # (10) Cooldown is the WRAPPER's: two FAIL runs reach the real send_telegram.sh (sandboxed, DRY_RUN); the
  #      second is suppressed inside 24h, and a PASS clears through it.
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
    for i in 1 2; do SEND_UNDER_TEST="$st/send-real" judge FAIL JUDGE '' '' 'BYBIT|1h:STALE_GENERATION' '' 'BYBIT|1h|STALE_GENERATION'; done
    has 'run 1: the real wrapper fired (dry run, sandboxed)' "$(cat "$st/tg/log" 2>/dev/null)" 'DRY_RUN_FIRED'
    has 'run 2: the real wrapper suppressed it on its 24h cooldown' "$(cat "$st/tg/log" 2>/dev/null)" 'SUPPRESSED_COOLDOWN'
    SEND_UNDER_TEST="$st/send-real" judge PASS JUDGE '' '' '' ''
    ck 'a PASS after the fires exits 0 through the real wrapper' "$(cat "$st/run.rc")" 0
  else
    has 'send_telegram.sh sits beside this script' "missing" "present"
  fi

  # Vacuity guard: a self-test that asserted nothing must never report a pass.
  if [ "$checked" -lt 45 ]; then
    echo "SELF_TEST_VERDICT=INDETERMINATE — only $checked assertions ran (expected >= 45)"; return 3
  fi
  if [ -n "$fails" ]; then
    echo "SELF_TEST_VERDICT=FAIL — ${fails#|}"; return 1
  fi
  echo "SELF_TEST_VERDICT=PASS — $checked assertions (seed · hand-over · resolve · regression page + body · empty-vs-seed · INDETERMINATE per judge and per run · unreadable state · result record · wrapper cooldown + clear)"
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  self_test; exit $?
fi
run_canary
