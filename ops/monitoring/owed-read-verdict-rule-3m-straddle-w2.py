#!/usr/bin/env python3
"""owed-read-verdict-rule-3m-straddle-w2.py — SIGNAL-VERDICT-RULE-GATE-LIVE-RULE-W1 CH2 R1.

Owner wave: SIGNAL-VERDICT-RULE-GATE-LIVE-RULE-W1 (arc ARC-VERDICT-RULE-SWITCH-30M-1H, task T3). Its CH1
taught the verdict-rule gate to read the live rule, flag a straddled window and page only a switch
AWAY from the live rule. The first window that tests it is 3m window 2 [2026-10-27, 2026-11-17): the
3m switch to (F,F) landed inside it (first fade-served 3m row 2026-10-31T11:29Z), so its incumbent is
(M,M) while the live rule at its look is (F,F). owed-read-runner.py runs this script when the registry
row is due, after that look; it answers ONE question and prints

    OWED_READ_METRICS=<json object, <= 4 KiB>
    OWED_READ_VERDICT=PASS|FAIL|INDETERMINATE

── THE RULE (pre-registered in the wave's spec, CH2 R1 — this file implements it, never retunes it) ──
  record   the EARLIEST verdict-rule-gate record at or after the look for EACH 3m cell (UP, DOWN),
           window 2, state DECIDED: live == live_at_look == FF, straddled true, actionable false.
  wrapper  >= 1 `[VERDICT_RULE_SWITCH_RECOMMENDED]` line in the alert wrapper's log at or after the
           look, and none naming `3m:[MF]{2}:w2` (a page key for this window).
  PASS iff both legs PASS. FAIL iff either is contradicted. INDETERMINATE when a record or the log is
  absent (a cell without a record, an unreadable or unparseable results file, no wrapper line).

  The words of the rule, fixed here:
    at or after the look   LOOK <= at <= now, by each record's `at` and each log line's leading UTC
                           stamp — `now` bounds both, so a sandbox replay sees only what existed then.
    a wrapper line         one the wrapper wrote for a run: SUPPRESSED_TEST_CONTEXT lines (a test
                           process calling the wrapper) never count towards the >= 1, but a test line
                           naming the key still contradicts.
    the log                the live file and its first rotation (`.1`); weekly rotation cannot move a
                           line written after the look out of both inside the row's 72 h window.

    owed-read-verdict-rule-3m-straddle-w2.py --run --now EPOCH [--sandbox] < anchors.json   (the runner)
    owed-read-verdict-rule-3m-straddle-w2.py --self-test
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timezone

# ── the pre-registration (the wave's spec, CH2 R1) ──
WAVE = "SIGNAL-VERDICT-RULE-GATE-LIVE-RULE-W1"
TF = "3m"
WINDOW = 2
LOOK = "2026-11-23T12:43Z"               # the gate's own look format (its records carry it verbatim)
LOOK_EPOCH = 1795437780                  # = LOOK; the self-test pins the two equal
LIVE = "FF"
DETECTOR = "verdict-rule-gate"
ALERT_ID = "VERDICT_RULE_SWITCH_RECOMMENDED"
RECORDS = "/var/lib/algovault-monitoring/canary-results.jsonl"
WRAPPER_LOG = "/var/log/algovault-monitoring-telegram.log"
CELLS = (f"{TF}|TRENDING_UP", f"{TF}|TRENDING_DOWN")
TEST_VERB = "SUPPRESSED_TEST_CONTEXT"
# What the registry row's `anchors` must equal. The registry is inert data that arrives by
# declaration-sync; a row can SELECT this read but can never retune it — a differing anchor is
# INDETERMINATE, and the fix is a reviewed edit of this file.
ANCHORS = {"tf": TF, "window": WINDOW, "look": LOOK, "live": LIVE, "detector": DETECTOR, "alert_id": ALERT_ID,
           "records": RECORDS, "wrapper_log": WRAPPER_LOG}
SANDBOX_KEY = "_sandbox_overrides"
# Nothing is overridable: the install's sandbox proof runs the registered read at a pinned `now`.
SANDBOX_OVERRIDABLE: tuple[str, ...] = ()

VERDICTS = ("PASS", "FAIL", "INDETERMINATE")
EXIT_FOR = {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3}
METRICS_MAX_BYTES = 4096
LINES_LISTED = 3
_KEY_RE = re.compile(r"(?<![A-Za-z0-9])" + re.escape(TF) + r":[MF]{2}:w" + str(WINDOW) + r"(?![0-9])")
_LOG_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) \[([A-Za-z0-9_]+)\] ([A-Z_]+)")


def _epoch(stamp: str, fmt: str = "%Y-%m-%dT%H:%M:%SZ") -> int:
    return int(datetime.strptime(stamp, fmt).replace(tzinfo=timezone.utc).timestamp())


# ── the anchors the runner hands over ────────────────────────────────────────────────────────

def resolve_anchors(anchors, sandbox):
    """-> (effective constants dict, None) or (None, reason)."""
    if not isinstance(anchors, dict):
        return None, "anchors are not a JSON object"
    overrides = anchors.get(SANDBOX_KEY)
    declared = {k: v for k, v in anchors.items() if k != SANDBOX_KEY}
    if declared != ANCHORS:
        diff = sorted(k for k in set(declared) | set(ANCHORS) if declared.get(k) != ANCHORS.get(k))
        return None, "the registry's anchors differ from this read's pre-registration on %s" % ",".join(diff)
    if overrides is not None:
        if not sandbox:
            return None, "a sandbox override arrived without --sandbox — refused"
        bad = sorted(overrides) if isinstance(overrides, dict) else ["(not an object)"]
        bad = [k for k in bad if k not in SANDBOX_OVERRIDABLE]
        if bad:
            return None, "sandbox override key(s) %s are not overridable" % ",".join(bad)
    return json.loads(json.dumps(ANCHORS)), None


# ── leg 1: the gate's records ────────────────────────────────────────────────────────────────

def leg_record(lines, now, eff=ANCHORS):
    """The earliest DECIDED record per 3m cell, window 2, in [LOOK, now] — judged on the four fields.
    `lines` is the results file's lines, or None when the file could not be read."""
    if lines is None:
        return {"verdict": "INDETERMINATE", "reason": "the results file is absent or unreadable"}
    look_s = LOOK_EPOCH
    earliest: dict[str, tuple[int, dict]] = {}
    bad = 0
    for ln in lines:
        if not ln.strip():
            continue
        try:
            d = json.loads(ln)
            if not isinstance(d, dict):
                raise ValueError("not an object")
        except ValueError:
            bad += 1
            continue
        m = d.get("metrics")
        if d.get("canary") != eff["detector"] or not isinstance(m, dict):
            continue
        if m.get("tf") != eff["tf"] or m.get("window") != eff["window"] or m.get("state") != "DECIDED" \
                or m.get("cell") not in CELLS:
            continue
        try:
            at = _epoch(d["at"])
        except (KeyError, TypeError, ValueError):
            bad += 1
            continue
        if not look_s <= at <= now:
            continue
        if m["cell"] not in earliest or at < earliest[m["cell"]][0]:
            earliest[m["cell"]] = (at, m)
    if bad:
        return {"verdict": "INDETERMINATE", "reason": f"{bad} unparseable line(s) — one could be the earliest record"}
    cells, contradictions = {}, []
    for cell in CELLS:
        if cell not in earliest:
            continue
        at, m = earliest[cell]
        got = {"at": datetime.fromtimestamp(at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "look": m.get("look"),
               "live": m.get("live"), "live_at_look": m.get("live_at_look"), "straddled": m.get("straddled"),
               "actionable": m.get("actionable"), "rec": m.get("rec"), "cause": m.get("cause")}
        cells[cell] = got
        if got["look"] != eff["look"]:
            contradictions.append(f"{cell} look {got['look']!r} != {eff['look']}")
        if got["live"] != eff["live"] or got["live_at_look"] != eff["live"]:
            contradictions.append(f"{cell} live={got['live']!r} live_at_look={got['live_at_look']!r} (want {eff['live']})")
        if got["straddled"] is not True:
            contradictions.append(f"{cell} straddled={got['straddled']!r} (want true)")
        if got["actionable"] is not False:
            contradictions.append(f"{cell} actionable={got['actionable']!r} (want false)")
    if contradictions:
        return {"verdict": "FAIL", "contradictions": contradictions[:6], "cells": cells}
    missing = [c for c in CELLS if c not in earliest]
    if missing:
        return {"verdict": "INDETERMINATE", "reason": f"no DECIDED record at or after the look for {','.join(missing)}",
                "cells": cells}
    return {"verdict": "PASS", "cells": cells}


# ── leg 2: the wrapper's log ─────────────────────────────────────────────────────────────────

def leg_wrapper(lines, now, eff=ANCHORS):
    """`lines` = the log's lines (live file + `.1`), or None when neither file could be read."""
    if lines is None:
        return {"verdict": "INDETERMINATE", "reason": "the wrapper log is absent or unreadable"}
    counted, test_lines, naming = 0, 0, []
    for ln in lines:
        mt = _LOG_RE.match(ln)
        if not mt or mt.group(2) != eff["alert_id"]:
            continue
        try:
            ts = _epoch(mt.group(1))
        except ValueError:
            continue
        if not LOOK_EPOCH <= ts <= now:
            continue
        if _KEY_RE.search(ln):
            naming.append(ln[:160])
        if mt.group(3) == TEST_VERB:
            test_lines += 1
        else:
            counted += 1
    out = {"lines_after_look": counted, "test_context_lines": test_lines}
    if naming:
        return {**out, "verdict": "FAIL", "naming": naming[:LINES_LISTED]}
    if counted == 0:
        return {**out, "verdict": "INDETERMINATE", "reason": "no wrapper line for this alert at or after the look"}
    return {**out, "verdict": "PASS"}


def aggregate(legs):
    vs = [legs[k]["verdict"] for k in sorted(legs)]
    if "FAIL" in vs:
        return "FAIL"
    return "PASS" if vs and all(v == "PASS" for v in vs) else "INDETERMINATE"


def evaluate(now, record_lines, log_lines, eff=ANCHORS):
    """Pure: everything gathered -> (verdict, metrics)."""
    legs = {"record": leg_record(record_lines, now, eff), "wrapper": leg_wrapper(log_lines, now, eff)}
    metrics = {"legs": legs, "now": int(now), "look": eff["look"],
               "rule": {"tf": eff["tf"], "window": eff["window"], "live": eff["live"]}}
    return aggregate(legs), fit_metrics(metrics)


def fit_metrics(m):
    """<= METRICS_MAX_BYTES: shed the per-cell detail, then the listed lines."""
    def size(x):
        return len(json.dumps(x, sort_keys=True).encode("utf-8"))
    if size(m) > METRICS_MAX_BYTES:
        m["legs"]["record"].pop("cells", None)
    if size(m) > METRICS_MAX_BYTES:
        m["legs"]["wrapper"]["naming"] = "(shed for size)"
    return m


# ── the live run ─────────────────────────────────────────────────────────────────────────────

def read_lines(paths):
    """Concatenated lines of every readable path; None when NONE could be read."""
    out, any_read = [], False
    for p in paths:
        try:
            with open(p, encoding="utf-8", errors="replace") as fh:
                out.extend(fh.read().splitlines())
            any_read = True
        except OSError:
            continue
    return out if any_read else None


def run(now, anchors, sandbox):
    eff, err = resolve_anchors(anchors, sandbox)
    if err:
        return "INDETERMINATE", {"reason": err}
    verdict, metrics = evaluate(now, read_lines([eff["records"]]),
                                read_lines([eff["wrapper_log"], eff["wrapper_log"] + ".1"]), eff)
    metrics["sandbox"] = bool(sandbox)
    return verdict, fit_metrics(metrics)


def emit(verdict, metrics):
    """The two contract lines, the token last."""
    return ["OWED_READ_METRICS=" + json.dumps(metrics, sort_keys=True, separators=(",", ":")),
            "OWED_READ_VERDICT=" + verdict]


def main(argv=None):
    ap = argparse.ArgumentParser(description="owed read: verdict-rule-3m-straddle-w2")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--now", type=int)
    ap.add_argument("--sandbox", action="store_true")
    a = ap.parse_args(sys.argv[1:] if argv is None else argv)
    if a.self_test:
        return self_test()
    if not a.run or a.now is None:
        ap.error("the runner invokes --run --now EPOCH with the anchors on stdin")
    try:
        anchors = json.loads(sys.stdin.read() or "null")
        verdict, metrics = run(a.now, anchors, a.sandbox)
    except Exception as e:  # noqa: BLE001 — an unexpected fault verified nothing
        verdict, metrics = "INDETERMINATE", {"reason": "fault %s: %s" % (type(e).__name__, str(e)[:200])}
    for name, leg in sorted((metrics.get("legs") or {}).items()):
        print("LEG %s %s %s" % (name, leg.get("verdict"), leg.get("reason", "")))
    for ln in emit(verdict, metrics):
        print(ln)
    return EXIT_FOR[verdict]


# ── Self-test ────────────────────────────────────────────────────────────────────────────────

# Floor = the measured check count, so removing any scenario trips it.
_SELF_TEST_MIN_CHECKS = 30


def _load_gate():
    """The gate installed beside this read: its cell_record builds the record fixtures, so the read
    is tested against what the gate actually WRITES, not against a shape copied by hand."""
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("verdict_rule_gate", os.path.join(here, "verdict-rule-gate.py"))
    gate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gate)
    return gate


def self_test():
    import tempfile
    failures, ran = [], []

    def check(name, fn):
        ran.append(name)
        try:
            ok = fn()
        except Exception as e:  # noqa: BLE001 — an assertion that raises is a crash, not a verdict
            failures.append(name)
            print("  [FAIL] %s (raised %s: %s)" % (name, type(e).__name__, str(e)[:160]))
            return
        if not ok:
            failures.append(name)
        print("  [%s] %s" % ("ok" if ok else "FAIL", name))

    tmp = tempfile.mkdtemp(prefix="owed-read-vr3m.")
    NOW = LOOK_EPOCH + 3600
    try:
        gate = _load_gate()
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import canary_result_log as crl  # noqa: E402
        loaded = True
    except Exception as e:  # noqa: BLE001
        print("  [FAIL] the gate and canary_result_log beside this read load (%s)" % e)
        loaded = False

    def record(cell_regime, at, live="FF", live_at_look="FF", straddle="y", actionable=False, look=LOOK_EPOCH,
               window=WINDOW, tf=TF, state="DECIDED", rec="SWITCH_TO", cause="FF"):
        """One line exactly as the gate writes it: its own cell_record through canary_result_log."""
        w = [x for x in gate.window_chain(tf, gate.T_START_EPOCH, LOOK_EPOCH + 400 * 86400) if x["k"] == window][0]
        res = {"tf": tf, "k": window, "start": w["start"], "end": w["end"], "look": look, "state": state,
               "rows": 100, "scored": 100, "alts": {}, "diag": {}, "cells": {}, "incumbent": "MM", "clusters": 21,
               "min_clusters": 17, "rec": rec, "cause": cause, "live": live, "live_at_look": live_at_look,
               "straddle": straddle, "actionable": actionable}
        return crl.build_record(DETECTOR, "PASS", 0, gate.cell_record(res, cell_regime),
                                at=datetime.fromtimestamp(at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))

    def both(at, **kw):
        return [record("TRENDING_UP", at, **kw), record("TRENDING_DOWN", at, **kw)]

    def log(at, verb="CLEAR_SILENT", rest="resolved after 14d", tag=ALERT_ID):
        return "%s [%s] %s: %s" % (datetime.fromtimestamp(at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), tag, verb, rest)

    good_rec = (lambda: both(LOOK_EPOCH + 12)) if loaded else (lambda: [])
    good_log = [log(LOOK_EPOCH + 13)]

    # ── the pre-registration ──
    check("the constants are the spec's: TF 3m, WINDOW 2, LOOK 2026-11-23T12:43Z, LIVE FF",
          lambda: (TF, WINDOW, LOOK, LIVE) == ("3m", 2, "2026-11-23T12:43Z", "FF"))
    check("LOOK_EPOCH is LOOK", lambda: LOOK_EPOCH == _epoch(LOOK, "%Y-%m-%dT%H:%MZ"))
    check("the look is the gate's own scheduled look of 3m window 2",
          lambda: [w for w in gate.window_chain("3m", gate.T_START_EPOCH, LOOK_EPOCH + 1) if w["k"] == 2][0]["look"] == LOOK_EPOCH)
    check("token -> exit code: PASS 0, FAIL 1, INDETERMINATE 3", lambda: EXIT_FOR == {"PASS": 0, "FAIL": 1, "INDETERMINATE": 3})

    # ── anchors ──
    check("anchors equal to the pre-registration resolve to it", lambda: resolve_anchors(json.loads(json.dumps(ANCHORS)), False) == (ANCHORS, None))
    check("a registry row that retunes the rule is INDETERMINATE, naming the key",
          lambda: resolve_anchors(dict(ANCHORS, live="MM"), False)[0] is None and "live" in resolve_anchors(dict(ANCHORS, live="MM"), False)[1])
    check("a sandbox override without --sandbox is refused",
          lambda: resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {}}), False)[0] is None)
    check("under --sandbox every override key is refused (nothing is overridable)",
          lambda: resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {"live": "MM"}}), True)[0] is None
          and resolve_anchors(dict(ANCHORS, **{SANDBOX_KEY: {}}), True)[0] == ANCHORS)

    # ── PASS ──
    v, m = evaluate(NOW, good_rec(), good_log)
    check("PASS: both cells live = live_at_look = FF, straddled, not actionable; a wrapper line after the look",
          lambda: v == "PASS" and m["legs"]["record"]["verdict"] == "PASS" and m["legs"]["wrapper"]["verdict"] == "PASS")
    v, m = evaluate(NOW, good_rec() + both(LOOK_EPOCH + 7 * 86400 + 12, live="MM", actionable=True), good_log)
    check("the EARLIEST record wins: a later re-run with another live rule does not change the verdict", lambda: v == "PASS")
    v, m = evaluate(NOW, both(LOOK_EPOCH - 7 * 86400, live="MM", straddle="n") + good_rec(), good_log)
    check("a record before the look is not the look's record", lambda: v == "PASS")
    v, m = evaluate(NOW, good_rec() + [record("TRENDING_UP", LOOK_EPOCH + 12, window=1)]
                    + [record("TRENDING_UP", LOOK_EPOCH + 12, tf="5m", live="MM", straddle="n")], good_log)
    check("another window or timeframe is not read", lambda: v == "PASS")
    v, m = evaluate(NOW, good_rec(), good_log + [log(LOOK_EPOCH + 14, verb="FIRED", rest="NEW: 5m:FM:w2")])
    check("a page for ANOTHER key (5m:FM:w2) is not this read's business", lambda: v == "PASS")

    # ── FAIL: contradicted ──
    for label, kw in (("live MM", {"live": "MM"}), ("live_at_look MM", {"live_at_look": "MM"}),
                      ("not straddled", {"straddle": "n"}), ("straddle unknown (null)", {"straddle": "?"}),
                      ("actionable", {"actionable": True})):
        v, m = evaluate(NOW, both(LOOK_EPOCH + 12, **kw), good_log)
        check("FAIL: a record with %s contradicts" % label, lambda v=v, m=m: v == "FAIL" and m["legs"]["record"]["verdict"] == "FAIL")
    v, m = evaluate(NOW, [record("TRENDING_UP", LOOK_EPOCH + 12), record("TRENDING_DOWN", LOOK_EPOCH + 12, actionable=True)], good_log)
    check("FAIL: one cell contradicting is enough", lambda: v == "FAIL")
    for key in ("3m:FF:w2", "3m:FM:w2", "3m:MM:w2"):
        v, m = evaluate(NOW, good_rec(), good_log + [log(LOOK_EPOCH + 14, verb="FIRED", rest="NEW: %s" % key)])
        check("FAIL: a wrapper line naming %s contradicts" % key, lambda v=v, m=m: v == "FAIL" and m["legs"]["wrapper"]["verdict"] == "FAIL")
    v, m = evaluate(NOW, good_rec(), good_log + [log(LOOK_EPOCH + 14, verb="UNCHANGED_SUPPRESSED", rest="13m:FF:w20 x3m:FF:w2")])
    check("a near-miss token (13m:FF:w20, x3m:FF:w2) is not the key", lambda: v == "PASS")

    # ── INDETERMINATE: absent ──
    v, m = evaluate(NOW, None, good_log)
    check("INDETERMINATE: the results file absent", lambda: v == "INDETERMINATE" and m["legs"]["record"]["verdict"] == "INDETERMINATE")
    v, m = evaluate(NOW, [record("TRENDING_UP", LOOK_EPOCH + 12)], good_log)
    check("INDETERMINATE: a cell without a record", lambda: v == "INDETERMINATE" and "TRENDING_DOWN" in m["legs"]["record"]["reason"])
    v, m = evaluate(NOW, good_rec() + ["{not json"], good_log)
    check("INDETERMINATE: an unparseable results line (it could be the earliest record)", lambda: v == "INDETERMINATE")
    v, m = evaluate(LOOK_EPOCH + 5, good_rec(), good_log)
    check("INDETERMINATE: nothing at or before `now` (a replay before the run)", lambda: v == "INDETERMINATE")
    v, m = evaluate(NOW, good_rec(), None)
    check("INDETERMINATE: the wrapper log absent", lambda: v == "INDETERMINATE" and m["legs"]["wrapper"]["verdict"] == "INDETERMINATE")
    v, m = evaluate(NOW, good_rec(), [log(LOOK_EPOCH - 60), log(LOOK_EPOCH + 13, tag="OTHER_ALERT")])
    check("INDETERMINATE: no line for THIS alert at or after the look", lambda: v == "INDETERMINATE")
    v, m = evaluate(NOW, good_rec(), [log(LOOK_EPOCH + 13, verb=TEST_VERB, rest="--clear raised from a test process")])
    check("INDETERMINATE: a test-context line alone never proves the scheduled run",
          lambda: v == "INDETERMINATE" and m["legs"]["wrapper"]["test_context_lines"] == 1)

    # ── the live run's file reads ──
    rp, lp = os.path.join(tmp, "results.jsonl"), os.path.join(tmp, "tg.log")
    with open(rp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(good_rec()) + "\n")
    with open(lp + ".1", "w", encoding="utf-8") as fh:
        fh.write("\n".join(good_log) + "\n")
    check("read_lines: the live file absent but `.1` present still reads the rotation",
          lambda: read_lines([lp, lp + ".1"]) == good_log and read_lines([os.path.join(tmp, "nope")]) is None)
    eff = dict(ANCHORS, records=rp, wrapper_log=lp)
    v, m = evaluate(NOW, read_lines([eff["records"]]), read_lines([eff["wrapper_log"], eff["wrapper_log"] + ".1"]), eff)
    check("end to end through the files: PASS", lambda: v == "PASS")

    # ── metrics + output contract ──
    many = good_log + [log(LOOK_EPOCH + 20 + i, verb="FIRED", rest="NEW: 3m:FF:w2 " + "x" * 300) for i in range(40)]
    v, m = evaluate(NOW, good_rec() + both(LOOK_EPOCH + 30, live="MM"), many)
    check("metrics stay <= 4 KiB however many lines", lambda: len(json.dumps(m, sort_keys=True).encode()) <= METRICS_MAX_BYTES)
    reserved = ("read_id", "wave", "not_before", "expires_at", "attempt", "expired", "script", "duration_s", "runner_reason")
    check("metrics never use a runner-owned key", lambda: not [k for k in m if k in reserved])
    out = emit(v, m)
    check("the output is exactly one metrics line then one verdict line",
          lambda: len(out) == 2 and out[0].startswith("OWED_READ_METRICS={") and out[1] == "OWED_READ_VERDICT=" + v)
    check("aggregate: any FAIL -> FAIL; all PASS -> PASS; otherwise INDETERMINATE",
          lambda: aggregate({"a": {"verdict": "FAIL"}, "b": {"verdict": "INDETERMINATE"}}) == "FAIL"
          and aggregate({"a": {"verdict": "PASS"}, "b": {"verdict": "PASS"}}) == "PASS"
          and aggregate({"a": {"verdict": "PASS"}, "b": {"verdict": "INDETERMINATE"}}) == "INDETERMINATE")

    n = len(ran)
    ok = not failures and n >= _SELF_TEST_MIN_CHECKS
    if n < _SELF_TEST_MIN_CHECKS:
        print("  [FAIL] VACUITY: %d check(s) ran, floor is %d" % (n, _SELF_TEST_MIN_CHECKS))
    print("SELF-TEST: %s (%d check(s) ran, floor %d, %d failure(s))"
          % ("PASS" if ok else "FAIL", n, _SELF_TEST_MIN_CHECKS, len(failures)))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
