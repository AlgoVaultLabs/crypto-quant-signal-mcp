#!/usr/bin/env bash
#
# commit-funnel-snapshot.sh
#
# Wrapper invoked by the systemd unit algovault-funnel-snapshot.service (or
# manually for testing). Runs the activation-funnel snapshot writer, then,
# if new files were produced, git-adds / commits / pushes them to origin.
#
# Exit codes:
#   0  — success (either new snapshot committed + pushed, or nothing to do)
#   2  — DATABASE_URL missing (see ops/systemd/README.md for the env file)
#   3  — git push failed (snapshot files left in place for manual recovery)
#   *  — any other error propagates via `set -e`
#
# Invocation: the systemd unit sets WorkingDirectory=/opt/crypto-quant-signal-mcp,
# so `cd` at the top is primarily a safety net for manual runs (e.g.
# `/opt/crypto-quant-signal-mcp/scripts/commit-funnel-snapshot.sh`).

set -euo pipefail

# ── 0. Move to repo root (wrapper lives in scripts/, so `..` from its dir).
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

# ── 1. Load env file if present. The systemd unit also loads it via
# EnvironmentFile=, but we source it here too so manual runs from a shell
# behave identically to the timer-driven path.
if [ -f /etc/algovault/funnel-snapshot.env ]; then
  # shellcheck disable=SC1091
  source /etc/algovault/funnel-snapshot.env
fi

# ── 2. Trap: always log a completion line on exit, whatever the cause.
EXIT_STATUS=0
trap 'echo "[commit-funnel-snapshot] done status=${EXIT_STATUS} repo=${REPO_ROOT} ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)"' EXIT

# ── 3. Health check: refuse to run without DATABASE_URL. The snapshot writer
# needs it; failing loudly here is much clearer than failing inside tsx.
if [ -z "${DATABASE_URL:-}" ]; then
  echo "[commit-funnel-snapshot] ERROR: DATABASE_URL is not set." >&2
  echo "[commit-funnel-snapshot] Expected it to come from /etc/algovault/funnel-snapshot.env" >&2
  echo "[commit-funnel-snapshot] See ops/systemd/README.md for the env file template and" >&2
  echo "[commit-funnel-snapshot] the one-line docker-compose.yml change required to expose" >&2
  echo "[commit-funnel-snapshot] Postgres on 127.0.0.1:5432 (BLOCKER-1)." >&2
  EXIT_STATUS=2
  exit 2
fi

echo "[commit-funnel-snapshot] starting ts=$(date -u +%Y-%m-%dT%H:%M:%SZ) repo=${REPO_ROOT}"
echo "[commit-funnel-snapshot] DATABASE_URL=${DATABASE_URL%%@*}@<redacted>"

# ── 4. Run the snapshot writer. `npx -y tsx` fetches tsx on demand into the
# npm cache without a permanent devDependency install on the host. First run
# is slow (~30s), subsequent runs are <2s. See BLOCKER-2 in README.md.
echo "[commit-funnel-snapshot] running snapshot writer"
npx -y tsx scripts/write-funnel-snapshot.ts --tag auto 2>&1

# ── 5. Detect new files under activation-funnel/snapshots/. We limit the
# porcelain scope to that subdir so we never accidentally stage unrelated
# working-tree noise (e.g. a half-edited README the author forgot about).
NEW_FILES="$(git -C "${REPO_ROOT}" status --porcelain activation-funnel/snapshots/ | awk '/^\?\?/ {print $2}')"
MODIFIED_README="$(git -C "${REPO_ROOT}" status --porcelain activation-funnel/README.md | awk '/^( M| M|M | A)/ {print $2}')"

if [ -z "${NEW_FILES}" ] && [ -z "${MODIFIED_README}" ]; then
  echo "[commit-funnel-snapshot] no new snapshot — perhaps already run today"
  EXIT_STATUS=0
  exit 0
fi

echo "[commit-funnel-snapshot] new snapshot files:"
printf '  %s\n' ${NEW_FILES}
if [ -n "${MODIFIED_README}" ]; then
  echo "[commit-funnel-snapshot] activation-funnel/README.md also modified (ledger row)"
fi

# ── 6. Stage explicitly — never `git add -A` or `git add .` (CLAUDE.md rule:
# risks committing secrets / build artifacts). We add the snapshots subdir
# and the funnel README (which may have a new Snapshot Ledger row appended
# by the writer) and nothing else.
git -C "${REPO_ROOT}" add activation-funnel/snapshots/
if [ -n "${MODIFIED_README}" ]; then
  git -C "${REPO_ROOT}" add activation-funnel/README.md
fi

COMMIT_MSG="chore(funnel): auto-snapshot $(date -u +%Y-%m-%d)"
echo "[commit-funnel-snapshot] committing: ${COMMIT_MSG}"
git -C "${REPO_ROOT}" commit -m "${COMMIT_MSG}"

# ── 7. Push. If this fails, we deliberately leave the local commit in place
# so a human can push it manually — reverting would throw away the snapshot.
# The VPS deploy key is set up by .github/workflows/deploy.yml's checkout
# step, but may not have push access. See BLOCKER-3 in README.md.
echo "[commit-funnel-snapshot] pushing to origin main"
if ! git -C "${REPO_ROOT}" push origin main; then
  echo "[commit-funnel-snapshot] ERROR: git push origin main failed." >&2
  echo "[commit-funnel-snapshot] Local commit is intact; run 'git push origin main' manually." >&2
  echo "[commit-funnel-snapshot] See ops/systemd/README.md BLOCKER-3 (deploy-key push access)." >&2
  EXIT_STATUS=3
  exit 3
fi

echo "[commit-funnel-snapshot] push succeeded"
EXIT_STATUS=0
exit 0
