#!/usr/bin/env bash
# install_gate_staleness_hook.sh — OPS-GATE-STALENESS-ASSERT-W1
#
# Installs the sixth guarded marker block into the shared pre-push hook. The block detects
# that the PUSHING WORKTREE's copy of scripts/check_test_baseline.sh is older than the
# declared contract.
#
# WHY THE CHECK IS INLINE IN THE BLOCK, NOT A SCRIPT
#   The hook is ONE shared file in $GIT_COMMON_DIR, but every block invokes
#   "$(git rev-parse --show-toplevel)/scripts/<x>" — so the SCRIPTS are PER-WORKTREE.
#   A scripts/check-gate-staleness.sh would therefore itself be resolved per-worktree, and
#   a stale checkout would run a STALE CHECKER — reintroducing the exact defect this exists
#   to detect. Only the shared artifact can do the checking, so the check is inline and this
#   installer is its committed ancestor.
#   The same reasoning forbids the block from sourcing scripts/lib/hook-block.sh at RUNTIME
#   (also per-worktree): the ledger append is written out inline, in the identical TSV shape
#   the five existing blocks already use. The library is used HERE, in the installer, which
#   deliberately runs from a checkout.
#
# WHY IT SHIPS REPORT-FIRST
#   Blocking on day one would refuse every stale checkout at once — the fleet wedge arriving
#   through a different door. This estate has paid for that twice (2026-08-01/02, ~70 of 74
#   checkouts unable to push for a day). In report mode the TOKEN tells the truth and the
#   EXIT CODE stays 0. Promotion is gated on ops/gate-staleness-config.json.
#
#   Flags: --allow-unpublished   skip the publishability precondition (installer-introduces-
#                                its-own-guard case only)
#          --check               report whether the block is installed; change nothing
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# shellcheck source=scripts/lib/hook-block.sh
. "$ROOT/scripts/lib/hook-block.sh" || { printf '%s\n' "✖ cannot source scripts/lib/hook-block.sh" >&2; exit 1; }

ALLOW_UNPUBLISHED=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) printf '%s\n' "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

HOOK_PATH="$(hook_block_common_dir)/hooks/pre-push"
if [ "$CHECK_ONLY" = "1" ]; then
  if grep -q '^# >>> algovault gate-staleness ' "$HOOK_PATH" 2>/dev/null; then
    printf '%s\n' "[gate-staleness] block INSTALLED in $HOOK_PATH"
    exit 0
  fi
  printf '%s\n' "[gate-staleness] block NOT installed in $HOOK_PATH" >&2
  exit 1
fi

# The block guards on check_test_baseline.sh itself. That is deliberate and load-bearing: a
# worktree with NO gate script hits the EXISTING skip-loudly path (with its ledger row), which
# is the pre-existing "absent script" class — NOT this gate's "stale script" class. The two
# must never be conflated, and routing it through hook_block_install makes that structural.
GATE_SCRIPT='scripts/check_test_baseline.sh'
hook_block_assert_publishable "$GATE_SCRIPT" "$ALLOW_UNPUBLISHED" || exit 1

read -r -d '' COMMENT <<'EOF' || true
# Detects that THIS WORKTREE's scripts/check_test_baseline.sh is older than the declared
# contract. The hook is shared; the script it runs is per-worktree, so a checkout that has
# not rebased keeps running its own stale copy and no commit to origin/main can reach it.
# REPORT-ONLY on install — the token tells the truth, the exit code stays 0. Override:
#   ALGOVAULT_GATE_STALENESS=warn git push
EOF

read -r -d '' INVOCATION <<'EOF' || true
gs_root="$(git rev-parse --show-toplevel)"
  gs_gate="$gs_root/scripts/check_test_baseline.sh"
  gs_cfg="$gs_root/ops/gate-staleness-config.json"
  gs_ledger="$(cd "$(git rev-parse --git-common-dir)" && pwd)/algovault-hook-skip.log"
  # Defaults are INLINE because the config is per-worktree too — a stale checkout will not
  # have it. The config is an override, never a precondition.
  gs_min=1; gs_mode="report"
  if [ -f "$gs_cfg" ] && command -v jq >/dev/null 2>&1; then
    gs_min="$(jq -r '(.minimum_contract // 1)' "$gs_cfg" 2>/dev/null || echo 1)"
    gs_mode="$(jq -r '(.mode // "report")' "$gs_cfg" 2>/dev/null || echo report)"
  fi
  # NEVER executes or sources the target — grep only. Sourcing a stale copy would run its
  # whole gate body, since sourceability landed only in contract 1.
  gs_obs="$(grep -aoE '^ALGOVAULT_TEST_GATE_CONTRACT=[0-9]+' "$gs_gate" 2>/dev/null | head -1 | cut -d= -f2)"
  if [ -n "$gs_obs" ]; then
    if [ "$gs_obs" -ge "$gs_min" ] 2>/dev/null; then gs_verdict=PASS; else gs_verdict=FAIL; fi
  else
    # TRANSITIONAL content fallback. The marker reaches a worktree only when it rebases, so on
    # day one ZERO carry it and a marker-only test would call every worktree stale — a guard
    # that cries wolf once is ignored forever. Declared debt: remove when marker coverage is
    # 100% (ops/gate-staleness-config.json .transitional_content_fallback).
    gs_obs="absent"
    if grep -qaF '(.testResults // [])' "$gs_gate" 2>/dev/null; then gs_verdict=PASS; else gs_verdict=FAIL; fi
  fi
  # Healing-RATE telemetry: one row per run so promotion is decided on measurement, not a guess.
  gs_stale=0
  while IFS= read -r gs_w; do
    [ -f "$gs_w/scripts/check_test_baseline.sh" ] || continue
    grep -qaF '(.testResults // [])' "$gs_w/scripts/check_test_baseline.sh" 2>/dev/null || gs_stale=$((gs_stale+1))
  done < <(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}')
  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" STALE_COUNT "gate-staleness" "$gs_root" "$gs_stale" \
    >>"$gs_ledger" 2>/dev/null || true
  if [ "$gs_verdict" = "FAIL" ]; then
    gs_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
    printf '%s\n' "⚠️  algovault gate-staleness: this worktree's scripts/check_test_baseline.sh is STALE." >&2
    printf '%s\n' "⚠️    observed contract: $gs_obs   required minimum: $gs_min   fleet stale: $gs_stale" >&2
    printf '%s\n' "⚠️    It may report PASS having verified nothing. To fix THIS worktree:" >&2
    printf '%s\n' "⚠️      git fetch origin && git rebase origin/main" >&2
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" STALE_GATE "gate-staleness" "$gs_root" \
      "branch=$gs_branch observed=$gs_obs minimum=$gs_min verdict=FAIL" \
      >>"$gs_ledger" 2>/dev/null || true
  fi
  echo "GATE_STALENESS_VERDICT=$gs_verdict"
  if [ "$gs_verdict" != "PASS" ] && [ "$gs_mode" = "block" ] && [ "${ALGOVAULT_GATE_STALENESS:-block}" != "warn" ]; then
    exit 1
  fi
EOF

hook_block_install pre-push gate-staleness OPS-GATE-STALENESS-ASSERT-W1 "$GATE_SCRIPT" "$COMMENT" "$INVOCATION"
