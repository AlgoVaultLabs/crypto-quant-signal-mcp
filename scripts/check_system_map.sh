#!/usr/bin/env bash
# SYSTEM-MAP-ENFORCEMENT-W1 / C2 — pre-commit gate.
#
# Blocks commits with edge-mutation signals (per CLAUDE.md Execution flow
# step 6 list) when the system map hasn't been touched within MAX_AGE_SEC
# of NOW. The gate prevents the silent-drift class where a wave ships
# new MCP tools / postgres columns / cron entries / env vars / route
# handlers WITHOUT updating the map in the same Code session.
#
# The map is a router plus one card per component (OPS-SYSTEM-MAP-DIRECTORY-W1):
# system-map.md + system-map/<component>.md. Freshness is the NEWEST mtime of
# the router and its cards, so editing only the card a wave touched satisfies it.
#
# Honors `[skip-map-check]` in commit message as a documented escape
# hatch for false positives. Commits that stage the router or a card
# (the C3-style backfill case) are exempt automatically.
#
# Reads SYSTEM_MAP_PATH env var if set; otherwise the absolute vault path
# declared in scripts/lib/system-map-path.sh (shared with check_map_shape.sh),
# which also projects the card directory from it. Tests pass a tmp path via env var.
#
# Maintenance: pattern array below is the SoT for the gate's notion of
# "edge mutation". Keep aligned with CLAUDE.md Execution flow step 6
# (which is human-readable; this is machine-readable).
set -euo pipefail

# SYSTEM_MAP_PATH is resolved from scripts/lib/system-map-path.sh — the ONE definition, shared
# with scripts/check_map_shape.sh (SYSTEM-MAP-SHAPE-GATE-W1). Two gates now read this same
# out-of-repo file for two different properties (freshness here, shape there); two copies of
# one absolute string can disagree about WHICH file after a vault move, and that disagreement
# surfaces as "the gate passed", never as an error.
#
# Resolved LATE (just before first use, below) rather than here, deliberately: the no-signals
# fast path and BOTH escape hatches must never depend on the library being present, so a
# worktree that recovered only this script keeps committing normally unless it is a commit
# that would actually have been gated.
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
#
# Both hatches are LEGITIMATE and both stay. What changes (OPS-SYSTEM-MAP-GATE-COMMENT-STRIP-W1)
# is that they become COUNTABLE: until now a bypass left no trace anywhere, so "how often is this
# gate bypassed?" was unanswerable, and a hatch reached for reflexively looked identical to one
# reached for after genuine re-derivation.
#
# Writes to the EXISTING shared ledger (hook-block.sh's $GIT_COMMON_DIR/algovault-hook-skip.log)
# in its established TSV shape — ONE log with an event column, never a second one to forget to
# read. INLINED rather than sourcing scripts/lib/hook-block.sh, and that is deliberate: that
# library's own design decision #1 forbids runtime dependence on it, because a worktree predating
# it would fail to source and — under this script's `set -e` — block every commit there.
# hook-block.sh:219-220 inlines this identical printf into its emitted block for the same reason.
#
# Best-effort throughout: a ledger that cannot be written must never change the verdict.
map_gate_ledger() {   # <event>
  local common
  common=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd) || return 0
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" system-map \
    "$(git rev-parse --show-toplevel 2>/dev/null || echo '?')" scripts/check_system_map.sh \
    >>"$common/algovault-hook-skip.log" 2>/dev/null || true
}

if [ -n "${ALGOVAULT_SKIP_MAP_CHECK:-}" ]; then
  map_gate_ledger MAP_CHECK_ENV_BYPASS || true
  echo "[system-map gate] OK — ALGOVAULT_SKIP_MAP_CHECK set; bypassing (documented escape hatch, logged)."
  exit 0
fi
# (2) [skip-map-check] in the commit message — works for interactive/editor commits and
#     amends, where COMMIT_EDITMSG is populated before the pre-commit hook runs.
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null || echo "")
if [ -n "$GIT_DIR" ] && [ -f "$GIT_DIR/COMMIT_EDITMSG" ] && \
   grep -q '\[skip-map-check\]' "$GIT_DIR/COMMIT_EDITMSG"; then
  map_gate_ledger MAP_CHECK_MSG_BYPASS || true
  echo "[system-map gate] OK — [skip-map-check] in commit message; bypassing (logged)."
  exit 0
fi

# ── map-touching commits exempt automatically (C3 backfill case) ──
# The router (system-map.md) or a component card (system-map/<component>.md). The card
# alternative is INERT today and kept deliberately: the vault is not a git repository, so neither
# file can ever appear in a repo's staged diff (scripts/lib/system-map-path.sh records the
# measurement). It costs nothing and records the intent for the day the map is repo-resident. The
# mtime leg below is what actually lets a card-only edit through (OPS-SYSTEM-MAP-DIRECTORY-W1 CH4).
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null || echo "")
if echo "$STAGED_FILES" | grep -qE 'system-map\.md$|(^|/)system-map/[^/]+\.md$'; then
  echo "[system-map gate] OK — staged diff includes system-map.md or a system-map/ card; exempt."
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

# ── Strip comments before matching (OPS-SYSTEM-MAP-GATE-COMMENT-STRIP-W1) ────────────────────
# A MENTION IS NOT AN OCCURRENCE. Every pattern below is exactly the vocabulary a good comment
# uses when explaining why a change does NOT do the thing, so this gate matched its own prose:
# PAY-RAIL-DASHBOARD-W1 was blocked on "rides the existing 30s load() loop — adds NO setInterval",
# and this gate had already blocked its own installer's comment block for the same reason
# (install_system_map_hook.sh:47-52). The stripper also drops `+++ b/<path>` headers from
# matching — they begin with '+', so a file NAMED after a pattern word tripped the gate too
# (measured: src/guards/setInterval-guard.ts, whose only added line was `export const y = 2;`).
#
# NOT a bash stripper: shell-side comment handling in this repo is all `grep -vE '^[[:space:]]*#'`
# — '#'-only, whole-line, and diff-unaware. It cannot preserve the +/- prefix column, cannot
# switch language per hunk, and cannot see `//` or `--`. So this calls the shared node module,
# whose semantics (language-aware + offset-preserving) are declared in its docblock.
#
# FAIL TOWARD NOISE, NEVER TOWARD SILENCE. If node is missing or the stripper errors we match the
# UNSTRIPPED diff and say so. A stripping failure costs a false positive (annoying, visible, and
# the operator has two documented hatches); skipping the check costs a false negative — an
# unmapped edge ships and nothing ever says so. The explicit `if !` is load-bearing: this script
# runs `set -euo pipefail`, so a bare command substitution on a failing node would ABORT here and
# block the commit instead of falling back.
SCAN="$DIFF"
STRIPPER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/strip-comments.mjs"
if [ -n "$DIFF" ]; then
  if ! SCAN=$(printf '%s' "$DIFF" | node "$STRIPPER" --diff 2>/dev/null); then
    echo "[system-map gate] WARNING: comment stripper unavailable ($STRIPPER) —" >&2
    echo "  matching the UNSTRIPPED diff. Comments mentioning a pattern may false-positive." >&2
    SCAN="$DIFF"
  fi
fi

HITS=()
for pat in "${SIGNAL_PATTERNS[@]}"; do
  match=$(echo "$SCAN" | grep -nE "$pat" || true)
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
# ── resolve the target from the ONE shared definition ───────────────────────────────────────
# Only the DEFAULT needs resolving. A caller that set SYSTEM_MAP_PATH has already decided which
# file this is — the existing suite does exactly that, copying only this script into a tmp repo —
# so requiring the library there would add a dependency to a path that needs none. The default
# still lives in exactly ONE place, which is what single-derivation actually asks for.
#
# When the default IS needed and the library is missing, this REFUSES rather than guessing: the
# gate already blocks when it cannot determine freshness, and "cannot determine WHICH file" is
# the same class. Inlining a second copy of the path as a fallback would defeat the extraction.
MAP_PATH_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/system-map-path.sh"
if [ -z "${SYSTEM_MAP_PATH:-}" ] && [ ! -f "$MAP_PATH_LIB" ]; then
  echo "[system-map gate] BLOCK: scripts/lib/system-map-path.sh missing from this worktree."
  echo "  Recover:      git checkout origin/main -- scripts/lib/system-map-path.sh"
  echo "  Escape hatch: ALGOVAULT_SKIP_MAP_CHECK=1 git commit …   (logged to the skip ledger)"
  exit 1
fi
# The card directory is PROJECTED by the same library (OPS-SYSTEM-MAP-DIRECTORY-W1 CH4), so it
# follows SYSTEM_MAP_PATH with the router's precedence. With no library there is no second
# derivation to fall back on: freshness is router-only, and the gate SAYS so below — never silently.
MAP_DIR=""
MAP_DIR_UNRESOLVED="scripts/lib/system-map-path.sh absent; an explicit SYSTEM_MAP_PATH needs no library"
if [ -f "$MAP_PATH_LIB" ]; then
  # shellcheck source=scripts/lib/system-map-path.sh
  . "$MAP_PATH_LIB"
  SYSTEM_MAP_PATH="$ALGOVAULT_SYSTEM_MAP_PATH"
  MAP_DIR="${ALGOVAULT_SYSTEM_MAP_DIR:-}"
  MAP_DIR_UNRESOLVED="scripts/lib/system-map-path.sh defines no ALGOVAULT_SYSTEM_MAP_DIR"
fi

if [ ! -f "$SYSTEM_MAP_PATH" ]; then
  echo "[system-map gate] BLOCK: SYSTEM_MAP_PATH not found at $SYSTEM_MAP_PATH"
  echo "  Set SYSTEM_MAP_PATH env var to the correct location, or touch the file there."
  exit 1
fi

NOW=$(date +%s)
# GNU first, then BSD — and the ORDER IS THE FIX, not a preference.
#
# The previous form tried `stat -f %m` first "because the workstation is macOS". On GNU coreutils
# `-f` is NOT an unknown flag that cleanly fails through to the fallback — it is `--file-system`,
# and the argument list is read as files to stat rather than as a BSD format string. Measured on a
# live GNU box: the result reaching `MAP_MTIME` was NON-NUMERIC, so `$((NOW - MAP_MTIME))` was an
# arithmetic error, and `set -e` turned that into an exit 1 with ZERO stdout — indistinguishable
# from a BLOCK to any caller reading only the exit code. Measured 2026-08-13 on the Postgres lane:
# EVERY BLOCK-expecting case died there, and four of them still reported PASS because their
# harness read the code alone. (vitest.config.ts:93-98 named this platform difference correctly;
# an earlier reading of this wave called that comment wrong because the `||` chain LOOKS portable.)
#
# SO THE CHAIN ITSELF IS THE HAZARD, not the flavour order. `A || B` presumes a failing command
# prints nothing; GNU `stat -f` disproves that, and reordering only makes the same idiom happen to
# work on today's two platforms — renting a load-bearing property from a tool's behaviour, which
# this repo's build rules forbid outright. Detect the flavour ONCE, explicitly, and call only the
# matching form. `stat -c` is genuinely invalid on BSD, so this probe is decisive in both
# directions and nothing depends on what a failing stat happens to print.
if stat -c %Y . >/dev/null 2>&1; then STAT_FLAVOUR=gnu; else STAT_FLAVOUR=bsd; fi
map_mtime() {   # <path> -> epoch seconds on stdout, or nothing at all
  if [ "$STAT_FLAVOUR" = gnu ]; then stat -c %Y "$1" 2>/dev/null
  else                               stat -f %m "$1" 2>/dev/null; fi
}
MAP_MTIME=$(map_mtime "$SYSTEM_MAP_PATH" || true)

# VALIDATE BEFORE ARITHMETIC, and BLOCK rather than assume. Falling through to 0 would make the map
# look infinitely stale: it blocks, but for the wrong reason, and a wrong reason is how this bug
# survived behind a CI exclusion for months. A gate that cannot determine freshness REFUSES and
# says why — it never passes on an unreadable input, and it never invents a value.
case "$MAP_MTIME" in
  ''|*[!0-9]*)
    echo "[system-map gate] BLOCK: could not read a numeric mtime for $SYSTEM_MAP_PATH"
    echo "  stat flavour detected: $STAT_FLAVOUR"
    echo "  probe returned: '$(printf '%s' "$MAP_MTIME" | head -1)'"
    echo "  Freshness is undeterminable, so this gate REFUSES rather than assuming stale or fresh."
    echo "  Escape hatch:    ALGOVAULT_SKIP_MAP_CHECK=1 git commit …   (logged to the skip ledger)"
    exit 1 ;;
esac
# ── Freshness is the NEWEST mtime of the router AND its cards (OPS-SYSTEM-MAP-DIRECTORY-W1 CH4) ──
# The map is a router plus one card per component: system-map.md + system-map/<component>.md. A
# wave that edits only a card must satisfy this gate, and the staged-exempt leg above cannot do it
# — the vault is not a git repository, so neither file can ever be staged. So the card directory
# is scanned at depth 1 and the newest file wins.
#
# Every card gets the router's refusal rule: an mtime that does not read as a number BLOCKS. A
# directory that exists but cannot be listed BLOCKS too — a glob over an unlistable directory
# matches nothing, and "no cards" would then be a silent router-only pass over a corpus nobody
# could read. Only a directory that is genuinely ABSENT falls back to the router, and it says so.
NEWEST_MTIME="$MAP_MTIME"
NEWEST_NAME="system-map.md"
CARD_COUNT=0
if [ -z "$MAP_DIR" ]; then
  echo "[system-map gate] note: card directory unresolved ($MAP_DIR_UNRESOLVED) — router-only freshness."
elif [ ! -e "$MAP_DIR" ] && [ ! -L "$MAP_DIR" ]; then
  echo "[system-map gate] note: no card directory at $MAP_DIR — falling back to router-only freshness."
elif [ ! -d "$MAP_DIR" ] || [ ! -r "$MAP_DIR" ] || [ ! -x "$MAP_DIR" ]; then
  echo "[system-map gate] BLOCK: card directory $MAP_DIR exists but cannot be listed."
  echo "  Freshness is undeterminable, so this gate REFUSES rather than falling back to the router."
  echo "  Escape hatch:    ALGOVAULT_SKIP_MAP_CHECK=1 git commit …   (logged to the skip ledger)"
  exit 1
else
  for card in "$MAP_DIR"/*.md; do
    # Without nullglob an unmatched pattern stays literal — that is "zero cards", not a card.
    [ -e "$card" ] || [ -L "$card" ] || continue
    CARD_MTIME=$(map_mtime "$card" || true)
    case "$CARD_MTIME" in
      ''|*[!0-9]*)
        echo "[system-map gate] BLOCK: could not read a numeric mtime for card $card"
        echo "  stat flavour detected: $STAT_FLAVOUR"
        echo "  probe returned: '$(printf '%s' "$CARD_MTIME" | head -1)'"
        echo "  Freshness is undeterminable, so this gate REFUSES rather than assuming stale or fresh."
        echo "  Escape hatch:    ALGOVAULT_SKIP_MAP_CHECK=1 git commit …   (logged to the skip ledger)"
        exit 1 ;;
    esac
    CARD_COUNT=$((CARD_COUNT + 1))
    if [ "$CARD_MTIME" -gt "$NEWEST_MTIME" ]; then
      NEWEST_MTIME="$CARD_MTIME"
      NEWEST_NAME="system-map/$(basename "$card")"
    fi
  done
  echo "[system-map gate] note: freshness = newest of the router + $CARD_COUNT card(s) in $MAP_DIR."
fi
AGE=$((NOW - NEWEST_MTIME))

if [ "$AGE" -le "$MAX_AGE_SEC" ]; then
  echo "[system-map gate] OK — ${#HITS[@]} signals matched, map mtime fresh via $NEWEST_NAME (${AGE}s ago)."
  exit 0
fi

# ── BLOCK — edge mutation + a stale map (the router AND every card) ──
cat <<EOF
[system-map gate] BLOCK: edge-mutation signals detected in staged diff:
$(printf '  - %s\n' "${HITS[@]}")
system-map.md path: $SYSTEM_MAP_PATH
card directory:     ${MAP_DIR:-<unresolved>} — $CARD_COUNT card(s) considered
newest map file:    $NEWEST_NAME, ${AGE}s ago — STALE (max allowed: ${MAX_AGE_SEC}s).
Required action: touch the component card you changed in system-map/<component>.md (or the
                 router, system-map.md), then re-attempt the commit.
Escape hatch:    ALGOVAULT_SKIP_MAP_CHECK=1 git commit …   (reliable, non-interactive)
                 — or append [skip-map-check] to the message (interactive / amend commits).
Reference:       CLAUDE.md "## Execution flow" step 6 + "## Plan Mode rules"
                 govern this gate (per SYSTEM-MAP-ENFORCEMENT-W1 C2).
EOF
exit 1
