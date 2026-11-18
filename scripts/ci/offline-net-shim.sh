#!/usr/bin/env bash
# OPS-DEPLOY-LANE-NETWORK-FREE-W1 — deploy-lane network guard, shell half.
#
# scripts/ci/offline-bin/{curl,wget} exec this with the tool name first. Only reachable while
# deploy.yml's network-free gate window is open: scripts/ci/deploy-lane-shell.sh prepends
# offline-bin to PATH for those steps alone. That covers `curl` typed in a step AND a node gate's
# execFileSync('curl', …) — the exact call the primitive-resolution gate's live leg made.
#
# A call whose every URL argument is file:// or loopback passes through to the real binary.
# Anything else — including a call with no URL this shim can recognise — is refused with curl's
# "couldn't connect" exit code 7 and RECORDED in the ledger, so a caller that swallows the exit
# code is still caught by the window's closing step.
set -u
tool="${1:?offline-net-shim.sh: no tool name}"; shift
shimdir="$(cd "$(dirname "${BASH_SOURCE[0]}")/offline-bin" && pwd)"

# Host must BE loopback, not merely start like it: `127.example.com` is a DNS name, not 127/8.
# Same rule as isLocalHost() in scripts/lib/deploy-lane-offline-preload.mjs.
local_re='^https?://(localhost|\[::1\]|127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})(:[0-9]+)?([/?#]|$)'
is_local_url() {
  case "$1" in
    file://*) return 0 ;;
  esac
  [[ "$1" =~ $local_re ]] && return 0
  return 1
}

urls=0; foreign=""
for a in "$@"; do
  case "$a" in
    *://*) urls=$((urls + 1)); is_local_url "$a" || foreign="${foreign:+$foreign }$a" ;;
  esac
done

if [ "$urls" -gt 0 ] && [ -z "$foreign" ]; then
  real_path="$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF "$shimdir" | paste -sd: -)"
  real="$(PATH="$real_path" command -v "$tool" || true)"
  [ -n "$real" ] || { echo "offline-net-shim: no real $tool on PATH" >&2; exit 127; }
  exec "$real" "$@"
fi

target="${foreign:-<no recognisable URL in: $*>}"
# Name the CALLER, not the shim: a node gate's execFileSync('curl') must be attributed to the gate.
caller="$(ps -o args= -p "$PPID" 2>/dev/null | cut -c1-160 | tr '\t' ' ')"
caller="${caller:-$tool}"
printf 'ATTEMPT\t%s\t%s\t%s\t%s\n' "$tool" "$target" "$caller" "$$" >> "${DEPLOY_LANE_OFFLINE_LEDGER:-/dev/null}" 2>/dev/null || true
echo "DEPLOY_LANE_NETWORK_ATTEMPT via=$tool target=$target script=$caller" >&2
echo "deploy lane is network-free: refused $tool $target. A live read belongs post-deploy or on a host cron — see scripts/check-deploy-lane-offline.mjs" >&2
exit 7
