#!/usr/bin/env bash
# declaration-sync.sh — flow committed DECLARATIONS from their SoT to the hosts that read them.
#
# OPS-MONITORING-INVENTORY-HOST-SYNC-W1.
#
# ── THE DEFECT THIS RETIRES ──────────────────────────────────────────────────
# `monitoring-inventory-reconcile.py` reads its checklist from a HOST-LOCAL copy
# (`/opt/algovault-monitoring/monitoring-inventory.json`), resolved by its own sibling rule —
# NOT the git-deployed `/opt/crypto-quant-signal-mcp/ops/monitoring/` one. And `ops/monitoring/**`
# is in deploy.yml's `paths-ignore` BY DESIGN (host-applied over SSH, never COPYed into the image),
# so a commit touching only a declaration runs NO workflow that reaches a host at all.
#
# So no deploy has ever synced the file the reconciler actually reads. Every edit needed a manual
# push to BOTH hosts and nothing detected a skipped one. Measured 2026-08-05: repo 52 rows, both
# hosts 50, two rows missing for ~12h and ~1 day — surfacing as `CHECK ORPHAN: BREACH` on a
# perfectly healthy artifact. A false alarm on the meta-guard is how a monitoring layer gets muted.
#
# ── WHY THIS IS NOT THE PROHIBITED AUTO-INSTALL ──────────────────────────────
# CLAUDE.md: reconciliation is diagnostic by design — no auto-install, no auto-copy — because an
# unattended job must not perform an unreviewed privileged mutation. That rule is INTACT here:
#   - An ARTIFACT is executable code that runs with privilege. Installed only by a reviewed,
#     human-dispatched wave. This script NEVER moves one.
#   - A DECLARATION is a checklist a checker reads. A stale one does not make the host wrong;
#     it makes the CHECK wrong.
# Verified before building this: across all 52 inventory rows the file carries 19 purely
# declarative keys and ZERO string values matching shell/code shapes. `artifact`/`host_path` NAME
# executables; `sha256` is a HASH of one. Nothing here is executed by this script.
#
# ── WHY A PULL, NOT A CI PUSH ────────────────────────────────────────────────
# `gh secret list` carries VPS_HOST/VPS_SSH_KEY (signal-1) and NOTHING for aoe-1, and the AOE
# repo's deploy.yml is a stub with no SSH. A CI push would need a newly minted deploy credential
# AND would hand the production root SSH key to a second workflow — the SEC-04 hazard class.
# A pull needs no credential at all: the repo is public, and the raw URL was verified to be
# byte-identical to `git show origin/main:<path>` (sha b6a70cc1…) from BOTH hosts.
#
# ── WHY A DECLARED SET, NOT JUST THE INVENTORY ───────────────────────────────
# The inventory is simply the declaration that changes most often, so it drifted first. Measured,
# `doc-host-path-claims.json`, `network-posture.json` and `schedule-boundary-rule.json` are the
# SAME shape — host-local copies of committed declarations with no deploy path — and were merely
# still in sync because they change rarely. Fixing one lane and leaving three identical ones is
# the "lane fix wearing a generator's clothes" this repo retires on sight.
#
# The set lives IN THIS SCRIPT, deliberately. A separate config file would itself be a declaration
# needing a sync — the recursion this wave exists to end.
#
# Verdict: exactly one terminal DECLARATION_SYNC_VERDICT=SYNCED|UNCHANGED|FAILED|INDETERMINATE.
# Exit: 0 = SYNCED or UNCHANGED · 1 = FAILED · 3 = INDETERMINATE (token-law default for a NEW gate).
# FAIL-CLOSED: a fetch that does not 200, a body that will not parse, a missing required key, or a
# collapsed size REFUSES THE WRITE and keeps the working file. Installing a truncated declaration
# would break every check at once — strictly worse than being one revision stale.
#
# Usage:
#   declaration-sync.sh --self-test   # hermetic; no network, no /opt, vacuity-guarded
#   declaration-sync.sh               # sync every declared file
set -uo pipefail

BASE_URL=${DECLARATION_SYNC_BASE_URL:-https://raw.githubusercontent.com/AlgoVaultLabs/crypto-quant-signal-mcp/main/ops/monitoring}
DEST_DIR=${DECLARATION_SYNC_DEST_DIR:-/opt/algovault-monitoring}
TG=${DECLARATION_SYNC_TG:-/opt/algovault-monitoring/send_telegram.sh}
ALERT_ID=MONITORING_DECLARATION_SYNC_FAILED
# Template form, resolved at send-time by send_telegram.sh's PATCH-B resolver. A literal W<N>
# here would be a hardcoded recommended_wave, which CLAUDE.md forbids and a canary enforces.
RECOMMENDED_WAVE='OPS-MONITORING-DECLARATION-SYNC-W{NEXT}'
BACKUP_REASON=${DECLARATION_SYNC_BACKUP_REASON:-MONITORING-INVENTORY-HOST-SYNC-W1}

# <filename>|<required top-level key>|<min entry count, 0 = presence only>
# The count floor is a REFUSAL threshold, not a target: it exists so a truncated or half-written
# body can never replace a working file. Keep it well below the live value.
DECLARATIONS=(
  "monitoring-inventory.json|artifacts|40"
  "doc-host-path-claims.json|claims|1"
  "network-posture.json|hosts|1"
  "schedule-boundary-rule.json|canonical_minutes|5"
  # Ch3's SOT_PARITY config. In the set on purpose: the check that audits whether the hosts read
  # the committed declaration must not itself be configured by a copy nobody keeps current.
  # `enforcement` is a string, so presence-only (0) — there is nothing to count.
  "sot-parity-config.json|enforcement|0"
)

verdict() { echo "DECLARATION_SYNC_VERDICT=$1"; exit "$2"; }

# Validate a candidate body. Refuses on anything it cannot positively confirm.
# <path> <required-key> <min-count> -> 0 ok / 1 reject (reason on stdout)
validate_body() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
path, key, min_count = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
except Exception as exc:                       # noqa: BLE001 - any parse failure is a refusal
    print(f"does not parse as JSON: {exc}"); sys.exit(1)
if not isinstance(doc, dict):
    print("top level is not an object"); sys.exit(1)
if key not in doc:
    print(f"required top-level key {key!r} is absent"); sys.exit(1)
val = doc[key]
if min_count > 0:
    if not isinstance(val, (list, dict)):
        print(f"{key!r} is {type(val).__name__}, expected a list/object to count"); sys.exit(1)
    if len(val) < min_count:
        print(f"{key!r} has {len(val)} entries, below the refusal floor of {min_count}"); sys.exit(1)
sys.exit(0)
PY
}

# A body that shrank by more than half is a truncation signature, not an edit.
# <new-bytes> <old-bytes> -> 0 ok / 1 reject
size_sane() {
  [ "$2" -eq 0 ] && return 0
  [ $(( $1 * 2 )) -lt "$2" ] && return 1
  return 0
}

alert() {   # <body>
  # An unusable wrapper is itself operator-relevant, and piping into a non-existent one produces
  # a broken-pipe smear that reads like a bug in the sync. Say which it is.
  if [ ! -x "$TG" ]; then
    echo "  ! escalation channel UNAVAILABLE: $TG is not executable — alert not delivered" >&2
    return 0
  fi
  printf '🛑 %s\n\n%s\n\nHost: %s\nDest: %s\n\nAction: dispatch %s via Cowork → Claude Code\n' \
    "$ALERT_ID" "$*" "$(hostname)" "$DEST_DIR" "$RECOMMENDED_WAVE" \
    | "$TG" "$ALERT_ID" CRITICAL_PERSISTENT - || true
}

# ── --self-test: hermetic. No network, no /opt, no TG. Vacuity-guarded ──────
self_test() {
  local fails=0 checks=0
  local tmp; tmp=$(mktemp -d "${TMPDIR:-/tmp}/declsync.XXXXXX") || return 3
  # BSD mktemp does not substitute XXXXXX unless it is TERMINAL, so the template ends there and
  # the filenames are fixed INSIDE the dir. A trap removes it so a leftover cannot poison a rerun.
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  ck() { checks=$((checks+1)); [ "$2" = "$3" ] || { echo "  ✗ $1 (got '$2' want '$3')"; fails=$((fails+1)); }; }

  printf '{"artifacts":[%s]}' "$(printf '{"id":"a"},%.0s' $(seq 1 49))$(printf '{"id":"z"}')" > "$tmp/good.json"
  printf '{"artifacts":[{"id":"a"}]}' > "$tmp/thin.json"
  printf '{"rows":[]}'                > "$tmp/wrongkey.json"
  printf '{"artifacts":[{"id":'       > "$tmp/truncated.json"
  printf '[]'                         > "$tmp/notobject.json"
  : > "$tmp/empty.json"

  validate_body "$tmp/good.json"      artifacts 40 >/dev/null 2>&1; ck 'a full body validates'            "$?" 0
  validate_body "$tmp/thin.json"      artifacts 40 >/dev/null 2>&1; ck 'below-floor count is REFUSED'     "$?" 1
  validate_body "$tmp/wrongkey.json"  artifacts 40 >/dev/null 2>&1; ck 'missing required key is REFUSED'  "$?" 1
  validate_body "$tmp/truncated.json" artifacts 40 >/dev/null 2>&1; ck 'truncated JSON is REFUSED'        "$?" 1
  validate_body "$tmp/notobject.json" artifacts 40 >/dev/null 2>&1; ck 'non-object top level is REFUSED'  "$?" 1
  validate_body "$tmp/empty.json"     artifacts 40 >/dev/null 2>&1; ck 'empty body is REFUSED'            "$?" 1
  validate_body "$tmp/thin.json"      artifacts  0 >/dev/null 2>&1; ck 'presence-only skips the count'    "$?" 0

  size_sane 100 100 >/dev/null 2>&1; ck 'same size is sane'                "$?" 0
  size_sane  60 100 >/dev/null 2>&1; ck 'a 40% shrink is sane'             "$?" 0
  size_sane  40 100 >/dev/null 2>&1; ck 'a >50% collapse is REFUSED'       "$?" 1
  size_sane 100   0 >/dev/null 2>&1; ck 'no prior file cannot be a shrink' "$?" 0

  # Vacuity guard: in --self-test WE build the corpus, so an empty one is a defect in the TEST.
  # (At runtime an empty corpus would be a FACT about the world — a different question entirely.)
  if [ "${#DECLARATIONS[@]}" -eq 0 ]; then
    echo "  ✗ the declared file set is EMPTY — this self-test would assert nothing"; fails=$((fails+1))
  fi
  checks=$((checks+1))
  # Every declared row must be well-formed, or the runtime loop silently skips it.
  local d name key min
  for d in "${DECLARATIONS[@]}"; do
    IFS='|' read -r name key min <<< "$d"
    checks=$((checks+1))
    if [ -z "$name" ] || [ -z "$key" ] || ! [ "$min" -ge 0 ] 2>/dev/null; then
      echo "  ✗ malformed declaration row: '$d'"; fails=$((fails+1))
    fi
  done

  if [ "$fails" -ne 0 ]; then
    echo "✗ declaration-sync self-test: $fails of $checks check(s) FAILED"
    verdict INDETERMINATE 3
  fi
  echo "✓ declaration-sync self-test: $checks checks passed (validator refusals both ways, size-collapse guard, declared-set well-formedness)"
  verdict UNCHANGED 0
}

[ "${1:-}" = "--self-test" ] && self_test

# ── sync ────────────────────────────────────────────────────────────────────
command -v curl   >/dev/null 2>&1 || verdict INDETERMINATE 3
command -v python3 >/dev/null 2>&1 || verdict INDETERMINATE 3
[ -d "$DEST_DIR" ] || { echo "  ✗ dest dir $DEST_DIR does not exist"; verdict INDETERMINATE 3; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/declsync.XXXXXX") || verdict INDETERMINATE 3
# shellcheck disable=SC2064
trap "rm -rf '$WORK'" EXIT

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
changed=0; failed=0; unchanged=0
fail_detail=""

echo "declaration sync — ${#DECLARATIONS[@]} declared file(s) from $BASE_URL"

for d in "${DECLARATIONS[@]}"; do
  IFS='|' read -r name key min <<< "$d"
  dest="$DEST_DIR/$name"
  cand="$WORK/$name"

  code=$(curl -fsS -o "$cand" -w '%{http_code}' --max-time 30 "$BASE_URL/$name" 2>/dev/null) || code=000
  if [ "$code" != "200" ] || [ ! -s "$cand" ]; then
    echo "  ✗ FAILED   $name — fetch returned '$code' (kept the working file)"
    fail_detail="${fail_detail}${name}: fetch ${code}"$'\n'; failed=$((failed+1)); continue
  fi

  if ! reason=$(validate_body "$cand" "$key" "$min" 2>&1); then
    echo "  ✗ FAILED   $name — $reason (kept the working file)"
    fail_detail="${fail_detail}${name}: ${reason}"$'\n'; failed=$((failed+1)); continue
  fi

  new_b=$(wc -c < "$cand" | tr -d ' ')
  old_b=0; [ -f "$dest" ] && old_b=$(wc -c < "$dest" | tr -d ' ')
  if ! size_sane "$new_b" "$old_b"; then
    echo "  ✗ FAILED   $name — ${new_b}B vs ${old_b}B on disk: >50% collapse, refusing (kept the working file)"
    fail_detail="${fail_detail}${name}: size collapse ${new_b}/${old_b}"$'\n'; failed=$((failed+1)); continue
  fi

  new_h=$(sha256sum "$cand" | cut -d' ' -f1)
  old_h=""; [ -f "$dest" ] && old_h=$(sha256sum "$dest" | cut -d' ' -f1)
  if [ "$new_h" = "$old_h" ]; then
    echo "  · UNCHANGED $name — ${new_h:0:16} (${new_b}B)"
    unchanged=$((unchanged+1)); continue
  fi

  # Backup before replacing, per the NO_BACKUP check the reconciler asserts on load-bearing rows.
  # Only claim one when one was actually taken — a first install has nothing to back up, and an
  # alert body that asserts a file exists when it does not is its own small lie.
  backup_note="no prior file — nothing to back up"
  if [ -f "$dest" ]; then
    cp -p "$dest" "$dest.bak.$BACKUP_REASON-$STAMP"
    backup_note="backup .bak.$BACKUP_REASON-$STAMP"
  fi
  # Atomic swap: the reconciler may be mid-read, and a partial write would break every check.
  # Same filesystem, so mv is a rename. chown is best-effort (it is a no-op when already root and
  # fails harmlessly off-host in a test); the chmod + mv are what must succeed.
  cp "$cand" "$dest.tmp.$$" || { echo "  ✗ FAILED   $name — could not stage a temp copy"; fail_detail="${fail_detail}${name}: stage failed"$'\n'; failed=$((failed+1)); continue; }
  chown root:root "$dest.tmp.$$" 2>/dev/null || true
  chmod 644 "$dest.tmp.$$" && mv -f "$dest.tmp.$$" "$dest"
  if [ "$(sha256sum "$dest" | cut -d' ' -f1)" != "$new_h" ]; then
    rm -f "$dest.tmp.$$"
    echo "  ✗ FAILED   $name — post-swap hash mismatch"
    fail_detail="${fail_detail}${name}: post-swap hash mismatch"$'\n'; failed=$((failed+1)); continue
  fi
  echo "  ✓ SYNCED   $name — ${old_h:0:16} -> ${new_h:0:16} (${new_b}B), $backup_note"
  changed=$((changed+1))
done

echo "  summary: ${changed} synced · ${unchanged} unchanged · ${failed} failed"

if [ "$failed" -gt 0 ]; then
  # The wrapper OWNS cooldown + severity gating (CLAUDE.md: consumers must not re-implement them).
  alert "$failed of ${#DECLARATIONS[@]} declaration(s) could not be synced. The working files were KEPT, so checks still run — against a possibly stale declaration.

$fail_detail"
  verdict FAILED 1
fi
[ "$changed" -gt 0 ] && verdict SYNCED 0
verdict UNCHANGED 0
