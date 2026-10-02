#!/usr/bin/env bash
# monitoring-results-sync.sh — OPS-SCORER-CAPTURE-DAY3-HEALTH-READOUT-W1 R6.
#
# The two-way half of CLAUDE.md execution-flow step 6.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
# Step 6 already PUSHES `status.md` to signal-1. Nothing ever came back. So a canary that
# publishes its result on host stdout — which is every canary on this box — was readable only by
# someone holding an SSH key, and the scheduled `OPS-SCORER-INPUT-PERSISTENCE-W1` day-3 health
# check could not execute a single probe from Cowork. The fix is not a new HTTP surface (the
# scorer store's own firewall exists to refuse exactly that); it is to make the EXISTING sync
# bidirectional.
#
#   push   status.md            ->  root@<host>:/var/lib/algovault-monitoring/status.md
#          wave-history.md      ->  root@<host>:/var/lib/algovault-monitoring/wave-history.md
#          to EVERY host in the `wave-history` inventory row's installed_at[] (OPS-HOST-KERNEL-
#          REBOOT-W5 CH2 — see "THE WAVE-HISTORY PUSH" below)
#   pull   canary-results.jsonl ->  <vault>/Claude files/canary-results.jsonl   (UNION-MERGED)
#          from EVERY host in MONITORING_SYNC_PULL_LABELS (default: signal-1 aoe-1), each resolved
#          through the host SoT scripts/data/boot-critical-units.json — never a second literal.
#          OPS-BDIR-V3-PANEL-READINESS-W1 CH3 added aoe-1: its weekly B-DIR panel-readiness line
#          would otherwise be host stdout again, unreadable without an SSH key.
#   mirror repo audits/*preregistration*.md -> <vault>/Claude files/repo-preregistrations/
#
# ── WHY THE THIRD LEG LIVES HERE AND NOT IN A SCRIPT OF ITS OWN ─────────────────────────────
# OPS-PREREG-VAULT-MIRROR-W1. Pre-registrations are committed to the REPO, so the PLANNING
# agent — whose mount is the vault only — cannot read the commitments it must plan against.
# That is this file's own defect class in the opposite direction, and it made
# `EDGE-HOLD-DISCIPLINE-W1` undispatchable (audits/EDGE-HOLD-DISCIPLINE-readiness-2026-09-09.md
# §2, blocker A).
#
# It rides THIS script rather than arriving as a fourth thing somebody has to remember, because
# this one already runs at step 6 of EVERY wave. A new script that must be remembered will rot;
# a step that already runs will not. The leg itself is a SEPARATE executable
# (`ops/scripts/prereg-vault-mirror.sh`) so that each script emits exactly ONE verdict token —
# this file keeps `MONITORING_RESULTS_SYNC_VERDICT`, the mirror keeps `PREREG_MIRROR_VERDICT`,
# and neither has to speak for the other.
#
# ── THE PULL MERGES; IT NEVER OVERWRITES, AND THAT IS A PAIRED CONTRACT ─────────────────────
# `ops/monitoring/canary_result_log.py` caps the host file at MAX_LINES and DISCARDS the oldest
# rows past it. That cap is only safe because this side unions rather than copies. A plain `scp`
# down would silently delete vault history the moment the host rolled — so the merge and that cap
# are a pair, and neither may be changed without the other.
#
# Dedupe is on the FULL LINE, never on `(canary, at)` alone: two records sharing an instant are
# two real observations (a scheduled run and an operator's on-demand run in the same second), and
# collapsing them would be the row-dedupe defect that once deleted 8.4M legitimate rows elsewhere
# in this estate. Only byte-identical records — the same record pulled twice — are collapsed.
#
# ── VERDICT ─────────────────────────────────────────────────────────────────────────────────
# Exactly one terminal `MONITORING_RESULTS_SYNC_VERDICT=PASS|FAIL|INDETERMINATE`.
# Exit 0 = PASS · 1 = FAIL · 3 = INDETERMINATE (the token-law default for a NEW gate).
#
# INDETERMINATE covers "could not reach the host" and "could not parse what came back". Callers
# gate on the TOKEN, never the bare code. No caller gates on this today — step 6 is invoked by a
# Code session, and an unreachable host must never block a wave — so `--fail-open` downgrades the
# CODE to 0 while leaving the token telling the truth. That is the same lever shape as
# `ALGOVAULT_TEST_GATE=warn`: one convention, not a second dialect.
#
# Usage:
#   monitoring-results-sync.sh                 # push status.md, pull the results log, mirror preregs
#   monitoring-results-sync.sh push
#   monitoring-results-sync.sh pull
#   monitoring-results-sync.sh mirror
#   monitoring-results-sync.sh --self-test     # hermetic: no ssh, no scp, no host
#   monitoring-results-sync.sh --show-config
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

# SELF-PATH, RESOLVED ONCE AND ABSOLUTE. The load-time refusal can only be reached through a
# REAL invocation, so the self-test re-executes this file — and `"${BASH_SOURCE[0]}"` is
# whatever string the caller typed. MEASURED 2026-09-10 on origin/main: run as
# `bash monitoring-results-sync.sh` from ops/scripts, that re-invocation is a bare name, hits
# `command not found`, and the two refusal assertions fail — a suite green from one directory
# and red from another, which also makes any mutation proof run there VACUOUS. `$HERE` is
# already absolute, so the fix is to project the self-path from it and never from argv.
SELF="$HERE/$(basename "${BASH_SOURCE[0]}")"

# The vault root is PROJECTED from the one declared vault path, never restated. A second absolute
# string is a duplicated fact, and after a vault move the two would disagree about which file —
# the dark-guard class `scripts/lib/system-map-path.sh` was extracted to retire.
#
# AND IT REFUSES RATHER THAN DEGRADING. Measured while proving this script's self-test can fail:
# under `set -uo pipefail` (no `-e`), a missing lib makes `$(dirname "$ALGOVAULT_SYSTEM_MAP_PATH")`
# abort only the SUBSHELL, so VAULT_ROOT came back EMPTY and the script carried on — ready to scp
# to `/status.md` and merge into `/Claude files/…`. An empty path is not a degraded path, it is a
# different path, and this tool moves files.
MAP_PATH_LIB="$REPO/scripts/lib/system-map-path.sh"
if [ ! -r "$MAP_PATH_LIB" ]; then
  echo "  vault path SoT unreadable: $MAP_PATH_LIB" >&2
  echo "MONITORING_RESULTS_SYNC_VERDICT=INDETERMINATE"; exit 3
fi
# shellcheck source=/dev/null
. "$MAP_PATH_LIB"
if [ -z "${ALGOVAULT_SYSTEM_MAP_PATH:-}" ]; then
  echo "  vault path SoT defined no path" >&2
  echo "MONITORING_RESULTS_SYNC_VERDICT=INDETERMINATE"; exit 3
fi
VAULT_ROOT="$(dirname "$ALGOVAULT_SYSTEM_MAP_PATH")"
if [ -z "$VAULT_ROOT" ] || [ ! -d "$VAULT_ROOT" ]; then
  echo "  vault root does not resolve to a directory: [$VAULT_ROOT]" >&2
  echo "MONITORING_RESULTS_SYNC_VERDICT=INDETERMINATE"; exit 3
fi

HOST=${MONITORING_SYNC_HOST:-root@204.168.185.24}
SSH_KEY=${MONITORING_SYNC_SSH_KEY:-$HOME/.ssh/algovault_deploy}
SSH_OPTS=${MONITORING_SYNC_SSH_OPTS:--o StrictHostKeyChecking=no -o ConnectTimeout=15}
REMOTE_DIR=${MONITORING_SYNC_REMOTE_DIR:-/var/lib/algovault-monitoring}
REMOTE_RESULTS="$REMOTE_DIR/canary-results.jsonl"
REMOTE_STATUS="$REMOTE_DIR/status.md"
LOCAL_STATUS=${MONITORING_SYNC_STATUS:-$VAULT_ROOT/status.md}
# `Claude files/` is the lazy-load quarantine zone: nothing there is auto-read at session start,
# which is where an append-only ops record belongs.
LOCAL_RESULTS=${MONITORING_SYNC_RESULTS:-$VAULT_ROOT/Claude files/canary-results.jsonl}
# Every host whose results file is PULLED (push stays signal-1 only). A label, never an address:
# addresses are resolved from the ONE host SoT, so a host move is one edit, not a hunt.
PULL_LABELS=${MONITORING_SYNC_PULL_LABELS:-signal-1 aoe-1}
HOSTS_SOT=${MONITORING_SYNC_HOSTS_SOT:-$REPO/scripts/data/boot-critical-units.json}
SCP=${MONITORING_SYNC_SCP:-scp}  # the seam the self-test replaces to drive the real push + pull paths
SSH=${MONITORING_SYNC_SSH:-ssh}  # the seam for the wave-history push's remote count + atomic rename
REMOTE_WAVE_HISTORY="$REMOTE_DIR/wave-history.md"
WAVE_HISTORY_BUILDER=${MONITORING_SYNC_WAVE_HISTORY_BUILDER:-$REPO/ops/scripts/wave-history-build.sh}
INVENTORY=${MONITORING_SYNC_INVENTORY:-$REPO/ops/monitoring/monitoring-inventory.json}
# The operator lever for a DELIBERATE shrink (an archive heading legitimately deleted). Loud, never
# the default — see the floor in do_push_wave_history.
ALLOW_SHRINK=${MONITORING_SYNC_WAVE_HISTORY_ALLOW_SHRINK:-0}

VERDICT=PASS
NOTES=()

note() { NOTES+=("$1"); }
downgrade() { # never upgrade: INDETERMINATE outranks FAIL outranks PASS
  case "$1:$VERDICT" in
    INDETERMINATE:*) VERDICT=INDETERMINATE ;;
    FAIL:PASS)       VERDICT=FAIL ;;
  esac
}

# ── THE BYPASSED ARTIFACT ───────────────────────────────────────────────────────────────────
# ssh/scp is the seam a hermetic self-test replaces, which makes THIS the only code no scenario
# would otherwise execute — and it is the code that decides what the vault keeps. So it is a pure
# file->file function and the self-test drives it directly, with real fixtures.
#
# Written in python3 rather than sort/uniq: `sort -u` on JSON is a byte sort that would order
# records by their first differing character, and BSD vs GNU `sort` disagree about locale
# collation. The merge must be deterministic on the operator's Mac and on any host.
merge_jsonl() { # <existing-or-missing> <incoming> <out>
  python3 - "$1" "$2" "$3" <<'PY'
import json, os, sys
existing, incoming, out = sys.argv[1], sys.argv[2], sys.argv[3]

def read(p):
    if not p or not os.path.exists(p):
        return []
    with open(p, encoding="utf-8") as fh:
        return [l for l in (x.rstrip("\n") for x in fh) if l.strip()]

seen, kept, unparseable = set(), [], []
for line in read(existing) + read(incoming):
    if line in seen:            # byte-identical record pulled twice
        continue
    seen.add(line)
    try:
        rec = json.loads(line)
        kept.append(((str(rec.get("at", "")), str(rec.get("canary", ""))), line))
    except Exception:
        # NEVER dropped. A line we cannot parse is preserved and REPORTED — silently discarding
        # it would make a writer bug indistinguishable from a quiet period.
        unparseable.append(line)

kept.sort(key=lambda t: t[0])
body = [l for _, l in kept] + unparseable
os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
tmp = out + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    fh.write("\n".join(body) + ("\n" if body else ""))
os.replace(tmp, out)
print(f"merged={len(body)} unparseable={len(unparseable)}")
PY
}

do_push() {
  do_push_status
  do_push_wave_history
}

# The original leg, unchanged in behaviour (only `scp` became the "$SCP" seam). It names status.md
# and NOTHING else — which is what makes a STALE producer safe: a session running a copy of this
# script from before OPS-HOST-KERNEL-REBOOT-W5 runs only this, so it can refresh status.md but can
# never truncate, replace or delete wave-history.md. The corpus can LAG; it cannot REGRESS.
# (Measured 2026-10-02: the primary checkout sat 299 commits behind origin/main, so a stale producer
# is the normal case, not an edge case.) The self-test asserts it.
do_push_status() {
  if [ ! -f "$LOCAL_STATUS" ]; then
    note "push: SKIPPED — no status.md at $LOCAL_STATUS"; downgrade INDETERMINATE; return
  fi
  if "$SCP" -i "$SSH_KEY" $SSH_OPTS "$LOCAL_STATUS" "$HOST:$REMOTE_STATUS" >/dev/null 2>&1; then
    note "push: status.md -> $HOST:$REMOTE_STATUS ($(wc -c <"$LOCAL_STATUS" | tr -d ' ') bytes)"
  else
    note "push: FAILED — host unreachable or scp refused"; downgrade INDETERMINATE
  fi
}

# ── THE WAVE-HISTORY PUSH (OPS-HOST-KERNEL-REBOOT-W5 CH2) ───────────────────────────────────
# Trim policy v3 empties status.md of every CLOSED wave, so a host consumer answering "what has
# already shipped" from it alone was blind by design (1 of 108 templated classes resolved). The
# builder derives the headings-only corpus ONCE from the whole ledger; this leg ships it.
#   * TARGETS are the `wave-history` inventory row's installed_at[] — ONE SoT for "who consumes it",
#     never a second list here — each label resolved through the host SoT exactly like the pull.
#   * A builder that does not print PASS pushes NOTHING (a truncated corpus must never replace a
#     good one) and downgrades this script's ONE token to INDETERMINATE.
#   * ATOMIC: scp to `<path>.tmp`, then chmod 0644 + `mv -f` in ONE remote command, so a reader sees
#     the old file or the new one, never half of one. 0644: every consumer runs as root today, but
#     the wrapper is also reachable from non-root units, and reading is all any of them does.
#   * MONOTONIC FLOOR: a corpus with FEWER headings than the host already holds is refused per host
#     (INDETERMINATE) — the corpus is append-only history, so a shrink means a source went missing.
#     MONITORING_SYNC_WAVE_HISTORY_ALLOW_SHRINK=1 is the loud operator lever for a deliberate one.
wave_history_targets() { # one label per line from the inventory row; nothing if absent/unreadable
  python3 - "$INVENTORY" <<'PY' 2>/dev/null
import json, sys
try:
    rows = json.load(open(sys.argv[1], encoding="utf-8")).get("artifacts", [])
except Exception:  # noqa: BLE001 — unreadable inventory: no targets, and the caller says so
    raise SystemExit(0)
row = next((r for r in rows if r.get("id") == "wave-history"), None)
for e in (row or {}).get("installed_at") or []:
    if isinstance(e, dict) and e.get("host"):
        print(e["host"])
PY
}

do_push_wave_history() {
  local tmp out tok n labels label host remote_n
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/mrsync-wh.XXXXXX")" || {
    note "wave-history: FAILED — mktemp"; downgrade INDETERMINATE; return; }
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  if [ ! -r "$WAVE_HISTORY_BUILDER" ]; then
    note "wave-history: SKIPPED — builder $WAVE_HISTORY_BUILDER not present in this worktree; NOTHING pushed"
    downgrade INDETERMINATE; return
  fi
  out="$(bash "$WAVE_HISTORY_BUILDER" --out "$tmp/wave-history.md" 2>&1)"
  tok="$(printf '%s\n' "$out" | grep -o 'WAVE_HISTORY_VERDICT=[A-Z]*' | tail -1)"
  if [ "$tok" != "WAVE_HISTORY_VERDICT=PASS" ] || [ ! -s "$tmp/wave-history.md" ]; then
    printf '%s\n' "$out" | sed -n 's/^  /  wave-history builder: /p'
    note "wave-history: builder said ${tok:-<no verdict token>} — NOTHING pushed (a truncated corpus must never replace a good one)"
    downgrade INDETERMINATE; return
  fi
  n=$(grep -c '^### ' "$tmp/wave-history.md")
  labels="$(wave_history_targets)"
  if [ -z "$labels" ]; then
    note "wave-history: FAILED — no \`wave-history\` row with installed_at hosts in $INVENTORY; NOTHING pushed"
    downgrade INDETERMINATE; return
  fi
  for label in $labels; do
    host="$(resolve_pull_host "$label")"
    if [ -z "$host" ]; then
      note "wave-history[$label]: FAILED — no address for label '$label' in $HOSTS_SOT"; downgrade INDETERMINATE; continue
    fi
    if ! remote_n="$("$SSH" -i "$SSH_KEY" $SSH_OPTS "$host" \
          "if [ -r '$REMOTE_WAVE_HISTORY' ]; then grep -c '^### ' '$REMOTE_WAVE_HISTORY' || true; else echo 0; fi" 2>/dev/null)"; then
      note "wave-history[$label]: FAILED — host unreachable"; downgrade INDETERMINATE; continue
    fi
    remote_n="$(printf '%s' "$remote_n" | tr -dc '0-9')"; remote_n="${remote_n:-0}"
    if [ "$n" -lt "$remote_n" ] && [ "$ALLOW_SHRINK" != 1 ]; then
      note "wave-history[$label]: REFUSED — the new corpus has $n heading(s), the host holds $remote_n; history is append-only, so a source likely went missing (MONITORING_SYNC_WAVE_HISTORY_ALLOW_SHRINK=1 for a deliberate shrink)"
      downgrade INDETERMINATE; continue
    fi
    [ "$n" -lt "$remote_n" ] && note "wave-history[$label]: ALLOW_SHRINK=1 — shrinking $remote_n -> $n on operator instruction"
    if "$SCP" -i "$SSH_KEY" $SSH_OPTS "$tmp/wave-history.md" "$host:$REMOTE_WAVE_HISTORY.tmp" >/dev/null 2>&1 \
       && "$SSH" -i "$SSH_KEY" $SSH_OPTS "$host" \
          "chmod 0644 '$REMOTE_WAVE_HISTORY.tmp' && mv -f '$REMOTE_WAVE_HISTORY.tmp' '$REMOTE_WAVE_HISTORY'" >/dev/null 2>&1; then
      note "wave-history[$label]: -> $host:$REMOTE_WAVE_HISTORY  headings ${remote_n}->${n}  ($(wc -c <"$tmp/wave-history.md" | tr -d ' ') bytes, atomic rename)"
    else
      note "wave-history[$label]: FAILED — scp or the remote rename refused"; downgrade INDETERMINATE
    fi
  done
}

# Label -> "root@<address>" through the host SoT (the same file install-monitoring-artifact.sh
# resolves labels from). signal-1 keeps honouring MONITORING_SYNC_HOST, so every existing override
# still works. Prints nothing when the label cannot be resolved — the caller reports that.
resolve_pull_host() { # <label>
  if [ "$1" = signal-1 ]; then echo "$HOST"; return; fi
  python3 - "$HOSTS_SOT" "$1" <<'PY' 2>/dev/null
import json, sys
try:
    entry = json.load(open(sys.argv[1], encoding="utf-8")).get("hosts", {}).get(sys.argv[2])
except Exception:  # noqa: BLE001 — unreadable SoT: resolve nothing, the caller says so
    raise SystemExit(0)
if isinstance(entry, dict) and entry.get("address"):
    print("root@" + entry["address"])
PY
}

do_pull() {
  local label host
  for label in $PULL_LABELS; do
    host="$(resolve_pull_host "$label")"
    if [ -z "$host" ]; then
      note "pull[$label]: FAILED — no address for label '$label' in $HOSTS_SOT"; downgrade INDETERMINATE; continue
    fi
    pull_one "$label" "$host"
  done
}

pull_one() { # <label> <user@host>
  local label="$1" from="$2"
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/mrsync.XXXXXX")" || {
    note "pull[$label]: FAILED — mktemp"; downgrade INDETERMINATE; return; }
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  # `XXXXXX` is TERMINAL in that template and the file name is fixed INSIDE the directory: BSD
  # mktemp does not substitute the placeholder when a suffix follows it, so the suffixed form
  # creates a literal `.XXXXXX.` file on the operator's Mac while working fine on GNU CI.
  local inc="$tmp/incoming.jsonl"
  if ! "$SCP" -i "$SSH_KEY" $SSH_OPTS "$from:$REMOTE_RESULTS" "$inc" >/dev/null 2>&1; then
    note "pull[$label]: FAILED — could not fetch $REMOTE_RESULTS (host unreachable, or no canary has run yet)"
    downgrade INDETERMINATE; return
  fi
  local before after stats
  before=$( [ -f "$LOCAL_RESULTS" ] && wc -l <"$LOCAL_RESULTS" | tr -d ' ' || echo 0 )
  if ! stats="$(merge_jsonl "$LOCAL_RESULTS" "$inc" "$LOCAL_RESULTS")"; then
    note "pull[$label]: FAILED — merge refused the payload"; downgrade FAIL; return
  fi
  after=$(wc -l <"$LOCAL_RESULTS" | tr -d ' ')
  # POSITIVE per-step output. "no new records" and "the pull silently did nothing" must not look
  # the same, so the numbers are printed whether or not anything moved.
  note "pull[$label]: $from:$REMOTE_RESULTS -> $LOCAL_RESULTS  lines ${before}->${after} (+$((after - before)))  $stats"
  case "$stats" in *"unparseable=0"*) : ;; *) note "pull[$label]: WARNING — unparseable lines preserved at end of file"; downgrade FAIL ;; esac
}

PREREG_MIRROR=${MONITORING_SYNC_PREREG_MIRROR:-$REPO/ops/scripts/prereg-vault-mirror.sh}

do_mirror_prereg() {
  # A worktree that predates OPS-PREREG-VAULT-MIRROR-W1 does not carry the sibling. That is a
  # "could not verify", never a failure of the sync and never an abort: step 6 runs at the END
  # of a wave and must not turn a stale checkout into a blocked wave. Same shape as every
  # pre-push block, and it SAYS SO rather than skipping quietly.
  if [ ! -r "$PREREG_MIRROR" ]; then
    note "mirror: SKIPPED — $PREREG_MIRROR not present in this worktree; run: git checkout origin/main -- ops/scripts/prereg-vault-mirror.sh"
    downgrade INDETERMINATE; return
  fi
  local out tok
  out="$(bash "$PREREG_MIRROR" both 2>&1)"
  tok="$(printf '%s\n' "$out" | grep -o 'PREREG_MIRROR_VERDICT=[A-Z]*' | tail -1)"
  # Gate on the TOKEN, never the exit code — the whole point of the token law. A run that died
  # without emitting one is INDETERMINATE, which is the one outcome that law forbids going
  # unreported.
  case "$tok" in
    PREREG_MIRROR_VERDICT=PASS) : ;;
    PREREG_MIRROR_VERDICT=FAIL) downgrade FAIL ;;
    PREREG_MIRROR_VERDICT=*)    downgrade INDETERMINATE ;;
    *) note "mirror: the prereg mirror emitted NO verdict token — treating as INDETERMINATE"
       downgrade INDETERMINATE ;;
  esac
  # POSITIVE per-step output: its own notes are reproduced, so "nothing moved" and "the leg
  # never ran" cannot look the same from this file's output alone.
  printf '%s\n' "$out" | sed -n 's/^  /  prereg /p'
  note "mirror: ${tok:-PREREG_MIRROR_VERDICT=<none>}"
}

self_test() {
  local fails=0 ran=0 tmp
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/mrst.XXXXXX")" || { echo "SELF-TEST: FAIL (mktemp)"; return 1; }
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  t() { ran=$((ran + 1)); if [ "$2" != "$3" ]; then echo "  - $1: expected [$3] got [$2]"; fails=$((fails + 1)); fi; }

  local A="$tmp/a.jsonl" B="$tmp/b.jsonl" O="$tmp/o.jsonl"
  printf '%s\n' '{"at":"2026-01-02T00:00:00Z","canary":"c1","v":1}' \
                '{"at":"2026-01-01T00:00:00Z","canary":"c1","v":2}' > "$A"
  printf '%s\n' '{"at":"2026-01-02T00:00:00Z","canary":"c1","v":1}' \
                '{"at":"2026-01-03T00:00:00Z","canary":"c2","v":3}' > "$B"
  local out; out="$(merge_jsonl "$A" "$B" "$O")"
  t "byte-identical records collapse"        "$out"                    "merged=3 unparseable=0"
  t "output is chronological"                "$(sed -n 1p "$O" | sed 's/.*"at":"\([^"]*\)".*/\1/')" "2026-01-01T00:00:00Z"
  t "the newest record survives"             "$(sed -n 3p "$O" | sed 's/.*"canary":"\([^"]*\)".*/\1/')" "c2"

  # HISTORY IS NEVER LOST: the paired contract with canary_result_log.py's MAX_LINES cap. An
  # incoming file that has ALREADY rolled past the vault's oldest record must not truncate it.
  printf '%s\n' '{"at":"2026-01-09T00:00:00Z","canary":"c1","v":9}' > "$B"
  out="$(merge_jsonl "$O" "$B" "$O")"
  t "a rolled host file does not truncate vault history" "$out" "merged=4 unparseable=0"
  t "the oldest vault record is still first" "$(sed -n 1p "$O" | sed 's/.*"at":"\([^"]*\)".*/\1/')" "2026-01-01T00:00:00Z"

  # Two real observations sharing an instant are BOTH kept — never row-deduped on (canary, at).
  printf '%s\n' '{"at":"2026-01-01T00:00:00Z","canary":"c1","v":99}' > "$B"
  out="$(merge_jsonl "$O" "$B" "$O")"
  t "same-instant DIFFERENT records are both kept" "$out" "merged=5 unparseable=0"

  # An unparseable line is preserved AND reported, never silently dropped.
  printf '%s\n' 'this is not json' > "$B"
  out="$(merge_jsonl "$O" "$B" "$O")"
  t "an unparseable line is preserved and reported" "$out" "merged=6 unparseable=1"
  t "the unparseable line is last"           "$(tail -1 "$O")"          "this is not json"

  # A first-ever pull, with no vault file at all, must create one rather than fail.
  printf '%s\n' '{"at":"2026-02-01T00:00:00Z","canary":"c3","v":1}' > "$B"
  out="$(merge_jsonl "$tmp/does-not-exist.jsonl" "$B" "$tmp/fresh/new.jsonl")"
  t "a first pull creates the vault file"     "$out"                    "merged=1 unparseable=0"
  t "the created file has the record"         "$(wc -l <"$tmp/fresh/new.jsonl" | tr -d ' ')" "1"

  # ── THE PULL LEG, BOTH HOSTS, THROUGH THE REAL CODE PATH ───────────────────────────────────
  # scp is the seam; point it at a stub that serves one fixture per host, and drive the REAL
  # do_pull -> resolve_pull_host -> pull_one -> merge_jsonl chain.
  local sot="$tmp/hosts.json" pst="$tmp/pull-scp.sh" dest="$tmp/pulled.jsonl"
  printf '%s\n' '{"hosts":{"signal-1":{"address":"10.0.0.1"},"aoe-1":{"address":"10.0.0.2"}}}' > "$sot"
  printf '%s\n' '{"at":"2026-03-01T00:00:00Z","host":"signal-1","canary":"s"}' > "$tmp/from-10.0.0.1.jsonl"
  printf '%s\n' '{"at":"2026-03-02T00:00:00Z","host":"aoe-1","canary":"a"}' > "$tmp/from-10.0.0.2.jsonl"
  cat > "$pst" <<STUB
#!/usr/bin/env bash
src=""; for x in "\$@"; do case "\$x" in *@*:*) src="\$x" ;; esac; done
h="\${src#*@}"; h="\${h%%:*}"
[ -f "$tmp/from-\$h.jsonl" ] || exit 1
eval "last=\\\${\$#}"; cp "$tmp/from-\$h.jsonl" "\$last"
STUB
  chmod +x "$pst"
  t "aoe-1 resolves from the host SoT" "$(HOSTS_SOT="$sot" resolve_pull_host aoe-1)" "root@10.0.0.2"
  t "an unknown label resolves to nothing" "$(HOSTS_SOT="$sot" resolve_pull_host no-such-host)" ""
  VERDICT=PASS; NOTES=()
  HOST="root@10.0.0.1" HOSTS_SOT="$sot" SCP="$pst" LOCAL_RESULTS="$dest" PULL_LABELS="signal-1 aoe-1" do_pull
  t "both hosts' records land in ONE vault file" "$(wc -l <"$dest" | tr -d ' ')" "2"
  t "the aoe-1 record is there" "$(grep -c '"host":"aoe-1"' "$dest")" "1"
  t "a two-host pull that fetched both is PASS" "$VERDICT" "PASS"
  VERDICT=PASS; NOTES=()
  HOST="root@10.0.0.1" HOSTS_SOT="$sot" SCP="$pst" LOCAL_RESULTS="$dest" PULL_LABELS="signal-1 ghost" do_pull
  t "an unresolvable label is INDETERMINATE, never a silent skip" "$VERDICT" "INDETERMINATE"
  t "and it names the label" "$(printf '%s\n' "${NOTES[@]}" | grep -c "no address for label 'ghost'")" "1"
  rm -f "$tmp/from-10.0.0.2.jsonl"; VERDICT=PASS; NOTES=()
  HOST="root@10.0.0.1" HOSTS_SOT="$sot" SCP="$pst" LOCAL_RESULTS="$dest" PULL_LABELS="signal-1 aoe-1" do_pull
  t "an unreachable aoe-1 is INDETERMINATE and blocks nothing" "$VERDICT" "INDETERMINATE"
  t "the reachable host was still merged" "$(printf '%s\n' "${NOTES[@]}" | grep -c 'pull\[signal-1\]: root@10.0.0.1')" "1"
  VERDICT=PASS; NOTES=()

  # ── THE WAVE-HISTORY PUSH, THROUGH THE REAL CODE PATH (OPS-HOST-KERNEL-REBOOT-W5 CH2) ──────
  # scp, ssh and the builder are seams; each stub emulates its real counterpart closely enough
  # that do_push / do_push_status / do_push_wave_history run unmodified against a fake remote.
  local R="$tmp/remote" WL="$tmp/wh.log" BLD="$tmp/stub-builder.sh" WSCP="$tmp/wh-scp.sh" WSSH="$tmp/wh-ssh.sh"
  local inv="$tmp/inventory.json" st="$tmp/status.md"
  mkdir -p "$R/10.0.0.1" "$R/10.0.0.2"
  printf '### 2026-10-02 — OPS-OPEN-W1 — ⏳ open\n' > "$st"
  printf '%s\n' '{"artifacts":[{"id":"wave-history","installed_at":[{"host":"signal-1","path":"/var/lib/algovault-monitoring/wave-history.md"},{"host":"aoe-1","path":"/var/lib/algovault-monitoring/wave-history.md"}]}]}' > "$inv"
  cat > "$BLD" <<STUB
#!/usr/bin/env bash
# MODE comes from WH_STUB_MODE: PASS | FAIL | INDETERMINATE | NOTOKEN. FAIL and NOTOKEN still WRITE
# a (truncated) file, so "a FAIL that pushes anyway" has something to push and cannot hide.
o=""; while [ \$# -gt 0 ]; do [ "\$1" = --out ] && o="\$2"; shift; done
case "\${WH_STUB_MODE:-PASS}" in
  PASS) printf '<!-- generated -->\n### a — X-W1 — ✅ GREEN\n### b — X-W2 — ✅ GREEN\n### c — X-W3 — ✅ GREEN\n' > "\$o"; echo WAVE_HISTORY_VERDICT=PASS ;;
  FAIL) printf '### a — X-W1 — ✅ GREEN\n' > "\$o"; echo WAVE_HISTORY_VERDICT=FAIL; exit 1 ;;
  INDETERMINATE) echo WAVE_HISTORY_VERDICT=INDETERMINATE; exit 3 ;;
  NOTOKEN) printf '### a — X-W1 — ✅ GREEN\n' > "\$o"; echo "it died before saying anything" ;;
esac
STUB
  cat > "$WSCP" <<STUB
#!/usr/bin/env bash
# scp [-i key] [-o opt]... <src> <user@host:dst>  — option PAIRS are skipped, the rest are operands.
ops=(); while [ \$# -gt 0 ]; do case "\$1" in -i|-o) shift 2 ;; *) ops+=("\$1"); shift ;; esac; done
src="\${ops[0]}"; dst="\${ops[1]}"; h="\${dst#*@}"; h="\${h%%:*}"; f="\${dst##*/}"
echo "SCP \$src -> \$dst" >> "$WL"
[ -d "$R/\$h" ] || exit 1
cp "\$src" "$R/\$h/\$f"
STUB
  cat > "$WSSH" <<STUB
#!/usr/bin/env bash
eval "cmd=\\\${\$#}"; eval "hostarg=\\\${\$((\$# - 1))}"
h="\${hostarg#*@}"
echo "SSH \$h \$cmd" >> "$WL"
[ -d "$R/\$h" ] || exit 255
case "\$cmd" in
  *"grep -c"*) if [ -f "$R/\$h/count" ]; then cat "$R/\$h/count"; elif [ -f "$R/\$h/wave-history.md" ]; then grep -c '^### ' "$R/\$h/wave-history.md"; else echo 0; fi ;;
  *"mv -f"*)   chmod 0644 "$R/\$h/wave-history.md.tmp" && mv -f "$R/\$h/wave-history.md.tmp" "$R/\$h/wave-history.md" ;;
  *) exit 2 ;;
esac
STUB
  chmod +x "$BLD" "$WSCP" "$WSSH"
  export WH_STUB_MODE
  whrun() { # <stub-mode> [allow_shrink] [builder] — the REAL do_push (both legs) against the fake remote
    WH_STUB_MODE="$1"; VERDICT=PASS; NOTES=(); : > "$WL"
    HOST="root@10.0.0.1" HOSTS_SOT="$sot" SCP="$WSCP" SSH="$WSSH" LOCAL_STATUS="$st" INVENTORY="$inv" \
      ALLOW_SHRINK="${2:-0}" WAVE_HISTORY_BUILDER="${3:-$BLD}" do_push
  }
  whrun PASS
  t "a PASS corpus lands on signal-1"                  "$(WH_STUB_MODE=PASS bash "$BLD" --out "$tmp/expect.md" >/dev/null; cmp -s "$R/10.0.0.1/wave-history.md" "$tmp/expect.md" && echo same || echo differ)" "same"
  t "a PASS corpus lands on aoe-1 (installed_at, not a literal)" "$(grep -c '^### ' "$R/10.0.0.2/wave-history.md" 2>/dev/null)" "3"
  t "status.md still goes to signal-1 only"           "$(grep -c 'SCP .*status.md -> root@10.0.0.1:/var/lib/algovault-monitoring/status.md' "$WL")" "1"
  t "the copy goes to <path>.tmp first"               "$(grep -c 'wave-history.md -> root@10.0.0.[12]:/var/lib/algovault-monitoring/wave-history.md.tmp$' "$WL")" "2"
  t "…then ONE remote chmod 0644 + mv -f per host"    "$(grep -c "chmod 0644 '/var/lib/algovault-monitoring/wave-history.md.tmp' && mv -f" "$WL")" "2"
  t "no .tmp is left on either host"                  "$(ls "$R"/10.0.0.*/ | grep -c '\.tmp$')" "0"
  t "the installed corpus is world-readable (0644)"   "$(ls -l "$R/10.0.0.2/wave-history.md" | cut -c1-10)" "-rw-r--r--"
  t "a full push is PASS"                             "$VERDICT" "PASS"
  t "the note is POSITIVE: headings before->after"    "$(printf '%s\n' "${NOTES[@]}" | grep -c 'headings 0->3')" "2"

  for m in FAIL INDETERMINATE NOTOKEN; do
    rm -f "$R"/10.0.0.*/wave-history.md
    whrun "$m"
    t "a builder $m pushes NOTHING to any host"        "$(grep -c 'wave-history' "$WL")" "0"
    t "…and leaves no file on either host ($m)"        "$(ls "$R"/10.0.0.*/ | grep -c wave-history)" "0"
    t "…and downgrades the ONE token to INDETERMINATE ($m)" "$VERDICT" "INDETERMINATE"
    t "…and SAYS nothing was pushed ($m)"              "$(printf '%s\n' "${NOTES[@]}" | grep -c 'NOTHING pushed')" "1"
    t "…while status.md was still pushed ($m)"         "$(grep -c 'status.md -> ' "$WL")" "1"
  done

  # The monotonic floor: aoe-1 already holds MORE history than this corpus carries.
  rm -f "$R"/10.0.0.*/wave-history.md; printf 'OLD\n' > "$R/10.0.0.2/wave-history.md"; echo 99 > "$R/10.0.0.2/count"
  whrun PASS
  t "a SHRINKING corpus is refused for that host"     "$(cat "$R/10.0.0.2/wave-history.md")" "OLD"
  t "…the other host is still pushed"                 "$(grep -c '^### ' "$R/10.0.0.1/wave-history.md")" "3"
  t "…and the refusal is INDETERMINATE, named"        "$VERDICT:$(printf '%s\n' "${NOTES[@]}" | grep -c 'wave-history\[aoe-1\]: REFUSED')" "INDETERMINATE:1"
  whrun PASS 1
  t "ALLOW_SHRINK=1 is the deliberate, loud override" "$(grep -c '^### ' "$R/10.0.0.2/wave-history.md"):$(printf '%s\n' "${NOTES[@]}" | grep -c 'ALLOW_SHRINK=1')" "3:1"
  rm -f "$R/10.0.0.2/count"

  # Targets are the inventory row, never a list in this file.
  printf '%s\n' '{"artifacts":[{"id":"wave-history","installed_at":[{"host":"aoe-1","path":"/x"}]}]}' > "$inv"
  rm -f "$R"/10.0.0.*/wave-history.md; whrun PASS
  t "a one-host installed_at pushes to that host only" "$(ls "$R"/10.0.0.1/ | grep -c wave-history):$(ls "$R"/10.0.0.2/ | grep -c wave-history)" "0:1"
  printf '%s\n' '{"artifacts":[{"id":"something-else"}]}' > "$inv"
  rm -f "$R"/10.0.0.*/wave-history.md; whrun PASS
  t "no wave-history row: NOTHING pushed, INDETERMINATE" "$(grep -c 'wave-history' "$WL"):$VERDICT" "0:INDETERMINATE"
  printf '%s\n' '{"artifacts":[{"id":"wave-history","installed_at":[{"host":"ghost"}]}]}' > "$inv"
  whrun PASS
  t "an unresolvable installed_at label is INDETERMINATE and named" "$VERDICT:$(printf '%s\n' "${NOTES[@]}" | grep -c "no address for label 'ghost'")" "INDETERMINATE:1"
  whrun PASS 0 "$tmp/no-such-builder.sh"
  t "an absent builder (a worktree predating it) pushes NOTHING" "$(grep -c 'wave-history' "$WL"):$VERDICT" "0:INDETERMINATE"

  # STALE-PRODUCER SAFETY: the pre-W5 leg names status.md and nothing else, so a session running an
  # old copy of this script can refresh status.md but can never touch wave-history.md.
  printf 'KEEP\n' > "$R/10.0.0.1/wave-history.md"; : > "$WL"; VERDICT=PASS; NOTES=()
  HOST="root@10.0.0.1" SCP="$WSCP" LOCAL_STATUS="$st" do_push_status
  t "the status.md leg transfers ONLY status.md"      "$(grep -c '^SCP' "$WL"):$(grep -c 'wave-history' "$WL")" "1:0"
  t "…and leaves an existing wave-history.md untouched" "$(cat "$R/10.0.0.1/wave-history.md")" "KEEP"
  t "the status.md leg makes no ssh call at all"      "$(grep -c '^SSH' "$WL")" "0"
  unset WH_STUB_MODE
  VERDICT=PASS; NOTES=()

  # ── THE MIRROR LEG'S TOKEN MAPPING ────────────────────────────────────────────────────────
  # The leg delegates to a sibling executable, so the INVOCATION is a seam and a hermetic suite
  # is structurally blind to it. Point the seam at a stub that emits a chosen token and drive
  # the real `do_mirror_prereg`, so what gets asserted is the mapping this file actually owns.
  local stub="$tmp/stub-mirror.sh"
  for pair in "PASS:PASS" "FAIL:FAIL" "INDETERMINATE:INDETERMINATE"; do
    printf '#!/usr/bin/env bash\necho "  stub note"\necho "PREREG_MIRROR_VERDICT=%s"\n' "${pair%%:*}" > "$stub"
    chmod +x "$stub"
    VERDICT=PASS
    MONITORING_SYNC_PREREG_MIRROR="$stub" PREREG_MIRROR="$stub" do_mirror_prereg >/dev/null
    t "a mirror ${pair%%:*} maps to sync ${pair##*:}" "$VERDICT" "${pair##*:}"
  done
  # A run that emits NO token is the one outcome the token law forbids going unreported.
  printf '#!/usr/bin/env bash\necho "it died before saying anything"\nexit 0\n' > "$stub"; chmod +x "$stub"
  VERDICT=PASS
  PREREG_MIRROR="$stub" do_mirror_prereg >/dev/null
  t "a mirror emitting NO token is INDETERMINATE" "$VERDICT" "INDETERMINATE"
  # A worktree predating the mirror must degrade, SAY SO, and never abort the sync.
  VERDICT=PASS; NOTES=()
  PREREG_MIRROR="$tmp/does-not-exist.sh" do_mirror_prereg >/dev/null
  t "an absent sibling is INDETERMINATE"  "$VERDICT" "INDETERMINATE"
  t "and it names the remediation"        "$(printf '%s\n' "${NOTES[@]}" | grep -c 'git checkout origin/main')" "1"
  VERDICT=PASS; NOTES=()

  # The verdict ladder never upgrades.
  VERDICT=PASS;          downgrade FAIL;          t "PASS downgrades to FAIL"            "$VERDICT" "FAIL"
  downgrade INDETERMINATE;                        t "FAIL downgrades to INDETERMINATE"   "$VERDICT" "INDETERMINATE"
  downgrade FAIL;                                 t "INDETERMINATE is never downgraded"  "$VERDICT" "INDETERMINATE"
  VERDICT=PASS

  # The vault root is DERIVED, and the derivation REFUSES rather than degrading to "".
  t "vault root resolves to a real directory"      "$([ -d "$VAULT_ROOT" ] && echo yes || echo no)" "yes"
  t "the results path lands in the lazy-load zone"  "$(basename "$(dirname "$LOCAL_RESULTS")")" "Claude files"
  # The declared vault, asserted only when nothing has overridden it — an override is the
  # sanctioned test lever and must not be reported as drift.
  if [ -z "${SYSTEM_MAP_PATH:-}" ]; then
    t "the declared vault is the AlgoVault planning hub" "$(basename "$VAULT_ROOT")" "AlgoVault MCP"
  fi
  # A vault root that does not resolve must REFUSE, never degrade to "" and then move files into
  # it. The refusal lives at LOAD time, so it is driven through a REAL invocation — no in-process
  # assertion can reach code that runs before main. `SYSTEM_MAP_PATH` is the sanctioned override
  # the sibling gates already use, so this needs no fixture surgery.
  #
  # `--show-config`, deliberately, NOT `pull`. First written against `pull` and MEASURED to pass
  # with the guard DELETED: `pull` reaches scp, scp fails, and that failure emits the very same
  # INDETERMINATE token — so the assertion was satisfied by the network rather than by the
  # refusal. Right subject, wrong quantity, and nothing about the green looked anomalous.
  # `--show-config` touches no network, so on a healthy load it CANNOT emit this token, and the
  # token's presence is therefore evidence of the refusal and of nothing else. The reason line is
  # asserted too, so a token from some future third cause still cannot masquerade as this one.
  # CWD-INDEPENDENT, asserted directly. Proving the mutation above only goes red when the
  # suite happens to be invoked by a bare name, and a proof that depends on how it was
  # called is luck. This asserts the property itself.
  # Parameter expansion, NOT `case`: bash 3.2 (which is what /bin/bash is on this Mac) mis-parses
  # a `case` pattern's `)` inside `$( )` and returns the tail of the expression as a STRING.
  # Measured here — the assertion read back " echo yes ;; *) echo no ;; esac)".
  t "the self-path is absolute" "$([ "${SELF#/}" != "$SELF" ] && echo yes || echo no)" "yes"
  local refuse
  refuse="$(SYSTEM_MAP_PATH="$tmp/no-such-vault/system-map.md" "$SELF" --show-config 2>&1)"
  t "an unresolvable vault root REFUSES" \
    "$(printf '%s' "$refuse" | tail -1)" "MONITORING_RESULTS_SYNC_VERDICT=INDETERMINATE"
  t "and it says WHY" \
    "$(printf '%s' "$refuse" | grep -c 'vault root does not resolve')" "1"
  # The healthy control: the same flag on a real vault emits NO verdict token at all, which is
  # what makes the assertion above discriminating rather than merely true.
  t "a healthy load emits no refusal token" \
    "$("$SELF" --show-config 2>&1 | grep -c 'MONITORING_RESULTS_SYNC_VERDICT')" "0"

  # VACUITY floor (OPS-HOST-KERNEL-REBOOT-W5): the suite is constructed HERE, so a run that stops
  # executing scenarios must not report a pass. Set to the actual count; raise it with new cases.
  if [ "$ran" -lt 70 ]; then
    echo "SELF-TEST: INDETERMINATE (only $ran assertions ran, floor 70)"
    echo "MONITORING_RESULTS_SYNC_VERDICT=INDETERMINATE"
    return 3
  fi
  if [ "$fails" -gt 0 ]; then
    echo "SELF-TEST: FAIL ($fails of $ran)"
    echo "MONITORING_RESULTS_SYNC_VERDICT=INDETERMINATE"
    return 3
  fi
  echo "SELF-TEST: PASS ($ran assertions)"
  echo "MONITORING_RESULTS_SYNC_VERDICT=PASS"
  return 0
}

FAIL_OPEN=0
MODE=both
for a in "$@"; do
  case "$a" in
    --self-test)   self_test; exit $? ;;
    --show-config) printf 'HOST=%s\nREMOTE_RESULTS=%s\nLOCAL_STATUS=%s\nLOCAL_RESULTS=%s\nVAULT_ROOT=%s\nPULL_LABELS=%s\n' \
                     "$HOST" "$REMOTE_RESULTS" "$LOCAL_STATUS" "$LOCAL_RESULTS" "$VAULT_ROOT" "$PULL_LABELS"
                   for l in $PULL_LABELS; do printf 'PULL[%s]=%s\n' "$l" "$(resolve_pull_host "$l")"; done; exit 0 ;;
    --fail-open)   FAIL_OPEN=1 ;;
    push|pull|mirror|both) MODE="$a" ;;
    *) echo "unknown argument: $a" >&2; echo "MONITORING_RESULTS_SYNC_VERDICT=INDETERMINATE"; exit 3 ;;
  esac
done

[ "$MODE" = both ] || [ "$MODE" = push ] && do_push
[ "$MODE" = both ] || [ "$MODE" = pull ] && do_pull
[ "$MODE" = both ] || [ "$MODE" = mirror ] && do_mirror_prereg

for n in "${NOTES[@]:-}"; do [ -n "$n" ] && echo "  $n"; done
echo "MONITORING_RESULTS_SYNC_VERDICT=$VERDICT"
case "$VERDICT" in
  PASS) exit 0 ;;
  FAIL) [ "$FAIL_OPEN" = 1 ] && exit 0 || exit 1 ;;
  *)    [ "$FAIL_OPEN" = 1 ] && exit 0 || exit 3 ;;
esac
