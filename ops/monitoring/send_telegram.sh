#!/usr/bin/env bash
# OPS-MONITORING-TELEGRAM-INTEGRATION-W1 + PATCH-A + OPS-MONITORING-RECOMMENDATION-RESOLVER-AND-CANARY-W1 PATCH-B
#   + OPS-ALERT-RECOVERY-NOTICE-W1 CH1 (the alert channel becomes a STATE, not an event stream)
# Reusable Telegram alert wrapper.
# Usage: send_telegram.sh <alert_id> <severity> [body_file|-]     # fire (unchanged)
#        send_telegram.sh --clear <alert_id> [reason]             # FIRING -> CLEAR
#        send_telegram.sh --reconcile [alert_id]                  # adopt on-disk state, emit nothing
#        send_telegram.sh --self-test                             # hermetic
#        send_telegram.sh --acknowledge <alert_id>                # seed the ack from ALERT_KEYS; no POST
#        send_telegram.sh --resolve [-]                           # body on stdin -> resolved body on
#                                                                 # stdout; no state, no log, no network
#   ALERT_KEYS="<k1> <k2> …" opts a call into page-on-change — honoured ONLY for a registry row
#   declaring page_on="change" + page_on_change (see PAGE-ON-CHANGE below). Every other row is
#   byte-identical to before.
#   body via stdin if 3rd arg is "-" or omitted.
#
# ── WHY --clear EXISTS (OPS-ALERT-RECOVERY-NOTICE-W1) ────────────────────────────────────────
# This wrapper could say a thing broke. It had no way to say it stopped. `date +%s > "$MARKER"`
# runs on a delivered fire and NOTHING ever cleared it, so the channel's last message was pinned
# to the worst thing that ever happened, and the 24h cooldown made a self-healed condition go
# quiet — indistinguishable from one still broken inside its cooldown, and from a dead reporter.
# Measured: MONITORING_DECLARATION_SYNC_FAILED fired 2026-08-17 during a published GitHub
# incident, self-healed within the hour, and 70 HOURS LATER the operator was still treating it as
# live and dispatched a wave to investigate a condition that had already fixed itself.
#
# ── AND WHY IT IS SILENT BY DEFAULT ──────────────────────────────────────────────────────────
# CLAUDE.md holds that recovery CHATTER is noise and silent recovery is the default; a prior wave
# retired real alarm-fatigue in webhook-delivery-canary.py by auto-resolving silently, and that
# decision stands. The law was AMENDED (2026-08-21), not overridden: chatter is unbounded
# per-cycle "recovered again" traffic; a RESOLUTION is at most one message per episode, emitted
# only on FIRING -> CLEAR, only when a fire was actually DELIVERED, and it removes the marker so
# it cannot repeat. Announcing is therefore OPT-IN PER ALERT via `announce_resolution` on the
# alert-registry row, and every failure mode of that lookup — absent registry, absent row,
# unreadable file, no python3 — resolves to SILENT. The default lives in DATA and in the code
# path, never in a sentence someone has to read.
#
# ── PAGE-ON-CHANGE (OPS-ALARM-SINGLE-DERIVATION-W1 CH3) — ONE primitive, opt-in per registry row ─
# "A level trigger over a state nothing clears pages forever" was solved BESPOKE three times in ten
# days (payment-decline's ACK_BASELINE, AOE output-liveness tuples, BDIR PASS->FAIL), each inside a
# consumer, while this contract says consumers MUST NOT re-implement its gates. Only this wrapper
# knows whether a page was DELIVERED, so only it can acknowledge correctly. The semantics are
# PORTED from payment-decline-canary.py's ACK_BASELINE, not re-invented:
#   * Opt-in in DATA: the row carries page_on="change" AND page_on_change{review_by, decided_by,
#     decided_at, reason}. Anything missing or malformed, or a call without valid ALERT_KEYS,
#     resolves to LEVEL and logs PAGE_ON_CHANGE_NOT_EARNED (fail toward noise). It holds THROUGH
#     review_by inclusive; from the next UTC day the row pages on the LEVEL and the body says so.
#   * The caller calls on EVERY run: ALERT_KEYS=<entity ids> for a non-empty set, `--clear` for an
#     empty one (removing the marker AND the ack). Keys are entity ids such as dead:ASTER|NVO,
#     never figures that change nightly. Without every-run calls nothing prunes, and a
#     recovered-then-re-broken key would never page again.
#   * Decided AFTER the severity and test-context gates and BEFORE the 24h gate, from
#     $STATE_DIR/<alert_id>.ack.json (temp file + rename). No key outside the ack: prune the ack to
#     the keys still present, log UNCHANGED_SUPPRESSED, exit; the 24h gate is not consulted. Some
#     key outside it: continue, and ONLY a DELIVERED (2xx) page sets ack := keys. A 24h-suppressed,
#     failed or DRY_RUN_TG run leaves the ack alone — an acknowledgment means an operator SAW it.
#   * A missing or malformed ack is UNKNOWN, never "everything is old": it pages and re-seeds.
#   * `--acknowledge <id>` seeds the ack from ALERT_KEYS WITHOUT a POST (ACKNOWLEDGED_BOOTSTRAP) —
#     the one sanctioned way to acknowledge without paging.
#
# CONTRACT (CLAUDE.md ## Automation-first recovery → Operator-action-required alert contract):
#   TG fires ONLY when:
#     (a) severity == CRITICAL_PERSISTENT, AND
#     (b) cooldown elapsed (24h per alert_id), AND
#     (c) DRY_RUN_TG env var is unset/0.
#   All other paths log silently. Fail-open exit 0 on every error path.
#
# PATCH-B (RECRESOLVER-W1): resolve_template() substitutes OPS-<CLASS>-W{NEXT} placeholders
#   in the body by greping /var/lib/algovault-monitoring/status.md ∪ wave-history.md for the
#   highest-completed GREEN W<N> of the class. Runs AFTER body read + AFTER cooldown gate +
#   BEFORE DRY_RUN gate, so DRY_RUN_FIRED + FIRED log lines reflect the RESOLVED body.
#   (Corpus widened to the union by OPS-HOST-KERNEL-REBOOT-W5 — see resolve_template().)

set -euo pipefail

# ── MODE DISPATCH — must precede the positional reads, which are mandatory in alert mode ────
MODE=alert
case "${1:-}" in
  --clear)     MODE=clear;     shift ;;
  --reconcile) MODE=reconcile; shift ;;
  --self-test) MODE=self-test; shift ;;
  --acknowledge) MODE=acknowledge; shift ;;
  --resolve)   MODE=resolve;   shift ;;
esac

case "$MODE" in
  alert)
    ALERT_ID="${1:?alert_id required}"
    SEVERITY="${2:?severity required}"
    BODY_INPUT="${3:--}"
    ;;
  clear)
    ALERT_ID="${1:?alert_id required}"
    CLEAR_REASON="${2:-}"
    ;;
  reconcile) ALERT_ID="${1:-ALL}" ;;
  self-test) ALERT_ID="SELF_TEST" ;;
  acknowledge) ALERT_ID="${1:?alert_id required}" ;;
  resolve)     ALERT_ID="RESOLVE"; BODY_INPUT="${1:--}" ;;
esac

# Every path below is overridable ONLY so the hermetic --self-test can redirect it. All four are
# unset in production, so production resolves to the same literals as before this change.
LOG="${ALERT_WRAPPER_LOG:-/var/log/algovault-monitoring-telegram.log}"
STATE_DIR="${ALERT_WRAPPER_STATE_DIR:-/opt/algovault-monitoring/.alert-state}"
ENV_FILE="${ALERT_WRAPPER_ENV:-/etc/algovault-monitoring/env}"
ALERT_REGISTRY="${ALERT_REGISTRY_PATH:-/opt/algovault-monitoring/alert-registry.json}"
# The POST seam. Stubbed by --self-test so the suite touches no network; the suite ALSO asserts
# the real invocation's flags are intact, because a hermetic test is structurally blind to
# exactly what its own seam replaces.
TG_CURL="${ALERT_WRAPPER_CURL:-curl}"
COOLDOWN_SEC=86400  # 24h per CLAUDE.md operator-action-required contract
# Page-on-change state (OPS-ALARM-SINGLE-DERIVATION-W1 CH3): beside the marker, in the same
# sandboxable STATE_DIR. `--reconcile` never touches it — it globs *-last-fired-at only.
ACK_FILE="$STATE_DIR/${ALERT_ID}.ack.json"
POC_MODE=LEVEL POC_REASON="" POC_REVIEW_BY="" POC_KEYS="" POC_NKEYS=0 POC_ACK_STATE="" POC_ACK_WHY=""
POC_NEW="" POC_NNEW=0 POC_NACKED=0 POC_PRUNED="" POC_NPRUNED=0 POC_PRUNE_CHANGED=0

# fail-open: an unwritable STATE_DIR must not abort under `set -e`. The header has always
# promised fail-open on every error path; before this line it was the one place that did not
# honour it, and a wrapper that dies takes the caller's cron with it. (AC7.)
# `--resolve` is a pure function (stdin -> stdout) and must not even create STATE_DIR.
[[ "$MODE" == resolve ]] || mkdir -p "$STATE_DIR" 2>/dev/null || true

# `|| true` is LOAD-BEARING: under `set -euo pipefail` an unwritable $LOG made the FIRST log()
# call abort the wrapper, so every alert from a non-root caller died silently — the editorial units
# run as User=algovault against a root-owned log. The header promises fail-open on every error path;
# a logging failure must never be able to swallow an operator alert.
# (OPS-AUTOPUB-FULL-REVIEW-FIX-W1 C5. The perms themselves are fixed too, incl. the logrotate
# `create` line that regenerated them weekly — but the code must not depend on that.)
#
# `--resolve` sends its diagnostics to STDERR instead: it is a read-only probe that a sweep may run
# a hundred times, and its RESOLVER_MISS lines must never land in the forensic log beside real fires.
# (Kept on ONE line: both repos' parity tests pin the fail-open `|| true` on the log() definition line.)
log() { if [[ "$MODE" == resolve ]]; then echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ALERT_ID] $*" >&2 || true; else echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [$ALERT_ID] $*" >> "$LOG" 2>/dev/null || true; fi; }

# === PATCH-B: resolve_template() — substitutes OPS-<CLASS>-W{NEXT} via a status.md ∪ wave-history.md grep ===
# Reads STATUS_MD_PATH (default /var/lib/algovault-monitoring/status.md, refreshed per
# CLAUDE.md ## Execution flow step 6 SOP after every wave's status.md append) UNION
# WAVE_HISTORY_PATH (default /var/lib/algovault-monitoring/wave-history.md, the headings-only
# corpus ops/scripts/wave-history-build.sh derives and monitoring-results-sync.sh pushes).
#
# WHY THE UNION (OPS-HOST-KERNEL-REBOOT-W5): since trim policy v3 (2026-08-12) status.md holds
# OPEN waves only — a closed GREEN wave is archived the moment it closes — so this resolver was
# searching for exactly the records the policy removes. MEASURED 2026-10-02 over the 108 templated
# classes in this repo: status.md alone resolved 1; the union resolves 21. The 2026-09-12 and
# 2026-10-02 KERNEL_STALENESS pages both shipped OPS-HOST-KERNEL-REBOOT-W{NEXT} verbatim while
# W1..W4 sat GREEN in the archive. The predicate below is UNCHANGED; only its corpus widened.
#
# Behavior:
#   - Class has GREEN history: substitute W{NEXT} → W<max+1> (MAX-W<N> via grep -oE | sort -n | tail -1)
#   - Class has zero GREEN history: ship the placeholder VERBATIM + log RESOLVER_MISS
#   - neither file readable OR regex extract fails: ship placeholder verbatim + log RESOLVER_MISS
# RESOLVER_MISS reasons: reachable_status_md_path_not_found (NEITHER file readable),
# wave_history_absent (only status.md was read — resolution continues on it, but closed waves are
# invisible), no_completed_waves_for_class, regex_extract_failed, resolved_wave_already_green.
resolve_template() {
  local body="$1"
  local status_path="${STATUS_MD_PATH:-/var/lib/algovault-monitoring/status.md}"
  local history_path="${WAVE_HISTORY_PATH:-/var/lib/algovault-monitoring/wave-history.md}"
  local corpus=()
  [[ -r "$status_path" ]] && corpus+=("$status_path")
  [[ -r "$history_path" ]] && corpus+=("$history_path")
  if [[ ${#corpus[@]} -eq 0 ]]; then
    log "RESOLVER_MISS: template=<not-extracted> reason=reachable_status_md_path_not_found (neither ${status_path} nor ${history_path} is readable)"
    echo "$body"
    return 0
  fi
  local templates
  templates=$(echo "$body" | grep -oE 'OPS-[A-Z0-9-]+-W\{NEXT\}' | sort -u || true)
  if [[ -z "$templates" ]]; then
    echo "$body"
    return 0
  fi
  if [[ ! -r "$history_path" ]]; then
    log "RESOLVER_MISS: template=<corpus> reason=wave_history_absent (${history_path} unreadable; resolving from ${status_path} alone, where trim policy v3 keeps OPEN waves only)"
  fi
  local tpl class highest next
  while IFS= read -r tpl; do
    [[ -z "$tpl" ]] && continue
    class="${tpl%-W\{NEXT\}}"
    # OPS-CLOSEDBAR-LIVENESS-BAND-W1 R4. The prior pattern was
    #   ^### .* — ${class}-W[0-9]+ — .*GREEN
    # which demands " — " IMMEDIATELY AFTER the wave id. CLAUDE.md MANDATES a
    # "(Target ICP tier(s): …)" block in exactly that position, so it could never match a
    # conforming entry. MEASURED 2026-08-07: 96 `OPS-*-W<N>` headings in status.md, ZERO
    # matches — this resolver had NEVER resolved anything for ANY class, so every templated
    # recommended_wave it shipped said "W1", a COMPLETED wave whenever the class had one.
    # A regex that encodes a format its own SoT does not produce is a dark guard.
    # Anchor on the wave id; require GREEN anywhere on the heading (accepting
    # GREEN_WITH_CAVEAT / GREEN_RETROACTIVE_CLOSE, which are completions too).
    highest=$(grep -ohE "^### .*${class}-W[0-9]+.*GREEN" "${corpus[@]}" 2>/dev/null \
              | grep -oE "${class}-W[0-9]+" | grep -oE '[0-9]+$' | sort -n | tail -1 || true)
    if [[ -z "$highest" ]]; then
      # Ship the placeholder VERBATIM — exactly what this file's header has always documented.
      # The prior code asserted W1: a CONFIDENT WRONG ANSWER, strictly worse than an unresolved
      # template, because the operator cannot tell it was a guess.
      log "RESOLVER_MISS: template=${tpl} reason=no_completed_waves_for_class (placeholder shipped verbatim)"
      continue
    fi
    next=$((highest + 1))
    if ! [[ "$next" =~ ^[0-9]+$ ]]; then
      log "RESOLVER_MISS: template=${tpl} reason=regex_extract_failed"
      continue
    fi
    # Never hand the operator a wave that already shipped — re-running a completed wave is not
    # a remedy, and this alert family has now produced that Action line twice.
    if grep -qhE "^### .*${class}-W${next}.*GREEN" "${corpus[@]}" 2>/dev/null; then
      log "RESOLVER_MISS: template=${tpl} reason=resolved_wave_already_green (${class}-W${next}); placeholder shipped verbatim"
      continue
    fi
    body="${body//${tpl}/${class}-W${next}}"
  done <<< "$templates"
  echo "$body"
}

# ── THE TEST-CONTEXT PREDICATE, DERIVED ONCE ────────────────────────────────────────────────
# The trigger SET is unchanged (OPS-AUTOPUB-TEST-ALERT-LEAK-W1); it moved into a function so the
# fire path and the clear path cannot drift apart. Two copies of this condition would be two
# places to update, and the clear path is the one where a miss is WORSE: a test that writes the
# marker silences the next page, but a test that DELETES it erases the episode and makes the next
# genuine fire look fresh. Same predicate, one definition, both consumers project from it.
is_test_context() {
  [[ -n "${NODE_TEST_CONTEXT:-}" || -n "${VITEST:-}" || "${ALGOVAULT_TG_TEST_INERT:-0}" == "1" ]]
}

# ── announce_resolution <alert_id> -> 0 announce / 1 SILENT ─────────────────────────────────
# Opt-in, per alert, expressed in DATA. EVERY failure mode resolves to SILENT: no registry file,
# unreadable registry, malformed JSON, missing row, missing key, no python3. That is deliberate —
# the law's default is silence, so the mechanism that implements the exception must fail toward
# the default rather than away from it.
announce_resolution() {
  [[ -r "$ALERT_REGISTRY" ]] || return 1
  command -v python3 >/dev/null 2>&1 || return 1
  python3 - "$ALERT_REGISTRY" "$1" <<'PY' >/dev/null 2>&1
import json, sys
try:
    rows = json.load(open(sys.argv[1])).get("alerts", [])
    row = next((r for r in rows if r.get("alert_id") == sys.argv[2]), None)
    sys.exit(0 if (row or {}).get("announce_resolution") is True else 1)
except Exception:
    sys.exit(1)
PY
}

# ── page_on_change helper — ONE python program, three subcommands, JSON in, KEY=value lines out ──
# Every value it prints is either from a fixed vocabulary or a key that passed KEY_RE, so the shell
# can read the lines back without quoting hazards. Any crash prints nothing, and nothing resolves to
# LEVEL — the failure mode of this mechanism is noise, never silence.
poc_py() {
  python3 - "$@" <<'PY' 2>/dev/null
import datetime, json, os, re, sys, tempfile
KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:|/@+-]{0,127}$")
DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
MAX_KEYS = 500
FIELDS = ("review_by", "decided_by", "decided_at", "reason")

def norm_keys(raw):
    toks = [t for t in re.split(r"[\s,]+", raw or "") if t]
    if not toks:
        return None, "no keys supplied (ALERT_KEYS empty or unset)"
    bad = sum(1 for t in toks if not KEY_RE.match(t))
    if bad:
        return None, "%d invalid key token(s) in ALERT_KEYS" % bad
    keys = sorted(set(toks))
    if len(keys) > MAX_KEYS:
        return None, "%d keys exceeds the %d-key bound" % (len(keys), MAX_KEYS)
    return keys, None

def parse_date(s):
    if not isinstance(s, str) or not DATE_RE.match(s):
        return None
    try:
        return datetime.date.fromisoformat(s)
    except ValueError:
        return None

def today():
    seam = parse_date(os.environ.get("ALERT_WRAPPER_TODAY", ""))
    return seam or datetime.datetime.now(datetime.timezone.utc).date()

def load_ack(path, aid):
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except FileNotFoundError:
        return None, "absent"
    except Exception:
        return None, "unreadable"
    if not isinstance(doc, dict) or not isinstance(doc.get("keys"), list):
        return None, "malformed"
    if doc.get("alert_id") not in (None, aid):
        return None, "recorded for another alert id"
    keys = [k for k in doc["keys"] if isinstance(k, str) and KEY_RE.match(k)]
    if len(keys) != len(doc["keys"]):
        return None, "holding an invalid key"
    return set(keys), "loaded"

def out(**kv):
    for k, v in kv.items():
        print("%s=%s" % (k, v))

cmd = sys.argv[1] if len(sys.argv) > 1 else ""
if cmd == "norm":
    keys, err = norm_keys(os.environ.get("ALERT_KEYS", ""))
    out(**({"ERR": err} if err else {"KEYS": " ".join(keys), "NKEYS": len(keys)}))
elif cmd == "write":
    path, aid, source, keys = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]
    if not keys or any(not KEY_RE.match(k) for k in keys):
        print("ERR refusing to write an empty or invalid key set"); sys.exit(0)
    try:
        d = os.path.dirname(path) or "."
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".%s." % os.path.basename(path), suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "alert_id": aid, "source": source,
                       "updated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                       "keys": sorted(set(keys))}, fh, indent=1, sort_keys=True)
            fh.write("\n")
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)          # atomic: never a half-written acknowledgement
        print("OK %d key(s)" % len(set(keys)))
    except Exception as e:
        print("ERR %s" % type(e).__name__)
elif cmd == "eval":
    registry, aid, ack_path = sys.argv[2], sys.argv[3], sys.argv[4]
    try:
        with open(registry, encoding="utf-8") as fh:
            rows = json.load(fh).get("alerts", [])
        row = next((r for r in rows if isinstance(r, dict) and r.get("alert_id") == aid), None)
    except Exception:
        row = None
    if row is None or ("page_on" not in row and "page_on_change" not in row):
        out(MODE="LEVEL"); sys.exit(0)     # the legacy path: no opt-in, no log line, byte-identical
    poc = row.get("page_on_change")
    reason = None
    if row.get("page_on") != "change":
        reason = "the row declares page_on_change but page_on is not \"change\""
    elif not isinstance(poc, dict):
        reason = "page_on=change without a page_on_change declaration"
    elif any(not isinstance(poc.get(f), str) or not poc.get(f).strip() for f in FIELDS):
        reason = "page_on_change lacks one of review_by, decided_by, decided_at, reason"
    elif parse_date(poc.get("review_by")) is None:
        reason = "page_on_change.review_by is not a YYYY-MM-DD date"
    keys, kerr = norm_keys(os.environ.get("ALERT_KEYS", ""))
    if reason is None and kerr:
        reason = kerr
    if reason:
        out(MODE="NOT_EARNED", REASON=reason); sys.exit(0)
    review_by = parse_date(poc["review_by"])
    if today() > review_by:                # INCLUSIVE through review_by; LEVEL from the next UTC day
        out(MODE="EXPIRED", REVIEW_BY=review_by.isoformat()); sys.exit(0)
    ack, why = load_ack(ack_path, aid)
    kset = set(keys)
    new = sorted(kset) if ack is None else sorted(kset - ack)
    acked = 0 if ack is None else len(kset & ack)
    pruned = [] if ack is None else sorted(ack & kset)
    changed = 1 if (ack is not None and ack - kset) else 0
    out(MODE="EARNED", REVIEW_BY=review_by.isoformat(), KEYS=" ".join(keys), NKEYS=len(keys),
        ACK_STATE="LOADED" if ack is not None else "UNKNOWN", ACK_WHY=why,
        NEW=" ".join(new), NNEW=len(new), NACKED=acked,
        PRUNED=" ".join(pruned), NPRUNED=len(pruned), PRUNE_CHANGED=changed)
PY
}

# ── poc_eval — the page-on-change decision for $ALERT_ID, into the POC_* globals ───────────────
# Anything it cannot establish leaves LEVEL, the pre-existing behaviour.
poc_eval() {
  POC_MODE=LEVEL
  [[ -r "$ALERT_REGISTRY" ]] || return 0
  # Fast path for every legacy caller: no key set supplied and no row anywhere declaring page_on
  # means there is nothing to decide, and python is never started.
  if [[ -z "${ALERT_KEYS:-}" ]] && ! grep -q '"page_on' "$ALERT_REGISTRY" 2>/dev/null; then return 0; fi
  command -v python3 >/dev/null 2>&1 || return 0
  local line
  while IFS= read -r line; do
    case "${line%%=*}" in
      MODE)          POC_MODE="${line#*=}" ;;
      REASON)        POC_REASON="${line#*=}" ;;
      REVIEW_BY)     POC_REVIEW_BY="${line#*=}" ;;
      KEYS)          POC_KEYS="${line#*=}" ;;
      NKEYS)         POC_NKEYS="${line#*=}" ;;
      ACK_STATE)     POC_ACK_STATE="${line#*=}" ;;
      ACK_WHY)       POC_ACK_WHY="${line#*=}" ;;
      NEW)           POC_NEW="${line#*=}" ;;
      NNEW)          POC_NNEW="${line#*=}" ;;
      NACKED)        POC_NACKED="${line#*=}" ;;
      PRUNED)        POC_PRUNED="${line#*=}" ;;
      NPRUNED)       POC_NPRUNED="${line#*=}" ;;
      PRUNE_CHANGED) POC_PRUNE_CHANGED="${line#*=}" ;;
    esac
  done < <(ALERT_KEYS="${ALERT_KEYS:-}" poc_py eval "$ALERT_REGISTRY" "$ALERT_ID" "$ACK_FILE")
  case "$POC_MODE" in
    EARNED)
      # A partial read is never a decision: every count the gate branches on must be numeric.
      [[ "$POC_NNEW" =~ ^[0-9]+$ && "$POC_NKEYS" =~ ^[1-9][0-9]*$ && "$POC_NACKED" =~ ^[0-9]+$ ]] || POC_MODE=LEVEL ;;
    NOT_EARNED|EXPIRED) ;;
    *) POC_MODE=LEVEL ;;
  esac
}

# ack_write <source> <key>... — atomic; logs and returns 1 on any failure (the keys page again).
ack_write() {
  local src="$1" res
  shift
  res=$(poc_py write "$ACK_FILE" "$ALERT_ID" "$src" "$@" || true)
  if [[ "$res" == OK* ]]; then return 0; fi
  log "ACK_WRITE_FAILED: ${res:-python3 unavailable} (source=$src)"
  return 1
}

keys_word() { if [[ "$1" == 1 ]]; then echo "1 key"; else echo "$1 keys"; fi; }

# poc_list "<space-separated keys>" -> "k1, k2, … and N more" (bounded: a Telegram message is too)
poc_list() {
  local max=15 n=0 k acc=""
  # Keys passed KEY_RE (no glob or quote characters), so word splitting here is exact.
  # shellcheck disable=SC2206
  local arr=($1)
  for k in "${arr[@]}"; do
    n=$((n + 1))
    if [[ $n -gt $max ]]; then break; fi
    acc="${acc:+$acc, }$k"
  done
  if [[ ${#arr[@]} -gt $max ]]; then acc="$acc and $(( ${#arr[@]} - max )) more"; fi
  echo "$acc"
}

# The derived header a delivered page-on-change page carries. Built HERE from the ack, never
# supplied by the caller, so the caller cannot mislabel what is new.
poc_header() {
  local acked
  if [[ "$POC_ACK_STATE" == LOADED ]]; then
    acked=$(keys_word "$POC_NACKED")
  else
    acked="unknown — the acknowledgement was ${POC_ACK_WHY:-unreadable}, so every key is treated as new"
  fi
  printf 'NEW: %s · still present (acknowledged): %s\n' "$(poc_list "$POC_NEW")" "$acked"
}

# ── human_span <seconds> ────────────────────────────────────────────────────────────────────
human_span() {
  local s=$1
  if   [[ $s -lt 3600   ]]; then echo "$((s / 60))m"
  elif [[ $s -lt 172800 ]]; then echo "$((s / 3600))h"
  else echo "$((s / 86400))d $(( (s % 86400) / 3600 ))h"
  fi
}

# ── do_clear — the FIRING -> CLEAR transition ───────────────────────────────────────────────
# Emits AT MOST ONE message per episode: it is gated on the marker existing (i.e. a fire was
# actually DELIVERED to the operator) and removes that marker on success. Its rate is bounded by
# the fires it answers — the 24h cooldown already limits an alert to one fire per day, therefore
# to one resolution per day. No new timer and no new tunable, which is the whole argument for why
# this is a resolution rather than chatter.
do_clear() {
  # 1. TEST CONTEXT FIRST — before ANY state read or write. See is_test_context above.
  if is_test_context; then
    log "SUPPRESSED_TEST_CONTEXT: --clear raised from a test process (NODE_TEST_CONTEXT=${NODE_TEST_CONTEXT:-} VITEST=${VITEST:-} ALGOVAULT_TG_TEST_INERT=${ALGOVAULT_TG_TEST_INERT:-0}); production alert state untouched"
    exit 0
  fi

  # 1b. PAGE-ON-CHANGE: `--clear` is how a page-on-change caller reports an EMPTY key set, and
  #     nothing present means nothing stays acknowledged. Removed whether or not a marker exists;
  #     a row that never adopted page-on-change has no ack file, so its path is unchanged.
  if [[ -f "$ACK_FILE" ]]; then
    rm -f "$ACK_FILE" 2>/dev/null || true
    log "ACK_CLEARED: acknowledged key set removed (the caller reported an empty key set)"
  fi

  local marker="$STATE_DIR/${ALERT_ID}-last-fired-at"

  # 2. No marker -> NOTHING HAPPENED. Never announce a resolution for a condition that never
  #    fired: that is a confident wrong answer, which this file's own RESOLVER_MISS history
  #    already establishes is strictly worse than saying nothing.
  if [[ ! -f "$marker" ]]; then
    log "CLEAR_NOOP: no marker — nothing was firing, so nothing resolved"
    exit 0
  fi

  local since now age span
  since=$(cat "$marker" 2>/dev/null || echo "")
  now=$(date +%s)
  if [[ "$since" =~ ^[0-9]+$ ]]; then age=$((now - since)); else age=-1; fi
  if [[ $age -ge 0 ]]; then span=$(human_span "$age"); else span="unknown (unparseable marker)"; fi

  # 3. SILENT by default. Forensics go to the log, which is exactly what the law asks for.
  if ! announce_resolution "$ALERT_ID"; then
    rm -f "$marker" 2>/dev/null || true
    log "CLEAR_SILENT: resolved after ${span} (announce_resolution not enabled; state cleared, no POST)${CLEAR_REASON:+ reason=$CLEAR_REASON}"
    exit 0
  fi

  local body
  body=$(printf '✅ RESOLVED — %s\n\nThis is a STATE TRANSITION: the condition that fired is no longer present.\nWas firing for: %s\n%sHost: %s\n\nNo action required. This message exists so silence never has to be interpreted.\n' \
    "$ALERT_ID" "$span" "${CLEAR_REASON:+Reason: $CLEAR_REASON$'\n'}" "$(hostname)")

  # 4. DRY_RUN mirrors DRY_RUN_FIRED exactly: no POST, state change still performed.
  if [[ "${DRY_RUN_TG:-0}" == "1" ]]; then
    rm -f "$marker" 2>/dev/null || true
    log "DRY_RUN_CLEARED: TG POST skipped (DRY_RUN_TG=1); marker removed; resolved after ${span}"
    exit 0
  fi

  # 5. Creds. KEEP the marker — a resolution we could not deliver must be retried, never dropped.
  if [[ ! -r "$ENV_FILE" ]]; then
    log "CLEAR_SEND_FAILED: $ENV_FILE not readable; marker KEPT for retry"
    exit 0
  fi
  # shellcheck disable=SC1091
  . "$ENV_FILE"
  if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
    log "CLEAR_SEND_FAILED: credentials unset; marker KEPT for retry"
    exit 0
  fi

  # NOTE: a resolution is DELIBERATELY not cooldown-gated. A resolution that waits 24h is
  # worthless, and its rate is already bounded by the fires it answers.
  local tmp code
  tmp=$(mktemp /tmp/.tg-clear-XXXXXX)
  code=$("$TG_CURL" -sS -o "$tmp" -w "%{http_code}" -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${body}" \
    --max-time 10 || echo "000")

  if [[ "$code" =~ ^2 ]]; then
    rm -f "$marker" 2>/dev/null || true
    log "CLEAR_FIRED: HTTP $code — resolved after ${span}; marker removed"
  else
    # Losing state on an undelivered resolution would leave the operator with a stale FIRING view
    # and no way back to CLEAR. Keep it; the next healthy tick retries.
    log "CLEAR_SEND_FAILED: HTTP $code — marker KEPT for retry"
  fi
  rm -f "$tmp" 2>/dev/null || true
  exit 0
}

# ── do_reconcile — adopt on-disk state WITHOUT emitting any transition ──────────────────────
# The adoption tool. When an alert flips announce_resolution to true, any marker it already
# carries would produce a RESOLVED for a historical episode on the very next healthy tick.
# Measured at design time: 31 markers across the two hosts, aged 0d to 82d. Run this for an id
# whose history you do NOT want announced; skip it for one whose resolution IS the receipt.
# One-way, and logged per alert_id, so the silence is a recorded decision rather than a gap.
do_reconcile() {
  if is_test_context; then
    log "SUPPRESSED_TEST_CONTEXT: --reconcile raised from a test process; production alert state untouched"
    exit 0
  fi
  local n=0 f id
  shopt -s nullglob
  for f in "$STATE_DIR"/*-last-fired-at; do
    id=$(basename "$f" -last-fired-at)
    # Scoped to the marker glob ONLY. $STATE_DIR is SHARED — seven other canaries keep their own
    # .count/.set/.json state beside these markers, so anything wholesale here would eat theirs.
    [[ "$ALERT_ID" == "ALL" || "$ALERT_ID" == "$id" ]] || continue
    rm -f "$f" 2>/dev/null || true
    n=$((n + 1))
    log "RECONCILED: $id adopted silently — pre-existing marker dropped, no transition emitted"
  done
  log "RECONCILE_DONE: $n marker(s) adopted silently (scope=$ALERT_ID)"
  exit 0
}

# ── do_acknowledge — seed the ack WITHOUT a POST (the bootstrap) ───────────────────────────────
# The one sanctioned way to acknowledge without paging: an adopter's known set is recorded once,
# at install, so its first real run pages only what is genuinely new. No marker, no POST.
do_acknowledge() {
  if is_test_context; then
    log "SUPPRESSED_TEST_CONTEXT: --acknowledge raised from a test process; production alert state untouched"
    exit 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log "ACKNOWLEDGE_REFUSED: python3 unavailable; nothing written"
    exit 0
  fi
  local line keys="" n=0 err=""
  while IFS= read -r line; do
    case "${line%%=*}" in
      KEYS)  keys="${line#*=}" ;;
      NKEYS) n="${line#*=}" ;;
      ERR)   err="${line#*=}" ;;
    esac
  done < <(ALERT_KEYS="${ALERT_KEYS:-}" poc_py norm)
  if [[ -n "$err" || -z "$keys" ]]; then
    log "ACKNOWLEDGE_REFUSED: ${err:-no valid keys}; nothing written"
    exit 0
  fi
  poc_eval
  # shellcheck disable=SC2086
  if ack_write bootstrap $keys; then
    log "ACKNOWLEDGED_BOOTSTRAP: $(keys_word "$n") acknowledged without a POST (registry opt-in: ${POC_MODE})"
  fi
  exit 0
}

# ── --self-test: hermetic. No network, no /opt, no /var/log, no TG. Vacuity-guarded ─────────
# Verdict contract: exactly one terminal ALERT_WRAPPER_VERDICT=PASS|FAIL|INDETERMINATE.
# Exit 0=PASS / 1=FAIL / 3=INDETERMINATE (3 is the token-law default for a new gate).
self_test() {
  local fails=0 checks=0 tmp me
  me="${BASH_SOURCE[0]}"
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/tgtest.XXXXXX") || { echo "ALERT_WRAPPER_VERDICT=INDETERMINATE"; exit 3; }
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  mkdir -p "$tmp/state"
  ck() { checks=$((checks+1)); [[ "$2" == "$3" ]] || { echo "  ✗ $1 (got '$2' want '$3')"; fails=$((fails+1)); }; }

  printf 'TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=c\n' > "$tmp/env"
  printf '#!/usr/bin/env bash\nprintf 200\n' > "$tmp/curl-ok";   chmod +x "$tmp/curl-ok"
  printf '#!/usr/bin/env bash\nprintf 500\n' > "$tmp/curl-fail"; chmod +x "$tmp/curl-fail"

  # THE SUITE'S OWN VACUITY HAZARD, closed explicitly: this file suppresses everything under
  # VITEST / NODE_TEST_CONTEXT, and `npm test` sets VITEST=1. Inheriting it would send every
  # child down SUPPRESSED_TEST_CONTEXT and the whole suite would pass while asserting nothing.
  # So each child is launched with those cleared, and the ONE case that wants suppression sets
  # it explicitly.
  run() {  # <state_dir> <extra-env...> -- <args...>
    local sd="$1"; shift
    env -u VITEST -u NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT=0 \
        ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$sd" \
        ALERT_WRAPPER_ENV="$tmp/env" ALERT_REGISTRY_PATH="$tmp/registry.json" \
        ALERT_WRAPPER_CURL="$tmp/curl-ok" "$@" >/dev/null 2>&1
  }
  verb() { tail -1 "$tmp/log" 2>/dev/null | sed -E 's/.*\] ([A-Z_]+):.*/\1/'; }
  mark() { echo "$1" > "$tmp/state/AID-last-fired-at"; }
  fresh() { rm -f "$tmp/state"/*-last-fired-at 2>/dev/null || true; : > "$tmp/log"; rm -f "$tmp/registry.json"; }
  optin() { printf '{"alerts":[{"alert_id":"AID","announce_resolution":true}]}\n' > "$tmp/registry.json"; }

  # ── transitions ──────────────────────────────────────────────────────────
  fresh; run "$tmp/state" bash "$me" --clear AID
  ck 'CLEAR with no marker is a NOOP'                    "$(verb)" 'CLEAR_NOOP'
  ck 'CLEAR with no marker announces nothing'            "$(grep -c 'CLEAR_FIRED' "$tmp/log")" '0'

  fresh; mark "$(( $(date +%s) - 7200 ))"; run "$tmp/state" bash "$me" --clear AID
  ck 'CLEAR is SILENT when not opted in (the law default)' "$(verb)" 'CLEAR_SILENT'
  ck 'CLEAR_SILENT still clears the state'               "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'n'

  fresh; mark "$(( $(date +%s) - 7200 ))"; printf '{"alerts":[{"alert_id":"AID"}]}\n' > "$tmp/registry.json"
  run "$tmp/state" bash "$me" --clear AID
  ck 'a row WITHOUT announce_resolution stays SILENT'    "$(verb)" 'CLEAR_SILENT'
  fresh; mark "$(( $(date +%s) - 7200 ))"; printf 'not json\n' > "$tmp/registry.json"
  run "$tmp/state" bash "$me" --clear AID
  ck 'a MALFORMED registry fails toward SILENT'          "$(verb)" 'CLEAR_SILENT'

  fresh; mark "$(( $(date +%s) - 7200 ))"; optin; run "$tmp/state" bash "$me" --clear AID
  ck 'opted in + delivered -> CLEAR_FIRED'               "$(verb)" 'CLEAR_FIRED'
  ck 'a delivered resolution removes the marker'         "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'n'

  # A resolution is DELIBERATELY exempt from the 24h cooldown. Marker 1 minute old.
  fresh; mark "$(( $(date +%s) - 60 ))"; optin; run "$tmp/state" bash "$me" --clear AID
  ck 'resolution is NOT suppressed by an unexpired cooldown' "$(verb)" 'CLEAR_FIRED'

  # ── failed send KEEPS the marker ─────────────────────────────────────────
  fresh; mark "$(( $(date +%s) - 7200 ))"; optin
  env -u VITEST -u NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT=0 \
      ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$tmp/state" ALERT_WRAPPER_ENV="$tmp/env" \
      ALERT_REGISTRY_PATH="$tmp/registry.json" ALERT_WRAPPER_CURL="$tmp/curl-fail" \
      bash "$me" --clear AID >/dev/null 2>&1
  ck 'a FAILED send logs CLEAR_SEND_FAILED'              "$(verb)" 'CLEAR_SEND_FAILED'
  ck 'a FAILED send KEEPS the marker for retry'          "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'y'

  fresh; mark "$(( $(date +%s) - 7200 ))"; optin
  env -u VITEST -u NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT=0 \
      ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$tmp/state" ALERT_WRAPPER_ENV="$tmp/nope" \
      ALERT_REGISTRY_PATH="$tmp/registry.json" bash "$me" --clear AID >/dev/null 2>&1
  ck 'missing creds KEEP the marker too'                 "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'y'

  # ── DRY_RUN mirrors DRY_RUN_FIRED ────────────────────────────────────────
  fresh; mark "$(( $(date +%s) - 7200 ))"; optin
  env -u VITEST -u NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT=0 DRY_RUN_TG=1 \
      ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$tmp/state" ALERT_WRAPPER_ENV="$tmp/env" \
      ALERT_REGISTRY_PATH="$tmp/registry.json" bash "$me" --clear AID >/dev/null 2>&1
  ck 'DRY_RUN_TG clears state without a POST'            "$(verb)" 'DRY_RUN_CLEARED'

  # ── THE SHARPEST HAZARD: test context cannot clear production state ──────
  # A test that DELETES alert state is worse than one that writes it: a write silences the next
  # page, a delete erases the episode and makes the next genuine fire look like a fresh incident.
  local before after
  for trig in VITEST NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT; do
    fresh; mark 1755700000; optin
    before=$(cksum < "$tmp/state/AID-last-fired-at")
    env -u VITEST -u NODE_TEST_CONTEXT "$trig=1" \
        ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$tmp/state" ALERT_WRAPPER_ENV="$tmp/env" \
        ALERT_REGISTRY_PATH="$tmp/registry.json" ALERT_WRAPPER_CURL="$tmp/curl-ok" \
        bash "$me" --clear AID >/dev/null 2>&1
    after=$(cksum < "$tmp/state/AID-last-fired-at" 2>/dev/null || echo MISSING)
    ck "test context cannot clear production state ($trig)" "$after" "$before"
    ck "  and it announces nothing ($trig)" "$(grep -c 'CLEAR_FIRED' "$tmp/log")" '0'
  done

  # ── reconcile emits nothing ──────────────────────────────────────────────
  fresh; mark "$(( $(date +%s) - 999999 ))"; optin
  echo 12345 > "$tmp/state/OTHER-last-fired-at"
  echo keep > "$tmp/state/some-canary.count"     # a SHARED-DIR neighbour that must survive
  run "$tmp/state" bash "$me" --reconcile AID
  ck 'reconcile drops the scoped marker'                 "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'n'
  ck 'reconcile leaves an out-of-scope marker alone'     "$([[ -f "$tmp/state/OTHER-last-fired-at" ]] && echo y || echo n)" 'y'
  ck 'reconcile never touches a neighbour canary file'   "$([[ -f "$tmp/state/some-canary.count" ]] && echo y || echo n)" 'y'
  ck 'reconcile emits NO transition'                     "$(grep -cE 'CLEAR_FIRED|CLEAR_SILENT' "$tmp/log")" '0'

  # ── THE UNSCOPED CASE, which is the only one where the GLOB is load-bearing ──────────────
  # Caught by the proof-it-can-fail step: the scoped case above survives a broken glob because
  # the alert_id filter rejects a neighbour anyway, so it passed while asserting nothing about
  # the glob. `--reconcile` with no id is the shape where $STATE_DIR being a SHARED directory
  # actually bites — seven other canaries keep .count/.set/.json state beside these markers.
  fresh; mark 111; echo 222 > "$tmp/state/OTHER-last-fired-at"
  echo keep > "$tmp/state/some-canary.count"
  echo keep > "$tmp/state/another-canary.set"
  run "$tmp/state" bash "$me" --reconcile
  ck 'unscoped reconcile drops EVERY marker'             "$(ls "$tmp/state"/*-last-fired-at 2>/dev/null | wc -l | tr -d ' ')" '0'
  ck 'unscoped reconcile spares a .count neighbour'      "$([[ -f "$tmp/state/some-canary.count" ]] && echo y || echo n)" 'y'
  ck 'unscoped reconcile spares a .set neighbour'        "$([[ -f "$tmp/state/another-canary.set" ]] && echo y || echo n)" 'y'

  # ── SANDBOX CONTAINMENT — the small honest debt from OPS-ALERT-RECOVERY-NOTICE-W1 ────────
  # That wave's proof-4 run cleared a REAL `QUOTA_EXHAUSTION_HIGH_VOLUME` marker (13h old) on
  # signal-1 instead of a sandboxed one, resetting its 24h cooldown. It was disclosed rather than
  # left to be found, and it failed in the safe direction — the next exhaustion pages sooner, not
  # later. But the safeguard was PROSE: "use ALGOVAULT_TG_TEST_INERT=1 for ad-hoc runs", addressed
  # to whoever happened to read it. CLAUDE.md: a rule that has once failed as prose must be retired
  # into a gate. This is that gate.
  #
  # `$decoy` stands in for /opt/algovault-monitoring/.alert-state and is seeded with the exact
  # marker that was clobbered. Containment is asserted as a CHECKSUM MANIFEST of the whole
  # directory, not a file-exists probe: a rewritten marker with the same name is the same incident.
  local decoy manifest_before manifest_after
  decoy="$tmp/prod-state"
  mkdir -p "$decoy"
  seed_decoy() {
    rm -rf "${decoy:?}"/*
    echo 1755600000 > "$decoy/QUOTA_EXHAUSTION_HIGH_VOLUME-last-fired-at"
    echo 1755600001 > "$decoy/AID-last-fired-at"
    echo keep       > "$decoy/some-canary.count"
  }
  # `find | sort` + cksum: names AND contents, so a same-name rewrite is caught.
  dmanifest() { find "$decoy" -type f | sort | while read -r f; do printf '%s %s\n' "${f##*/}" "$(cksum < "$f")"; done; }

  # (a) THE INCIDENT'S OWN SHAPE — an ad-hoc run under a test context, pointed at production.
  #     This is what SHOULD have happened in proof-4 and is now asserted rather than remembered.
  for sub in "--clear QUOTA_EXHAUSTION_HIGH_VOLUME" "--reconcile QUOTA_EXHAUSTION_HIGH_VOLUME" "--reconcile"; do
    seed_decoy; : > "$tmp/log"; manifest_before=$(dmanifest)
    # shellcheck disable=SC2086
    env -u VITEST -u NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT=1 \
        ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$decoy" ALERT_WRAPPER_ENV="$tmp/env" \
        ALERT_REGISTRY_PATH="$tmp/registry.json" ALERT_WRAPPER_CURL="$tmp/curl-ok" \
        bash "$me" $sub >/dev/null 2>&1
    manifest_after=$(dmanifest)
    ck "test-inert '$sub' leaves production state byte-identical" "$manifest_after" "$manifest_before"
  done

  # (b) SANDBOX CONTAINMENT — a FULLY LIVE run (not inert) confined by ALERT_WRAPPER_STATE_DIR
  #     must not reach outside it, for any subcommand.
  for sub in "--clear AID" "--reconcile AID" "--reconcile"; do
    seed_decoy; fresh; mark 111; optin
    echo keep > "$tmp/state/some-canary.count"
    manifest_before=$(dmanifest)
    # shellcheck disable=SC2086
    run "$tmp/state" bash "$me" $sub
    manifest_after=$(dmanifest)
    ck "sandboxed '$sub' cannot touch a path outside its state dir" "$manifest_after" "$manifest_before"
  done
  # NOT VACUOUS: the last sandboxed --reconcile must genuinely have done its job inside the
  # sandbox. Without this, a wrapper that did nothing at all would satisfy every check above.
  ck 'sandbox containment is not vacuous — the run DID act inside the sandbox' \
     "$(ls "$tmp/state"/*-last-fired-at 2>/dev/null | wc -l | tr -d ' ')" '0'
  ck '  …and the decoy still holds both of its markers' \
     "$(ls "$decoy"/*-last-fired-at 2>/dev/null | wc -l | tr -d ' ')" '2'

  # ── PAGE-ON-CHANGE (OPS-ALARM-SINGLE-DERIVATION-W1 CH3) ───────────────────────────────────
  # Every rule of the gate, two-way. A recording curl stub keeps the POSTed text, so the derived
  # header is asserted in what an operator would actually receive, not in a log paraphrase.
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" >> "%s"\nprintf 200\n' "$tmp/posted" > "$tmp/curl-rec"
  chmod +x "$tmp/curl-rec"
  local ackf="$tmp/state/AID.ack.json"
  ackkeys() { python3 -c 'import json,sys; print(" ".join(json.load(open(sys.argv[1]))["keys"]))' "$ackf" 2>/dev/null || echo MISSING; }
  ackseed() { printf '{"version":1,"alert_id":"AID","keys":[%s]}\n' "$1" > "$ackf"; }
  pocrow() {
    printf '{"alerts":[{"alert_id":"AID","page_on":"change","page_on_change":{"review_by":"%s","decided_by":"self-test","decided_at":"2026-09-30","reason":"fixture"}}]}\n' "$1" > "$tmp/registry.json"
  }
  pfresh() { fresh; rm -f "$ackf" "$tmp/posted" 2>/dev/null || true; }
  posts() { if [[ -f "$tmp/posted" ]]; then grep -c '^https://api.telegram.org/' "$tmp/posted"; else echo 0; fi; }
  firep() {  # <keys> [extra env...] — one alert-mode call through the recording stub, today pinned
    local keys="$1"; shift
    : > "$tmp/status.md"   # hermetic: a readable, template-free status.md, so the resolver logs nothing
    printf 'b\n' | run "$tmp/state" ALERT_WRAPPER_CURL="$tmp/curl-rec" ALERT_WRAPPER_TODAY=2026-09-30 \
      STATUS_MD_PATH="$tmp/status.md" ALERT_KEYS="$keys" "$@" bash "$me" AID CRITICAL_PERSISTENT -
  }
  vseq() { sed -E 's/.*\] ([A-Z_]+):.*/\1/' "$tmp/log" | tr '\n' ' '; }

  # (1) first sighting, no ack -> UNKNOWN -> pages; header derived; ack seeded deduped + sorted
  pfresh; pocrow 2099-12-31; firep 'dead:XT|B dead:XT|A dead:XT|A'
  ck 'page-on-change: an absent ack is UNKNOWN and PAGES'       "$(verb)" 'PAGED_NEW_KEY'
  ck '  …the delivered text leads with the derived NEW header'   "$(grep -c '^text=NEW: dead:XT|A, dead:XT|B · still present (acknowledged): unknown' "$tmp/posted")" '1'
  ck '  …and the ack is seeded, deduped and sorted'              "$(ackkeys)" 'dead:XT|A dead:XT|B'
  ck '  …and the key set is DEDUPED before anything counts it'  "$(grep -c 're-seeded to the 2 keys present' "$tmp/log")" '1'
  # (2) the same set -> UNCHANGED_SUPPRESSED, no POST — even though the 24h gate WOULD allow a page
  rm -f "$tmp/posted"; mark 1; firep 'dead:XT|A dead:XT|B'
  ck 'the same key set is UNCHANGED_SUPPRESSED'                  "$(verb)" 'UNCHANGED_SUPPRESSED'
  ck '  …and POSTs nothing'                                      "$(posts)" '0'
  # (3) decided BEFORE the 24h gate: a fresh marker does not turn "unchanged" into "cooldown"
  mark "$(( $(date +%s) - 60 ))"; firep 'dead:XT|A dead:XT|B'
  ck 'unchanged is decided BEFORE the 24h gate'                  "$(verb)" 'UNCHANGED_SUPPRESSED'
  # (4) a recovered key is PRUNED from the ack, silently
  firep 'dead:XT|A'
  ck 'a recovered key stays silent'                              "$(verb)" 'UNCHANGED_SUPPRESSED'
  ck '  …and is pruned from the ack'                             "$(ackkeys)" 'dead:XT|A'
  # (5) it re-breaks inside the 24h window -> suppressed there, ack NOT advanced (still new later)
  firep 'dead:XT|A dead:XT|B'
  ck 'a re-broken key inside 24h reaches the 24h gate'           "$(verb)" 'SUPPRESSED_COOLDOWN'
  ck '  …and the ack is NOT advanced'                            "$(ackkeys)" 'dead:XT|A'
  # (6) prune -> re-page once the 24h gate allows, naming only the NEW key
  mark 1; rm -f "$tmp/posted"; firep 'dead:XT|A dead:XT|B'
  ck 'prune -> re-page'                                          "$(verb)" 'PAGED_NEW_KEY'
  ck '  …the header names only the NEW key and the acknowledged count' "$(grep -c '^text=NEW: dead:XT|B · still present (acknowledged): 1 key$' "$tmp/posted")" '1'
  ck '  …and a delivered page advances the ack to every present key' "$(ackkeys)" 'dead:XT|A dead:XT|B'
  # (7) a FAILED POST leaves the ack alone
  pfresh; pocrow 2099-12-31; ackseed '"dead:XT|A"'
  printf 'b\n' | run "$tmp/state" ALERT_WRAPPER_CURL="$tmp/curl-fail" ALERT_WRAPPER_TODAY=2026-09-30 \
    ALERT_KEYS='dead:XT|A dead:XT|B' bash "$me" AID CRITICAL_PERSISTENT -
  ck 'a failed POST is FAILED_TG_API'                            "$(verb)" 'FAILED_TG_API'
  ck '  …and leaves the ack unchanged'                           "$(ackkeys)" 'dead:XT|A'
  # (8) DRY_RUN_TG leaves the ack alone: an acknowledgment means an operator SAW it
  pfresh; pocrow 2099-12-31; ackseed '"dead:XT|A"'; firep 'dead:XT|A dead:XT|B' DRY_RUN_TG=1
  ck 'DRY_RUN_TG on a new key is DRY_RUN_FIRED'                  "$(verb)" 'DRY_RUN_FIRED'
  ck '  …and does NOT advance the ack'                           "$(ackkeys)" 'dead:XT|A'
  # (9) a malformed ack is UNKNOWN, never "everything is old": it pages and re-seeds
  pfresh; pocrow 2099-12-31; echo 'not json' > "$ackf"; firep 'dead:XT|A'
  ck 'a malformed ack PAGES'                                     "$(verb)" 'PAGED_NEW_KEY'
  ck '  …and re-seeds'                                           "$(ackkeys)" 'dead:XT|A'
  # (10) both-or-neither: page_on without its declaration is NOT earned -> the LEVEL
  pfresh; printf '{"alerts":[{"alert_id":"AID","page_on":"change"}]}\n' > "$tmp/registry.json"
  ackseed '"dead:XT|A"'; firep 'dead:XT|A'
  ck 'page_on without page_on_change is NOT earned'             "$(grep -c 'PAGE_ON_CHANGE_NOT_EARNED' "$tmp/log")" '1'
  ck '  …and pages on the LEVEL despite a covering ack'         "$(verb)" 'FIRED'
  pfresh; printf '{"alerts":[{"alert_id":"AID","page_on":"change","page_on_change":{"review_by":"2099-12-31"}}]}\n' > "$tmp/registry.json"
  ackseed '"dead:XT|A"'; firep 'dead:XT|A'
  ck 'a declaration missing decided_by/decided_at/reason is NOT earned' "$(grep -c 'PAGE_ON_CHANGE_NOT_EARNED' "$tmp/log")" '1'
  # (11) a malformed review_by is NOT earned
  pfresh; pocrow 2026-13-45; ackseed '"dead:XT|A"'; firep 'dead:XT|A'
  ck 'a malformed review_by is NOT earned'                       "$(grep -c 'PAGE_ON_CHANGE_NOT_EARNED' "$tmp/log")" '1'
  # (12) a keyless call on an opted-in row is NOT earned -> the LEVEL
  pfresh; pocrow 2099-12-31; firep ''
  ck 'a call without keys is NOT earned'                         "$(grep -c 'PAGE_ON_CHANGE_NOT_EARNED' "$tmp/log")" '1'
  ck '  …and pages on the LEVEL'                                 "$(verb)" 'FIRED'
  # (13) one invalid token fails the whole set toward noise
  pfresh; pocrow 2099-12-31; ackseed '"dead:XT|A"'; firep 'dead:XT|A dead"XT'
  ck 'an invalid key token is NOT earned'                        "$(grep -c 'PAGE_ON_CHANGE_NOT_EARNED' "$tmp/log")" '1'
  # (14) review_by is INCLUSIVE; the next UTC day is the LEVEL again and the body says so
  pfresh; pocrow 2026-09-30; ackseed '"dead:XT|A"'; firep 'dead:XT|A'
  ck 'review_by is inclusive (today == review_by is still earned)' "$(verb)" 'UNCHANGED_SUPPRESSED'
  pfresh; pocrow 2026-09-29; ackseed '"dead:XT|A"'; firep 'dead:XT|A'
  ck 'the day after review_by pages on the LEVEL'               "$(verb)" 'FIRED'
  ck '  …the log says the opt-in expired'                        "$(grep -c 'PAGE_ON_CHANGE_EXPIRED' "$tmp/log")" '1'
  ck '  …and the delivered body carries one line saying so'     "$(grep -c 'page-on-change expired after review_by 2026-09-29' "$tmp/posted")" '1'
  # (15) a row WITHOUT page_on ignores ALERT_KEYS entirely: byte-identical verbs, no ack
  pfresh; printf '{"alerts":[{"alert_id":"AID"}]}\n' > "$tmp/registry.json"; firep ''; firep ''
  local legacy_verbs; legacy_verbs=$(vseq)
  pfresh; printf '{"alerts":[{"alert_id":"AID"}]}\n' > "$tmp/registry.json"; firep 'dead:XT|A'; firep 'dead:XT|A'
  ck 'a row without page_on ignores ALERT_KEYS (verb sequence identical)' "$(vseq)" "$legacy_verbs"
  ck '  …the sequence is the legacy FIRED then SUPPRESSED_COOLDOWN' "$legacy_verbs" 'FIRED SUPPRESSED_COOLDOWN '
  ck '  …and writes no ack'                                      "$([[ -f "$ackf" ]] && echo y || echo n)" 'n'
  pfresh; firep 'dead:XT|A'
  ck 'with NO registry at all, keys change nothing either'      "$(verb)" 'FIRED'
  # (16) --acknowledge seeds the ack from ALERT_KEYS WITHOUT a POST and without a marker
  pfresh; pocrow 2099-12-31
  run "$tmp/state" ALERT_WRAPPER_CURL="$tmp/curl-rec" ALERT_KEYS='dead:XT|B dead:XT|A,dead:XT|A' bash "$me" --acknowledge AID
  ck '--acknowledge is ACKNOWLEDGED_BOOTSTRAP'                   "$(verb)" 'ACKNOWLEDGED_BOOTSTRAP'
  ck '  …counting the deduped set (comma or space separated)'    "$(grep -c 'ACKNOWLEDGED_BOOTSTRAP: 2 keys acknowledged' "$tmp/log")" '1'
  ck '  …seeds the ack'                                          "$(ackkeys)" 'dead:XT|A dead:XT|B'
  ck '  …POSTs nothing'                                          "$(posts)" '0'
  ck '  …and writes no marker'                                   "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'n'
  firep 'dead:XT|A dead:XT|B'
  ck '  …so the first real run of that set is UNCHANGED'        "$(verb)" 'UNCHANGED_SUPPRESSED'
  pfresh; pocrow 2099-12-31; run "$tmp/state" bash "$me" --acknowledge AID
  ck '--acknowledge without keys is REFUSED'                     "$(verb)" 'ACKNOWLEDGE_REFUSED'
  ck '  …and writes nothing'                                     "$([[ -f "$ackf" ]] && echo y || echo n)" 'n'
  # (17) --clear removes BOTH the marker and the ack; with no marker it still removes the ack
  pfresh; pocrow 2099-12-31; mark 111; ackseed '"dead:XT|A"'; run "$tmp/state" bash "$me" --clear AID
  ck '--clear removes the ack'                                   "$([[ -f "$ackf" ]] && echo y || echo n)" 'n'
  ck '  …and the marker'                                         "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'n'
  pfresh; ackseed '"dead:XT|A"'; run "$tmp/state" bash "$me" --clear AID
  ck '--clear with no marker still removes the ack'             "$([[ -f "$ackf" ]] && echo y || echo n)" 'n'
  ck '  …and still reports CLEAR_NOOP for the marker'           "$(verb)" 'CLEAR_NOOP'
  # (18) --reconcile never touches an ack: it globs the marker files only
  pfresh; mark 111; ackseed '"dead:XT|A"'; run "$tmp/state" bash "$me" --reconcile
  ck '--reconcile leaves the ack alone'                          "$([[ -f "$ackf" ]] && echo y || echo n)" 'y'
  # (19) a TEST context can neither write nor clear production ack state, on any path
  local sub
  for sub in "--acknowledge AID" "--clear AID" "AID CRITICAL_PERSISTENT -"; do
    seed_decoy; printf '{"version":1,"alert_id":"AID","keys":["dead:XT|Z"]}\n' > "$decoy/AID.ack.json"
    pocrow 2099-12-31; manifest_before=$(dmanifest)
    # shellcheck disable=SC2086
    printf 'b\n' | env -u VITEST -u NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT=1 ALERT_KEYS='dead:XT|A' \
        ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$decoy" ALERT_WRAPPER_ENV="$tmp/env" \
        ALERT_REGISTRY_PATH="$tmp/registry.json" ALERT_WRAPPER_CURL="$tmp/curl-ok" \
        bash "$me" $sub >/dev/null 2>&1
    ck "test-inert '$sub' leaves production ack state byte-identical" "$(dmanifest)" "$manifest_before"
  done
  # (20) a LIVE --acknowledge confined by ALERT_WRAPPER_STATE_DIR cannot reach outside it
  seed_decoy; pfresh; pocrow 2099-12-31; manifest_before=$(dmanifest)
  run "$tmp/state" ALERT_KEYS='dead:XT|A' bash "$me" --acknowledge AID
  ck 'a sandboxed --acknowledge cannot touch a path outside its state dir' "$(dmanifest)" "$manifest_before"
  ck '  …and it DID act inside the sandbox (not vacuous)'       "$(ackkeys)" 'dead:XT|A'
  # (21) STRUCTURE — the order the whole design depends on, asserted on the shipped text
  local i_test i_poc i_cool
  i_test=$(grep -n '^if is_test_context; then$' "$me" | head -1 | cut -d: -f1 || true)
  i_poc=$(grep -n '^poc_eval$' "$me" | head -1 | cut -d: -f1 || true)
  i_cool=$(grep -n '^MARKER="\$STATE_DIR/\${ALERT_ID}-last-fired-at"$' "$me" | head -1 | cut -d: -f1 || true)
  ck 'the gate sits after the test-context gate and before the 24h gate' \
     "$([[ -n "$i_test" && -n "$i_poc" && -n "$i_cool" && $i_test -lt $i_poc && $i_poc -lt $i_cool ]] && echo y || echo n)" 'y'
  ck 'the ack lives beside the marker in STATE_DIR'             "$(grep -c '^ACK_FILE="\$STATE_DIR/\${ALERT_ID}.ack.json"$' "$me")" '1'
  ck '--reconcile still globs ONLY the marker files'            "$(grep -c 'for f in "\$STATE_DIR"/\*-last-fired-at; do' "$me")" '1'

  # ── legacy 3-arg path byte-identical ─────────────────────────────────────
  # The documented verb for each legacy scenario, pinned. Any reordering of the gates, or a new
  # gate slipped in front of one, changes the verb a scenario produces and fails here.
  fresh; run "$tmp/state" bash "$me" AID LOW - < /dev/null
  ck 'legacy 3-arg path byte-identical: non-critical severity' "$(verb)" 'SUPPRESSED_SEVERITY'
  fresh; env VITEST=1 ALERT_WRAPPER_LOG="$tmp/log" ALERT_WRAPPER_STATE_DIR="$tmp/state" \
      ALERT_WRAPPER_ENV="$tmp/env" bash "$me" AID CRITICAL_PERSISTENT - < /dev/null >/dev/null 2>&1
  ck 'legacy 3-arg path byte-identical: test context'    "$(verb)" 'SUPPRESSED_TEST_CONTEXT'
  fresh; mark "$(( $(date +%s) - 60 ))"; run "$tmp/state" bash "$me" AID CRITICAL_PERSISTENT - < /dev/null
  ck 'legacy 3-arg path byte-identical: cooldown'        "$(verb)" 'SUPPRESSED_COOLDOWN'
  fresh; env -u VITEST -u NODE_TEST_CONTEXT ALGOVAULT_TG_TEST_INERT=0 ALERT_WRAPPER_LOG="$tmp/log" \
      ALERT_WRAPPER_STATE_DIR="$tmp/state" ALERT_WRAPPER_ENV="$tmp/nope" \
      bash "$me" AID CRITICAL_PERSISTENT - < /dev/null >/dev/null 2>&1
  ck 'legacy 3-arg path byte-identical: no creds'        "$(verb)" 'FAILED_NO_ENV'
  fresh; printf 'b\n' | run "$tmp/state" bash "$me" AID CRITICAL_PERSISTENT -
  ck 'legacy 3-arg path byte-identical: fires'           "$(verb)" 'FIRED'
  ck 'legacy 3-arg path byte-identical: writes the marker' "$([[ -f "$tmp/state/AID-last-fired-at" ]] && echo y || echo n)" 'y'

  # ── RESOLVER CORPUS + --resolve (OPS-HOST-KERNEL-REBOOT-W5 CH2) ──────────────────────────
  # The fixture mirrors 2026-10-02: status.md holds only the OPEN wave (trim policy v3), the
  # class's GREEN history lives only in the archive-derived wave-history.md.
  local rs="$tmp/resolver" rout
  mkdir -p "$rs"
  printf '%s\n' '### 2026-10-02 08:00 UTC — OPS-FIXTURE-REBOOT-W5 (Target ICP tier(s): META) — ⏳ open' > "$rs/status.md"
  printf '%s\n' '<!-- generated -->' \
    '### 2026-08-27 — OPS-FIXTURE-REBOOT-W3 (Target ICP tier(s): META) — ✅ GREEN' \
    '### 2026-09-12 08:49 UTC — OPS-FIXTURE-REBOOT-W4 (Target ICP tier(s): META) — ✅ GREEN' > "$rs/wave-history.md"
  printf '#!/usr/bin/env bash\ntouch "%s/curl-was-called"\nprintf 200\n' "$rs" > "$rs/curl-tripwire"; chmod +x "$rs/curl-tripwire"
  resolve_body() {  # <status_path> <history_path> — stdin body -> stdout; stderr captured
    env -u VITEST -u NODE_TEST_CONTEXT -u ALGOVAULT_TG_TEST_INERT \
        ALERT_WRAPPER_LOG="$rs/log" ALERT_WRAPPER_STATE_DIR="$rs/state" ALERT_WRAPPER_ENV="$tmp/env" \
        ALERT_REGISTRY_PATH="$tmp/registry.json" ALERT_WRAPPER_CURL="$rs/curl-tripwire" \
        STATUS_MD_PATH="$1" WAVE_HISTORY_PATH="$2" bash "$me" --resolve - 2>"$rs/stderr"
  }
  rout=$(printf 'recommended_wave: OPS-FIXTURE-REBOOT-W{NEXT}\n' | resolve_body "$rs/status.md" "$rs/wave-history.md")
  ck 'archive-only GREEN history resolves through wave-history.md'   "$rout" 'recommended_wave: OPS-FIXTURE-REBOOT-W5'
  # TWO-DIRECTION REPRODUCTION: the same corpus WITHOUT wave-history.md is exactly origin/main's view.
  rout=$(printf 'recommended_wave: OPS-FIXTURE-REBOOT-W{NEXT}\n' | resolve_body "$rs/status.md" "$rs/absent.md")
  ck 'status.md alone ships the placeholder verbatim (the bug, reproduced)' "$rout" 'recommended_wave: OPS-FIXTURE-REBOOT-W{NEXT}'
  ck '…and logs wave_history_absent'                    "$(grep -c 'reason=wave_history_absent' "$rs/stderr")" '1'
  ck '…and no_completed_waves_for_class'                "$(grep -c 'reason=no_completed_waves_for_class' "$rs/stderr")" '1'
  # The wave's own GREEN entry lands in status.md -> the next page names the NEXT wave.
  printf '%s\n' '### 2026-10-02 09:30 UTC — OPS-FIXTURE-REBOOT-W5 (Target ICP tier(s): META) — ✅ GREEN' >> "$rs/status.md"
  rout=$(printf 'recommended_wave: OPS-FIXTURE-REBOOT-W{NEXT}\n' | resolve_body "$rs/status.md" "$rs/wave-history.md")
  ck 'a GREEN in status.md and history in the archive take the max of the UNION' "$rout" 'recommended_wave: OPS-FIXTURE-REBOOT-W6'
  # aoe-1's shape: no status.md at all, only the pushed corpus.
  rout=$(printf 'recommended_wave: OPS-FIXTURE-REBOOT-W{NEXT}\n' | resolve_body "$rs/absent.md" "$rs/wave-history.md")
  ck 'wave-history.md alone resolves (the aoe-1 shape)'  "$rout" 'recommended_wave: OPS-FIXTURE-REBOOT-W5'
  ck '…without a reachable_status_md_path_not_found'   "$(grep -c 'reachable_status_md_path_not_found' "$rs/stderr")" '0'
  rout=$(printf 'recommended_wave: OPS-FIXTURE-REBOOT-W{NEXT}\n' | resolve_body "$rs/absent.md" "$rs/absent2.md")
  ck 'NEITHER file readable ships the placeholder verbatim' "$rout" 'recommended_wave: OPS-FIXTURE-REBOOT-W{NEXT}'
  ck '…as reachable_status_md_path_not_found'           "$(grep -c 'reason=reachable_status_md_path_not_found' "$rs/stderr")" '1'
  rout=$(printf 'line one\nrecommended_wave: none here\n' | resolve_body "$rs/status.md" "$rs/wave-history.md")
  ck 'a body with no template passes through unchanged' "$rout" "$(printf 'line one\nrecommended_wave: none here')"
  ck '…and logs nothing'                                "$(wc -c < "$rs/stderr" | tr -d ' ')" '0'
  # --resolve is a PURE function: no STATE_DIR, no marker, no log file, no network — ever.
  ck '--resolve never creates STATE_DIR'               "$([[ -e "$rs/state" ]] && echo y || echo n)" 'n'
  ck '--resolve never writes the shared log'           "$([[ -e "$rs/log" ]] && echo y || echo n)" 'n'
  ck '--resolve never reaches the network'             "$([[ -e "$rs/curl-was-called" ]] && echo y || echo n)" 'n'
  ck '--resolve never writes a cooldown marker anywhere' "$(find "$tmp" -name '*-last-fired-at' -newer "$rs/curl-tripwire" | grep -c RESOLVE)" '0'
  # Both the max-extraction and the already-GREEN guard read the SAME union (single corpus).
  ck 'the max-extraction reads the union corpus'       "$(grep -c 'grep -ohE "^### .\*\${class}-W\[0-9\]+.\*GREEN" "\${corpus\[@\]}"' "$me")" '1'
  ck 'the already-GREEN guard reads the same union'    "$(grep -c 'grep -qhE "^### .\*\${class}-W\${next}.\*GREEN" "\${corpus\[@\]}"' "$me")" '1'
  ck 'ONE pinned default for the corpus path'          "$(grep -cE '^  local history_path="\$\{WAVE_HISTORY_PATH:-/var/lib/algovault-monitoring/wave-history\.md\}"$' "$me")" '1'

  # ── SEAM-BLINDNESS GUARD ─────────────────────────────────────────────────
  # Every POST above went through a stubbed curl, so this suite is structurally blind to the real
  # invocation. Assert the bypassed artifact directly: both POST sites must still carry the flags
  # that make them correct, and neither may hardcode `curl` past the seam.
  ck 'the fire POST keeps -sS -o -w and --max-time'   "$(grep -c '"\$TG_CURL" -sS -o "\$TMP_RESP" -w "%{http_code}" -X POST' "$me")" '1'
  ck 'the clear POST keeps -sS -o -w and --max-time'  "$(grep -c '"\$TG_CURL" -sS -o "\$tmp" -w "%{http_code}" -X POST' "$me")" '1'
  ck 'no POST bypasses the seam'                      "$(grep -cE '^\s*(HTTP_CODE=\$\(|code=\$\()curl ' "$me")" '0'
  ck 'the cooldown value is untouched'                "$(grep -c '^COOLDOWN_SEC=86400' "$me")" '1'

  # ── VACUITY GUARDS ───────────────────────────────────────────────────────
  checks=$((checks+1))
  if [[ $checks -lt 119 ]]; then  # raised 90 -> 119 by OPS-HOST-KERNEL-REBOOT-W5 (resolver corpus + --resolve)
    echo "  ✗ this suite ran only $checks checks — it is asserting almost nothing"; fails=$((fails+1))
  fi
  checks=$((checks+1))
  if [[ ! -s "$tmp/log" ]]; then
    echo "  ✗ the captured log is EMPTY — every child was suppressed and nothing was asserted"
    fails=$((fails+1))
  fi

  if [[ $fails -ne 0 ]]; then
    echo "SELF-TEST: FAIL — $fails of $checks check(s) failed"
    echo "ALERT_WRAPPER_VERDICT=FAIL"
    exit 1
  fi
  echo "SELF-TEST: PASS — $checks checks (transitions both ways, silent-by-default, failed-send retains state, test context cannot clear production state, legacy 3-arg path byte-identical, reconcile emits nothing, sandbox containment both ways, seam-blindness guard, page-on-change: new/same/prune/re-page, 24h/failed/dry-run keep the ack, UNKNOWN ack pages, both-or-neither, review_by inclusive, --acknowledge, --clear, legacy rows ignore keys, gate order, resolver corpus status.md ∪ wave-history.md both directions, --resolve pure)"
  echo "ALERT_WRAPPER_VERDICT=PASS"
  exit 0
}

# ── --resolve: the resolver as a pure, read-only seam (OPS-HOST-KERNEL-REBOOT-W5) ──────────
# A body on stdin (or a file argument) -> the resolved body on stdout. It reads the same corpus a
# real fire reads and NOTHING else: no STATE_DIR (not even created), no cooldown marker, no ack, no
# env file, no network, and its diagnostics go to stderr rather than the shared log. Any gate or
# probe that wants to know what a page WOULD say calls this instead of firing one.
do_resolve() {
  local body
  if [[ "$BODY_INPUT" == "-" ]]; then body=$(cat); else body=$(cat "$BODY_INPUT" 2>/dev/null || true); fi
  resolve_template "$body"
  exit 0
}

case "$MODE" in
  resolve)   do_resolve ;;
  clear)     do_clear ;;
  reconcile) do_reconcile ;;
  self-test) self_test ;;
  acknowledge) do_acknowledge ;;
esac

# Severity gate
if [[ "$SEVERITY" != "CRITICAL_PERSISTENT" ]]; then
  log "SUPPRESSED_SEVERITY: severity=$SEVERITY not in TG-fire set"
  exit 0
fi

# ── TEST-CONTEXT GATE (OPS-AUTOPUB-TEST-ALERT-LEAK-W1, 2026-07-22) ────────────────────────
# No alert may originate from a test process.
#
# WHY HERE AND NOT IN THE CALLERS: this wrapper is the single choke point for ALL Telegram
# egress, and node/vitest child processes inherit the parent env, so one gate here covers every
# current AND future consumer in any language — instead of each caller remembering to inject a
# stub. `lib/drafter.mjs` and `lib/anchor-numeric-claims.mjs` already accept an injectable
# `invoker` for exactly this, but the DEFAULT is the real wrapper, so any test that drives the
# module end-to-end (rather than calling the alert fn directly) fires for real. That happened on
# 2026-07-22T12:43:22Z: `tests/unit/drafter.test.mjs` runs the real drafter against a fake
# `claude` that emits malformed output, retries exhausted, and the escalation paged the operator
# with test-fixture text.
#
# DELIBERATELY BEFORE THE COOLDOWN GATE, and it does NOT write the marker. The dangerous half of
# that incident was not the spurious message — it was that firing WROTE the 24h cooldown marker,
# which would have SILENCED the next genuine drafter failure. A test run must leave production
# alert state untouched.
#
# Backward-compatible: both vars are unset in production, so prod behaviour is byte-identical.
# Forward-compatible: ALGOVAULT_TG_TEST_INERT is the explicit escape hatch for non-node harnesses.
if is_test_context; then
  log "SUPPRESSED_TEST_CONTEXT: alert raised from a test process (NODE_TEST_CONTEXT=${NODE_TEST_CONTEXT:-} VITEST=${VITEST:-} ALGOVAULT_TG_TEST_INERT=${ALGOVAULT_TG_TEST_INERT:-0}); no POST, no cooldown marker"
  exit 0
fi

# ── PAGE-ON-CHANGE GATE (OPS-ALARM-SINGLE-DERIVATION-W1 CH3) ───────────────────────────────────
# AFTER the severity and test-context gates (a test process never reaches it, so it can never read
# or write an ack) and BEFORE the 24h gate. For a row that never opted in, poc_eval resolves LEVEL
# and nothing below does anything: that path is byte-identical to before.
poc_eval
case "$POC_MODE" in
  EARNED)
    if [[ "$POC_NNEW" -eq 0 ]]; then
      if [[ "$POC_PRUNE_CHANGED" == 1 ]]; then
        # shellcheck disable=SC2086
        ack_write prune $POC_PRUNED || true
      fi
      log "UNCHANGED_SUPPRESSED: all $(keys_word "$POC_NKEYS") already acknowledged (ack pruned to ${POC_NPRUNED}); no POST, the 24h gate was not consulted"
      exit 0
    fi
    ;;
  NOT_EARNED)
    log "PAGE_ON_CHANGE_NOT_EARNED: ${POC_REASON}; paging on the LEVEL (fail toward noise)"
    ;;
  EXPIRED)
    log "PAGE_ON_CHANGE_EXPIRED: review_by ${POC_REVIEW_BY} has passed; paging on the LEVEL until the registry row is re-decided"
    ;;
esac

# Cooldown gate
MARKER="$STATE_DIR/${ALERT_ID}-last-fired-at"
if [[ -f "$MARKER" ]]; then
  LAST=$(cat "$MARKER")
  NOW=$(date +%s)
  AGE=$((NOW - LAST))
  if [[ $AGE -lt $COOLDOWN_SEC ]]; then
    HRS=$((AGE / 3600))
    log "SUPPRESSED_COOLDOWN: last fired ${HRS}h ago (cooldown ${COOLDOWN_SEC}s)"
    exit 0
  fi
fi

# Source TG credentials
if [[ ! -r "$ENV_FILE" ]]; then
  log "FAILED_NO_ENV: $ENV_FILE not readable"
  exit 0  # fail-open per contract row 5
fi
# shellcheck disable=SC1091
. "$ENV_FILE"
: "${TELEGRAM_BOT_TOKEN:?TG token unset}" "${TELEGRAM_CHAT_ID:?chat id unset}"

# Read body
if [[ "$BODY_INPUT" == "-" ]]; then
  BODY=$(cat)
else
  BODY=$(cat "$BODY_INPUT")
fi

# === PATCH-B: resolver invocation — AFTER body-read, AFTER cooldown, BEFORE DRY_RUN gate ===
BODY=$(resolve_template "$BODY")
# PAGE-ON-CHANGE: the header is DERIVED from the ack here, never supplied by the caller.
if [[ "$POC_MODE" == EARNED ]]; then
  BODY="$(poc_header)"$'\n\n'"$BODY"
elif [[ "$POC_MODE" == EXPIRED ]]; then
  BODY="$BODY"$'\n\n'"⏳ page-on-change expired after review_by ${POC_REVIEW_BY}: this alert pages on the LEVEL again until its registry row is re-decided."
fi
BODY_LOG=$(echo "$BODY" | tr '\n' ' ' | head -c 1500)

# PATCH-A: DRY_RUN_TG gate — synthetic smokes + cred probes go through ALL gate logic
# but skip the actual TG POST. Marker is still written so cooldown-suppression smokes work.
if [[ "${DRY_RUN_TG:-0}" == "1" ]]; then
  date +%s > "$MARKER"
  log "DRY_RUN_FIRED: TG POST skipped (DRY_RUN_TG=1); marker written for cooldown smokes; body=${BODY_LOG}"
  exit 0
fi

# Post to TG (fail-open: log error but exit 0 so caller cron doesn't bounce)
TMP_RESP=$(mktemp /tmp/.tg-resp-XXXXXX)
HTTP_CODE=$("$TG_CURL" -sS -o "$TMP_RESP" -w "%{http_code}" -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${BODY}" \
  --max-time 10 || echo "000")

if [[ "$HTTP_CODE" =~ ^2 ]]; then
  date +%s > "$MARKER"
  log "FIRED: HTTP $HTTP_CODE body=${BODY_LOG}"
  if [[ "$POC_MODE" == EARNED ]]; then
    # Only a DELIVERED page acknowledges: ack := every key present now (the page named them all).
    # shellcheck disable=SC2086
    if ack_write delivered $POC_KEYS; then
      log "PAGED_NEW_KEY: new $(keys_word "$POC_NNEW"): ${POC_NEW} · acknowledged before: ${POC_NACKED} · ack re-seeded to the $(keys_word "$POC_NKEYS") present"
    else
      log "PAGED_NEW_KEY: new $(keys_word "$POC_NNEW"): ${POC_NEW} · the ack could NOT be re-seeded, so these keys will page again"
    fi
  fi
  rm -f "$TMP_RESP"
  exit 0
else
  RESP=$(head -c 500 "$TMP_RESP" 2>/dev/null || echo "")
  log "FAILED_TG_API: HTTP $HTTP_CODE response='${RESP}'"
  rm -f "$TMP_RESP"
  exit 0  # fail-open per contract
fi
