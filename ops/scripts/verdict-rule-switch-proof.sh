#!/usr/bin/env bash
# verdict-rule-switch-proof.sh — SIGNAL-VERDICT-RULE-SWITCH-3m-W1 R4: the post-deploy proof that a committed
# verdict-rule switch (or switch-back) is what prod actually serves and stamps. Reusable for every later one.
#
# Runs from a repo checkout on the Mac, after the switch's deploy. ONE `BEGIN READ ONLY` transaction as
# `aoe_readonly` (ssh → docker exec -i <postgres> psql), the read-only token printed first. It reads FEATURE
# columns only — the served side, the stamp, the config id, the regime and the call-time capture. Never
# `outcome_return_pct` or any label table: the B-DIR holdout is sealed, and a proof about what was SERVED has no
# business reading how it turned out. The self-test asserts the emitted SQL names none of them.
#
# Since --since (epoch seconds; pass T_SWITCH = the new mcp-server container's StartedAt):
#   wrong_config     signals rows whose rule_config_id is not --expect (NULL included)       — every row
#   v1               rows stamped verdict_rule_version = 1 (never written again)             — signals + band_signals
#   v3_outside       signals rows stamped 3 that are NOT an F cell's decisive row served `verdict_f`
#   f_missed         F cells' decisive rows not stamped 3, or not served `verdict_f`
#   band_v3_outside  band_signals rows stamped 3 outside the F cells (band rows carry no decisive capture)
#   f_served         F cells' decisive rows stamped 3 and served `verdict_f` — the positive evidence
#   f_served_<tf>    the same, for ONE timeframe named by --switched: one COUNT per switched timeframe
# `f_served` is one total, so a timeframe already on F fills its floor while a newly switched one has no row yet; the
# per-timeframe counters are what prove the switch this run is about. Per-cell (tf × direction) f_served prints as
# CELL lines, evidence only: one direction can be absent for hours, and f_missed already covers both.
# The three cell counters join each (signal_hash, exchange)'s EARLIEST signals row (the gate's registered
# convention; ~0.1% of hashes are true double-writes) to its one signal_scorer_inputs row
# (uq_signal_scorer_inputs_hash_exchange). The cell is the scorer row's (timeframe, regime) — the call's own.
# A v3 row with no scorer row cannot be shown to be inside an F cell, so it counts as outside.
#
# Verdict — exactly one terminal line; callers gate on the TOKEN, never the exit code:
#   SWITCH_PROOF=PASS           exit 0   the first five are 0, f_served ≥ 30 and every f_served_<tf> ≥ 30
#   SWITCH_PROOF=FAIL           exit 1   any of the first five is non-zero (FAIL outranks every thin counter)
#   SWITCH_PROOF=INDETERMINATE  exit 3   f_served or an f_served_<tf> < 30, --switched missing or naming a timeframe
#                                        with no --f-cells cell, or the host, the query or its output could not be read
#
# Usage: ops/scripts/verdict-rule-switch-proof.sh --since <epoch> --expect <rule_config_id> --f-cells <tf:REGIME,...|none> \
#          --switched <tf,...|none>
#        ops/scripts/verdict-rule-switch-proof.sh --self-test
#   e.g. --f-cells 3m:TRENDING_UP,3m:TRENDING_DOWN,30m:TRENDING_UP,30m:TRENDING_DOWN --switched 30m
#   --f-cells names EVERY cell on F (a cell left out counts its stamp-3 rows as v3_outside); --switched names only the
#   timeframes this deploy moved to F. A run that moved none to F passes --switched none.
# A switch-BACK to all-M passes --f-cells none --switched none: then every v3 row is outside and f_served cannot reach
# the floor, so a switch-back proves itself on the first four counters and reads INDETERMINATE by construction (stated,
# not hidden).
set -uo pipefail

RO_TOKEN='TOKEN current_user=aoe_readonly transaction_read_only=on'
HOST='root@204.168.185.24'
KEY="$HOME/.ssh/algovault_deploy"
PG_CTR='crypto-quant-signal-mcp-postgres-1'
F_SERVED_FLOOR=30
COUNTERS=(rows keys unjoined wrong_config v1 v3_outside f_missed band_rows band_v3_outside f_served)
STRICT=(wrong_config v1 v3_outside f_missed band_v3_outside)

# cells_array <tf:REGIME,...|none> → a SQL ARRAY literal of 'tf:REGIME' keys, or returns 1 on any malformed cell.
# Strict whitelist: the value is spliced into SQL, so nothing but a timeframe and a trend regime gets through.
cells_array() {
  local spec="$1" c out='' parts=()
  if [ "$spec" = none ]; then echo "ARRAY[]::text[]"; return 0; fi
  IFS=',' read -r -a parts <<< "$spec"
  [ "${#parts[@]}" -gt 0 ] || return 1
  for c in "${parts[@]}"; do
    [[ "$c" =~ ^[0-9]{1,2}[mhd]:TRENDING_(UP|DOWN)$ ]] || return 1
    out="${out:+$out,}'$c'"
  done
  echo "ARRAY[$out]::text[]"
}

# switched_tfs <tf,...|none> → the timeframes, space-separated ('' for none), or returns 1 on anything malformed or
# repeated. Same whitelist reason as cells_array: each value is spliced into SQL and into a counter name.
switched_tfs() {
  local spec="$1" tf out='' parts=()
  if [ "$spec" = none ]; then echo ''; return 0; fi
  [[ "$spec" =~ ^[0-9]{1,2}[mhd](,[0-9]{1,2}[mhd])*$ ]] || return 1
  IFS=',' read -r -a parts <<< "$spec"
  for tf in "${parts[@]}"; do
    case " $out " in *" $tf "*) return 1 ;; esac
    out="${out:+$out }$tf"
  done
  echo "$out"
}

# switched_covered <space-separated tfs> <f-cells spec> → returns 1 and names the first timeframe with no --f-cells cell.
# A switched timeframe outside the F cells could never count a row, so it can only ever read as a thin counter.
switched_covered() {
  local tf
  for tf in $1; do
    case ",$2," in *",$tf:TRENDING_"*) ;; *) echo "$tf"; return 1 ;; esac
  done
  return 0
}

# proof_sql <since> <expect> <cells-array-literal> <space-separated switched tfs> → the whole read-only session on stdout.
proof_sql() {
  local since="$1" expect="$2" cells="$3" switched="$4" tf per_tf=''
  for tf in $switched; do
    per_tf="$per_tf
UNION ALL SELECT 'COUNT f_served_$tf=' || (SELECT count(*) FROM j WHERE f_decisive AND v = 3 AND served_f AND tf = '$tf')"
  done
  cat <<SQL
BEGIN READ ONLY;
SET LOCAL statement_timeout = '120s';
SELECT 'TOKEN current_user=' || current_user || ' transaction_read_only=' || current_setting('transaction_read_only');
WITH s_all AS (
  SELECT id, signal, timeframe, signal_hash, exchange, verdict_rule_version, rule_config_id
  FROM signals WHERE created_at >= $since
), s_first AS (
  SELECT DISTINCT ON (coalesce(signal_hash, 'id:' || id::text), exchange) *
  FROM s_all ORDER BY coalesce(signal_hash, 'id:' || id::text), exchange, id
), j AS (
  SELECT f.signal AS served, f.verdict_rule_version AS v, ssi.scorer_input_id AS ssi_id, ssi.timeframe AS tf,
         ssi.timeframe || ':' || coalesce(ssi.regime, '') AS cell,
         (ssi.timeframe || ':' || coalesce(ssi.regime, '')) = ANY ($cells) AND ssi.trend_decisive IS TRUE AS f_decisive,
         f.signal IS NOT DISTINCT FROM ssi.verdict_f AS served_f
  FROM s_first f
  LEFT JOIN signal_scorer_inputs ssi ON ssi.signal_hash = f.signal_hash AND ssi.exchange = f.exchange
), b AS (
  SELECT timeframe, regime, verdict_rule_version FROM band_signals WHERE created_at >= $since
)
SELECT 'COUNT rows=' || (SELECT count(*) FROM s_all)
UNION ALL SELECT 'COUNT keys=' || (SELECT count(*) FROM j)
UNION ALL SELECT 'COUNT unjoined=' || (SELECT count(*) FROM j WHERE ssi_id IS NULL)
UNION ALL SELECT 'COUNT wrong_config=' || (SELECT count(*) FROM s_all WHERE rule_config_id IS DISTINCT FROM '$expect')
UNION ALL SELECT 'COUNT v1=' || ((SELECT count(*) FROM s_all WHERE verdict_rule_version = 1) + (SELECT count(*) FROM b WHERE verdict_rule_version = 1))
UNION ALL SELECT 'COUNT v3_outside=' || (SELECT count(*) FROM j WHERE v = 3 AND NOT (coalesce(f_decisive, false) AND served_f))
UNION ALL SELECT 'COUNT f_missed=' || (SELECT count(*) FROM j WHERE f_decisive AND (v IS DISTINCT FROM 3 OR NOT served_f))
UNION ALL SELECT 'COUNT band_rows=' || (SELECT count(*) FROM b)
UNION ALL SELECT 'COUNT band_v3_outside=' || (SELECT count(*) FROM b WHERE verdict_rule_version = 3 AND NOT ((timeframe || ':' || coalesce(regime, '')) = ANY ($cells)))
UNION ALL SELECT 'COUNT f_served=' || (SELECT count(*) FROM j WHERE f_decisive AND v = 3 AND served_f)$per_tf
UNION ALL SELECT 'CELL ' || c || ' f_served=' || (SELECT count(*) FROM j WHERE f_decisive AND v = 3 AND served_f AND cell = c) FROM unnest($cells) AS c;
ROLLBACK;
SQL
}

# parse_counts <output-file> [space-separated switched tfs] → prints `name=value` per counter in COUNTERS order, then
# one per switched timeframe; returns 1 unless the token line is the read-only token and every counter appears exactly
# once as a non-negative integer. Output we were handed and could not parse is never a zero.
parse_counts() {
  local f="$1" switched="${2:-}" name val n tf per_tf=''
  [ -r "$f" ] || return 1
  [ "$(grep -c '^TOKEN ' "$f")" -eq 1 ] && grep -qxF "$RO_TOKEN" "$f" || return 1
  for tf in $switched; do per_tf="$per_tf f_served_$tf"; done
  for name in "${COUNTERS[@]}" $per_tf; do
    n="$(grep -c "^COUNT $name=" "$f")"
    [ "$n" -eq 1 ] || return 1
    val="$(sed -n "s/^COUNT $name=//p" "$f")"
    [[ "$val" =~ ^[0-9]+$ ]] || return 1
    echo "$name=$val"
  done
}

# decide <parsed name=value lines | 'ind:<why>'> [space-separated switched tfs] → prints the verdict line, returns its code.
decide() {
  local parsed="$1" switched="${2:-}" name val red='' served='' tf thin=''
  case "$parsed" in ind:*) printf '[switch-proof] cannot verify: %s\n' "${parsed#ind:}" >&2; echo 'SWITCH_PROOF=INDETERMINATE'; return 3 ;; esac
  for name in "${STRICT[@]}"; do
    val="$(printf '%s\n' "$parsed" | sed -n "s/^$name=//p")"
    [[ "$val" =~ ^[0-9]+$ ]] || { echo '[switch-proof] cannot verify: counters' >&2; echo 'SWITCH_PROOF=INDETERMINATE'; return 3; }
    [ "$val" -eq 0 ] || red="$red $name=$val"
  done
  served="$(printf '%s\n' "$parsed" | sed -n 's/^f_served=//p')"
  [[ "$served" =~ ^[0-9]+$ ]] || { echo '[switch-proof] cannot verify: f_served' >&2; echo 'SWITCH_PROOF=INDETERMINATE'; return 3; }
  for tf in $switched; do
    val="$(printf '%s\n' "$parsed" | sed -n "s/^f_served_$tf=//p")"
    [[ "$val" =~ ^[0-9]+$ ]] || { echo "[switch-proof] cannot verify: f_served_$tf" >&2; echo 'SWITCH_PROOF=INDETERMINATE'; return 3; }
    [ "$val" -ge "$F_SERVED_FLOOR" ] || thin="$thin $tf=$val"
  done
  if [ -n "$red" ]; then printf '[switch-proof] FAIL:%s\n' "$red" >&2; echo 'SWITCH_PROOF=FAIL'; return 1; fi
  if [ "$served" -lt "$F_SERVED_FLOOR" ]; then
    printf '[switch-proof] f_served=%s < %s — clean so far, too thin to prove\n' "$served" "$F_SERVED_FLOOR" >&2
    echo 'SWITCH_PROOF=INDETERMINATE'; return 3
  fi
  if [ -n "$thin" ]; then
    printf '[switch-proof] switched timeframes below their own floor of %s:%s — clean so far, too thin to prove\n' "$F_SERVED_FLOOR" "$thin" >&2
    echo 'SWITCH_PROOF=INDETERMINATE'; return 3
  fi
  echo 'SWITCH_PROOF=PASS'; return 0
}

self_test() {
  local fails=() tmp out code sql cells
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/switch-proof.XXXXXX")" || { echo 'SWITCH_PROOF_SELF_TEST=INDETERMINATE'; return 3; }
  fixture() { # fixture <file> <token> name=value...
    local f="$1" tok="$2"; shift 2
    { echo "$tok"; for kv in "$@"; do echo "COUNT $kv"; done; } > "$f"
  }
  local clean=(rows=900 keys=899 unjoined=0 wrong_config=0 v1=0 v3_outside=0 f_missed=0 band_rows=50 band_v3_outside=0)
  expect_verdict() { # expect_verdict <label> <want-token> <want-code> <file> [switched tfs]
    local p; p="$(parse_counts "$4" "${5:-}")" || p='ind:parse'
    out="$(decide "$p" "${5:-}" 2>/dev/null)"; code=$?
    [ "$out" = "SWITCH_PROOF=$2" ] && [ "$code" -eq "$3" ] || fails+=("$1: got '$out' exit $code, want SWITCH_PROOF=$2 exit $3")
  }

  # ── decide, both ways: PASS needs all five strict zeros AND the floor; any strict non-zero is FAIL ──
  fixture "$tmp/pass" "$RO_TOKEN" "${clean[@]}" f_served=30;           expect_verdict 'clean at the floor' PASS 0 "$tmp/pass"
  fixture "$tmp/thin" "$RO_TOKEN" "${clean[@]}" f_served=29;           expect_verdict 'clean below the floor' INDETERMINATE 3 "$tmp/thin"
  fixture "$tmp/zero" "$RO_TOKEN" rows=0 keys=0 unjoined=0 wrong_config=0 v1=0 v3_outside=0 f_missed=0 band_rows=0 band_v3_outside=0 f_served=0
  expect_verdict 'empty corpus is never PASS' INDETERMINATE 3 "$tmp/zero"
  local k
  for k in wrong_config v1 v3_outside f_missed band_v3_outside; do
    local row=() kv
    for kv in "${clean[@]}"; do [ "${kv%%=*}" = "$k" ] && row+=("$k=1") || row+=("$kv"); done
    fixture "$tmp/red-$k" "$RO_TOKEN" "${row[@]}" f_served=500;      expect_verdict "$k=1 with ample f_served" FAIL 1 "$tmp/red-$k"
    fixture "$tmp/redthin-$k" "$RO_TOKEN" "${row[@]}" f_served=2;    expect_verdict "$k=1 outranks a thin f_served" FAIL 1 "$tmp/redthin-$k"
  done
  # ── parse refuses what it cannot read: never a zero ──
  fixture "$tmp/tok" 'TOKEN current_user=algovault_app transaction_read_only=off' "${clean[@]}" f_served=500
  expect_verdict 'a non-read-only token' INDETERMINATE 3 "$tmp/tok"
  fixture "$tmp/notok" 'no token here' "${clean[@]}" f_served=500;      expect_verdict 'a missing token' INDETERMINATE 3 "$tmp/notok"
  fixture "$tmp/miss" "$RO_TOKEN" rows=1 keys=1 unjoined=0 wrong_config=0 v1=0 v3_outside=0 f_missed=0 band_rows=0 f_served=500
  expect_verdict 'a missing counter (band_v3_outside)' INDETERMINATE 3 "$tmp/miss"
  fixture "$tmp/dup" "$RO_TOKEN" "${clean[@]}" f_served=500 f_served=1; expect_verdict 'a duplicated counter' INDETERMINATE 3 "$tmp/dup"
  fixture "$tmp/nan" "$RO_TOKEN" "${clean[@]}" f_served=lots;           expect_verdict 'a non-integer counter' INDETERMINATE 3 "$tmp/nan"
  : > "$tmp/empty";                                                     expect_verdict 'empty output (ssh/psql died)' INDETERMINATE 3 "$tmp/empty"
  expect_verdict 'an unreadable file' INDETERMINATE 3 "$tmp/does-not-exist"

  # ── the per-timeframe floor: an older F timeframe must not be able to fill a newly switched one's ──
  local sw='30m 1h'
  fixture "$tmp/tf-none" "$RO_TOKEN" "${clean[@]}" f_served=500 f_served_30m=0 f_served_1h=0
  expect_verdict '3m = 500, 30m = 1h = 0' INDETERMINATE 3 "$tmp/tf-none" "$sw"
  fixture "$tmp/tf-one" "$RO_TOKEN" "${clean[@]}" f_served=559 f_served_30m=30 f_served_1h=29
  expect_verdict '30m = 30, 1h = 29' INDETERMINATE 3 "$tmp/tf-one" "$sw"
  fixture "$tmp/tf-two" "$RO_TOKEN" "${clean[@]}" f_served=560 f_served_30m=30 f_served_1h=30
  expect_verdict 'both switched timeframes at the floor' PASS 0 "$tmp/tf-two" "$sw"
  fixture "$tmp/tf-oldthin" "$RO_TOKEN" "${clean[@]}" f_served=29 f_served_30m=30 f_served_1h=30
  expect_verdict 'the total floor still holds beside the per-timeframe one' INDETERMINATE 3 "$tmp/tf-oldthin" "$sw"
  for k in wrong_config v1 v3_outside f_missed band_v3_outside; do
    local row=() kv
    for kv in "${clean[@]}"; do [ "${kv%%=*}" = "$k" ] && row+=("$k=1") || row+=("$kv"); done
    fixture "$tmp/tf-red-$k" "$RO_TOKEN" "${row[@]}" f_served=500 f_served_30m=0 f_served_1h=0
    expect_verdict "$k=1 outranks thin switched timeframes" FAIL 1 "$tmp/tf-red-$k" "$sw"
    fixture "$tmp/tf-redfull-$k" "$RO_TOKEN" "${row[@]}" f_served=500 f_served_30m=30 f_served_1h=30
    expect_verdict "$k=1 outranks full switched timeframes" FAIL 1 "$tmp/tf-redfull-$k" "$sw"
  done
  fixture "$tmp/tf-miss" "$RO_TOKEN" "${clean[@]}" f_served=500 f_served_30m=30
  expect_verdict 'a missing per-timeframe counter (1h)' INDETERMINATE 3 "$tmp/tf-miss" "$sw"
  fixture "$tmp/tf-dup" "$RO_TOKEN" "${clean[@]}" f_served=500 f_served_30m=30 f_served_1h=30 f_served_1h=30
  expect_verdict 'a duplicated per-timeframe counter' INDETERMINATE 3 "$tmp/tf-dup" "$sw"
  fixture "$tmp/tf-nan" "$RO_TOKEN" "${clean[@]}" f_served=500 f_served_30m=30 f_served_1h=lots
  expect_verdict 'a non-integer per-timeframe counter' INDETERMINATE 3 "$tmp/tf-nan" "$sw"
  { cat "$tmp/tf-two"; echo 'CELL 30m:TRENDING_UP f_served=30'; echo 'CELL 30m:TRENDING_DOWN f_served=0'; } > "$tmp/tf-cell"
  expect_verdict 'CELL lines are evidence only (a direction at 0 does not hold the verdict)' PASS 0 "$tmp/tf-cell" "$sw"

  # ── the --switched whitelist and its coverage: both refuse BEFORE the host is touched ──
  [ "$(switched_tfs '30m,1h')" = '30m 1h' ] || fails+=("switched_tfs did not render 30m,1h: '$(switched_tfs '30m,1h')'")
  { switched_tfs none >/dev/null && [ -z "$(switched_tfs none)" ]; } || fails+=('switched_tfs none is not the empty list')
  for bad in '' '30m,' ',30m' '30m,,1h' '30M' 'x' 'none,30m' '30m,30m' "30m'; DROP TABLE signals; --" '30m 1h'; do
    switched_tfs "$bad" >/dev/null 2>&1 && fails+=("switched_tfs accepted '$bad'")
  done
  switched_covered '30m 1h' '3m:TRENDING_UP,30m:TRENDING_DOWN,1h:TRENDING_UP' >/dev/null || fails+=('switched_covered refused covered timeframes')
  [ "$(switched_covered '30m 1h' '30m:TRENDING_UP')" = 1h ] || fails+=('switched_covered did not name the uncovered 1h')
  [ "$(switched_covered '1h' '11h:TRENDING_UP')" = 1h ] || fails+=('switched_covered took 11h for 1h')
  switched_covered '' 'none' >/dev/null || fails+=('switched_covered refused --switched none')

  # A function shadows the binary for these calls only, so a refusal that regressed cannot reach the host.
  ssh() { : > "$tmp/ssh-reached"; cat >/dev/null; return 99; }
  local id64 refused
  id64="$(printf 'a%.0s' {1..64})"
  expect_refused() { # expect_refused <label> <run_proof args...>: INDETERMINATE exit 3 AND the host never reached
    local label="$1"; shift
    rm -f "$tmp/ssh-reached"
    refused="$(run_proof "$@" 2>/dev/null)"; code=$?
    [ "$refused" = 'SWITCH_PROOF=INDETERMINATE' ] && [ "$code" -eq 3 ] || fails+=("$label: got '$refused' exit $code, want SWITCH_PROOF=INDETERMINATE exit 3")
    [ ! -e "$tmp/ssh-reached" ] || fails+=("$label: reached the host before refusing")
  }
  expect_refused '--switched missing' --since 1700000000 --expect "$id64" --f-cells 30m:TRENDING_UP
  expect_refused 'a switched timeframe with no --f-cells cell' --since 1700000000 --expect "$id64" --f-cells 3m:TRENDING_UP --switched 30m
  expect_refused 'a switched timeframe under --f-cells none' --since 1700000000 --expect "$id64" --f-cells none --switched 30m
  expect_refused 'a malformed --switched' --since 1700000000 --expect "$id64" --f-cells 30m:TRENDING_UP --switched "30m'; --"
  unset -f ssh

  # ── the --f-cells whitelist: it is spliced into SQL ──
  cells="$(cells_array '3m:TRENDING_UP,3m:TRENDING_DOWN')" && [ "$cells" = "ARRAY['3m:TRENDING_UP','3m:TRENDING_DOWN']::text[]" ] \
    || fails+=("cells_array did not render the 3m pair: '$cells'")
  [ "$(cells_array none)" = 'ARRAY[]::text[]' ] || fails+=('cells_array none is not the empty array')
  for bad in '' '3m' '3m:RANGING' "3m:TRENDING_UP'); DROP TABLE signals; --" '3m:TRENDING_UP,,4h:TRENDING_DOWN' 'x:TRENDING_UP' '3m:trending_up'; do
    cells_array "$bad" >/dev/null 2>&1 && fails+=("cells_array accepted '$bad'")
  done

  # ── the bypassed artifact: the SQL the seam above never runs. Assert its shape, not just the parser ──
  sql="$(proof_sql 1700000000 "$id64" "$cells" "$sw")"
  printf '%s\n' "$sql" | head -1 | grep -qx 'BEGIN READ ONLY;' || fails+=('SQL does not open with BEGIN READ ONLY')
  printf '%s\n' "$sql" | tail -1 | grep -qx 'ROLLBACK;' || fails+=('SQL does not close with ROLLBACK')
  printf '%s\n' "$sql" | grep -qiE 'outcome_|label|pfe_|mae_|return_1candle' && fails+=('SQL names an outcome/label column — sealed holdout')
  printf '%s\n' "$sql" | grep -qiE '\b(insert|update|delete|alter|create|drop|truncate|grant)\b' && fails+=('SQL carries a write keyword')
  printf '%s\n' "$sql" | grep -qE "^SELECT 'TOKEN " || fails+=('SQL emits no read-only token line')
  for k in "${COUNTERS[@]}"; do
    [ "$(printf '%s\n' "$sql" | grep -c "'COUNT $k='")" -eq 1 ] || fails+=("SQL does not emit COUNT $k exactly once")
  done
  [ "$(printf '%s\n' "$sql" | grep -c "created_at >= 1700000000")" -eq 2 ] || fails+=('--since does not bound both signals and band_signals')
  for k in 30m 1h; do
    [ "$(printf '%s\n' "$sql" | grep -c "'COUNT f_served_$k='")" -eq 1 ] || fails+=("SQL does not emit COUNT f_served_$k exactly once")
    printf '%s\n' "$sql" | grep "'COUNT f_served_$k='" | grep -qF "AND served_f AND tf = '$k')" || fails+=("COUNT f_served_$k is not scoped to its own timeframe")
  done
  printf '%s\n' "$sql" | grep -q "'COUNT f_served_3m='" && fails+=('SQL counts a timeframe --switched did not name')
  printf '%s\n' "$sql" | grep "^UNION ALL SELECT 'CELL '" | grep -qF "FROM unnest($cells) AS c;" || fails+=('per-cell evidence does not cover every --f-cells cell')
  [ "$(printf '%s\n' "$sql" | grep -c 'COUNT f_served_')" -eq 2 ] || fails+=('SQL carries a per-timeframe COUNT beyond --switched')
  [ "$(proof_sql 1700000000 "$id64" "$cells" '' | grep -c 'COUNT f_served_')" -eq 0 ] || fails+=('--switched none still emits a per-timeframe COUNT')

  rm -rf "$tmp"
  if [ "${#fails[@]}" -gt 0 ]; then
    printf '  ✗ %s\n' "${fails[@]}" >&2
    echo 'SELF-TEST: FAIL'; echo 'SWITCH_PROOF_SELF_TEST=FAIL'; return 1
  fi
  echo 'SELF-TEST: PASS (decide both ways incl. FAIL-outranks-thin; per-timeframe floor; parse refuses token/missing/duplicate/non-integer/empty; f-cells + switched whitelists, missing/uncovered --switched refused before the host; SQL shape: read-only, rollback, no outcome/label/write, every counter once, per-timeframe COUNTs scoped, --since on both tables)'
  echo 'SWITCH_PROOF_SELF_TEST=PASS'; return 0
}

run_proof() {
  local since='' expect='' fcells='' switched_arg='' switched uncovered cells out parsed
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || { echo "[switch-proof] $1 needs a value" >&2; echo 'SWITCH_PROOF=INDETERMINATE'; return 3; }
    case "$1" in
      --since) since="$2" ;;
      --expect) expect="$2" ;;
      --f-cells) fcells="$2" ;;
      --switched) switched_arg="$2" ;;
      *) echo "[switch-proof] unknown argument $1" >&2; echo 'SWITCH_PROOF=INDETERMINATE'; return 3 ;;
    esac
    shift 2
  done
  [[ "$since" =~ ^[0-9]{10}$ ]] || { echo '[switch-proof] --since must be epoch seconds' >&2; echo 'SWITCH_PROOF=INDETERMINATE'; return 3; }
  [[ "$expect" =~ ^[0-9a-f]{64}$ ]] || { echo '[switch-proof] --expect must be a 64-hex rule_config_id' >&2; echo 'SWITCH_PROOF=INDETERMINATE'; return 3; }
  cells="$(cells_array "$fcells")" || { echo '[switch-proof] --f-cells must be tf:TRENDING_UP|DOWN[,...] or none' >&2; echo 'SWITCH_PROOF=INDETERMINATE'; return 3; }
  switched="$(switched_tfs "$switched_arg")" || { echo '[switch-proof] --switched is required: tf[,...] (no repeats) or none' >&2; echo 'SWITCH_PROOF=INDETERMINATE'; return 3; }
  uncovered="$(switched_covered "$switched" "$fcells")" || { echo "[switch-proof] --switched names $uncovered, which has no --f-cells cell" >&2; echo 'SWITCH_PROOF=INDETERMINATE'; return 3; }
  command -v ssh >/dev/null 2>&1 || { echo '[switch-proof] ssh not on PATH' >&2; echo 'SWITCH_PROOF=INDETERMINATE'; return 3; }
  out="$(mktemp "${TMPDIR:-/tmp}/switch-proof.XXXXXX")" || { echo 'SWITCH_PROOF=INDETERMINATE'; return 3; }
  proof_sql "$since" "$expect" "$cells" "$switched" |
    ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -i "$KEY" "$HOST" \
      "docker exec -i $PG_CTR psql -U aoe_readonly -d signal_performance -At -q -v ON_ERROR_STOP=1" > "$out" 2> "$out.err"
  if parsed="$(parse_counts "$out" "$switched")"; then
    printf '[switch-proof] since=%s expect=%s f-cells=%s switched=%s\n' "$since" "${expect:0:12}…" "$fcells" "$switched_arg" >&2
    printf '%s\n' "$parsed" | sed 's/^/[switch-proof]   /' >&2
    grep '^CELL ' "$out" | sed 's/^/[switch-proof]   /' >&2
  else
    tail -5 "$out.err" 2>/dev/null | sed 's/^/[switch-proof] stderr: /' >&2
    parsed='ind:host, query or output unreadable'
  fi
  rm -f "$out" "$out.err"
  decide "$parsed" "$switched"
}

# Sourceable for fixtures: a sourced copy defines the functions and runs nothing.
if (return 0 2>/dev/null); then return 0; fi

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  *) run_proof "$@"; exit $? ;;
esac
