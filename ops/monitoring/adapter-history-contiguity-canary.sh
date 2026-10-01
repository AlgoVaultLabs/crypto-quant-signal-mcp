#!/usr/bin/env bash
# ops/monitoring/adapter-history-contiguity-canary.sh — OPS-ADAPTER-HISTORY-ANCHOR-W1 CH3.
#
# The LIVE half of the adapter history contract. tests/unit/adapter-history-contract.test.ts guards the CODE on
# captured fixtures; only a live probe guards the VENUES (WEEX changed its served interval on 2026-09-03 with
# nothing watching). This wrapper runs `dist/scripts/adapter-history-contiguity.js` INSIDE the app container —
# through the adapters, metered by _upstream-fetch.ts, batch class, caller tag `adapter-history-canary` — and
# hands it the expectations from the DEPLOYED checkout's fixtures (REACH.json + UNSERVABLE.json): one copy of
# the expectations, travelling with the code that is judged against them.
#
# ── VERDICT ───────────────────────────────────────────────────────────────────────────────────
# Exactly one terminal `ADAPTER_HISTORY_VERDICT=PASS|FAIL|INDETERMINATE` (exit 0 / 1 / 3). Read the TOKEN,
# never the code. The script's own token is the source; a run with no token, an unreadable expectation set or
# a stopped container is INDETERMINATE — and still publishes a record, never silence.
#
# ── STREAKS AND THE PAGE (architect ruling OAH-Q10) ───────────────────────────────────────────
# One streak file per pair in $STREAK_DIR (`<VENUE>-<tf>`, holding the consecutive FAIL count).
#   FAIL          → +1            PASS / SKIPPED → reset (file removed)
#   INDETERMINATE → unchanged     (a venue we could not read never advances AND never resets a streak)
# A pair that FAILs this run with a streak ≥ PAGE_AFTER (3) pages ADAPTER_HISTORY_GAP through send_telegram.sh,
# CRITICAL_PERSISTENT. Repetition is governed by the wrapper's 24h cooldown, not here: night 4 calls it again
# and the wrapper suppresses. announce_resolution is FALSE (alert-registry.json): a cleared streak is silent.
#
# ── PUBLISHED, SO THE VAULT CAN READ IT ──────────────────────────────────────────────────────
# Every run appends ONE canary_result_log record (canary `adapter-history-contiguity`): the verdict, pair
# counts, the failing / indeterminate / skipped pair names, the open streaks and the substitutedNewest count.
# Identifiers and counts only. ops/scripts/monitoring-results-sync.sh pulls it into the vault.
#
# ── SCHEDULE: 24 10 * * * (signal-1) ─────────────────────────────────────────────────────────
# Daytime, outside 02:20–06:30Z (labeler + relabel) and 18:30–02:15Z; minute 24 of hour 10 checked clear
# against the live crontab at install. Safe-to-kill (cron-interlock-registry.json): read-only, re-derives its
# verdict on the next fire; a killed run is INDETERMINATE-equivalent (no token → streaks untouched).
#
# Usage: adapter-history-contiguity-canary.sh            # the canary (cron)
#        adapter-history-contiguity-canary.sh --self-test # hermetic, two-way, vacuity-guarded
set -uo pipefail

REPO="${ADAPTER_HISTORY_REPO:-/opt/crypto-quant-signal-mcp}"
CTR="${ADAPTER_HISTORY_APP_CTR:-crypto-quant-signal-mcp-mcp-server-1}"
SEND="${ADAPTER_HISTORY_SEND:-/opt/algovault-monitoring/send_telegram.sh}"
LOG="${ADAPTER_HISTORY_LOG:-/var/log/adapter-history-contiguity.log}"
STREAK_DIR="${ADAPTER_HISTORY_STREAK_DIR:-/var/lib/algovault-monitoring/adapter-history-streak}"
RESULT_LOG_DIR="${ADAPTER_HISTORY_RESULT_LOG_DIR:-/opt/algovault-monitoring}"
DOCKER="${ADAPTER_HISTORY_DOCKER:-docker}"   # the self-test's seam; unset in production
PAGE_AFTER=3
ALERT_ID="ADAPTER_HISTORY_GAP"
CANARY="adapter-history-contiguity"
TAG="[adapter-history-canary]"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $TAG $*" >> "$LOG" 2>/dev/null || true; }

# The expectation set, built from the deployed checkout's pinned fixtures. Prints the JSON or fails.
expectations() { # repo
  python3 - "$1" <<'PYEXP'
import json, sys, os
fx = os.path.join(sys.argv[1], "tests/fixtures/adapter-history")
reach = json.load(open(os.path.join(fx, "REACH.json")))["pairs"]
unserv = json.load(open(os.path.join(fx, "UNSERVABLE.json")))["pairs"]
if not isinstance(reach, dict) or not reach or not isinstance(unserv, list):
    raise SystemExit("expectations: REACH.json pairs empty or malformed")
print(json.dumps({"reach": reach, "unservable": unserv}))
PYEXP
}

# Streak update + page decision + result metrics, from the script's output. Pure over (output, streak dir).
# Prints: `PAGE <pair> <streak> <reasons>` lines for pairs to page, then one `METRICS <json>` line.
judge_streaks() { # output_file streak_dir page_after
  python3 - "$1" "$2" "$3" <<'PYSTREAK'
import json, os, sys
out_file, sdir, page_after = sys.argv[1], sys.argv[2], int(sys.argv[3])
pairs = []
for line in open(out_file, encoding="utf-8", errors="replace"):
    i = line.find("[adapter-history] PAIR ")
    if i < 0:
        continue
    try:
        pairs.append(json.loads(line[i + len("[adapter-history] PAIR "):]))
    except Exception:
        pass
os.makedirs(sdir, exist_ok=True)
def path(p): return os.path.join(sdir, f"{p['venue']}-{p['tf']}")
def read(p):
    try: return int(open(path(p)).read().strip() or 0)
    except Exception: return 0
pages, open_streaks = [], {}
for p in pairs:
    v, name = p.get("verdict"), f"{p.get('venue')}/{p.get('tf')}"
    if v == "FAIL":
        n = read(p) + 1
        open(path(p), "w").write(f"{n}\n")
        if n >= page_after:
            pages.append((name, n, "; ".join(p.get("reasons") or [])[:300]))
    elif v in ("PASS", "SKIPPED"):
        try: os.remove(path(p))
        except FileNotFoundError: pass
    # INDETERMINATE: never advances, never resets.
for f in sorted(os.listdir(sdir)):
    try: open_streaks[f] = int(open(os.path.join(sdir, f)).read().strip() or 0)
    except Exception: pass
for name, n, why in pages:
    print(f"PAGE {name} {n} {why}")
by = lambda v: sorted(f"{p.get('venue')}/{p.get('tf')}" for p in pairs if p.get("verdict") == v)
metrics = {
    "pairs": len(pairs), "pass": len(by("PASS")), "fail": len(by("FAIL")),
    "indeterminate": len(by("INDETERMINATE")), "skipped": len(by("SKIPPED")),
    "failing": by("FAIL"), "indeterminate_pairs": by("INDETERMINATE"), "skipped_pairs": by("SKIPPED"),
    "open_streaks": open_streaks, "paged": [n for n, _, _ in pages],
    "substituted_newest": sum(int(p.get("substitutedNewest") or 0) for p in pairs),
}
print("METRICS " + json.dumps(metrics, sort_keys=True))
PYSTREAK
}

# The page body. Every pair is named WITH its entity noun (a bare `BITGET/2h (3)` reads as a quantity).
page_body() { # pages_file
  local n
  n="$(wc -l < "$1" | tr -d ' ')"
  printf '🛑 %s\n' "$ALERT_ID"
  printf 'Adapter history drift: %s %s FAILed %s or more consecutive nightly runs of the live canary.\n' \
    "$n" "$( [ "$n" = 1 ] && echo pair || echo pairs )" "$PAGE_AFTER"
  while read -r _ pair streak why; do
    printf -- '- pair %s — %s consecutive FAIL runs — %s\n' "$pair" "$streak" "$why"
  done < "$1"
  printf 'A venue changed what it serves (front gap, holes, head gap, off-grid or out-of-range bars) against the\n'
  printf 'class pinned in tests/fixtures/adapter-history/REACH.json, or a Bitget/OKX history window lost its\n'
  printf 'completeness or its meta. Re-capture and compare before changing the pin; never absorb it.\n'
  printf 'Log: %s · result: canary-results.jsonl (%s)\n' "$LOG" "$CANARY"
  printf 'Recommended wave: OPS-ADAPTER-HISTORY-ANCHOR-W{NEXT}\n'
}

publish() { # verdict exit_code metrics_json
  python3 - "$RESULT_LOG_DIR" "$CANARY" "$1" "$2" "$3" <<'PYREC' 2>/dev/null || echo "$TAG CANARY_RESULT_LOG_FAILED=python_unavailable"
import json, sys
sys.path.insert(0, sys.argv[1])
try:
    from canary_result_log import append_result
except Exception as e:
    print(f"[adapter-history-canary] CANARY_RESULT_LOG_FAILED=import:{type(e).__name__}")
    raise SystemExit(0)
try:
    metrics = json.loads(sys.argv[5]) if sys.argv[5] else {}
    if not isinstance(metrics, dict):
        metrics = {"metrics_unparseable": True}
except Exception:
    metrics = {"metrics_unparseable": True}
ok, detail = append_result(sys.argv[2], sys.argv[3], int(sys.argv[4]), metrics)
print(f"[adapter-history-canary] CANARY_RESULT_LOG={detail}" if ok else f"[adapter-history-canary] CANARY_RESULT_LOG_FAILED={detail}")
PYREC
}

finish() { # verdict detail exit_code [metrics_json]
  log "$1 $2"
  publish "$1" "$3" "${4:-}"
  echo "$TAG $(date -u +%Y-%m-%dT%H:%M:%SZ) ADAPTER_HISTORY_VERDICT=$1 $2"
  exit "$3"
}

run_canary() {
  local out rc verdict pages metrics tmp
  AHC_TMP="$(mktemp -d 2>/dev/null || echo "/tmp/ahc.$$")"; mkdir -p "$AHC_TMP"; tmp="$AHC_TMP"
  trap 'rm -rf "$AHC_TMP"' EXIT

  if ! expectations "$REPO" > "$tmp/expect.json" 2>"$tmp/expect.err"; then
    finish INDETERMINATE "expectations unreadable from $REPO: $(head -c 200 "$tmp/expect.err" | tr '\n' ' ')" 3
  fi
  if ! "$DOCKER" inspect -f '{{.State.Running}}' "$CTR" 2>/dev/null | grep -q true; then
    finish INDETERMINATE "container $CTR is not running — nothing was probed" 3
  fi

  "$DOCKER" exec -i "$CTR" node dist/scripts/adapter-history-contiguity.js --expect - < "$tmp/expect.json" > "$tmp/out" 2>&1
  rc=$?
  cat "$tmp/out" >> "$LOG" 2>/dev/null || true
  out="$tmp/out"

  verdict="$(grep -o 'ADAPTER_HISTORY_VERDICT=[A-Z]*' "$out" | tail -1 | cut -d= -f2)"
  case "$verdict" in
    PASS|FAIL|INDETERMINATE) ;;
    *) finish INDETERMINATE "no verdict token in the script output (rc=$rc); streaks untouched" 3 ;;
  esac

  judge_streaks "$out" "$STREAK_DIR" "$PAGE_AFTER" > "$tmp/judged" 2>"$tmp/judged.err" \
    || finish INDETERMINATE "streak update failed: $(head -c 200 "$tmp/judged.err" | tr '\n' ' ') (script verdict $verdict)" 3
  grep '^PAGE ' "$tmp/judged" > "$tmp/pages" || true
  metrics="$(sed -n 's/^METRICS //p' "$tmp/judged" | tail -1)"
  pages="$(wc -l < "$tmp/pages" | tr -d ' ')"

  if [ "${pages:-0}" -gt 0 ]; then
    if [ -x "$SEND" ]; then
      page_body "$tmp/pages" | "$SEND" "$ALERT_ID" CRITICAL_PERSISTENT - 2>>"$LOG" || log "ESCALATE_UNSENT: send_telegram invocation failed"
    else
      log "ESCALATE_UNSENT: $SEND not executable"
    fi
  fi

  case "$verdict" in
    PASS) finish PASS "script rc=$rc pages=$pages" 0 "$metrics" ;;
    FAIL) finish FAIL "script rc=$rc pages=$pages" 1 "$metrics" ;;
    *)    finish INDETERMINATE "script rc=$rc pages=$pages (fail-open: streaks of unread pairs untouched)" 3 "$metrics" ;;
  esac
}

# ── two-way self-test, vacuity-guarded ─────────────────────────────────────────────────────────
self_test() {
  local me st checked=0 fails="" here real_send
  me="$0"; here="$(cd "$(dirname "$0")" && pwd)"
  AHC_ST="$(mktemp -d 2>/dev/null || echo "/tmp/ahc-st.$$")"; mkdir -p "$AHC_ST"; st="$AHC_ST"
  trap 'rm -rf "$AHC_ST"' EXIT
  ck() { checked=$((checked + 1)); if [ "$2" = "$3" ]; then echo "SELF-TEST: ok   $1"; else echo "SELF-TEST: FAIL $1 (got '$2', want '$3')"; fails="$fails|$1"; fi; }
  has() { checked=$((checked + 1)); if grep -qF -- "$3" <<<"$2"; then echo "SELF-TEST: ok   $1"; else echo "SELF-TEST: FAIL $1 (missing '$3')"; fails="$fails|$1"; fi; }

  # A fixture checkout carrying the two expectation files.
  mkdir -p "$st/repo/tests/fixtures/adapter-history"
  printf '{"pairs":{"BITGET/2h":{"R":{}}}}\n' > "$st/repo/tests/fixtures/adapter-history/REACH.json"
  printf '{"pairs":[{"pair":"OKX/8h"}]}\n' > "$st/repo/tests/fixtures/adapter-history/UNSERVABLE.json"
  # A fake docker: `inspect` answers running unless $st/stopped exists; `exec` prints $st/script.out after
  # recording its stdin (the expectations it was handed).
  cat > "$st/docker" <<EOF
#!/usr/bin/env bash
case "\$1" in
  inspect) [ -f "$st/stopped" ] && echo false || echo true ;;
  exec) cat > "$st/stdin.json"; cat "$st/script.out"; exit \$(cat "$st/script.rc" 2>/dev/null || echo 0) ;;
esac
EOF
  # A recording wrapper: argv + body, one record per call.
  cat > "$st/send" <<EOF
#!/usr/bin/env bash
printf 'ARGV %s\n' "\$*" >> "$st/sent"; cat >> "$st/sent"; printf 'END\n' >> "$st/sent"
EOF
  chmod +x "$st/docker" "$st/send"
  pair() { printf '[adapter-history] PAIR {"venue":"%s","tf":"%s","verdict":"%s","reasons":["%s"],"substitutedNewest":%s}\n' "$1" "$2" "$3" "${4:-}" "${5:-0}"; }
  night() { # <token> [pair lines...]
    local tok="$1"; shift
    { for l in "$@"; do printf '%s\n' "$l"; done; [ -n "$tok" ] && printf '[adapter-history] ADAPTER_HISTORY_VERDICT=%s\n' "$tok"; } > "$st/script.out"
    ADAPTER_HISTORY_REPO="$st/repo" ADAPTER_HISTORY_DOCKER="$st/docker" ADAPTER_HISTORY_SEND="${SEND_UNDER_TEST:-$st/send}" \
      ADAPTER_HISTORY_LOG="$st/log" ADAPTER_HISTORY_STREAK_DIR="$st/streak" ADAPTER_HISTORY_RESULT_LOG_DIR="$st/nolib" \
      bash "$me" > "$st/run.out" 2>&1
    echo $? > "$st/run.rc"
  }
  tok() { grep -o 'ADAPTER_HISTORY_VERDICT=[A-Z]*' "$st/run.out" | tail -1 | cut -d= -f2; }
  streak() { cat "$st/streak/$1" 2>/dev/null | tr -d '\n' || true; }
  sends() { grep -c '^ARGV ' "$st/sent" 2>/dev/null || echo 0; }

  F='C1: the deep history window is incomplete (pinned complete)'
  # (1) PASS: no streak, no send, exit 0, expectations handed over.
  night PASS "$(pair BITGET 2h PASS)" "$(pair OKX 8h SKIPPED)"
  ck 'PASS night: token PASS' "$(tok)" PASS
  ck 'PASS night: exit 0' "$(cat "$st/run.rc")" 0
  ck 'PASS night: no streak file' "$(streak BITGET-2h)" ''
  ck 'PASS night: no page' "$(sends)" 0
  has 'the script was handed the REACH expectations on stdin' "$(cat "$st/stdin.json")" '"BITGET/2h"'
  has 'and the UNSERVABLE declarations' "$(cat "$st/stdin.json")" '"OKX/8h"'
  # (2)(3) FAIL nights 1 and 2: the streak grows, nothing pages.
  night FAIL "$(pair BITGET 2h FAIL "$F")" "$(pair OKX 1h PASS)"
  ck 'FAIL night 1: token FAIL' "$(tok)" FAIL
  ck 'FAIL night 1: exit 1' "$(cat "$st/run.rc")" 1
  ck 'FAIL night 1: streak 1' "$(streak BITGET-2h)" 1
  ck 'FAIL night 1: no page' "$(sends)" 0
  night FAIL "$(pair BITGET 2h FAIL "$F")"
  ck 'FAIL night 2: streak 2' "$(streak BITGET-2h)" 2
  ck 'FAIL night 2: no page' "$(sends)" 0
  # (4) INDETERMINATE for that pair: never advances, never resets.
  night INDETERMINATE "$(pair BITGET 2h INDETERMINATE 'recent: UpstreamRateLimitError')"
  ck 'IND night: token INDETERMINATE' "$(tok)" INDETERMINATE
  ck 'IND night: exit 3' "$(cat "$st/run.rc")" 3
  ck 'IND night: streak unchanged at 2' "$(streak BITGET-2h)" 2
  ck 'IND night: no page' "$(sends)" 0
  # (5) FAIL night 3: pages once, CRITICAL_PERSISTENT, through the wrapper, with the entity noun.
  night FAIL "$(pair BITGET 2h FAIL "$F")"
  ck 'FAIL night 3: streak 3' "$(streak BITGET-2h)" 3
  ck 'FAIL night 3: exit 1 (the token maps to its code)' "$(cat "$st/run.rc")" 1
  ck 'FAIL night 3: one page' "$(sends)" 1
  has 'the page goes to ADAPTER_HISTORY_GAP, CRITICAL_PERSISTENT, body on stdin' "$(cat "$st/sent")" 'ARGV ADAPTER_HISTORY_GAP CRITICAL_PERSISTENT -'
  has 'the body names the pair with its entity noun' "$(cat "$st/sent")" '- pair BITGET/2h — 3 consecutive FAIL runs — C1:'
  has 'the body counts pairs as pairs' "$(cat "$st/sent")" 'Adapter history drift: 1 pair FAILed 3 or more'
  has 'the body carries the template wave id, never a hardcoded one' "$(cat "$st/sent")" 'OPS-ADAPTER-HISTORY-ANCHOR-W{NEXT}'
  # (6) A PASS resets the streak; a pair that never FAILed is never paged.
  night PASS "$(pair BITGET 2h PASS)"
  ck 'PASS after FAIL: streak reset' "$(streak BITGET-2h)" ''
  ck 'PASS after FAIL: no new page' "$(sends)" 1
  night FAIL "$(pair BITGET 2h SKIPPED)" "$(pair OKX 1h FAIL "$F")"
  ck 'a SKIPPED pair resets nothing it never had, and a fresh FAIL starts at 1' "$(streak BITGET-2h)$(streak OKX-1h)" 1
  # (7) Whole-run INDETERMINATE: no token / stopped container / unreadable expectations — streaks untouched.
  night FAIL "$(pair XT 1h FAIL "$F")"
  night '' "$(pair XT 1h FAIL "$F")"
  ck 'no token: INDETERMINATE' "$(tok)" INDETERMINATE
  ck 'no token: the streak was NOT advanced' "$(streak XT-1h)" 1
  touch "$st/stopped"; night FAIL "$(pair XT 1h FAIL "$F")"; rm -f "$st/stopped"
  ck 'stopped container: INDETERMINATE' "$(tok)" INDETERMINATE
  ck 'stopped container: streak untouched' "$(streak XT-1h)" 1
  mv "$st/repo/tests/fixtures/adapter-history/REACH.json" "$st/reach.bak"; night FAIL "$(pair XT 1h FAIL "$F")"
  mv "$st/reach.bak" "$st/repo/tests/fixtures/adapter-history/REACH.json"
  ck 'unreadable expectations: INDETERMINATE' "$(tok)" INDETERMINATE
  ck 'unreadable expectations: exit 3' "$(cat "$st/run.rc")" 3
  ck 'unreadable expectations: streak untouched' "$(streak XT-1h)" 1
  # (8) Every exit path publishes a record — through the REAL canary_result_log when it is beside this file.
  if [ -r "$here/canary_result_log.py" ]; then
    mkdir -p "$st/lib"; cp "$here/canary_result_log.py" "$st/lib/"
    printf '[adapter-history] PAIR {"venue":"OKX","tf":"1h","verdict":"PASS","reasons":[],"substitutedNewest":1}\n[adapter-history] ADAPTER_HISTORY_VERDICT=PASS\n' > "$st/script.out"
    ADAPTER_HISTORY_REPO="$st/repo" ADAPTER_HISTORY_DOCKER="$st/docker" ADAPTER_HISTORY_SEND="$st/send" \
      ADAPTER_HISTORY_LOG="$st/log" ADAPTER_HISTORY_STREAK_DIR="$st/streak" ADAPTER_HISTORY_RESULT_LOG_DIR="$st/lib" \
      CANARY_RESULT_LOG_PATH="$st/results.jsonl" bash "$me" > "$st/run.out" 2>&1
    has 'a PASS run appends one result record' "$(cat "$st/run.out")" 'CANARY_RESULT_LOG=line='
    local rec; rec="$(tail -1 "$st/results.jsonl" 2>/dev/null || true)"
    has 'the record names this canary' "$rec" '"adapter-history-contiguity"'
    has 'the record counts substitutedNewest' "$rec" '"substituted_newest":1'
  else
    has 'canary_result_log.py sits beside this script' "missing" "present"
  fi
  # (9) Cooldown is the WRAPPER's: night 4 calls it again, and the real send_telegram.sh (sandboxed, DRY_RUN)
  # suppresses it inside 24h.
  real_send="$here/send_telegram.sh"
  if [ -x "$real_send" ] || [ -r "$real_send" ]; then
    mkdir -p "$st/tg"; printf 'TELEGRAM_BOT_TOKEN=selftest\nTELEGRAM_CHAT_ID=0\n' > "$st/tg/env"; printf '{"alerts":[]}\n' > "$st/tg/registry.json"; : > "$st/tg/status.md"
    cat > "$st/send-real" <<EOF
#!/usr/bin/env bash
ALERT_WRAPPER_LOG="$st/tg/log" ALERT_WRAPPER_STATE_DIR="$st/tg/state" ALERT_WRAPPER_ENV="$st/tg/env" \
ALERT_REGISTRY_PATH="$st/tg/registry.json" ALERT_WRAPPER_CURL=/bin/false STATUS_MD_PATH="$st/tg/status.md" \
DRY_RUN_TG=1 bash "$real_send" "\$@"
EOF
    chmod +x "$st/send-real"
    rm -rf "$st/streak"
    for i in 1 2 3 4; do SEND_UNDER_TEST="$st/send-real" night FAIL "$(pair BITGET 8h FAIL "$F")"; done
    ck 'night 4: streak 4' "$(streak BITGET-8h)" 4
    has 'night 3: the real wrapper fired (dry run, sandboxed)' "$(cat "$st/tg/log" 2>/dev/null)" 'DRY_RUN_FIRED'
    has 'night 4: the real wrapper suppressed it on its 24h cooldown' "$(cat "$st/tg/log" 2>/dev/null)" 'SUPPRESSED_COOLDOWN'
    ck 'the wrapper was reached on nights 3 and 4 only' "$(grep -cE 'DRY_RUN_FIRED|SUPPRESSED_COOLDOWN|FAILED_|SUPPRESSED_TEST_CONTEXT' "$st/tg/log" 2>/dev/null | tr -d ' ')" 2
    has 'the record carries the open streak by pair file' "$(tail -1 "$st/results.jsonl" 2>/dev/null)" '"open_streaks":{"XT-1h":1}'
  else
    has 'send_telegram.sh sits beside this script' "missing" "present"
  fi

  # Vacuity guard: a self-test that asserted nothing must never report a pass.
  if [ "$checked" -lt 40 ]; then
    echo "SELF_TEST_VERDICT=INDETERMINATE — only $checked assertions ran (expected >= 40)"; return 3
  fi
  if [ -n "$fails" ]; then
    echo "SELF_TEST_VERDICT=FAIL — ${fails#|}"; return 1
  fi
  echo "SELF_TEST_VERDICT=PASS — $checked assertions (PASS · FAIL streak 1-2-3 · INDETERMINATE per pair and per run · reset · page argv + body · result record · wrapper cooldown)"
  return 0
}

if [ "${1:-}" = "--self-test" ]; then
  self_test; exit $?
fi
run_canary
