#!/usr/bin/env bash
# SYSTEM-MAP-ENFORCEMENT-W1 / C2 — onboarding installer for the pre-commit
# system-map gate.
#
# Idempotent: re-running on an already-installed hook is a no-op (compares
# contents, only writes if different). If a non-system-map pre-commit hook
# is present, it's backed up to <path>.bak.<TIMESTAMP> before overwrite.
#
# Run once per fresh clone of crypto-quant-signal-mcp:
#   bash scripts/install_system_map_hook.sh
#
# NOT invoked from CI — this is a developer-onboarding utility.
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
HOOK_PATH="$REPO_ROOT/.git/hooks/pre-commit"
ONELINER='#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/scripts/check_system_map.sh" "$@"
'

if [ -f "$HOOK_PATH" ]; then
  if [ "$(cat "$HOOK_PATH")" = "$ONELINER" ]; then
    echo "[system-map hook] already installed at $HOOK_PATH (no-op)"
    exit 0
  fi
  BACKUP="$HOOK_PATH.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  cp "$HOOK_PATH" "$BACKUP"
  echo "[system-map hook] backed up existing pre-commit → $BACKUP"
fi

printf '%s' "$ONELINER" > "$HOOK_PATH"
chmod 0755 "$HOOK_PATH"
echo "[system-map hook] installed at $HOOK_PATH (mode 755)"
