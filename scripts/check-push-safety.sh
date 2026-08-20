#!/usr/bin/env bash
#
# check-push-safety.sh — refuse HISTORY DESTRUCTION on a protected ref, at pre-push.
# OPS-AOE-PREPUSH-RESTORE-W1.
#
# ─── WHAT THIS CLOSES ───────────────────────────────────────────────────────────────────────
# CLAUDE.md states as LAW "Never force push to main/master" and "Never reset --hard / push
# --force / branch -D without auth". Measured 2026-08-02 on origin/main: of the four live
# pre-push blocks (check_test_baseline.sh, check-session-drift.mjs, check-source-greppable.mjs,
# check-shared-state.mjs) **zero** read the hook's stdin. stdin is the ONLY channel by which a
# pre-push hook learns which refs are being pushed, so none of them could detect a force push or
# a deletion even in principle. Both laws were enforced by prose alone. This is that enforcement.
#
# ─── "PROTECT MAIN" DOES NOT MEAN "BLOCK PUSHES TO MAIN" ────────────────────────────────────
# This repo's LAW is auto-commit + auto-push on R-step completion, and merges land on the
# default branch as plain fast-forwards. A conventional main-protection hook that refuses direct
# pushes would halt EVERY wave in the repo — a worse outage than the one this arc just retired,
# and in the one file that governs all 75 checkouts. So the protectable surface is history
# destruction, and only two things are refused:
#
#   1. NON-FAST-FORWARD to a protected ref — `git merge-base --is-ancestor <remote> <local>`
#      false. That IS what a force push is, detected by its EFFECT rather than by guessing at a
#      flag the hook is never shown. (`git push --force` that happens to be a fast-forward
#      destroys nothing and is not refused; a plain `git push` that would drop commits IS.)
#   2. DELETION of a protected ref — all-zero local sha.
#
# Explicitly ALLOWED, each pinned by a --self-test case in both directions:
#   · an ordinary fast-forward to a protected ref — the normal path every wave ships through;
#   · a brand-new remote branch (all-zero REMOTE sha) — every cc-session.sh worktree's first push;
#   · anything at all on a non-protected ref — force-pushing a feature branch stays routine.
#
# ─── THE STDIN CONTRACT: THREE STATES, NOT TWO ──────────────────────────────────────────────
# A vacuity guard belongs where the corpus is CONSTRUCTED, not where it is OBSERVED.
#   · --self-test  — WE build the fixture corpus, so empty there means the test built nothing.
#                    That is a defect in the test. REFUSE. (the vacuity guard lives there)
#   · runtime      — GIT builds the corpus, so empty here is a FACT: no ref updates were
#                    attempted. The correct verdict over zero ref updates is PASS.
# "Empty input" is only vacuity when YOU were supposed to fill it.
#
# This is not hypothetical: measured 2026-08-02, `git push` with nothing to push prints
# "Everything up-to-date" AND STILL RUNS THE HOOK, with all four sibling blocks emitting PASS.
# Blocking on empty stdin would therefore refuse a completely routine no-op push.
#
#   0 lines              -> PASS, with an explicit positive line. A REPORTED pass, never a
#                           silent one — the house law is "assert positive per-row output",
#                           not "block on absence".
#   non-empty, unparseable -> INDETERMINATE (3), BLOCKS. We were handed something and could not
#                           understand it; that is genuine indeterminacy and fail-closed must
#                           survive here.
#   >=1 well-formed line -> evaluate.
#
# ─── ORDERING NOTE ──────────────────────────────────────────────────────────────────────────
# This block sorts FIRST in the shared hook's canonical LC_ALL=C order (push-safety <
# session-drift < shared-state < source-greppable < test-gate), which is deliberate: it is the
# cheapest guard (one stdin read + one merge-base per ref) and the most consequential, so it
# refuses history destruction in milliseconds rather than after a full vitest run.
# CONSEQUENCE: it CONSUMES the hook's stdin. Nothing breaks today — measured, 0 of the other 4
# read stdin — but a future stdin-reading block would find it drained. If one is ever added,
# tee stdin here rather than making it sort earlier.
#
# Verdict: exactly one terminal `PUSH_SAFETY_VERDICT=PASS|FAIL|INDETERMINATE`.
# Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (token-law default for a new gate; deliberately
# NOT check_test_baseline.sh's 2, which is 2 only because it already deployed 2).
# ALGOVAULT_PUSH_SAFETY=warn downgrades the EXIT CODE only, never the TOKEN.
#
#   scripts/check-push-safety.sh              # reads pre-push stdin
#   scripts/check-push-safety.sh --self-test  # hermetic, two-way, vacuity-guarded

# Deliberately NOT `set -e`: every exit path must print exactly one verdict token, and an
# unguarded errexit would leave the caller with a bare non-zero code and no token at all.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CONFIG_PATH="${ALGOVAULT_PUSH_SAFETY_CONFIG:-$REPO_ROOT/ops/push-safety-config.json}"
MODE="${ALGOVAULT_PUSH_SAFETY:-block}"

ledger_append() {  # $1 = token — records an ALLOWED push only (see verdict()).
  local common
  common="$(cd "$(git rev-parse --git-common-dir 2>/dev/null || echo .git)" && pwd)" || return 0
  printf '%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "PUSH_SAFETY_FAILOPEN" "$1" "$(git rev-parse --show-toplevel 2>/dev/null)" \
    >>"$common/algovault-hook-skip.log" 2>/dev/null || true
}

verdict() {  # $1 = token
  local token="$1" code
  case "$token" in
    PASS) code=0 ;;
    FAIL) code=1 ;;
    *)    code=3 ;;
  esac
  if [ "$MODE" = "warn" ] && [ "$token" != "PASS" ]; then
    printf '%s\n' "[push-safety] ALGOVAULT_PUSH_SAFETY=warn — reporting $token without blocking."
    # The ledger records UNGATED PUSHES only. A blocked run let nothing through, so it is not a
    # ledger event — the same invariant check_test_baseline.sh's fail_open() already pins.
    ledger_append "$token"
    code=0
  fi
  printf '%s\n' "PUSH_SAFETY_VERDICT=$token"
  exit "$code"
}

# Protected refs, read ONLY from the committed config. There is no ref pattern in this script:
# a pattern here is one a future wave "fixes" without noticing it is load-bearing.
# node rather than jq: the shared hook already hard-depends on node for three sibling blocks,
# so this adds no new dependency, whereas jq is required by only one.
load_protected_refs() {
  [ -r "$CONFIG_PATH" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(j.protected_refs)) process.exit(2);
    for (const r of j.protected_refs) {
      if (!r || typeof r.ref !== "string" || !r.ref) process.exit(2);
      if (typeof r.reason !== "string" || r.reason.trim() === "") process.exit(3); // reason is mandatory
      console.log(r.ref);
    }
  ' "$CONFIG_PATH" 2>/dev/null
}

# Ref NAMESPACES that must never leave this machine, read from the same committed config and
# under the same rules: pattern in the config, never in this script, and a mandatory `reason`
# on every row. A DIFFERENT question from `protected_refs` — that one asks "is this push
# destroying history on a ref we declared?", this one asks "is this content allowed to leave
# at all?" — so it is loaded and evaluated separately rather than folded into the same list.
load_never_push_refs() {
  [ -r "$CONFIG_PATH" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!Array.isArray(j.never_push_refs)) process.exit(2);
    for (const r of j.never_push_refs) {
      if (!r || typeof r.pattern !== "string" || !r.pattern) process.exit(2);
      if (typeof r.reason !== "string" || r.reason.trim() === "") process.exit(3); // reason is mandatory
      console.log(r.pattern + "\t" + r.reason.replace(/\s+/g, " "));
    }
  ' "$CONFIG_PATH" 2>/dev/null
}

is_zero_sha() { case "$1" in *[!0]*) return 1 ;; *) return 0 ;; esac; }
is_hex_sha()  { printf '%s' "$1" | grep -qE '^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$'; }

# ── self-test ───────────────────────────────────────────────────────────────────────────────
self_test() {
  local tmp fails=0 cases=0
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/push-safety-selftest.XXXXXX")" || {
    printf '%s\n' "✖ self-test: mktemp -d failed"; verdict INDETERMINATE; }

  # A real repo with a real fork so ancestry is genuine, not stubbed.
  ( cd "$tmp" && git init -q -b main . && git config user.email t@example.com && git config user.name t \
    && echo one >f && git add f && git commit -qm one \
    && echo two >f && git commit -qam two \
    && git branch fork HEAD~1 \
    && cd "$tmp" && echo rewritten >f && git commit -qam rewritten ) >/dev/null 2>&1

  local base tip rewritten zero='0000000000000000000000000000000000000000'
  base="$(git -C "$tmp" rev-parse fork)"       # ancestor of nothing after the rewrite
  tip="$(git -C "$tmp" rev-parse main)"
  rewritten="$tip"
  local ff_from ff_to
  ff_from="$(git -C "$tmp" rev-parse HEAD~1)"
  ff_to="$tip"

  local cfg="$tmp/cfg.json"
  printf '%s\n' '{"protected_refs":[{"ref":"refs/heads/main","reason":"fixture"}],"never_push_refs":[{"pattern":"refs/algovault/*","reason":"fixture: local-only WIP snapshots"}]}' >"$cfg"

  run_case() {  # $1 = label, $2 = expected token, $3 = stdin
    cases=$((cases + 1))
    local out token
    # printf '%s' (no newline) would make `while read` hit EOF and DROP the only line, so every
    # refuse-case would silently look like "empty stdin -> PASS". Caught by this self-test on its
    # first run: 4 of 8 cases were green-by-vacuum. Feed exactly what git feeds — newline-terminated
    # lines — and keep the empty case genuinely empty.
    if [ -n "$3" ]; then out="$(printf '%s\n' "$3" | ALGOVAULT_PUSH_SAFETY=block ALGOVAULT_PUSH_SAFETY_CONFIG="$cfg" bash "$0" --_evaluate --_repo "$tmp" 2>&1)"
    else                 out="$(printf ''       | ALGOVAULT_PUSH_SAFETY=block ALGOVAULT_PUSH_SAFETY_CONFIG="$cfg" bash "$0" --_evaluate --_repo "$tmp" 2>&1)"
    fi
    token="$(printf '%s\n' "$out" | grep -oE 'PUSH_SAFETY_VERDICT=[A-Z]+' | tail -1 | cut -d= -f2)"
    if [ "$token" != "$2" ]; then
      printf '  ✖ %-46s expected %-14s got %s\n' "$1" "$2" "${token:-<none>}"
      fails=$((fails + 1))
    else
      printf '  ✓ %-46s %s\n' "$1" "$2"
    fi
  }

  printf '%s\n' "[push-safety] self-test"
  run_case "fast-forward to a protected ref"        PASS "refs/heads/main $ff_to refs/heads/main $ff_from"
  run_case "NON-fast-forward to a protected ref"    FAIL "refs/heads/main $base refs/heads/main $rewritten"
  run_case "deletion of a protected ref"            FAIL "refs/heads/main $zero refs/heads/main $tip"
  run_case "force-push to a NON-protected ref"      PASS "refs/heads/fork $base refs/heads/fork $rewritten"
  run_case "first push of a brand-new branch"       PASS "refs/heads/new $tip refs/heads/new $zero"
  run_case "empty stdin (git attempted no updates)" PASS ""
  run_case "unparseable stdin"                      INDETERMINATE "this is not a ref line"
  run_case "malformed sha"                          INDETERMINATE "refs/heads/main deadbeef refs/heads/main $tip"

  # ── never_push_refs: exfiltration of a local-only namespace ──────────────────────────────
  # The live vector, measured 2026-08-20: `git push --mirror` carries every ref under refs/.
  run_case "WIP namespace, mirror shape"            FAIL "refs/algovault/wip/r/s/20260820T101500Z $tip refs/algovault/wip/r/s/20260820T101500Z $zero"
  # A crafted refspec can rename the namespace on the way out; the content still leaves, so
  # BOTH the local and the remote ref are matched.
  run_case "WIP namespace remapped onto refs/heads" FAIL "refs/algovault/wip/r/s/t $tip refs/heads/leaked $zero"
  # MUST-NOT-FIRE. `refs/algovault/*` is a namespace PREFIX, not a substring: a branch merely
  # named after the org is an ordinary branch and must still push. Without this case the
  # pattern could tighten into "anything containing algovault" and nobody would notice until a
  # normal push was refused.
  run_case "a branch merely NAMED algovault-*"      PASS "refs/heads/algovault-thing $tip refs/heads/algovault-thing $zero"
  # MULTI-REF. Every case above feeds ONE ref, so none of them can catch a refusal that stops
  # the scan early — which is exactly the bug a real `git push --mirror` (5 refs on stdin)
  # exposed after all 11 single-ref cases were green.
  run_case "multi-ref: earlier refusal must not hide a later one" FAIL \
"refs/heads/main $base refs/heads/main $rewritten
refs/algovault/wip/r/s/t $tip refs/algovault/wip/r/s/t $zero"

  # Vacuity guard — belongs HERE, where WE built the corpus.
  if [ "$cases" -eq 0 ]; then
    printf '%s\n' "✖ self-test ran ZERO cases — refusing to report success over an empty corpus"
    rm -rf "$tmp"; verdict INDETERMINATE
  fi
  if [ -z "$base" ] || [ -z "$tip" ] || [ "$base" = "$tip" ]; then
    printf '%s\n' "✖ self-test fixture is degenerate (no real fork) — its FAIL cases would be vacuous"
    rm -rf "$tmp"; verdict INDETERMINATE
  fi

  rm -rf "$tmp"
  if [ "$fails" -ne 0 ]; then
    printf '%s\n' "✖ self-test: $fails of $cases case(s) failed"
    verdict INDETERMINATE
  fi
  printf '%s\n' "✓ self-test: $cases/$cases cases — 6 refuse, 6 allow, all three stdin states pinned,"
  printf '%s\n' "  and both questions covered: history destruction AND local-only-namespace exfiltration."
  verdict PASS
}

# ── evaluation ──────────────────────────────────────────────────────────────────────────────
EVAL_REPO=""
if [ "${1:-}" = "--self-test" ]; then self_test; fi
if [ "${1:-}" = "--_evaluate" ]; then
  shift
  if [ "${1:-}" = "--_repo" ]; then EVAL_REPO="${2:-}"; fi
fi
GIT=(git)
[ -n "$EVAL_REPO" ] && GIT=(git -C "$EVAL_REPO")

PROTECTED="$(load_protected_refs)" || {
  printf '%s\n' "✖ push-safety: cannot read protected refs from $CONFIG_PATH"
  printf '%s\n' "  A guard that cannot load its own declaration has not verified anything — failing closed."
  printf '%s\n' "  (A row missing its mandatory 'reason' also lands here: an exemption without a reason"
  printf '%s\n' "   is exactly what a future wave 'fixes' without knowing it was load-bearing.)"
  verdict INDETERMINATE
}

# An empty protected set is CONSTRUCTED vacuity, not observed vacuity: we wrote the config, so
# declaring nothing means we built nothing. Same rule as the self-test corpus — refuse. (Contrast
# with empty stdin, which git constructs and which legitimately means "no ref updates attempted".)
if [ -z "${PROTECTED//[[:space:]]/}" ]; then
  printf '%s\n' "✖ push-safety: $CONFIG_PATH declares ZERO protected refs."
  printf '%s\n' "  Refusing to report a pass over an empty declaration — that would be a guard that"
  printf '%s\n' "  cannot fail. If nothing should be protected, retire the block; do not empty the list."
  verdict INDETERMINATE
fi

NEVER_PUSH="$(load_never_push_refs)" || {
  printf '%s\n' "✖ push-safety: cannot read never_push_refs from $CONFIG_PATH"
  printf '%s\n' "  Same rule as the protected set: a guard that cannot load its own declaration has"
  printf '%s\n' "  verified nothing. A row missing its mandatory 'reason' also lands here."
  verdict INDETERMINATE
}
if [ -z "${NEVER_PUSH//[[:space:]]/}" ]; then
  printf '%s\n' "✖ push-safety: $CONFIG_PATH declares ZERO never-push namespaces."
  printf '%s\n' "  Constructed vacuity — we wrote this config, so declaring nothing means we built"
  printf '%s\n' "  nothing. If no namespace is local-only any more, retire the key; do not empty it."
  verdict INDETERMINATE
fi

# Echo the matched row's reason and return 0; return 1 if the ref may leave.
# `case` globs are used deliberately: `*` spans `/`, so `refs/algovault/*` covers the whole
# namespace at any depth, while `refs/heads/algovault-anything` does NOT match — the pattern is
# a namespace prefix, not a substring. Both directions are pinned by --self-test.
never_push_reason() {
  local ref="$1" line pat reason
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    pat="${line%%	*}"; reason="${line#*	}"
    # shellcheck disable=SC2254
    case "$ref" in $pat) printf '%s' "$reason"; return 0 ;; esac
  done <<EOF
$NEVER_PUSH
EOF
  return 1
}

is_protected() {
  local ref="$1" p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    [ "$p" = "$ref" ] && return 0
  done <<EOF
$PROTECTED
EOF
  return 1
}

lines=0; refused=0; inspected=0
# `|| [ -n "$line" ]` so a final line with no trailing newline is still processed rather than
# silently dropped at EOF — otherwise a malformed last line reads as "no ref updates" and PASSES.
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "${line//[[:space:]]/}" ] || { line=""; continue; }
  lines=$((lines + 1))
  # shellcheck disable=SC2086
  set -- $line
  if [ "$#" -ne 4 ]; then
    printf '%s\n' "✖ push-safety: cannot parse pre-push stdin line ${lines}: '$line'"
    printf '%s\n' "  Expected '<local-ref> <local-sha> <remote-ref> <remote-sha>' (4 fields, got $#)."
    printf '%s\n' "  Refusing to judge input we do not understand."
    verdict INDETERMINATE
  fi
  local_ref="$1"; local_sha="$2"; remote_ref="$3"; remote_sha="$4"

  if ! is_zero_sha "$local_sha" && ! is_hex_sha "$local_sha"; then
    printf '%s\n' "✖ push-safety: line ${lines} local sha is not a sha: '$local_sha'"; verdict INDETERMINATE
  fi
  if ! is_zero_sha "$remote_sha" && ! is_hex_sha "$remote_sha"; then
    printf '%s\n' "✖ push-safety: line ${lines} remote sha is not a sha: '$remote_sha'"; verdict INDETERMINATE
  fi

  # EXFILTRATION CHECK — first, and on BOTH refs. It is independent of fast-forward-ness:
  # a perfectly clean fast-forward of a local-only namespace is still the content leaving.
  # `--mirror` is the live vector; it pushes every ref under refs/ and has no per-ref opt-out.
  leak_ref=""; npr=""
  for _r in "$local_ref" "$remote_ref"; do
    if npr="$(never_push_reason "$_r")"; then leak_ref="$_r"; break; fi
    npr=""
  done
  if [ -n "$leak_ref" ]; then
      printf '%s\n' ""
      printf '%s\n' "✖ push-safety: REFUSING to push $leak_ref — a local-only namespace"
      printf '%s\n' "    local  : $local_ref"
      printf '%s\n' "    remote : $remote_ref"
      printf '%s\n' "    reason : $npr"
      printf '%s\n' "    This is NOT a history-destruction refusal — the push may be a clean"
      printf '%s\n' "    fast-forward. The content itself is not allowed to leave the machine."
      printf '%s\n' "    If you reached this via 'git push --mirror', that is the vector this"
      printf '%s\n' "    exists for: --mirror carries every ref under refs/ and cannot exclude one."
      refused=$((refused + 1))
      # `continue`, never `break`. An earlier version broke out of the whole loop when the
      # shared `refused` counter was non-zero — which meant ANY prior refusal (a non-fast-
      # forward on main, say) aborted the scan before it reached the namespace refs, and the
      # guard silently under-reported. The self-test could not see it: every case feeds ONE
      # ref, so no case has a second line to drop. Only a real `git push --mirror` with five
      # refs on stdin exposed it. Every ref update gets judged, always.
      continue
  fi

  if ! is_protected "$remote_ref"; then
    printf '%s\n' "  ✓ $remote_ref — not a protected ref, nothing to enforce"
    continue
  fi
  inspected=$((inspected + 1))

  # DELETION — all-zero LOCAL sha.
  if is_zero_sha "$local_sha"; then
    printf '%s\n' ""
    printf '%s\n' "✖ push-safety: REFUSING to delete the protected ref $remote_ref"
    printf '%s\n' "    remote sha : $remote_sha"
    printf '%s\n' "    CLAUDE.md: 'Never reset --hard / push --force / branch -D without auth.'"
    printf '%s\n' "    If this is genuinely intended, get authorisation and remove the ref's row from"
    printf '%s\n' "    ops/push-safety-config.json in a reviewed commit — not with an override."
    refused=$((refused + 1))
    continue
  fi

  # NEW remote ref — all-zero REMOTE sha. Cannot destroy history that does not exist.
  if is_zero_sha "$remote_sha"; then
    printf '%s\n' "  ✓ $remote_ref — new remote ref, no history to destroy"
    continue
  fi

  # The remote object must be present locally or ancestry is unknowable. Treating a missing
  # object as "not an ancestor" would block a legitimate push on a stale fetch — so it is
  # INDETERMINATE, not FAIL.
  if ! "${GIT[@]}" cat-file -e "$remote_sha^{commit}" 2>/dev/null; then
    printf '%s\n' "✖ push-safety: $remote_ref remote sha $remote_sha is not present locally."
    printf '%s\n' "  Ancestry is unknowable without it, so this is INDETERMINATE, not a refusal."
    printf '%s\n' "  Fix: git fetch origin   # then push again"
    verdict INDETERMINATE
  fi

  if "${GIT[@]}" merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
    printf '%s\n' "  ✓ $remote_ref — fast-forward ($(printf '%.12s' "$remote_sha") → $(printf '%.12s' "$local_sha")), no history destroyed"
    continue
  fi

  printf '%s\n' ""
  printf '%s\n' "✖ push-safety: REFUSING a NON-FAST-FORWARD push to the protected ref $remote_ref"
  printf '%s\n' "    remote sha : $remote_sha   (what the remote has now)"
  printf '%s\n' "    local  sha : $local_sha   (what you are about to make it)"
  printf '%s\n' "    Why: the remote sha is NOT an ancestor of the local sha, so commits currently on"
  printf '%s\n' "    $remote_ref would stop being reachable. That is what a force push IS, regardless of"
  printf '%s\n' "    which flag produced it. CLAUDE.md: 'Never force push to main/master.'"
  printf '%s\n' "    Commits that would be dropped:"
  "${GIT[@]}" log --oneline "$local_sha..$remote_sha" 2>/dev/null | sed 's/^/      /' | head -20
  printf '%s\n' "    Remediation — REVERT-THEN-REAPPLY, never reset --hard:"
  printf '%s\n' "      git revert <sha>      # push the revert, then re-apply the intended edits"
  refused=$((refused + 1))
done

if [ "$lines" -eq 0 ]; then
  # Not vacuity: git told us there are no ref updates. Reported, never silent.
  printf '%s\n' "[push-safety] no ref updates on stdin — nothing to inspect (0 refs)"
  verdict PASS
fi

if [ "$refused" -gt 0 ]; then
  printf '%s\n' ""
  printf '%s\n' "[push-safety] $refused of $lines ref update(s) refused; $inspected on protected refs."
  verdict FAIL
fi

printf '%s\n' "[push-safety] $lines ref update(s) checked, $inspected on protected refs — no history destroyed."
verdict PASS
