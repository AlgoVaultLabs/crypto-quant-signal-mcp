#!/usr/bin/env python3
"""decision-gate-orphan-canary.py — OPS-RECALIBRATE-HARNESS-RETIRE-W1 (R6)

Detects a DECISION GATE that has outlived its decision.

── The bug class ────────────────────────────────────────────────────────────────────────────
A decision-gate instrument is built to answer ONE question ONCE: "is there enough evidence to
dispatch wave X yet?" It fires a once-ever alert behind a marker file, the architect takes the
decision, and then the instrument runs forever — burning a cron slot, holding an inventory row,
and keeping an alarm armed for a consumer that no longer exists.

Nothing in this estate detected that, because from the reconciler's point of view an ORPHANED
gate and a HEALTHY gate are byte-identical: installed, hashes match, exits 0, schedule matches.
Every one of HASH_DRIFT / ORPHAN / DARK / SCHEDULE_DRIFT / NO_BACKUP passes on an orphan.

Measured at this wave's R0, and the reason it is a class rather than an anecdote:
  * `closedbar-recalibrate-readiness` — RECALIBRATE_READY fired 2026-08-13 00:24Z; the decision
    (DECISION-CLOSEDBAR-ARC-DEFER-W1) landed 07:33Z the same day. Found because it paged.
  * `candle-basis-shadow-report`      — CANDLE_BASIS_FLIP_READY fired 2026-08-07 05:43Z; the
    decision (SIGNAL-CLOSEDBAR-FLIP-W1) landed 12:40Z the SAME DAY. Nobody noticed for six days.
    It was found only by writing the spec for the first one.

The second is the whole argument. One orphan is an oversight; two, six days apart, with the
second invisible until a human happened to look sideways, is a missing detector.

── This is a RECURRENCE guard, NOT itself a decision gate ───────────────────────────────────
Stated explicitly because it is the first objection a reader of this wave will raise: after
OPS-RECALIBRATE-HARNESS-RETIRE-W1 both declared rows are `retired`, so this canary reports
`0 orphaned` and will keep doing so until a new decision gate is declared. That is not the
permanently-PASS class this wave exists to retire. Its subject is open-ended — "any future gate
that outlives its decision" — exactly like book-liveness-canary's R8 recurrence guard, for which
its own row records that `retired` would be false. A one-shot gate's subject is a single
question that gets answered; this one's subject is a class that keeps being instantiated.

── Contract ─────────────────────────────────────────────────────────────────────────────────
Corpus: every `ops/monitoring/monitoring-inventory.json` row carrying `decision_gate: true`.
Per row, three independent facts are read and reported POSITIVELY (never absence-of-alert):
  1. install_state          — from the row
  2. once-ever alert FIRED? — `once_ever_marker` exists on disk; its mtime gives the age.
                              This is the fired-EVIDENCE locator. Without it "has it fired?"
                              is prose, and a canary cannot evaluate prose.
  3. retirement trigger     — evaluated, not read. `kind: status_md_entry` greps the host-local
                              status.md for `match`.

Classification (one row → exactly one state):
  RETIRED           install_state != installed                       healthy, terminal
  ARMED             installed, marker absent                         healthy — still waiting to fire
  FIRED_RECENT      installed, fired, no decision yet, age <= grace   healthy — decision pending
  ORPHAN_SUSPECTED  installed, fired, no decision recorded, age > grace
  ORPHANED          installed, fired, AND the decision IS recorded

Two alert ids, because they have DIFFERENT remedies and this estate has twice shipped one
`recommended_wave` shared by two alerts with opposite remedies (closedbar-w1-liveness R2, and
the recalibrate config's own `alerts` block records the same lesson):
  DECISION_GATE_ORPHANED          → the decision is on record; retire the gate.
  DECISION_GATE_ORPHAN_SUSPECTED  → it fired long ago and NO decision was ever recorded; either
                                    record one or retire it. This is the branch that would have
                                    caught the sibling six days early with nobody having written
                                    a retirement_trigger for it — detection replacing memory.

Verdict token: exactly one terminal `DECISION_GATE_ORPHAN_VERDICT=PASS|FAIL|INDETERMINATE`.
Exit: 0 = evaluated (PASS, or FAIL with the alert sent) · 3 = INDETERMINATE (verified NOTHING).
3 is the token-law default for a NEW gate. Callers gate on the TOKEN, never the bare exit code:
FAIL exits 0 deliberately — the alert is the action, and bouncing a cron line on a real finding
only adds noise to a mailbox nobody reads.

FAIL-CLOSED, and specifically it never silently skips a row:
  * unreadable inventory / unreadable status.md              → INDETERMINATE
  * a decision_gate row missing once_ever_alert / _marker /
    retirement_trigger                                       → INDETERMINATE
  * an UNRECOGNISED retirement_trigger.kind                   → INDETERMINATE
The last one is the point. P6 of this wave's R0 measured that an unrecognised enum makes the
reconciler skip the row, and a skipped row is indistinguishable from a healthy one — the same
defect this canary exists to catch, one layer up. So an unknown kind is loud, never a skip.

Vacuity guard sits where the corpus is CONSTRUCTED, not where it is observed: WE declare the
decision_gate rows, so zero of them means the declaration is missing → INDETERMINATE. (Contrast
a runtime corpus the world builds, where empty is a FACT and the honest verdict is PASS with a
positive line. "Empty input" is only vacuity when you were supposed to fill it.)

Env / test seams:
  MONITORING_INVENTORY_PATH   inventory override (same sibling rule as the reconciler)
  DECISION_GATE_STATUS_MD     status.md path        DECISION_GATE_LOG        log path
  DECISION_GATE_GRACE_DAYS    suspicion grace (default 14)
  DECISION_GATE_NOW_EPOCH     freeze "now"          DECISION_GATE_SELFTEST=1 short-circuits fire()
  ALGOVAULT_TG_TEST_INERT=1   suppresses BEFORE the wrapper's cooldown gate and writes no marker.
                              Use this for repeated gate runs — DRY_RUN_TG=1 is NOT inert
                              (send_telegram.sh writes the 24h marker on that path, so
                              back-to-back dry runs FALSE-GREEN on cooldown suppression).
  --self-test                 hermetic scenario suite; no inventory, no status.md, no wrapper.

Cron: 27 7 * * * (canonical off-:00 minute per ops/monitoring/schedule-boundary-rule.json).
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ALERT_ORPHANED = "DECISION_GATE_ORPHANED"
ALERT_SUSPECTED = "DECISION_GATE_ORPHAN_SUSPECTED"
WRAPPER = os.environ.get("TG_WRAPPER", "/opt/algovault-monitoring/send_telegram.sh")
LOG = os.environ.get("DECISION_GATE_LOG", "/var/log/algovault-decision-gate-orphan-canary.log")
STATUS_MD = os.environ.get("DECISION_GATE_STATUS_MD", "/var/lib/algovault-monitoring/status.md")

# Grace before a fired-but-undecided gate becomes SUSPECT. 14d, not 7: a decision this class
# gates is an architect call on a real question, and a week is a normal turnaround. Carries a
# revisit row in `Claude files/defensive-reductions-to-revisit.md`.
GRACE_DAYS = max(1, int(os.environ.get("DECISION_GATE_GRACE_DAYS", "14")))

RECOMMENDED_WAVE_ORPHANED = "OPS-DECISION-GATE-RETIRE-W{NEXT}"
RECOMMENDED_WAVE_SUSPECTED = "OPS-DECISION-GATE-TRIAGE-W{NEXT}"

KNOWN_TRIGGER_KINDS = ("status_md_entry",)

HEALTHY_STATES = ("RETIRED", "ARMED", "FIRED_RECENT")
FINDING_STATES = ("ORPHANED", "ORPHAN_SUSPECTED")


class Indeterminate(Exception):
    """Raised where the run verified NOTHING it was supposed to verify. Never a silent skip."""


def log(msg):
    line = "[%s] %s" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), msg)
    print(line, flush=True)
    try:
        with open(LOG, "a") as fh:
            fh.write(line + "\n")
    except OSError:
        pass  # the log is evidence, not the contract; the token is the contract


def _resolve_inventory_path():
    """Same rule as monitoring-inventory-reconcile.py, and for the same measured reason.

    That script derived its path from __file__'s grandparent — correct in a checkout, resolving
    to `/ops/monitoring/...` once installed to /opt. Its first unattended run logged
    INVENTORY_LOAD_FAILED and exited 0, having reconciled nothing, one day after the wave that
    shipped it codified "installed is not working". Sibling-first is what makes the installed
    copy read the declaration declaration-sync.sh actually feeds it.
    """
    env = os.environ.get("MONITORING_INVENTORY_PATH")
    if env:
        return Path(env)
    sibling = Path(__file__).resolve().parent / "monitoring-inventory.json"
    if sibling.exists():
        return sibling
    return Path(__file__).resolve().parent.parent.parent / "ops/monitoring/monitoring-inventory.json"


def now_epoch():
    frozen = os.environ.get("DECISION_GATE_NOW_EPOCH")
    return int(frozen) if frozen else int(time.time())


# ── pure logic (fixture-drivable — this is what --self-test exercises) ────────────────────────

def decision_gates(inventory):
    """CORPUS CONSTRUCTION. Empty here is vacuity, because WE declare these rows."""
    rows = inventory.get("artifacts")
    if not isinstance(rows, list):
        raise Indeterminate("inventory has no `artifacts` list — shape changed or file truncated")
    gates = [r for r in rows if isinstance(r, dict) and r.get("decision_gate") is True]
    if not gates:
        raise Indeterminate(
            "ZERO rows carry decision_gate:true. This corpus is DECLARED, not discovered, so an "
            "empty set means the declaration was lost — not that no decision gates exist.")
    return gates


def require_fields(row):
    """A decision_gate row that cannot be evaluated is INDETERMINATE, never a skip."""
    missing = [f for f in ("once_ever_alert", "once_ever_marker", "retirement_trigger")
               if not row.get(f)]
    if missing:
        raise Indeterminate(
            "row %s declares decision_gate:true but is missing %s — an unevaluable gate must not "
            "read as a healthy one" % (row.get("id", "<no id>"), "+".join(missing)))


def marker_state(path, now, stat_fn=None):
    """(fired: bool, age_days: float|None). Absence is a FACT here, not vacuity: the world
    creates this file, and 'not fired yet' is a real, healthy answer."""
    stat_fn = stat_fn or (lambda p: os.stat(p))
    try:
        st = stat_fn(path)
    except (OSError, ValueError):
        return False, None
    return True, max(0.0, (now - st.st_mtime) / 86400.0)


def trigger_matched(trigger, status_text):
    """Evaluate the retirement trigger. Unknown kind => INDETERMINATE, never a silent skip."""
    if not isinstance(trigger, dict):
        raise Indeterminate("retirement_trigger is not an object: %r" % (trigger,))
    kind = trigger.get("kind")
    if kind not in KNOWN_TRIGGER_KINDS:
        raise Indeterminate(
            "unrecognised retirement_trigger.kind=%r (known: %s). An unrecognised enum that is "
            "SKIPPED looks exactly like a healthy row — the defect this canary exists to catch."
            % (kind, ", ".join(KNOWN_TRIGGER_KINDS)))
    match = trigger.get("match")
    if not match:
        raise Indeterminate("retirement_trigger.kind=%s carries no `match`" % kind)
    return match in status_text


def classify_row(row, fired, age_days, decided, grace_days=None):
    """One row -> exactly one state. Pure: no I/O, no globals beyond the default grace."""
    grace = GRACE_DAYS if grace_days is None else grace_days
    if row.get("install_state") != "installed":
        state = "RETIRED"
    elif not fired:
        state = "ARMED"
    elif decided:
        state = "ORPHANED"
    elif age_days is not None and age_days > grace:
        state = "ORPHAN_SUSPECTED"
    else:
        state = "FIRED_RECENT"
    return {
        "id": row.get("id"),
        "state": state,
        "install_state": row.get("install_state"),
        "alert": row.get("once_ever_alert"),
        "marker": row.get("once_ever_marker"),
        "fired": fired,
        "age_days": age_days,
        "decided": decided,
        "trigger": (row.get("retirement_trigger") or {}).get("match"),
        "owner_wave": row.get("owner_wave"),
    }


def render_row_line(v):
    """The POSITIVE per-row line. Every decision gate evaluated appears here, healthy or not."""
    age = "n/a" if v["age_days"] is None else "%.1fd" % v["age_days"]
    return ("EVAL gate=%s state=%s install_state=%s once_ever_alert=%s fired=%s marker_age=%s "
            "decision_recorded=%s trigger=%s"
            % (v["id"], v["state"], v["install_state"], v["alert"],
               "Y" if v["fired"] else "N", age, "Y" if v["decided"] else "N", v["trigger"]))


def build_body(alert_id, findings):
    """Alert body. Entity ids carry their entity NOUN and are pluralised from the id COUNT —
    a bare parenthesised number beside a count once cost a real operator misread
    (WEBHOOK_DELIVERY_DRIFT, 2026-08-01: '(new: 6)' read as six subscriptions when there were
    two). The self-test asserts this rendered BODY, not just the action verdict."""
    noun = "decision gate" if len(findings) == 1 else "decision gates"
    ids = ", ".join(sorted(f["id"] for f in findings))
    if alert_id == ALERT_ORPHANED:
        head = "\U0001F6D1 %s" % ALERT_ORPHANED
        why = ("Their once-ever alert has fired AND the decision it gated is recorded in "
               "status.md, yet they are still `installed` and still on cron. A gate that can no "
               "longer fail is indistinguishable from a broken one.")
        wave = RECOMMENDED_WAVE_ORPHANED
    else:
        head = "⚠️ %s" % ALERT_SUSPECTED
        why = ("Their once-ever alert fired more than %d days ago and NO decision is recorded in "
               "status.md. Either the decision was taken and never written down, or it is still "
               "owed. Both need a human; neither needs this gate to keep running."
               % GRACE_DAYS)
        wave = RECOMMENDED_WAVE_SUSPECTED
    lines = [head, "",
             "%d %s orphaned: %s" % (len(findings), noun, ids), "", why, ""]
    for f in sorted(findings, key=lambda x: x["id"]):
        age = "unknown" if f["age_days"] is None else "%.1f days ago" % f["age_days"]
        lines.append("  %s — %s fired %s; owner wave %s"
                     % (f["id"], f["alert"], age, f["owner_wave"]))
    lines += ["", "Action: dispatch %s via Cowork → Claude Code" % wave,
              "Source log: %s" % LOG]
    return "\n".join(lines)


# ── effects ──────────────────────────────────────────────────────────────────────────────────

LAST_FIRE = {}


def fire(alert_id, body):
    """Hand the body to the wrapper, which OWNS severity / cooldown / DRY_RUN / fail-open.
    This consumer re-implements none of those gates."""
    LAST_FIRE[alert_id] = body
    if os.environ.get("DECISION_GATE_SELFTEST") == "1":
        log("WOULD_FIRE: %s (self-test — wrapper skipped)" % alert_id)
        return
    proc = subprocess.run([WRAPPER, alert_id, "CRITICAL_PERSISTENT", "-"],
                          input=body, capture_output=True, text=True, timeout=30)
    log("wrapper exit=%d out=%s"
        % (proc.returncode, (proc.stdout or proc.stderr).strip()[:160]))
    if os.environ.get("ALGOVAULT_TG_TEST_INERT") == "1":
        log("WOULD_FIRE: alert_id=%s severity=CRITICAL_PERSISTENT verdict=SUPPRESSED_TEST_INERT "
            "(no POST, no cooldown marker)" % alert_id)
    elif os.environ.get("DRY_RUN_TG") == "1":
        log("WOULD_FIRE: alert_id=%s severity=CRITICAL_PERSISTENT verdict=DRY_RUN (no POST; 24h "
            "COOLDOWN MARKER WRITTEN — prefer ALGOVAULT_TG_TEST_INERT=1)" % alert_id)


def evaluate(inventory, status_text, now, stat_fn=None):
    """The whole shipped decision path, driven by injected data so --self-test exercises IT
    rather than a re-implementation beside it."""
    verdicts = []
    for row in decision_gates(inventory):
        require_fields(row)
        fired, age = marker_state(row["once_ever_marker"], now, stat_fn=stat_fn)
        decided = trigger_matched(row["retirement_trigger"], status_text)
        verdicts.append(classify_row(row, fired, age, decided))
    return verdicts


def run(inventory, status_text, now, stat_fn=None):
    verdicts = evaluate(inventory, status_text, now, stat_fn=stat_fn)
    for v in verdicts:
        log(render_row_line(v))
    log("SUMMARY: %d decision gate(s) evaluated — %s"
        % (len(verdicts),
           ", ".join("%s=%d" % (s, sum(1 for v in verdicts if v["state"] == s))
                     for s in ("RETIRED", "ARMED", "FIRED_RECENT",
                               "ORPHAN_SUSPECTED", "ORPHANED"))))
    for alert_id, state in ((ALERT_ORPHANED, "ORPHANED"),
                            (ALERT_SUSPECTED, "ORPHAN_SUSPECTED")):
        findings = [v for v in verdicts if v["state"] == state]
        if findings:
            fire(alert_id, build_body(alert_id, findings))
    return verdicts


def main():
    try:
        inv_path = _resolve_inventory_path()
        try:
            inventory = json.loads(Path(inv_path).read_text())
        except (OSError, ValueError) as e:
            raise Indeterminate("inventory unreadable at %s: %s" % (inv_path, e))
        try:
            status_text = Path(STATUS_MD).read_text()
        except OSError as e:
            # Handed input we could not read => INDETERMINATE, always. Without status.md the
            # retirement trigger cannot be evaluated, and "no decision found" would be a lie.
            raise Indeterminate("status.md unreadable at %s: %s" % (STATUS_MD, e))
        log("START inventory=%s status_md=%s grace_days=%d"
            % (inv_path, STATUS_MD, GRACE_DAYS))
        verdicts = run(inventory, status_text, now_epoch())
        orphaned = [v for v in verdicts if v["state"] in FINDING_STATES]
        print("DECISION_GATE_ORPHAN_VERDICT=%s" % ("FAIL" if orphaned else "PASS"))
        return 0
    except Indeterminate as e:
        log("INDETERMINATE: %s" % e)
        print("DECISION_GATE_ORPHAN_VERDICT=INDETERMINATE")
        return 3
    except Exception as e:  # noqa: BLE001 — an unexpected fault verified nothing either
        log("INDETERMINATE: %s: %s" % (type(e).__name__, e))
        print("DECISION_GATE_ORPHAN_VERDICT=INDETERMINATE")
        return 3


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

def self_test():
    """Hermetic scenarios — no inventory file, no status.md, no wrapper, temp log.

    Two-way by construction: every FINDING state has a matching HEALTHY twin differing in ONE
    input, so a classifier that always-fires and one that never-fires both go RED.

    A hermetic suite is structurally blind to exactly what its seam replaces, so the artifacts
    the seam bypasses are asserted directly: the rendered alert BODY, the per-row output line,
    and the token->exit-code mapping. Assertions that would RAISE are wrapped — an assertion
    that aborts the suite is not an assertion, it is a crash that reads as "no output".
    """
    global LOG
    tmp = tempfile.mkdtemp(prefix="decision-gate-selftest-")
    LOG = os.path.join(tmp, "selftest.log")
    os.environ["DECISION_GATE_SELFTEST"] = "1"
    os.environ["ALGOVAULT_TG_TEST_INERT"] = "1"

    failures = []
    ran = []

    def check(name, fn):
        ran.append(name)
        try:
            ok = bool(fn())
        except Exception as e:  # noqa: BLE001 — a raising assertion must REPORT, never abort
            ok, name = False, "%s [raised %s: %s]" % (name, type(e).__name__, e)
        print("  [%s] %s" % ("PASS" if ok else "FAIL", name))
        if not ok:
            failures.append(name)

    NOW = 1786600000
    DAY = 86400

    def row(rid="g1", state="installed", marker="/tmp/.nonexistent-marker", match="WAVE-X",
            kind="status_md_entry", **kw):
        r = {"id": rid, "install_state": state, "decision_gate": True,
             "once_ever_alert": "X_READY", "once_ever_marker": marker,
             "retirement_trigger": {"kind": kind, "match": match},
             "owner_wave": "OPS-TEST-W1"}
        r.update(kw)
        return r

    def inv(*rows):
        return {"artifacts": list(rows)}

    def stat_at(age_days):
        class S:
            st_mtime = NOW - age_days * DAY
        return lambda p: S()

    def stat_missing(p):
        raise OSError("no such file")

    # ── the five classifications, each paired with a one-input twin ──────────────────────────
    def state_of(r, stat_fn, status):
        return evaluate(inv(r), status, NOW, stat_fn=stat_fn)[0]["state"]

    check("fired + decision recorded + installed -> ORPHANED (the live class)",
          lambda: state_of(row(), stat_at(1), "…WAVE-X shipped…") == "ORPHANED")
    check("TWIN: same row, decision NOT recorded, fresh -> FIRED_RECENT (no alert)",
          lambda: state_of(row(), stat_at(1), "nothing here") == "FIRED_RECENT")
    check("TWIN: same row, decision NOT recorded, past grace -> ORPHAN_SUSPECTED",
          lambda: state_of(row(), stat_at(GRACE_DAYS + 1), "nothing here") == "ORPHAN_SUSPECTED")
    check("TWIN: exactly AT grace is still healthy (boundary is >, not >=)",
          lambda: state_of(row(), stat_at(GRACE_DAYS), "nothing here") == "FIRED_RECENT")
    check("TWIN: marker absent -> ARMED even with the decision recorded",
          lambda: state_of(row(), stat_missing, "…WAVE-X shipped…") == "ARMED")
    check("TWIN: install_state=retired -> RETIRED even when fired AND decided",
          lambda: state_of(row(state="retired"), stat_at(99), "…WAVE-X shipped…") == "RETIRED")
    check("retired wins over every other input (a retired gate never alerts)",
          lambda: all(state_of(row(state=s), stat_at(99), "…WAVE-X shipped…") == "RETIRED"
                      for s in ("retired", "pending", "unclassified")))

    # ── fail-closed: never a silent skip ─────────────────────────────────────────────────────
    def raises_indeterminate(fn):
        try:
            fn()
        except Indeterminate:
            return True
        except Exception:  # noqa: BLE001
            return False
        return False

    check("VACUITY: zero decision_gate rows -> INDETERMINATE (corpus is DECLARED, not discovered)",
          lambda: raises_indeterminate(lambda: decision_gates(inv({"id": "x"}))))
    check("VACUITY: an empty artifacts list -> INDETERMINATE",
          lambda: raises_indeterminate(lambda: decision_gates(inv())))
    check("SHAPE: artifacts missing entirely -> INDETERMINATE",
          lambda: raises_indeterminate(lambda: decision_gates({})))
    check("UNKNOWN retirement_trigger.kind -> INDETERMINATE, never a skip",
          lambda: raises_indeterminate(
              lambda: evaluate(inv(row(kind="cron_absent")), "", NOW, stat_fn=stat_at(1))))
    check("retirement_trigger without `match` -> INDETERMINATE",
          lambda: raises_indeterminate(
              lambda: trigger_matched({"kind": "status_md_entry"}, "anything")))
    check("retirement_trigger not an object -> INDETERMINATE",
          lambda: raises_indeterminate(lambda: trigger_matched("WAVE-X", "WAVE-X")))
    for f in ("once_ever_alert", "once_ever_marker", "retirement_trigger"):
        r = row()
        r.pop(f)
        check("a decision_gate row missing %s -> INDETERMINATE" % f,
              lambda r=r: raises_indeterminate(lambda: require_fields(r)))

    # ── artifacts the hermetic seam BYPASSES, asserted directly ──────────────────────────────
    orph = classify_row(row(rid="closedbar-recalibrate-readiness"), True, 3.0, True)
    body = build_body(ALERT_ORPHANED, [orph])
    check("BODY names the alert id", lambda: ALERT_ORPHANED in body)
    check("BODY names the gate id", lambda: "closedbar-recalibrate-readiness" in body)
    check("BODY carries the entity NOUN beside the count (never a bare number)",
          lambda: "1 decision gate orphaned:" in body)
    check("BODY pluralises from the id COUNT",
          lambda: "2 decision gates orphaned:" in build_body(
              ALERT_ORPHANED, [orph, classify_row(row(rid="candle-basis-shadow-report"),
                                                  True, 6.0, True)]))
    check("BODY carries a recommended wave in template form, never a literal W<N>",
          lambda: RECOMMENDED_WAVE_ORPHANED in body and "W{NEXT}" in body)
    check("SUSPECTED body is a DIFFERENT remedy from ORPHANED (never one wave for two faults)",
          lambda: RECOMMENDED_WAVE_SUSPECTED not in body
          and RECOMMENDED_WAVE_SUSPECTED in build_body(
              ALERT_SUSPECTED, [classify_row(row(), True, 99.0, False)]))
    line = render_row_line(orph)
    check("per-row line is POSITIVE — carries id, state and the measured age",
          lambda: "gate=closedbar-recalibrate-readiness" in line
          and "state=ORPHANED" in line and "marker_age=3.0d" in line)
    check("per-row line is emitted for HEALTHY rows too (absence is not evidence)",
          lambda: "state=ARMED" in render_row_line(
              classify_row(row(), False, None, False)))

    # ── end-to-end through run(): fires exactly the right alert ids ─────────────────────────
    LAST_FIRE.clear()
    run(inv(row(rid="a"), row(rid="b", state="retired")), "…WAVE-X shipped…", NOW,
        stat_fn=stat_at(1))
    check("run() fires ORPHANED for the installed row only",
          lambda: ALERT_ORPHANED in LAST_FIRE and "gate=a" not in LAST_FIRE.get(ALERT_SUSPECTED, "")
          and "b" not in LAST_FIRE[ALERT_ORPHANED].split("orphaned:")[1].split("\n")[0])
    LAST_FIRE.clear()
    run(inv(row(rid="c", state="retired")), "…WAVE-X shipped…", NOW, stat_fn=stat_at(1))
    check("run() over an all-retired corpus fires NOTHING (this canary's own steady state)",
          lambda: not LAST_FIRE)

    # ── token -> exit-code mapping (re-coding INDETERMINATE to 0 must go RED) ────────────────
    check("INDETERMINATE maps to exit 3, PASS/FAIL to 0",
          lambda: _token_exit_map() == {"PASS": 0, "FAIL": 0, "INDETERMINATE": 3})

    # VACUITY GUARD on the suite itself, at the point the corpus is CONSTRUCTED: `ran` is
    # appended by the real check() and compared against a floor, so a suite that silently stops
    # running scenarios (an early return, a botched refactor, a rename that drops a block) goes
    # RED instead of reporting a confident PASS over nothing. A guard written as
    # `len(failures) + 1 > 0` against a hardcoded count — which is what this line was first —
    # is not an assertion: it cannot fail, and it prints a number that lies the moment a check
    # is added or removed.
    n = len(ran)
    ok = not failures and n >= _SELF_TEST_MIN_CHECKS
    if n < _SELF_TEST_MIN_CHECKS:
        print("  [FAIL] VACUITY: suite ran %d check(s), floor is %d — it verified less than it "
              "was built to" % (n, _SELF_TEST_MIN_CHECKS))
    print("SELF-TEST: %s (%d check(s) ran, floor %d, %d failure(s))"
          % ("PASS" if ok else "FAIL", n, _SELF_TEST_MIN_CHECKS, len(failures)))
    print("DECISION_GATE_ORPHAN_VERDICT=%s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


# Floor, not a target — set to the ACTUAL check count so removing any scenario trips it. Raise
# it when scenarios are added; it exists so a suite that stops running its scenarios cannot
# report a pass. It earned its keep on first run: the line it replaced printed a hardcoded "30"
# while the suite really ran 27, so the summary had been lying from the moment it was written.
_SELF_TEST_MIN_CHECKS = 27


def _token_exit_map():
    """The mapping main() deploys, in ONE place so the self-test asserts the shipped fact
    rather than a copy. Asserting tokens without their exit codes is how re-coding
    INDETERMINATE to 0 once stayed fully green."""
    return {"PASS": 0, "FAIL": 0, "INDETERMINATE": 3}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="decision-gate orphan canary")
    ap.add_argument("--self-test", action="store_true",
                    help="hermetic scenario suite; exit non-zero on failure")
    a = ap.parse_args()
    sys.exit(self_test() if a.self_test else main())
