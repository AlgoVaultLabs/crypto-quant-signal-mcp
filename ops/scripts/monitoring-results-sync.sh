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
#   pull   canary-results.jsonl ->  <vault>/Claude files/canary-results.jsonl   (UNION-MERGED)
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
  if [ ! -f "$LOCAL_STATUS" ]; then
    note "push: SKIPPED — no status.md at $LOCAL_STATUS"; downgrade INDETERMINATE; return
  fi
  if scp -i "$SSH_KEY" $SSH_OPTS "$LOCAL_STATUS" "$HOST:$REMOTE_STATUS" >/dev/null 2>&1; then
    note "push: status.md -> $HOST:$REMOTE_STATUS ($(wc -c <"$LOCAL_STATUS" | tr -d ' ') bytes)"
  else
    note "push: FAILED — host unreachable or scp refused"; downgrade INDETERMINATE
  fi
}

do_pull() {
  local tmp; tmp="$(mktemp -d "${TMPDIR:-/tmp}/mrsync.XXXXXX")" || {
    note "pull: FAILED — mktemp"; downgrade INDETERMINATE; return; }
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  # `XXXXXX` is TERMINAL in that template and the file name is fixed INSIDE the directory: BSD
  # mktemp does not substitute the placeholder when a suffix follows it, so the suffixed form
  # creates a literal `.XXXXXX.` file on the operator's Mac while working fine on GNU CI.
  local inc="$tmp/incoming.jsonl"
  if ! scp -i "$SSH_KEY" $SSH_OPTS "$HOST:$REMOTE_RESULTS" "$inc" >/dev/null 2>&1; then
    note "pull: FAILED — could not fetch $REMOTE_RESULTS (host unreachable, or no canary has run yet)"
    downgrade INDETERMINATE; return
  fi
  local before after stats
  before=$( [ -f "$LOCAL_RESULTS" ] && wc -l <"$LOCAL_RESULTS" | tr -d ' ' || echo 0 )
  if ! stats="$(merge_jsonl "$LOCAL_RESULTS" "$inc" "$LOCAL_RESULTS")"; then
    note "pull: FAILED — merge refused the payload"; downgrade FAIL; return
  fi
  after=$(wc -l <"$LOCAL_RESULTS" | tr -d ' ')
  # POSITIVE per-step output. "no new records" and "the pull silently did nothing" must not look
  # the same, so the numbers are printed whether or not anything moved.
  note "pull: $REMOTE_RESULTS -> $LOCAL_RESULTS  lines ${before}->${after} (+$((after - before)))  $stats"
  case "$stats" in *"unparseable=0"*) : ;; *) note "pull: WARNING — unparseable lines preserved at end of file"; downgrade FAIL ;; esac
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
    --show-config) printf 'HOST=%s\nREMOTE_RESULTS=%s\nLOCAL_STATUS=%s\nLOCAL_RESULTS=%s\nVAULT_ROOT=%s\n' \
                     "$HOST" "$REMOTE_RESULTS" "$LOCAL_STATUS" "$LOCAL_RESULTS" "$VAULT_ROOT"; exit 0 ;;
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
