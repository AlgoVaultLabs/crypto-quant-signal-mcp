#!/usr/bin/env bash
# ops/monitoring/pre-trade-health-canary.sh — DECISION-CALL-V1-W3 CH2.
#
# The hourly health canary for pre_trade_check, the priced pre-trade decision call. "Installed" is not
# "working": the tool can answer every call it gets and still be degraded for the next one — three venue
# feeds down, a fee table past its verification date — with nothing paging. This wrapper runs ONE probe —
# `dist/scripts/pre-trade-health.js`, INSIDE the app container — and acts on its two tokens. Nothing here
# re-derives a verdict; this file only keeps a counter, pages, clears and publishes.
#
# ── READ-ONLY ─────────────────────────────────────────────────────────────────────────────────
# The probe runs with PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=…": the server
# refuses any write in the session (SQLSTATE 25006). The probe adopts the regime tables (to_regclass)
# instead of ensuring them, and calls the ENGINE, not the pipeline: no request_log row, no quota unit.
#
# ── TWO TOKENS, TWO ALERTS (read each TOKEN, never the code) ────────────────────────────────────
#   PRE_TRADE_HEALTH_VERDICT → pre_trade_check_degraded, CRITICAL_PERSISTENT after 2 CONSECUTIVE FAILs.
#     One FAIL is never a page: the probe is one call through live venue feeds, and one blip is noise.
#     $STATE_FILE holds the consecutive-FAIL count. PASS rewrites it to 0 and clears; FAIL increments it and
#     pages at >= 2 (repetition is the wrapper's 24h cooldown, not this file's). It is rewritten ONLY after a
#     PASS or FAIL run (temp + rename). An INDETERMINATE run — no token, a stopped container, an unreachable
#     database — never touches it, pages nothing and clears nothing: a run that judged nothing knows nothing.
#     A count that cannot be read restarts at 1 on the next FAIL and is logged: the sustain is never
#     skipped (one FAIL still pages nothing) and a corrupt file can never hold the alert dark.
#   VENUE_FEE_TABLE_VERDICT → venue_fee_table_stale, CRITICAL_PERSISTENT on the FIRST FAIL (a date does not
#     blip); PASS clears. The probe judges it with no database, so it still acts when the health token cannot.
#   Both alerts: adopted (the owner calls --clear), announce_resolution false — a clear is silent.
#
# ── LOGS ──────────────────────────────────────────────────────────────────────────────────────
# $LOG gets ONE summary line per run (both verdicts, the count, the wall time). The probe's full output —
# one line per check, per venue and per fee row — is overwritten into $LOG.last every run and copied to
# $LOG.last-fail on a FAIL, so the newest run and the newest failure survive without an unbounded log.
#
# ── PUBLISHED ─────────────────────────────────────────────────────────────────────────────────
# Every run appends ONE canary_result_log record (canary `pre-trade-health`): both verdicts, the wall time,
# venue states, the failed checks, the stale fee rows and the count. Identifiers and counts only.
# ops/scripts/monitoring-results-sync.sh pulls it into the vault.
#
# ── SCHEDULE: 47 * * * * (signal-1) ───────────────────────────────────────────────────────────
# Hourly, clear of the :44 regime-freshness canary and 13 minutes from the hour boundary. Read-only;
# safe-to-kill (a killed run prints no token, which is INDETERMINATE).
#
# Usage: pre-trade-health-canary.sh             # the canary (cron)
#        pre-trade-health-canary.sh --self-test # hermetic, two-way, vacuity-guarded
set -uo pipefail

CTR="${PRE_TRADE_HEALTH_APP_CTR:-crypto-quant-signal-mcp-mcp-server-1}"
SEND="${PRE_TRADE_HEALTH_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${PRE_TRADE_HEALTH_LOG:-/var/log/pre-trade-health.log}"
STATE_FILE="${PRE_TRADE_HEALTH_STATE_FILE:-/var/lib/algovault-monitoring/pre-trade-health/consecutive-fails}"
RESULT_LOG_DIR="${PRE_TRADE_HEALTH_RESULT_LOG_DIR:-/opt/algovault-monitoring}"
DOCKER="${PRE_TRADE_HEALTH_DOCKER:-docker}"   # the self-test's seam; unset in production
PGOPTS="-c default_transaction_read_only=on -c statement_timeout=60000"
ALERT_ID="pre_trade_check_degraded"
FEE_ALERT_ID="venue_fee_table_stale"
SUSTAIN=2
CANARY="pre-trade-health"
TAG="[pre-trade-health-canary]"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $TAG $*" >> "$LOG" 2>/dev/null || true; }

# `KEY=value` line value from the probe output (last occurrence). Empty when absent.
field() { grep -a "^$1=" "$2" | tail -1 | cut -d= -f2- ; }

# A verdict token, or INDETERMINATE when it is absent or not one of the three.
token_of() { # name output_file
  local v; v="$(field "$1" "$2")"
  case "$v" in PASS|FAIL|INDETERMINATE) echo "$v" ;; *) echo INDETERMINATE ;; esac
}

# The probe output, read by mode. Pure over the file.
#   down    — one body line per DOWN venue        stale   — one body line per stale fee row
#   limit   — the fee table's max age in days     metrics — the result record (health fees count)
probe_read() { # mode output_file [health fees count]
  python3 - "$@" <<'PYR'
import json, sys
mode, out = sys.argv[1], sys.argv[2]
fees, venues, kv, checks = [], [], {}, {}
for line in open(out, encoding="utf-8", errors="replace"):
    line = line.rstrip("\n")
    for tag, acc in (("[pre-trade-health] FEE ", fees), ("[pre-trade-health] VENUE ", venues)):
        i = line.find(tag)
        if i >= 0:
            try: acc.append(json.loads(line[i + len(tag):]))
            except Exception: pass
    if (line.startswith("PRE_TRADE_HEALTH_") or line.startswith("VENUE_FEE_TABLE_")) and "=" in line:
        k, v = line.split("=", 1); kv[k] = v
    i = line.find("[pre-trade-health] CHECK ")
    if i >= 0:
        for tok in line[i:].split():
            if tok.startswith(("max_age_days=", "decision=")): checks[tok.split("=", 1)[0]] = tok.split("=", 1)[1]
if mode == "down":
    for v in venues:
        if v.get("state") == "DOWN": print(f"- venue {v.get('exchange')} — {v.get('excluded')}")
elif mode == "stale":
    for f in fees:
        if f.get("stale") is True:
            age = f.get("age_days")
            print(f"- venue {f.get('exchange')} — verified {f.get('verified_at')} ({f'{age} days' if isinstance(age, int) else 'unparseable date'}), source {f.get('source_url')}")
elif mode == "limit":
    print(checks.get("max_age_days", "?"))
elif mode == "metrics":
    health, fee_v, count = sys.argv[3], sys.argv[4], sys.argv[5]
    by = {}
    for v in venues: by[v.get("state")] = by.get(v.get("state"), 0) + 1
    wall = kv.get("PRE_TRADE_HEALTH_WALL_MS", "")
    print(json.dumps({
        "health": health, "fees": fee_v,
        "wall_ms": int(wall) if wall.isdigit() else None,
        "decision": checks.get("decision"),
        "venues": len(venues), "venue_states": dict(sorted(by.items())),
        "down": sorted(f"{v.get('exchange')}:{v.get('excluded')}" for v in venues if v.get("state") == "DOWN"),
        "fail_keys": [k for k in kv.get("PRE_TRADE_HEALTH_FAIL_KEYS", "").split(";") if k],
        "fee_rows": len(fees),
        "fee_stale": [x for x in kv.get("VENUE_FEE_TABLE_STALE", "").split(",") if x],
        "consecutive_fails": int(count) if count.isdigit() else None,
    }, sort_keys=True))
PYR
}

# The health page. Every key carries its entity noun ("check venues", "venue OKX"), never a bare figure.
health_body() { # fail_keys count output_file
  local wall
  wall="$(field PRE_TRADE_HEALTH_WALL_MS "$3")"
  printf '🛑 %s\n' "$ALERT_ID"
  printf 'pre_trade_check health probe FAILed %s consecutive hourly runs (pages at %s).\n' "$2" "$SUSTAIN"
  tr ';' '\n' <<<"$1" | grep . | while IFS= read -r k; do
    printf -- '- check %s — %s\n' "${k%%:*}" "${k#*:}"
  done
  probe_read down "$3" 2>/dev/null || true
  printf 'Probe: BTC long $10,000, 8h hold, 4h regime — one engine call, internal license, batch lane; wall %s ms.\n' "${wall:-?}"
  printf 'A refusal, throw or missing decision is what every caller gets; a feed/funding_unavailable venue drops out of the ranking.\n'
  printf 'Log: %s (full probe output: %s.last-fail) · result: canary-results.jsonl (%s)\n' "$LOG" "$LOG" "$CANARY"
  printf 'Recommended wave: DECISION-CALL-V1-W{NEXT}\n'
}

# The fee page.
fee_body() { # output_file
  local n
  n="$(probe_read stale "$1" 2>/dev/null | grep -c . | tr -d ' ')"
  printf '🛑 %s\n' "$FEE_ALERT_ID"
  printf 'The pre_trade_check fee table has %s %s past the %s-day verification limit (it still prices, with a FEE_TABLE_STALE note).\n' \
    "$n" "$( [ "$n" = 1 ] && echo row || echo rows )" "$(probe_read limit "$1" 2>/dev/null || echo '?')"
  probe_read stale "$1" 2>/dev/null || true
  printf 'Re-verify each source page, then bump that row'"'"'s verifiedAt in src/lib/venue-fees.ts.\n'
  printf 'Log: %s (full probe output: %s.last-fail) · result: canary-results.jsonl (%s)\n' "$LOG" "$LOG" "$CANARY"
  printf 'Recommended wave: VENUE-FEES-REVERIFY-W{NEXT}\n'
}

publish() { # verdict exit_code metrics_json
  python3 - "$RESULT_LOG_DIR" "$CANARY" "$1" "$2" "$3" <<'PYREC' 2>/dev/null || echo "$TAG CANARY_RESULT_LOG_FAILED=python_unavailable"
import json, sys
sys.path.insert(0, sys.argv[1])
try:
    from canary_result_log import append_result
except Exception as e:
    print(f"[pre-trade-health-canary] CANARY_RESULT_LOG_FAILED=import:{type(e).__name__}")
    raise SystemExit(0)
try:
    metrics = json.loads(sys.argv[5]) if sys.argv[5] else {}
    if not isinstance(metrics, dict):
        metrics = {"metrics_unparseable": True}
except Exception:
    metrics = {"metrics_unparseable": True}
ok, detail = append_result(sys.argv[2], sys.argv[3], int(sys.argv[4]), metrics)
print(f"[pre-trade-health-canary] CANARY_RESULT_LOG={detail}" if ok else f"[pre-trade-health-canary] CANARY_RESULT_LOG_FAILED={detail}")
PYREC
}

# One verdict for the run: FAIL if either token FAILs, else INDETERMINATE if either is, else PASS.
combined() { # health fees
  if [ "$1" = FAIL ] || [ "$2" = FAIL ]; then echo FAIL
  elif [ "$1" = INDETERMINATE ] || [ "$2" = INDETERMINATE ]; then echo INDETERMINATE
  else echo PASS; fi
}

finish() { # health fees detail [metrics_json]
  local v code
  v="$(combined "$1" "$2")"
  case "$v" in PASS) code=0 ;; FAIL) code=1 ;; *) code=3 ;; esac
  log "health=$1 fees=$2 $3"
  publish "$v" "$code" "${4:-}"
  echo "$TAG $(date -u +%Y-%m-%dT%H:%M:%SZ) PRE_TRADE_HEALTH_VERDICT=$1 $3"
  echo "$TAG $(date -u +%Y-%m-%dT%H:%M:%SZ) VENUE_FEE_TABLE_VERDICT=$2"
  exit "$code"
}

# The consecutive-FAIL count: absent = 0. Returns 1 (and prints nothing) when it cannot be read as a count.
read_count() {
  local v
  [ -e "$STATE_FILE" ] || { echo 0; return 0; }
  [ -r "$STATE_FILE" ] || return 1
  v="$(head -1 "$STATE_FILE" 2>/dev/null | tr -d '[:space:]')"
  case "$v" in ''|*[!0-9]*) return 1 ;; esac
  echo "$((10#$v))"
}

# Persist the next count atomically (a rename replaces the file whatever its own mode).
persist_count() { # n
  local dir tmp
  dir="$(dirname "$STATE_FILE")"
  mkdir -p "$dir" 2>/dev/null || return 1
  tmp="$(mktemp "$dir/.consecutive-fails.XXXXXX" 2>/dev/null)" || return 1
  printf '%s\n' "$1" > "$tmp" && mv -f "$tmp" "$STATE_FILE"
}

page() { # alert_id  (body on stdin)
  if [ -x "$SEND" ]; then
    "$SEND" "$1" CRITICAL_PERSISTENT - 2>>"$LOG" || log "ESCALATE_UNSENT: send_telegram invocation failed ($1)"
  else
    cat > /dev/null; log "ESCALATE_UNSENT: $SEND not executable ($1)"
  fi
}

clear_alert() { # alert_id note
  if [ -x "$SEND" ]; then
    "$SEND" --clear "$1" "$2" 2>>"$LOG" >/dev/null || log "CLEAR_UNSENT: send_telegram --clear failed ($1)"
  fi
}

run_canary() {
  local out rc health fees prev count="" fails tmp detail
  PTH_TMP="$(mktemp -d 2>/dev/null || echo "/tmp/pth.$$")"; mkdir -p "$PTH_TMP"; tmp="$PTH_TMP"
  trap 'rm -rf "$PTH_TMP"' EXIT

  # A plain string compare, never `… | grep -q`: under pipefail that can false-miss on SIGPIPE.
  if [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null)" != true ]; then
    finish INDETERMINATE INDETERMINATE "container $CTR is not running — nothing was judged; count untouched"
  fi

  "$DOCKER" exec -e "PGOPTIONS=$PGOPTS" "$CTR" node dist/scripts/pre-trade-health.js > "$tmp/out" 2>&1
  rc=$?
  # The FULL probe output is kept for the LAST run (and the last FAIL run) only; $LOG gets ONE line per run.
  cp "$tmp/out" "$LOG.last" 2>/dev/null || true
  out="$tmp/out"
  health="$(token_of PRE_TRADE_HEALTH_VERDICT "$out")"
  fees="$(token_of VENUE_FEE_TABLE_VERDICT "$out")"

  # ── the fee arm: stateless, pages on the first FAIL ────────────────────────────────────────────
  case "$fees" in
    FAIL) fee_body "$out" | page "$FEE_ALERT_ID" ;;
    PASS) clear_alert "$FEE_ALERT_ID" "fee table PASS" ;;
  esac

  # ── the health arm: the 2-run sustain ──────────────────────────────────────────────────────────
  case "$health" in
    PASS)
      if persist_count 0; then count=0; clear_alert "$ALERT_ID" "pre_trade_check health PASS"
      else log "STATE_WRITE_FAILED: $STATE_FILE"; health=INDETERMINATE; fi
      ;;
    FAIL)
      if prev="$(read_count)"; then count=$((prev + 1)); else log "STATE_UNREADABLE: $STATE_FILE — the count restarts at 1"; count=1; fi
      if persist_count "$count"; then
        fails="$(field PRE_TRADE_HEALTH_FAIL_KEYS "$out")"
        [ "$count" -ge "$SUSTAIN" ] && health_body "$fails" "$count" "$out" | page "$ALERT_ID"
      else
        log "STATE_WRITE_FAILED: $STATE_FILE"; health=INDETERMINATE; count=""
      fi
      ;;
  esac

  if [ "$health" = FAIL ] || [ "$fees" = FAIL ]; then cp "$tmp/out" "$LOG.last-fail" 2>/dev/null || true; fi
  detail="probe rc=$rc count=${count:-untouched} wall_ms=$(field PRE_TRADE_HEALTH_WALL_MS "$out") fail_keys=$(field PRE_TRADE_HEALTH_FAIL_KEYS "$out") stale_fees=$(field VENUE_FEE_TABLE_STALE "$out")"
  finish "$health" "$fees" "$detail" "$(probe_read metrics "$out" "$health" "$fees" "$count" 2>/dev/null || echo '{"metrics_unparseable":true}')"
}

# ── two-way self-test, vacuity-guarded ─────────────────────────────────────────────────────────
self_test() {
  local me st checked=0 fails="" here real_send
  me="$0"; here="$(cd "$(dirname "$0")" && pwd)"
  PTH_ST="$(mktemp -d 2>/dev/null || echo "/tmp/pth-st.$$")"; mkdir -p "$PTH_ST"; st="$PTH_ST"
  trap 'rm -rf "$PTH_ST"' EXIT
  ck() { checked=$((checked + 1)); if [ "$2" = "$3" ]; then echo "SELF-TEST: ok   $1"; else echo "SELF-TEST: FAIL $1 (got '$2', want '$3')"; fails="$fails|$1"; fi; }
  has() { checked=$((checked + 1)); if grep -qF -- "$3" <<<"$2"; then echo "SELF-TEST: ok   $1"; else echo "SELF-TEST: FAIL $1 (missing '$3')"; fails="$fails|$1"; fi; }
  hasnt() { checked=$((checked + 1)); if grep -qF -- "$3" <<<"$2"; then echo "SELF-TEST: FAIL $1 (unexpected '$3')"; fails="$fails|$1"; else echo "SELF-TEST: ok   $1"; fi; }

  # A fake docker: `inspect` answers running unless $st/stopped exists; `exec` records its argv and prints
  # $st/probe.out.
  cat > "$st/docker" <<EOF
#!/usr/bin/env bash
case "\$1" in
  inspect) [ -f "$st/stopped" ] && echo false || echo true ;;
  exec) shift; printf '%s\n' "\$@" > "$st/exec.argv"; cat "$st/probe.out"; exit \$(cat "$st/probe.rc" 2>/dev/null || echo 0) ;;
esac
EOF
  # A recording wrapper: argv + body, one record per call.
  cat > "$st/send" <<EOF
#!/usr/bin/env bash
printf 'ARGV %s\n' "\$*" >> "$st/sent"; [ "\$1" = --clear ] || cat >> "$st/sent"; printf 'END\n' >> "$st/sent"
EOF
  chmod +x "$st/docker" "$st/send"
  # probe <health|''> <fees|''> <fail_keys> <stale_fee_venue|''> [EXCHANGE:excluded|-:UP|DOWN ...]
  probe() {
    local h="$1" f="$2" k="$3" s="$4" ex v x
    shift 4
    {
      for ex in BINANCE BYBIT; do
        if [ "$ex" = "$s" ]; then
          printf '[pre-trade-health] FEE {"age_days":95,"exchange":"%s","source_url":"https://fees.example/%s","stale":true,"verified_at":"2026-07-28"}\n' "$ex" "$ex"
        else
          printf '[pre-trade-health] FEE {"age_days":7,"exchange":"%s","source_url":"https://fees.example/%s","stale":false,"verified_at":"2026-10-24"}\n' "$ex" "$ex"
        fi
      done
      printf '[pre-trade-health] CHECK fee_table rows=2 stale=%s max_age_days=90\n' "$( [ -n "$s" ] && echo 1 || echo 0 )"
      printf 'VENUE_FEE_TABLE_STALE=%s\n' "$s"
      [ -n "$f" ] && printf 'VENUE_FEE_TABLE_VERDICT=%s\n' "$f"
      printf '[pre-trade-health] CHECK db=REACHABLE regime_tables=ADOPTED\n'
      for v in "$@"; do
        x="$(cut -d: -f2 <<<"$v")"; [ "$x" = - ] && x=null || x="\"$x\""
        printf '[pre-trade-health] VENUE {"exchange":"%s","excluded":%s,"state":"%s"}\n' "${v%%:*}" "$x" "${v##*:}"
      done
      printf '[pre-trade-health] CHECK decision=GO reasons=none\n'
      printf 'PRE_TRADE_HEALTH_WALL_MS=1234\nPRE_TRADE_HEALTH_FAIL_KEYS=%s\n' "$k"
      [ -n "$h" ] && printf 'PRE_TRADE_HEALTH_VERDICT=%s\n' "$h"
    } > "$st/probe.out"
    PRE_TRADE_HEALTH_DOCKER="$st/docker" PRE_TRADE_HEALTH_SEND="${SEND_UNDER_TEST:-$st/send}" \
      PRE_TRADE_HEALTH_LOG="$st/log" PRE_TRADE_HEALTH_STATE_FILE="$st/state/consecutive-fails" \
      PRE_TRADE_HEALTH_RESULT_LOG_DIR="${RESULT_DIR_UNDER_TEST:-$st/nolib}" CANARY_RESULT_LOG_PATH="$st/results.jsonl" \
      bash "$me" > "$st/run.out" 2>&1
    echo $? > "$st/run.rc"
  }
  htok() { grep -o 'PRE_TRADE_HEALTH_VERDICT=[A-Z]*' "$st/run.out" | tail -1 | cut -d= -f2; }
  ftok() { grep -o 'VENUE_FEE_TABLE_VERDICT=[A-Z]*' "$st/run.out" | tail -1 | cut -d= -f2; }
  state() { cat "$st/state/consecutive-fails" 2>/dev/null | tr -d '\n' || true; }
  # `grep -c` prints 0 AND exits 1 on no match, so `|| echo 0` would print it twice.
  sends() { local n; n="$(grep -c "^ARGV $1 CRITICAL_PERSISTENT" "$st/sent" 2>/dev/null)"; echo "${n:-0}"; }
  clears() { local n; n="$(grep -c "^ARGV --clear $1" "$st/sent" 2>/dev/null)"; echo "${n:-0}"; }
  argv() { cat "$st/exec.argv" 2>/dev/null; }
  local UP5=(BINANCE:-:UP BYBIT:-:UP OKX:-:UP BITGET:-:UP HYPERLIQUID:-:UP)
  local DOWN3=(BINANCE:feed_unavailable:DOWN OKX:feed_unavailable:DOWN BYBIT:funding_unavailable:DOWN BITGET:-:UP HYPERLIQUID:-:UP)

  # (1) PASS / PASS: exit 0, the count is written as 0, both alerts clear, nothing pages.
  probe PASS PASS '' '' "${UP5[@]}"
  ck 'pass run: health token PASS' "$(htok)" PASS
  ck 'pass run: fee token PASS' "$(ftok)" PASS
  ck 'pass run: exit 0' "$(cat "$st/run.rc")" 0
  has 'the probe runs read-only' "$(argv)" 'PGOPTIONS=-c default_transaction_read_only=on'
  has 'with a server-side statement timeout' "$(argv)" 'statement_timeout=60000'
  has 'and is the health probe script' "$(argv)" 'dist/scripts/pre-trade-health.js'
  ck 'pass run: the count is 0' "$(state)" 0
  ck 'pass run: no health page' "$(sends "$ALERT_ID")" 0
  ck 'pass run: no fee page' "$(sends "$FEE_ALERT_ID")" 0
  ck 'pass run: health PASS clears (adopted)' "$(clears "$ALERT_ID")" 1
  ck 'pass run: fee PASS clears (adopted)' "$(clears "$FEE_ALERT_ID")" 1
  # (2) The broken health arm, FAIL #1: counted, NEVER paged — one FAIL pages nothing.
  probe FAIL PASS 'venues:2 of 5 up, below 3' '' "${DOWN3[@]}"
  ck 'fail 1: health token FAIL' "$(htok)" FAIL
  ck 'fail 1: exit 1 (the token maps to its code)' "$(cat "$st/run.rc")" 1
  ck 'fail 1: the count is 1' "$(state)" 1
  ck 'fail 1: ONE FAIL PAGES NOTHING' "$(sends "$ALERT_ID")" 0
  ck 'fail 1: a FAIL never clears' "$(clears "$ALERT_ID")" 1
  # (3) FAIL #2: the second consecutive FAIL pages, with entity nouns and the template wave id.
  probe FAIL PASS 'venues:2 of 5 up, below 3' '' "${DOWN3[@]}"
  ck 'fail 2: the count is 2' "$(state)" 2
  ck 'fail 2: THE SECOND FAIL PAGES' "$(sends "$ALERT_ID")" 1
  has 'the page goes to pre_trade_check_degraded, CRITICAL_PERSISTENT, body on stdin' "$(cat "$st/sent")" 'ARGV pre_trade_check_degraded CRITICAL_PERSISTENT -'
  has 'the body counts the consecutive runs' "$(cat "$st/sent")" 'FAILed 2 consecutive hourly runs (pages at 2)'
  has 'the body names the failed check with its entity noun' "$(cat "$st/sent")" '- check venues — 2 of 5 up, below 3'
  has 'the body names each DOWN venue with its entity noun' "$(cat "$st/sent")" '- venue OKX — feed_unavailable'
  has 'the body names a funding outage too' "$(cat "$st/sent")" '- venue BYBIT — funding_unavailable'
  hasnt 'the body never lists an UP venue' "$(cat "$st/sent")" '- venue BITGET'
  has 'the body carries the wall time' "$(cat "$st/sent")" 'wall 1234 ms'
  has 'the body carries the template wave id, never a hardcoded one' "$(cat "$st/sent")" 'Recommended wave: DECISION-CALL-V1-W{NEXT}'
  has 'a FAIL keeps its full probe output in .last-fail' "$(cat "$st/log.last-fail" 2>/dev/null)" '[pre-trade-health] VENUE {"exchange":"OKX","excluded":"feed_unavailable","state":"DOWN"}'
  has 'the newest run is always in .last' "$(cat "$st/log.last" 2>/dev/null)" 'PRE_TRADE_HEALTH_VERDICT=FAIL'
  ck 'the log itself never takes the probe output (one summary line per run)' "$(grep -c '\[pre-trade-health\] VENUE' "$st/log" | tr -d ' ')" 0
  # (4) FAIL #3 pages again — repetition is the WRAPPER's cooldown, not this file's.
  probe FAIL PASS 'call:threw TypeError' '' "${UP5[@]}"
  ck 'fail 3: the count is 3' "$(state)" 3
  ck 'fail 3: pages again (the wrapper dedups)' "$(sends "$ALERT_ID")" 2
  has 'a throw is named as a failed check' "$(cat "$st/sent")" '- check call — threw TypeError'
  # (5) PASS resets the sustain and clears.
  probe PASS PASS '' '' "${UP5[@]}"
  ck 'reset: the count is back to 0' "$(state)" 0
  ck 'reset: PASS clears' "$(clears "$ALERT_ID")" 2
  # (6) INDETERMINATE from the probe (an unreachable database): the count untouched, no page, no clear, exit 3.
  printf '1\n' > "$st/state/consecutive-fails"
  probe INDETERMINATE PASS '' ''
  ck 'probe INDETERMINATE: token INDETERMINATE' "$(htok)" INDETERMINATE
  ck 'probe INDETERMINATE: exit 3' "$(cat "$st/run.rc")" 3
  ck 'probe INDETERMINATE: the count untouched' "$(state)" 1
  ck 'probe INDETERMINATE: no page' "$(sends "$ALERT_ID")" 2
  ck 'probe INDETERMINATE: no clear' "$(clears "$ALERT_ID")" 2
  hasnt 'a non-FAIL run never overwrites .last-fail' "$(cat "$st/log.last-fail" 2>/dev/null)" 'PRE_TRADE_HEALTH_VERDICT=INDETERMINATE'
  # (7) No health token (a watchdog kill): INDETERMINATE, the count untouched — and the fee arm still acts.
  probe '' PASS '' ''
  ck 'no health token: INDETERMINATE' "$(htok)" INDETERMINATE
  ck 'no health token: the count untouched' "$(state)" 1
  ck 'no health token: the fee arm still clears' "$(clears "$FEE_ALERT_ID")" 7
  # (8) A stopped container: both INDETERMINATE, exit 3, the count untouched, nothing pages or clears.
  touch "$st/stopped"; probe PASS PASS '' '' "${UP5[@]}"; rm -f "$st/stopped"
  ck 'stopped container: health INDETERMINATE' "$(htok)" INDETERMINATE
  ck 'stopped container: fee INDETERMINATE' "$(ftok)" INDETERMINATE
  ck 'stopped container: exit 3' "$(cat "$st/run.rc")" 3
  ck 'stopped container: the count untouched' "$(state)" 1
  ck 'stopped container: nothing cleared' "$(clears "$FEE_ALERT_ID")" 7
  # (9) The broken fee arm: the FIRST FAIL pages, naming the venue, its date and its source URL.
  probe PASS FAIL '' BYBIT "${UP5[@]}"
  ck 'fee fail: fee token FAIL' "$(ftok)" FAIL
  ck 'fee fail: exit 1' "$(cat "$st/run.rc")" 1
  ck 'fee fail: THE FIRST FEE FAIL PAGES' "$(sends "$FEE_ALERT_ID")" 1
  has 'the fee page goes to venue_fee_table_stale, CRITICAL_PERSISTENT, body on stdin' "$(cat "$st/sent")" 'ARGV venue_fee_table_stale CRITICAL_PERSISTENT -'
  has 'the fee body names the venue, its date and its source URL' "$(cat "$st/sent")" '- venue BYBIT — verified 2026-07-28 (95 days), source https://fees.example/BYBIT'
  has 'the fee body counts rows and states the limit from the probe' "$(cat "$st/sent")" 'has 1 row past the 90-day verification limit'
  hasnt 'the fee body never lists a fresh row' "$(cat "$st/sent")" '- venue BINANCE — verified'
  has 'the fee body carries its template wave id' "$(cat "$st/sent")" 'Recommended wave: VENUE-FEES-REVERIFY-W{NEXT}'
  ck 'fee fail: the health arm is independent (PASS resets the count)' "$(state)" 0
  # (10) Fee PASS clears; a missing fee token does nothing.
  probe PASS PASS '' '' "${UP5[@]}"
  ck 'fee pass: clears' "$(clears "$FEE_ALERT_ID")" 8
  probe PASS '' '' '' "${UP5[@]}"
  ck 'no fee token: INDETERMINATE' "$(ftok)" INDETERMINATE
  ck 'no fee token: no fee clear' "$(clears "$FEE_ALERT_ID")" 8
  ck 'no fee token: no fee page' "$(sends "$FEE_ALERT_ID")" 1
  ck 'no fee token: exit 3' "$(cat "$st/run.rc")" 3
  # (11) Database down + a stale fee table: the fee page still fires, the count untouched, exit 1.
  printf '1\n' > "$st/state/consecutive-fails"
  probe INDETERMINATE FAIL '' BINANCE
  ck 'db down + stale fees: fee page fires anyway' "$(sends "$FEE_ALERT_ID")" 2
  ck 'db down + stale fees: the count untouched' "$(state)" 1
  ck 'db down + stale fees: exit 1 (a FAIL wins the code)' "$(cat "$st/run.rc")" 1
  # (12) A count that cannot be read restarts at 1: never a page from ONE FAIL, never dark.
  printf 'garbage\n' > "$st/state/consecutive-fails"
  probe FAIL PASS 'decision:missing' '' "${UP5[@]}"
  ck 'unreadable count + FAIL: restarts at 1' "$(state)" 1
  ck 'unreadable count + FAIL: no page' "$(sends "$ALERT_ID")" 2
  has 'unreadable count: logged' "$(cat "$st/log")" 'STATE_UNREADABLE'
  probe FAIL PASS 'decision:missing' '' "${UP5[@]}"
  ck 'unreadable count, next FAIL: pages (the sustain resumes)' "$(sends "$ALERT_ID")" 3
  # (13) Every exit path publishes a record — through the REAL canary_result_log when it is beside this file.
  if [ -r "$here/canary_result_log.py" ]; then
    mkdir -p "$st/lib"; cp "$here/canary_result_log.py" "$st/lib/"
    RESULT_DIR_UNDER_TEST="$st/lib" probe PASS PASS '' '' "${UP5[@]}"
    has 'a PASS run appends one result record' "$(cat "$st/run.out")" 'CANARY_RESULT_LOG=line='
    local rec; rec="$(tail -1 "$st/results.jsonl" 2>/dev/null || true)"
    has 'the record names this canary' "$rec" '"pre-trade-health"'
    has 'the record carries the wall time' "$rec" '"wall_ms":1234'
    has 'the record counts venues by state' "$rec" '"venue_states":{"UP":5}'
    has 'the record carries both verdicts' "$rec" '"fees":"PASS","health":"PASS"'
    RESULT_DIR_UNDER_TEST="$st/lib" probe FAIL PASS 'venues:2 of 5 up, below 3' '' "${DOWN3[@]}"
    has 'a FAIL record names the down venues' "$(tail -1 "$st/results.jsonl" 2>/dev/null)" '"down":["BINANCE:feed_unavailable","BYBIT:funding_unavailable","OKX:feed_unavailable"]'
    touch "$st/stopped"; RESULT_DIR_UNDER_TEST="$st/lib" probe PASS PASS '' ''; rm -f "$st/stopped"
    has 'an INDETERMINATE run also publishes' "$(tail -1 "$st/results.jsonl" 2>/dev/null)" '"INDETERMINATE"'
  else
    has 'canary_result_log.py sits beside this script' "missing" "present"
  fi
  # (14) Cooldown is the WRAPPER's: two paging FAIL runs reach the real send_telegram.sh (sandboxed,
  #      DRY_RUN); the second is suppressed inside 24h, and a PASS clears through it.
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
    printf '1\n' > "$st/state/consecutive-fails"
    for i in 1 2; do SEND_UNDER_TEST="$st/send-real" probe FAIL PASS 'venues:2 of 5 up, below 3' '' "${DOWN3[@]}"; done
    has 'run 1: the real wrapper fired (dry run, sandboxed)' "$(cat "$st/tg/log" 2>/dev/null)" 'DRY_RUN_FIRED'
    has 'run 2: the real wrapper suppressed it on its 24h cooldown' "$(cat "$st/tg/log" 2>/dev/null)" 'SUPPRESSED_COOLDOWN'
    SEND_UNDER_TEST="$st/send-real" probe PASS PASS '' '' "${UP5[@]}"
    ck 'a PASS after the fires exits 0 through the real wrapper' "$(cat "$st/run.rc")" 0
  else
    has 'send_telegram.sh sits beside this script' "missing" "present"
  fi

  # Vacuity guard: a self-test that asserted nothing must never report a pass.
  if [ "$checked" -lt 79 ]; then
    echo "SELF_TEST_VERDICT=INDETERMINATE — only $checked assertions ran (expected >= 79)"; return 3
  fi
  if [ -n "$fails" ]; then
    echo "SELF_TEST_VERDICT=FAIL — ${fails#|}"; return 1
  fi
  echo "SELF_TEST_VERDICT=PASS — $checked assertions (pass + clears · health FAIL 1 silent, FAIL 2 pages + body · repeat · reset · INDETERMINATE per probe, per token and per run · fee FAIL pages first time + body · fee clear · db-down fee page · unreadable count restarts · result record · wrapper cooldown + clear)"
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  self_test; exit $?
fi
run_canary
