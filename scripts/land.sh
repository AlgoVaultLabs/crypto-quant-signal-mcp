#!/usr/bin/env bash
#
# scripts/land.sh — OPS-SERIALIZE-LANDING-AND-DEPLOY-W1 CH1 R2.
#
# THE CRITICAL SECTION:   acquire -> fetch -> rebase onto the remote default -> git push -> release
#
# ─── WHY THE LOCK IS HERE AND NOT IN THE HOOK ───────────────────────────────────────────────
#
# A lock held only inside the pre-push hook does NOT fix the push race. Traced against the
# measured hook:
#
#   Session A `git push` -> hook acquires -> ~2-min gate -> hook exits -> transfer succeeds
#   Session B `git push` -> hook blocks on the lock -> A finishes -> B's gate runs ~2 min ->
#             hook exits -> transfer STILL REFUSED non-fast-forward, because B never rebased
#             onto A's new tip. B waited politely and then failed anyway.
#
# git has already computed the refs being pushed by the time a pre-push hook runs, a pre-push
# hook cannot rebase, and there is no post-push hook to release against. So the critical section
# must contain the FETCH and the REBASE, which means it must live in a wrapper — this file.
#
# ─── WHAT IS AND IS NOT CLAIMED ─────────────────────────────────────────────────────────────
#
# `git push` runs BOTH the ~2-minute gate and the ref transfer, and the lock is released only
# after it returns. So for any two sessions that both go through land.sh, the second cannot begin
# its fetch until the first has fully landed, and therefore always rebases onto a tip that cannot
# move under it. WITHIN THE LOCK'S SCOPE THE NON-FAST-FORWARD RACE IS ELIMINATED, NOT REDUCED.
# There is no residual timing window for participants, and there is no "window reduction"
# percentage to quote — a landing runs the gate exactly ONCE.
#
# The residual risk is not timing, it is SCOPE, and all three cases are declared:
#
#   1. a push that BYPASSES land.sh (a raw `git push`) — measured by the `bypass-detect`
#      pre-push block, which is REPORT-only this wave;
#   2. a writer OUTSIDE the one Mac sharing $GIT_COMMON_DIR — a cloud session, a second machine,
#      or CI. This is not hypothetical: .github/workflows/regenerate-landing.yml commits
#      regenerated landing surfaces and `git push`es to main with a PAT. Declared on the
#      `ref-main` row in ops/shared-worktree-state.json; hardening is
#      OPS-CI-MAIN-WRITER-HARDEN-W{NEXT};
#   3. a lock TIMEOUT, which fails open by design and announces itself with a token.
#
# THE BOUNDED REBASE-RETRY BELOW IS THE FAIL-SAFE FOR THOSE THREE CASES ONLY. It is not what
# makes landing safe and must not be described as such. Inside the lock it must never fire —
# CH1-R5 asserts exactly that, and a retry firing there would falsify the elimination claim.
#
# ─── VERDICT TOKEN ──────────────────────────────────────────────────────────────────────────
#
#   LAND_VERDICT=LANDED | DIRTY | TAGGED | CONFLICT | GATE_BLOCKED | EXHAUSTED | INDETERMINATE
#   LAND_ATTEMPTS=<n>        # push attempts made; 1 == the lock did its job
#
#   exit 0 -> LANDED
#   exit 1 -> DIRTY · CONFLICT · GATE_BLOCKED · EXHAUSTED     (a clean, named non-zero)
#   exit 3 -> INDETERMINATE  (token-law default for a NEW gate — could not evaluate, never
#                             "evaluated and fine")
#
# It also surfaces LANDING_LOCK_VERDICT= once, from the lock primitive.
#
# ─── WHAT THIS SCRIPT MUST NEVER DO ─────────────────────────────────────────────────────────
#
#   · never pass a force flag, a verify-skipping flag, or a deletion flag to git push. The gate
#     IS the point; a lander that can skip it is a lander that will be used to skip it.
#   · never auto-resolve a rebase conflict. An auto-resolving lander is a data-integrity hazard;
#     conflicts are handed back to the operator with the exact conflicted paths.
#   · never swallow, re-interpret or downgrade a hook block's verdict token. A push refused by
#     a gate is GATE_BLOCKED and is NOT retried — retrying a red gate is routing around it,
#     which this repo forbids outright. Only a non-fast-forward is retryable.
#
# ─── USAGE ──────────────────────────────────────────────────────────────────────────────────
#
#   bash scripts/land.sh                 # rebase onto the remote default and fast-forward it
#   bash scripts/land.sh --remote origin
#   bash scripts/land.sh --to <branch>   # publish HEAD to some OTHER branch (no rebase; see below)
#   bash scripts/land.sh --dry-run       # everything except the transfer (no lock is taken)
#
# ─── WHAT "LAND" TARGETS, AND WHY IT IS NOT THE CURRENT BRANCH ──────────────────────────────
#
# The default target is the REMOTE DEFAULT BRANCH, pushed as `HEAD:<default>`. That is this
# repo's house landing operation — auto-commit + auto-push, merges arriving as plain
# fast-forwards — and it is the only target for which the rebase above it makes sense.
#
# Pushing the CURRENT BRANCH would be incoherent with rebasing, and the first dogfood run proved
# it rather than the argument: rebasing onto a moved origin/main rewrites this branch's commits,
# so pushing it back to its OWN already-published remote ref is a NON-FAST-FORWARD. The retry
# then re-fetches, rebases again, and is refused again — an unbounded loop dressed as a
# fail-safe, resolvable only with a force flag this script must never carry. Landing onto the
# default branch is a fast-forward by construction, because the rebase just made it one.
#
# `--to <branch>` publishes HEAD elsewhere and deliberately SKIPS the rebase: rebasing onto the
# default and then pushing somewhere else is the incoherent combination above. Use it to publish
# a feature branch; use the default form to land.
#
# Portable to macOS bash 3.2.

set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf '%s\n' "✖ land: not inside a git repository."
  printf 'LAND_VERDICT=%s\n' INDETERMINATE
  exit 3
}

# shellcheck source=scripts/lib/with-lock.sh
. "$REPO_ROOT/scripts/lib/with-lock.sh"

LOCK_NAME="${ALGOVAULT_LAND_LOCK_NAME:-landing}"
REMOTE="origin"
TARGET=""
DRY_RUN=0
# 3 attempts: the retry exists only for the three out-of-scope cases above, and an unbounded
# loop is the livelock this wave retires. Exhaustion is a clean non-zero with a token, never a
# silent give-up.
MAX_ATTEMPTS="${ALGOVAULT_LAND_MAX_ATTEMPTS:-3}"
BACKOFF_BASE="${ALGOVAULT_LAND_BACKOFF_BASE:-2}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote) REMOTE="${2:-origin}"; shift 2 ;;
    --to) TARGET="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,60p' "$0" | sed -e 's/^# \{0,1\}//'; exit 0 ;;
    *) printf '%s\n' "✖ land: unknown argument '$1'"; printf 'LAND_VERDICT=%s\n' INDETERMINATE; exit 3 ;;
  esac
done

ATTEMPTS=0

finish() {  # <token> <exit-code>
  printf 'LAND_ATTEMPTS=%s\n' "$ATTEMPTS"
  printf 'LAND_VERDICT=%s\n' "$1"
  exit "$2"
}

# ── preconditions, all BEFORE the lock is taken ─────────────────────────────────────────────

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  printf '%s\n' "✖ land: HEAD is detached. Check out a branch before landing."
  finish INDETERMINATE 3
fi

# A dirty TRACKED tree is refused — this is git rebase's own precondition, stated up front so it
# fails in milliseconds instead of halfway through a critical section. Untracked files do not
# participate in a rebase, so they warn rather than block.
if ! git diff --quiet || ! git diff --cached --quiet; then
  printf '%s\n' "✖ land: the working tree has uncommitted tracked changes. Refusing to rebase a dirty tree."
  git status --short -- . | sed -e 's/^/    /'
  printf '%s\n' "    Commit or stash them, then re-run."
  finish DIRTY 1
fi
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  printf '%s\n' "⚠️  land: untracked files present (they do not participate in a rebase; continuing)." >&2
fi

# Resolve the remote default ref — NEVER hardcode `main`.
DEFAULT_REF="$(git symbolic-ref --quiet --short "refs/remotes/$REMOTE/HEAD" 2>/dev/null || true)"
[ -n "$DEFAULT_REF" ] || DEFAULT_REF="$REMOTE/main"
DEFAULT_BRANCH="${DEFAULT_REF#"$REMOTE"/}"

# Target defaults to the remote default branch. REBASE only when landing there — see the header.
if [ -z "$TARGET" ]; then TARGET="$DEFAULT_BRANCH"; REBASE=1; else REBASE=0; fi

# ── TAG GUARD — OPS-CI-MAIN-WRITER-HARDEN-W1 CH2 R2 ─────────────────────────────────────────
#
# THE HAZARD, MEASURED (not theorised): this lander REBASES, and a rebase rewrites the commits
# unique to this branch. A tag created BEFORE landing therefore ends up pointing at a commit that
# is no longer on the branch — orphaned, but still perfectly pushable, because `refs/tags/*` is a
# separate namespace with no fast-forward rule to refuse it. And `.github/workflows/publish-npm.yml`
# checks out the TAG TREE. So npm would publish a tree that never landed, with nothing failing
# anywhere. Reproduced 2026-08-21 in a throwaway repo: tag at 9137fb4, HEAD after rebase 38cbb7e,
# `git merge-base --is-ancestor <tag> HEAD` -> NO.
#
# That is the same class as the v1.19.0 frozen npm README and its v1.22.0 recurrence, which the
# release template already documents. Third occurrence of "the tag is on the wrong commit" is
# where a rule becomes a gate.
#
# WHY THE PREDICATE IS WIDE. The literal reading — refuse only when the remote has ALREADY moved,
# i.e. only when a rebase would really rewrite something — RACES ITSELF: this lander fetches
# INSIDE the lock, so the remote can move between this check and the rebase, and the narrow
# predicate would wave through exactly the case it exists to catch. Measured: a rebase onto an
# unmoved upstream leaves SHAs untouched, so the narrow predicate is silent in precisely the
# window where the answer can still change. The wide predicate refuses whenever a tag sits on an
# unlanded commit and a rebase is possible at all. It is race-immune, and it ENFORCES the correct
# ordering rather than merely surviving it.
#
# It is also correctly SCOPED, and does not fire on routine work in a repo full of tags: an old
# release tag points at a commit already on the remote default, which is by definition NOT in
# `$DEFAULT_REF..HEAD`. Only a tag on an unlanded commit trips it. `--to <branch>` sets REBASE=0
# and skips this entirely, because nothing is rewritten there.
#
# Tags are PEELED (`%(*objectname)`), because the release ritual creates ANNOTATED tags: matching
# on `%(objectname)` alone would compare the tag OBJECT's sha against a commit sha and never fire.
if [ "$REBASE" -eq 1 ]; then
  RANGE_SHAS="$(git rev-list "$DEFAULT_REF..HEAD" 2>/dev/null || true)"
  if [ -n "$RANGE_SHAS" ]; then
    ORPHANING="$(git for-each-ref --format='%(refname:short) %(objectname) %(*objectname)' refs/tags/ 2>/dev/null |
      while read -r TAG_NAME TAG_OBJ TAG_PEELED; do
        TARGET_SHA="${TAG_PEELED:-$TAG_OBJ}"
        if printf '%s\n' "$RANGE_SHAS" | grep -qxF "$TARGET_SHA"; then
          printf '%s -> %s\n' "$TAG_NAME" "$TARGET_SHA"
        fi
      done)"
    if [ -n "$ORPHANING" ]; then
      printf '%s\n' "✖ land: a local tag points at a commit this landing would REBASE, which would orphan it."
      printf '%s\n' "$ORPHANING" | sed -e 's/^/      /'
      printf '%s\n' ""
      printf '%s\n' "    A rebase rewrites the commits unique to this branch. The tag would keep pointing at the"
      printf '%s\n' "    OLD commit, which is then on no branch — and publish-npm.yml checks out the TAG TREE, so"
      printf '%s\n' "    npm would publish a tree that never landed. Nothing would fail; it would just be wrong."
      printf '%s\n' ""
      printf '%s\n' "    LAND FIRST, THEN TAG THE LANDED SHA:"
      printf '%s\n' "      1. scripts/land.sh                        # may rebase; no tag exists yet"
      printf '%s\n' "      2. LANDED=\$(git rev-parse HEAD)           # re-read AFTER landing, never a SHA from before"
      printf '%s\n' "      3. git tag -a vX.Y.Z -m vX.Y.Z \"\$LANDED\"  # annotate THAT commit"
      printf '%s\n' "      4. git push origin vX.Y.Z                 # the tag alone; refs/tags/* is its own namespace"
      printf '%s\n' ""
      printf '%s\n' "    To recover from here: delete the premature tag (git tag -d <name>), land, then re-tag the"
      printf '%s\n' "    landed SHA. If it was already pushed, delete it on the remote too before re-tagging."
      finish TAGGED 1
    fi
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s\n' "[land] DRY RUN — branch=$BRANCH remote=$REMOTE default=$DEFAULT_REF target=$TARGET rebase=$REBASE; no lock, no transfer."
  finish LANDED 0
fi

# ── the critical section ────────────────────────────────────────────────────────────────────

# ARM BEFORE ACQUIRING. A signal arriving between the mkdir and the trap install would otherwise
# terminate this shell with the lock still held — same window closed in with-lock.sh, same reason.
#
# INT/TERM must ABORT the landing, not merely release. The first version released and returned,
# so bash resumed the loop with the lock gone — and because `git push` ran in the FOREGROUND the
# trap did not even run until the push finished. Measured: a SIGTERM to a landing mid-gate did
# nothing for the rest of the gate. The push therefore runs in the background under `wait`, and
# the handler kills it before releasing.
on_signal() {
  [ -n "${PUSH_PID:-}" ] && kill -TERM "$PUSH_PID" 2>/dev/null
  algovault_lock_release "$LOCK_NAME"
  trap - EXIT INT TERM
  printf '%s\n' "" "✖ land: interrupted — lock released, nothing was force-pushed." >&2
  ATTEMPTS="${ATTEMPTS:-0}"
  printf 'LAND_ATTEMPTS=%s\n' "$ATTEMPTS"
  printf 'LAND_VERDICT=%s\n' INDETERMINATE
  exit 130
}
trap on_signal INT TERM
trap 'algovault_lock_release "$LOCK_NAME"' EXIT

algovault_lock_acquire "$LOCK_NAME" || finish INDETERMINATE 3
printf 'LANDING_LOCK_VERDICT=%s\n' "$ALGOVAULT_LOCK_VERDICT"

PUSH_OUT="$(mktemp -d "${TMPDIR:-/tmp}/algovault-land.XXXXXX")/push.out"

while [ "$ATTEMPTS" -lt "$MAX_ATTEMPTS" ]; do
  ATTEMPTS=$((ATTEMPTS + 1))

  # Every attempt RE-FETCHES: a retry against a stale view of the remote is not a retry.
  if ! git fetch "$REMOTE" --quiet; then
    printf '%s\n' "✖ land: git fetch $REMOTE failed — cannot establish what to rebase onto."
    finish INDETERMINATE 3
  fi

  if [ "$REBASE" -eq 1 ] && ! git rebase "$DEFAULT_REF" >/dev/null 2>&1; then
    CONFLICTED="$(git diff --name-only --diff-filter=U 2>/dev/null || true)"
    git rebase --abort >/dev/null 2>&1 || true
    printf '%s\n' "✖ land: rebase onto $DEFAULT_REF CONFLICTS. The rebase has been aborted; your branch is untouched."
    printf '%s\n' "    Conflicted paths:"
    printf '%s\n' "$CONFLICTED" | sed -e 's/^/      /'
    printf '%s\n' "    Resolve by hand, then re-run. This lander will never auto-resolve a conflict."
    finish CONFLICT 1
  fi

  # The gate AND the ref transfer both happen inside this call, which is why the lock's scope is
  # the whole of it. No force flag, no verify-skipping flag, no deletion flag — ever.
  git push "$REMOTE" "HEAD:$TARGET" >"$PUSH_OUT" 2>&1 &
  PUSH_PID=$!
  wait "$PUSH_PID"; PUSH_RC=$?
  PUSH_PID=""
  cat "$PUSH_OUT"
  if grep -qE '\[rejected\]|error: failed to push|hook declined' "$PUSH_OUT" 2>/dev/null; then
    PUSH_RC=1
  fi

  if [ "$PUSH_RC" -eq 0 ]; then
    finish LANDED 0
  fi

  # A gate refused. That is NOT retryable: retrying a red gate is routing around it. Surface the
  # block's own token verbatim and stop — land.sh never re-interprets or downgrades it.
  if grep -qE 'hook declined|_VERDICT=(FAIL|INDETERMINATE)' "$PUSH_OUT" 2>/dev/null; then
    printf '%s\n' "✖ land: a pre-push gate refused this push. Its own verdict, verbatim:"
    grep -oE '[A-Z_]+_VERDICT=[A-Z]+' "$PUSH_OUT" | sed -e 's/^/      /' || true
    printf '%s\n' "    land.sh does not retry, warn-mode, or route around a gate. Fix the cause and re-run."
    finish GATE_BLOCKED 1
  fi

  if ! grep -qE 'non-fast-forward|fetch first|stale info|Updates were rejected' "$PUSH_OUT" 2>/dev/null; then
    printf '%s\n' "✖ land: git push failed for a reason this lander does not recognise. Not retrying."
    finish INDETERMINATE 3
  fi

  if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then break; fi

  # Jittered backoff. Jitter matters because the case being retried is CONTENTION with a writer
  # outside the lock; identical backoffs would re-collide in lockstep.
  SLEEP=$(( BACKOFF_BASE * ATTEMPTS + (${RANDOM:-0} % 3) ))
  printf '%s\n' "⚠️  land: non-fast-forward — a writer OUTSIDE this lock moved $DEFAULT_REF." >&2
  printf '%s\n' "⚠️    attempt $ATTEMPTS/$MAX_ATTEMPTS; re-fetching and rebasing in ${SLEEP}s." >&2
  sleep "$SLEEP"
done

printf '%s\n' "✖ land: $MAX_ATTEMPTS attempts exhausted landing HEAD onto $REMOTE/$TARGET."
printf '%s\n' "    Every attempt was refused non-fast-forward, so a writer outside this lock's scope is"
printf '%s\n' "    landing faster than this session can rebase. Escalate rather than loop: see the"
printf '%s\n' "    residual-scope note in this file's header and the ref-main row in"
printf '%s\n' "    ops/shared-worktree-state.json."
finish EXHAUSTED 1
