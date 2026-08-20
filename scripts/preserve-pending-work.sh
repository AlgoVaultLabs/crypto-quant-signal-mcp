#!/usr/bin/env bash
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR GIT_QUARANTINE_PATH
#
# preserve-pending-work.sh — OPS-WORKTREE-WORK-PENDING-W1 CH5
#
# SNAPSHOT this worktree's Class-A paths to a LOCAL ref, so that losing an uncommitted change
# requires losing a local ref too. After this, `dirty=1` stops being a load-bearing safety
# property — which is the whole point, because it was only ever a state accident.
#
#   preserve-pending-work.sh --worktree <path>
#   preserve-pending-work.sh --list [--worktree <path>]     list WIP refs (uncapped)
#   preserve-pending-work.sh --self-test
#
# EXIT CODES — defined HERE because nothing else defines them, and deliberately NOT the
# predicate's (R1.4) codes. Do not conflate them:
#
#   0  PRESERVED             a new WIP ref was minted
#   1  NOTHING_TO_PRESERVE   a healthy no-op, and a GREEN outcome — not a failure
#   3  INDETERMINATE         could not evaluate; the caller must not treat this as success
#
# ── METHOD: A TEMPORARY INDEX. `git stash` IS REJECTED, AND THE REASON IS MEASURED ──
#
# Measured on git 2.50.1 (Apple Git-155), 2026-08-20:
#
#   * `git stash create --include-untracked` is ACCEPTED — it returns a commit SHA and no
#     error. The dispatching spec claimed the flag does not exist on `create` ("it belongs to
#     push/save"). That claim is FALSE, and the truth is WORSE: the flag is accepted and
#     SILENTLY DOES NOTHING. The resulting tree contained only the tracked files; the
#     untracked file was absent.
#   * A silent omission is far more dangerous than a hard error here, because the payload it
#     drops is exactly the payload this wave exists to protect — the stranding on the record
#     included untracked `migrations/029_*.sql`.
#   * `git stash push` mutates the working tree AND the real index, so it is itself a
#     work-loss vector for a session that is still running.
#
# The temporary index has four properties none of those have:
#
#   1. The working tree and the real index are NEVER touched. The session keeps working.
#   2. Untracked Class-A files ARE covered.
#   3. Gitignored Class-A paths are covered too, via `-f` on exactly the flagged subset —
#      without it `git add` refuses them, exits non-zero, and silently omits them.
#   4. Per-file `git add` is satisfied BY CONSTRUCTION: the temp index only ever receives
#      explicitly named Class-A paths, so the cross-session contamination class (two sessions
#      sweeping each other's edits into their own commits) is structurally impossible here.
#
# ── WHAT IT REFUSES TO DO ────────────────────────────────────────────────────
#
# NEVER commits to the working branch. NEVER pushes. NEVER `git stash push`. NEVER
# `reset --hard`. `refs/algovault/*` is outside `refs/heads/*`, and the leak vectors are
# ASSERTED rather than assumed — see --self-test and the CH5 gate.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREDICATE="${ALGOVAULT_WORK_PENDING_PREDICATE:-$SELF_DIR/lib/worktree-work-pending.sh}"
RETENTION_DAYS="${ALGOVAULT_WIP_RETENTION_DAYS:-30}"
# Validated because it is caller-supplied and reaches `$(( ))`. Under `set -u` a non-numeric
# operand is read as a variable name, hits "unbound variable", and KILLS THE SHELL before any
# verdict is printed — the same defect that took the predicate down on the Linux CI lane.
case "$RETENTION_DAYS" in ''|*[!0-9]*) RETENTION_DAYS=30 ;; esac

WT=""; MODE="preserve"
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree)   shift; WT="${1:-}" ;;
    --worktree=*) WT="${1#--worktree=}" ;;
    --list)       MODE="list" ;;
    --self-test)  MODE="selftest" ;;
    -h|--help)    sed -n '3,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)            echo "preserve: unknown argument: $1" >&2; exit 3 ;;
  esac
  shift
done

log() { printf '%s\n' "$*"; }
indet() { log "PRESERVE_VERDICT=INDETERMINATE reason=$1"; exit 3; }

# ── ref naming (R5.2) ───────────────────────────────────────────────────────
# `date -u +%Y%m%dT%H%M%SZ`, NOT ISO-8601: an ISO timestamp carries a COLON, which
# `git check-ref-format` forbids outright, so `update-ref` would fail at the last step after
# all the work was done. The slug is sanitised for the same reason, and the result is
# VALIDATED rather than trusted.
slugify() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//; s/--*/-/g'; }

# ── list (R5.6): UNCAPPED enumeration ───────────────────────────────────────
# `git for-each-ref` takes a --count; using one here and then reporting "N refs" would be
# aggregating over a LIMIT-capped collection, which this estate forbids by law.
list_refs() {
  git -C "${1:-.}" for-each-ref --format='%(refname) %(committerdate:unix) %(objectname)' 'refs/algovault/wip/**' 2>/dev/null
}

do_list() {
  local wt="${WT:-$PWD}" now cutoff n=0 old=0 line ts ref
  git -C "$wt" rev-parse --git-dir >/dev/null 2>&1 || indet "not-a-git-worktree"
  now="$(date -u +%s)"; cutoff=$(( now - RETENTION_DAYS * 86400 ))
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    n=$(( n + 1 ))
    ref="${line%% *}"; ts="$(printf '%s' "$line" | awk '{print $2}')"
    if [ -n "$ts" ] && [ "$ts" -lt "$cutoff" ] 2>/dev/null; then
      old=$(( old + 1 )); log "  OLD(>${RETENTION_DAYS}d) $ref"
    else
      log "  $ref"
    fi
  done < <(list_refs "$wt")
  # R5.6 — REPORTED, never auto-deleted. Deletion of a work snapshot stays a human act.
  log "PRESERVE_LIST=$n refs ($old older than ${RETENTION_DAYS}d — reported, NEVER auto-deleted)"
  log "  to delete one deliberately: git update-ref -d <ref>"
  exit 0
}

# ── the recovery runbook (R5.9) ─────────────────────────────────────────────
# A preservation mechanism nobody can reverse is a write-only archive.
runbook() {
  cat <<'RUNBOOK'
# ── RECOVERING PRESERVED WORK ────────────────────────────────────────────────
# 1. List what exists (uncapped):
#      bash scripts/preserve-pending-work.sh --list --worktree <path>
#      git for-each-ref --format='%(refname) %(committerdate:iso)' 'refs/algovault/wip/**'
#
# 2. See what a snapshot holds, and how it differs from where you are:
#      git show --stat <ref>
#      git diff HEAD <ref>
#      git ls-tree -r --name-only <ref>
#
# 3. Restore ONE file without disturbing anything else (the usual case):
#      git checkout <ref> -- path/to/file
#
# 4. Restore everything into a scratch worktree, to inspect before adopting:
#      git worktree add --detach /tmp/recovered <ref>
#
# 5. When done, delete the ref deliberately — nothing deletes it for you:
#      git update-ref -d <ref>
RUNBOOK
}

# ══════════════════════════════════════════════════════════════════════════════
preserve() {
  local wt="$1" repo slug ts ref tree sha parent common paths_a gitignored n=0 add_failed=0 addout arc
  [ -n "$wt" ] || indet "no-worktree-given"
  [ -d "$wt" ] || indet "worktree-path-does-not-exist"
  git -C "$wt" rev-parse --git-dir >/dev/null 2>&1 || indet "not-a-git-worktree"
  [ -r "$PREDICATE" ] || indet "predicate-not-found"
  # RESOLVE the path the way git reports it. On macOS /var is a symlink to /private/var, so a
  # caller-supplied /var/... path never matches the predicate's /private/var/... row and the
  # Class-A set silently reads EMPTY — which this script would then report as
  # NOTHING_TO_PRESERVE. A fail-open on a preservation primitive is the worst possible
  # direction, and it is exactly the bug the self-test caught here.
  wt="$(cd "$wt" 2>/dev/null && pwd -P)" || indet "worktree-path-unresolvable"
  command -v jq >/dev/null 2>&1 || indet "jq-absent"

  common="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || indet "no-common-dir"
  repo="$(basename "$(dirname "$common")")"
  slug="$(slugify "$(basename "$wt")")"
  [ -n "$slug" ] || indet "empty-slug"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  ref="refs/algovault/wip/$(slugify "$repo")/$slug/$ts"

  # VALIDATE the ref BEFORE doing any work, so a naming bug fails fast rather than after a
  # tree has been written.
  git check-ref-format "$ref" 2>/dev/null || indet "ref-name-rejected-by-git:$ref"

  # ── the Class-A path set, from THE ONE PREDICATE. Never re-derived here. ──
  paths_a="$(bash "$PREDICATE" --all --paths class_a 2>/dev/null | awk -F'\t' -v w="$wt" 'NF>=3 && $2==w {print $3}')"
  gitignored="$(bash "$PREDICATE" --all --gitignored-class-a 2>/dev/null | awk -F'\t' -v w="$wt" 'NF>=3 && $2==w {print $3}')"

  if [ -z "$paths_a" ]; then
    log "PRESERVE_VERDICT=NOTHING_TO_PRESERVE worktree=$wt"
    log "  no Class-A paths — a healthy no-op, not a failure"
    return 1
  fi

  local TMPIDX
  # EXPLICIT template, not `mktemp -t algovault-wip`. BSD accepts a bare prefix; GNU requires
  # at least three X's and errors with "too few X's in template", so the spec's literal form
  # would make this primitive return INDETERMINATE on every Linux host. Second BSD/GNU
  # divergence in this wave after `stat -f`, and neither is visible from macOS — which is why
  # tests/unit/worktree-work-pending.test.ts now lints for the whole class.
  TMPIDX="$(mktemp "${TMPDIR:-/tmp}/algovault-wip.XXXXXX")" || indet "mktemp-failed"
  # git REJECTS a zero-byte index file, so the file must not exist. git-stash does exactly
  # this. The trap covers every failure path so a temp index is never leaked.
  rm -f "$TMPIDX"
  trap 'rm -f "$TMPIDX"' RETURN
  export GIT_INDEX_FILE="$TMPIDX"

  if git -C "$wt" rev-parse --verify HEAD >/dev/null 2>&1; then
    git -C "$wt" read-tree HEAD 2>/dev/null || { unset GIT_INDEX_FILE; indet "read-tree-failed"; }
    parent="-p HEAD"
  else
    parent=""
  fi

  local p forced
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    forced=0
    # `-f` ONLY for the subset R1.6 flagged gitignored. Without it `git add` refuses the path,
    # exits non-zero, and SILENTLY omits it — and CH3 deliberately widened the ignore set.
    if printf '%s\n' "$gitignored" | grep -qxF "$p"; then forced=1; fi
    # NO `|| true` HERE. Masking a failed add is how a ref gets minted that LOOKS like a
    # backup and is missing the one file that mattered — the add's own stderr is the only
    # thing that can explain it later.
    #
    # REACT to git's refusal rather than PREDICT it. The predicate's R1.6 flag is used as a
    # hint, but the authoritative signal is `git add` itself saying no: measured 2026-08-20,
    # `git check-ignore` SKIPS paths that are in the index, so a TRACKED file living under an
    # ignored directory is never flagged — and that is exactly the path `git add` refuses.
    # Predicting the refusal missed it; reacting to it cannot. This is also robust to an
    # ignore rule changing between the census and the add, which CH3 makes a live scenario.
    if [ "$forced" -eq 1 ]; then
      addout="$(git -C "$wt" add -f -- "$p" 2>&1)"; arc=$?
    else
      addout="$(git -C "$wt" add -- "$p" 2>&1)"; arc=$?
      if [ "$arc" -ne 0 ] && printf '%s' "$addout" | grep -q 'ignored by one of your .gitignore'; then
        addout="$(git -C "$wt" add -f -- "$p" 2>&1)"; arc=$?
        [ "$arc" -eq 0 ] && log "  (re-added with -f: $p is gitignored but IS classified as work)"
      fi
    fi
    if [ "$arc" -ne 0 ]; then
      log "  ADD FAILED ($arc) for $p: $addout"
      add_failed=$(( add_failed + 1 ))
    fi
    n=$(( n + 1 ))
  done <<EOF
$paths_a
EOF

  [ "$add_failed" -eq 0 ] || { unset GIT_INDEX_FILE; indet "git-add-failed-for-$add_failed-path(s)"; }
  tree="$(git -C "$wt" write-tree 2>/dev/null)" || { unset GIT_INDEX_FILE; indet "write-tree-failed"; }
  [ -n "$tree" ] || { unset GIT_INDEX_FILE; indet "empty-tree"; }

  # ── ASSERT EVERY NAMED PATH ACTUALLY LANDED, before minting a ref ──
  # A `git add` that failed silently would otherwise produce a ref that LOOKS like a backup
  # and is missing the one file that mattered.
  #
  # The tree listing is materialised ONCE, to a file, and never piped into `grep -q`. This
  # script runs under `set -o pipefail`, and `grep -q` exits the instant it matches — which
  # SIGPIPEs the producer, so the PIPELINE returns non-zero on a SUCCESSFUL match. Measured
  # here: every path was correctly staged and present in the tree, and all three were still
  # reported MISSING. It is the estate's own rule with a new face — never judge a command by
  # the exit status of a pipeline it sits inside.
  #
  # Note WHY the hermetic self-test could not catch this: its scratch tree is a handful of
  # files, so `ls-tree` finishes writing before `grep -q` can exit and no SIGPIPE ever
  # happens. The bug is a function of CORPUS SIZE, which is exactly the kind of thing a
  # small fixture is structurally blind to.
  local missing=0 listing="$TMPIDX.tree"
  git -C "$wt" ls-tree -r --name-only "$tree" > "$listing" 2>/dev/null || {
    unset GIT_INDEX_FILE; rm -f "$listing"; indet "ls-tree-failed"; }
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if ! grep -qxF "$p" "$listing"; then
      log "  MISSING from the snapshot tree: $p"; missing=$(( missing + 1 ))
    fi
  done <<EOF
$paths_a
EOF
  rm -f "$listing"
  if [ "$missing" -ne 0 ]; then
    unset GIT_INDEX_FILE
    indet "paths-did-not-land:$missing"
  fi

  # ── R5.5 IDEMPOTENCE: an unchanged tree mints no second ref ──
  local newest newest_tree
  newest="$(list_refs "$wt" | sort -k2,2n | tail -1 | awk '{print $1}')"
  if [ -n "$newest" ]; then
    newest_tree="$(git -C "$wt" rev-parse "$newest^{tree}" 2>/dev/null || echo "")"
    if [ -n "$newest_tree" ] && [ "$newest_tree" = "$tree" ]; then
      unset GIT_INDEX_FILE
      log "PRESERVE_VERDICT=NOTHING_TO_PRESERVE worktree=$wt"
      log "  tree $tree is identical to $newest — no second ref minted"
      return 1
    fi
  fi

  sha="$(GIT_AUTHOR_NAME='AlgoVault WIP' GIT_AUTHOR_EMAIL='wip@algovault.local' \
         GIT_COMMITTER_NAME='AlgoVault WIP' GIT_COMMITTER_EMAIL='wip@algovault.local' \
         git -C "$wt" commit-tree "$tree" $parent -m "wip($slug): auto-preserved $ts" 2>/dev/null)" \
    || { unset GIT_INDEX_FILE; indet "commit-tree-failed"; }
  [ -n "$sha" ] || { unset GIT_INDEX_FILE; indet "commit-tree-empty"; }

  git -C "$wt" update-ref "$ref" "$sha" 2>/dev/null || { unset GIT_INDEX_FILE; indet "update-ref-failed"; }
  unset GIT_INDEX_FILE

  log "PRESERVE_VERDICT=PRESERVED worktree=$wt ref=$ref commit=$sha paths=$n"
  while IFS= read -r p; do [ -n "$p" ] && log "    + $p"; done <<EOF
$paths_a
EOF
  log "  recover with: git -C $wt checkout $ref -- <path>   (see --help for the full runbook)"
  return 0
}

# ══════════════════════════════════════════════════════════════════════════════
ST_PASS=0; ST_FAIL=0
st() { if [ "$2" = "$3" ]; then ST_PASS=$((ST_PASS+1)); echo "  ok   $1";
       else ST_FAIL=$((ST_FAIL+1)); echo "  FAIL $1 — got '$2' want '$3'"; fi; }

run_self_test() {
  local T; T="$(mktemp -d "${TMPDIR:-/tmp}/preserve-selftest.XXXXXX")" || { echo "PRESERVE_VERDICT=INDETERMINATE"; exit 3; }
  trap 'rm -rf "$T"' EXIT
  echo "[preserve] --self-test (hermetic; scratch repos only)"

  # ref-name validation — the colon case that would fail at update-ref
  git check-ref-format "refs/algovault/wip/r/s/20260820T091500Z" 2>/dev/null \
    && st "the chosen timestamp format IS a legal ref" ok ok || st "the chosen timestamp format IS a legal ref" no ok
  git check-ref-format "refs/algovault/wip/r/s/2026-08-20T09:15:00Z" 2>/dev/null \
    && st "an ISO timestamp with a COLON is REJECTED" no ok || st "an ISO timestamp with a COLON is REJECTED" ok ok
  st "slugify strips illegal characters" "$(slugify 'feat/my branch:v2')" "feat-my-branch-v2"

  # a real repo with tracked-modified, untracked, gitignored-flagged and Class-B content
  local R="$T/repo"; mkdir -p "$R"
  git -C "$R" init -q --initial-branch=main >/dev/null 2>&1
  git -C "$R" config user.email a@b; git -C "$R" config user.name a
  git -C "$R" config commit.gpgsign false; git -C "$R" config core.hooksPath /dev/null
  printf 'seed\n' > "$R/tracked.txt"; printf 'research-data\n' > "$R/.gitignore"
  git -C "$R" add tracked.txt .gitignore >/dev/null 2>&1
  git -C "$R" commit -qm seed >/dev/null 2>&1
  printf 'MODIFIED\n' >> "$R/tracked.txt"
  printf 'ALTER TABLE x;\n' > "$R/migration.sql"
  ln -s /tmp "$R/node_modules"
  # A TRACKED file that ALSO matches an ignore rule. Ignore rules do not apply to tracked
  # files, so this one DOES appear in `git status` and therefore in the Class-A set — it is
  # the reachable half of R1.6, and the half `-f` exists for.
  mkdir -p "$R/research-data"; printf 'seed\n' > "$R/research-data/tracked-but-ignored.bin"
  git -C "$R" add -f research-data/tracked-but-ignored.bin >/dev/null 2>&1
  git -C "$R" commit -qm "tracked despite the ignore rule" >/dev/null 2>&1
  printf 'payload\n' >> "$R/research-data/tracked-but-ignored.bin"
  # An UNTRACKED gitignored path: declared, invisible to `git status`, and DELIBERATELY not
  # swept into a WIP snapshot — see the assertion below.
  printf 'huge\n' > "$R/research-data/untracked-ignored.bin"

  local EST="$T/estate"
  mkdir -p "$EST/scripts/lib" "$EST/ops"
  cp "$PREDICATE" "$EST/scripts/lib/worktree-work-pending.sh"
  cat > "$EST/ops/worktree-noise-config.json" <<JSON
{ "repos": ["$R"],
  "rows": [ { "pattern": "node_modules", "match": "basename", "class": "B", "reason": "t", "owner_wave": "t", "added": "2026-08-20" } ] }
JSON
  local P="$EST/scripts/lib/worktree-work-pending.sh"

  local before_status before_index
  before_status="$(git -C "$R" status --porcelain -uall | shasum -a 256 | cut -d' ' -f1)"
  before_index="$(shasum -a 256 "$R/.git/index" | cut -d' ' -f1)"

  local out rc
  out="$(ALGOVAULT_WORK_PENDING_PREDICATE="$P" bash "${BASH_SOURCE[0]}" --worktree "$R" 2>&1)"; rc=$?
  st "a dirty worktree PRESERVES (exit 0)" "$rc" "0"
  st "verdict token is PRESERVED" "$(printf '%s\n' "$out" | grep -c 'PRESERVE_VERDICT=PRESERVED')" "1"

  local ref; ref="$(git -C "$R" for-each-ref --format='%(refname)' 'refs/algovault/wip/**' | head -1)"
  st "a WIP ref was minted" "$([ -n "$ref" ] && echo yes || echo no)" "yes"

  # AC5.1 — modified, untracked AND gitignored-flagged all recoverable
  st "AC5.1 modified TRACKED file is in the snapshot" \
     "$(git -C "$R" show "$ref:tracked.txt" 2>/dev/null | tail -1)" "MODIFIED"
  st "AC5.1 UNTRACKED file is in the snapshot" \
     "$(git -C "$R" show "$ref:migration.sql" 2>/dev/null | tail -1)" "ALTER TABLE x;"
  st "AC5.1 TRACKED-but-gitignored Class-A file is in the snapshot" \
     "$(git -C "$R" show "$ref:research-data/tracked-but-ignored.bin" 2>/dev/null | tail -1)" "payload"
  # DELIBERATE EXCLUSION, asserted so it is a decision rather than an accident. An untracked
  # gitignored path never appears in `git status`, so it is not in the Class-A set and never
  # reaches the temp index. That is correct and load-bearing: the estate's gitignored payload
  # is DECLARED (and protected by exempt_paths), it runs to gigabytes — 1.6 GB in one
  # autonomous-optimizer worktree alone — and sweeping it into a WIP commit on every session
  # end would be a far worse outcome than leaving it where its exemption already protects it.
  st "an UNTRACKED gitignored path is deliberately ABSENT from the WIP tree" \
     "$(git -C "$R" ls-tree -r --name-only "$ref" | grep -c 'untracked-ignored.bin' || true)" "0"

  # AC5.3 — Class-B must be ABSENT
  st "AC5.3 Class-B node_modules is ABSENT from the WIP tree" \
     "$(git -C "$R" ls-tree -r --name-only "$ref" | grep -c '^node_modules$' || true)" "0"

  # AC5.2 — the working tree and the REAL index are byte-identical
  st "AC5.2 working tree untouched" \
     "$(git -C "$R" status --porcelain -uall | shasum -a 256 | cut -d' ' -f1)" "$before_status"
  st "AC5.2 real index untouched" \
     "$(shasum -a 256 "$R/.git/index" | cut -d' ' -f1)" "$before_index"
  st "AC5.2 both sides were non-empty" "$([ -n "$before_status" ] && [ -n "$before_index" ] && echo yes || echo no)" "yes"

  # the working BRANCH must not have moved, and no stash may exist
  st "the working branch did NOT move" \
     "$(git -C "$R" rev-parse HEAD)" "$(git -C "$R" rev-parse main)"
  st "no stash entry was created" "$(git -C "$R" stash list | grep -c . || true)" "0"

  # AC5.5 — idempotence
  out="$(ALGOVAULT_WORK_PENDING_PREDICATE="$P" bash "${BASH_SOURCE[0]}" --worktree "$R" 2>&1)"; rc=$?
  st "AC5.5 second run on an unchanged tree is NOTHING_TO_PRESERVE (exit 1)" "$rc" "1"
  st "AC5.5 ref count stayed at 1 (uncapped enumeration)" \
     "$(git -C "$R" for-each-ref --format='%(refname)' 'refs/algovault/wip/**' | grep -c . )" "1"

  # a CHANGED tree mints a second ref
  printf 'more\n' >> "$R/migration.sql"
  ALGOVAULT_WORK_PENDING_PREDICATE="$P" bash "${BASH_SOURCE[0]}" --worktree "$R" >/dev/null 2>&1
  st "a CHANGED tree DOES mint a second ref" \
     "$(git -C "$R" for-each-ref --format='%(refname)' 'refs/algovault/wip/**' | grep -c . )" "2"

  # AC5.6 — a clean worktree is NOTHING_TO_PRESERVE, and that is GREEN
  local C="$T/clean"; mkdir -p "$C"
  git -C "$C" init -q --initial-branch=main >/dev/null 2>&1
  git -C "$C" config user.email a@b; git -C "$C" config user.name a
  git -C "$C" config commit.gpgsign false; git -C "$C" config core.hooksPath /dev/null
  printf 'x\n' > "$C/f"; git -C "$C" add f >/dev/null 2>&1; git -C "$C" commit -qm s >/dev/null 2>&1
  cat > "$EST/ops/worktree-noise-config.json" <<JSON
{ "repos": ["$C"],
  "rows": [ { "pattern": "node_modules", "match": "basename", "class": "B", "reason": "t", "owner_wave": "t", "added": "2026-08-20" } ] }
JSON
  out="$(ALGOVAULT_WORK_PENDING_PREDICATE="$P" bash "${BASH_SOURCE[0]}" --worktree "$C" 2>&1)"; rc=$?
  st "AC5.6 clean worktree exits 1 = NOTHING_TO_PRESERVE" "$rc" "1"
  st "AC5.6 and says so in its token" "$(printf '%s\n' "$out" | grep -c 'NOTHING_TO_PRESERVE')" "1"

  # AC5.7 — fault injection: an unusable predicate is INDETERMINATE, never a crash
  out="$(ALGOVAULT_WORK_PENDING_PREDICATE="$T/nope.sh" bash "${BASH_SOURCE[0]}" --worktree "$R" 2>&1)"; rc=$?
  st "AC5.7 missing predicate -> INDETERMINATE (exit 3)" "$rc" "3"
  st "AC5.7 and it is a VERDICT, not a crash" "$(printf '%s\n' "$out" | grep -c 'PRESERVE_VERDICT=INDETERMINATE')" "1"
  out="$(bash "${BASH_SOURCE[0]}" --worktree "$T/not-a-repo" 2>&1)"; rc=$?
  st "a non-existent worktree -> INDETERMINATE (exit 3)" "$rc" "3"

  # R5.4 — the leak vectors, asserted on the SCRATCH repo (it has no remote at all)
  st "R5.4 refs live outside refs/heads/*" \
     "$(git -C "$R" for-each-ref --format='%(refname)' 'refs/heads/**' | grep -c 'algovault' || true)" "0"

  echo "[preserve] --self-test: $ST_PASS passed, $ST_FAIL failed"
  [ "$ST_PASS" -eq 0 ] && { echo "PRESERVE_VERDICT=INDETERMINATE (empty corpus)"; exit 3; }
  [ "$ST_FAIL" -ne 0 ] && { echo "PRESERVE_SELFTEST=FAIL"; exit 1; }
  echo "PRESERVE_SELFTEST=PASS"; exit 0
}

case "$MODE" in
  selftest) run_self_test ;;
  list)     do_list ;;
  preserve)
    [ -n "$WT" ] || { echo "preserve: --worktree <path> is required" >&2; exit 3; }
    preserve "$WT"; exit $?
    ;;
esac
