#!/usr/bin/env bash
# install-monitoring-artifact.sh — install a monitoring artifact to EVERY host its registry says
# consumes it, resolving each host label through the SoT that already records addresses.
#
# OPS-AOE-SEND-TELEGRAM-REPARITY-W1.
#
# ── THE DEFECT THIS RETIRES, AND WHY DETECTION WAS NOT ENOUGH ────────────────────────────────
# `monitoring-inventory.json` records every installation of a shared primitive in `installed_at`.
# OPS-AOE-MONITORING-PARITY-W1 added that registry precisely because `send_telegram.sh` had been
# updated at ONE call site while a second host quietly kept an ancestor. But the registry was
# DECLARATIVE ONLY: nothing ever read it to perform an install. So "update the primitive
# everywhere" stayed a manual act of memory, and REGISTRY_PARITY could only report the miss
# afterwards. Detection is strictly weaker than enumeration — this script is the enumeration.
#
# ── THE ROOT CAUSE OF THE RECURRENCE WAS AN UNVERIFIED ABSENCE CLAIM ────────────────────────
# `send-telegram-wrapper`'s aoe-1 entry sat `install_state: pending` for 12 days on this recorded
# reason: *"its address is recorded NOWHERE in the repo SoT (the inventory carries only the
# label)"*. That was FALSE. The address was committed in FOUR files, two of them machine-readable
# — including `scripts/data/boot-critical-units.json`, which is a `label -> {address}` map for
# exactly these two hosts and has a live consumer. One `git grep` would have refuted it, and a
# whole wave was deferred on the unchecked claim instead.
#
# So this script resolves labels through THAT file rather than a new registry of its own: a
# duplicated fact goes stale, and a 4th home for one address is how this class regenerates. The
# companion test asserts every `installed_at` label resolves there, which is what makes
# "the address is recorded nowhere" unable to block a wave again.
#
# ── SAFETY ───────────────────────────────────────────────────────────────────────────────────
#  * DRY RUN BY DEFAULT. `--apply` is required to touch a host.
#  * Refuses unless the repo file's sha256 already equals the row's canonical `sha256`. The row
#    is what HASH_DRIFT and REGISTRY_PARITY compare against, so installing a file that disagrees
#    with it would plant drift by construction. Re-stamp first, then install.
#  * Timestamped backup before every overwrite (the convention NO_BACKUP asserts), and the
#    installed bytes are verified against canonical AFTER the swap.
#  * This is a human-invoked, reviewed install — NOT the unattended auto-install CLAUDE.md
#    forbids. It moves executable code, which is exactly why no cron may ever call it.
#
# Verdict: exactly one terminal INSTALL_MONITORING_ARTIFACT_VERDICT=PASS|FAIL|INDETERMINATE.
# Exit: 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (token-law default for a NEW gate).
#
# Usage:
#   install-monitoring-artifact.sh --self-test
#   install-monitoring-artifact.sh <row-id>            # dry run: says exactly what it would do
#   install-monitoring-artifact.sh <row-id> --apply
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
INVENTORY=${INSTALL_ARTIFACT_INVENTORY:-$REPO/ops/monitoring/monitoring-inventory.json}
HOSTS_SOT=${INSTALL_ARTIFACT_HOSTS_SOT:-$REPO/scripts/data/boot-critical-units.json}
SSH_KEY=${INSTALL_ARTIFACT_SSH_KEY:-$HOME/.ssh/algovault_deploy}
SSH_OPTS=${INSTALL_ARTIFACT_SSH_OPTS:--o StrictHostKeyChecking=no -o ConnectTimeout=12}
# The label stamped into the timestamped backup filename, i.e. the RECOVERY RECORD's stated
# reason. It defaulted to this script's OWN authoring wave, so every later install silently
# claimed to have been made by OPS-AOE-SEND-TELEGRAM-REPARITY-W1 — measured 2026-08-11, when
# OPS-X402-SETTLEMENT-BACKFILL-W1 installed the revenue-meter canary and its backup came out
# labelled with that unrelated wave. A backup exists so a human can answer "what changed here and
# why"; a false reason is worse than no reason. `MANUAL` is honest when the caller says nothing.
WAVE=${INSTALL_ARTIFACT_WAVE:-MANUAL}

verdict() { echo "INSTALL_MONITORING_ARTIFACT_VERDICT=$1"; exit "$2"; }
say() { printf '%s\n' "$*"; }

# Resolve a host LABEL to an address using the existing SoT. Fail closed and say where to look —
# a silent empty address would ssh to nowhere and read as a connectivity problem.
resolve_label() {
  # Path read at CALL time, not startup: the self-test overrides it per case, and a value
  # frozen at startup silently ignored the override (measured — it is why this had a bug).
  python3 - "${INSTALL_ARTIFACT_HOSTS_SOT:-$HOSTS_SOT}" "$1" <<'PY'
import json, sys
sot, label = sys.argv[1], sys.argv[2]
try:
    hosts = json.load(open(sot, encoding="utf-8")).get("hosts", {})
except Exception as exc:                                   # noqa: BLE001
    print(f"__ERR__ hosts SoT unreadable ({exc})"); raise SystemExit(0)
entry = hosts.get(label)
if not isinstance(entry, dict) or not entry.get("address"):
    print(f"__ERR__ label {label!r} has no address in {sot} (known: {sorted(hosts)})")
    raise SystemExit(0)
print(entry["address"])
PY
}

# Emit "<label>\t<path>" per installation the registry declares for this row.
row_targets() {
  python3 - "${INSTALL_ARTIFACT_INVENTORY:-$INVENTORY}" "$1" <<'PY'
import json, sys
inv, rid = sys.argv[1], sys.argv[2]
rows = json.load(open(inv, encoding="utf-8"))["artifacts"]
row = next((r for r in rows if r.get("id") == rid), None)
if row is None:
    print(f"__ERR__ no inventory row with id {rid!r}"); raise SystemExit(0)
entries = row.get("installed_at") or []
if not entries:
    # Deliberate: a row with no registry is not installable by this tool. Single-host rows carry
    # host/host_path, but this primitive exists for the MULTI-consumer case, and silently doing
    # one host would rebuild the very defect it retires.
    print(f"__ERR__ row {rid!r} declares no installed_at registry"); raise SystemExit(0)
print(f"__ARTIFACT__\t{row['artifact']}\t{row.get('sha256','')}")
for e in entries:
    if not e.get("host") or not e.get("path"):
        print(f"__ERR__ an installed_at entry of {rid!r} lacks host/path"); raise SystemExit(0)
    print(f"{e['host']}\t{e['path']}")
PY
}

self_test() {
  local fails=0 checks=0 tmp
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/instart.XXXXXX") || verdict INDETERMINATE 3
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  ck() { checks=$((checks+1)); [ "$2" = "$3" ] || { say "  ✗ $1 (got '$2' want '$3')"; fails=$((fails+1)); }; }

  # ── label resolution, both directions ──
  cat > "$tmp/hosts.json" <<'J'
{"hosts":{"h-good":{"address":"10.0.0.1"},"h-noaddr":{"compose_in_this_repo":false}}}
J
  local out
  out=$(INSTALL_ARTIFACT_HOSTS_SOT="$tmp/hosts.json" resolve_label h-good)
  ck 'a label with an address resolves' "$out" "10.0.0.1"
  out=$(INSTALL_ARTIFACT_HOSTS_SOT="$tmp/hosts.json" resolve_label h-noaddr)
  case "$out" in __ERR__*) ck 'a label with no address FAILS CLOSED' ok ok ;;
                 *) ck 'a label with no address FAILS CLOSED' "$out" '__ERR__…' ;; esac
  out=$(INSTALL_ARTIFACT_HOSTS_SOT="$tmp/hosts.json" resolve_label h-absent)
  case "$out" in __ERR__*) ck 'an unknown label FAILS CLOSED' ok ok ;;
                 *) ck 'an unknown label FAILS CLOSED' "$out" '__ERR__…' ;; esac
  out=$(INSTALL_ARTIFACT_HOSTS_SOT="$tmp/nope.json" resolve_label h-good)
  case "$out" in __ERR__*) ck 'an unreadable SoT FAILS CLOSED' ok ok ;;
                 *) ck 'an unreadable SoT FAILS CLOSED' "$out" '__ERR__…' ;; esac

  # ── registry enumeration ──
  cat > "$tmp/inv.json" <<'J'
{"artifacts":[
 {"id":"two-host","artifact":"ops/monitoring/x.sh","sha256":"aa",
  "installed_at":[{"host":"h1","path":"/opt/x.sh"},{"host":"h2","path":"/opt/x.sh"}]},
 {"id":"no-registry","artifact":"ops/monitoring/y.sh","sha256":"bb"},
 {"id":"bad-entry","artifact":"ops/monitoring/z.sh","sha256":"cc",
  "installed_at":[{"host":"h1"}]}
]}
J
  out=$(INSTALL_ARTIFACT_INVENTORY="$tmp/inv.json" row_targets two-host | grep -c $'^h[12]\t')
  ck 'both registry entries are enumerated' "$out" 2
  out=$(INSTALL_ARTIFACT_INVENTORY="$tmp/inv.json" row_targets no-registry | grep -c '^__ERR__')
  ck 'a row with no installed_at REFUSES' "$out" 1
  out=$(INSTALL_ARTIFACT_INVENTORY="$tmp/inv.json" row_targets bad-entry | grep -c '^__ERR__')
  ck 'an entry missing path REFUSES' "$out" 1
  out=$(INSTALL_ARTIFACT_INVENTORY="$tmp/inv.json" row_targets ghost | grep -c '^__ERR__')
  ck 'an unknown row id REFUSES' "$out" 1

  # ── the canonical-hash precondition, which is what keeps this from planting drift ──
  printf 'body\n' > "$tmp/art"
  local real; real=$(sha256sum "$tmp/art" | cut -d' ' -f1)
  hash_matches "$tmp/art" "$real"      >/dev/null 2>&1; ck 'matching hash passes the gate' "$?" 0
  hash_matches "$tmp/art" "${real%?}0" >/dev/null 2>&1; ck 'mismatching hash REFUSES'      "$?" 1
  hash_matches "$tmp/art" ""           >/dev/null 2>&1; ck 'absent canonical hash REFUSES' "$?" 1
  hash_matches "$tmp/absent" "$real"   >/dev/null 2>&1; ck 'absent artifact REFUSES'       "$?" 1

  # Vacuity: WE built these corpora, so an empty one is a defect in the TEST.
  checks=$((checks+1))
  [ "$checks" -ge 12 ] || { say "  ✗ self-test asserted almost nothing"; fails=$((fails+1)); }

  if [ "$fails" -ne 0 ]; then
    say "✗ install-monitoring-artifact self-test: $fails of $checks check(s) FAILED"
    verdict INDETERMINATE 3
  fi
  say "✓ install-monitoring-artifact self-test: $checks checks passed (label resolution both ways, registry enumeration, canonical-hash precondition)"
  verdict PASS 0
}

# <path> <expected-sha> -> 0 ok / 1 refuse
hash_matches() {
  [ -n "${2:-}" ] || { say "  ✗ the row carries no canonical sha256"; return 1; }
  [ -f "$1" ] || { say "  ✗ artifact not found at $1"; return 1; }
  local actual; actual=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$actual" = "$2" ] || {
    say "  ✗ repo file ${actual:0:12} != row.sha256 ${2:0:12} — re-stamp the inventory row FIRST"
    say "    (installing now would plant the drift HASH_DRIFT exists to catch)"
    return 1
  }
  return 0
}

[ "${1:-}" = "--self-test" ] && self_test

ROW_ID=${1:-}
APPLY=0
[ "${2:-}" = "--apply" ] && APPLY=1
[ -n "$ROW_ID" ] || { say "usage: $(basename "$0") <inventory-row-id> [--apply] | --self-test"; verdict INDETERMINATE 3; }
command -v python3   >/dev/null 2>&1 || verdict INDETERMINATE 3
command -v sha256sum >/dev/null 2>&1 || verdict INDETERMINATE 3
[ -r "$INVENTORY" ] || { say "  ✗ inventory unreadable: $INVENTORY"; verdict INDETERMINATE 3; }

# Process substitution, NEVER a pipe: `producer | while read` runs the loop in a SUBSHELL, so
# every TARGETS+=() lands in a child and the parent sees an empty array — which reads exactly
# like "the row has no targets". Measured here on the first run. macOS ships bash 3.2, so
# `mapfile` is unavailable and `< <(...)` is the portable form.
TARGETS=()
while IFS= read -r l; do [ -n "$l" ] && TARGETS+=("$l"); done < <(row_targets "$ROW_ID")
[ "${#TARGETS[@]}" -gt 0 ] || { say "  ✗ enumeration produced nothing"; verdict INDETERMINATE 3; }

ARTIFACT=""; CANON=""
for t in "${TARGETS[@]}"; do
  case "$t" in
    __ERR__*) say "  ✗ ${t#__ERR__ }"; verdict INDETERMINATE 3 ;;
    __ARTIFACT__*) IFS=$'\t' read -r _ ARTIFACT CANON <<< "$t" ;;
  esac
done
[ -n "$ARTIFACT" ] || { say "  ✗ row declared no artifact path"; verdict INDETERMINATE 3; }

SRC="$REPO/$ARTIFACT"
say "$ROW_ID — $ARTIFACT"
say "  canonical sha256: ${CANON:0:16}   mode: $([ "$APPLY" = 1 ] && echo APPLY || echo 'DRY RUN (pass --apply to act)')"
hash_matches "$SRC" "$CANON" || verdict FAIL 1

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ok=0; bad=0; skipped=0
for t in "${TARGETS[@]}"; do
  case "$t" in __ARTIFACT__*|__ERR__*) continue ;; esac
  IFS=$'\t' read -r label dest <<< "$t"
  addr=$(resolve_label "$label")
  case "$addr" in
    __ERR__*) say "  ✗ $label — ${addr#__ERR__ }"; bad=$((bad+1)); continue ;;
  esac

  live=$(ssh -n -i "$SSH_KEY" $SSH_OPTS "root@$addr" "sha256sum '$dest' 2>/dev/null | cut -d' ' -f1" 2>/dev/null)
  if [ "$live" = "$CANON" ]; then
    say "  · $label ($addr) — already canonical (${live:0:12})"
    skipped=$((skipped+1)); continue
  fi
  say "  → $label ($addr) — live ${live:-absent} -> ${CANON:0:12}"
  if [ "$APPLY" != 1 ]; then continue; fi

  if ! scp -q -i "$SSH_KEY" $SSH_OPTS "$SRC" "root@$addr:/tmp/.ima.$STAMP" 2>/dev/null; then
    say "    ✗ copy to $label failed"; bad=$((bad+1)); continue
  fi
  # Backup BEFORE the swap, verify AFTER it. Mode is preserved from the existing file when there
  # is one, so an install cannot silently drop the exec bit a cron depends on.
  out=$(ssh -n -i "$SSH_KEY" $SSH_OPTS "root@$addr" "
    set -u
    d='$dest'; t='/tmp/.ima.$STAMP'
    if [ -f \"\$d\" ]; then
      cp -p \"\$d\" \"\$d.bak.$WAVE-$STAMP\" || { echo BACKUP_FAILED; exit 1; }
      m=\$(stat -c %a \"\$d\")
    else m=755; fi
    install -m \"\$m\" \"\$t\" \"\$d\" || { echo INSTALL_FAILED; exit 1; }
    rm -f \"\$t\"
    echo \"OK \$(sha256sum \"\$d\" | cut -d' ' -f1) mode=\$m\"
  " 2>&1 | tail -1)
  case "$out" in
    "OK $CANON"*) say "    ✓ installed + verified (${out#OK }) · backup .bak.$WAVE-$STAMP"; ok=$((ok+1)) ;;
    *)            say "    ✗ $label — $out"; bad=$((bad+1)) ;;
  esac
done

say "  summary: $ok installed · $skipped already canonical · $bad failed"
[ "$bad" -eq 0 ] || verdict FAIL 1
verdict PASS 0
