#!/usr/bin/env bash
# OPS-GIT-IDENTITY-CANONICALIZE-W1 — author-identity gate (pre-commit block).
#
# Refuses a commit whose AUTHOR EMAIL is not in ops/author-identity-allowlist.json.
#
# WHY pre-commit AND NOT pre-push — load-bearing, do not "improve" this:
#   A pre-push hook's stdin is a SINGLE-CONSUMER STREAM, and scripts/check-push-safety.sh already
#   drains it (it sorts first by design and says so in its own installer). A second stdin-reading
#   block would receive an EMPTY stream and pass vacuously — a dark guard at exit 0, which is the
#   class this repo has now hit five times. pre-commit sidesteps the contention entirely, reads
#   `git var GIT_AUTHOR_IDENT`, and catches the fault one step EARLIER: before the commit object
#   exists, so there is nothing to rewrite afterwards.
#
# VERDICT TOKEN (the contract): exactly ONE terminal line
#     AUTHOR_IDENTITY_VERDICT=PASS|FAIL|INDETERMINATE
#   Callers gate on the TOKEN, never on the exit code. Exit codes are 0=PASS / 1=FAIL /
#   3=INDETERMINATE. 3 is the token-law DEFAULT for a NEW gate. Do NOT "align" it to
#   check_test_baseline.sh's 2 — that script is 2 only because it already DEPLOYED 2, and one
#   meaning with two codes inside a single script is the live footgun. Nothing reads both spaces.
#
# ROLLOUT: REPORT-first. In report mode a FAIL still prints FAIL and still ledgers, but exits 0 so
#   it does not block. Promotion needs BOTH promotion.max_violations AND promotion.not_before.
#
# ENV LEVER: ALGOVAULT_AUTHOR_IDENTITY=warn downgrades the exit CODE only, NEVER the token. There
#   is deliberately NO seam that can make this script print PASS: the self-test SOURCES this file
#   (see the SOURCED guard immediately below) and drives the pure functions directly, rather than
#   substituting an allowlist a fixture controls.
#
# USAGE
#   bash scripts/check-author-identity.sh              # gate (what the hook runs)
#   bash scripts/check-author-identity.sh --self-test  # two-way, vacuity-guarded suite
set -uo pipefail

# ── SOURCEABLE SEAM ─────────────────────────────────────────────────────────────────────────
# `return` succeeds only in a sourced context. When sourced, define the pure functions and stop
# before the gate body — this is how the test drives the predicate without an injection point
# that could print PASS. (CLAUDE.md's test-importable law, in shell.)
ALGOVAULT_AUTHOR_IDENTITY_SOURCED=0
(return 0 2>/dev/null) && ALGOVAULT_AUTHOR_IDENTITY_SOURCED=1

# ── PURE FUNCTIONS (the seam the hermetic self-test CAN reach) ───────────────────────────────
# A hermetic self-test is structurally blind to exactly what its own seam replaces, so the two
# things the gate body does that a fixture cannot — parse `git var GIT_AUTHOR_IDENT`, and load
# the allowlist — are extracted here and asserted directly.

# author_identity_exit_code <verdict> -> the code that verdict maps to.
# The MAPPING is a function, not a literal scattered through the gate body, so the self-test can
# assert token->code rather than only the token. Re-coding a mapping while the token stays right
# is precisely how a green suite once hid a broken INDETERMINATE path.
author_identity_exit_code() {
  case "${1:-}" in
    PASS) printf '0' ;;
    FAIL) printf '1' ;;
    *)    printf '3' ;;   # INDETERMINATE and anything unrecognised: fail-closed
  esac
}

# author_identity_parse_email "<GIT_AUTHOR_IDENT>" -> email on stdout, non-zero if unparseable.
# Input shape: `Name <email> <epoch> <tz>`  e.g. `A B <a@b.c> 1786265766 +0800`
# A display name may itself contain '<' (git strips it when committing, but we are handed the
# string and must not assume the producer sanitised it), so anchor on the LAST '<'.
author_identity_parse_email() {
  local ident="${1:-}" rest email
  [ -n "$ident" ] || return 1
  rest="$(printf '%s' "$ident" | sed -E 's/[[:space:]]+[0-9]+[[:space:]]+[+-][0-9]{4}[[:space:]]*$//')"
  case "$rest" in *'<'*'>'*) : ;; *) return 1 ;; esac
  email="${rest##*<}"      # everything after the LAST '<'
  email="${email%%>*}"     # up to the first '>' after it
  [ -n "$email" ] || return 1
  printf '%s' "$email"
}

# author_identity_parse_name "<GIT_AUTHOR_IDENT>" -> display name on stdout.
author_identity_parse_name() {
  local ident="${1:-}" rest name
  [ -n "$ident" ] || return 1
  rest="$(printf '%s' "$ident" | sed -E 's/[[:space:]]+[0-9]+[[:space:]]+[+-][0-9]{4}[[:space:]]*$//')"
  case "$rest" in *'<'*) : ;; *) return 1 ;; esac
  name="${rest%<*}"                                        # up to the LAST '<'
  name="$(printf '%s' "$name" | sed -E 's/[[:space:]]+$//')"
  printf '%s' "$name"
}

# author_identity_load <allowlist-path> -> "allowed<TAB>denied" (each newline-joined) on stdout.
# Non-zero on missing / unreadable / unparseable / EMPTY-allowed. VACUITY: we author this file, so
# an empty `allowed` is a defect in OUR config and must REFUSE. (Contrast the gate's INPUT, which
# the world supplies — see the note at the call site.)
author_identity_load() {
  local path="${1:-}" out
  [ -n "$path" ] && [ -f "$path" ] && [ -r "$path" ] || return 1
  command -v jq >/dev/null 2>&1 || return 2
  # `jq -r` + an explicit string test. Never `jq -e '<bare path>'`: that exits 0 for [], {}, ""
  # and 0, which is the vacuity hole scripts/check-jq-truthiness.mjs exists to make unwritable.
  out="$(jq -r '
      if (type != "object") then error("not an object")
      else
        ((.allowed  // []) | map(.email // empty) | join("\n")) + "\t" +
        ((.denied   // []) | map(.email // empty) | join("\n"))
      end' "$path" 2>/dev/null)" || return 3
  [ -n "${out%%	*}" ] || return 4      # empty allowed[] => vacuous allowlist => refuse
  printf '%s' "$out"
}

# author_identity_evaluate <email> <allowed-newline-list> <denied-newline-list> -> verdict token.
author_identity_evaluate() {
  local email="${1:-}" allowed="${2:-}" denied="${3:-}" e
  [ -n "$email" ]   || { printf 'INDETERMINATE'; return; }
  [ -n "$allowed" ] || { printf 'INDETERMINATE'; return; }   # vacuous allowlist never passes
  while IFS= read -r e; do
    [ -n "$e" ] && [ "$e" = "$email" ] && { printf 'PASS'; return; }
  done <<EOF
$allowed
EOF
  while IFS= read -r e; do
    [ -n "$e" ] && [ "$e" = "$email" ] && { printf 'FAIL'; return; }
  done <<EOF
$denied
EOF
  printf 'FAIL'        # ALLOWLIST semantics: absent => not allowed. `denied` only sharpens the message.
}

# author_identity_reason <email> <allowlist-path> -> the denied[] reason, when there is one.
author_identity_reason() {
  local email="${1:-}" path="${2:-}"
  [ -f "$path" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  jq -r --arg e "$email" '(.denied // []) | map(select(.email == $e)) | if length > 0 then .[0].reason else "" end' \
    "$path" 2>/dev/null
}

# ── PROMOTION MEASUREMENT (OPS-AUTHOR-IDENTITY-PROMOTE-W1) ──────────────────────────────────
# The ledger contains its own CALIBRATION: the wave that built this guard proved it could fail,
# and proving a guard can fail necessarily writes FAIL rows. Measuring max_violations over the
# WHOLE ledger therefore counts the wrong population, and since those rows never age out the
# criterion could never be satisfied — in perpetuity. promotion.measure_from cuts the calibration
# out of the population without touching the instrument, and min_rows_in_window stops an empty
# window from being a free pass.
#
# These are pure functions so the hermetic self-test can drive them against temp ledgers. The
# gate body never calls them, and `--measure-promotion` returns before the gate body runs.

# author_identity_bucket_commits <from-epoch> <allowed-list> <oos-list>   [reads TSV on STDIN]
#
#   stdin  : "<sha>\t<author-email>\t<committer-epoch>" per line — `git log --all --format=...`
#   stdout : COUNTS  <total> <before> <in_window> <oos> <in_scope> <refused>
#            OOS     <email> <n>     one line per DECLARED out-of-scope identity, zeros included
#            REFUSED <email> <n>     one line per refusing identity
#
# ── WHY EPOCH SECONDS AND NEVER AN ISO STRING ────────────────────────────────────────────────
# `git log --format=%cI` renders each commit in ITS OWN timezone offset. A lexicographic compare
# against a Z-suffixed bound therefore mis-buckets every non-UTC commit, and it does so silently,
# with a number that looks entirely reasonable. Measured on this repo at spec time: string
# bucketing reported 21 in-window violations and BLOCKED; epoch bucketing over the identical
# window reported 0 and READY. The 21 were all commits stamped +08:00 whose real instants were
# BEFORE the boundary — `2026-08-09T18:51:09+08:00` is 10:51:09Z, 39 minutes earlier than a
# boundary it string-sorts after. That is a measurement artifact read as signal, which is the
# same failure mode as the calibration rows that HALTed the previous wave. Use %ct. Always.
#
# Pure: reads stdin, shells out to nothing. The self-test drives it with fixture TSV, and the
# REAL `git log` invocation is asserted separately — a hermetic test is structurally blind to
# exactly the seam it replaces.
author_identity_bucket_commits() {
  from="${1:-}" allowed="${2:-}" oos="${3:-}"
  case "$from" in ''|*[!0-9]*) return 2 ;; esac
  awk -F'\t' -v from="$from" -v allowed="$allowed" -v oos="$oos" '
    BEGIN {
      n = split(allowed, A, " "); for (i = 1; i <= n; i++) if (A[i] != "") AL[A[i]] = 1;
      m = split(oos, O, " ");     for (i = 1; i <= m; i++) if (O[i] != "") { OS[O[i]] = 1; OC[O[i]] = 0 }
    }
    NF >= 3 {
      total++;
      if ($3 + 0 < from + 0) { before++; next }
      inwin++;
      if ($2 in OS) { oosn++; OC[$2]++; next }
      inscope++;
      if (!($2 in AL)) { refused++; RC[$2]++ }
    }
    END {
      printf "COUNTS %d %d %d %d %d %d\n", total+0, before+0, inwin+0, oosn+0, inscope+0, refused+0;
      # Report EVERY declared exclusion, including the zeros: an exclusion that is not reported is
      # indistinguishable from a bug, and a zero is the case most likely to be silently wrong.
      for (e in OC) printf "OOS %s %d\n", e, OC[e];
      for (e in RC) printf "REFUSED %s %d\n", e, RC[e];
    }
  '
}

# author_identity_count_indeterminate <ledger-path> <measure-from-ts> -> "<n>"
#
# The ONE bar that git history cannot answer. Git records commits, not verdicts, so an
# INDETERMINATE rate is invisible to the primary population — and it is the failure mode that
# matters most under BLOCK, because ALGOVAULT_AUTHOR_IDENTITY=warn downgrades only a FAIL and
# leaves an INDETERMINATE refusing the commit with no per-invocation escape. This is a declared
# SECONDARY population (see instrument.reason), never the violation count.
# ISO-8601 Z timestamps sort lexicographically, so a string compare IS a time compare here — the
# ledger writes Z exclusively, unlike git, which is why this one may compare strings.
author_identity_count_indeterminate() {
  ledger="${1:-}" from="${2:-}"
  [ -n "$ledger" ] && [ -f "$ledger" ] && [ -r "$ledger" ] || return 1
  [ -n "$from" ] || return 2
  awk -F'\t' -v from="$from" '$1 >= from && $2 == "INDETERMINATE" { n++ } END { printf "%d", n+0 }' "$ledger"
}

# author_identity_promotion_verdict <refused> <in_scope> <max_violations> <min_commits>
#                                   [<indeterminate> <max_indeterminate>]
# Order matters: the SAMPLE FLOOR is checked before the violation count. Too few observations is
# "we have not looked", which is INDETERMINATE — never READY, and never BLOCKED either.
# The indeterminate bar is checked LAST and only when supplied, so a caller that does not measure
# it (the hermetic fixtures) keeps the original four-argument contract.
author_identity_promotion_verdict() {
  local refused="${1:-}" inscope="${2:-}" maxv="${3:-}" minc="${4:-}" indet="${5:-}" maxi="${6:-}" v
  # Validate each value SEPARATELY. Do not build one delimited string and match a bracket
  # expression against it: inside a `case` pattern an unescaped `|` is the ALTERNATION separator
  # even within [...], so `*[!0-9|]*` silently parses as two broken patterns and the guard never
  # fires. The self-test caught exactly that here — a non-numeric input reached `[ -gt ]` and
  # returned READY on an integer-expression error.
  for v in "$refused" "$inscope" "$maxv" "$minc"; do
    case "$v" in ''|*[!0-9]*) printf 'INDETERMINATE'; return ;; esac
  done
  if [ "$inscope" -lt "$minc" ]; then printf 'INDETERMINATE'; return; fi
  if [ "$refused" -gt "$maxv" ]; then printf 'BLOCKED'; return; fi
  if [ -n "$indet" ] || [ -n "$maxi" ]; then
    for v in "$indet" "$maxi"; do
      case "$v" in ''|*[!0-9]*) printf 'INDETERMINATE'; return ;; esac
    done
    if [ "$indet" -gt "$maxi" ]; then printf 'BLOCKED'; return; fi
  fi
  printf 'READY'
}

# author_identity_promotion_exit_code <verdict> -> 0 READY / 1 BLOCKED / 3 INDETERMINATE.
# Same token-law shape as author_identity_exit_code, and asserted the same way: a re-coded
# mapping with a correct token is a green suite over a broken gate.
author_identity_promotion_exit_code() {
  case "${1:-}" in
    READY)   printf '0' ;;
    BLOCKED) printf '1' ;;
    *)       printf '3' ;;
  esac
}

[ "$ALGOVAULT_AUTHOR_IDENTITY_SOURCED" = "1" ] && return 0 2>/dev/null

# ══ NON-GATE FLAGS ══════════════════════════════════════════════════════════════════════════
# ONE dispatch for every non-gate flag, deliberately: this file is on the SHARED pre-commit path
# that governs every linked worktree, so a second `if` here would be a second string compare on
# every commit in the repo. A `case` with two branches costs the commit path exactly what the
# single `if` it replaced cost. Both branches return BEFORE the gate body.
case "${1:-}" in
--measure-promotion)
  # OPS-PROMOTION-INSTRUMENT-INDEPENDENCE-W1 CH2 R2.2 — the violation count is computed FROM GIT
  # HISTORY. The ledger is read for exactly one thing, the INDETERMINATE rate, which git cannot
  # see; it is never consulted for the violation count.
  #
  # This flag creates no commit and appends no ledger row, so running it CANNOT MOVE ANY COUNT IT
  # REPORTS. That is the whole point: under the old ledger instrument, a deliberate run could and
  # did write the FAIL row that blocked promotion.
  #
  # Prints SIX counts — never a bare verdict, because "0 violations" means nothing without the
  # window it was measured over, the sample that filled it, and what was excluded from both.
  REPO_ROOT_MP="$(git rev-parse --show-toplevel 2>/dev/null || printf '')"
  if [ -z "$REPO_ROOT_MP" ]; then
    printf '✖ measure-promotion: not inside a git repository.\n' >&2
    printf 'PROMOTION_MEASURE_VERDICT=INDETERMINATE\n'; exit 3
  fi
  ALLOWLIST_MP="$REPO_ROOT_MP/ops/author-identity-allowlist.json"
  LEDGER_MP="$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd)/algovault-author-identity.log"
  if ! command -v jq >/dev/null 2>&1 || [ ! -f "$ALLOWLIST_MP" ]; then
    printf '✖ measure-promotion: jq missing or allowlist unreadable at %s\n' "$ALLOWLIST_MP" >&2
    printf 'PROMOTION_MEASURE_VERDICT=INDETERMINATE\n'; exit 3
  fi
  FROM_MP="$(jq -r '.promotion.measure_from // ""' "$ALLOWLIST_MP" 2>/dev/null)"
  MINC_MP="$(jq -r '.promotion.min_commits_in_window // ""' "$ALLOWLIST_MP" 2>/dev/null)"
  MAXV_MP="$(jq -r '.promotion.max_violations // ""' "$ALLOWLIST_MP" 2>/dev/null)"
  MAXI_MP="$(jq -r '.promotion.max_indeterminate_in_window // ""' "$ALLOWLIST_MP" 2>/dev/null)"
  MODE_MP="$(jq -r '.promotion.mode // ""' "$ALLOWLIST_MP" 2>/dev/null)"
  NB_MP="$(jq -r '.promotion.not_before // ""' "$ALLOWLIST_MP" 2>/dev/null)"
  ALLOWED_MP="$(jq -r '[.allowed[].email] | join(" ")' "$ALLOWLIST_MP" 2>/dev/null)"
  OOS_MP="$(jq -r '[(.out_of_scope_identities // [])[].email] | join(" ")' "$ALLOWLIST_MP" 2>/dev/null)"
  # measure_from is an ISO-8601 Z instant in config and an EPOCH everywhere it is compared.
  # Convert ONCE, here, so no comparison downstream can accidentally be lexicographic.
  FROMEPOCH_MP="$(date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$FROM_MP" +%s 2>/dev/null \
                  || date -u -d "$FROM_MP" +%s 2>/dev/null || printf '')"
  printf 'promotion.mode                 : %s\n' "${MODE_MP:-(unset)}"
  printf 'promotion.not_before           : %s   (today %s)\n' "${NB_MP:-(unset)}" "$(date -u +%Y-%m-%d)"
  printf 'promotion.measure_from         : %s   (epoch %s)\n' "${FROM_MP:-(unset)}" "${FROMEPOCH_MP:-?}"
  printf 'promotion.min_commits_in_window: %s\n' "${MINC_MP:-(unset)}"
  printf 'promotion.max_violations       : %s\n' "${MAXV_MP:-(unset)}"
  printf 'promotion.max_indeterminate    : %s\n' "${MAXI_MP:-(unset)}"
  printf 'primary population             : git log --all (commits) — NOT the ledger\n'
  printf 'secondary population           : %s   (INDETERMINATE rate only)\n' "$LEDGER_MP"
  if [ -z "$FROMEPOCH_MP" ] || [ -z "$ALLOWED_MP" ]; then
    printf '✖ measure-promotion: measure_from unparseable or allowed[] empty. WE author this file, so that is our defect, not a fact about the world.\n' >&2
    printf 'PROMOTION_MEASURE_VERDICT=INDETERMINATE\n'; exit 3
  fi
  BUCKET_MP="$(git log --all --format='%H%x09%ae%x09%ct' 2>/dev/null \
               | sort -u -k1,1 \
               | author_identity_bucket_commits "$FROMEPOCH_MP" "$ALLOWED_MP" "$OOS_MP")" || BUCKET_MP=''
  COUNTS_MP="$(printf '%s\n' "$BUCKET_MP" | awk '$1=="COUNTS"{print; exit}')"
  if [ -z "$COUNTS_MP" ]; then
    printf '✖ measure-promotion: could not bucket git history. An ABSENT measurement is not a clean one.\n' >&2
    printf 'PROMOTION_MEASURE_VERDICT=INDETERMINATE\n'; exit 3
  fi
  TOT_MP="$(printf '%s' "$COUNTS_MP"  | awk '{print $2}')"
  BEF_MP="$(printf '%s' "$COUNTS_MP"  | awk '{print $3}')"
  WIN_MP="$(printf '%s' "$COUNTS_MP"  | awk '{print $4}')"
  OOS_N_MP="$(printf '%s' "$COUNTS_MP" | awk '{print $5}')"
  INS_MP="$(printf '%s' "$COUNTS_MP"  | awk '{print $6}')"
  REF_MP="$(printf '%s' "$COUNTS_MP"  | awk '{print $7}')"
  printf 'commits_total_all_refs         : %s\n' "$TOT_MP"
  printf 'commits_before_measure_from    : %s\n' "$BEF_MP"
  printf 'commits_in_window              : %s\n' "$WIN_MP"
  printf '  in_window_out_of_scope       : %s\n' "$OOS_N_MP"
  printf '%s\n' "$BUCKET_MP" | awk '$1=="OOS"{ printf "      %-44s %s\n", $2, $3 }' | sort
  printf '  in_window_in_scope           : %s   (floor %s)\n' "$INS_MP" "${MINC_MP:-?}"
  printf '  in_window_would_be_refused   : %s   (bar %s)\n' "$REF_MP" "${MAXV_MP:-?}"
  printf '%s\n' "$BUCKET_MP" | awk '$1=="REFUSED"{ printf "      %-44s %s\n", $2, $3 }' | sort
  # The one bar git cannot answer. A missing ledger is not a clean ledger.
  if ! INDET_MP="$(author_identity_count_indeterminate "$LEDGER_MP" "$FROM_MP")"; then
    printf '✖ measure-promotion: ledger missing/unreadable, so the INDETERMINATE rate is unknown.\n' >&2
    printf 'PROMOTION_MEASURE_VERDICT=INDETERMINATE\n'; exit 3
  fi
  printf '  ledger_indeterminate_in_window: %s   (bar %s, secondary population)\n' "$INDET_MP" "${MAXI_MP:-?}"
  VERDICT_MP="$(author_identity_promotion_verdict "$REF_MP" "$INS_MP" "$MAXV_MP" "$MINC_MP" "$INDET_MP" "$MAXI_MP")"
  printf 'PROMOTION_MEASURE_VERDICT=%s\n' "$VERDICT_MP"
  exit "$(author_identity_promotion_exit_code "$VERDICT_MP")"
  ;;
--self-test)
  PASSED=0; FAILED=0
  # Assertions must never RAISE. An assertion that aborts the suite silently converts
  # "proven able to fail" into "crashes", and the run reads as tooling breakage, not a verdict.
  ok() { # ok <label> <actual> <expected>
    if [ "$2" = "$3" ]; then PASSED=$((PASSED+1))
    else FAILED=$((FAILED+1)); printf 'SELF-TEST: FAIL (%s) expected=[%s] actual=[%s]\n' "$1" "$3" "$2" >&2; fi
  }

  TD="$(mktemp -d "${TMPDIR:-/tmp}/author-identity-selftest.XXXXXX")" || {
    printf 'AUTHOR_IDENTITY_VERDICT=INDETERMINATE\n'; exit 3; }
  trap 'rm -rf "$TD"' EXIT           # BSD mktemp: XXXXXX must be TERMINAL; -d + trap is canonical

  # --- fixtures built with the REAL extractor, never hand-written shapes it never emits -------
  REAL_IDENT="$(git var GIT_AUTHOR_IDENT 2>/dev/null || printf '')"

  # (1) parser — including the two shapes a naive `cut -d'<'` gets wrong
  ok parse-simple   "$(author_identity_parse_email 'AlgoVaultFi <a@b.com> 1786265766 +0800')" 'a@b.com'
  ok parse-spacename "$(author_identity_parse_email 'AlgoVault Operator <x@y.z> 1700000000 -0500')" 'x@y.z'
  ok parse-anglename "$(author_identity_parse_email 'Weird <Name <deep@mail.io> 1754700000 +0000')" 'deep@mail.io'
  ok parse-name     "$(author_identity_parse_name  'AlgoVault Operator <x@y.z> 1700000000 -0500')" 'AlgoVault Operator'
  author_identity_parse_email 'no-brackets-here 1 +0000' >/dev/null 2>&1; ok parse-garbage "$?" 1
  author_identity_parse_email '' >/dev/null 2>&1;         ok parse-empty   "$?" 1

  # SEAM: push a REAL `git var GIT_AUTHOR_IDENT` through the parser. This is the one assertion the
  # hermetic fixtures above cannot make, and it is the whole reason this block exists.
  if [ -n "$REAL_IDENT" ]; then
    RE="$(author_identity_parse_email "$REAL_IDENT")"
    case "$RE" in *@*) ok seam-real-ident 'has-at' 'has-at' ;; *) ok seam-real-ident "$RE" 'has-at' ;; esac
  else
    ok seam-real-ident 'no-git' 'no-git'   # counted, so the suite is never silently short
  fi

  # (2) loader — valid / empty-allowed / unparseable / missing
  printf '{"allowed":[{"email":"good@x.com"}],"denied":[{"email":"bad@y.com"}]}\n' > "$TD/ok.json"
  printf '{"allowed":[],"denied":[]}\n'                                            > "$TD/empty.json"
  printf 'this is not json at all {{{\n'                                           > "$TD/broken.json"
  L="$(author_identity_load "$TD/ok.json")";  ok load-ok "$(printf '%s' "$L" | tr '\t' '|')" 'good@x.com|bad@y.com'
  author_identity_load "$TD/empty.json"  >/dev/null 2>&1; ok load-empty      "$?" 4
  author_identity_load "$TD/broken.json" >/dev/null 2>&1; ok load-unparseable "$?" 3
  author_identity_load "$TD/nope.json"   >/dev/null 2>&1; ok load-missing     "$?" 1

  # (3) evaluate — two-way: it must PASS the good and FAIL the bad
  ok eval-allowed  "$(author_identity_evaluate 'good@x.com' 'good@x.com' 'bad@y.com')" PASS
  ok eval-denied   "$(author_identity_evaluate 'bad@y.com'  'good@x.com' 'bad@y.com')" FAIL
  ok eval-unknown  "$(author_identity_evaluate 'who@z.com'  'good@x.com' 'bad@y.com')" FAIL
  ok eval-multi    "$(author_identity_evaluate 'two@x.com'  "$(printf 'one@x.com\ntwo@x.com')" '')" PASS
  ok eval-vacuous  "$(author_identity_evaluate 'good@x.com' '' 'bad@y.com')" INDETERMINATE
  ok eval-noemail  "$(author_identity_evaluate '' 'good@x.com' '')" INDETERMINATE

  # (4) the LIVE allowlist must itself be non-vacuous and must judge the real addresses correctly
  REPO_ROOT_ST="$(git rev-parse --show-toplevel 2>/dev/null || printf '.')"
  LIVE="$REPO_ROOT_ST/ops/author-identity-allowlist.json"
  if LL="$(author_identity_load "$LIVE")"; then
    LA="${LL%%	*}"; LD="${LL#*	}"
    ok live-canonical "$(author_identity_evaluate '264139505+AlgoVaultFi@users.noreply.github.com' "$LA" "$LD")" PASS
    ok live-megatron  "$(author_identity_evaluate '268183053+Megatron888-Robot@users.noreply.github.com' "$LA" "$LD")" PASS
    ok live-test      "$(author_identity_evaluate 'test@test.local' "$LA" "$LD")" FAIL
    ok live-gmail     "$(author_identity_evaluate 'megatronwarlord1998@gmail.com' "$LA" "$LD")" FAIL
    ok live-personal  "$(author_identity_evaluate 'diophantus.hau@gmail.com' "$LA" "$LD")" FAIL
    ok live-admin     "$(author_identity_evaluate 'admin@algovault.com' "$LA" "$LD")" FAIL
  else
    ok live-allowlist-loadable 'load-failed' 'loadable'
  fi

  # (5) token -> EXIT CODE mapping. Asserting the token alone once left a re-coded INDETERMINATE
  # mapping fully green; the mapping is therefore asserted directly.
  ok map-pass  "$(author_identity_exit_code PASS)" 0
  ok map-fail  "$(author_identity_exit_code FAIL)" 1
  ok map-indet "$(author_identity_exit_code INDETERMINATE)" 3
  ok map-junk  "$(author_identity_exit_code wat)" 3

  # (6) PROMOTION MEASUREMENT — two-way, against REAL ledger files this test builds.
  # Fixtures use the real 4-field row shape the gate body emits, never a hand-invented one.
  mkledger() { # mkledger <path> <n_pass_in_window> <n_fail_in_window> <n_calibration_before>
    local p="$1" np="$2" nf="$3" nb="$4" i
    : >"$p"
    i=0; while [ "$i" -lt "$nb" ]; do
      printf '2026-08-09T10:55:51Z\tFAIL\t/tmp/calib\ttest@test.local\n' >>"$p"; i=$((i+1)); done
    i=0; while [ "$i" -lt "$np" ]; do
      printf '2026-08-10T00:00:00Z\tPASS\t/tmp/repo\tgood@x.com\n' >>"$p"; i=$((i+1)); done
    i=0; while [ "$i" -lt "$nf" ]; do
      printf '2026-08-11T00:00:00Z\tFAIL\t/tmp/repo\tbad@y.com\n' >>"$p"; i=$((i+1)); done
  }
  CUT='2026-08-09T11:07:26Z'
  CUTEPOCH=1786273646            # == CUT, converted once; every commit compare is integer
  AL='good@x.com'
  OS='ci@algovault.com'

  # ── the git-history bucketer (OPS-PROMOTION-INSTRUMENT-INDEPENDENCE-W1 CH2 R2.2) ─────────────
  # Fed fixture TSV in the SAME shape `git log --all --format='%H%x09%ae%x09%ct'` emits.
  bucket() { printf '%s' "$1" | author_identity_bucket_commits "$CUTEPOCH" "$AL" "$OS" | awk '$1=="COUNTS"{printf "%s|%s|%s|%s|%s|%s",$2,$3,$4,$5,$6,$7}'; }
  TSV_BASIC="$(printf 'a\t%s\t%s\nb\t%s\t%s\nc\t%s\t%s\n' \
    "$AL" $((CUTEPOCH-3600)) "$AL" $((CUTEPOCH+60)) "$OS" $((CUTEPOCH+120)))"
  # total|before|in_window|out_of_scope|in_scope|refused
  ok bkt-basic "$(bucket "$TSV_BASIC")" '3|1|2|1|1|0'

  # the boundary is INCLUSIVE (>=), so a commit exactly ON measure_from is IN the window
  ok bkt-inclusive "$(bucket "$(printf 'a\t%s\t%s\n' "$AL" "$CUTEPOCH")")" '1|0|1|0|1|0'

  # an identity in NEITHER list is a VIOLATION, and stays in the denominator
  ok bkt-unlisted "$(bucket "$(printf 'a\t%s\t%s\nb\tnobody@example.invalid\t%s\n' \
    "$AL" $((CUTEPOCH+60)) $((CUTEPOCH+90)))")" '2|0|2|0|2|1'

  # out-of-scope is subtracted from BOTH numerator and denominator, never counted as a violation
  ok bkt-oos-both "$(bucket "$(printf 'a\t%s\t%s\n' "$OS" $((CUTEPOCH+60)))")" '1|0|1|1|0|0'

  # EVERY declared exclusion is reported, INCLUDING a zero — an unreported exclusion is
  # indistinguishable from a bug, and the zero is the case most likely to be silently wrong
  ok bkt-reports-zero "$(printf 'a\t%s\t%s\n' "$AL" $((CUTEPOCH+60)) \
    | author_identity_bucket_commits "$CUTEPOCH" "$AL" "$OS" | awk -v e="$OS" '$1=="OOS"&&$2==e{print $3}')" 0
  # ...and a refusing identity is named, not merely counted
  ok bkt-names-refuser "$(printf 'a\tnobody@example.invalid\t%s\n' $((CUTEPOCH+60)) \
    | author_identity_bucket_commits "$CUTEPOCH" "$AL" "$OS" | awk '$1=="REFUSED"{print $2}')" 'nobody@example.invalid'

  # THE EPOCH REGRESSION. A +08:00 commit 10 minutes BEFORE the bound renders as 18:xx and
  # string-sorts AFTER it. On the live repo that artifact turned 0 violations into 21 and READY
  # into BLOCKED. Bucketing on %ct keeps it before the bound, where it belongs.
  ok bkt-epoch-not-string "$(bucket "$(printf 'a\ttest@test.local\t%s\n' $((CUTEPOCH-600)))")" '1|1|0|0|0|0'
  ok bkt-nonnum-from "$(author_identity_bucket_commits 'not-an-epoch' "$AL" "$OS" </dev/null >/dev/null 2>&1; printf '%s' $?)" 2

  # ── the ledger-side INDETERMINATE bar (R2.5): the one thing git history cannot see ───────────
  mkledger "$TD/l1" 40 0 7
  ok indet-none "$(author_identity_count_indeterminate "$TD/l1" "$CUT")" 0
  printf '2026-08-11T00:00:00Z\tINDETERMINATE\t/tmp/repo\t?\n' >>"$TD/l1"
  ok indet-one "$(author_identity_count_indeterminate "$TD/l1" "$CUT")" 1
  author_identity_count_indeterminate "$TD/nope" "$CUT" >/dev/null 2>&1; ok indet-missing-ledger "$?" 1
  author_identity_count_indeterminate "$TD/l1" ''     >/dev/null 2>&1; ok indet-no-from "$?" 2

  # ── the verdict function ─────────────────────────────────────────────────────────────────────
  # clean window at or above the floor => READY
  ok win-ready "$(author_identity_promotion_verdict 0 40 0 30)" READY
  # a REAL in-window violation => BLOCKED (this is the case the whole flag exists to catch)
  ok win-blocked "$(author_identity_promotion_verdict 2 42 0 30)" BLOCKED
  # under the sample floor => INDETERMINATE, never READY: an empty window is a free pass
  ok win-floor "$(author_identity_promotion_verdict 0 5 0 30)" INDETERMINATE
  ok win-empty "$(author_identity_promotion_verdict 0 0 0 30)" INDETERMINATE
  # floor is checked BEFORE violations: a tiny window with a violation is still "we have not looked"
  ok win-floor-beats-fail "$(author_identity_promotion_verdict 2 5 0 30)" INDETERMINATE
  # non-numeric / missing config values must never fall through to READY
  ok win-nonnum "$(author_identity_promotion_verdict 0 40 '' 30)" INDETERMINATE
  ok win-garbage "$(author_identity_promotion_verdict x 40 0 30)" INDETERMINATE
  # the INDETERMINATE bar blocks even when git history is spotless, and a garbage bar never passes
  ok win-indet-blocks "$(author_identity_promotion_verdict 0 40 0 30 1 0)" BLOCKED
  ok win-indet-ok     "$(author_identity_promotion_verdict 0 40 0 30 0 0)" READY
  ok win-indet-nonnum "$(author_identity_promotion_verdict 0 40 0 30 x 0)" INDETERMINATE

  # ── THE SEAM THIS HERMETIC SUITE OTHERWISE REPLACES ─────────────────────────────────────────
  # Every assertion above feeds the bucketer fixture TSV, so the one thing no scenario exercises
  # is the REAL `git log` invocation that produces it — and a format string is exactly the kind of
  # thing that rots silently. Assert the literal shipped in the flag body: three tab-separated
  # fields, author email, and COMMITTER EPOCH (%ct), never %cI.
  #
  # The greps EXCLUDE the self-test's own assertion lines. Without that, each one matches the
  # literal it carries and counts itself — a ban-line satisfying its own ban is the classic dead
  # canary, and it reads as a healthy 0 becoming a mysterious 1.
  SELF_SRC="${ALGOVAULT_AUTHOR_IDENTITY_SELF_SRC:-$0}"
  if [ -r "$SELF_SRC" ]; then
    # Anchored to the EXECUTABLE lines, not the file: the same literals legitimately appear in a
    # comment and in a printf label, so a file-wide count asserts a number nobody can reason about.
    seamsrc() { grep -v '^  *ok seam-' "$SELF_SRC"; }
    ok seam-git-format "$(seamsrc | grep -c "BUCKET_MP=\"\$(git log --all --format='%H%x09%ae%x09%ct'")" 1
    ok seam-no-iso-format "$(seamsrc | grep -c "format='%H%x09%ae%x09%cI'")" 0
    ok seam-reads-min-commits "$(seamsrc | grep -c "jq -r '\.promotion\.min_commits_in_window")" 1
    ok seam-no-stale-min-rows "$(seamsrc | grep -c "jq -r '\.promotion\.min_rows_in_window")" 0
    # ...and the exclusion itself must not be vacuous: if it ever filtered the WHOLE file the four
    # assertions above would all read 0 and two of them would pass for the wrong reason.
    ok seam-filter-not-vacuous "$([ "$(seamsrc | wc -l | tr -d ' ')" -gt 300 ] && printf yes || printf no)" yes
  fi
  # token -> exit code mapping for the promotion verdict, asserted directly
  ok pmap-ready   "$(author_identity_promotion_exit_code READY)" 0
  ok pmap-blocked "$(author_identity_promotion_exit_code BLOCKED)" 1
  ok pmap-indet   "$(author_identity_promotion_exit_code INDETERMINATE)" 3
  ok pmap-junk    "$(author_identity_promotion_exit_code wat)" 3

  # VACUITY GUARD: in --self-test WE build the corpus, so an empty one means the test built
  # nothing — a defect in the test. REFUSE. (At runtime the WORLD builds the corpus, so empty
  # there is a fact, not vacuity. Empty-vs-unparseable is the line, not empty-vs-non-empty.)
  TOTAL=$((PASSED+FAILED))
  if [ "$TOTAL" -eq 0 ]; then
    printf 'SELF-TEST: vacuous — zero assertions executed.\n' >&2
    printf 'AUTHOR_IDENTITY_VERDICT=INDETERMINATE\n'; exit 3
  fi
  printf 'SELF-TEST: %d passed, %d failed (%d assertions)\n' "$PASSED" "$FAILED" "$TOTAL"
  if [ "$FAILED" -gt 0 ]; then printf 'AUTHOR_IDENTITY_VERDICT=FAIL\n'; exit "$(author_identity_exit_code FAIL)"; fi
  printf 'AUTHOR_IDENTITY_VERDICT=PASS\n'; exit "$(author_identity_exit_code PASS)"
  ;;
esac

# ══ GATE BODY ═══════════════════════════════════════════════════════════════════════════════
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '')"
if [ -z "$REPO_ROOT" ]; then
  printf '✖ author-identity: not inside a git repository.\n' >&2
  printf 'AUTHOR_IDENTITY_VERDICT=INDETERMINATE\n'; exit 3
fi
ALLOWLIST="${REPO_ROOT}/ops/author-identity-allowlist.json"
COMMON_DIR="$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd || printf '')"
LEDGER="${COMMON_DIR:-/tmp}/algovault-author-identity.log"

emit() { # emit <verdict> ; ledger + the ONE terminal token + the mapped (possibly levered) code
  local verdict="$1" code
  code="$(author_identity_exit_code "$verdict")"
  printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$verdict" "$REPO_ROOT" "${EMAIL:-unparsed}" \
    >>"$LEDGER" 2>/dev/null || true
  # REPORT mode and the warn lever both downgrade the CODE. Neither ever launders the TOKEN.
  if [ "$verdict" = "FAIL" ] && { [ "$MODE" = "report" ] || [ "${ALGOVAULT_AUTHOR_IDENTITY:-}" = "warn" ]; }; then
    code=0
  fi
  printf 'AUTHOR_IDENTITY_VERDICT=%s\n' "$verdict"
  exit "$code"
}

MODE=block
if command -v jq >/dev/null 2>&1 && [ -f "$ALLOWLIST" ]; then
  M="$(jq -r 'if (.promotion.mode // "") == "" then "block" else .promotion.mode end' "$ALLOWLIST" 2>/dev/null)"
  [ -n "$M" ] && MODE="$M"
fi

if ! LOADED="$(author_identity_load "$ALLOWLIST")"; then
  RC=$?
  case "$RC" in
    2) printf '✖ author-identity: jq not found — cannot read %s\n' "$ALLOWLIST" >&2 ;;
    4) printf '✖ author-identity: allowlist has an EMPTY allowed[] — we author this file, so empty is a defect in our config, not a fact about the world.\n' >&2 ;;
    *) printf '✖ author-identity: allowlist missing or unparseable at %s\n' "$ALLOWLIST" >&2 ;;
  esac
  EMAIL=''
  emit INDETERMINATE
fi
ALLOWED="${LOADED%%	*}"; DENIED="${LOADED#*	}"

IDENT="$(git var GIT_AUTHOR_IDENT 2>/dev/null || printf '')"
if [ -z "$IDENT" ]; then
  printf '✖ author-identity: git could not resolve an author identity.\n' >&2
  printf '  With user.useConfigOnly=true this is git REFUSING to guess — set user.email for this repo.\n' >&2
  EMAIL=''
  emit INDETERMINATE
fi
# An identity we were HANDED and cannot parse is INDETERMINATE, always — never a pass.
if ! EMAIL="$(author_identity_parse_email "$IDENT")"; then
  printf '✖ author-identity: could not parse GIT_AUTHOR_IDENT: %s\n' "$IDENT" >&2
  EMAIL=''
  emit INDETERMINATE
fi
NAME="$(author_identity_parse_name "$IDENT" 2>/dev/null || printf '')"

VERDICT="$(author_identity_evaluate "$EMAIL" "$ALLOWED" "$DENIED")"
if [ "$VERDICT" = "FAIL" ]; then
  printf '✖ author-identity: this commit would be authored %s <%s>, which is not allowlisted.\n' "$NAME" "$EMAIL" >&2
  REASON="$(author_identity_reason "$EMAIL" "$ALLOWLIST")"
  [ -n "$REASON" ] && printf '  Known-bad address. %s\n' "$REASON" >&2
  printf '  Allowlist: %s\n' "$ALLOWLIST" >&2
  printf '  Fix:  git config --local --unset-all user.email && git config --local --unset-all user.name\n' >&2
  printf '        (prefer inheriting ~/.gitconfig over restating the value in a second place)\n' >&2
  [ "$MODE" = "report" ] && printf '  REPORT mode — reporting, not blocking. Promotion: see promotion{} in the allowlist.\n' >&2
elif [ "$VERDICT" = "PASS" ]; then
  printf 'author-identity: %s <%s> — allowlisted.\n' "$NAME" "$EMAIL"
fi
emit "$VERDICT"
