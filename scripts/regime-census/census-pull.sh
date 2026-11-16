#!/usr/bin/env bash
# census-pull.sh — EDGE-REGIME-CENSUS-W1: the census's two READ-ONLY sessions against signal-1, in sr-pull.sh's form.
#
#   bash scripts/regime-census/census-pull.sh --out <dir>     # the pull (CH3, from the landed SHA)
#   bash scripts/regime-census/census-pull.sh --self-test     # hermetic, no host, no database
#
# Sessions (the statements are the generator's, src/scripts/regime-census/census-extract-sql.ts, never typed here):
#   pg   ssh → docker exec -i <postgres> psql -U aoe_readonly -At -q -v window_start=… -v window_end=…
#        one BEGIN READ ONLY, token line first; sections BOTKEY, REGIME, CHECKS
#   bot  ssh → sqlite3 -safe -readonly -bail 'file:<state.db>?immutable=1' (immutable: the only write-free open of a WAL
#        file with no side files — mode=ro refuses or needs -shm/-wal created; -safe: no .shell/.output/writefile, so
#        the CLI cannot write even if a future script asked it to). PRAGMA query_only, token line first; section WATCHES.
#        Preflight: the host's sqlite3 must be >= 3.37 (where -safe exists); older is INDETERMINATE, never a read
#        without -safe.
# Nothing is written on the host. The window is [end − 90 d, end), end = this pull's own UTC clock floored to the minute.
#
# Output in <dir> (refused inside the repository — the repo is public, the extracts are private):
#   botkey.csv regime.csv checks.csv watches.csv, session-pg.sql session-bot.sql, and pull.json with the sha256 of
#   every file and session script, the row counts, the window, the pull's UTC clock, the code SHA, whether that SHA
#   is landed (an ancestor of origin/main with the census code clean), whether the bot DB had a -wal at the read,
#   and the verdict.
# One terminal line: REGIME_CENSUS_PULL_VERDICT=PASS|FAIL|INDETERMINATE (exit 0 / 1 / 3). Callers gate on the TOKEN.
#   FAIL           a session's token line says it was not read-only
#   INDETERMINATE  no token, a session error, a missing/odd section, an empty REGIME extract (the corpus this pull
#                  constructs), a BOTKEY that is not one row, or code that is not landed. A header-only CHECKS or
#                  WATCHES is valid data (no checks, no regime watches), never vacuity.
set -uo pipefail

HOST='root@204.168.185.24'
KEY="$HOME/.ssh/algovault_deploy"
PG_CTR='crypto-quant-signal-mcp-postgres-1'
BOT_DB='/var/lib/algovault-bot/state.db'
PG_TOKEN='TOKEN current_user=aoe_readonly transaction_read_only=on'
BOT_TOKEN='TOKEN sqlite query_only=1'
SQLITE_MIN='3.37.0'
WINDOW_DAYS=90
GEN='src/scripts/regime-census/census-extract-sql.ts'
CODE_PATHS='src/scripts/regime-census scripts/regime-census'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[census-pull] $*" >&2; }
ind_exit() { log "$1"; echo 'REGIME_CENSUS_PULL_VERDICT=INDETERMINATE'; exit 3; }

# decide <pg-token> <bot-token> <regime> <others> <code> → the verdict line, returns its code.
#   tokens: ok|fail|ind   regime: ok|empty|ind   others: ok|ind   code: ok|ind
decide() {
  local pg="$1" bot="$2" regime="$3" others="$4" code="$5" red="" ind=""
  case "$pg" in ok) ;; fail) red="$red pg-token-not-read-only" ;; *) ind="$ind pg-token" ;; esac
  case "$bot" in ok) ;; fail) red="$red bot-token-not-query-only" ;; *) ind="$ind bot-token" ;; esac
  case "$regime" in ok) ;; empty) ind="$ind empty-regime-corpus" ;; *) ind="$ind regime-extract" ;; esac
  case "$others" in ok) ;; *) ind="$ind other-sections" ;; esac
  case "$code" in ok) ;; *) ind="$ind code-not-landed" ;; esac
  if [ -n "$red" ]; then log "FAIL:$red"; echo 'REGIME_CENSUS_PULL_VERDICT=FAIL'; return 1; fi
  if [ -n "$ind" ]; then log "cannot verify:$ind"; echo 'REGIME_CENSUS_PULL_VERDICT=INDETERMINATE'; return 3; fi
  echo 'REGIME_CENSUS_PULL_VERDICT=PASS'; return 0
}

# token_state <raw-file> <expected-token> → ok | fail | ind   (the FIRST line must be the token; empty file is ind)
token_state() {
  [ -s "$1" ] || { echo ind; return; }
  local first; first="$(head -n 1 "$1")"
  if [ "$first" = "$2" ]; then echo ok; return; fi
  case "$first" in TOKEN\ *) echo fail ;; *) echo ind ;; esac
}

# section <raw-file> <NAME> → the lines between ===NAME=== and the next ===…=== marker (or EOF)
section() {
  awk -v want="===$2===" '
    /^===[A-Z]+===$/ { on = ($0 == want); next }
    on { print }' "$1"
}

# files_state <header-csv> <file> → ok | empty | ind   (header must match exactly; a header-only file is empty)
files_state() {
  [ -s "$2" ] || { echo ind; return; }
  [ "$(head -n 1 "$2")" = "$1" ] || { echo ind; return; }
  [ "$(awk 'END { print NR }' "$2")" -ge 2 ] && echo ok || echo empty
}

# rows_of <file> → data rows (lines after the header)
rows_of() { local n; n="$(awk 'END { print NR }' "$1" 2>/dev/null)"; echo $(( ${n:-1} > 0 ? ${n:-1} - 1 : 0 )); }

# iso_of <epoch-seconds> → YYYY-MM-DDTHH:MM:SS.000Z (BSD date, then GNU date)
iso_of() {
  date -u -r "$1" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z
}

# window_bounds <now-epoch> → "<start-iso> <end-iso>": end floored to the minute, start = end − WINDOW_DAYS days
window_bounds() {
  local end=$(( $1 / 60 * 60 ))
  echo "$(iso_of $(( end - WINDOW_DAYS * 86400 ))) $(iso_of "$end")"
}

# header_of <headers-file> <NAME> → the registered header the generator prints for NAME
header_of() { awk -F= -v k="$2" '$1 == k { print substr($0, length(k) + 2); exit }' "$1"; }

# version_ge <a> <b> → 0 iff dotted version a >= b (numeric per field; an empty or non-numeric a is never >=)
version_ge() {
  case "$1" in '' | *[!0-9.]*) return 1 ;; esac
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, x, "."); nb = split(b, y, "."); n = (na > nb ? na : nb)
    for (i = 1; i <= n; i++) { xi = (i <= na ? x[i] + 0 : 0); yi = (i <= nb ? y[i] + 0 : 0)
      if (xi > yi) exit 0; if (xi < yi) exit 1 }
    exit 0 }'
}

# inside <path> <root> → 0 iff path is root or below it
inside() { case "$1/" in "$2/"*) return 0 ;; esac; return 1; }

sha() { shasum -a 256 "$1" | awk '{ print $1 }'; }
gen() { npx --no-install tsx "$GEN" "$@"; }

run_pull() {
  local out=""
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || ind_exit "$1 needs a value"
    case "$1" in
      --out) out="$2" ;;
      *) ind_exit "unknown argument $1" ;;
    esac
    shift 2
  done
  [ -n "$out" ] || ind_exit '--out is required'
  local t
  for t in ssh git awk shasum npx; do command -v "$t" >/dev/null 2>&1 || ind_exit "required tool '$t' not on PATH"; done
  local root; root="$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null)" || ind_exit 'not inside a checkout'
  cd "$root" || ind_exit "cannot cd to $root"
  mkdir -p "$out" || ind_exit "cannot create $out"
  local out_abs; out_abs="$(cd "$out" && pwd -P)"
  if inside "$out_abs" "$(pwd -P)"; then ind_exit "out-dir-inside-the-repository($out_abs)"; fi

  local head landed=false code='ind'
  head="$(git rev-parse HEAD)"
  git fetch origin --quiet 2>/dev/null || log 'git fetch failed — landed state judged on the local origin/main'
  # shellcheck disable=SC2086
  if git merge-base --is-ancestor "$head" origin/main 2>/dev/null && [ -z "$(git status --porcelain -- $CODE_PATHS)" ]; then
    landed=true; code='ok'
  fi
  log "code $head landed=$landed"

  local headers="$out_abs/headers.txt"
  gen --headers > "$headers" || ind_exit 'the generator failed (--headers)'
  local now ws we; now="$(date -u +%s)"; read -r ws we <<< "$(window_bounds "$now")"
  local pg_sql="$out_abs/session-pg.sql" bot_sql="$out_abs/session-bot.sql"
  gen --part pg > "$pg_sql" && [ -s "$pg_sql" ] || ind_exit 'the generator refused or printed nothing (pg)'
  gen --part bot > "$bot_sql" && [ -s "$bot_sql" ] || ind_exit 'the generator refused or printed nothing (bot)'
  local pull_at; pull_at="$(iso_of "$now")"
  log "window $ws → $we · pull_at $pull_at"

  local sqlite_v
  sqlite_v="$(ssh -o ConnectTimeout=20 -i "$KEY" "$HOST" 'sqlite3 --version' 2>/dev/null | awk 'NR == 1 { print $1 }')"
  version_ge "$sqlite_v" "$SQLITE_MIN" || ind_exit "host sqlite3 '${sqlite_v:-unreadable}' is older than $SQLITE_MIN: -safe is unavailable, and the bot read never runs without it"
  log "host sqlite3 $sqlite_v (>= $SQLITE_MIN, -safe available)"

  local pg_raw="$out_abs/session-pg.raw" bot_raw="$out_abs/session-bot.raw" bot_err="$out_abs/session-bot.err"
  ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -i "$KEY" "$HOST" \
    "docker exec -i $PG_CTR psql -U aoe_readonly -d signal_performance -At -q -v window_start=$ws -v window_end=$we" < "$pg_sql" > "$pg_raw"
  local rc_pg=$?
  ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -i "$KEY" "$HOST" \
    "{ test -e '$BOT_DB-wal' && echo bot_wal_present=1 || echo bot_wal_present=0; } >&2; sqlite3 -safe -readonly -bail 'file:$BOT_DB?immutable=1'" < "$bot_sql" > "$bot_raw" 2> "$bot_err"
  local rc_bot=$?
  local pg_tok bot_tok
  pg_tok="$(token_state "$pg_raw" "$PG_TOKEN")"
  bot_tok="$(token_state "$bot_raw" "$BOT_TOKEN")"
  [ "$rc_pg" -eq 0 ] || { log "pg session exit $rc_pg"; [ "$pg_tok" = fail ] || pg_tok='ind'; }
  [ "$rc_bot" -eq 0 ] || { log "bot session exit $rc_bot: $(grep -v '^bot_wal_present=' "$bot_err" | head -n 3)"; [ "$bot_tok" = fail ] || bot_tok='ind'; }
  local bot_wal; bot_wal="$(grep -o 'bot_wal_present=[01]' "$bot_err" | tail -n 1 | cut -d= -f2)"

  local regime_state='ind' others='ok' name f st rows meta="$out_abs/pull.json" files_json=''
  for name in BOTKEY REGIME CHECKS WATCHES; do
    f="$out_abs/$(printf '%s' "$name" | tr 'A-Z' 'a-z').csv"
    if [ "$name" = WATCHES ]; then section "$bot_raw" "$name" > "$f"; else section "$pg_raw" "$name" > "$f"; fi
    st="$(files_state "$(header_of "$headers" "$name")" "$f")"
    rows="$(rows_of "$f")"
    log "  $name: $rows rows — $st"
    case "$name" in
      REGIME) regime_state="$st" ;;
      BOTKEY) [ "$st" = ok ] && [ "$rows" -eq 1 ] || others='ind' ;;
      *) [ "$st" = ind ] && others='ind' ;;
    esac
    files_json="$files_json${files_json:+,}
    \"$(basename "$f")\": { \"sha256\": \"$(sha "$f")\", \"rows\": $rows }"
  done
  rm -f "$pg_raw" "$bot_raw" "$bot_err"

  local vline rc
  vline="$(decide "$pg_tok" "$bot_tok" "$regime_state" "$others" "$code")"; rc=$?
  {
    printf '{\n  "schema": "regime-census-pull-v1",\n  "wave": "EDGE-REGIME-CENSUS-W1",\n'
    printf '  "pull_at": "%s",\n  "pull_at_epoch": %s,\n' "$pull_at" "$now"
    printf '  "window_start": "%s",\n  "window_end": "%s",\n  "window_days": %s,\n' "$ws" "$we" "$WINDOW_DAYS"
    printf '  "code_sha": "%s",\n  "code_landed": %s,\n' "$head" "$landed"
    printf '  "session_pg_sql_sha256": "%s",\n  "session_bot_sql_sha256": "%s",\n' "$(sha "$pg_sql")" "$(sha "$bot_sql")"
    printf '  "pg_token": "%s",\n  "bot_token": "%s",\n  "bot_wal_present": %s,\n' "$pg_tok" "$bot_tok" "${bot_wal:-null}"
    printf '  "host_sqlite_version": "%s",\n' "$sqlite_v"
    printf '  "files": {%s\n  },\n' "$files_json"
    printf '  "pull_verdict": "%s"\n}\n' "${vline#REGIME_CENSUS_PULL_VERDICT=}"
  } > "$meta"
  rm -f "$headers"
  echo "$vline"
  return "$rc"
}

self_test() {
  local fails=0 cases=0 tmp
  check() { cases=$((cases + 1)); if [ "$2" != "$3" ]; then fails=$((fails + 1)); log "self-test FAIL: $1 — got '$2' want '$3'"; fi; }
  dv() { decide "$@" 2>/dev/null | tail -n 1; }
  # decide(): one meaning per verdict, a red beats a cannot-verify
  check 'all ok' "$(dv ok ok ok ok ok)" 'REGIME_CENSUS_PULL_VERDICT=PASS'
  check 'pg token fail' "$(dv fail ok ok ok ok)" 'REGIME_CENSUS_PULL_VERDICT=FAIL'
  check 'bot token fail' "$(dv ok fail ok ok ok)" 'REGIME_CENSUS_PULL_VERDICT=FAIL'
  check 'pg token ind' "$(dv ind ok ok ok ok)" 'REGIME_CENSUS_PULL_VERDICT=INDETERMINATE'
  check 'bot token ind' "$(dv ok ind ok ok ok)" 'REGIME_CENSUS_PULL_VERDICT=INDETERMINATE'
  check 'empty regime corpus is never PASS' "$(dv ok ok empty ok ok)" 'REGIME_CENSUS_PULL_VERDICT=INDETERMINATE'
  check 'regime ind' "$(dv ok ok ind ok ok)" 'REGIME_CENSUS_PULL_VERDICT=INDETERMINATE'
  check 'other sections ind' "$(dv ok ok ok ind ok)" 'REGIME_CENSUS_PULL_VERDICT=INDETERMINATE'
  check 'code not landed is never PASS' "$(dv ok ok ok ok ind)" 'REGIME_CENSUS_PULL_VERDICT=INDETERMINATE'
  check 'red beats ind' "$(dv fail ind empty ind ind)" 'REGIME_CENSUS_PULL_VERDICT=FAIL'
  decide ok ok ok ok ok >/dev/null 2>&1; check 'PASS exit' "$?" 0
  decide ok fail ok ok ok >/dev/null 2>&1; check 'FAIL exit' "$?" 1
  decide ok ok empty ok ok >/dev/null 2>&1; check 'INDETERMINATE exit' "$?" 3
  # the clock and the window: exactly WINDOW_DAYS, end floored to the minute
  check 'iso of the epoch' "$(iso_of 0)" '1970-01-01T00:00:00.000Z'
  check 'window floors to the minute and spans 90 d' "$(window_bounds $(( 7776000 + 59 )))" '1970-01-01T00:00:00.000Z 1970-04-01T00:00:00.000Z'
  # the out-dir refusal
  inside /a/repo/x /a/repo; check 'out inside the repo is refused' "$?" 0
  inside /a/repo /a/repo; check 'out at the repo root is refused' "$?" 0
  inside /a/repository-private /a/repo; check 'a sibling with the repo name as prefix is outside' "$?" 1
  # the -safe preflight: sqlite3 >= 3.37, field by field
  version_ge 3.45.1 "$SQLITE_MIN"; check 'host 3.45.1 has -safe' "$?" 0
  version_ge 3.37.0 "$SQLITE_MIN"; check '3.37.0 is the floor' "$?" 0
  version_ge 3.36.9 "$SQLITE_MIN"; check '3.36.9 lacks -safe' "$?" 1
  version_ge 3.100.0 "$SQLITE_MIN"; check 'numeric, not lexical' "$?" 0
  version_ge '' "$SQLITE_MIN"; check 'an unreadable version is never enough' "$?" 1
  # token_state() / section() / files_state() / header_of() on fixture sessions
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/census-pull-selftest.XXXXXX")" || { echo 'REGIME_CENSUS_PULL_SELFTEST_VERDICT=INDETERMINATE'; return 3; }
  printf '%s\n===BOTKEY===\nbot_keys,bot_rows\n2,10\n===REGIME===\nts,tool_name\n===CHECKS===\nchecked_at\n' "$PG_TOKEN" > "$tmp/good.raw"
  printf 'TOKEN current_user=algovault transaction_read_only=off\n===REGIME===\nts\n1\n' > "$tmp/writable.raw"
  printf '%s\n' "$BOT_TOKEN" > "$tmp/bot.raw"
  printf 'TOKEN sqlite query_only=0\n' > "$tmp/botw.raw"
  printf 'psql: error\n' > "$tmp/err.raw"
  : > "$tmp/none.raw"
  check 'pg token ok' "$(token_state "$tmp/good.raw" "$PG_TOKEN")" ok
  check 'token of a writable session' "$(token_state "$tmp/writable.raw" "$PG_TOKEN")" fail
  check 'bot token ok' "$(token_state "$tmp/bot.raw" "$BOT_TOKEN")" ok
  check 'bot token not query-only' "$(token_state "$tmp/botw.raw" "$BOT_TOKEN")" fail
  check 'no token line' "$(token_state "$tmp/err.raw" "$PG_TOKEN")" ind
  check 'empty session' "$(token_state "$tmp/none.raw" "$PG_TOKEN")" ind
  section "$tmp/good.raw" BOTKEY > "$tmp/bk.csv"; section "$tmp/good.raw" REGIME > "$tmp/rg.csv"; section "$tmp/good.raw" WATCHES > "$tmp/w.csv"
  check 'section body' "$(tr '\n' ';' < "$tmp/bk.csv")" 'bot_keys,bot_rows;2,10;'
  check 'rows present' "$(files_state 'bot_keys,bot_rows' "$tmp/bk.csv")" ok
  check 'one data row' "$(rows_of "$tmp/bk.csv")" 1
  check 'header only' "$(files_state 'ts,tool_name' "$tmp/rg.csv")" empty
  check 'wrong header' "$(files_state 'ts,caller' "$tmp/rg.csv")" ind
  check 'absent section' "$(files_state 'chat_n' "$tmp/w.csv")" ind
  printf 'BOTKEY=bot_keys,bot_rows\nREGIME=ts,tool_name\n' > "$tmp/h.txt"
  check 'header lookup' "$(header_of "$tmp/h.txt" REGIME)" 'ts,tool_name'
  check 'header lookup of an absent name' "$(header_of "$tmp/h.txt" WATCHES)" ''
  rm -rf "$tmp"
  local exp=37
  if [ "$cases" -lt "$exp" ]; then log "self-test ran $cases cases, floor $exp"; echo 'REGIME_CENSUS_PULL_SELFTEST_VERDICT=INDETERMINATE'; return 3; fi
  if [ "$fails" -gt 0 ]; then echo 'REGIME_CENSUS_PULL_SELFTEST_VERDICT=FAIL'; return 1; fi
  log "self-test: $cases cases"
  echo 'REGIME_CENSUS_PULL_SELFTEST_VERDICT=PASS'; return 0
}

# Sourceable: a `. census-pull.sh` defines the functions and runs nothing.
if (return 0 2>/dev/null); then return 0; fi

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  *) run_pull "$@"; exit $? ;;
esac
