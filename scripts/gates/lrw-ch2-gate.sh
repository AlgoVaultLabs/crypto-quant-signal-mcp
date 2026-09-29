#!/usr/bin/env bash
# lrw-ch2-gate.sh — EDGE-LABELER-RACE-WINDOW-V2-W1 CH2 (the generator fix: corrected cache, -v2 race, DDL).
#
# Runs, in order, from the repo root:
#   1. rm -rf dist && npm run build && npm run build:knowledge  (deploy.yml's order — tsc alone leaves
#      dist/knowledge missing and kb-reachability reads INDETERMINATE; measured by ADS-1 CH2)
#   2. the full vitest suite with the CI reporters, then scripts/classify-suite-verdict.mjs — the SAME verdict
#      deploy.yml gates on. The raw vitest exit code is NOT the gate (it is 1 under load with 0 failing tests).
#   3. LRW_SELFTEST — (a) the wave's own files ran and passed inside that suite, read from the JSON report,
#      never assumed: the race-window regression suite, the hold -v2 suite, the golden, the expiry path;
#      (b) the MUTATION MATRIX: each mutation below is applied to a sandbox copy of the tree and ITS target suite
#      (race = lrw-race-window-v2, hold = lrw-hold-v2) must go RED on it. A survivor means the suite cannot see
#      that defect → RED. An UNMUTATED control sandbox runs both suites first and must PASS: a sandbox that fails
#      on its own (a file the suites read left out of the copy) would count every mutation as killed, so a failed
#      control makes the whole matrix unverifiable → INDETERMINATE, never GREEN.
#         M1  race  contiguity dropped            servedWindow no longer checks the W steps
#         M2  race  race by index                 prepareRaceV2 races forwardAsc.slice(0, W) instead of the window
#         M3  race  extend from coveredUntil+tf   processGroup's retired off-grid extension, coverage = range end
#         M4  race  -v1 clip removed              -v1 sees the whole corrected cache (coarser-served definition moves)
#         M5  race  cut timeout out of -v2 gate   coarser -v2 only where -v1 DECIDED (outcome-selected)
#         M6  race  closed-window check dropped   prepareRaceV2 races a window that may still be forming
#         M7  race  probed watermark dropped      OKX/Bitget young coins stuck behind their listing (-v1 regression)
#         M8  race  -v1 extents bridged           a served candle between two -v1 extents enters -v1 σ
#         M9  race  seal edge dropped             a T_CAP row carries a post-seal close in ret_at_expiry_pct
#         M10 race  coarser hold-back dropped     a -v2 window open when -v1 is due is never raced
#         M11 race  -v1 σ extent on the span      -v1 σ reads 60W served candles (LRW-Q4 cut broken)
#         M12 race  -v2 σ from the -v1 view       -v2 σ on ~36 windows (LRW-Q1 broken)
#         M13 race  expiry from the -v1 view      coarser expiry NULL for want of the cut (LRW-Q9e)
#         M14 race  hold-back on the -v2 outcome  a refused -v2 window withholds -v1 (LRW-Q15 clock pin)
#         M15 race  lag formula changed           the coarser -v1 lag drifts from (W+1)·(served − requested)
#         M16 race  write-once guards dropped     a -v1-less -v2 row is re-written every nightly (LRW-Q16)
#         M17 race  V2_NO_V1_TWIN per signal      mixed-τ twin-less rows go uncounted (must be per τ)
#         M18 race  V2_HELDBACK pending uncounted the hold-back goes silent
#         M19 race  V2_HELDBACK released uncounted
#         M20 race  record lines not printed      the nightly stops printing V2_HELDBACK / V2_NO_V1_TWIN
#         M21 race  released lower clause dropped the estimate counts a signal not yet due a nightly ago
#         M22 race  released upper clause dropped the estimate counts a signal whose window was long closed
#         M23 race  no-twin ignores existing -v1  a same-τ twin written by an earlier run reads as missing
#         M24 race  no-twin counted before insert a group a budget skip abandons still counts its rows
#         H1  hold  requested step as the grid    hold -v2 refused on every non-faithful pair
#         H2  hold  -v2 pages on requested step   finer-served hold -v2 loses a candle per page
#         H3  hold  -v2 unscoped                  hold -v2 for decisions whose -v1 fetch failed
#         (H4 retired: the -v1 verdict is now PRINTED before the -v2 pass, so re-evaluating it late is the same
#          instant — an equivalent mutant; the ordering is pinned by the hold suite's verdict-before-fetch assert)
#         H5  hold  retry list dropped            a deferred hold -v2 is never retried
#         H6  hold  cut source dropped            coarser hold -v2 only where -v1 decided
#         H7  hold  retry bound dropped           the retry list reaches past its per-row bound
#         H8  hold  pre-filter narrowed           the SQL pre-filter cuts rows the per-row bound keeps
#         H9  hold  aged-out never classified     a last-night loss reads as pending (silent)
#         H10 hold  V2_NO_V1_TWIN uncounted       the hold no-twin class goes silent
#         H11 hold  source 1 = pushed, not inserted  a refused -v1 re-push races -v2 with no bound
#         H12 hold  empty -v1 forward = cut       no-klines counted as a completed -v1 attempt
#         H13 hold  a -v2 fault throws            the -v1 verdict token and exit code are lost
#         H14 hold  limited never set             a capped retry list reads as complete
#         H15 hold  write-once guards dropped     complete -v2 sets re-raced every nightly
#         H16 hold  own writes spend the LIMIT    this run's -v1 writes crowd retry rows out
#         H18 hold  int8 ids compared raw         pg's string ids never match: source 1 is always empty
#         H19 hold  coarser source 1 unbounded    the drained coarser backlog's -v2 is outcome-selected
#         H20 hold  every leg calls rows lost     a per-venue leg reports aged_out for a row a later leg writes
#         H21 hold  cap overflow uncounted        last-chance rows past the LIMIT age out silently
#         H22 hold  retry order alphabetical      a cap cuts urgent rows and keeps ones that could wait
#         H23 hold  no schedule jitter in pending a row whose last nightly starts late drops out uncounted
#   4. node dist/scripts/ads1/ddl-parity-check.js  -> DDL_PARITY: PASS (migrations == the labeller's DDL)
#
# Verdict — exactly one terminal line, the token is the contract:
#   CH2_GREEN          exit 0   every leg passed
#   CH2_RED            exit 1   any leg failed (incl. a surviving mutation)
#   CH2_INDETERMINATE  exit 3   a required tool is missing, or a leg produced no readable verdict
# RED outranks INDETERMINATE.
#
# A committed bash script on purpose (the tool shell is zsh: ${PIPESTATUS[0]} empty, [ "" -eq 0 ] TRUE).
# --self-test drives the REAL decision function (the script is sourceable) over synthetic leg results, plus a
# PATH-stripped run for the missing-tool precondition. There is no env seam that can fake a leg.
#
# Usage:  scripts/gates/lrw-ch2-gate.sh            (from anywhere inside the checkout)
#         scripts/gates/lrw-ch2-gate.sh --self-test
set -uo pipefail

REQUIRED_TOOLS=(node npm npx git grep sed cp mktemp cmp)
OWN_FILES=(
  'tests/unit/lrw-race-window-v2.test.ts'
  'tests/unit/lrw-hold-v2.test.ts'
  'tests/unit/directional-label-golden.test.ts'
  'tests/unit/directional-label-expiry.test.ts'
)
RACE_SUITE='tests/unit/lrw-race-window-v2.test.ts'
HOLD_SUITE='tests/unit/lrw-hold-v2.test.ts'
MIN_MUTATIONS=45 # a matrix shorter than the declared one is vacuous, never GREEN

# decide <build_rc> <suite_token> <own_status> <mutation_line> <ddl_line>  -> prints the token, returns its code
#   own_status:    passed | failed | missing
#   mutation_line: "MUTATIONS killed=<k> of=<n>" | "" (no readable result)
decide() {
  local build_rc="$1" suite="$2" own="$3" mut="$4" ddl="$5"
  local red="" ind="" k n
  [ "$build_rc" = "0" ] || red="$red build"
  case "$suite" in
    PASS|PASS_AFTER_ISOLATION) ;;
    FAIL) red="$red suite" ;;
    *) ind="$ind suite:${suite:-none}" ;;
  esac
  case "$own" in
    passed) ;;
    failed) red="$red own-files" ;;
    *) ind="$ind own-files:${own:-none}" ;;
  esac
  case "$mut" in
    "MUTATIONS control=FAIL"*) ind="$ind mutations:control-failed" ;;
    "MUTATIONS killed="*" of="*)
      k="$(printf '%s' "$mut" | sed -E 's/^MUTATIONS killed=([0-9]+) of=([0-9]+).*/\1/')"
      n="$(printf '%s' "$mut" | sed -E 's/^MUTATIONS killed=([0-9]+) of=([0-9]+).*/\2/')"
      if [ "$n" -lt "$MIN_MUTATIONS" ]; then ind="$ind mutations:vacuous($n)"
      elif [ "$k" -ne "$n" ]; then red="$red mutations:$((n - k))-survived"; fi ;;
    *) ind="$ind mutations:no-result" ;;
  esac
  case "$ddl" in
    "DDL_PARITY: PASS"*) ;;
    "DDL_PARITY: FAIL"*) red="$red ddl-parity" ;;
    *) ind="$ind ddl-parity:no-verdict" ;;
  esac
  if [ -n "$red" ]; then printf '[lrw-ch2-gate] RED:%s%s\n' "$red" "${ind:+ (also unverified:$ind)}" >&2; echo CH2_RED; return 1; fi
  if [ -n "$ind" ]; then printf '[lrw-ch2-gate] cannot verify:%s\n' "$ind" >&2; echo CH2_INDETERMINATE; return 3; fi
  printf '[lrw-ch2-gate] build + suite + own files + mutation matrix + DDL parity all passed\n' >&2
  echo CH2_GREEN; return 0
}

# mutate <sandbox> <name> <file> <sed-expr>  -> applies one mutation; fails if it did not change the file
mutate() {
  local box="$1" name="$2" file="$3" expr="$4"
  cp "$box/$file" "$box/$file.orig"
  sed -i.bak -E "$expr" "$box/$file" && rm -f "$box/$file.bak"
  if cmp -s "$box/$file" "$box/$file.orig"; then
    printf '[lrw-ch2-gate] mutation %s did NOT apply (pattern drifted) — the matrix cannot vouch for it\n' "$name" >&2
    return 1
  fi
  return 0
}

# mutation_matrix <root> <tmp>  -> prints "MUTATIONS killed=<k> of=<n>"
mutation_matrix() {
  local root="$1" tmp="$2" killed=0 total=0 name file expr target
  local L=src/scripts/directional-labeler.ts B=src/scripts/backfill-directional-labels.ts H=src/scripts/backfill-hold-decision-labels.ts
  # name | file | target suite | sed -E expression   (one row per mutation; the table IS the matrix)
  local -a NAMES=() FILES=() TARGETS=() EXPRS=()
  row() { NAMES+=("$1"); FILES+=("$2"); TARGETS+=("$3"); EXPRS+=("$4"); }
  row M1 "$L" "$RACE_SUITE" '/if \(forwardAsc\[i\]\.time !== first \+ i \* stepMs\) return \{ ok: false, reason: .gap. \};/d'
  row M2 "$L" "$RACE_SUITE" 's/const w = servedWindow\(forwardAsc, W, entryMs, stepMs\);$/const w = { ok: true as const, window: forwardAsc.slice(0, W) };/'
  row M3a "$B" "$RACE_SUITE" 's/const start = Math\.max\(nextFetchStartMs\(coveredUntil, stepMs, neededStart\), probedThrough \+ 1\);/const start = coveredUntil + tfMs >= neededStart ? coveredUntil + tfMs : neededStart;/'
  row M4 "$B" "$RACE_SUITE" 's/const v1View = withinExtents\(asc, v1Extents\);/const v1View = asc;/'
  row M5 "$B" "$RACE_SUITE" 's/if \(!\(wroteV1 \|\| v1CutUnwritable\) \|\| !v2Missing\) continue;/if (!wroteV1 || !v2Missing) continue;/'
  row M6 "$L" "$RACE_SUITE" '/if \(!windowClosed\(entryMs, W, stepMs, fetchedNotBeforeMs\)\) return \{ kind: .deferred. \};/d'
  row M7 "$B" "$RACE_SUITE" 's/if \(answered && coveredUntil === before\) probedThrough = neededEnd;//'
  row M8 "$B" "$RACE_SUITE" 's/if \(last && lo <= last\[1\]\) last\[1\]/if (last \&\& lo <= last[1] + 300000) last[1]/'
  row M9 "$B" "$RACE_SUITE" 's/const expiry = sealEdgeRow\(s\.created_at, g\.timeframe, stepMs\)/const expiry = false/'
  row M10 "$B" "$RACE_SUITE" 's/if \(!windowClosed\(entryMs, W, stepMs, groupStartMs\)\) \{ cov\.v2HeldBack\+\+; continue; \}//'
  row M11 "$B" "$RACE_SUITE" 's/^( +)entryMs - \(SIGMA_TARGET_WINDOWS \* W \+ FETCH_BUFFER_CANDLES\) \* tfMs,$/\1entryMs - (SIGMA_TARGET_WINDOWS * W + FETCH_BUFFER_CANDLES) * spanMs,/'
  row M12 "$B" "$RACE_SUITE" 's/const prep = prepareRaceV2\(cache, fullForward,/const prep = prepareRaceV2(new Map(v1View.map((c) => [c.time, c])), fullForward,/'
  row M13 "$B" "$RACE_SUITE" 's/: expiryReturnPct\(fullForward, W,/: expiryReturnPct(forwardAsc, W,/'
  row M14 "$B" "$RACE_SUITE" 's/if \(!windowClosed\(entryMs, W, stepMs, groupStartMs\)\) \{ cov\.v2HeldBack\+\+; continue; \}/if (prepareRaceV2(cache, fullForward, entryMs, W, stepMs, groupStartMs).kind !== "ready") { cov.v2HeldBack++; continue; }/'
  row M15 "$B" "$RACE_SUITE" 's/return \(W \+ 1\) \* \(served - requested\);/return (W + 1) * served;/'
  row M16 "$B" "$RACE_SUITE" 's/if \(!\(wroteV1 \|\| v1CutUnwritable\) \|\| !v2Missing\) continue;/if (!(wroteV1 || v1CutUnwritable)) continue;/;/\/\/ -v2 written once$/d'
  row M17 "$B" "$RACE_SUITE" 's/if \(!done\.has\(`\$\{s\.id\}\|\$\{twin\}`\) && !v1Written\.has\(twin\)\) groupNoTwin\+\+;/if (!wroteV1) groupNoTwin++;/'
  row M18 "$B" "$RACE_SUITE" 's/cov\.v2HeldBack\+\+; continue;/continue;/'
  row M19 "$B" "$RACE_SUITE" 's/cov\.v2HeldBackReleased\+\+;/void 0;/'
  row M20 "$B" "$RACE_SUITE" 's/for \(const line of formatV2Tokens\(cov\)\) console\.log\(line\);//'
  row M21 "$B" "$RACE_SUITE" 's/if \(prevRun >= entryMs \+ \(W \+ 1\) \* tfMs && /if (/'
  row M22 "$B" "$RACE_SUITE" 's/ && !windowClosed\(entryMs, W, stepMs, prevRun\)\) cov\.v2HeldBackReleased/) cov.v2HeldBackReleased/'
  row M23 "$B" "$RACE_SUITE" 's/if \(!done\.has\(`\$\{s\.id\}\|\$\{twin\}`\) && !v1Written\.has\(twin\)\) groupNoTwin\+\+;/if (!v1Written.has(twin)) groupNoTwin++;/'
  row M24 "$B" "$RACE_SUITE" 's/groupNoTwin\+\+;/cov.v2NoV1Twin++;/'
  row H1 "$H" "$HOLD_SUITE" 's/const stepMs = servedCandleStepMs\(exchange, timeframe\) \?\? tfMs;/const stepMs = tfMs;/'
  row H2 "$H" "$HOLD_SUITE" 's/fetchRangeInto\(cache, exchange as ExchangeId, coin, timeframe, start, neededEnd, stepMs\)/fetchRangeInto(cache, exchange as ExchangeId, coin, timeframe, start, neededEnd)/'
  row H3 "$H" "$HOLD_SUITE" 's/labelHoldV2\(v2Groups\.groups,/labelHoldV2(groups,/'
  row H5 "$H" "$HOLD_SUITE" 's/for \(const r of retry\) add\(r, .retry.\);/for (const r of retry.slice(0, 0)) add(r, "retry");/'
  row H6 "$H" "$HOLD_SUITE" 's/for \(const d of cutUnwritable\) if \(holdV2Retryable\(d, nowMs\)\) add\(d, .cut.\);//'
  row H7 "$H" "$HOLD_SUITE" '/`h\.decided_at > b\.lo_s`, \/\/ the per-row bound/d'
  row H8 "$H" "$HOLD_SUITE" 's/HOLD_V2_RETRY_PREFILTER_S = 8 \* 86_400;/HOLD_V2_RETRY_PREFILTER_S = 6 * 86_400;/'
  row H9 "$H" "$HOLD_SUITE" 's/else if \(!lastLegOfNight \|\| holdV2Retryable\(d, nowMs \+ HOLD_NIGHTLY_CADENCE_MS \+ HOLD_NIGHTLY_JITTER_MS\)\) a\.pending\+\+;/else if (true) a.pending++;/'
  row H10 "$H" "$HOLD_SUITE" 's/if \(!have\.has\(`\$\{d\.decision_id\}\|\$\{twin\}`\)\) v2\.noV1Twin\+\+;/void 0;/'
  row H11 "$H" "$HOLD_SUITE" 's/v1Attempted\.filter\(\(d\) => v1Insert\.ids\.has\(Number\(d\.decision_id\)\)\)/v1Attempted/'
  row H12 "$H" "$HOLD_SUITE" 's/if \(indeterminateTimeout && forwardAsc\.length > 0 && coarser\) cutUnwritable = true;/if (indeterminateTimeout \&\& coarser) cutUnwritable = true;/'
  row H13 "$H" "$HOLD_SUITE" 's/v2Error = err instanceof Error \? err\.message\.slice\(0, 200\) : String\(err\)\.slice\(0, 200\);/throw err;/'
  row H14 "$H" "$HOLD_SUITE" 's/limited = retry\.length >= cli\.maxDecisions;/limited = false;/'
  row H15 "$H" "$HOLD_SUITE" 's/const candidates = picked\.filter\(\(d\) => v2Specs\.some\(\(sp\) => !have\.has\(`\$\{d\.decision_id\}\|\$\{sp\.spec\}`\)\)\);/const candidates = picked;/;/\/\/ hold -v2 written once$/d'
  row H16 "$H" "$HOLD_SUITE" '/`h\.decision_id <> ALL\(\$7::bigint\[\]\)`, \/\/ sources 1-2/d'
  row H18 "$H" "$HOLD_SUITE" 's/v1Insert\.ids\.has\(Number\(d\.decision_id\)\)/v1Insert.ids.has(d.decision_id)/'
  row H19 "$H" "$HOLD_SUITE" 's/for \(const d of v1Inserted\) if \(!isCoarserPair\(d\.exchange, d\.timeframe\) \|\| holdV2Retryable\(d, nowMs\)\) add\(d, .v1.\);/for (const d of v1Inserted) add(d, "v1");/'
  row H20 "$H" "$HOLD_SUITE" 's/const lastLeg = !\(cli\.venue \|\| cli\.coin \|\| cli\.timeframe\);/const lastLeg = true;/'
  row H21 "$H" "$HOLD_SUITE" 's/if \(lastLeg\) retryAcc\.agedOut \+= v2Groups\.overflowLastChance;//'
  row H22 "$H" "$HOLD_SUITE" 's/ORDER BY h\.decided_at - b\.lo_s, h\.exchange/ORDER BY h.exchange/'
  row H23 "$H" "$HOLD_SUITE" 's/holdV2Retryable\(d, nowMs \+ HOLD_NIGHTLY_CADENCE_MS \+ HOLD_NIGHTLY_JITTER_MS\)\) a\.pending/holdV2Retryable(d, nowMs + HOLD_NIGHTLY_CADENCE_MS)) a.pending/'
  # make_box <dir>: a copy of everything the two suites read (src, tests, docs) + the config, deps linked
  make_box() {
    mkdir -p "$1" && cp -R "$root/src" "$root/tests" "$root/docs" "$1/" \
      && cp "$root/package.json" "$root/tsconfig.json" "$root/vitest.config.ts" "$1/" && ln -s "$root/node_modules" "$1/node_modules"
  }
  # the CONTROL: both suites must pass on an unmutated sandbox, or no kill below means anything
  local ctl="$tmp/box-control" s cout
  make_box "$ctl" || { echo "MUTATIONS control=FAIL (sandbox)"; return; }
  for s in "$RACE_SUITE" "$HOLD_SUITE"; do
    cout="$(cd "$ctl" && npx vitest run "$s" </dev/null 2>&1)"
    if ! printf '%s' "$cout" | grep -qE '^ +Tests +[0-9]+ passed \('; then
      printf '%s\n' "$cout" > "$tmp/control-$(basename "$s").log"
      printf '[lrw-ch2-gate] CONTROL FAILED: %s does not pass on the unmutated sandbox\n' "$s" >&2
      echo "MUTATIONS control=FAIL ($s)"; return
    fi
  done
  rm -rf "$ctl"
  printf '[lrw-ch2-gate] control: both suites pass on the unmutated sandbox\n' >&2
  local i
  for i in "${!NAMES[@]}"; do
    name="${NAMES[$i]}"; file="${FILES[$i]}"; target="${TARGETS[$i]}"; expr="${EXPRS[$i]}"
    total=$((total + 1))
    local box="$tmp/box-$name"
    make_box "$box" || { printf '[lrw-ch2-gate] sandbox %s could not be built\n' "$name" >&2; continue; }
    mutate "$box" "$name" "$file" "$expr" || continue
    if [ "$name" = "M3a" ]; then
      # the legacy extension also set coverage to the RANGE END, not to the last arrival
      mutate "$box" M3b "$B" \
        's/^( +)coveredUntil = advanceCoverage\(coveredUntil, cache\.keys\(\), start, neededEnd\);$/\1coveredUntil = Math.max(coveredUntil, neededEnd);/' || continue
    fi
    local out
    out="$(cd "$box" && npx vitest run "$target" </dev/null 2>&1)"
    if printf '%s' "$out" | grep -qE 'Tests +[0-9]+ failed'; then
      killed=$((killed + 1)); printf '[lrw-ch2-gate] mutation %s KILLED\n' "$name" >&2
    else
      printf '[lrw-ch2-gate] mutation %s SURVIVED (the suite cannot see it)\n' "$name" >&2
      printf '%s\n' "$out" > "$tmp/survivor-$name.log"
    fi
    rm -rf "$box"
  done
  echo "MUTATIONS killed=$killed of=$total"
}

run_gate() {
  local t
  for t in "${REQUIRED_TOOLS[@]}"; do
    command -v "$t" >/dev/null 2>&1 || { printf "[lrw-ch2-gate] required tool '%s' not on PATH\n" "$t" >&2; echo CH2_INDETERMINATE; exit 3; }
  done
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "[lrw-ch2-gate] not inside a git checkout" >&2; echo CH2_INDETERMINATE; exit 3; }
  cd "$root" || { echo CH2_INDETERMINATE; exit 3; }
  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR GIT_QUARANTINE_PATH
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/lrw-ch2-gate.XXXXXX")" || { echo CH2_INDETERMINATE; exit 3; }

  rm -rf dist
  { npm run build && npm run build:knowledge; } >"$tmp/build.log" 2>&1
  local build_rc=$?
  local suite="" own="missing" mut="" ddl=""
  if [ "$build_rc" -eq 0 ]; then
    npx vitest run --reporter=default --reporter=json --outputFile="$tmp/report.json" \
      --reporter=./scripts/vitest-error-shape-reporter.mjs </dev/null >"$tmp/vitest.log" 2>&1 || true
    mv -f .vitest-error-shapes.json "$tmp/shapes.json" 2>/dev/null || true
    suite="$(node scripts/classify-suite-verdict.mjs "$tmp/report.json" --sidecar="$tmp/shapes.json" 2>/dev/null \
      | grep -E '^SUITE_VERDICT=' | tail -n 1 | sed 's/^SUITE_VERDICT=//')"
    own="$(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      let st = "passed";
      for (const want of process.argv.slice(2)) {
        const f = (r.testResults || []).find((t) => String(t.name).endsWith(want));
        if (!f) { st = st === "failed" ? "failed" : "missing"; continue; }
        const a = f.assertionResults || [];
        if (!(a.length > 0 && a.every((x) => x.status === "passed"))) st = "failed";
      }
      console.log(st);
    ' "$tmp/report.json" "${OWN_FILES[@]}" 2>/dev/null || echo missing)"
    mut="$(mutation_matrix "$root" "$tmp")"
    ddl="$(node dist/scripts/ads1/ddl-parity-check.js 2>/dev/null | tail -n 1)"
  fi
  printf '[lrw-ch2-gate] build_rc=%s suite=%s own=%s\n[lrw-ch2-gate] %s\n[lrw-ch2-gate] %s\n' \
    "$build_rc" "${suite:-none}" "$own" "${mut:-no mutation line}" "${ddl:-no ddl line}" >&2
  local rc st_ok=0 k n
  decide "$build_rc" "$suite" "$own" "$mut" "$ddl"; rc=$?
  # the self-test token the chapter spec names: the wave's own suites passed AND every mutation was killed
  k="$(printf '%s' "$mut" | sed -nE 's/^MUTATIONS killed=([0-9]+) of=([0-9]+).*/\1/p')"
  n="$(printf '%s' "$mut" | sed -nE 's/^MUTATIONS killed=([0-9]+) of=([0-9]+).*/\2/p')"
  if [ "$own" = "passed" ] && [ -n "$k" ] && [ "$k" = "$n" ] && [ "$n" -ge "$MIN_MUTATIONS" ]; then st_ok=1; fi
  if [ "$st_ok" -eq 1 ]; then printf 'LRW_SELFTEST: PASS (%s own files, %s)\n' "${#OWN_FILES[@]}" "$mut" >&2
  else printf 'LRW_SELFTEST: FAIL (own=%s, %s)\n' "$own" "${mut:-no mutation result}" >&2; fi
  if [ "$rc" -eq 0 ]; then rm -rf "$tmp"
  else printf '[lrw-ch2-gate] evidence kept: %s (build.log, vitest.log, report.json, survivor-*.log)\n' "$tmp" >&2; fi
  exit "$rc"
}

self_test() {
  local pass=0 fail=0 cases=0
  check() { # <name> <want token> <want rc> <decide args...>
    local name="$1" want="$2" want_rc="$3"; shift 3
    local out rc
    out="$(decide "$@" 2>/dev/null)"; rc=$?
    cases=$((cases + 1))
    if [ "$out" = "$want" ] && [ "$rc" -eq "$want_rc" ]; then pass=$((pass + 1)); echo "SELF-TEST: ok $name"
    else fail=$((fail + 1)); echo "SELF-TEST: FAIL $name (got '$out' rc=$rc, want '$want' rc=$want_rc)"; fi
  }
  local K='MUTATIONS killed=45 of=45' D='DDL_PARITY: PASS (12 columns, labeler DDL == migrations)'
  check all-pass-green CH2_GREEN 0 0 PASS passed "$K" "$D"
  check pass-after-isolation-green CH2_GREEN 0 0 PASS_AFTER_ISOLATION passed "$K" "$D"
  check build-failed-red CH2_RED 1 2 "" missing "" ""
  check suite-fail-red CH2_RED 1 0 FAIL passed "$K" "$D"
  check own-files-failed-red CH2_RED 1 0 PASS failed "$K" "$D"
  check a-surviving-mutation-red CH2_RED 1 0 PASS passed 'MUTATIONS killed=44 of=45' "$D"
  check ddl-fail-red CH2_RED 1 0 PASS passed "$K" 'DDL_PARITY: FAIL (only in migrations: [x])'
  check suite-unreadable-indeterminate CH2_INDETERMINATE 3 0 "" passed "$K" "$D"
  check own-files-missing-indeterminate CH2_INDETERMINATE 3 0 PASS missing "$K" "$D"
  check mutation-result-missing-indeterminate CH2_INDETERMINATE 3 0 PASS passed "" "$D"
  check a-failed-control-is-not-green CH2_INDETERMINATE 3 0 PASS passed 'MUTATIONS control=FAIL (tests/unit/lrw-race-window-v2.test.ts)' "$D"
  check a-short-matrix-is-not-green CH2_INDETERMINATE 3 0 PASS passed 'MUTATIONS killed=6 of=6' "$D"
  check ddl-indeterminate-is-not-green CH2_INDETERMINATE 3 0 PASS passed "$K" 'DDL_PARITY: INDETERMINATE (cannot read)'
  check red-outranks-indeterminate CH2_RED 1 0 FAIL missing "" ""
  # the missing-tool precondition, through the real entry point with a PATH that holds only bash
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/lrw-ch2-selftest.XXXXXX")" || { echo "LRW_CH2_GATE_SELFTEST: FAIL mktemp"; exit 1; }
  ln -s "$(command -v bash)" "$tmp/bash"
  local out rc errtxt
  errtxt="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>&1 >/dev/null)"
  out="$(env PATH="$tmp" "$tmp/bash" "${BASH_SOURCE[0]}" 2>/dev/null)"; rc=$?
  rm -rf "$tmp"
  cases=$((cases + 1))
  if [ "$out" = "CH2_INDETERMINATE" ] && [ "$rc" -eq 3 ] && printf '%s' "$errtxt" | grep -q "required tool 'node'"; then
    pass=$((pass + 1)); echo "SELF-TEST: ok missing-tool-indeterminate"
  else fail=$((fail + 1)); echo "SELF-TEST: FAIL missing-tool-indeterminate (got '$out' rc=$rc)"; fi
  if [ "$cases" -lt 15 ]; then echo "LRW_CH2_GATE_SELFTEST: FAIL vacuous ($cases cases)"; exit 1; fi
  if [ "$fail" -eq 0 ]; then echo "LRW_CH2_GATE_SELFTEST: PASS ($pass checks)"; exit 0; fi
  echo "LRW_CH2_GATE_SELFTEST: FAIL ($fail of $cases)"; exit 1
}

# sourceable: when sourced, define decide() and stop (no gate run)
if (return 0 2>/dev/null); then return 0; fi
if [ "${1:-}" = "--self-test" ]; then self_test; fi
run_gate
