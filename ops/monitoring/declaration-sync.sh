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

# ── WHICH HOST GETS WHICH DECLARATION (OPS-DECLARATION-SYNC-YAML-W1) ─────────────────────────
# Resolution mirrors monitoring-inventory-reconcile.py EXACTLY — same variable, same default — so
# there is ONE host-label convention in this directory rather than a second dialect. aoe-1's cron
# sets MONITORING_HOST_LABELS=aoe-1 for both scripts; the signal host takes the default.
#
# WHY SCOPING IS NOT OPTIONAL, measured the hard way in this wave: the first cut synced all ten
# declarations to BOTH hosts on the theory that a few inert extra files were harmless next to the
# risk of forking a shared primitive. The AOE reconciler disagreed within a minute —
#   CHECK ORPHAN: BREACH ["OPS-SEED-ORCHESTRATOR-W1-baseline.json", …5 files]
# — and it was right: aoe-1 runs none of those canaries, so those configs had no consumer there,
# and an unregistered file on a host is exactly what ORPHAN exists to catch. Note this does NOT
# fork the primitive: the SCRIPT stays byte-identical on both hosts and only its BEHAVIOUR branches
# on the label, which is the same shape the reconciler already uses.
HOST_LABELS=${MONITORING_HOST_LABELS:-signal-1,204.168.185.24}

# True when $1 (a scope field) applies to this host. `*` = every host.
scope_applies() {
  case "$1" in *'*'*) return 0 ;; esac
  local want have
  local IFS=,
  for want in $1; do
    for have in $HOST_LABELS; do
      [ "$want" = "$have" ] && return 0
    done
  done
  return 1
}

# <filename>|<required top-level key>|<min entry count, 0 = presence only>|<host scope>
# The count floor is a REFUSAL threshold, not a target: it exists so a truncated or half-written
# body can never replace a working file. Keep it well below the live value.
# The scope is `*` for a declaration every host reads, or a comma-list of host labels.
#
# ── THIS SET IS NO LONGER MAINTAINED BY MEMORY (OPS-DECLARATION-SYNC-YAML-W1, 2026-08-10) ─────
# It is still hand-written HERE on purpose — a separate config file would itself be a declaration
# needing a sync, the recursion this script exists to end (see the note above). What changed is
# that its COMPLETENESS is now DERIVED and ASSERTED against `ops/monitoring/monitoring-inventory.json`
# by tests/unit/declaration-sync.test.ts: every inventory row that is a host-consumed,
# non-executable, in-repo declaration MUST appear below, or the build fails. Adding a host config
# without wiring it here is therefore no longer possible to do silently.
#
# That assertion found FIVE rows already missing — and only three of them were the YAML this wave
# was named for. `venue-slo-tiers.json` and `OPS-SEED-ORCHESTRATOR-W1-baseline.json` are JSON and
# had simply never been added, which is exactly why the fix is a derived-coverage assertion rather
# than "add YAML support": a hand-maintained set drifts in whatever format nobody is thinking about.
DECLARATIONS=(
  # Every host's reconciler reads these five, so they are `*`.
  "monitoring-inventory.json|artifacts|40|*"
  "doc-host-path-claims.json|claims|1|*"
  "network-posture.json|hosts|1|*"
  "schedule-boundary-rule.json|canonical_minutes|5|*"
  # Ch3's SOT_PARITY config. In the set on purpose: the check that audits whether the hosts read
  # the committed declaration must not itself be configured by a copy nobody keeps current.
  # `enforcement` is a string, so presence-only (0) — there is nothing to count.
  "sot-parity-config.json|enforcement|0|*"
  # ── added by OPS-DECLARATION-SYNC-YAML-W1 ──
  # All five are signal-host canary configs: their consumers run only there, and syncing them
  # everywhere makes them ORPHANs on hosts that read them from nowhere (measured — see above).
  # The file whose 5-day rot motivated this: retired in the repo 2026-08-05, still live on the
  # host 2026-08-10, because no sync path reached a .yaml. Live `rows` is 30; floor well below.
  "website-drift-manifest.yaml|rows|20|signal-1"
  "postgres-cpu-autopilot-registry.yaml|classes|3|signal-1"
  "recommendation-drift-manifest.yaml|rows|2|signal-1"
  # JSON, and never synced — the two the "add YAML" framing would have walked straight past.
  "venue-slo-tiers.json|majors|3|signal-1"
  # `baseline-data`: HASH_DRIFT on it is SEVERE because the baseline IS what "normal" means. Note
  # the direction this establishes — a host-side regeneration that is not committed gets REVERTED
  # within the hour. That is intended (committed is canonical, and network-posture.json already
  # sets the precedent), but it means a legitimate incident-time re-baseline must be committed.
  "OPS-SEED-ORCHESTRATOR-W1-baseline.json|by_venue_total_24h|3|signal-1"
)

verdict() { echo "DECLARATION_SYNC_VERDICT=$1"; exit "$2"; }

# Validate a candidate body. Refuses on anything it cannot positively confirm.
# <path> <required-key> <min-count> -> 0 ok / 1 reject (reason on stdout)
#
# Format is chosen by EXTENSION, and the contract is identical for both: a mapping at the top
# level, the required key present, and (when the floor is non-zero) a countable value at or above
# it. YAML is a superset of JSON, so `yaml.safe_load` would parse both — but dispatching on the
# extension keeps a malformed .json from being silently rescued by YAML's laxer grammar, which
# would defeat the truncation guard this function exists to be.
validate_body() {
  python3 - "$1" "$2" "$3" <<'PY'
import json, os, sys
path, key, min_count = sys.argv[1], sys.argv[2], int(sys.argv[3])
ext = os.path.splitext(path)[1].lower()
try:
    raw = open(path, encoding="utf-8").read()
except Exception as exc:                       # noqa: BLE001 - any read failure is a refusal
    print(f"unreadable: {exc}"); sys.exit(1)
if ext in (".yaml", ".yml"):
    try:
        import yaml
    except ImportError:
        # NOT a malformed body — we could not VERIFY it. Say so explicitly, because the loop turns
        # this into FAILED (keep the working file + alert), and an operator reading "does not
        # parse" would go looking for a corrupt file that is perfectly fine.
        print("PyYAML unavailable — cannot verify a YAML declaration"); sys.exit(1)
    try:
        doc = yaml.safe_load(raw)
    except Exception as exc:                    # noqa: BLE001
        print(f"does not parse as YAML: {exc}"); sys.exit(1)
else:
    try:
        doc = json.loads(raw)
    except Exception as exc:                    # noqa: BLE001
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

# True when any declared file needs a YAML parser. Drives the fail-closed preflight below: a
# missing PyYAML must be INDETERMINATE ("verified nothing") rather than a per-file FAILED, or a
# host without the module reports N specific refusals for one missing dependency.
declares_yaml() {
  local d name scope
  for d in "${DECLARATIONS[@]}"; do
    IFS='|' read -r name _ _ scope <<< "$d"
    scope_applies "$scope" || continue      # a YAML row for another host needs no parser here
    case "$name" in *.yaml|*.yml) return 0 ;; esac
  done
  return 1
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

  # ── YAML, both directions (OPS-DECLARATION-SYNC-YAML-W1) ──
  # The seam this wave added is the format branch, so it is the one thing a hermetic self-test
  # would otherwise never execute. Fixtures mirror the JSON cases exactly.
  printf 'rows:\n%s' "$(printf '  - {id: r}\n%.0s' $(seq 1 25))" > "$tmp/good.yaml"
  printf 'rows:\n  - {id: r}\n'                                   > "$tmp/thin.yaml"
  printf 'classes:\n  - a\n'                                      > "$tmp/otherkey.yaml"
  printf 'rows:\n  - {id: r\n   bad indent: [\n'                   > "$tmp/broken.yaml"
  printf -- '- a\n- b\n'                                           > "$tmp/seq.yaml"
  : > "$tmp/empty.yaml"

  validate_body "$tmp/good.yaml"     rows 20 >/dev/null 2>&1; ck 'a full YAML body validates'          "$?" 0
  validate_body "$tmp/thin.yaml"     rows 20 >/dev/null 2>&1; ck 'below-floor YAML is REFUSED'         "$?" 1
  validate_body "$tmp/otherkey.yaml" rows 20 >/dev/null 2>&1; ck 'missing key in YAML is REFUSED'      "$?" 1
  validate_body "$tmp/broken.yaml"   rows 20 >/dev/null 2>&1; ck 'unparseable YAML is REFUSED'         "$?" 1
  validate_body "$tmp/seq.yaml"      rows 20 >/dev/null 2>&1; ck 'YAML sequence at top is REFUSED'     "$?" 1
  validate_body "$tmp/empty.yaml"    rows 20 >/dev/null 2>&1; ck 'empty YAML is REFUSED'               "$?" 1
  validate_body "$tmp/good.yaml"     rows  0 >/dev/null 2>&1; ck 'YAML presence-only skips the count'  "$?" 0
  # A .json body must NOT be rescued by YAML's laxer grammar — that is why we branch on extension
  # rather than parsing everything with yaml.safe_load.
  validate_body "$tmp/truncated.json" artifacts 0 >/dev/null 2>&1; ck 'truncated .json is not YAML-rescued' "$?" 1
  # The set genuinely contains YAML, so the preflight predicate must say so — a hermetic suite that
  # never evaluates it would let the runtime guard rot unnoticed.
  declares_yaml; ck 'declares_yaml() sees the YAML rows' "$?" 0

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
  local d name key min scope
  for d in "${DECLARATIONS[@]}"; do
    IFS='|' read -r name key min scope <<< "$d"
    checks=$((checks+1))
    if [ -z "$name" ] || [ -z "$key" ] || ! [ "$min" -ge 0 ] 2>/dev/null || [ -z "$scope" ]; then
      echo "  ✗ malformed declaration row (name|key|min|scope): '$d'"; fails=$((fails+1))
    fi
  done

  # scope_applies(): the seam that decides what a host installs, so assert it directly rather
  # than trusting it. A wrong answer here either starves a host or plants ORPHANs on it.
  ( HOST_LABELS=signal-1,204.168.185.24
    scope_applies '*'              ) >/dev/null 2>&1; ck 'scope * applies anywhere'          "$?" 0
  ( HOST_LABELS=signal-1; scope_applies 'signal-1' ) >/dev/null 2>&1; ck 'own label applies'  "$?" 0
  ( HOST_LABELS=aoe-1;    scope_applies 'signal-1' ) >/dev/null 2>&1; ck 'other label REFUSED' "$?" 1
  ( HOST_LABELS=aoe-1;    scope_applies 'signal-1,aoe-1' ) >/dev/null 2>&1; ck 'list matches'  "$?" 0
  ( HOST_LABELS=aoe-1;    scope_applies '' ) >/dev/null 2>&1; ck 'empty scope applies nowhere' "$?" 1
  # Vacuity in the OTHER direction: on each real host at least one row must be in scope, or the
  # sync is a silent no-op there — the exact shape of failure this whole script exists to end.
  local n l
  for l in signal-1 aoe-1; do
    n=0
    for d in "${DECLARATIONS[@]}"; do
      IFS='|' read -r _ _ _ scope <<< "$d"
      ( HOST_LABELS=$l; scope_applies "$scope" ) >/dev/null 2>&1 && n=$((n+1))
    done
    checks=$((checks+1))
    [ "$n" -gt 0 ] || { echo "  ✗ no declaration is in scope for host label '$l'"; fails=$((fails+1)); }
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
# Fail-closed on the YAML parser, and INDETERMINATE rather than FAILED: without it we cannot
# verify those bodies at all, which is "verified nothing", not "found something wrong".
if declares_yaml && ! python3 -c 'import yaml' >/dev/null 2>&1; then
  echo "  ✗ PyYAML is unavailable but the declared set contains YAML — cannot verify those bodies"
  verdict INDETERMINATE 3
fi
[ -d "$DEST_DIR" ] || { echo "  ✗ dest dir $DEST_DIR does not exist"; verdict INDETERMINATE 3; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/declsync.XXXXXX") || verdict INDETERMINATE 3
# shellcheck disable=SC2064
trap "rm -rf '$WORK'" EXIT

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
changed=0; failed=0; unchanged=0; skipped=0
fail_detail=""

echo "declaration sync — ${#DECLARATIONS[@]} declared file(s) from $BASE_URL"

for d in "${DECLARATIONS[@]}"; do
  IFS='|' read -r name key min scope <<< "$d"
  if ! scope_applies "$scope"; then
    # POSITIVE output, not silence: a skipped row must be distinguishable from a synced one, or
    # "nothing happened" reads the same as "everything was already current".
    echo "  – SKIPPED  $name — scoped to '$scope', this host is '$HOST_LABELS'"
    skipped=$((skipped+1)); continue
  fi
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

  # Backup per the NO_BACKUP check the reconciler asserts on EVERY load-bearing row.
  #
  # A first install has no prior revision to preserve — but skipping the backup entirely leaves
  # the new row tripping NO_BACKUP until the file happens to change, which is a false alarm the
  # sync itself manufactures. Measured: adding sot-parity-config.json produced exactly that on
  # signal-1 within minutes. So a prior file is backed up (a real rollback point), and a first
  # install is stamped AFTER the swap (establishes the convention plus a restore point for the
  # first unintended change). Only ever claim the one that actually happened.
  first_install=1
  backup_note="first install — .bak stamped after the swap"
  if [ -f "$dest" ]; then
    first_install=0
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
  [ "$first_install" -eq 1 ] && cp -p "$dest" "$dest.bak.$BACKUP_REASON-$STAMP"
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
