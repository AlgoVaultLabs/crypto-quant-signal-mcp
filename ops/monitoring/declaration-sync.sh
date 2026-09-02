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

# ── DURABLE HISTORY (OPS-MONITORING-INVENTORY-RESTORE-W1) ────────────────────────────────────
# Until this wave the only record of a run was wherever the crontab redirect happened to send
# stdout — an UNCOMMITTED destination, so the committed file described none of its own history.
# The path here matches what both hosts' crontabs already redirect to, so nothing moves.
#
# We do NOT tee the per-row body into it. `closedbar-w1-liveness.sh:78` paid for that lesson:
# the cron line already redirects stdout here, so tee-ing wrote every line TWICE. Instead the
# body stays on stdout (one writer, one copy) and only two STRUCTURED bookend records are
# appended directly — a START and the terminal verdict — which are what make the file
# self-describing if the redirect is ever removed or the script is run by hand.
LOG=${DECLARATION_SYNC_LOG:-/var/log/declaration-sync.log}

# Attempt heartbeat, consumed by monitoring-inventory-reconcile.py's SYNC_LIVENESS check.
# /var/lib, NOT $DEST_DIR: a file under the monitoring dir with no inventory row is exactly what
# ORPHAN exists to catch, and the existing snapshot-landing-heartbeat
# (ops/cron/snapshot-landing-daily.sh:49) already established /var/lib as the heartbeat home.
HEARTBEAT=${DECLARATION_SYNC_HEARTBEAT:-/var/lib/algovault-monitoring/declaration-sync-heartbeat}

# Set by self_test(). The hermetic suite must never touch /var/log or /var/lib, and must never
# alert — its INDETERMINATE is a TEST failure, not an operational one.
IN_SELF_TEST=0

# Fail-soft on every side of it: an unwritable log or heartbeat must cost the RECORD, never the
# sync. `|| true` is load-bearing for the same reason send_telegram.sh:31 documents.
log_line() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG" 2>/dev/null || true; }

# ── WHICH HOST GETS WHICH DECLARATION (OPS-DECLARATION-SYNC-YAML-W1) ─────────────────────────
# WHY SCOPING IS NOT OPTIONAL, measured the hard way in that wave: the first cut synced all ten
# declarations to BOTH hosts on the theory that a few inert extra files were harmless next to the
# risk of forking a shared primitive. The AOE reconciler disagreed within a minute —
#   CHECK ORPHAN: BREACH ["OPS-SEED-ORCHESTRATOR-W1-baseline.json", …5 files]
# — and it was right: aoe-1 runs none of those canaries, so those configs had no consumer there,
# and an unregistered file on a host is exactly what ORPHAN exists to catch. Note this does NOT
# fork the primitive: the SCRIPT stays byte-identical on both hosts and only its BEHAVIOUR branches
# on the label, which is the same shape the reconciler already uses.
#
# ── THERE IS DELIBERATELY NO DEFAULT IDENTITY (OPS-DECLARATION-SYNC-HOST-IDENTITY-W1) ─────────
# This line used to give MONITORING_HOST_LABELS a DEFAULT naming A DIFFERENT PRODUCTION HOST —
# the signal host's label and its literal address. (The value is described rather than quoted on
# purpose: it must not reappear anywhere in this file, and a guard test greps for it.)
# That cannot fail safely, and on 2026-08-13T14:04:01Z it did not:
# a hand-run on aoe-1 without the env inherited signal-1's identity, so scope_applies() approved
# every signal-1 row and the sync wrote five foreign declarations (plus five .bak siblings) onto
# aoe-1, reporting `✓ SYNCED` for each. The 07:17 reconcile caught them as ORPHANs and paged.
# The guard was never wrong — it was fed a false identity. Note this is the SECOND time these
# exact five files have littered aoe-1; the block above is the first.
#
# So identity is now ASSERTED, never assumed, and the resolution FAILS TOWARD REFUSAL:
#   1. MONITORING_HOST_LABELS — the explicit operator/cron path, unchanged.
#   2. /etc/algovault-host-label — the host's own opaque label, asserted by the host itself.
#   3. neither -> UNRESOLVED (empty) -> the precondition below REFUSES the whole run.
# A peer host's label may NEVER be a fallback here, in any form. Refusing is correct even though
# it means an unlabelled run stops working: such a run only ever "worked" by coincidence, on
# exactly one of the two hosts.
#
# Extracted as a function rather than inlined so the hermetic self-test can assert the resolution
# ORDER directly — a seam the suite replaces is otherwise the one thing it cannot see.
HOST_IDENTITY_FILE=${DECLARATION_SYNC_IDENTITY_FILE:-/etc/algovault-host-label}

resolve_host_labels() {   # <env value> <identity file> -> labels on stdout, empty when unresolved
  if [ -n "${1:-}" ]; then printf '%s' "$1"; return 0; fi
  [ -r "${2:-}" ] || return 0
  tr -d '[:space:]' < "$2" 2>/dev/null || true
}

HOST_LABELS=$(resolve_host_labels "${MONITORING_HOST_LABELS:-}" "$HOST_IDENTITY_FILE")

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
  # Every host's reconciler reads these six, so they are `*`.
  "monitoring-inventory.json|artifacts|40|*"
  "doc-host-path-claims.json|claims|1|*"
  "network-posture.json|hosts|1|*"
  "schedule-boundary-rule.json|canonical_minutes|5|*"
  # Ch3's SOT_PARITY config. In the set on purpose: the check that audits whether the hosts read
  # the committed declaration must not itself be configured by a copy nobody keeps current.
  # `enforcement` is a string, so presence-only (0) — there is nothing to count.
  "sot-parity-config.json|enforcement|0|*"
  # The alert CONSUMER REGISTRY, added by OPS-ALERT-REGISTRY-DECLARE-W1 — same argument one
  # subject over: the registry that records which alerts exist must not itself be a copy nobody
  # keeps current. `alerts` is live 46; 30 is a truncation refusal, not a target.
  # It is `*` on MEASURED evidence, not on assumption. Both hosts' reconcilers OWN this row and
  # both raised `KeyError: 'host_path'` on it (measured live 2026-08-21 03:25Z, before the
  # row carried one) — a crash is positive proof the row is read there, which is exactly the
  # "does this host genuinely consume it" test the ORPHAN note above demands before `*`.
  # NOTE THE PAIRING, because the two files sit next to each other on the host and a reader
  # deserves the line stated: alert-registry.json is a DECLARATION (inert JSON, synced here),
  # while send_telegram.sh — which READS it — is an ARTIFACT (executable, installed by reviewed
  # SSH and never by this script). This script moves the first and never the second. That is
  # what keeps the whole mechanism inside CLAUDE.md's no-auto-install rule.
  "alert-registry.json|alerts|30|*"
  # ── added by OPS-DECLARATION-SYNC-YAML-W1 ──
  # All five are signal-host canary configs: their consumers run only there, and syncing them
  # everywhere makes them ORPHANs on hosts that read them from nowhere (measured — see above).
  # The file whose 5-day rot motivated this: retired in the repo 2026-08-05, still live on the
  # host 2026-08-10, because no sync path reached a .yaml. Live `rows` is 30; floor well below.
  "website-drift-manifest.yaml|rows|20|signal-1"
  "postgres-cpu-autopilot-registry.yaml|classes|3|signal-1"
  # Floor lowered 2 -> 1 by OPS-AOE-LIVENESS-W2 CH2, which RETIRED the third row
  # (AOE_SHADOW_WRITER_STALL, a cross-host target that had been dark since it was added). Live
  # `rows` is now 2, which the old floor would have REFUSED — freezing a healthy declaration on
  # every host. The floor is a truncation guard, never a policy minimum, so it tracks the live
  # value from below rather than pinning it from above.
  "recommendation-drift-manifest.yaml|rows|1|signal-1"
  # JSON, and never synced — the two the "add YAML" framing would have walked straight past.
  "venue-slo-tiers.json|majors|3|signal-1"
  # `baseline-data`: HASH_DRIFT on it is SEVERE because the baseline IS what "normal" means. Note
  # the direction this establishes — a host-side regeneration that is not committed gets REVERTED
  # within the hour. That is intended (committed is canonical, and network-posture.json already
  # sets the precedent), but it means a legitimate incident-time re-baseline must be committed.
  "OPS-SEED-ORCHESTRATOR-W1-baseline.json|by_venue_total_24h|3|signal-1"
  # ── added by OPS-MONITORING-SIGNAL-CONTRACT-W1 CH2 ──
  # The DETECTOR_ENVELOPE contract. Scope widened signal-1 -> signal-1,aoe-1 by
  # OPS-AOE-LIVENESS-W1 CH1: the condition this line set was MET, not waived. aoe-1 now has a
  # genuine reader — monitoring/aoe-host/aoe-output-liveness-canary.py (autonomous-optimizer
  # repo) imports the detector_envelope.py installed beside it there. Still a COMMA-LIST and
  # deliberately not `*`: `*` would declare every host a reader, which is the claim this row
  # spent four months refusing to make. Add the next host the same way, when it reads.
  # THE PAIRING, stated because the two files sit next to each other on the host: the .schema.json
  # is a DECLARATION (inert JSON, synced here) and detector_envelope.py is an ARTIFACT
  # (executable, installed by reviewed SSH and never by this script).
  # `required_fields` is live 9; 5 is a truncation refusal, not a target.
  # ── added by OPS-HOST-KERNEL-REBOOT-W3 CH1 ──
  # The boot-survival contract, PROJECTED from scripts/data/boot-critical-units.json by
  # scripts/check-boot-contract-parity.mjs. `*` on MEASURED evidence: boot-contract-canary.sh is
  # installed and scheduled on BOTH hosts and reads this file to decide, and aoe-1 has no checkout
  # of this repo at all, so this sync is its ONLY source.
  # Floor 1, and the reasoning is worth stating because 2 is the tempting answer. `hosts` is a
  # DICT of exactly two (signal-1, aoe-1), and tests/unit/declaration-sync.test.ts REQUIRES every
  # floor to sit STRICTLY BELOW the live count: "the floor is a truncation guard, never a policy
  # minimum" — a floor equal to the live value starts refusing a healthy declaration the moment
  # the file legitimately shrinks, and the hosts then silently freeze on a stale copy. That is the
  # same lesson recorded two entries above, where OPS-AOE-LIVENESS-W2 CH2 had to lower a floor
  # 2 -> 1 after retiring a row. So the "there must be TWO hosts" requirement is enforced where it
  # can be enforced without that side effect, and it IS enforced twice:
  #   - scripts/check-boot-contract-parity.mjs refuses to emit or accept a projection declaring
  #     fewer than MIN_HOSTS=2, at build time, before anything reaches a host;
  #   - boot-contract-canary.sh resolves its own identity FROM this file and reports
  #     INDETERMINATE when it matches no declared host, so a truncated copy makes the guard say
  #     so rather than quietly evaluating the wrong box.
  # THE PAIRING: boot-contract.json is a DECLARATION (generated, inert JSON, synced here) while
  # boot-contract-canary.sh is an ARTIFACT (executable, installed by reviewed SSH, never here).
  "boot-contract.json|hosts|1|*"
  "detector-envelope.schema.json|required_fields|5|signal-1,aoe-1"
  # ── added by OPS-AUDIT-CADENCE-CANARY-W1 CH2 ──
  # The security-audit cadence ledger. Its ONLY consumer is audit-cadence-canary.py on signal-1,
  # so the scope is `signal-1` and NOT `*`: syncing it to aoe-1 would make it an ORPHAN there —
  # a file that host reads from nowhere — which is the measured lesson the .yaml rows above
  # already record. Add the next host the same way, WHEN it reads.
  #
  # Floor 1, not 2. `audits` is live at 2 and grows by one per monthly audit; the floor is a
  # TRUNCATION guard, never a policy minimum, so it tracks the live value from BELOW. A floor
  # pinned at the live count would REFUSE a legitimate future edit, which is how a healthy
  # declaration gets frozen on every host.
  #
  # THE PAIRING, stated because the two sit next to each other on the host: audit-cadence.json is
  # a DECLARATION (inert JSON, synced here) and audit-cadence-canary.py is an ARTIFACT
  # (executable, installed by reviewed SSH in CH3 and never by this script). That distinction is
  # what keeps this mechanism inside CLAUDE.md's no-auto-install rule.
  #
  # This row lands in CH2 rather than CH1 BY MEASUREMENT: check-declaration-coverage.mjs derives
  # its expectation from CONSUMPTION, so a declaration with no reader makes `declared` a strict
  # superset of `derived` — which its Vacuity Guard 3 correctly calls a broken scan and returns
  # INDETERMINATE for. The declaration must land WITH its consumer, and here it does.
  "audit-cadence.json|audits|1|signal-1"
)

# Exactly one terminal token on stdout, plus — outside the hermetic suite — a durable record in
# BOTH the log and the heartbeat. The heartbeat's verdict half is what separates "cron never
# fired" (no attempt_at at all, or a stale one) from "fired and wedged" (fresh attempt_at, no
# verdict= or a FAILED/INDETERMINATE one). Recording only the attempt would collapse those two.
verdict() {
  if [ "$IN_SELF_TEST" -eq 0 ]; then
    log_line "DECLARATION_SYNC_VERDICT=$1 exit=$2"
    { printf 'verdict=%s\nverdict_at=%s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$HEARTBEAT"; } 2>/dev/null || true
    # ── ADOPTER (OPS-ALERT-RECOVERY-NOTICE-W1 CH2) ───────────────────────────────────────────
    # A healthy terminal verdict is the FIRING -> CLEAR transition for this alert. Before this,
    # a green run said nothing to the channel, so the operator could not distinguish "healed" from
    # "still broken, inside its 24h cooldown" from "the sync died" — which is precisely how the
    # 2026-08-17 episode stayed live in the operator's view for 70 hours after it self-healed.
    #
    # ONLY on the healthy verdicts. FAILED alerts on its own path and INDETERMINATE means the run
    # could not verify anything — clearing on "I don't know" would be the confident wrong answer
    # this estate keeps retiring.
    #
    # Fail-open and non-fatal: `|| true` under a script that is not `set -e` is belt-and-braces,
    # but this must never be able to change the sync's own verdict or exit code.
    case "$1" in
      SYNCED|UNCHANGED)
        # `< /dev/null` is LOAD-BEARING, not decoration. The clear path takes its argument
        # positionally and reads no body, but this runs from cron with whatever stdin the
        # scheduler handed the job — and an alert wrapper that ever blocks on a read would hang
        # the sync forever at its own success path, which is the worst possible place for it.
        # Measured during this wave's own live proof: a stand-in wrapper that did `cat -` hung a
        # real declaration-sync run on aoe-1 until it was killed. Close the mouth explicitly.
        [ -x "$TG" ] && { "$TG" --clear "$ALERT_ID" "declaration sync verdict=$1" </dev/null >/dev/null 2>&1 || true; }
        ;;
    esac
  fi
  echo "DECLARATION_SYNC_VERDICT=$1"
  exit "$2"
}

# ATTEMPT recency, stamped at job START and BEFORE any conditional work — CLAUDE.md: "Producer
# liveness pages on ATTEMPT recency (heartbeat stamped at job START, fail-soft, before
# conditional work), NOT output recency". Output recency is unusable here by construction: the
# sync only REWRITES a declaration whose hash changed (see the UNCHANGED `continue` below), so a
# perfectly healthy run on a stable declaration set touches nothing and advances no mtime. A
# bound built on declaration mtime would therefore fire on healthy hosts, forever.
stamp_attempt() {
  [ "$IN_SELF_TEST" -eq 0 ] || return 0
  mkdir -p "$(dirname "$HEARTBEAT")" 2>/dev/null || true
  { printf 'attempt_at=%s\nhost_labels=%s\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HOST_LABELS" > "$HEARTBEAT"; } 2>/dev/null || true
}

# ── What THIS attempt RESOLVED, per declaration (OPS-SOT-PARITY-PHASE-W1) ────────────────────
#
# The reconciler's SOT_PARITY check compares the host's local declaration against the committed
# SoT at a FIXED time each day. On aoe-1 that sample lands 50 minutes after this script's last
# run and 10 minutes before its next, so any commit inside that window reads as DRIFTED against
# a host that is behaving perfectly — measured 4/4, every such reading healed by the very next
# sync, +10 minutes, unobserved.
#
# One line of evidence closes it: the sha this attempt actually FETCHED and VALIDATED. If the
# host holds exactly that, the host is faithful and the SoT simply moved since — propagation,
# not drift. If the host holds something ELSE, the sync fetched a body it failed to install, and
# THAT is the real "the sync is not landing" that the alert was written for.
#
# Recorded for BOTH terminal per-file outcomes, because both are resolutions: UNCHANGED means
# "fetched, validated, already had it" and SYNCED means "fetched, validated, installed it". A
# rejected or unfetchable body records NOTHING — we resolved no sha, so we make no claim, and
# the reconciler's absence-of-key path falls straight back to DRIFTED. Suppression is EARNED.
#
# Appended, never rewritten: stamp_attempt() truncates the heartbeat at job start, so the file
# only ever describes the CURRENT attempt. Fail-soft — this must never change a verdict.
record_resolved() {
  [ "$IN_SELF_TEST" -eq 0 ] || return 0
  { printf 'resolved:%s=%s\n' "$1" "$2" >> "$HEARTBEAT"; } 2>/dev/null || true
}

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

# ── A SENTINEL ASSIGNED IN A `||` FALLBACK DESTROYS THE DIAGNOSTIC ───────────────────────────
# (OPS-MONITORING-DECLARATION-SYNC-W1 CH1a.) The fetch used to pass `-f` — bundled in this
# script's original `-fsS` cluster — together with a `||` fallback:
#
#     code=$(curl -sS -f ... -w '%{http_code}' ...) || code=<sentinel>
#
# `-f` makes curl exit 22 on any HTTP >= 400, so the `||` fired and OVERWROTE `code` with a
# sentinel — discarding the status curl had ALREADY captured. One value then encoded six causes
# with six different remedies, three of them one command apart and one (`connect`) that must
# never be automated. Measured cost, 2026-08-17: five rows reported the sentinel on both hosts,
# the operator could not tell an upstream vendor outage from a wrong BASE_URL, and a 3-chapter
# wave was specced against a condition that had self-healed 70h earlier. The cause was a GitHub
# platform incident (13:28-21:15Z, raw-content ~50% error at peak) — a fact the sentinel made
# unreachable from the alert body.
#
# `-f` is GONE, so curl reports the real status instead of exiting 22, and the two facts curl
# knows — its exit status and the HTTP status — are now carried SEPARATELY and BOTH reported.
# There is no fallback assignment: curl's own `%{http_code}` already prints `000` when no
# response arrived, and that is curl's measurement, not our sentinel overwriting one.
#
# The vocabulary is CLOSED and TOTAL — `curl_<n>` catches every code not named above it, so an
# outcome can never map to nothing. Each member maps to exactly ONE operator remedy:
#   http_<code>  status != 200          -> per status: 403 transport/auth, 404 path
#   dns          curl 6                 -> resolver
#   connect      curl 7                 -> egress / firewall  ** OPERATOR ONLY, never automated **
#   timeout      curl 28                -> budget or link
#   tls          curl 35/60             -> cert store
#   curl_<n>     any other non-zero     -> keep the NUMBER; never fold it into a bucket
#   empty_body   200 with a zero-length body -> upstream truncation
# Callers emit the cause AND both raw values, so a future taxonomy gap is VISIBLE rather than
# silently absorbed.
fetch_cause() {   # <http_code> <curl_exit> <body_path> -> cause on stdout; EMPTY means the fetch is good
  case "$2" in
    0)      ;;
    6)      echo "dns";        return 0 ;;
    7)      echo "connect";    return 0 ;;
    28)     echo "timeout";    return 0 ;;
    35|60)  echo "tls";        return 0 ;;
    *)      echo "curl_$2";    return 0 ;;
  esac
  [ "$1" = "200" ]  || { echo "http_$1";   return 0; }
  [ -s "$3" ]       || { echo "empty_body"; return 0; }
  echo ""
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

# ── A SYNC THAT CANNOT RUN IS OPERATIONALLY IDENTICAL TO ONE THAT FAILED ─────────────────────
# (OPS-MONITORING-INVENTORY-RESTORE-W1 R3.) This script was fail-closed PER ROW — every non-200,
# parse failure, key/floor refusal, size collapse and post-swap mismatch alerts — but NOT per
# PROCESS: every precondition below exited INDETERMINATE 3 without ever calling alert(), so the
# sync could be completely dead and nothing would page. Only the row-level half was audible.
#
# The exit code is unchanged (3, the token-law default) and so is the token; what changes is that
# the verdict is now DELIVERED. Severity, cooldown, DRY_RUN and fail-open stay owned by
# send_telegram.sh — CLAUDE.md forbids a consumer re-implementing them, and alert() already
# routes through the wrapper.
die_indeterminate() {   # <one-line reason> [detail…]
  echo "  ✗ $1"
  alert "The sync could not run at all: $1

Nothing was fetched and nothing was written, so every declaration on this host is now as stale as
its last successful run. The checks that read them keep running against that stale copy.

${2:-}"
  verdict INDETERMINATE 3
}

# ── --self-test: hermetic. No network, no /opt, no TG. Vacuity-guarded ──────
self_test() {
  IN_SELF_TEST=1
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
  # HOST_LABELS is set EXPLICITLY here rather than inherited. declares_yaml() is scope-aware, so
  # its answer is a function of identity — and until OPS-DECLARATION-SYNC-HOST-IDENTITY-W1 this
  # check silently rode the peer-host default, which meant it passed on any machine for the wrong
  # reason. It asserts a property of the host that OWNS the YAML rows, so it must say so.
  ( HOST_LABELS=signal-1; declares_yaml ); ck 'declares_yaml() sees the YAML rows (signal-1)' "$?" 0
  ( HOST_LABELS=aoe-1;    declares_yaml ); ck 'declares_yaml() sees none for aoe-1'           "$?" 1

  size_sane 100 100 >/dev/null 2>&1; ck 'same size is sane'                "$?" 0
  size_sane  60 100 >/dev/null 2>&1; ck 'a 40% shrink is sane'             "$?" 0
  size_sane  40 100 >/dev/null 2>&1; ck 'a >50% collapse is REFUSED'       "$?" 1
  size_sane 100   0 >/dev/null 2>&1; ck 'no prior file cannot be a shrink' "$?" 0

  # ── fetch_cause(): ONE CASE PER MEMBER OF THE CLOSED TAXONOMY (CH1c) ──────────────────────
  # The sentinel this wave retired collapsed six causes with six different remedies into one
  # string. These cases pin every member to exactly one outcome, so a later edit cannot quietly
  # re-merge two remedies — above all `connect` (operator-only, a firewall is never automated)
  # with `http_403` (a transport/auth change), which are one command apart and were previously
  # indistinguishable. Driven entirely through the pure function: no network is touched.
  ck 'curl 6  -> dns'            "$(fetch_cause 000 6  "$tmp/good.json")"  'dns'
  ck 'curl 7  -> connect'        "$(fetch_cause 000 7  "$tmp/good.json")"  'connect'
  ck 'curl 28 -> timeout'        "$(fetch_cause 000 28 "$tmp/good.json")"  'timeout'
  ck 'curl 35 -> tls'            "$(fetch_cause 000 35 "$tmp/good.json")"  'tls'
  ck 'curl 60 -> tls'            "$(fetch_cause 000 60 "$tmp/good.json")"  'tls'
  # An unmapped code keeps its NUMBER. Folding it into a bucket would recreate the sentinel in
  # miniature — and 22 is exactly the code `-f` used to produce, so it must stay legible.
  ck 'curl 22 -> curl_22'        "$(fetch_cause 403 22 "$tmp/good.json")"  'curl_22'
  ck 'curl 99 -> curl_99'        "$(fetch_cause 000 99 "$tmp/good.json")"  'curl_99'
  # exit 0 + non-200: the half `-f` destroyed. These three have three DIFFERENT remedies.
  ck 'http 403 survives'         "$(fetch_cause 403 0  "$tmp/good.json")"  'http_403'
  ck 'http 404 survives'         "$(fetch_cause 404 0  "$tmp/good.json")"  'http_404'
  ck 'http 500 survives'         "$(fetch_cause 500 0  "$tmp/good.json")"  'http_500'
  ck '200 + zero-length body'    "$(fetch_cause 200 0  "$tmp/empty.json")" 'empty_body'
  # The ONLY outcome that may return empty — the success path.
  ck '200 + real body -> GOOD'   "$(fetch_cause 200 0  "$tmp/good.json")"  ''

  # VACUITY GUARD for the taxonomy itself. Two ways this suite could assert nothing: an empty
  # case table, or a mapping that returns "" for a FAILURE — which would send the row down the
  # SUCCESS path and sync an unfetched file. That is strictly worse than the sentinel it
  # replaced, so it is asserted rather than assumed.
  local fc_cases='000|6 000|7 000|28 000|35 000|60 000|99 403|22 403|0 404|0 500|0 000|0'
  local fc_n=0 fc_c fc_http fc_exit
  for fc_c in $fc_cases; do
    fc_http=${fc_c%|*}; fc_exit=${fc_c#*|}
    fc_n=$((fc_n+1)); checks=$((checks+1))
    if [ -z "$(fetch_cause "$fc_http" "$fc_exit" "$tmp/good.json")" ]; then
      echo "  ✗ fetch outcome http=$fc_http curl=$fc_exit maps to NO cause — it would take the success path"
      fails=$((fails+1))
    fi
  done
  checks=$((checks+1))
  if [ "$fc_n" -eq 0 ]; then
    echo "  ✗ the fetch-cause case table is EMPTY — this suite would assert nothing"; fails=$((fails+1))
  fi

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
  # The label pair below is deliberately OPAQUE and synthetic: this case asserts only that a `*`
  # scope applies to a multi-label host, so WHICH labels appear is incidental, and a real host's
  # identity written here would be a peer literal that a future author could mistake for a
  # default (OPS-DECLARATION-SYNC-HOST-IDENTITY-W1).
  ( HOST_LABELS=host-alpha,host-beta
    scope_applies '*'              ) >/dev/null 2>&1; ck 'scope * applies anywhere'          "$?" 0
  # The trap that makes the identity precondition mandatory, pinned so it cannot be "simplified"
  # into a rows-in-scope check: `*` never reads $HOST_LABELS, so it applies even to a host with
  # NO identity at all. An unresolved host therefore still has five declarations in scope.
  ( HOST_LABELS=; scope_applies '*' ) >/dev/null 2>&1; ck 'scope * applies even with NO identity' "$?" 0
  ( HOST_LABELS=signal-1; scope_applies 'signal-1' ) >/dev/null 2>&1; ck 'own label applies'  "$?" 0
  ( HOST_LABELS=aoe-1;    scope_applies 'signal-1' ) >/dev/null 2>&1; ck 'other label REFUSED' "$?" 1
  ( HOST_LABELS=aoe-1;    scope_applies 'signal-1,aoe-1' ) >/dev/null 2>&1; ck 'list matches'  "$?" 0
  ( HOST_LABELS=aoe-1;    scope_applies '' ) >/dev/null 2>&1; ck 'empty scope applies nowhere' "$?" 1
  # resolve_host_labels(): the OTHER seam this suite would otherwise be blind to, and the one
  # whose old default put five foreign files on aoe-1. Assert the ORDER, not just the outcome.
  local idf="$tmp/host-label"
  printf 'marker-label\n' > "$idf"
  ck 'env WINS over the marker'            "$(resolve_host_labels 'env-label' "$idf")" 'env-label'
  ck 'marker used when env is unset'       "$(resolve_host_labels '' "$idf")"          'marker-label'
  ck 'marker whitespace is stripped'       "$(printf 'spaced\n\n' > "$idf"; resolve_host_labels '' "$idf")" 'spaced'
  ck 'MISSING marker -> UNRESOLVED (empty)' "$(resolve_host_labels '' "$tmp/does-not-exist")" ''
  ck 'EMPTY marker   -> UNRESOLVED (empty)' "$(: > "$idf"; resolve_host_labels '' "$idf")"     ''
  # The whole point of the wave: with neither source, the answer is NOTHING — never a peer host.
  ck 'no env + no marker -> UNRESOLVED'    "$(resolve_host_labels '' '')"              ''

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
  echo "✓ declaration-sync self-test: $checks checks passed (validator refusals both ways, size-collapse guard, declared-set well-formedness, fetch-cause taxonomy both ways)"
  verdict UNCHANGED 0
}

[ "${1:-}" = "--self-test" ] && self_test

# ── sync ────────────────────────────────────────────────────────────────────
# BEFORE any conditional work, and before the preconditions that can end the run: the heartbeat
# records that this host ATTEMPTED, which is the only thing that distinguishes a dead cron from a
# wedged run. Stamping it after the preconditions would make an INDETERMINATE exit look exactly
# like a cron that never fired.
stamp_attempt
log_line "START declaration-sync labels=$HOST_LABELS declared=${#DECLARATIONS[@]} base=$BASE_URL"

# THE FIRST PRECONDITION, because identity decides what every later step DOES. It runs after the
# START record on purpose: an unresolved run must still leave `labels=` empty in the log, which is
# the forensic line that identified the 2026-08-13 incident in the first place.
#
# This tests the IDENTITY, not how many rows are in scope, and the distinction is load-bearing:
# scope_applies() returns 0 for a `*` scope WITHOUT EVER READING $HOST_LABELS, so an unresolved
# host still has five `*`-scoped declarations "in scope" and a rows-in-scope check would sail
# straight past it while writing files. Only an explicit emptiness test can catch this.
[ -n "$HOST_LABELS" ] || die_indeterminate \
  "this host has no identity — MONITORING_HOST_LABELS is unset and $HOST_IDENTITY_FILE is missing, unreadable or empty" \
  "Nothing was written, deliberately. Without an identity this script cannot tell its own
declarations from another host's, and guessing is what put five foreign files on aoe-1 on
2026-08-13 (OPS-DECLARATION-SYNC-HOST-IDENTITY-W1).

Fix EITHER by restoring the host's marker:
  printf '<this-host-label>\\n' > $HOST_IDENTITY_FILE
or, for a one-off run, by naming the host explicitly:
  MONITORING_HOST_LABELS=<this-host-label> $0"

command -v curl   >/dev/null 2>&1 || die_indeterminate "curl is not installed — no declaration can be fetched"
command -v python3 >/dev/null 2>&1 || die_indeterminate "python3 is not installed — no declaration body can be validated"
# Fail-closed on the YAML parser, and INDETERMINATE rather than FAILED: without it we cannot
# verify those bodies at all, which is "verified nothing", not "found something wrong".
if declares_yaml && ! python3 -c 'import yaml' >/dev/null 2>&1; then
  die_indeterminate "PyYAML is unavailable but the declared set contains YAML — cannot verify those bodies" \
    "Install it with: apt-get install -y python3-yaml"
fi
[ -d "$DEST_DIR" ] || die_indeterminate "dest dir $DEST_DIR does not exist"

# The 5th silent exit, and the one the dispatching spec's "four preconditions" did not list. It
# is not hypothetical: BSD/GNU mktemp both fail here on a full or read-only /tmp, and without an
# alert a host whose /tmp filled up syncs nothing, forever, at a green-looking exit code.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/declsync.XXXXXX") || die_indeterminate "cannot create a work dir under ${TMPDIR:-/tmp} — check free space and permissions"
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

  # No `-f`, and NO `||` fallback: both facts curl knows are captured separately and neither is
  # discarded. `cx` must be read on the very next line — any command in between overwrites $?.
  code=$(curl -sS -o "$cand" -w '%{http_code}' --max-time 30 "$BASE_URL/$name" 2>/dev/null)
  cx=$?
  cause=$(fetch_cause "$code" "$cx" "$cand")
  if [ -n "$cause" ]; then
    echo "  ✗ FAILED   $name — fetch $cause (http=$code curl=$cx) (kept the working file)"
    fail_detail="${fail_detail}${name}: fetch ${cause} (http=${code} curl=${cx})"$'\n'; failed=$((failed+1)); continue
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
    record_resolved "$name" "$new_h"
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
  record_resolved "$name" "$new_h"
  changed=$((changed+1))
done

echo "  summary: ${changed} synced · ${unchanged} unchanged · ${failed} failed"

if [ "$failed" -gt 0 ]; then
  # The wrapper OWNS cooldown + severity gating (CLAUDE.md: consumers must not re-implement them).
  # THE DENOMINATOR IS THE IN-SCOPE COUNT, NOT THE ARRAY LENGTH (CH1b). `$failed` only ever counts
  # rows this host actually attempted, so dividing it by ${#DECLARATIONS[@]} understates the blast
  # radius wherever the declared set is host-scoped. Measured 2026-08-17: aoe-1 has 5 of 10 rows in
  # scope, so a TOTAL outage there paged as "5 of 10" — reading as half-broken — while signal-1's
  # genuinely-10-of-10 outage paged identically. An alert that understates its own blast radius is
  # the same defect class as one that collapses its cause.
  in_scope=$((failed + unchanged + changed))
  alert "$failed of $in_scope in-scope declaration(s) could not be synced ($skipped skipped: scoped to another host). The working files were KEPT, so checks still run — against a possibly stale declaration.

$fail_detail"
  verdict FAILED 1
fi
[ "$changed" -gt 0 ] && verdict SYNCED 0
verdict UNCHANGED 0
