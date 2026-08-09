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

[ "$ALGOVAULT_AUTHOR_IDENTITY_SOURCED" = "1" ] && return 0 2>/dev/null

# ══ SELF-TEST ═══════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--self-test" ]; then
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
fi

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
