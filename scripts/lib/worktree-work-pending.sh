#!/usr/bin/env bash
# worktree-work-pending.sh — OPS-WORKTREE-WORK-PENDING-W1 CH1
#
# THE ONE PREDICATE for "is there unlanded WORK in this worktree?"
#
# SINGLE DERIVATION, deliberately — and the sibling of scripts/lib/branch-work-landed.sh,
# whose shape this mirrors. That script answers "has this worktree's work LANDED?"; there
# was no counterpart for "is there uncommitted WORK here", so every consumer re-derived it
# from raw `git status` line counts. That is the same unchecked-definition defect that
# produced the retracted "30 unpushed commits across 7 worktrees" figure: a number measured
# by a definition nobody had checked.
#
# ── WHY "DIRTY" IS NOT "WORK" ────────────────────────────────────────────────
#
# The dominant term in this estate's dirty count has been NOISE, not work. `.gitignore`'s
# `node_modules/` carries a trailing slash, which per gitignore(5) matches DIRECTORIES ONLY;
# git stores a worktree's `node_modules` as a SYMLINK (a blob, mode 120000), so the pattern
# never matches it and every such worktree reads dirty forever. Counting `git status` lines
# therefore measures the ignore file's bugs, not anybody's unsaved work.
#
# So work is defined by CLASSIFICATION, from a declared manifest with a `reason` ON EVERY
# ROW (ops/worktree-noise-config.json), never by dirtiness.
#
# ── OUTPUT CONTRACT ──────────────────────────────────────────────────────────
#
#   --all            one TSV row per worktree, then exactly ONE verdict line:
#                      path <TAB> repo <TAB> branch <TAB> work_pending <TAB> protected_by
#                        <TAB> class_a_count <TAB> oldest_class_a_age_hours
#                      WORK_PENDING_VERDICT=CLEAN|PENDING|INDETERMINATE
#   --all --field <name>     that one column only, one value per line
#   --all --paths class_a    repo <TAB> worktree <TAB> path        (baseline row shape)
#   --all --paths class_b    repo <TAB> worktree <TAB> path <TAB> matched reason
#   --validate-config        schema-check the manifest and say so
#   --self-test              hermetic, two-way, vacuity-guarded
#
#   work_pending  ∈ {YES, NO, UNKNOWN}      UNKNOWN is FAIL-SAFE: never reclaimed,
#                                           never counted clean.
#   protected_by  ∈ {exempt_paths, lock, dirty_only, none}
#
# EXIT CODES — 0 = CLEAN · 1 = PENDING · 3 = INDETERMINATE.
# `3` is the token-law default for a NEW gate. scripts/check_test_baseline.sh uses `2` only
# because it already deployed `2`. DO NOT "align" them. **Callers gate on the TOKEN.**
#
# The one-verdict-line contract governs GATE runs (`--all` without a projection) and
# `--self-test` — not `--field` / `--paths`, which are projections whose stdout is consumed
# by `sort`/`comm` and must carry nothing else. Same precedent as check_test_baseline.sh's
# probe modes. The projections still carry the real exit code.
#
# ── protected_by, and why it is DERIVED rather than asserted ─────────────────
#
# Ordered, mechanically, mirroring cc-session.sh `clean_consider`'s own precedence:
#
#   1. lock          a live `git worktree lock` — what actually refuses `worktree remove`
#   2. exempt_paths  an UNEXPIRED declared row in ops/shared-worktree-state.json
#   3. dirty_only    none of the above, the tree is dirty, AND work_pending = YES
#   4. none          otherwise
#
# (3) is the de-renting instrument. It means: real work is sitting here and the ONLY thing
# standing between it and `cc-session.sh clean --force` is the accident that the tree
# happens to be dirty. Clean the noise and that protection evaporates — which is exactly the
# loss event already on this estate's record.
#
# Because the label is DERIVED, the relabel attack is structurally impossible: you cannot
# satisfy "{dirty_only} = empty" by renaming rows to `none`, because nothing writes the
# label. The only way to clear it is to add a real protection or to have no work to protect.
#
# DELIBERATELY NOT counted as protection: the landed-predicate refusal. `clean` also refuses
# a worktree carrying unmerged commits, but that answers a DIFFERENT question, and it is
# itself one merge away from vanishing. Treating it as protection would hide exactly the
# class this predicate exists to surface.
#
# ── KNOWN LIMITATION, pinned by a self-test rather than left to chance ───────
#
# `git status -uall` expands an untracked, NON-IGNORED directory into its individual files.
# A `match: basename` row names a final path component exactly (R1.2 — deliberately NOT
# gitignore semantics, because reusing those would reintroduce the very trailing-slash /
# symlink defect this wave retires, one layer up). So if a Class-B DIRECTORY were ever
# untracked AND unignored, its expanded contents would classify Class-A: `node_modules/a.js`
# has basename `a.js`.
#
# Not live today: `node_modules` is ignored as a directory in every declared repo, and CH3
# makes the symlink ignored too, so neither form is ever expanded. The behaviour is asserted
# in --self-test so it is a CHOSEN semantic rather than an accident. If a second such
# directory ever appears, the fix belongs in the manifest as a `match: glob` row, and the
# owner is OPS-WORKTREE-NOISE-DIR-EXPANSION-W{NEXT}.
#
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"

# Test seams. Both default to the committed artefacts; --self-test points them at scratch.
CONFIG="${WORK_PENDING_CONFIG:-$REPO_ROOT/ops/worktree-noise-config.json}"
STATE_FILE="${WORK_PENDING_STATE_FILE:-$REPO_ROOT/ops/shared-worktree-state.json}"
# `today` is injectable so an expiry test is not a function of the wall clock.
TODAY="${WORK_PENDING_TODAY:-$(date -u +%Y-%m-%d)}"
NOW_EPOCH="${WORK_PENDING_NOW_EPOCH:-$(date -u +%s)}"

# Sourceable seam (CLAUDE.md's test-importable law in shell). A fixture that only wants the
# pure helpers must not trigger a census as a side effect.
if (return 0 2>/dev/null); then WORK_PENDING_SOURCED=1; else WORK_PENDING_SOURCED=0; fi

VERDICT_EMITTED=0
emit_verdict() {
  # Structural, not conventional: exactly one verdict line per gate run.
  if [ "$VERDICT_EMITTED" -eq 1 ]; then return 0; fi
  VERDICT_EMITTED=1
  echo "WORK_PENDING_VERDICT=$1"
}

indeterminate() {
  echo "[work-pending] INDETERMINATE: $1" >&2
  emit_verdict INDETERMINATE
  exit 3
}

# ── pure helpers, driven directly by --self-test ─────────────────────────────

# fold_verdict <newline-separated work_pending values> -> CLEAN|PENDING|INDETERMINATE
# R1.4: any UNKNOWN wins, then any YES, else CLEAN. UNKNOWN can never fold to CLEAN.
fold_verdict() {
  local vals="$1" seen_yes=0 v
  # An empty corpus reaching HERE is not vacuity — the vacuity guard sits where the corpus
  # is CONSTRUCTED (census_repo), because that is where "we were supposed to enumerate
  # something" is knowable. See the verdict-token law's vacuity clause.
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    case "$v" in
      UNKNOWN) echo "INDETERMINATE"; return 0 ;;
      YES)     seen_yes=1 ;;
      NO)      : ;;
      *)       echo "INDETERMINATE"; return 0 ;;   # allow-list; unknown token is never green
    esac
  done <<EOF
$vals
EOF
  if [ "$seen_yes" -eq 1 ]; then echo "PENDING"; else echo "CLEAN"; fi
}

# verdict_to_code <verdict> -> 0|1|3
verdict_to_code() {
  case "$1" in
    CLEAN)         echo 0 ;;
    PENDING)       echo 1 ;;
    INDETERMINATE) echo 3 ;;
    *)             echo 3 ;;                       # allow-list, default INDETERMINATE
  esac
}

# expiry_active <expires> <today> -> 0 if the exemption still applies, 1 if lapsed
expiry_active() {
  local exp="${1:-}" today="${2:-}"
  [ -n "$exp" ] || return 0                        # no expiry field = no expiry
  [ "$exp" = "never" ] && return 0
  [ -n "$today" ] || return 0
  # Lexical compare is correct for zero-padded ISO dates and needs no date(1) parsing.
  if [ "$exp" \< "$today" ]; then return 1; fi
  return 0
}

# ── config ──────────────────────────────────────────────────────────────────

CFG_PATTERNS=""   # one "match<TAB>pattern<TAB>reason" line per row

validate_config() {
  local f="$1" bad
  [ -r "$f" ] || { echo "config unreadable: $f"; return 1; }
  jq -e 'type=="object"' "$f" >/dev/null 2>&1 || { echo "config is not a JSON object: $f"; return 1; }
  # A config WE author is a constructed corpus, so an empty declaration is vacuity and must
  # refuse — distinct from an enumeration that ran and found nothing.
  jq -e '(.repos // []) | type=="array" and length>0' "$f" >/dev/null 2>&1 \
    || { echo "config declares no repos"; return 1; }
  jq -e '(.repos // []) | all(type=="string" and startswith("/"))' "$f" >/dev/null 2>&1 \
    || { echo "every repos[] entry must be an ABSOLUTE path"; return 1; }
  jq -e '(.rows // []) | type=="array" and length>0' "$f" >/dev/null 2>&1 \
    || { echo "config declares no classification rows"; return 1; }
  # AC1.2 — `reason` and `match` are MANDATORY and validated. A row missing either fails the
  # schema; an exemption that lives only in a comment gets "fixed" by a future wave.
  bad=$(jq -r '
    [ (.rows // []) | to_entries[]
      | select(
          ((.value.pattern // "") | type != "string" or length == 0)
          or ((.value.reason  // "") | type != "string" or length == 0)
          or ((.value.match   // "") | IN("basename","relpath","glob") | not)
          or ((.value.class   // "") != "B")
        )
      | "row[\(.key)]" ] | join(",")' "$f" 2>/dev/null)
  if [ -n "${bad:-}" ]; then
    echo "invalid classification row(s): $bad (each row needs a non-empty pattern + reason, match in basename|relpath|glob, class B)"
    return 1
  fi
  return 0
}

load_config() {
  CFG_PATTERNS="$(jq -r '(.rows // [])[] | "\(.match)\t\(.pattern)\t\(.reason)"' "$CONFIG" 2>/dev/null)"
  [ -n "$CFG_PATTERNS" ] || return 1
  return 0
}

# classify_path <relpath> -> prints "B<TAB>reason" or "A"
classify_path() {
  local p="$1" bn line m pat reason
  bn="${p##*/}"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    m="${line%%	*}"
    reason="${line##*	}"
    pat="${line#*	}"; pat="${pat%%	*}"
    case "$m" in
      basename) [ "$bn" = "$pat" ] && { printf 'B\t%s\n' "$reason"; return 0; } ;;
      relpath)  [ "$p"  = "$pat" ] && { printf 'B\t%s\n' "$reason"; return 0; } ;;
      # shellcheck disable=SC2254 — the pattern IS the glob; quoting it would defeat the row.
      glob)     case "$p" in $pat) printf 'B\t%s\n' "$reason"; return 0 ;; esac ;;
    esac
  done <<EOF
$CFG_PATTERNS
EOF
  echo "A"
  return 0
}

# ── shared-state: exemptions + locks ────────────────────────────────────────

EXEMPT_PATHS=""   # one "path" line per UNEXPIRED exemption

load_exemptions() {
  EXEMPT_PATHS=""
  [ -r "$STATE_FILE" ] || return 0                 # absent SoT = no declared exemptions
  local rows line p exp
  rows="$(jq -r '((.worktree_roots.exempt_paths) // [])[]
                 | select((.path // "") | type=="string" and startswith("/"))
                 | "\(.path)\t\(.expires // "never")"' "$STATE_FILE" 2>/dev/null)"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    p="${line%%	*}"; exp="${line##*	}"
    if expiry_active "$exp" "$TODAY"; then
      EXEMPT_PATHS="$EXEMPT_PATHS$p
"
      local np; np="$(norm_path "$p")"
      [ "$np" != "$p" ] && EXEMPT_PATHS="$EXEMPT_PATHS$np
"
    fi
  done <<EOF
$rows
EOF
  return 0
}

# Resolve a path the way git reports it. On macOS /var is a symlink to /private/var, so a
# declared exemption written as /var/... would never match git's /private/var/... — a silent
# fail-OPEN on a PROTECTION, which is the worst possible direction for this predicate to be
# wrong in. Comparison-only: the emitted row keeps the path git gave us.
norm_path() {
  local p="$1" r
  r="$(cd "$p" 2>/dev/null && pwd -P)" || r=""
  if [ -n "$r" ]; then printf '%s' "$r"; else printf '%s' "$p"; fi
}

is_exempt() {
  local n; n="$(norm_path "$1")"
  case "$EXEMPT_PATHS" in *"$1"$'\n'*) return 0 ;; esac
  case "$EXEMPT_PATHS" in *"$n"$'\n'*) return 0 ;; esac
  return 1
}

LOCKED_PATHS=""
collect_locked() {
  local root="$1" line cur=""
  LOCKED_PATHS=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) cur="${line#worktree }" ;;
      locked*)     [ -n "$cur" ] && LOCKED_PATHS="$LOCKED_PATHS$cur
" ;;
    esac
  done < <(git -C "$root" worktree list --porcelain 2>/dev/null)
}

is_locked() {
  local n; n="$(norm_path "$1")"
  case "$LOCKED_PATHS" in *"$1"$'\n'*) return 0 ;; esac
  case "$LOCKED_PATHS" in *"$n"$'\n'*) return 0 ;; esac
  return 1
}

# ── census ──────────────────────────────────────────────────────────────────

# R1.6 half (b) — the load-bearing half. Gitignored paths NEVER appear in
# `git status -uall`; they need `--ignored`, which collapses to the ignoring directory
# (measured: 26 entries, <1 s, on a 1.6 GB worktree). Anything there that CLASSIFIES
# Class-A is real payload the primary corpus is structurally blind to — AOE's `data/` is
# the live instance, and it is precisely what exempt_paths exists to protect.
#
# Deliberately NOT folded into class_a_count / work_pending: an ignored path is a DECLARED
# artifact, so its presence is not somebody's unsaved work. Folding it in would leave every
# AOE worktree PENDING forever, which is decoration. It IS reported, because CH5 must know
# such a path exists and must use `git add -f` if it is ever asked to preserve one.
#
# Run LAZILY, only for the --gitignored-class-a projection: a per-worktree ignore scan on
# every gate run would cost ~30 s across this estate for output no gate reads.
scan_ignored_class_a() {
  local repo="$1" wt="$2" line p cls
  [ -d "$wt" ] || return 0
  while IFS= read -r line; do
    case "$line" in '!! '*) p="${line#!! }" ;; *) continue ;; esac
    p="${p%/}"
    [ -n "$p" ] || continue
    cls="$(classify_path "$p")"
    [ "${cls%%	*}" = "B" ] && continue
    GITIGNORED_A="$GITIGNORED_A$repo	$wt	$p	ignored_only
"
  done < <(git -C "$wt" status --porcelain=v1 --ignored 2>/dev/null)
}

ROWS=""        # TSV rows, one per worktree
PATHS_A=""     # repo<TAB>worktree<TAB>path
PATHS_B=""     # repo<TAB>worktree<TAB>path<TAB>reason
GITIGNORED_A="" # repo<TAB>worktree<TAB>path<TAB>tracked_ignored|ignored_only  (R1.6)

# Return the mtime as a BARE INTEGER, or nothing. Never anything else.
#
# `-f` means opposite things on the two stats: BSD `stat -f <fmt>` is a format string, GNU
# `stat -f` is --file-system. So the BSD-first form does not merely fail on Linux — it can
# SUCCEED and print something non-numeric, and the caller then feeds that to `$(( ))`.
#
# Under `set -u` that is fatal, not cosmetic: bash treats a non-numeric operand as a VARIABLE
# NAME, hits "unbound variable", and KILLS THE SHELL — so the predicate exits having printed
# NO VERDICT TOKEN AT ALL, which is the one outcome the token law forbids. Measured on the
# Postgres CI lane 2026-08-20: every scenario carrying a Class-A path died here, and only
# those, because nothing else reaches this function.
#
# So both forms are tried and the result is VALIDATED. A tool that answers in the wrong
# format is treated exactly like a tool that failed.
mtime_of() {
  local m
  for m in "$(stat -c %Y "$1" 2>/dev/null || true)" "$(stat -f %m "$1" 2>/dev/null || true)"; do
    case "$m" in ''|*[!0-9]*) continue ;; *) printf '%s' "$m"; return 0 ;; esac
  done
  return 0
}

# Numeric or nothing, asserted at the point of USE as well as of production — defence in
# depth, because the caller is the one that dies.
is_uint() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

census_worktree() {
  local repo="$1" wt="$2" branch="$3"
  local rc entry xy p cls reason a=0 oldest="" mt age pending protected dirty=0

  if [ ! -d "$wt" ]; then
    ROWS="$ROWS$wt	$repo	$branch	UNKNOWN	none	0	-
"
    return 0
  fi

  # -z: NUL-delimited and UNQUOTED. Avoids git's C-style path quoting entirely, which is a
  # parser nobody should hand-write twice.
  #
  # Routed through a FILE, not "$(...)": bash command substitution SILENTLY DISCARDS NUL
  # bytes, so `st=$(git status -z)` would concatenate every entry into one unsplittable
  # string and the classifier would see a single garbage path. Measured, not assumed.
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/wpw-status.XXXXXX")" || {
    ROWS="$ROWS$wt	$repo	$branch	UNKNOWN	none	0	-
"
    return 0
  }
  git -C "$wt" status --porcelain=v1 -z --untracked-files=all >"$tmp" 2>/dev/null; rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -f "$tmp"
    ROWS="$ROWS$wt	$repo	$branch	UNKNOWN	none	0	-
"
    return 0
  fi
  [ -s "$tmp" ] && dirty=1

  local expect_orig=0
  while IFS= read -r -d '' entry; do
    if [ "$expect_orig" -eq 1 ]; then expect_orig=0; continue; fi   # rename's from-path
    [ -n "$entry" ] || continue
    xy="${entry:0:2}"
    p="${entry:3}"
    case "$xy" in R*|C*|*R|*C) expect_orig=1 ;; esac
    [ -n "$p" ] || continue
    cls="$(classify_path "$p")"
    if [ "${cls%%	*}" = "B" ]; then
      reason="${cls#*	}"
      PATHS_B="$PATHS_B$repo	$wt	$p	$reason
"
      continue
    fi
    a=$(( a + 1 ))
    PATHS_A="$PATHS_A$repo	$wt	$p
"
    # R1.6 half (a) — a TRACKED path that also matches an ignore rule. Ignore rules do not
    # apply to tracked files, so this one shows up in the primary corpus.
    if git -C "$wt" check-ignore -q -- "$p" 2>/dev/null; then
      GITIGNORED_A="$GITIGNORED_A$repo	$wt	$p	tracked_ignored
"
    fi
    mt="$(mtime_of "$wt/$p")"
    if is_uint "${mt:-}"; then
      if ! is_uint "$oldest" || [ "$mt" -lt "$oldest" ]; then oldest="$mt"; fi
    fi
  done < "$tmp"
  rm -f "$tmp"

  if [ "$a" -gt 0 ]; then pending=YES; else pending=NO; fi

  if is_locked "$wt";  then protected=lock
  elif is_exempt "$wt"; then protected=exempt_paths
  elif [ "$dirty" -eq 1 ] && [ "$pending" = "YES" ]; then protected=dirty_only
  else protected=none
  fi

  # `-` is the honest answer for "no resolvable age", and it is what the column already means
  # elsewhere. Never let an unvalidated value reach `$(( ))`.
  age="-"
  if is_uint "$oldest" && is_uint "$NOW_EPOCH"; then age=$(( ( NOW_EPOCH - oldest ) / 3600 )); fi

  ROWS="$ROWS$wt	$repo	$branch	$pending	$protected	$a	$age
"
}

census_repo() {
  local repo="$1" line wt="" branch="" n=0
  git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 \
    || indeterminate "declared repo is not a git repository: $repo"
  collect_locked "$repo"
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) wt="${line#worktree }"; branch="(detached)" ;;
      branch\ *)   branch="${line#branch refs/heads/}" ;;
      '')          [ -n "$wt" ] && { census_worktree "$repo" "$wt" "$branch"; n=$(( n + 1 )); wt=""; } ;;
    esac
  done < <(git -C "$repo" worktree list --porcelain 2>/dev/null; echo)
  [ -n "$wt" ] && { census_worktree "$repo" "$wt" "$branch"; n=$(( n + 1 )); }
  # R1.5 — the vacuity guard belongs where the corpus is CONSTRUCTED. The config DECLARED
  # this repo, so zero worktrees means the enumeration failed, not that the world is empty.
  # (A live repo always lists at least its main worktree.)
  [ "$n" -gt 0 ] || indeterminate "declared repo enumerated ZERO worktrees: $repo"
  return 0
}

run_census() {
  command -v jq  >/dev/null 2>&1 || indeterminate "jq is not on PATH"
  command -v git >/dev/null 2>&1 || indeterminate "git is not on PATH"
  local problem
  problem="$(validate_config "$CONFIG")" || indeterminate "config schema: ${problem:-unspecified}"
  load_config || indeterminate "config declares no usable classification rows"
  load_exemptions
  local repos r
  repos="$(jq -r '(.repos // [])[]' "$CONFIG" 2>/dev/null)"
  [ -n "$repos" ] || indeterminate "config declares no repos"
  while IFS= read -r r; do
    [ -n "$r" ] || continue
    census_repo "$r"
  done <<EOF
$repos
EOF
}

field_index() {
  case "$1" in
    path) echo 1 ;; repo) echo 2 ;; branch) echo 3 ;; work_pending) echo 4 ;;
    protected_by) echo 5 ;; class_a_count) echo 6 ;; oldest_class_a_age_hours) echo 7 ;;
    *) echo "" ;;
  esac
}

usage() {
  cat <<'USAGE'
usage: worktree-work-pending.sh --all [--field <name>] [--paths class_a|class_b]
       worktree-work-pending.sh --validate-config
       worktree-work-pending.sh --self-test

  --all               TSV rows + exactly one WORK_PENDING_VERDICT= line
  --field <name>      one column: path|repo|branch|work_pending|protected_by
                      |class_a_count|oldest_class_a_age_hours
  --paths class_a     repo<TAB>worktree<TAB>path   (the ops/worktree-class-a-baseline.tsv shape)
  --paths class_b     ... plus the matched reason
  --gitignored-class-a  R1.6 projection: Class-A paths that are ALSO gitignored

exit: 0 CLEAN · 1 PENDING · 3 INDETERMINATE.  Callers gate on the TOKEN, never the code.
USAGE
}

main() {
  local mode="" field="" paths="" verdict code
  while [ $# -gt 0 ]; do
    case "$1" in
      --all)                 mode=all ;;
      --field)               shift; field="${1:-}"; [ -n "$field" ] || { usage >&2; exit 3; } ;;
      --field=*)             field="${1#--field=}" ;;
      --paths)               shift; paths="${1:-}"; [ -n "$paths" ] || { usage >&2; exit 3; } ;;
      --paths=*)             paths="${1#--paths=}" ;;
      --gitignored-class-a)  paths=gitignored_class_a ;;
      --validate-config)     mode=validate ;;
      --self-test)           mode=selftest ;;
      -h|--help)             usage; exit 0 ;;
      *)                     echo "unknown argument: $1" >&2; usage >&2; exit 3 ;;
    esac
    shift
  done

  if [ "$mode" = "validate" ]; then
    local problem
    if problem="$(validate_config "$CONFIG")"; then
      echo "[work-pending] config OK: $CONFIG ($(jq -r '(.rows|length)' "$CONFIG") rows, $(jq -r '(.repos|length)' "$CONFIG") repos)"
      exit 0
    fi
    echo "[work-pending] config INVALID: ${problem:-unspecified}" >&2
    exit 1
  fi

  if [ "$mode" = "selftest" ]; then run_self_test; fi

  [ "$mode" = "all" ] || { usage >&2; exit 3; }

  run_census
  verdict="$(fold_verdict "$(printf '%s\n' "$ROWS" | awk -F'\t' 'NF>=4{print $4}')")"
  code="$(verdict_to_code "$verdict")"

  if [ -n "$paths" ]; then
    case "$paths" in
      class_a)              printf '%s' "$PATHS_A" ;;
      class_b)              printf '%s' "$PATHS_B" ;;
      gitignored_class_a)
        local ln r w
        while IFS= read -r ln; do
          [ -n "$ln" ] || continue
          w="${ln%%	*}"; r="${ln#*	}"; r="${r%%	*}"
          scan_ignored_class_a "$r" "$w"
        done <<EOF
$ROWS
EOF
        printf '%s' "$GITIGNORED_A" ;;
      *) echo "unknown --paths class: $paths (expected class_a|class_b)" >&2; exit 3 ;;
    esac
    exit "$code"
  fi

  if [ -n "$field" ]; then
    local idx; idx="$(field_index "$field")"
    [ -n "$idx" ] || { echo "unknown --field: $field" >&2; exit 3; }
    printf '%s' "$ROWS" | awk -F'\t' -v i="$idx" 'NF>=7{print $i}'
    exit "$code"
  fi

  printf '%s' "$ROWS"
  emit_verdict "$verdict"
  exit "$code"
}

# ── --self-test (hermetic: builds its own scratch repos, touches no real one) ─
#
# TWO-WAY and vacuity-guarded. Every assertion is WRAPPED: a broken subject must print
# `SELF-TEST: FAIL` and keep going, never abort the suite — an assertion that RAISES is not
# an assertion, it is a crash that reads as "proven able to fail" while proving nothing.

ST_PASS=0; ST_FAIL=0
st_check() {
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then ST_PASS=$(( ST_PASS + 1 )); echo "  ok   $label"
  else ST_FAIL=$(( ST_FAIL + 1 )); echo "  FAIL $label — got '$got' want '$want'"; fi
}

st_mkrepo() {
  local d="$1"
  mkdir -p "$d"
  git -C "$d" init -q --initial-branch=main >/dev/null 2>&1
  git -C "$d" config user.email selftest@algovault.local
  git -C "$d" config user.name  selftest
  git -C "$d" config commit.gpgsign false
  git -C "$d" config core.hooksPath /dev/null
  printf 'seed\n' > "$d/README.md"
  git -C "$d" add README.md >/dev/null 2>&1
  git -C "$d" commit -qm seed >/dev/null 2>&1
}

st_config() {
  # The manifest under test. `reason` and `match` on every row — the schema demands both.
  cat > "$1" <<JSON
{ "version": 1,
  "repos": [ $2 ],
  "rows": [
    { "pattern": "node_modules", "match": "basename", "class": "B", "reason": "selftest", "owner_wave": "selftest", "added": "2026-08-20" },
    { "pattern": ".venv",        "match": "basename", "class": "B", "reason": "selftest", "owner_wave": "selftest", "added": "2026-08-20" },
    { "pattern": ".claude/napkin.md", "match": "relpath", "class": "B", "reason": "selftest", "owner_wave": "selftest", "added": "2026-08-20" }
  ],
  "promotion": {} }
JSON
}

st_verdict() { printf '%s\n' "$1" | sed -n 's/^WORK_PENDING_VERDICT=//p' | tail -1; }
st_field()   { printf '%s\n' "$1" | awk -F'\t' -v i="$2" 'NF>=7{print $i}' | tail -1; }

run_self_test() {
  command -v jq >/dev/null 2>&1 || { echo "✖ self-test needs jq"; emit_verdict INDETERMINATE; exit 3; }
  local T; T="$(mktemp -d "${TMPDIR:-/tmp}/wpw-selftest.XXXXXX")" || {
    echo "✖ self-test could not mktemp -d"; emit_verdict INDETERMINATE; exit 3; }
  trap 'rm -rf "$T"' EXIT
  local SELF="${BASH_SOURCE[0]}" out cfg
  echo "[work-pending] --self-test (hermetic; no real repo is touched)"

  # ── pure helpers first: they are the only code a fixture can reach without a census ──
  st_check "fold: UNKNOWN wins over YES"      "$(fold_verdict "$(printf 'YES\nUNKNOWN\nNO\n')")" "INDETERMINATE"
  st_check "fold: UNKNOWN wins over all-NO"   "$(fold_verdict "$(printf 'NO\nUNKNOWN\n')")"      "INDETERMINATE"
  st_check "fold: YES beats NO"               "$(fold_verdict "$(printf 'NO\nYES\nNO\n')")"      "PENDING"
  st_check "fold: all NO is CLEAN"            "$(fold_verdict "$(printf 'NO\nNO\n')")"           "CLEAN"
  st_check "fold: unrecognised token is never green" "$(fold_verdict "$(printf 'NO\nMAYBE\n')")" "INDETERMINATE"
  st_check "code: CLEAN=0"                    "$(verdict_to_code CLEAN)"                         "0"
  st_check "code: PENDING=1"                  "$(verdict_to_code PENDING)"                       "1"
  st_check "code: INDETERMINATE=3"            "$(verdict_to_code INDETERMINATE)"                 "3"
  st_check "code: garbage folds to 3"         "$(verdict_to_code WAT)"                           "3"
  expiry_active never    2026-08-20 && st_check "expiry: never is active"  ok ok || st_check "expiry: never is active"  no ok
  expiry_active 2026-09-19 2026-08-20 && st_check "expiry: future is active" ok ok || st_check "expiry: future is active" no ok
  expiry_active 2026-08-19 2026-08-20 && st_check "expiry: past is LAPSED"  no ok || st_check "expiry: past is LAPSED"  ok ok

  # ── (1) Class-B-only dirt folds to CLEAN ──────────────────────────────────
  local R1="$T/r1"; st_mkrepo "$R1"; cfg="$T/c1.json"; st_config "$cfg" "\"$R1\""
  ln -s /tmp "$R1/node_modules"                       # a SYMLINK, exactly the live shape
  mkdir -p "$R1/.claude"; printf 'runbook\n' > "$R1/.claude/napkin.md"
  out="$(WORK_PENDING_CONFIG="$cfg" WORK_PENDING_STATE_FILE=/nonexistent bash "$SELF" --all 2>/dev/null)"
  st_check "Class-B-only dirty -> CLEAN"        "$(st_verdict "$out")" "CLEAN"
  st_check "node_modules SYMLINK classifies B"  "$(st_field "$out" 6)" "0"
  out="$(WORK_PENDING_CONFIG="$cfg" WORK_PENDING_STATE_FILE=/nonexistent bash "$SELF" --all --paths class_b 2>/dev/null | wc -l | tr -d ' ')"
  st_check "both Class-B paths projected"       "$out" "2"

  # ── (2) .venv AS A SYMLINK is Class B (AC1.3) ─────────────────────────────
  ln -s /tmp "$R1/.venv"
  out="$(WORK_PENDING_CONFIG="$cfg" WORK_PENDING_STATE_FILE=/nonexistent bash "$SELF" --all 2>/dev/null)"
  st_check ".venv SYMLINK classifies B"         "$(st_verdict "$out")" "CLEAN"

  # ── (3) an UNTRACKED real file is Class A -> PENDING ──────────────────────
  printf 'real work\n' > "$R1/new-work.sql"
  out="$(WORK_PENDING_CONFIG="$cfg" WORK_PENDING_STATE_FILE=/nonexistent bash "$SELF" --all 2>/dev/null)"
  st_check "untracked Class-A -> PENDING"       "$(st_verdict "$out")" "PENDING"
  st_check "class_a_count is 1"                 "$(st_field "$out" 6)" "1"
  st_check "protected_by is dirty_only"         "$(st_field "$out" 5)" "dirty_only"

  # ── (4) a MODIFIED TRACKED file is Class A ────────────────────────────────
  local R2="$T/r2"; st_mkrepo "$R2"; cfg="$T/c2.json"; st_config "$cfg" "\"$R2\""
  printf 'changed\n' >> "$R2/README.md"
  out="$(WORK_PENDING_CONFIG="$cfg" WORK_PENDING_STATE_FILE=/nonexistent bash "$SELF" --all 2>/dev/null)"
  st_check "modified tracked -> PENDING"        "$(st_verdict "$out")" "PENDING"

  # ── (5) gitignored Class-A is FLAGGED (R1.6) ──────────────────────────────
  local R3="$T/r3"; st_mkrepo "$R3"; cfg="$T/c3.json"; st_config "$cfg" "\"$R3\""
  printf 'secret.local\n' > "$R3/.gitignore"
  git -C "$R3" add .gitignore >/dev/null 2>&1; git -C "$R3" commit -qm ignore >/dev/null 2>&1
  printf 'payload\n' > "$R3/secret.local"
  out="$(WORK_PENDING_CONFIG="$cfg" WORK_PENDING_STATE_FILE=/nonexistent bash "$SELF" --all --gitignored-class-a 2>/dev/null)"
  st_check "gitignored Class-A is flagged"      "$(printf '%s' "$out" | grep -c 'secret.local' || true)" "1"

  # ── (6) a live LOCK and an exemption outrank dirty_only ───────────────────
  local R4="$T/r4"; st_mkrepo "$R4"; cfg="$T/c4.json"; st_config "$cfg" "\"$R4\""
  printf 'work\n' > "$R4/thing.txt"
  cat > "$T/state.json" <<JSON
{ "worktree_roots": { "exempt_paths": [ { "path": "$R4", "reason": "selftest", "expires": "never" } ] } }
JSON
  out="$(WORK_PENDING_CONFIG="$cfg" WORK_PENDING_STATE_FILE="$T/state.json" bash "$SELF" --all 2>/dev/null)"
  st_check "declared exemption outranks dirty_only" "$(st_field "$out" 5)" "exempt_paths"
  cat > "$T/state-lapsed.json" <<JSON
{ "worktree_roots": { "exempt_paths": [ { "path": "$R4", "reason": "selftest", "expires": "2026-01-01" } ] } }
JSON
  out="$(WORK_PENDING_CONFIG="$cfg" WORK_PENDING_STATE_FILE="$T/state-lapsed.json" WORK_PENDING_TODAY=2026-08-20 bash "$SELF" --all 2>/dev/null)"
  st_check "LAPSED exemption does not protect"      "$(st_field "$out" 5)" "dirty_only"

  # ── (6b) a live `git worktree lock` outranks everything ───────────────────
  # `lock` is one of the four protected_by values and it is LIVE on four worktrees in this
  # estate, so it needs a scenario of its own — an untested branch of a safety label is an
  # untested safety label.
  git -C "$R4" worktree add -q "$T/r4-wt" -b locked-wt >/dev/null 2>&1
  git -C "$R4" worktree lock "$T/r4-wt" >/dev/null 2>&1
  printf 'work\n' > "$T/r4-wt/thing.txt"
  out="$(WORK_PENDING_CONFIG="$cfg" WORK_PENDING_STATE_FILE=/nonexistent bash "$SELF" --all 2>/dev/null)"
  st_check "a live worktree lock reads as protected_by=lock" \
    "$(printf '%s\n' "$out" | awk -F'\t' '$1 ~ /r4-wt$/ {print $5}' | tail -1)" "lock"

  # ── (7) unreadable / invalid config -> INDETERMINATE, never CLEAN ─────────
  out="$(WORK_PENDING_CONFIG="$T/nope.json" bash "$SELF" --all 2>/dev/null)"
  st_check "absent config -> INDETERMINATE"     "$(st_verdict "$out")" "INDETERMINATE"
  printf '{"repos":["%s"],"rows":[{"pattern":"x","class":"B","reason":"no match key"}]}\n' "$R1" > "$T/c-bad.json"
  out="$(WORK_PENDING_CONFIG="$T/c-bad.json" bash "$SELF" --all 2>/dev/null)"
  st_check "row missing \`match\` -> INDETERMINATE" "$(st_verdict "$out")" "INDETERMINATE"
  printf '{"repos":["%s"],"rows":[{"pattern":"x","match":"basename","class":"B"}]}\n' "$R1" > "$T/c-bad2.json"
  out="$(WORK_PENDING_CONFIG="$T/c-bad2.json" bash "$SELF" --all 2>/dev/null)"
  st_check "row missing \`reason\` -> INDETERMINATE" "$(st_verdict "$out")" "INDETERMINATE"
  printf '{"repos":[],"rows":[{"pattern":"x","match":"basename","class":"B","reason":"r"}]}\n' > "$T/c-empty.json"
  out="$(WORK_PENDING_CONFIG="$T/c-empty.json" bash "$SELF" --all 2>/dev/null)"
  st_check "EMPTY declaration is vacuity -> INDETERMINATE" "$(st_verdict "$out")" "INDETERMINATE"
  printf '{"repos":["%s/not-a-repo"],"rows":[{"pattern":"x","match":"basename","class":"B","reason":"r"}]}\n' "$T" > "$T/c-norepo.json"
  out="$(WORK_PENDING_CONFIG="$T/c-norepo.json" bash "$SELF" --all 2>/dev/null)"
  st_check "declared non-repo -> INDETERMINATE" "$(st_verdict "$out")" "INDETERMINATE"

  # ── (8) exit CODES, not just tokens — re-coding the map must break this ───
  WORK_PENDING_CONFIG="$T/c2.json" WORK_PENDING_STATE_FILE=/nonexistent bash "$SELF" --all >/dev/null 2>&1
  st_check "PENDING exits 1"                    "$?" "1"
  local R5="$T/r5"; st_mkrepo "$R5"; st_config "$T/c5.json" "\"$R5\""
  WORK_PENDING_CONFIG="$T/c5.json" WORK_PENDING_STATE_FILE=/nonexistent bash "$SELF" --all >/dev/null 2>&1
  st_check "CLEAN exits 0"                      "$?" "0"
  WORK_PENDING_CONFIG="$T/nope.json" bash "$SELF" --all >/dev/null 2>&1
  st_check "INDETERMINATE exits 3"              "$?" "3"

  # ── (9) exactly ONE verdict line, whatever the repo count (AC1.1) ─────────
  st_config "$T/c-multi.json" "\"$R1\", \"$R2\", \"$R3\""
  out="$(WORK_PENDING_CONFIG="$T/c-multi.json" WORK_PENDING_STATE_FILE=/nonexistent bash "$SELF" --all 2>/dev/null)"
  st_check "exactly one verdict line across 3 repos" \
    "$(printf '%s\n' "$out" | grep -c 'WORK_PENDING_VERDICT=' || true)" "1"
  st_check "projections carry NO verdict line" \
    "$(WORK_PENDING_CONFIG="$T/c-multi.json" WORK_PENDING_STATE_FILE=/nonexistent bash "$SELF" --all --paths class_a 2>/dev/null | grep -c 'WORK_PENDING_VERDICT=' || true)" "0"

  # ── (9b) REGRESSION: a `stat` that answers in the WRONG FORMAT must not kill the run ──
  # This reproduces the Postgres-lane failure on any platform. A shim `stat` earlier on PATH
  # prints a non-numeric answer and exits 0 — exactly what GNU `stat -f %m` does — and the
  # predicate must still emit EXACTLY ONE verdict token. Before the fix it printed none at
  # all, because `$(( ))` under `set -u` read the string as an unbound variable name and
  # killed the shell.
  local SHIM="$T/shim"; mkdir -p "$SHIM"
  printf '#!/bin/sh\necho "?"\nexit 0\n' > "$SHIM/stat"; chmod +x "$SHIM/stat"
  out="$(PATH="$SHIM:$PATH" WORK_PENDING_CONFIG="$cfg" WORK_PENDING_STATE_FILE=/nonexistent bash "$SELF" --all 2>/dev/null)"
  st_check "a wrong-format \`stat\` still yields exactly ONE verdict line" \
    "$(printf '%s\n' "$out" | grep -c 'WORK_PENDING_VERDICT=' || true)" "1"
  st_check "...and the run is still PENDING, not a crash" "$(st_verdict "$out")" "PENDING"
  st_check "...with the age column falling back to '-'" "$(st_field "$out" 7)" "-"

  # A shim that emulates GNU stat EXACTLY: `-c %Y` answers correctly, `-f` is
  # --file-system and prints something unrelated. This is the real Linux shape, and it
  # proves the fix does not merely survive it but reads the CORRECT mtime — a guard that
  # only stopped the crash would leave every age reading "-" on every Linux host.
  printf '#!/bin/sh\ncase "$1" in\n  -c) echo 1755000000 ;;\n  -f) echo "Block size: 4096" ;;\n  *) echo "?" ;;\nesac\nexit 0\n' > "$SHIM/stat"
  chmod +x "$SHIM/stat"
  out="$(PATH="$SHIM:$PATH" WORK_PENDING_CONFIG="$cfg" WORK_PENDING_STATE_FILE=/nonexistent WORK_PENDING_NOW_EPOCH=1755003600 bash "$SELF" --all 2>/dev/null)"
  st_check "GNU-shaped stat: verdict still emitted exactly once" \
    "$(printf '%s\n' "$out" | grep -c 'WORK_PENDING_VERDICT=' || true)" "1"
  st_check "GNU-shaped stat: the age is READ CORRECTLY, not defaulted to '-'" "$(st_field "$out" 7)" "1"

  # ── (10) the KNOWN LIMITATION, pinned so it is a decision and not an accident
  local R6="$T/r6"; st_mkrepo "$R6"; st_config "$T/c6.json" "\"$R6\""
  mkdir -p "$R6/node_modules"; printf 'x\n' > "$R6/node_modules/pkg.js"
  out="$(WORK_PENDING_CONFIG="$T/c6.json" WORK_PENDING_STATE_FILE=/nonexistent bash "$SELF" --all 2>/dev/null)"
  st_check "documented limit: an UNIGNORED Class-B dir expands to Class-A" \
    "$(st_verdict "$out")" "PENDING"

  echo "[work-pending] --self-test: $ST_PASS passed, $ST_FAIL failed"
  if [ "$ST_PASS" -eq 0 ]; then
    echo "[work-pending] SELF-TEST built an EMPTY corpus — refusing to report a pass" >&2
    emit_verdict INDETERMINATE; exit 3
  fi
  if [ "$ST_FAIL" -ne 0 ]; then emit_verdict PENDING; exit 1; fi
  emit_verdict CLEAN; exit 0
}

if [ "${WORK_PENDING_SOURCED:-0}" = "1" ]; then return 0; fi
main "$@"
