#!/usr/bin/env bash
# SYSTEM-MAP-ENFORCEMENT-W1 / C2 — pre-commit gate.
#
# Blocks commits with edge-mutation signals (per CLAUDE.md Execution flow
# step 6 list) when system-map.md hasn't been touched within MAX_AGE_SEC
# of NOW. The gate prevents the silent-drift class where a wave ships
# new MCP tools / postgres columns / cron entries / env vars / route
# handlers WITHOUT updating system-map.md in the same Code session.
#
# Honors `[skip-map-check]` in commit message as a documented escape
# hatch for false positives. Commits that touch system-map.md directly
# (the C3-style backfill case) are exempt automatically.
#
# Reads SYSTEM_MAP_PATH env var if set; defaults to the absolute vault
# path. Tests pass a tmp path via env var.
#
# Maintenance: pattern array below is the SoT for the gate's notion of
# "edge mutation". Keep aligned with CLAUDE.md Execution flow step 6
# (which is human-readable; this is machine-readable).
set -euo pipefail

SYSTEM_MAP_PATH="${SYSTEM_MAP_PATH:-/Users/tank/My Drive/Obsidian Vault/AlgoVault MCP/system-map.md}"
MAX_AGE_SEC="${SYSTEM_MAP_MAX_AGE_SEC:-600}"   # 10 min default

# ── Edge-mutation signal patterns ──
# Each entry is a `git diff --cached`-grep regex matching a likely edge
# mutation. Patterns probe-corrected per Plan Mode Step 0 (2026-05-03):
# `src/api/` dropped (dir doesn't exist; routes in src/index.ts);
# API-rename heuristic dropped (high false-positive rate).
declare -a SIGNAL_PATTERNS=(
  '^\+.*app\.(get|post|put|delete|use)\('               # new HTTP route in src/index.ts
  '^\+.*server\.tool\('                                  # new MCP tool registration
  '^\+.*ALTER TABLE .* ADD COLUMN'                       # postgres schema delta
  '^\+.*CREATE TABLE'                                    # new postgres table
  '^\+.*(cron\.schedule|setInterval|crontab)'            # cron / scheduled-job change
  '^\+.*process\.env\.[A-Z_][A-Z0-9_]+'                  # new env var read
  '^[+-].*"version":'                                    # package.json version
  '^[+-].*"name":'                                       # package.json name (rename)
)

# ── File-path patterns (whole staged file rather than diff lines) ──
declare -a FILE_PATTERNS=(
  '^migrations/'                                         # new SQL migration file
  '^src/scripts/seed-signals\.ts$'                       # cron-driver edits
)

# ── escape hatches for confirmed false positives ──
# (1) env var — the RELIABLE non-interactive hatch. The COMMIT_EDITMSG check below
#     CANNOT fire on `git commit -m/-F` (the pre-commit hook runs before the message
#     file is written), so `ALGOVAULT_SKIP_MAP_CHECK=1 git commit …` is the canonical
#     bypass for scripted/agent commits.
if [ -n "${ALGOVAULT_SKIP_MAP_CHECK:-}" ]; then
  echo "[system-map gate] OK — ALGOVAULT_SKIP_MAP_CHECK set; bypassing (documented escape hatch)."
  exit 0
fi
# (2) [skip-map-check] in the commit message — works for interactive/editor commits and
#     amends, where COMMIT_EDITMSG is populated before the pre-commit hook runs.
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null || echo "")
if [ -n "$GIT_DIR" ] && [ -f "$GIT_DIR/COMMIT_EDITMSG" ] && \
   grep -q '\[skip-map-check\]' "$GIT_DIR/COMMIT_EDITMSG"; then
  echo "[system-map gate] OK — [skip-map-check] in commit message; bypassing."
  exit 0
fi

# ── system-map.md-touching commits exempt automatically (C3 backfill case) ──
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null || echo "")
if echo "$STAGED_FILES" | grep -qE 'system-map\.md$'; then
  echo "[system-map gate] OK — staged diff includes system-map.md; exempt."
  exit 0
fi

# ── Scan staged diff + file list for edge-mutation signals ──
# Signals are SERVER-CODE patterns (routes / tools / SQL / cron / env / package.json), so the
# diff scan is scoped to code paths. We EXCLUDE: markdown + audits + docs (an edge described in
# PROSE is not an edge mutation), landing/** (client HTML + inline JS — a `setInterval` poller
# or a minified hero line re-emitted as `+` is not a server cron/edge), and tests/** (which
# REFERENCE signals like `server.tool(` in assertions). Real edges live in src/scripts/
# migrations/package.json, all still fully scanned. (system-map-gate false-positive hardening.)
DIFF=$(git diff --cached -- . \
  ':(exclude,glob)**/*.md' \
  ':(exclude,glob)audits/**' \
  ':(exclude,glob)docs/**' \
  ':(exclude,glob)landing/**' \
  ':(exclude,glob)tests/**' \
  2>/dev/null || echo "")
HITS=()
for pat in "${SIGNAL_PATTERNS[@]}"; do
  match=$(echo "$DIFF" | grep -nE "$pat" || true)
  [ -n "$match" ] && HITS+=("pattern: $pat")
done
for pat in "${FILE_PATTERNS[@]}"; do
  match=$(echo "$STAGED_FILES" | grep -E "$pat" || true)
  [ -n "$match" ] && HITS+=("file pattern: $pat ($match)")
done

if [ ${#HITS[@]} -eq 0 ]; then
  echo "[system-map gate] OK — no edge-mutation signals in staged diff."
  exit 0
fi

# ── Edge mutation detected — verify system-map.md mtime is fresh ──
if [ ! -f "$SYSTEM_MAP_PATH" ]; then
  echo "[system-map gate] BLOCK: SYSTEM_MAP_PATH not found at $SYSTEM_MAP_PATH"
  echo "  Set SYSTEM_MAP_PATH env var to the correct location, or touch the file there."
  exit 1
fi

NOW=$(date +%s)
# BSD stat (macOS) first; fallback to GNU stat (Linux CI). Per Plan Mode probe,
# the workstation is macOS so BSD stat is the primary path.
MAP_MTIME=$(stat -f %m "$SYSTEM_MAP_PATH" 2>/dev/null || stat -c %Y "$SYSTEM_MAP_PATH" 2>/dev/null || echo "0")
AGE=$((NOW - MAP_MTIME))

if [ "$AGE" -le "$MAX_AGE_SEC" ]; then
  echo "[system-map gate] OK — ${#HITS[@]} signals matched, system-map.md mtime fresh (${AGE}s ago)."
  exit 0
fi

# ── BLOCK — edge mutation + stale system-map.md ──
cat <<EOF
[system-map gate] BLOCK: edge-mutation signals detected in staged diff:
$(printf '  - %s\n' "${HITS[@]}")
system-map.md path: $SYSTEM_MAP_PATH
system-map.md age:  ${AGE}s ago — STALE (max allowed: ${MAX_AGE_SEC}s).
Required action: touch the relevant component card / edge row in system-map.md,
                 then re-attempt the commit.
Escape hatch:    ALGOVAULT_SKIP_MAP_CHECK=1 git commit …   (reliable, non-interactive)
                 — or append [skip-map-check] to the message (interactive / amend commits).
Reference:       CLAUDE.md "## Execution flow" step 6 + "## Plan Mode rules"
                 govern this gate (per SYSTEM-MAP-ENFORCEMENT-W1 C2).
EOF
exit 1
