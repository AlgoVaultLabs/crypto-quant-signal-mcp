#!/usr/bin/env bash
# shellcheck shell=bash
#
# scripts/lib/hook-block.sh — the ONE emitter for guarded blocks in the SHARED git hooks.
# OPS-SHARED-WORKTREE-STATE-REGISTRY-W1.
#
# ─── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────
# Four installers hand-rolled block emission four ways into ONE file that governs EVERY
# worktree. The 4th (OPS-GREPPABLE-SOURCE-GUARD-W1) installed a block invoking a script that
# existed only in its own worktree, and every other session's push died with MODULE_NOT_FOUND.
# It was a DEADLOCK, not merely a failure: `--no-verify` is forbidden by policy and deleting
# the block would have disabled a real guard mid-install.
#
# Measured 2026-08-02 (CH1 census), and the reason this is a precondition rather than a rule:
#   · 74 checkouts share ONE hooks dir  ·  69-70 of them could not push AT ALL
#   · a real `git push --dry-run` from cqsm-wt-mon-inventory ran the full test suite, THEN
#     died on `Cannot find module '<that worktree>/scripts/check-session-drift.mjs'`
#   · `git rev-parse --show-toplevel` inside a hook resolves to the PUSHING WORKTREE, which is
#     precisely why a per-worktree absence becomes a fleet-wide block.
#
# "Install the block last" was the obvious patch. It is a rule people must remember, of exactly
# the kind that already failed for `grep -a` (recorded June, ignored 8 weeks, cost a false HALT
# in August). So ordering is enforced HERE, at install time, and an unsatisfiable block skips
# loudly instead of blocking.
#
# ─── THREE DESIGN DECISIONS THAT ARE NOT OBVIOUS ────────────────────────────────────────────
#
# 1. THE SKIP GUARD IS INLINE, NOT A CALL INTO THIS FILE.
#    An emitted block must NOT `source` this library. A worktree that predates this wave does
#    not contain scripts/lib/hook-block.sh either, so a block that sourced it would fail to
#    source — recreating incident A with the guard itself as the missing dependency. Every
#    emitted block therefore depends on nothing but POSIX sh and git.
#
# 2. THE GUARD USES if/else, NEVER `exit 0`.
#    A bare `exit 0` in a skipped block aborts the WHOLE hook, silently skipping every LATER
#    block. A worktree missing only check_test_baseline.sh would then also skip the drift and
#    greppable gates. `exit 0` skips the hook; if/else skips the block. Only the second is
#    what "skip this guard" means.
#
# 3. BLOCK ORDER IS CANONICAL (LC_ALL=C, by name), IMPOSED ON EVERY WRITE.
#    Order-independence has to be a property of OUR rule, not of the sequence installers happen
#    to run in — otherwise "byte-identical across both orders" is unachievable on a fresh hook
#    and the property test degenerates into a characterization test. Sorting also fixes a real
#    waste observed in the measurement above: the cheap node guards now run BEFORE the full
#    vitest suite, so a blocked push fails in milliseconds instead of after a whole test run.
#    Each guard's own behaviour is unchanged; the guards are mutually independent (separate
#    processes, each `|| exit 1`), so only which failure surfaces first changes.
#
# ─── IDEMPOTENCE KEYS ON <name> ALONE ───────────────────────────────────────────────────────
# The key is `# >>> algovault <name> (` — deliberately NOT including the wave-id. Keying on the
# full sentinel would mean re-running an installer under a NEW wave-id appends a duplicate
# block, which is the same hazard by another door. The trailing " (" keeps `test-gate` from
# matching `test-gate-2`. Re-installing an existing <name> REPLACES that block in place, which
# is what lets a retrofit reach the 74 checkouts already carrying an unguarded copy.
#
# ─── THE SENTINEL SHAPE IS THE LIVE ONE, DELIBERATELY ───────────────────────────────────────
# `# >>> algovault <name> (<WAVE-ID>) >>>` … `# <<< algovault <name> <<<`, adopted verbatim.
# Normalising it to something tidier while 73 worktrees hold installers that detect the OLD
# marker would be *a shared resource mutated into a state only the mutating session can
# satisfy* — this wave's own generator, committed by this wave, in the one file that can break
# every session. The sentinel is cosmetic; the hazard is not.
#
# Usage (see scripts/install_*_hook.sh for the four live consumers):
#   . "$(git rev-parse --show-toplevel)/scripts/lib/hook-block.sh"
#   hook_block_assert_publishable scripts/check-thing.mjs "$ALLOW_UNPUBLISHED" || exit 1
#   hook_block_install pre-push thing OPS-SOME-WAVE-W1 scripts/check-thing.mjs \
#       "$COMMENT" 'node "$(git rev-parse --show-toplevel)/scripts/check-thing.mjs" || exit 1'

# Absolute $GIT_COMMON_DIR. `git rev-parse --git-common-dir` returns a RELATIVE path from the
# primary checkout, so it is resolved rather than used raw.
hook_block_common_dir() {
  (cd "$(git rev-parse --git-common-dir)" && pwd)
}

# The shared ledger. ONE file with an EVENT column, not one file per event class — a second
# ledger is a second thing to forget to read. Mirrors check_test_baseline.sh's
# $GIT_COMMON_DIR/algovault-test-gate-failopen.log convention rather than inventing a dialect.
hook_block_ledger_path() {
  printf '%s/algovault-hook-skip.log\n' "$(hook_block_common_dir)"
}

# TSV: timestamp \t event \t name \t worktree \t script
hook_block_ledger_append() {
  local event="$1" name="$2" script="$3" ledger
  ledger="$(hook_block_ledger_path)" || return 0
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$event" "$name" "$(git rev-parse --show-toplevel)" "$script" \
    >>"$ledger" 2>/dev/null || true
}

# The remote default ref, RESOLVED — never a hardcoded `main`. `main` is this repo's default
# today, but that is not a property of the mechanism (the lesson cc-session.sh's
# default_base_ref already encodes; same shape reused rather than re-derived).
hook_block_default_ref() {
  local sym
  sym=$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null) || sym=""
  if [ -n "$sym" ]; then
    printf '%s\n' "${sym#refs/remotes/}"
  elif git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
    printf 'origin/main\n'
  else
    printf '\n'
  fi
}

# ── THE PRECONDITION ────────────────────────────────────────────────────────────────────────
# Refuse to write a block whose script is not reachable from the remote default ref. This is
# "install the block last", enforced instead of remembered.
#
# FAIL-CLOSED on an unresolvable default ref: this runs at INSTALL time on a developer machine,
# where refusing costs one re-run, while a wrong "yes" costs every parallel session a blocked
# push. Cheap to retry, expensive to get wrong — so it refuses.
#
# $2 = "1" enables the --allow-unpublished bootstrap escape hatch: loud banner AND a ledger
# row, so an override is auditable rather than invisible.
hook_block_assert_publishable() {
  local script="$1" allow="${2:-0}" ref
  ref="$(hook_block_default_ref)"

  if [ -z "$ref" ]; then
    printf '%s\n' "✖ hook-block: cannot resolve the remote default ref (origin/HEAD unset and no origin/main)." >&2
    printf '%s\n' "  Refusing to install — an unverifiable block is how every session's push broke on 2026-08-01." >&2
    printf '%s\n' "  Fix: git remote set-head origin --auto   # then re-run this installer" >&2
    return 1
  fi

  if git cat-file -e "$ref:$script" 2>/dev/null; then
    printf '%s\n' "[hook-block] precondition OK — $script is reachable from $ref"
    return 0
  fi

  if [ "$allow" = "1" ]; then
    printf '%s\n' "" >&2
    printf '%s\n' "⚠️  ═══════════════════════════════════════════════════════════════════════════" >&2
    printf '%s\n' "⚠️   hook-block: --allow-unpublished OVERRIDE" >&2
    printf '%s\n' "⚠️   $script is NOT reachable from $ref." >&2
    printf '%s\n' "⚠️   Installing anyway. Until you push it, EVERY worktree that lacks this file" >&2
    printf '%s\n' "⚠️   will SKIP this guard (loudly, with a ledger row) rather than run it." >&2
    printf '%s\n' "⚠️   Ledger: $(hook_block_ledger_path)" >&2
    printf '%s\n' "⚠️  ═══════════════════════════════════════════════════════════════════════════" >&2
    printf '%s\n' "" >&2
    hook_block_ledger_append UNPUBLISHED_OVERRIDE "$script" "$script"
    return 0
  fi

  printf '%s\n' "✖ hook-block: REFUSING to install a block for $script" >&2
  printf '%s\n' "  It is not reachable from $ref, so every worktree that lacks it would be" >&2
  printf '%s\n' "  affected. On 2026-08-01 this exact condition blocked ~70 checkouts at once." >&2
  printf '%s\n' "" >&2
  printf '%s\n' "  Fix — push the script FIRST, then re-run this installer:" >&2
  printf '%s\n' "      git add $script && git commit && git push" >&2
  printf '%s\n' "      bash ${BASH_SOURCE[1]:-<installer>}" >&2
  printf '%s\n' "" >&2
  printf '%s\n' "  Genuine bootstrap only (audited: banner + ledger row):" >&2
  printf '%s\n' "      bash ${BASH_SOURCE[1]:-<installer>} --allow-unpublished" >&2
  return 1
}

# ── BLOCK RENDERING ─────────────────────────────────────────────────────────────────────────
# Emits the sentinelled block, comment lines, and the INLINE skip guard wrapping the
# invocation. `$comment` is a newline-separated set of already-`#`-prefixed lines.
hook_block_render() {
  local name="$1" wave="$2" script="$3" comment="$4" invocation="$5"

  printf '%s\n' "# >>> algovault $name ($wave) >>>"
  [ -n "$comment" ] && printf '%s\n' "$comment"
  cat <<EOF
# Self-guard [OPS-SHARED-WORKTREE-STATE-REGISTRY-W1]: a guard cannot evaluate a worktree whose
# tree does not contain it. Blocking there is what deadlocked every parallel session on
# 2026-08-01 (~70 of 74 checkouts). This is a DELIBERATE fail-open — loud + ledgered, never
# silent — and scripts/check-shared-state.mjs is what escalates a worktree that keeps running
# unguarded. if/else, never \`exit 0\`: \`exit 0\` would abort the hook and skip every LATER block.
if [ ! -f "\$(git rev-parse --show-toplevel)/$script" ]; then
  printf '%s\n' "⚠️  algovault $name: $script not present in this worktree — SKIPPING." >&2
  printf '%s\n' "⚠️    This worktree predates the guard. To run it here:" >&2
  printf '%s\n' "⚠️      git checkout \$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD || echo origin/main) -- $script" >&2
  printf '%s\t%s\t%s\t%s\t%s\n' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" SKIP "$name" "\$(git rev-parse --show-toplevel)" "$script" \\
    >>"\$(cd "\$(git rev-parse --git-common-dir)" && pwd)/algovault-hook-skip.log" 2>/dev/null || true
else
  $invocation
fi
EOF
  printf '%s\n' "# <<< algovault $name <<<"
}

# ── IDEMPOTENT, COMPOSABLE, ORDER-INDEPENDENT INSTALL ───────────────────────────────────────
# hook_block_install <hook-name> <name> <wave-id> <script> <comment> <invocation> [legacy-regex]
#
# Splits the existing hook into (foreign remainder, one file per algovault block), replaces or
# adds OUR block, then re-emits: shebang + foreign remainder + blocks in canonical LC_ALL=C
# name order. A foreign hook body is always preserved — this appends, never truncates a
# sibling's work.
#
# <legacy-regex> (optional) drops matching lines from the foreign remainder. Used ONLY by
# install_system_map_hook.sh, whose pre-wave form was a whole-file `exec …` rather than a
# block; without this the migrated hook would invoke the system-map gate twice.
hook_block_install() {
  local hook="$1" name="$2" wave="$3" script="$4" comment="$5" invocation="$6" legacy="${7:-}"
  local common hooks_dir hook_path tmp shebang existed=0 backup=""

  common="$(hook_block_common_dir)"
  hooks_dir="$common/hooks"
  hook_path="$hooks_dir/$hook"
  mkdir -p "$hooks_dir"

  # BSD mktemp: XXXXXX must be TERMINAL, and a leftover literal template poisons the next run.
  # Canonical form is `mktemp -d` + fixed names inside + a trap.
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/algovault-hook-block.XXXXXX")" || {
    printf '%s\n' "✖ hook-block: mktemp -d failed" >&2; return 1; }
  # Explicit cleanup at every return path rather than `trap … RETURN`: RETURN is a bash-only
  # signal, and this file gets sourced by hand from an interactive shell often enough (zsh on
  # this operator's machine) that a bash-only trap both errors noisily and leaks the temp dir.

  : >"$tmp/remainder"

  if [ -f "$hook_path" ]; then
    existed=1
    # Timestamped backup BEFORE the first mutation. The daily reconciler detects an unintended
    # change; the backup is what makes it RECOVERABLE. Detection without recovery is half a guard.
    backup="$hook_path.bak.SHARED-STATE-W1-$(date -u +%Y%m%dT%H%M%SZ)"
    cp "$hook_path" "$backup"

    awk -v dir="$tmp" '
      /^# >>> algovault [A-Za-z0-9_.-]+ \(/ { inb=1; f=dir "/block." $4; print >f; next }
      inb && /^# <<< algovault / { print >f; inb=0; next }
      inb { print >f; next }
      { print >(dir "/remainder") }
    ' "$hook_path"
  fi

  # Shebang: take the existing one if present, else default. Never emit it twice.
  shebang="$(head -n 1 "$tmp/remainder" 2>/dev/null || true)"
  if printf '%s' "$shebang" | grep -q '^#!'; then
    tail -n +2 "$tmp/remainder" >"$tmp/remainder.body"
  else
    shebang='#!/usr/bin/env bash'
    cp "$tmp/remainder" "$tmp/remainder.body"
  fi

  # Drop a migrated legacy invocation, if the caller declared one.
  if [ -n "$legacy" ]; then
    grep -v -E "$legacy" "$tmp/remainder.body" >"$tmp/remainder.kept" || true
    mv "$tmp/remainder.kept" "$tmp/remainder.body"
  fi

  # Replace-or-add OUR block, keyed on <name> alone (the filename IS the key).
  hook_block_render "$name" "$wave" "$script" "$comment" "$invocation" >"$tmp/block.$name"

  # Foreign content with leading AND trailing blank lines stripped, so a re-run is byte-stable
  # regardless of how many blank lines the previous layout left behind.
  sed -e '/./,$!d' "$tmp/remainder.body" \
    | awk 'NF{last=NR} {line[NR]=$0} END{for(i=1;i<=last;i++) print line[i]}' >"$tmp/remainder.trimmed"

  {
    printf '%s\n' "$shebang"
    [ -s "$tmp/remainder.trimmed" ] && cat "$tmp/remainder.trimmed"
    # Canonical LC_ALL=C order — a function of OUR rule, never of installer sequence.
    (cd "$tmp" && ls block.* 2>/dev/null | LC_ALL=C sort) | while IFS= read -r f; do
      printf '\n'
      cat "$tmp/$f"
    done
  } >"$tmp/hook.new"

  if [ "$existed" = "1" ] && cmp -s "$tmp/hook.new" "$hook_path"; then
    printf '%s\n' "[hook-block] $hook / $name — already current (idempotent no-op)"
    # Remove ONLY the backup this invocation just took. Never glob-delete the wave's backups:
    # an earlier run in this same wave may have captured a genuinely different revision.
    [ -n "$backup" ] && rm -f "$backup"
    rm -rf "$tmp"
    return 0
  fi

  cat "$tmp/hook.new" >"$hook_path"
  chmod 0755 "$hook_path"
  rm -rf "$tmp"
  if [ "$existed" = "1" ]; then
    printf '%s\n' "[hook-block] $hook / $name — installed (composable; $(grep -c '^# >>> algovault' "$hook_path") block(s) total)"
  else
    printf '%s\n' "[hook-block] $hook / $name — created $hook_path (mode 755)"
  fi
}
