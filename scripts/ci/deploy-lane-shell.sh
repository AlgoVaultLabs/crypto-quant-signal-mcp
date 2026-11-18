#!/usr/bin/env bash
# OPS-DEPLOY-LANE-NETWORK-FREE-W1 — deploy.yml's job-default shell.
#
# deploy.yml sets `defaults.run.shell: bash scripts/ci/deploy-lane-shell.sh {0}`, so every `run:`
# step in the deploy job goes through here. GitHub's own default for an unspecified shell is
# `bash -e {0}` (no pipefail), and this file ends by exec'ing EXACTLY that — outside the gate
# window nothing about a step's behaviour changes.
#
# INSIDE the window (DEPLOY_LANE_OFFLINE=1, written to $GITHUB_ENV by the window's opening step
# and set back to 0 by its closing step) it arms the network guard for the step's whole process
# tree, then runs the step the same way:
#   · NODE_OPTIONS=--import=<preload>  — every node process refuses and records a non-loopback
#     connection (scripts/lib/deploy-lane-offline-preload.mjs).
#   · PATH=<offline-bin>:$PATH         — curl and wget refuse and record (scripts/ci/offline-bin).
#   · one STEP line in the ledger      — the closing step counts these against the run steps it
#     parses out of deploy.yml, so a step that ran WITHOUT the guard is caught at runtime, not
#     just argued about from the YAML.
#
# NODE_OPTIONS cannot be exported through $GITHUB_ENV (the runner refuses that key), which is why
# the guard is armed here, per step, instead.
set -e
script="${1:?deploy-lane-shell.sh: no step script given}"

if [ "${DEPLOY_LANE_OFFLINE:-0}" = "1" ]; then
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  ledger="${DEPLOY_LANE_OFFLINE_LEDGER:?deploy-lane-shell.sh: window is open but DEPLOY_LANE_OFFLINE_LEDGER is unset}"
  printf 'STEP\tshell\t%s\t%s\t%s\n' "${GITHUB_ACTION:-local}" "$script" "$$" >> "$ledger"
  export DEPLOY_LANE_OFFLINE_LEDGER="$ledger"
  export NODE_OPTIONS="--import=${root}/scripts/lib/deploy-lane-offline-preload.mjs${NODE_OPTIONS:+ ${NODE_OPTIONS}}"
  export PATH="${root}/scripts/ci/offline-bin:${PATH}"
fi

exec bash -e "$script"
